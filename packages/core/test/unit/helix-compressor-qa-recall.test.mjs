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
import test from "node:test";
import {
  HISTORY_RECALL_TOOL_SCHEMA,
  HISTORY_RECALL_TOOL_NAME,
  hasQAPlaceholder,
  injectHistoryRecallInstruction,
  extractOpenAIHistoryRecallCalls,
  extractAnthropicHistoryRecallCalls,
  helixCompressorResponseHook
} from "@ccr/core/plugins/built-ins/helix-compressor.ts";

const HELIX_API = "https://api.helix-compressor.com";
const HELIX_KEY = "hk_test_xxx";

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
      helixApiUrl: HELIX_API,
      helixApiKey: HELIX_KEY,
      evaluatorApiUrl: "https://api.openai.com",
      evaluatorApiKey: "sk-test",
      evaluatorModel: "gpt-4o-mini",
      timeoutMs: 5000
    },
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
  assert.deepEqual(calls, [{ hash_id: "abc123def4567890", tool_call_id: "call_qa1" }]);
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
  assert.deepEqual(calls, [{ hash_id: "abc123def4567890", tool_call_id: "toolu_qa1" }]);
});

// ============== response hook 不抛错(关键回归)==============
//
// 修复前:helix-compressor.ts:840 引用未定义变量 `recallResults`/`validCalls`,
// 在 hook 走到 audit log 时抛 TypeError,gateway 吞掉 → LLM 看到 tool_call 没回结果。

test("response hook: history_recall path 不抛错 (回归测试)", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ q: "原 Q 文本", a: "原 A 文本" })
  });

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

  global.fetch = originalFetch;
});

test("response hook: history_recall hash miss 优雅处理 (审计 + 不抛错)", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 404
  });

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
  global.fetch = originalFetch;
});

// ============== Prompt directive 内容(防止将来误删)==============

test("HISTORY_RECALL_INSTRUCTION 含明确触发词 + 反例", () => {
  // 通过调用 injectHistoryRecallInstruction 拿到注入后的内容
  const messages = [{ role: "user", content: "Hi" }];
  const [injected] = injectHistoryRecallInstruction(messages);
  const text = injected.content;

  // 强触发词
  assert.ok(text.includes("⚠️"), "应有 ⚠️ 强触发符号");
  // 必须调用的场景关键词
  assert.ok(text.includes("必须调用"), "应明确'必须调用'场景");
  // 决策示例:hash_id 提取
  assert.ok(text.includes("abc123def4567890"), "应有 hash_id 提取示例");
  // 反例
  assert.ok(text.includes("禁止"), "应有'禁止'反例段");
  // 召回时的 with_media 决策
  assert.ok(text.includes("with_media"), "应提示 with_media 用途");
});
