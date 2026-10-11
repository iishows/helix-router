/**
 * helix-compressor recall unit tests
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  helixCompressorResponseHook,
  HC_RECALL_TOOL_SCHEMA,
  HC_RECALL_TOOL_SCHEMA_ANTHROPIC,
  HISTORY_RECALL_TOOL_SCHEMA,
  HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC,
  extractOpenAIHcrecallCalls,
  extractAnthropicHcrecallCalls,
  hasHCPlaceholder,
  injectRecallInstruction
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

function mockResponseWithToolCalls() {
  return {
    choices: [{
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "hc_recall",
            arguments: JSON.stringify({ hash_id: "abc123def456", reason: "need details" })
          }
        }]
      }
    }]
  };
}

test("HC_RECALL_TOOL_SCHEMA has correct name", () => {
  assert.equal(HC_RECALL_TOOL_SCHEMA.function.name, "hc_recall");
  assert.equal(HC_RECALL_TOOL_SCHEMA.type, "function");
  assert.ok(HC_RECALL_TOOL_SCHEMA.function.parameters.required.includes("hash_id"));
});

test("hasHCPlaceholder: detects in string content", () => {
  assert.equal(hasHCPlaceholder([
    { role: "user", content: "Some text with ⟦HC:abc123⟧ placeholder" }
  ]), true);
  assert.equal(hasHCPlaceholder([
    { role: "user", content: "Normal text" }
  ]), false);
});

test("hasHCPlaceholder: handles array content (Anthropic)", () => {
  assert.equal(hasHCPlaceholder([
    { role: "user", content: [{ type: "text", text: "Has ⟦HC:abc⟧" }] }
  ]), true);
});

test("injectRecallInstruction: prepends to system message", () => {
  const messages = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hello" }
  ];
  const result = injectRecallInstruction(messages);
  assert.equal(result[0].role, "system");
  assert.ok(result[0].content.includes("hc_recall"));
  assert.ok(result[0].content.includes("You are helpful."));
});

test("injectRecallInstruction: inserts new system message if none", () => {
  const messages = [{ role: "user", content: "Hello" }];
  const result = injectRecallInstruction(messages);
  assert.equal(result[0].role, "system");
  assert.ok(result[0].content.includes("hc_recall"));
  assert.equal(result[1].role, "user");
});

test("injectRecallInstruction: no duplicate if already injected", () => {
  const messages = [
    { role: "system", content: "<<HC_RECALL_INSTRUCTION_v1>>\n## 工具调用: hc_recall" },
    { role: "user", content: "Hi" }
  ];
  const result = injectRecallInstruction(messages);
  assert.equal(result.length, 2);
  assert.ok(!result[0].content.includes("## 工具调用: hc_recall\n## 工具调用"));
});

test("extractOpenAIHcrecallCalls: extracts tool_call", () => {
  const calls = extractOpenAIHcrecallCalls(mockResponseWithToolCalls());
  assert.deepEqual(calls, [{
    tool_call_id: "call_1",
    hash_id: "abc123def456",
    reason: "need details"
  }]);
});

test("extractOpenAIHcrecallCalls: filters non-hc_recall", () => {
  const response = {
    choices: [{
      message: {
        tool_calls: [
          { id: "c1", type: "function", function: { name: "other_tool", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "hc_recall", arguments: '{"hash_id":"abc"}' } }
        ]
      }
    }]
  };
  const calls = extractOpenAIHcrecallCalls(response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool_call_id, "c2");
});

test("extractOpenAIHcrecallCalls: empty for no tool_calls", () => {
  const calls = extractOpenAIHcrecallCalls({ choices: [{ message: { content: "hi" } }] });
  assert.equal(calls.length, 0);
});

test("extractOpenAIHcrecallCalls: handles malformed arguments", () => {
  const response = {
    choices: [{
      message: {
        tool_calls: [{
          id: "c1",
          type: "function",
          function: { name: "hc_recall", arguments: "{invalid json" }
        }]
      }
    }]
  };
  assert.equal(extractOpenAIHcrecallCalls(response).length, 0);
});

test("extractAnthropicHcrecallCalls: extracts tool_use", () => {
  const response = {
    content: [{
      type: "tool_use",
      id: "toolu_1",
      name: "hc_recall",
      input: { hash_id: "abc123", reason: "details" }
    }]
  };
  const calls = extractAnthropicHcrecallCalls(response);
  assert.deepEqual(calls, [{
    tool_call_id: "toolu_1",
    hash_id: "abc123",
    reason: "details"
  }]);
});

test("extractAnthropicHcrecallCalls: filters non-hc_recall tool_use", () => {
  const response = {
    content: [
      { type: "text", text: "thinking..." },
      { type: "tool_use", id: "t1", name: "Read", input: { file: "x" } },
      { type: "tool_use", id: "t2", name: "hc_recall", input: { hash_id: "abc" } }
    ]
  };
  const calls = extractAnthropicHcrecallCalls(response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool_call_id, "t2");
});

test("response hook: returns continueLoop=false when no tool calls", async () => {
  const result = await helixCompressorResponseHook(
    {
      body: {}, headers: {}, method: "POST", path: "/v1/chat",
      requestId: "r1",
      responsePayload: { choices: [{ message: { content: "hi" } }] },
      statusCode: 200, protocol: "openai"
    },
    mockContext()
  );
  assert.equal(result.continueLoop, false);
});

test("response hook: rejects invalid hash_id format", async () => {
  const response = {
    choices: [{
      message: {
        tool_calls: [{
          id: "c1", type: "function",
          function: { name: "hc_recall", arguments: JSON.stringify({ hash_id: "not-hex!!" }) }
        }]
      }
    }]
  };
  const result = await helixCompressorResponseHook(
    {
      body: {}, headers: {}, method: "POST", path: "/v1/chat",
      requestId: "r1", responsePayload: response, statusCode: 200, protocol: "openai"
    },
    mockContext()
  );
  assert.equal(result.continueLoop, false);
});

test("response hook: limits recall to MAX_RECALL_PER_REQUEST", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ results: [] })
  });

  const response = {
    choices: [{
      message: {
        tool_calls: Array.from({ length: 5 }, (_, i) => ({
          id: `call_${i}`,
          type: "function",
          function: {
            name: "hc_recall",
            arguments: JSON.stringify({ hash_id: `abc1234${i}def${i}` })
          }
        }))
      }
    }]
  };

  const result = await helixCompressorResponseHook(
    {
      body: {}, headers: {}, method: "POST", path: "/v1/chat",
      requestId: "r1", responsePayload: response, statusCode: 200, protocol: "openai"
    },
    mockContext()
  );

  assert.equal(result.continueLoop, true);
  assert.equal(result.messagesToAppend?.length, 3);

  global.fetch = originalFetch;
});

test("response hook: handles batch recall success", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ results: [{ hash: "abc123def456", original: "The original content" }] })
  });

  const result = await helixCompressorResponseHook(
    {
      body: {}, headers: {}, method: "POST", path: "/v1/chat",
      requestId: "r1", responsePayload: mockResponseWithToolCalls(),
      statusCode: 200, protocol: "openai"
    },
    mockContext()
  );

  assert.equal(result.continueLoop, true);
  assert.equal(result.messagesToAppend?.length, 1);
  assert.equal(result.messagesToAppend[0].role, "tool");
  assert.equal(result.messagesToAppend[0].tool_call_id, "call_1");
  assert.equal(result.messagesToAppend[0].content, "The original content");

  global.fetch = originalFetch;
});

test("response hook: handles hash miss gracefully", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ results: [] })
  });

  const result = await helixCompressorResponseHook(
    {
      body: {}, headers: {}, method: "POST", path: "/v1/chat",
      requestId: "r1", responsePayload: mockResponseWithToolCalls(),
      statusCode: 200, protocol: "openai"
    },
    mockContext()
  );

  assert.equal(result.continueLoop, true);
  assert.ok(result.messagesToAppend[0].content.includes("not found"));

  global.fetch = originalFetch;
});

test("response hook: Anthropic protocol returns user+tool_result", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ results: [{ hash: "abc123def456", original: "Original" }] })
  });

  const response = {
    content: [{
      type: "tool_use",
      id: "toolu_1",
      name: "hc_recall",
      input: { hash_id: "abc123def456", reason: "details" }
    }]
  };

  const result = await helixCompressorResponseHook(
    {
      body: {}, headers: {}, method: "POST", path: "/v1/messages",
      requestId: "r1", responsePayload: response, statusCode: 200, protocol: "anthropic"
    },
    mockContext()
  );

  assert.equal(result.continueLoop, true);
  assert.equal(result.messagesToAppend[0].role, "user");
  assert.ok(Array.isArray(result.messagesToAppend[0].content));
  assert.equal(result.messagesToAppend[0].content[0].type, "tool_result");
  assert.equal(result.messagesToAppend[0].content[0].tool_use_id, "toolu_1");

  global.fetch = originalFetch;
});

// ============= H2 修复验证: Anthropic 格式 schema =============

test("HC_RECALL_TOOL_SCHEMA_ANTHROPIC uses Anthropic format (no type:function, has input_schema)", () => {
  assert.equal(HC_RECALL_TOOL_SCHEMA_ANTHROPIC.name, "hc_recall");
  assert.equal(HC_RECALL_TOOL_SCHEMA_ANTHROPIC.type, undefined, "Anthropic 顶层无 type 字段");
  assert.equal(HC_RECALL_TOOL_SCHEMA_ANTHROPIC.function, undefined, "Anthropic 顶层无 function 包裹");
  assert.ok(HC_RECALL_TOOL_SCHEMA_ANTHROPIC.input_schema, "Anthropic 必须有 input_schema");
  assert.equal(HC_RECALL_TOOL_SCHEMA_ANTHROPIC.input_schema.type, "object");
  assert.ok(HC_RECALL_TOOL_SCHEMA_ANTHROPIC.input_schema.properties.hash_id);
  assert.ok(HC_RECALL_TOOL_SCHEMA_ANTHROPIC.input_schema.properties.reason);
  assert.ok(HC_RECALL_TOOL_SCHEMA_ANTHROPIC.input_schema.required.includes("hash_id"));
});

test("HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC uses Anthropic format with with_media", () => {
  assert.equal(HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC.name, "history_recall");
  assert.equal(HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC.type, undefined);
  assert.equal(HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC.function, undefined);
  assert.ok(HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC.input_schema);
  assert.ok(HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC.input_schema.properties.hash_id);
  assert.ok(HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC.input_schema.properties.with_media);
  assert.ok(HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC.input_schema.properties.reason);
  assert.ok(HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC.input_schema.required.includes("hash_id"));
});

test("OpenAI and Anthropic HC schemas have equivalent field semantics", () => {
  const openaiParams = HC_RECALL_TOOL_SCHEMA.function.parameters;
  const anthropicSchema = HC_RECALL_TOOL_SCHEMA_ANTHROPIC.input_schema;
  assert.deepEqual(
    Object.keys(openaiParams.properties).sort(),
    Object.keys(anthropicSchema.properties).sort(),
    "两个 schema 必须有相同的 properties key 集合"
  );
  assert.deepEqual(openaiParams.required, anthropicSchema.required, "required 字段必须一致");
  assert.equal(openaiParams.type, anthropicSchema.type, "type 必须一致");
});

test("OpenAI and Anthropic HISTORY schemas have equivalent field semantics", () => {
  const openaiParams = HISTORY_RECALL_TOOL_SCHEMA.function.parameters;
  const anthropicSchema = HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC.input_schema;
  assert.deepEqual(
    Object.keys(openaiParams.properties).sort(),
    Object.keys(anthropicSchema.properties).sort(),
    "两个 schema 必须有相同的 properties key 集合"
  );
  assert.deepEqual(openaiParams.required, anthropicSchema.required, "required 字段必须一致");
});
