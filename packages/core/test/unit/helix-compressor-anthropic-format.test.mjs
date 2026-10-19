/**
 * Helix Compressor transform 行为测试(V1.11 / 2026-10-15 起)
 *
 * 旧行为(H2 修复):transform 往 body.tools 注入裸的 history_recall schema,
 *   并按协议分发(Anthropic: input_schema / OpenAI: function.parameters)。
 *
 * 新行为(V1.11):**不再注入裸工具**。原因是网关的 buildVirtualTooling 对客户端工具
 *   与 virtual-model profile internal 工具同名会直接 400
 *   (`Client tool "history_recall" conflicts with virtual model tool.`)。改为:
 *   - body 含可召回占位符(⟦QA:⟧ / ⟦HC:⟧)时,transform 返回
 *     `model = "ccr-helix-recall/<真 model>"`,网关据此命中 helix virtualModelProfile
 *     → internal tool 循环(支持流式)兑现 recall;
 *   - 占位符缺失时不改写 → 不命中 profile → 保持 live 直通(零 TTFB 回归)。
 *   - recall 工具定义由 profile 提供(见 config-compiler),教学 prompt 仍由 transform 注入。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helixCompressorTransform } from "@ccr/core/plugins/built-ins/helix-compressor.ts";
import { HELIX_RECALL_MODEL_PREFIX } from "@ccr/core/contracts/app.ts";
import { configureCacheDir } from "@ccr/core/observability/helix-recall-local-store";

const TEST_MODEL = "MiniMax-M2.7";

// transform 只做本地压缩,无任何 cloud fetch。本地 compressV3x 只会对
// "够长的历史 pair"产出 ⟦QA:hash⟧ 占位符,且 transform 要求 body 带 model。
// 缓存目录指向 tmp,避免污染真实 DATADIR。
configureCacheDir(mkdtempSync(join(tmpdir(), "helix-transform-")));

/** 一段足够长、会被本地压缩成 ⟦QA:hash⟧ 的历史(每条 ≥500 字符,合并 ≥1000)。 */
const LONG_HISTORY = [
  { role: "user", content: "A".repeat(600) },
  { role: "assistant", content: "B".repeat(600) },
  { role: "user", content: "final question" }
];

/** 太短 → 不产生占位符。 */
const SHORT_HISTORY = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello" },
  { role: "user", content: "final question" }
];

function mockContext(overrides = {}) {
  return {
    config: {},
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    },
    paths: { configDir: "", dataDir: "", pluginDataDir: "" },
    permissions: [],
    pluginConfig: {
      ...overrides.pluginConfig
    },
    pluginId: "helix-compressor",
    openSqliteStore: async () => { throw new Error("not implemented"); },
    ...overrides
  };
}

/** Anthropic 格式的 tools (本仓库示例 body 用的格式) */
const ANTHROPIC_TOOLS = [
  { name: "Read", description: "Reads a file", input_schema: { type: "object", properties: {} } }
];

/** OpenAI 格式的 tools */
const OPENAI_TOOLS = [
  { type: "function", function: { name: "Read", description: "Reads a file", parameters: { type: "object", properties: {} } } }
];

function recallTools(tools) {
  return (tools ?? []).filter((t) =>
    t.name === "history_recall" ||
    (t.function && t.function.name === "history_recall") ||
    t.name === "hc_recall" ||
    (t.function && t.function.name === "hc_recall")
  );
}

test("含占位符 → transform 改写 model 为 ccr-helix-recall/<真 model>", async () => {
  const result = await helixCompressorTransform(
    {
      body: { model: TEST_MODEL, tools: ANTHROPIC_TOOLS, messages: LONG_HISTORY },
      headers: {},
      method: "POST",
      path: "/v1/messages",
      requestId: "test-anthropic-1",
      routedModel: TEST_MODEL,
      url: "/v1/messages"
    },
    mockContext({ pluginConfig: { keepRecentPairs: 0 } })
  );

  assert.ok(result, "transform 应当返回结果");
  assert.equal(result.routedModel, `${HELIX_RECALL_MODEL_PREFIX}${TEST_MODEL}`);
});

test("含占位符 → 不再注入裸 history_recall 工具(避免 profile internal 工具同名 400)", async () => {
  const result = await helixCompressorTransform(
    {
      body: { model: TEST_MODEL, tools: ANTHROPIC_TOOLS, messages: LONG_HISTORY },
      headers: {},
      method: "POST",
      path: "/v1/messages",
      requestId: "test-no-inject-1",
      routedModel: TEST_MODEL,
      url: "/v1/messages"
    },
    mockContext({ pluginConfig: { keepRecentPairs: 0 } })
  );

  assert.ok(result);
  assert.deepEqual(recallTools(result.body.tools), [], "不应注入任何裸 recall 工具");
  // 原有客户端工具保持不变
  assert.deepEqual(result.body.tools, ANTHROPIC_TOOLS);
});

test("含占位符 → 注入教学 prompt(system message 含 marker)", async () => {
  const result = await helixCompressorTransform(
    {
      body: { model: TEST_MODEL, messages: LONG_HISTORY },
      headers: {},
      method: "POST",
      path: "/v1/messages",
      requestId: "test-instruction-1",
      routedModel: TEST_MODEL,
      url: "/v1/messages"
    },
    mockContext({ pluginConfig: { keepRecentPairs: 0 } })
  );

  assert.ok(result);
  const systemText = JSON.stringify(result.body.messages);
  assert.ok(systemText.includes("HISTORY_RECALL_INSTRUCTION_v1"), "应含 history recall 教学 marker");
});

// ===== countChars 回归(2026-10-19):tool_result/tool_use/多 text 块不得漏计 =====
//
// 旧 countChars 有两个 bug:early-return(只算第一个 text 块)+ 只认 .text
// (漏 tool_result.content / tool_use.input)。导致 x-helix-compressor-input-chars
// 严重偏低 → UI ratio / "内容 X→Y chars" 全失真。此测试锁住真实 Claude Code 形状。

test("countChars: tool_result.content / tool_use.input / 多 text 块都被计入", async () => {
  const blocky = [
    { role: "user", content: "Q".repeat(800) },
    // 消息块:tally 应 ≥ 5000(tool_result.content) + 2000(tool_use.input) + 300+700(text)
    { role: "assistant", content: [
      { type: "tool_use", id: "t1", name: "Read", input: { file: "x".repeat(2000) } },
      { type: "text", text: "A".repeat(300) },
      { type: "text", text: "B".repeat(700) }
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", content: "Z".repeat(5000) }
    ] },
    { role: "user", content: "final question" }
  ];
  const result = await helixCompressorTransform(
    {
      body: { model: TEST_MODEL, messages: blocky },
      headers: {}, method: "POST", path: "/v1/messages",
      requestId: "test-countchars-1", routedModel: TEST_MODEL, url: "/v1/messages"
    },
    mockContext({ pluginConfig: { keepRecentPairs: 0 } })
  );
  assert.ok(result);
  const inputChars = Number(result.headers["x-helix-compressor-input-chars"]);
  // 800 + 5000 + 2000 + 300 + 700 = 8800(含少量 JSON 结构);旧实现只算 800+300=1100
  assert.ok(inputChars >= 8800, `input-chars 应 ≥ 8800(含所有块),实测 ${inputChars}`);
  assert.ok(inputChars < 10000, `input-chars 不应显著超出内容量,实测 ${inputChars}`);
});

test("OpenAI 协议 body 同样改写 model(与协议无关)", async () => {
  const result = await helixCompressorTransform(
    {
      body: { model: TEST_MODEL, tools: OPENAI_TOOLS, messages: LONG_HISTORY },
      headers: {},
      method: "POST",
      path: "/v1/chat/completions",
      requestId: "test-openai-1",
      routedModel: TEST_MODEL,
      url: "/v1/chat/completions"
    },
    mockContext({ pluginConfig: { keepRecentPairs: 0 } })
  );

  assert.ok(result);
  assert.equal(result.routedModel, `${HELIX_RECALL_MODEL_PREFIX}${TEST_MODEL}`);
  assert.deepEqual(recallTools(result.body.tools), []);
});

test("数组块 content 的 anthropic body 同样改写 model", async () => {
  const result = await helixCompressorTransform(
    {
      body: {
        model: TEST_MODEL,
        messages: [
          { role: "user", content: [{ type: "text", text: "A".repeat(600) }] },
          { role: "assistant", content: [{ type: "text", text: "B".repeat(600) }] },
          { role: "user", content: [{ type: "text", text: "final question" }] }
        ]
      },
      headers: {},
      method: "POST",
      path: "/v1/messages",
      requestId: "test-anthropic-blocks-1",
      routedModel: TEST_MODEL,
      url: "/v1/messages"
    },
    mockContext({ pluginConfig: { keepRecentPairs: 0 } })
  );

  assert.ok(result);
  assert.equal(result.routedModel, `${HELIX_RECALL_MODEL_PREFIX}${TEST_MODEL}`);
});

test("带 system 字段的 body 同样改写 model", async () => {
  const result = await helixCompressorTransform(
    {
      body: { model: TEST_MODEL, system: "You are Claude.", messages: LONG_HISTORY },
      headers: {},
      method: "POST",
      path: "/v1/messages",
      requestId: "test-anthropic-system-1",
      routedModel: TEST_MODEL,
      url: "/v1/messages"
    },
    mockContext({ pluginConfig: { keepRecentPairs: 0 } })
  );

  assert.ok(result);
  assert.equal(result.routedModel, `${HELIX_RECALL_MODEL_PREFIX}${TEST_MODEL}`);
});

// 关键性能门控:无占位符的请求不改写 model → 不命中 profile → 保持 upstream live 直通。
test("无占位符(短历史) → 不改写 model(避免全量 buffer 的 TTFB 回归)", async () => {
  const result = await helixCompressorTransform(
    {
      body: { model: TEST_MODEL, tools: ANTHROPIC_TOOLS, messages: SHORT_HISTORY },
      headers: {},
      method: "POST",
      path: "/v1/messages",
      requestId: "test-no-placeholder-1",
      routedModel: TEST_MODEL,
      url: "/v1/messages"
    },
    mockContext({ pluginConfig: { keepRecentPairs: 0 } })
  );

  assert.ok(result);
  assert.equal(result.routedModel, undefined, "无占位符时不应改写 model");
});
