/**
 * V1.15: Anthropic 形状 `tool_result.content` 内嵌媒体块的压缩行为。
 *
 * 线上事故(2026-11-17):Claude Code 的 Read 返回一张 1.2MB JPEG(1.64MB base64),
 * 媒体块嵌在 `{role:"user", content:[{type:"tool_result", content:[{type:"image",...}]}]}`
 * 里。媒体 pass 只看消息顶层块 → 看不见;tool_result pass 只统计 text 块长度 → 长度 0;
 * 且最近消息受 skipIndices 保护。结果本地压缩与主动 compact 都动不了它,981k tokens
 * 提交后上游 400(`Input exceeds the context limit`)。
 *
 * 修复语义:
 *   - 非最近消息里的内嵌媒体:与顶层媒体一致,有即压;
 *   - 最近消息里的内嵌媒体:小图保留(模型正要看的图),单块 ≥ 64KB 才破例压缩;
 *   - 压缩只替换内层媒体块,保留 tool_result / tool_use_id 配对。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressV3x } from "@ccr/core/plugins/built-ins/helix-compressor/hc-local.ts";
import { helixCompressorTransform } from "@ccr/core/plugins/built-ins/helix-compressor.ts";
import { HELIX_RECALL_MODEL_PREFIX } from "@ccr/core/contracts/app.ts";
import { configureCacheDir, get as getRecallEntry } from "@ccr/core/observability/helix-recall-local-store";

const TEST_MODEL = "MiniMax-M2.7";
configureCacheDir(mkdtempSync(join(tmpdir(), "helix-nested-media-")));

function mockContext(overrides = {}) {
  return {
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    paths: { configDir: "", dataDir: "", pluginDataDir: "" },
    permissions: [],
    pluginConfig: {},
    pluginId: "helix-compressor",
    openSqliteStore: async () => { throw new Error("not implemented"); },
    ...overrides
  };
}

const BIG = "A".repeat(200 * 1024); // > RECENT_TOOL_RESULT_MEDIA_OVERRIDE_CHARS
const SMALL = "A".repeat(10 * 1024); // < 阈值

function imageBlock(data) {
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data } };
}

/** 历史对话(可选),尾部是一个 Read 的 tool_use/tool_result 对。 */
function buildMessages({ data, withHistory = false }) {
  const history = withHistory
    ? [
        { role: "user", content: [{ type: "text", text: "older question" }] },
        { role: "assistant", content: [{ type: "text", text: "older answer" }] }
      ]
    : [];
  return [
    ...history,
    { role: "user", content: [{ type: "text", text: "edit_image生成三视图看看效果" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "x.jpeg" } }]
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [imageBlock(data)] }]
    }
  ];
}

function run(messages, overrides = {}) {
  return compressV3x(structuredClone(messages), {
    keepRecentPairs: 1,
    blockThresholdChars: 0,
    compressMedia: true,
    compressToolResults: true,
    toolResultThresholdChars: 1000,
    keepRecentToolResults: 2,
    maxCompressToolResults: 2000,
    entryFitsBudget: () => true,
    ...overrides
  });
}

function toolResultOf(messages) {
  const last = messages[messages.length - 1];
  return last.content[0];
}

test("recent tool_result 内的大图被压成占位符,保留 tool_result 结构", () => {
  const result = run(buildMessages({ data: BIG }));
  const block = toolResultOf(result.messages);

  assert.equal(result.messages.at(-1).role, "user");
  assert.equal(block.type, "tool_result");
  assert.equal(block.tool_use_id, "toolu_1");
  assert.equal(Array.isArray(block.content), true);
  assert.equal(block.content.length, 1);
  assert.equal(block.content[0].type, "text");
  assert.match(block.content[0].text, /^⟦QA:[0-9a-f]{16}⟧$/);

  // 召回条目:kind=media,带图片本体
  const entry = Object.values(result.hashMap).find((item) => item.kind === "media");
  assert.ok(entry, "应写入 media 召回条目");
  assert.ok(Array.isArray(entry.qMedia) && entry.qMedia.length === 1);
  assert.equal(entry.qMedia[0].source.data, BIG);
});

test("recent tool_result 内的小图保留(模型当前要看)", () => {
  const result = run(buildMessages({ data: SMALL }));
  const block = toolResultOf(result.messages);

  assert.equal(block.content[0].type, "image");
  assert.equal(block.content[0].source.data, SMALL);
  assert.equal(Object.keys(result.hashMap).length, 0);
});

test("非最近 tool_result 内的内嵌媒体一律压缩", () => {
  const messages = buildMessages({ data: SMALL, withHistory: true });
  // 追加一个更近的用户轮,使带图的 tool_result 退出「最近 2 条消息」窗口
  messages.push({ role: "assistant", content: [{ type: "text", text: "ok" }] });
  messages.push({ role: "user", content: [{ type: "text", text: "next question" }] });

  const result = run(messages);
  const withImage = result.messages.find(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result")
  );
  const block = withImage.content.find((b) => b.type === "tool_result");

  assert.equal(block.content[0].type, "text");
  assert.match(block.content[0].text, /^⟦QA:[0-9a-f]{16}⟧$/);
});

test("幂等:已替换的内嵌媒体不会被重复压缩,再次运行结果不变", () => {
  const first = run(buildMessages({ data: BIG }));
  const second = compressV3x(structuredClone(first.messages), {
    keepRecentPairs: 1,
    blockThresholdChars: 0,
    compressMedia: true,
    compressToolResults: true,
    toolResultThresholdChars: 1000,
    keepRecentToolResults: 2,
    maxCompressToolResults: 2000,
    entryFitsBudget: () => true
  });

  assert.deepEqual(second.messages, first.messages);
  assert.equal(Object.keys(second.hashMap).length, 0);
});

test("生产路径:transform 对 Anthropic 形状的内嵌大图产出占位符", async () => {
  const result = await helixCompressorTransform(
    {
      body: {
        model: TEST_MODEL,
        tools: [{ name: "Read", description: "Reads a file", input_schema: { type: "object", properties: {} } }],
        messages: buildMessages({ data: BIG })
      },
      headers: {},
      method: "POST",
      path: "/v1/messages",
      requestId: "test-nested-media-1",
      routedModel: TEST_MODEL,
      url: "/v1/messages"
    },
    mockContext()
  );

  assert.ok(result, "transform 应当返回结果");
  const last = result.body.messages.at(-1);
  const block = last.content.find((b) => b.type === "tool_result");
  assert.ok(block, "tool_result 结构必须保留");
  assert.equal(block.content[0].type, "text");
  assert.match(block.content[0].text, /^⟦QA:[0-9a-f]{16}⟧$/);
  // 占位符存在 → 网关需命中 recall profile 才能取回图片
  assert.equal(result.routedModel, `${HELIX_RECALL_MODEL_PREFIX}${TEST_MODEL}`);

  // 验收:凡出现在消息里的占位符必须能从本地召回缓存读回(不许有孤儿)
  const hash = block.content[0].text.match(/^⟦QA:([0-9a-f]{16})⟧$/)[1];
  const stored = getRecallEntry(hash);
  assert.ok(stored, "占位符必须可从召回缓存读回");
  assert.equal(stored.kind, "media");
  // V1.16:压不动的媒体(这里是伪 base64)不允许把原文存进召回,只留小标记
  assert.equal(stored.qMedia, undefined);
  assert.ok(stored.q.length < 200);
  assert.ok(!JSON.stringify(stored).includes(BIG.slice(0, 100)));
});

test("混排 tool_result(长文本 + 图):只换图,文本不被整块折叠覆盖", () => {
  const LONG_TEXT = "L".repeat(5000);
  const messages = [
    { role: "user", content: [{ type: "text", text: "older question" }] },
    { role: "assistant", content: [{ type: "text", text: "older answer" }] },
    { role: "user", content: [{ type: "text", text: "read it" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_mixed", name: "Read", input: { file_path: "x.jpeg" } }]
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_mixed",
          content: [{ type: "text", text: LONG_TEXT }, imageBlock(BIG)]
        }
      ]
    },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: [{ type: "text", text: "next question" }] }
  ];

  // keepRecentToolResults=0:让 tool_result pass 也真的考虑这个块,才能验证
  // skipBlocks 防止它把已替换的媒体占位符整块覆盖掉。
  const result = run(messages, { keepRecentToolResults: 0 });
  const block = result.messages[4].content[0];

  assert.equal(block.type, "tool_result");
  assert.equal(block.content[0].text, LONG_TEXT, "文本块应保持原文,不能被 tool_result pass 覆盖");
  assert.equal(block.content[1].type, "text");
  assert.match(block.content[1].text, /^⟦QA:[0-9a-f]{16}⟧$/);
});

test("tool_result.content 是字符串化的块数组时,写回仍保持字符串形状", () => {
  const messages = buildMessages({ data: BIG });
  messages.at(-1).content[0].content = JSON.stringify([imageBlock(BIG)]);

  const result = run(messages);
  const inner = result.messages.at(-1).content[0].content;

  assert.equal(typeof inner, "string");
  const parsed = JSON.parse(inner);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, "text");
  assert.match(parsed[0].text, /^⟦QA:[0-9a-f]{16}⟧$/);
});

test("一个 tool_result 内的多张图逐块压缩,各自写入召回条目", () => {
  const messages = buildMessages({ data: BIG });
  messages.at(-1).content[0].content = [imageBlock(BIG), imageBlock("B".repeat(200 * 1024))];

  const result = run(messages);
  const inner = result.messages.at(-1).content[0].content;

  assert.equal(inner.length, 2);
  for (const item of inner) {
    assert.equal(item.type, "text");
    assert.match(item.text, /^⟦QA:[0-9a-f]{16}⟧$/);
  }
  assert.equal(Object.keys(result.hashMap).length, 2);
});

test("召回缓存拒收(entryFitsBudget=false)时不写占位符,不留孤儿", () => {
  const messages = buildMessages({ data: BIG });
  const result = compressV3x(structuredClone(messages), {
    keepRecentPairs: 1,
    blockThresholdChars: 0,
    compressMedia: true,
    compressToolResults: true,
    toolResultThresholdChars: 1000,
    keepRecentToolResults: 2,
    maxCompressToolResults: 2000,
    entryFitsBudget: () => false
  });

  const inner = result.messages.at(-1).content[0].content;
  assert.equal(inner[0].type, "image");
  assert.equal(inner[0].source.data, BIG);
  assert.equal(Object.keys(result.hashMap).length, 0);
});

test("顶层媒体(非 tool_result)行为不变:非最近仍压缩", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "start" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: [{ type: "text", text: "look" }, imageBlock(BIG)] },
    { role: "assistant", content: [{ type: "text", text: "seen" }] },
    { role: "user", content: [{ type: "text", text: "next" }] }
  ];
  const result = compressV3x(messages, {
    keepRecentPairs: 1,
    compressMedia: true,
    compressToolResults: true,
    entryFitsBudget: () => true
  });

  assert.equal(result.messages[2].content[1].type, "text");
  assert.match(result.messages[2].content[1].text, /^⟦QA:[0-9a-f]{16}⟧$/);
});
