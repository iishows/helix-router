/**
 * Helix Compressor Anthropic 协议 schema 注入测试
 *
 * 覆盖 H2 修复: Helix 应根据请求 body 的 tools 格式自动注入
 * 对应协议的 recall 工具 schema (OpenAI vs Anthropic)。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  helixCompressorTransform,
  HISTORY_RECALL_TOOL_SCHEMA,
  HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC
} from "@ccr/core/plugins/built-ins/helix-compressor.ts";

const HELIX_API = "https://api.helix-compressor.com";

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
      helixApiKey: "hk_test_xxx",
      sampleMod: 999,  // 关掉 evaluator 抽样
      ...overrides.pluginConfig
    },
    pluginId: "helix-compressor",
    openSqliteStore: async () => { throw new Error("not implemented"); },
    ...overrides
  };
}

/**
 * 构造一个会返回 ⟦QA:hash⟧ 占位符的 cloud 响应
 * (因 keepRecentPairs=0 时所有 Q&A 都被压成占位符)
 */
function buildMockCompressResponse() {
  return {
    compressed: [
      { role: "user", content: "⟦QA:abc123def4567890⟧" },
      { role: "assistant", content: "OK." }
    ],
    stats: { originalChars: 1000, compressedChars: 100, ratio: 0.9, compressedCount: 1 }
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

test("Anthropic body → Helix 注入 Anthropic 格式 history_recall (input_schema)", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => buildMockCompressResponse()
  });

  const result = await helixCompressorTransform(
    {
      body: { tools: ANTHROPIC_TOOLS, messages: [{ role: "user", content: "hi" }] },
      headers: {},
      method: "POST",
      path: "/v1/messages",
      requestId: "test-anthropic-1",
      url: "/v1/messages"
    },
    mockContext({ pluginConfig: { keepRecentPairs: 0 } })
  );

  assert.ok(result, "transform 应当返回结果");
  assert.ok(Array.isArray(result.body.tools), "应当有 tools 数组");
  const historyTool = result.body.tools.find(t => t.name === "history_recall" || (t.function && t.function.name === "history_recall"));
  assert.ok(historyTool, "应当注入 history_recall");

  // 关键断言: 是 Anthropic 格式 (input_schema), 不是 OpenAI (function.parameters)
  assert.equal(historyTool.type, undefined, "Anthropic 协议 schema 顶层无 type");
  assert.equal(historyTool.function, undefined, "Anthropic 协议 schema 顶层无 function");
  assert.ok(historyTool.input_schema, "Anthropic 协议 schema 必须有 input_schema");
  assert.deepEqual(
    historyTool,
    HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC,
    "应当等于 HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC"
  );
  assert.notDeepEqual(
    historyTool,
    HISTORY_RECALL_TOOL_SCHEMA,
    "不应等于 OpenAI 格式 schema"
  );

  global.fetch = originalFetch;
});

test("OpenAI body → Helix 注入 OpenAI 格式 history_recall (parameters)", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => buildMockCompressResponse()
  });

  const result = await helixCompressorTransform(
    {
      body: { tools: OPENAI_TOOLS, messages: [{ role: "user", content: "hi" }] },
      headers: {},
      method: "POST",
      path: "/v1/chat/completions",
      requestId: "test-openai-1",
      url: "/v1/chat/completions"
    },
    mockContext({ pluginConfig: { keepRecentPairs: 0 } })
  );

  assert.ok(result);
  const historyTool = result.body.tools.find(t =>
    t.name === "history_recall" || (t.function && t.function.name === "history_recall")
  );
  assert.ok(historyTool, "应当注入 history_recall");

  // OpenAI 格式
  assert.equal(historyTool.type, "function");
  assert.ok(historyTool.function);
  assert.equal(historyTool.function.name, "history_recall");
  assert.ok(historyTool.function.parameters);
  assert.deepEqual(
    historyTool,
    HISTORY_RECALL_TOOL_SCHEMA,
    "应当等于 HISTORY_RECALL_TOOL_SCHEMA (OpenAI)"
  );
  assert.notDeepEqual(
    historyTool,
    HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC,
    "不应等于 Anthropic 格式 schema"
  );

  global.fetch = originalFetch;
});

test("无 tools 的 body → 默认 OpenAI 格式 (向后兼容)", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => buildMockCompressResponse()
  });

  const result = await helixCompressorTransform(
    {
      body: { messages: [{ role: "user", content: "hi" }] },  // 无 tools
      headers: {},
      method: "POST",
      path: "/v1/chat/completions",
      requestId: "test-no-tools-1",
      url: "/v1/chat/completions"
    },
    mockContext({ pluginConfig: { keepRecentPairs: 0 } })
  );

  assert.ok(result);
  const historyTool = result.body.tools.find(t =>
    t.name === "history_recall" || (t.function && t.function.name === "history_recall")
  );
  assert.ok(historyTool, "应当注入 history_recall");
  // 默认 OpenAI
  assert.equal(historyTool.type, "function");

  global.fetch = originalFetch;
});

test("查重: Anthropic body 已含 history_recall (Anthropic 格式) → 不重复注入", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => buildMockCompressResponse()
  });

  const result = await helixCompressorTransform(
    {
      body: {
        tools: [...ANTHROPIC_TOOLS, HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC],  // 已含
        messages: [{ role: "user", content: "hi" }]
      },
      headers: {},
      method: "POST",
      path: "/v1/messages",
      requestId: "test-dedup-1",
      url: "/v1/messages"
    },
    mockContext({ pluginConfig: { keepRecentPairs: 0 } })
  );

  assert.ok(result);
  const historyTools = result.body.tools.filter(t =>
    t.name === "history_recall" || (t.function && t.function.name === "history_recall")
  );
  assert.equal(historyTools.length, 1, "不应重复注入 history_recall");

  global.fetch = originalFetch;
});

test("查重: Anthropic body 已含 history_recall (OpenAI 格式,误用) → 仍会注入 Anthropic 版本", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => buildMockCompressResponse()
  });

  // body 是 Anthropic 格式但 history_recall 是 OpenAI 格式 (理论上不应该存在, 但测试查重的边界情况)
  const result = await helixCompressorTransform(
    {
      body: {
        tools: [...ANTHROPIC_TOOLS, HISTORY_RECALL_TOOL_SCHEMA],  // OpenAI 格式的 history_recall
        messages: [{ role: "user", content: "hi" }]
      },
      headers: {},
      method: "POST",
      path: "/v1/messages",
      requestId: "test-mixed-1",
      url: "/v1/messages"
    },
    mockContext({ pluginConfig: { keepRecentPairs: 0 } })
  );

  assert.ok(result);
  // 查重逻辑兼容两种格式的 name, 所以不会重复注入
  const historyTools = result.body.tools.filter(t =>
    t.name === "history_recall" || (t.function && t.function.name === "history_recall")
  );
  assert.equal(historyTools.length, 1, "查重应兼容两种格式, 只注入 1 个");
});