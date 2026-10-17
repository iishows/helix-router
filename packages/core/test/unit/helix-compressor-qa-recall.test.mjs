/**
 * helix-compressor V3.2 — Q&A pair compression / history_recall tests
 *
 * 覆盖:
 *  - HISTORY_RECALL_TOOL_SCHEMA 形状
 *  - hasQAPlaceholder 检测
 *  - injectHistoryRecallInstruction 三种情况:prepend / 插入 / 幂等(不重复)
 *  - extract{OpenAI,Anthropic}HistoryRecallCalls 提取
 *  - response hook:history_recall 通路不抛错(修复了 audit log undefined 引用)
 */

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HISTORY_RECALL_TOOL_SCHEMA,
  HISTORY_RECALL_TOOL_NAME,
  hasQAPlaceholder,
  injectHistoryRecallInstruction,
  extractOpenAIHistoryRecallCalls,
  extractAnthropicHistoryRecallCalls,
  helixCompressorResponseHook
} from "@ccr/core/plugins/built-ins/helix-compressor.ts";
import {
  configureCacheDir,
  putBatch as seedRecallCache,
  _resetIndexForTest,
  _clearCacheForTest
} from "@ccr/core/observability/helix-recall-local-store";

// P2(2026-10-15):history_recall 读本地 store,不打任何云端。测试改为预置本地 JSONL。
configureCacheDir(mkdtempSync(join(tmpdir(), "helix-qa-recall-test-")));

function seedRecallEntries(entries) {
  _clearCacheForTest();
  _resetIndexForTest();
  seedRecallCache(entries);
  _resetIndexForTest();
}

beforeEach(() => {
  _clearCacheForTest();
  _resetIndexForTest();
});

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
    pluginConfig: {},
    pluginId: "helix-compressor",
    openSqliteStore: async () => { throw new Error("not implemented"); },
    ...overrides
  };
}

// ============== Tool Schema ==============

test("HISTORY_RECALL_TOOL_SCHEMA: name & hash_id required", () => {
  assert.equal(HISTORY_RECALL_TOOL_SCHEMA.function.name, HISTORY_RECALL_TOOL_NAME);
  assert.equal(HISTORY_RECALL_TOOL_SCHEMA.type, "function");
  assert.ok(HISTORY_RECALL_TOOL_SCHEMA.function.parameters.required.includes("hash_id"));
  assert.equal(
    HISTORY_RECALL_TOOL_SCHEMA.function.parameters.properties.hash_id.pattern,
    "^[0-9a-f]{16}$"
  );
});

// ============== hasQAPlaceholder ==============

test("hasQAPlaceholder: detects in string content", () => {
  assert.equal(hasQAPlaceholder([
    { role: "user", content: "Some text with ⟦QA:abc123def4567890⟧ placeholder" }
  ]), true);
  assert.equal(hasQAPlaceholder([
    { role: "user", content: "Normal text" }
  ]), false);
  assert.equal(hasQAPlaceholder([
    { role: "assistant", content: "" }
  ]), false);
});

// 真实 Claude Code 的 content 恒为数组块([{type:"text",text:"⟦QA:hash⟧"}])。
// 旧实现只检查字符串 → 数组块里的 ⟦QA:⟧ 永远漏检 → history_recall 工具/教学 prompt
// 从不注入(请求日志 3605 实测:body 有 2 个 ⟦QA:⟧ 但 history_recall 工具缺失)。
test("hasQAPlaceholder: 检测数组块 content(真实 Claude Code 形状)", () => {
  assert.equal(hasQAPlaceholder([
    { role: "user", content: [{ type: "text", text: "⟦QA:d1e0fad99226a6f8⟧" }] }
  ]), true);
  assert.equal(hasQAPlaceholder([
    { role: "user", content: [{ type: "text", text: "普通文本" }] }
  ]), false);
  // tool_result 块(无 text 字段)不应误报
  assert.equal(hasQAPlaceholder([
    { role: "user", content: [{ type: "tool_result", content: "output" }] }
  ]), false);
  // 混合:数组里既有 text 又有 tool_use
  assert.equal(hasQAPlaceholder([
    { role: "assistant", content: [
      { type: "text", text: "⟦QA:aaaabbbbccccdddd⟧" },
      { type: "tool_use", id: "call_1", name: "Bash", input: {} }
    ] }
  ]), true);
});

// ============== injectHistoryRecallInstruction(幂等是关键)==============

test("injectHistoryRecallInstruction: prepends to existing system message", () => {
  const messages = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hello" }
  ];
  const result = injectHistoryRecallInstruction(messages);
  assert.equal(result.length, 2);
  assert.equal(result[0].role, "system");
  assert.ok(result[0].content.includes(HISTORY_RECALL_TOOL_NAME));
  assert.ok(result[0].content.includes("You are helpful."));
});

test("injectHistoryRecallInstruction: inserts new system if none exists", () => {
  const messages = [{ role: "user", content: "Hello" }];
  const result = injectHistoryRecallInstruction(messages);
  assert.equal(result.length, 2);
  assert.equal(result[0].role, "system");
  assert.ok(result[0].content.includes(HISTORY_RECALL_TOOL_NAME));
  assert.equal(result[1].role, "user");
});

test("injectHistoryRecallInstruction: NO duplicate if marker already present (回归测试)", () => {
  const messages = [
    { role: "system", content: "<<HISTORY_RECALL_INSTRUCTION_v1>>\n## 历史 Q&A 召回机制" },
    { role: "user", content: "Hi" }
  ];
  const result = injectHistoryRecallInstruction(messages);
  // 关键:不应该插入第二条 system message,也不应该让原 system 重复 prepend
  assert.equal(result.length, 2);
  assert.ok(result[0].content.includes("## 历史 Q&A 召回机制"));
  // 系统 prompt 应该只包含一次 marker 段,而非累积两次
  const markerCount = (result[0].content.match(/HISTORY_RECALL_INSTRUCTION_v1/g) || []).length;
  assert.equal(markerCount, 1, "marker 不应重复");
});

// ============== Extractor ==============

test("extractOpenAIHistoryRecallCalls: extracts history_recall tool_call", () => {
  const response = {
    choices: [{
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_qa1",
          type: "function",
          function: {
            name: HISTORY_RECALL_TOOL_NAME,
            arguments: JSON.stringify({ hash_id: "abc123def4567890" })
          }
        }]
      }
    }]
  };
  const calls = extractOpenAIHistoryRecallCalls(response);
  assert.deepEqual(calls, [{ hash_id: "abc123def4567890", tool_call_id: "call_qa1", with_media: false }]);
});

test("extractOpenAIHistoryRecallCalls: extracts with_media=true", () => {
  const response = {
    choices: [{
      message: {
        tool_calls: [{
          id: "call_qa2",
          type: "function",
          function: {
            name: HISTORY_RECALL_TOOL_NAME,
            arguments: JSON.stringify({ hash_id: "abc123def4567890", with_media: true })
          }
        }]
      }
    }]
  };
  const calls = extractOpenAIHistoryRecallCalls(response);
  assert.deepEqual(calls, [{ hash_id: "abc123def4567890", tool_call_id: "call_qa2", with_media: true }]);
});

test("extractOpenAIHistoryRecallCalls: filters non-history_recall", () => {
  const response = {
    choices: [{
      message: {
        tool_calls: [
          { id: "c1", type: "function", function: { name: "other_tool", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: HISTORY_RECALL_TOOL_NAME, arguments: '{"hash_id":"abc123def4567890"}' } }
        ]
      }
    }]
  };
  const calls = extractOpenAIHistoryRecallCalls(response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hash_id, "abc123def4567890");
  assert.equal(calls[0].with_media, false);
});

test("extractAnthropicHistoryRecallCalls: extracts history_recall tool_use", () => {
  const response = {
    content: [{
      type: "tool_use",
      id: "toolu_qa1",
      name: HISTORY_RECALL_TOOL_NAME,
      input: { hash_id: "abc123def4567890" }
    }]
  };
  const calls = extractAnthropicHistoryRecallCalls(response);
  assert.deepEqual(calls, [{ hash_id: "abc123def4567890", tool_call_id: "toolu_qa1", with_media: false }]);
});

test("extractAnthropicHistoryRecallCalls: extracts with_media=true", () => {
  const response = {
    content: [{
      type: "tool_use",
      id: "toolu_qa2",
      name: HISTORY_RECALL_TOOL_NAME,
      input: { hash_id: "abc123def4567890", with_media: true, reason: "要看原图细节" }
    }]
  };
  const calls = extractAnthropicHistoryRecallCalls(response);
  assert.deepEqual(calls, [{ hash_id: "abc123def4567890", tool_call_id: "toolu_qa2", with_media: true }]);
});

// ============== response hook 不抛错(关键回归)==============
//
// 修复前:helix-compressor.ts:840 引用未定义变量 `recallResults`/`validCalls`,
// 在 hook 走到 audit log 时抛 TypeError,gateway 吞掉 → LLM 看到 tool_call 没回结果。

test("response hook: history_recall path 不抛错 (回归测试)", async () => {
  seedRecallEntries([["abc123def4567890", { q: "原 Q 文本", a: "原 A 文本" }]]);

  const response = {
    choices: [{
      message: {
        tool_calls: [{
          id: "call_qa1",
          type: "function",
          function: {
            name: HISTORY_RECALL_TOOL_NAME,
            arguments: JSON.stringify({
              hash_id: "abc123def4567890",
              reason: "需要细节"
            })
          }
        }]
      }
    }]
  };

  let result;
  let threw = false;
  try {
    result = await helixCompressorResponseHook(
      {
        body: {}, headers: {}, method: "POST", path: "/v1/chat",
        requestId: "r1", responsePayload: response, statusCode: 200, protocol: "openai"
      },
      mockContext()
    );
  } catch (err) {
    threw = true;
    console.error("hook threw:", err);
  }

  assert.equal(threw, false, "response hook 不应该抛错(audit log 已修复)");
  assert.equal(result.continueLoop, true);
  assert.equal(result.messagesToAppend?.length, 1);
  assert.equal(result.messagesToAppend[0].tool_call_id, "call_qa1");
  // 内容应包含 q 和 a
  const content = result.messagesToAppend[0].content;
  assert.ok(content.includes("原 Q 文本"));
  assert.ok(content.includes("原 A 文本"));
  // 2026-10-16: 回填的原文 token 数(供「真实端到端节省」扣除召回回填)
  assert.equal(typeof result.recallTokens, "number");
  assert.ok(result.recallTokens > 0, "recallTokens 应 > 0(有回填原文)");
});

test("response hook: history_recall hash miss 优雅处理 (审计 + 不抛错)", async () => {
  seedRecallEntries([]);

  const response = {
    choices: [{
      message: {
        tool_calls: [{
          id: "call_qa1",
          type: "function",
          function: {
            name: HISTORY_RECALL_TOOL_NAME,
            arguments: JSON.stringify({ hash_id: "fffff1234567890" })
          }
        }]
      }
    }]
  };

  let threw = false;
  try {
    await helixCompressorResponseHook(
      {
        body: {}, headers: {}, method: "POST", path: "/v1/chat",
        requestId: "r1", responsePayload: response, statusCode: 200, protocol: "openai"
      },
      mockContext()
    );
  } catch {
    threw = true;
  }

  assert.equal(threw, false);
});

// V3.4: anthropic 协议 + with_media=true + 命中图片 → tool_result 用块数组返回真实 image 块
test("response hook: anthropic with_media=true returns a real image content block", async () => {
  seedRecallEntries([
    ["abcdabcdabcdabcd", {
      q: "[media block: image image/png, 4 bytes]",
      a: "",
      kind: "media",
      qMedia: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }]
    }]
  ]);

  const response = {
    content: [{
      type: "tool_use",
      id: "toolu_media1",
      name: HISTORY_RECALL_TOOL_NAME,
      input: { hash_id: "abcdabcdabcdabcd", with_media: true }
    }]
  };

  const result = await helixCompressorResponseHook(
    {
      body: {}, headers: {}, method: "POST", path: "/v1/chat",
      requestId: "r1", responsePayload: response, statusCode: 200, protocol: "anthropic"
    },
    mockContext()
  );

  assert.equal(result.continueLoop, true);
  const block = result.messagesToAppend[0].content[0];
  assert.equal(block.type, "tool_result");
  assert.equal(block.tool_use_id, "toolu_media1");
  assert.ok(Array.isArray(block.content), "tool_result content 应为块数组");
  const img = block.content.find((c) => c.type === "image");
  assert.deepEqual(img, {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAAA" }
  });
});

test("response hook: anthropic without with_media keeps plain-text q_media (no image block)", async () => {
  seedRecallEntries([
    ["abcdabcdabcdabcd", {
      q: "[media block: image image/png, 4 bytes]",
      a: "",
      kind: "media",
      qMedia: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }]
    }]
  ]);

  const response = {
    content: [{
      type: "tool_use",
      id: "toolu_media2",
      name: HISTORY_RECALL_TOOL_NAME,
      input: { hash_id: "abcdabcdabcdabcd" }
    }]
  };

  const result = await helixCompressorResponseHook(
    {
      body: {}, headers: {}, method: "POST", path: "/v1/chat",
      requestId: "r1", responsePayload: response, statusCode: 200, protocol: "anthropic"
    },
    mockContext()
  );

  const block = result.messagesToAppend[0].content[0];
  assert.equal(typeof block.content, "string", "无 with_media 时应为纯文本");
  assert.ok(!block.content.includes("AAAA"), "不应把 base64 当文本返回");
});

// ============== Prompt directive 内容(防止将来误删)==============

test("HISTORY_RECALL_INSTRUCTION 含明确触发词 + 反例", () => {
  // 通过调用 injectHistoryRecallInstruction 拿到注入后的内容
  const messages = [{ role: "user", content: "Hi" }];
  const [injected] = injectHistoryRecallInstruction(messages);
  const text = injected.content;

  // 强触发符号
  assert.ok(text.includes("⚠️"), "应有 ⚠️ 强触发符号");
  // 强制召回指令(英文,直接命令模型先召回再回答)
  assert.ok(text.includes("MUST recall"), "应明确'必须召回'的强制指令");
  // 决策示例:hash_id 提取
  assert.ok(text.includes("abc123def4567890"), "应有 hash_id 提取示例");
  // 反例 / 禁令
  assert.ok(text.includes("Do NOT"), "应有禁令段");
  // 召回时的 with_media 决策
  assert.ok(text.includes("with_media"), "应提示 with_media 用途");
});
