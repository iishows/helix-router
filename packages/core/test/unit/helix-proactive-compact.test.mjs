/**
 * Helix 主动 compact 单测(2026-10-15)
 *
 * 覆盖:门控 / 切点(不拆 tool 对) / 摘要调用与降级 / 缓存复用 / 增量摘要 / 组装。
 * 摘要上游用 mock fetch 捕获(不真连网络)。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import {
  applyHelixProactiveCompact,
  buildSummaryPrompt,
  foldBoundary,
  isUsableSummaryResponse,
  leadingSystemMessageCount,
  mergeSystemSummary,
  planCompactFold,
  readProactiveCompactSettingsFromConfig,
  resolveCompactBudgetTokens,
  stripRecallPrefix
} from "@ccr/core/gateway/features/helix-proactive-compact.ts";
import { _resetIndexForTest } from "@ccr/core/observability/helix-compact-summary-store.ts";

let cacheDir;

before(() => {
  cacheDir = mkdtempSync(path.join(os.tmpdir(), "helix-compact-unit-"));
  process.env.HELIX_RECALL_CACHE_DIR = cacheDir;
});

after(() => {
  rmSync(cacheDir, { force: true, recursive: true });
  delete process.env.HELIX_RECALL_CACHE_DIR;
});

function resetCacheIndex() {
  _resetIndexForTest();
}

function testConfig(overrides = {}) {
  return {
    Providers: [
      {
        api_base_url: "http://127.0.0.1:9999/v1",
        api_key: "test-key",
        models: ["MiniMax-M3"],
        name: "MiniMax",
        type: "openai_chat_completions"
      }
    ],
    Router: { fallback: { mode: "off", models: [], retryCount: 0 } },
    gateway: {},
    ...overrides
  };
}

function settings(overrides = {}) {
  return {
    // 旧用例断言的是「只按人类轮切点」的语义;激进折叠/最小收益门槛另有专门用例。
    aggressiveFolding: false,
    cacheTtlMs: 3 * 24 * 60 * 60 * 1000,
    ceilingTokens: 120000,
    floorTokens: 48000,
    keepRecentTurns: 2,
    minFoldedTokens: 0,
    minNewMessages: 0,
    model: "",
    percent: 0,
    percentOverrides: {},
    timeoutMs: 5000,
    tokenBudget: 10,
    ...overrides
  };
}

/** 多轮 + tool 对的样例:folded 边界应落在倒数第 2 个「新用户轮起点」。 */
function multiTurnMessages() {
  return [
    { content: "q1", role: "user" },
    { content: "a1", role: "assistant" },
    { content: [{ id: "tu_1", input: { p: 1 }, name: "Read", type: "tool_use" }], role: "assistant" },
    { content: [{ content: "tool out", tool_use_id: "tu_1", type: "tool_result" }], role: "user" },
    { content: "q2", role: "user" },
    { content: "a2", role: "assistant" },
    { content: "q3", role: "user" },
    { content: "a3", role: "assistant" },
    { content: "q4", role: "user" }
  ];
}

function withMockFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ body, headers: init?.headers, url: String(input) });
    return handler({ body, calls, init, url: String(input) });
  };
  return Promise.resolve()
    .then(() => run(calls))
    .finally(() => {
      globalThis.fetch = original;
    });
}

function openAiSummaryResponse(text) {
  return new Response(JSON.stringify({ choices: [{ message: { content: text, role: "assistant" } }] }), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

// ============= foldBoundary =============

test("foldBoundary: boundary 恰在倒数第 2 个新用户轮起点,无 tool 对跨切点", () => {
  const messages = multiTurnMessages();
  const boundary = foldBoundary(messages, 2);
  // 新用户轮起点 = index 0 / 4 / 6 / 8(索引 3 含 tool_result,不是起点)
  assert.equal(boundary, 6);
  const folded = messages.slice(0, boundary);
  const kept = messages.slice(boundary);
  const foldedToolUse = folded.some((m) => JSON.stringify(m).includes("tool_use"));
  const foldedToolResult = folded.some((m) => JSON.stringify(m).includes("tool_result"));
  assert.equal(foldedToolUse, true);
  assert.equal(foldedToolResult, true, "tool 对必须整体落在 folded 侧");
  assert.equal(kept.some((m) => JSON.stringify(m).includes("tool_")), false, "kept 侧不得残留半个 tool 对");
});

test("foldBoundary: 新用户轮不足 keepRecentTurns → undefined", () => {
  assert.equal(foldBoundary([{ content: "q", role: "user" }], 2), undefined);
  assert.equal(foldBoundary([
    { content: "q1", role: "user" },
    { content: "a1", role: "assistant" },
    { content: "q2", role: "user" }
  ], 2), undefined);
});

test("foldBoundary: boundary 落在索引 0 时返回 undefined(无更早历史可折)", () => {
  const messages = [
    { content: "q1", role: "user" },
    { content: "a1", role: "assistant" },
    { content: "q2", role: "user" },
    { content: "a2", role: "assistant" }
  ];
  assert.equal(foldBoundary(messages, 1), 2);
  assert.equal(foldBoundary(messages, 2), undefined);
});

// ============= mergeSystemSummary =============

test("mergeSystemSummary: 字符串 system 追加摘要段", () => {
  assert.equal(mergeSystemSummary("you are cc", "SUM"), "you are cc\n\n[CCR compacted summary]\nSUM");
});

test("mergeSystemSummary: 块数组 system 追加 text 块", () => {
  const out = mergeSystemSummary([{ text: "x", type: "text" }], "SUM");
  assert.equal(Array.isArray(out), true);
  assert.equal(out.length, 2);
  assert.equal(out[1].type, "text");
  assert.match(out[1].text, /SUM/);
});

test("mergeSystemSummary: 无 system 时返回摘要段", () => {
  assert.equal(mergeSystemSummary(undefined, "SUM"), "[CCR compacted summary]\nSUM");
  assert.equal(mergeSystemSummary("   ", "SUM"), "[CCR compacted summary]\nSUM");
});

// ============= 配置读取 =============

test("readProactiveCompactSettingsFromConfig: 缺省 + 覆盖", () => {
  const d = readProactiveCompactSettingsFromConfig(undefined);
  assert.equal(d.tokenBudget, 100000);
  assert.equal(d.keepRecentTurns, 2);
  assert.equal(d.aggressiveFolding, true);
  assert.equal(d.minFoldedTokens, 1024);
  assert.equal(d.timeoutMs, 60000);
  assert.equal(d.model, "");
  assert.equal(d.cacheTtlMs, 259200000);

  const o = readProactiveCompactSettingsFromConfig({
    keepRecentTurns: 4,
    proactiveCompactModel: "Other/model",
    tokenBudget: 0
  });
  assert.equal(o.tokenBudget, 0);
  assert.equal(o.keepRecentTurns, 4);
  assert.equal(o.model, "Other/model");
});

test("stripRecallPrefix: 剥掉 ccr-helix-recall/ 前缀", () => {
  assert.equal(stripRecallPrefix("ccr-helix-recall/MiniMax-M3"), "MiniMax-M3");
  assert.equal(stripRecallPrefix("MiniMax-M3"), "MiniMax-M3");
});

// ============= resolveCompactBudgetTokens =============

/** 带显式 modelMetadata 的配置:contextWindow 直接钉死,避免依赖打包目录。 */
function budgetConfig(contextWindow, model = "Demo-Model") {
  return {
    Providers: [
      {
        api_base_url: "http://127.0.0.1:9999/v1",
        api_key: "k",
        modelMetadata: { [model]: { contextWindow } },
        models: [model],
        name: "Demo",
        type: "openai_chat_completions"
      }
    ],
    Router: { fallback: { mode: "off", models: [], retryCount: 0 } },
    gateway: {}
  };
}

function budgetSettings(overrides = {}) {
  return {
    ceilingTokens: 120000,
    floorTokens: 48000,
    percent: 50,
    percentOverrides: {},
    tokenBudget: 100000,
    ...overrides
  };
}

test("resolveCompactBudgetTokens: percent<=0 → 回退绝对 tokenBudget", () => {
  const config = budgetConfig(200000);
  const r = resolveCompactBudgetTokens(config, budgetSettings({ percent: 0 }), "Demo-Model");
  assert.equal(r.budget, 100000);
  assert.equal(r.percent, undefined);
  assert.equal(r.contextWindow, undefined);
});

test("resolveCompactBudgetTokens: 中间值 = floor(context × percent%)", () => {
  const config = budgetConfig(200000);
  const r = resolveCompactBudgetTokens(config, budgetSettings(), "Demo-Model");
  assert.equal(r.contextWindow, 200000);
  assert.equal(r.percent, 50);
  assert.equal(r.budget, 100000);
});

test("resolveCompactBudgetTokens: 超大上下文 → 命中 ceiling(120k 硬顶)", () => {
  const config = budgetConfig(900000);
  const r = resolveCompactBudgetTokens(config, budgetSettings(), "Demo-Model");
  assert.equal(r.budget, 120000);
});

test("resolveCompactBudgetTokens: 小上下文 → 命中 floor(48k 下限)", () => {
  const config = budgetConfig(80000);
  const r = resolveCompactBudgetTokens(config, budgetSettings(), "Demo-Model");
  assert.equal(r.budget, 48000);
});

test("resolveCompactBudgetTokens: 拿不到上下文长度 → 回退 tokenBudget", () => {
  // metadata 无 contextWindow 且模型名不在目录里 → 上下文长度 0 → 回退绝对预算。
  const config = budgetConfig(undefined, "no-such-model-zzz");
  const r = resolveCompactBudgetTokens(config, budgetSettings(), "no-such-model-zzz");
  assert.equal(r.budget, 100000);
  assert.ok(!r.contextWindow, "拿不到上下文长度时返回 falsy");
});

test("resolveCompactBudgetTokens: percentOverrides 按真实 model 名优先", () => {
  const config = budgetConfig(200000);
  const r = resolveCompactBudgetTokens(
    config,
    budgetSettings({ percentOverrides: { "Demo-Model": 10 }, percent: 50 }),
    "Demo-Model"
  );
  assert.equal(r.percent, 10);
  assert.equal(r.budget, 48000, "10% × 200k = 20k, 被 floor 抬到 48k");
});

test("resolveCompactBudgetTokens: override 命中被 stripRecallPrefix 剥前缀后的选择器", () => {
  const config = budgetConfig(200000);
  const r = resolveCompactBudgetTokens(
    config,
    budgetSettings({ percentOverrides: { "Demo-Model": 80 }, percent: 50 }),
    "ccr-helix-recall/Demo-Model"
  );
  assert.equal(r.percent, 80);
  assert.equal(r.budget, 120000, "80% × 200k = 160k, 被 ceiling 压到 120k");
});

// ============= 门控 =============

test("门控: postCompressionTokens <= tokenBudget → undefined", async () => {
  resetCacheIndex();
  const result = await applyHelixProactiveCompact({
    body: { messages: multiTurnMessages() },
    config: testConfig(),
    headers: {},
    model: "MiniMax-M3",
    postCompressionTokens: 5,
    settings: settings({ tokenBudget: 10 })
  });
  assert.equal(result, undefined);
});

test("门控: tokenBudget=0 关闭 → undefined", async () => {
  resetCacheIndex();
  const result = await applyHelixProactiveCompact({
    body: { messages: multiTurnMessages() },
    config: testConfig(),
    headers: {},
    model: "MiniMax-M3",
    postCompressionTokens: 999999,
    settings: settings({ tokenBudget: 0 })
  });
  assert.equal(result, undefined);
});

test("门控: 显式 compact 信号(headers) → undefined(避免双折叠)", async () => {
  resetCacheIndex();
  const result = await applyHelixProactiveCompact({
    body: { messages: multiTurnMessages() },
    config: testConfig(),
    headers: { "x-ccr-context-compact": "1" },
    model: "MiniMax-M3",
    postCompressionTokens: 999999,
    settings: settings()
  });
  assert.equal(result, undefined);
});

test("门控: 主体 metadata.ccr_context_compact → undefined", async () => {
  resetCacheIndex();
  const result = await applyHelixProactiveCompact({
    body: { messages: multiTurnMessages(), metadata: { ccr_context_compact: true } },
    config: testConfig(),
    headers: {},
    model: "MiniMax-M3",
    postCompressionTokens: 999999,
    settings: settings()
  });
  assert.equal(result, undefined);
});

test("门控: 新用户轮不足 → undefined", async () => {
  resetCacheIndex();
  const result = await applyHelixProactiveCompact({
    body: { messages: [{ content: "q", role: "user" }] },
    config: testConfig(),
    headers: {},
    model: "MiniMax-M3",
    postCompressionTokens: 999999,
    settings: settings()
  });
  assert.equal(result, undefined);
});

test("门控: 模型无法解析到 upstream provider → undefined(不报错)", async () => {
  resetCacheIndex();
  const result = await applyHelixProactiveCompact({
    body: { messages: multiTurnMessages() },
    config: testConfig(),
    headers: {},
    model: "Unknown/nope",
    postCompressionTokens: 999999,
    settings: settings()
  });
  assert.equal(result, undefined);
});

test("门控: percent=0 且 tokenBudget=0 → undefined(两条路径都关闭)", async () => {
  resetCacheIndex();
  const result = await applyHelixProactiveCompact({
    body: { messages: multiTurnMessages() },
    config: testConfig(),
    headers: {},
    model: "MiniMax-M3",
    postCompressionTokens: 999999,
    settings: settings({ tokenBudget: 0, percent: 0 })
  });
  assert.equal(result, undefined);
});

test("门控: percent 路径下 postCompressionTokens <= 有效预算 → undefined", async () => {
  resetCacheIndex();
  // Demo-Model 上下文 200k × 50% = 100k 预算;postCompressionTokens 5 应被门控拦下。
  const config = budgetConfig(200000);
  const result = await applyHelixProactiveCompact({
    body: { messages: multiTurnMessages() },
    config,
    headers: {},
    model: "Demo-Model",
    postCompressionTokens: 5,
    settings: settings({ percent: 50, tokenBudget: 0 })
  });
  assert.equal(result, undefined);
});

// ============= 摘要调用 / 降级 =============

test("降级: fetch 抛错 → undefined,原 body 不变", async () => {
  resetCacheIndex();
  await withMockFetch(() => {
    throw new Error("network down");
  }, async (calls) => {
    const result = await applyHelixProactiveCompact({
      body: { messages: multiTurnMessages() },
      config: testConfig(),
      headers: {},
      model: "MiniMax-M3",
      postCompressionTokens: 999999,
      settings: settings()
    });
    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
  });
});

test("降级: 非 2xx → undefined", async () => {
  resetCacheIndex();
  await withMockFetch(() => new Response("nope", { status: 500 }), async () => {
    const result = await applyHelixProactiveCompact({
      body: { messages: multiTurnMessages() },
      config: testConfig(),
      headers: {},
      model: "MiniMax-M3",
      postCompressionTokens: 999999,
      settings: settings()
    });
    assert.equal(result, undefined);
  });
});

test("降级: 空文本 → undefined", async () => {
  resetCacheIndex();
  await withMockFetch(() => openAiSummaryResponse(""), async () => {
    const result = await applyHelixProactiveCompact({
      body: { messages: multiTurnMessages() },
      config: testConfig(),
      headers: {},
      model: "MiniMax-M3",
      postCompressionTokens: 999999,
      settings: settings()
    });
    assert.equal(result, undefined);
  });
});

// ============= 推理模型:摘要被 reasoning_content 吃光 =============

test("推理模型:摘要请求带 enable_thinking:false(避免 max_tokens 被 reasoning 吃光)", async () => {
  resetCacheIndex();
  await withMockFetch(() => openAiSummaryResponse("HANDOFF SUMMARY REASONING"), async (calls) => {
    const result = await applyHelixProactiveCompact({
      body: { messages: multiTurnMessages() },
      config: testConfig(),
      headers: { "x-session-id": "sess-reasoning" },
      model: "MiniMax-M3",
      postCompressionTokens: 999999,
      settings: settings()
    });
    assert.ok(result, "摘要成功后应折叠");
    assert.equal(calls.length, 1, "关思考一次成功,不应重试");
    assert.equal(calls[0].body.enable_thinking, false, "OpenAI Chat 请求应带 enable_thinking:false");
    assert.match(result.requestBody.system, /HANDOFF SUMMARY REASONING/);
  });
});

test("推理模型:provider 拒绝 enable_thinking(4xx)→ 退回原样请求(零回归)", async () => {
  resetCacheIndex();
  let call = 0;
  await withMockFetch(() => {
    call += 1;
    return call === 1
      ? new Response("unknown field enable_thinking", { status: 400 })
      : openAiSummaryResponse("FALLBACK SUMMARY");
  }, async (calls) => {
    const result = await applyHelixProactiveCompact({
      body: { messages: multiTurnMessages() },
      config: testConfig(),
      headers: { "x-session-id": "sess-fallback" },
      model: "MiniMax-M3",
      postCompressionTokens: 999999,
      settings: settings()
    });
    assert.ok(result, "退回后应成功");
    assert.equal(calls.length, 2, "先带开关被拒,再去掉开关重试");
    assert.equal(calls[0].body.enable_thinking, false);
    assert.equal(calls[1].body.enable_thinking, undefined, "退回请求不应含该字段");
    assert.match(result.requestBody.system, /FALLBACK SUMMARY/);
  });
});

test("推理模型:200 但正文为空(仍被 reasoning 吃光)→ 不盲目重试,直接 undefined", async () => {
  resetCacheIndex();
  await withMockFetch(() => openAiSummaryResponse(""), async (calls) => {
    const result = await applyHelixProactiveCompact({
      body: { messages: multiTurnMessages() },
      config: testConfig(),
      headers: { "x-session-id": "sess-empty-reasoning" },
      model: "MiniMax-M3",
      postCompressionTokens: 999999,
      settings: settings()
    });
    assert.equal(result, undefined);
    assert.equal(calls.length, 1, "形状对但正文空 → 不重试(重试同形状无意义)");
  });
});

// ============= 成功路径 / 缓存 / 增量 =============

test("成功: 折叠前缀 + system 注入摘要,diagnostic source=model", async () => {
  resetCacheIndex();
  const messages = multiTurnMessages();
  await withMockFetch(() => openAiSummaryResponse("HANDOFF SUMMARY ONE"), async (calls) => {
    const result = await applyHelixProactiveCompact({
      body: { messages, system: "you are cc" },
      config: testConfig(),
      headers: { "x-session-id": "sess-A" },
      model: "MiniMax-M3",
      postCompressionTokens: 999999,
      settings: settings()
    });
    assert.ok(result);
    assert.equal(result.requestBody.messages.length, 3, "只保留最近 2 轮 + 当前轮");
    assert.deepEqual(result.requestBody.messages.map((m) => m.content), ["q3", "a3", "q4"]);
    assert.match(result.requestBody.system, /\[CCR compacted summary\]/);
    assert.match(result.requestBody.system, /HANDOFF SUMMARY ONE/);
    assert.match(result.requestBody.system, /you are cc/);
    assert.match(result.diagnostic, /source=model/);
    assert.match(result.diagnostic, /gen=6/);
    // 绝对 tokenBudget 路径:budgetTokens = tokenBudget,并写入 diagnostic。
    assert.equal(result.budgetTokens, 10, "settings().tokenBudget=10");
    assert.match(result.diagnostic, /budget=10/);
    // 结构化数值(router-plugin 用它构建 x-ccr-helix-compact-json + sidecar)
    assert.equal(result.source, "model");
    assert.equal(result.coveredCount, 6);
    assert.equal(result.foldedCount, 6);
    assert.equal(typeof result.tokensAfter, "number");
    assert.ok(result.tokensAfter > 0);
    assert.equal(typeof result.summaryTokens, "number");
    assert.ok(result.summaryTokens > 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:9999/v1/chat/completions");
    assert.equal(calls[0].body.model, "MiniMax-M3");
    assert.equal(calls[0].body.stream, false);
    assert.match(calls[0].body.messages[0].content, /q1/);
  });
});

/** CC 自动 compact 的提示词(三个特征串齐全才会被判为 compact 申请)。 */
function claudeCompactPromptText() {
  return [
    "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
    "Your task is to create a detailed summary of the conversation so far.",
    "Your entire response must be plain text: an <analysis> block followed by a <summary> block."
  ].join("\n\n");
}

/** 历史中段残留一条 compact 提示词,最后一轮是普通用户输入。 */
function messagesWithStaleCompactPrompt() {
  return [
    { content: "q1", role: "user" },
    { content: "a1", role: "assistant" },
    { content: claudeCompactPromptText(), role: "user" },
    { content: "a2", role: "assistant" },
    { content: "q2", role: "user" },
    { content: "a2b", role: "assistant" },
    { content: "q3", role: "user" },
    { content: "a3", role: "assistant" },
    { content: "q4", role: "user" }
  ];
}

// 回归 (2026-11-03):历史上残留的 compact 提示词曾被当作「本轮在申请 compact」,
// 于是 CC 自动 compact 一次之后,主动 compact 在本会话内永久不再触发(实测 900+ 条消息未折叠)。
test("门控: 历史中段残留的 CC compact 提示词不阻断折叠(仅看本轮)", async () => {
  resetCacheIndex();
  const messages = messagesWithStaleCompactPrompt();
  await withMockFetch(() => openAiSummaryResponse("HANDOFF STALE PROMPT"), async (calls) => {
    const result = await applyHelixProactiveCompact({
      body: { messages, system: "you are cc" },
      config: testConfig(),
      headers: { "x-session-id": "sess-stale-prompt" },
      model: "MiniMax-M3",
      postCompressionTokens: 999999,
      settings: settings()
    });
    assert.ok(result, "历史里的旧 compact 提示词不应阻断本轮折叠");
    assert.deepEqual(result.requestBody.messages.map((m) => m.content), ["q3", "a3", "q4"]);
    assert.match(result.requestBody.system, /HANDOFF STALE PROMPT/);
    assert.equal(calls.length, 1);
  });
});

test("门控: 本轮(最后一条 user)是 CC compact 提示词 → undefined(避免双折叠)", async () => {
  resetCacheIndex();
  const messages = messagesWithStaleCompactPrompt();
  messages.push({ content: claudeCompactPromptText(), role: "user" });
  await withMockFetch(() => openAiSummaryResponse("SHOULD NOT BE USED"), async (calls) => {
    const result = await applyHelixProactiveCompact({
      body: { messages, system: "you are cc" },
      config: testConfig(),
      headers: { "x-session-id": "sess-live-prompt" },
      model: "MiniMax-M3",
      postCompressionTokens: 999999,
      settings: settings()
    });
    assert.equal(result, undefined, "本轮 compact 申请时不应再做主动折叠");
    assert.equal(calls.length, 0, "不应发起摘要请求");
  });
});

test("缓存: 同一折叠前缀第二次请求命中缓存,零额外 fetch", async () => {
  resetCacheIndex();
  const body = { messages: multiTurnMessages(), system: "you are cc" };
  const headers = { "x-session-id": "sess-B" };

  await withMockFetch(() => openAiSummaryResponse("CACHED SUMMARY"), async (first) => {
    const a = await applyHelixProactiveCompact({
      body, config: testConfig(), headers, model: "MiniMax-M3",
      postCompressionTokens: 999999, settings: settings()
    });
    assert.match(a.diagnostic, /source=model/);
    assert.equal(first.length, 1);
  });

  resetCacheIndex();
  await withMockFetch(() => openAiSummaryResponse("SHOULD NOT BE CALLED"), async (second) => {
    const b = await applyHelixProactiveCompact({
      body, config: testConfig(), headers, model: "MiniMax-M3",
      postCompressionTokens: 999999, settings: settings()
    });
    assert.ok(b);
    assert.match(b.diagnostic, /source=cache/);
    assert.equal(b.source, "cache");
    assert.equal(b.foldedCount, 6);
    assert.equal(typeof b.tokensAfter, "number");
    // 缓存命中路径不产生新的摘要调用 → summaryTokens 缺失(undefined)
    assert.equal(b.summaryTokens, undefined);
    assert.match(b.requestBody.system, /CACHED SUMMARY/);
    assert.equal(second.length, 0, "缓存命中不得再调上游");
  });
});

test("增量: 折叠前缀变长 → 只摘要 delta 并与旧摘要合并", async () => {
  resetCacheIndex();
  const long = multiTurnMessages();
  const headers = { "x-session-id": "sess-C" };

  // 第一次:前缀 = messages[0..5](boundary 6)
  await withMockFetch(() => openAiSummaryResponse("BASE HANDOFF"), async () => {
    const first = await applyHelixProactiveCompact({
      body: { messages: long, system: "sys" }, config: testConfig(), headers,
      model: "MiniMax-M3", postCompressionTokens: 999999, settings: settings()
    });
    assert.match(first.diagnostic, /source=model/);
  });

  // 追加两轮 → 新 boundary 后移,旧摘要成为新 folded 的严格前缀
  const grown = [
    ...long,
    { content: "a4", role: "assistant" },
    { content: "q5", role: "user" },
    { content: "a5", role: "assistant" },
    { content: "q6", role: "user" }
  ];
  resetCacheIndex();
  await withMockFetch(() => openAiSummaryResponse("MERGED HANDOFF"), async (calls) => {
    const second = await applyHelixProactiveCompact({
      body: { messages: grown, system: "sys" }, config: testConfig(), headers,
      model: "MiniMax-M3", postCompressionTokens: 999999, settings: settings()
    });
    assert.ok(second);
    assert.match(second.diagnostic, /source=incremental/);
    assert.equal(second.source, "incremental");
    assert.match(second.requestBody.system, /MERGED HANDOFF/);
    assert.equal(calls.length, 1);
    // 增量调用 prompt 必须带上旧摘要
    assert.match(calls[0].body.messages[0].content, /EXISTING HANDOFF/);
    assert.match(calls[0].body.messages[0].content, /BASE HANDOFF/);
  });
});

test("积攒: 新增未达阈值 → 复用旧摘要 + 中间段留原文,零上游调用", async () => {
  resetCacheIndex();
  const headers = { "x-session-id": "sess-acc" };
  const base = multiTurnMessages(); // 9 msgs, boundary=6, folded=6

  // 首次:摘要 folded[0..6)
  await withMockFetch(() => openAiSummaryResponse("FIRST HANDOFF"), async () => {
    const first = await applyHelixProactiveCompact({
      body: { messages: base, system: "sys" }, config: testConfig(), headers,
      model: "MiniMax-M3", postCompressionTokens: 999999, settings: settings()
    });
    assert.match(first.diagnostic, /source=model/);
  });

  // 追加 1 个新用户轮(2 条):boundary 6→8,folded 前缀变化 → 命中 prefix,但新增仅 2 < 100
  const grown = [...base, { content: "q5", role: "user" }, { content: "a5", role: "assistant" }];
  resetCacheIndex();
  await withMockFetch(() => openAiSummaryResponse("SHOULD NOT BE CALLED"), async (calls) => {
    const acc = await applyHelixProactiveCompact({
      body: { messages: grown, system: "sys" }, config: testConfig(), headers,
      model: "MiniMax-M3", postCompressionTokens: 999999,
      // 真实预算(不是测试默认的 10):复用受「2× 预算」上限约束。
      settings: settings({ minNewMessages: 100, tokenBudget: 100000 })
    });
    assert.ok(acc);
    // 2026-11-08: 复用路径改为「按旧摘要覆盖集合重建」,因此会精确命中缓存 key
    //   (source=cache),不再走旧 accumulate 的 index 语义。
    assert.equal(acc.source, "cache");
    assert.match(acc.diagnostic, /source=cache/);
    assert.equal(calls.length, 0, "未达阈值不得再调上游");
    // 复用旧摘要(覆盖原 6 条) + 新增历史留原文
    assert.match(acc.requestBody.system, /FIRST HANDOFF/);
    assert.equal(acc.requestBody.messages.length, grown.length - 6, "kept 从旧覆盖集合之后开始");
  });
});

test("积攒: 新增达阈值 → 走增量重摘(1 次调用)", async () => {
  resetCacheIndex();
  const headers = { "x-session-id": "sess-acc2" };
  const base = multiTurnMessages();

  await withMockFetch(() => openAiSummaryResponse("BASE"), async () => {
    await applyHelixProactiveCompact({
      body: { messages: base, system: "sys" }, config: testConfig(), headers,
      model: "MiniMax-M3", postCompressionTokens: 999999, settings: settings()
    });
  });

  // 追加足够多轮让新增 ≥ 阈值(10):每轮 4 条
  const grown = [...base];
  for (let i = 0; i < 4; i += 1) {
    grown.push(
      { content: `n${i}q`, role: "user" },
      { content: `n${i}a`, role: "assistant" },
      { content: `n${i}b`, role: "assistant" },
      { content: `n${i}c`, role: "assistant" }
    );
  }
  resetCacheIndex();
  await withMockFetch(() => openAiSummaryResponse("UPDATED"), async (calls) => {
    const r = await applyHelixProactiveCompact({
      body: { messages: grown, system: "sys" }, config: testConfig(), headers,
      model: "MiniMax-M3", postCompressionTokens: 999999,
      settings: settings({ minNewMessages: 10 })
    });
    assert.ok(r);
    assert.equal(r.source, "incremental");
    assert.equal(calls.length, 1, "达阈值 → 允许一次增量摘要");
    assert.match(calls[0].body.messages[0].content, /EXISTING HANDOFF/);
  });
});

test("归一: 复合 selector(Provider/model) → 摘要出站用配置内裸名", async () => {
  resetCacheIndex();
  // 复刻 live 现场:路由层给的是网关内部复合串,x-helix-compressor-model="MiniMax (China) 2/MiniMax-M3";
  //   上游只认裸名 MiniMax-M3。传复合串直发会被 400 unknown model。
  const config = {
    Providers: [
      {
        api_base_url: "http://127.0.0.1:9999/v1",
        api_key: "test-key",
        models: ["MiniMax-M3", "MiniMax-M2.7"],
        name: "MiniMax (China) 2",
        type: "openai_chat_completions"
      }
    ],
    Router: { fallback: { mode: "off", models: [], retryCount: 0 } },
    gateway: {}
  };
  await withMockFetch(() => openAiSummaryResponse("NORMALIZED HANDOFF"), async (calls) => {
    const result = await applyHelixProactiveCompact({
      body: { messages: multiTurnMessages() },
      config,
      headers: { "x-session-id": "sess-norm-a" },
      model: "MiniMax (China) 2/MiniMax-M3",
      postCompressionTokens: 999999,
      settings: settings()
    });
    assert.ok(result);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.model, "MiniMax-M3", "出站 model 必须是配置内裸名,不是复合 selector");
    assert.equal(calls[0].url, "http://127.0.0.1:9999/v1/chat/completions");
  });
});

test("归一: recall 虚拟前缀 + 复合 selector 也能剥净", async () => {
  resetCacheIndex();
  const config = {
    Providers: [
      {
        api_base_url: "http://127.0.0.1:9999/v1",
        api_key: "k",
        models: ["MiniMax-M3"],
        name: "MiniMax (China) 2",
        type: "openai_chat_completions"
      }
    ],
    Router: { fallback: { mode: "off", models: [], retryCount: 0 } },
    gateway: {}
  };
  await withMockFetch(() => openAiSummaryResponse("X"), async (calls) => {
    const result = await applyHelixProactiveCompact({
      body: { messages: multiTurnMessages() },
      config,
      headers: { "x-session-id": "sess-norm-b" },
      model: "ccr-helix-recall/MiniMax (China) 2/MiniMax-M3",
      postCompressionTokens: 999999,
      settings: settings()
    });
    assert.ok(result);
    assert.equal(calls[0].body.model, "MiniMax-M3");
  });
});

test("anthropic 协议: 摘要请求打到 /v1/messages 且带 anthropic-version", async () => {
  resetCacheIndex();
  const config = {
    Providers: [
      {
        api_base_url: "http://127.0.0.1:9998",
        api_key: "anthropic-key",
        models: ["claude-opus-5-5"],
        name: "Anthropic",
        type: "anthropic_messages"
      }
    ],
    Router: { fallback: { mode: "off", models: [], retryCount: 0 } },
    gateway: {}
  };
  await withMockFetch(() => new Response(JSON.stringify({
    content: [{ text: "ANTHROPIC HANDOFF", type: "text" }],
    role: "assistant",
    type: "message"
  }), { headers: { "content-type": "application/json" }, status: 200 }), async (calls) => {
    const result = await applyHelixProactiveCompact({
      body: { messages: multiTurnMessages() },
      config,
      headers: { "x-session-id": "sess-anthropic" },
      model: "claude-opus-5-5",
      postCompressionTokens: 999999,
      settings: settings()
    });
    assert.ok(result);
    assert.match(result.requestBody.system, /ANTHROPIC HANDOFF/);
    assert.equal(calls[0].url, "http://127.0.0.1:9998/v1/messages");
    assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
    assert.equal(calls[0].headers["x-api-key"], "anthropic-key");
  });
});

// ============= 摘要端点选择 / HTML 响应防护(2026-11 事故) =============

function unversionedOpenAiConfig(overrides = {}) {
  return {
    Providers: [
      {
        api_base_url: "http://127.0.0.1:9997",
        api_key: "k",
        models: ["MiniMax-M3"],
        name: "Unversioned",
        type: "openai_chat_completions",
        ...overrides
      }
    ],
    Router: { fallback: { mode: "off", models: [], retryCount: 0 } },
    gateway: {}
  };
}

test("端点: baseUrl 不带 /v1 时优先使用带版本号的 /v1/chat/completions", async () => {
  resetCacheIndex();
  await withMockFetch(() => openAiSummaryResponse("V1 HANDOFF"), async (calls) => {
    const result = await applyHelixProactiveCompact({
      body: { messages: multiTurnMessages() },
      config: unversionedOpenAiConfig(),
      headers: { "x-session-id": "sess-unversioned" },
      model: "MiniMax-M3",
      postCompressionTokens: 999999,
      settings: settings()
    });
    assert.ok(result);
    assert.equal(calls[0].url, "http://127.0.0.1:9997/v1/chat/completions");
    assert.match(result.requestBody.system, /V1 HANDOFF/);
  });
});

test("端点: provider capability 声明的 endpoint 优先于 baseUrl 推导", async () => {
  resetCacheIndex();
  const config = unversionedOpenAiConfig({
    capabilities: [{ type: "openai_chat_completions", endpoint: "http://127.0.0.1:9997/custom/chat" }]
  });
  await withMockFetch(() => openAiSummaryResponse("CAPABILITY HANDOFF"), async (calls) => {
    const result = await applyHelixProactiveCompact({
      body: { messages: multiTurnMessages() },
      config,
      headers: { "x-session-id": "sess-capability" },
      model: "MiniMax-M3",
      postCompressionTokens: 999999,
      settings: settings()
    });
    assert.ok(result);
    assert.equal(calls[0].url, "http://127.0.0.1:9997/custom/chat");
  });
});

test("降级: 上游 200 text/html(SPA 兜底页)绝不当摘要使用", async () => {
  resetCacheIndex();
  const html = "<!doctype html>\n<html><head><title>Helix Gateway</title></head><body></body></html>";
  await withMockFetch(() => new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
    status: 200
  }), async () => {
    const result = await applyHelixProactiveCompact({
      body: { messages: multiTurnMessages(), system: "you are cc" },
      config: unversionedOpenAiConfig(),
      headers: { "x-session-id": "sess-html" },
      model: "MiniMax-M3",
      postCompressionTokens: 999999,
      settings: settings()
    });
    assert.equal(result, undefined, "HTML 响应必须视为失败,退回原 body");
  });
});

test("isUsableSummaryResponse: 只接受 JSON / SSE,拒绝 HTML 与非 JSON", () => {
  assert.equal(isUsableSummaryResponse('{"choices":[]}', "application/json"), true);
  assert.equal(isUsableSummaryResponse("data: {}\n", "text/event-stream"), true);
  assert.equal(isUsableSummaryResponse("data: {}\n", undefined), true);
  assert.equal(isUsableSummaryResponse("<!doctype html><html></html>", "text/html"), false);
  assert.equal(isUsableSummaryResponse("<html></html>", "application/json"), false);
  assert.equal(isUsableSummaryResponse("<error>bad</error>", undefined), false);
  assert.equal(isUsableSummaryResponse("not json", "text/plain"), false);
  assert.equal(isUsableSummaryResponse("", "application/json"), false);
});

// ============= 2026-11-08 激进折叠 / 头部 system 保护 / 最小收益门槛 =============

/** Anthropic 形态的完整 tool 交换对。 */
function anthropicToolPair(id, outputChars) {
  return [
    { content: [{ input: { command: "echo hi" }, name: "Bash", type: "tool_use", id }], role: "assistant" },
    { content: [{ content: "y".repeat(outputChars), tool_use_id: id, type: "tool_result" }], role: "user" }
  ];
}

/** 真实生产形态:头部是压缩器插入的合成 system(recall 教学),后面才是人类轮。 */
function agenticBody() {
  return [
    // helix compressor 往 messages 头部插入的合成 system 消息
    { content: "<<HC_RECALL_INSTRUCTION_v2>> use ⟦QA:...⟧ placeholders", role: "system" },
    { content: "task: wire the i18n copy", role: "user" },
    ...Array.from({ length: 4 }, (_, i) => anthropicToolPair(`a${i}`, 6000)).flat(),
    { content: "translate", role: "user" },
    ...Array.from({ length: 4 }, (_, i) => anthropicToolPair(`b${i}`, 6000)).flat(),
    { content: "only keep en/zh", role: "user" },
    ...Array.from({ length: 4 }, (_, i) => anthropicToolPair(`c${i}`, 6000)).flat()
  ];
}

function toolIds(messages) {
  const uses = new Set();
  const results = new Set();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === "tool_use") uses.add(block.id);
      if (block?.type === "tool_result") results.add(block.tool_use_id);
    }
  }
  return { results, uses };
}

test("leadingSystemMessageCount: 只统计头部连续 system", () => {
  assert.equal(leadingSystemMessageCount([
    { content: "s1", role: "system" },
    { content: "s2", role: "system" },
    { content: "q", role: "user" },
    { content: "s3", role: "system" }
  ]), 2);
  assert.equal(leadingSystemMessageCount([{ content: "q", role: "user" }]), 0);
});

test("planCompactFold: 激进模式按预算尽可能多保留整轮", () => {
  // 4 个人类轮,每轮 ~2k token;预算 3000 → 只能保留最后 2 轮。
  const messages = [];
  for (let t = 0; t < 4; t += 1) {
    messages.push({ content: `q${t}`, role: "user" });
    messages.push({ content: "x".repeat(4000), role: "assistant" });
    messages.push(...anthropicToolPair(`t${t}`, 4000));
  }
  const base = planCompactFold(messages, 2, 100000, false);
  assert.ok(base);
  assert.equal(base.folded.length, 8, "非激进:固定保留最后 2 轮");
  const aggressive = planCompactFold(messages, 2, 3000, true);
  assert.ok(aggressive);
  // 预算只够「最后一轮的起点 + 倒数第二轮尾部的一个完整 tool 交换对」→ 轮内部分保留。
  assert.equal(aggressive.folded.length, 9, "预算只够保留尾部约 3k token");
  assert.equal(aggressive.usedIntraTurn, true);
  assert.equal(aggressive.kept[0].content, "q2", "保留区从人类轮起点开始");
  assert.match(JSON.stringify(aggressive.kept), /t3/, "最近一轮保留");
});

test("planCompactFold: 预算充足时保留比 keepRecentTurns 更多的轮次", () => {
  // 头部一条可折的旧 assistant + 4 个小轮(每轮 ~700 token);预算 3000 足够容纳全部 4 轮。
  const messages = [{ content: "y".repeat(5000), role: "assistant" }];
  for (let t = 0; t < 4; t += 1) {
    messages.push({ content: `q${t}`, role: "user" });
    messages.push({ content: `a${t} ` + "x".repeat(2000), role: "assistant" });
  }
  const base = planCompactFold(messages, 2, 100000, false);
  assert.ok(base);
  assert.equal(base.kept.length, 4, "非激进:只保留最后 2 轮");
  const filled = planCompactFold(messages, 2, 3000, true);
  assert.ok(filled);
  assert.equal(filled.kept.length, 8, "激进:预算内应保留全部 4 轮");
  assert.equal(filled.kept[0].content, "q0");
  assert.equal(filled.folded.length, 1, "只折掉头部那条旧消息");
});

test("planCompactFold: 单轮超预算时保留轮起点 + 尾部能装下的交换对", () => {
  const pair = (id, size) => [
    { content: [{ id, input: {}, name: "Read", type: "tool_use" }], role: "assistant" },
    { content: [{ content: `${id} ` + "x".repeat(size), tool_use_id: id, type: "tool_result" }], role: "user" }
  ];
  const messages = [
    { content: "task0", role: "user" },
    { content: "T2 task", role: "user" },
    ...Array.from({ length: 10 }, (_, i) => pair(`p${i}`, 4000)).flat(),
    { content: "T3 task", role: "user" },
    { content: "a3", role: "assistant" }
  ];
  const plan = planCompactFold(messages, 2, 4000, true);
  assert.ok(plan);
  // 保留区必须以人类轮起点开始
  assert.equal(plan.kept[0].content, "T2 task");
  const keptText = JSON.stringify(plan.kept);
  assert.ok(!keptText.includes('"p0"'), "最早的大输出应被折叠");
  assert.match(keptText, /"p9"/, "最近的输出应保留");
  assert.ok(plan.usedIntraTurn, "轮内部分保留 → folded 不是纯前缀");
  assert.ok(plan.folded.length > 0);
});

test("planCompactFold: 保留区内只丢完整 tool 交换对,绝不拆对", () => {
  const messages = [
    { content: "task", role: "user" },
    ...Array.from({ length: 6 }, (_, i) => anthropicToolPair(`k${i}`, 6000)).flat(),
    { content: "next", role: "user" },
    ...Array.from({ length: 4 }, (_, i) => anthropicToolPair(`n${i}`, 6000)).flat()
  ];
  const plan = planCompactFold(messages, 2, 500, true);
  assert.ok(plan);
  assert.equal(plan.usedIntraTurn, true);
  const keptIds = toolIds(plan.kept);
  assert.deepEqual([...keptIds.uses].sort(), [...keptIds.results].sort(), "kept 侧 tool_use/tool_result 必须成对");
  const foldedIds = toolIds(plan.folded);
  assert.deepEqual([...foldedIds.uses].sort(), [...foldedIds.results].sort(), "folded 侧也必须成对");
  assert.notEqual(plan.kept.at(-1), undefined, "最后一条消息必须保留");
});

test("回归: 头部合成 system 消息绝不被折叠(生产事故 folded=1)", async () => {
  resetCacheIndex();
  const messages = agenticBody();
  const protectedSystem = messages[0];
  await withMockFetch(() => openAiSummaryResponse("AGENTIC HANDOFF"), async (calls) => {
    const result = await applyHelixProactiveCompact({
      body: { messages, system: "client system" },
      config: testConfig(),
      headers: { "x-session-id": "sess-agentic" },
      model: "MiniMax-M3",
      postCompressionTokens: 20000,
      settings: settings({ aggressiveFolding: true, keepRecentTurns: 2, tokenBudget: 3000 })
    });
    assert.ok(result, "应折叠而不是只折 1 条 system 消息");
    assert.ok(result.foldedCount > 1, `foldedCount 必须 > 1,实际 ${result.foldedCount}`);
    assert.deepEqual(result.requestBody.messages[0], protectedSystem, "头部 system 必须原样保留");
    assert.match(result.requestBody.system, /AGENTIC HANDOFF/);
    assert.ok(result.tokensAfter < 20000, "折叠后 token 应显著下降");
    const keptIds = toolIds(result.requestBody.messages);
    assert.deepEqual([...keptIds.uses].sort(), [...keptIds.results].sort(), "输出侧不得有半个 tool 对");
    assert.equal(calls.length, 1);
  });
});

test("门槛: 折叠收益低于 minFoldedTokens → 不做(零 fetch)", async () => {
  resetCacheIndex();
  await withMockFetch(() => openAiSummaryResponse("SHOULD NOT BE USED"), async (calls) => {
    const result = await applyHelixProactiveCompact({
      body: { messages: multiTurnMessages() },
      config: testConfig(),
      headers: { "x-session-id": "sess-min-folded" },
      model: "MiniMax-M3",
      postCompressionTokens: 999999,
      settings: settings({ minFoldedTokens: 100000 })
    });
    assert.equal(result, undefined);
    assert.equal(calls.length, 0);
  });
});

test("门槛: minFoldedTokens 达标时正常折叠", async () => {
  resetCacheIndex();
  await withMockFetch(() => openAiSummaryResponse("SMALL BUT ENOUGH"), async () => {
    const result = await applyHelixProactiveCompact({
      body: { messages: multiTurnMessages() },
      config: testConfig(),
      headers: { "x-session-id": "sess-min-folded-ok" },
      model: "MiniMax-M3",
      postCompressionTokens: 999999,
      settings: settings({ minFoldedTokens: 1 })
    });
    assert.ok(result);
    assert.match(result.requestBody.system, /SMALL BUT ENOUGH/);
  });
});

test("planCompactFold: kept 侧绝不出现孤儿 tool_result / 半截交换对", () => {
  const openAiCall = (id) => ({ function: { arguments: "{}", name: "Bash" }, id, type: "function" });
  const messages = [
    { content: "task", role: "user" },
    { content: "", role: "assistant", tool_calls: [openAiCall("a")] },
    { content: "y".repeat(6000), role: "tool", tool_call_id: "a" },
    { content: "next", role: "user" },
    // 数据形状异常:assistant 声明 b、c,只有一个结果
    { content: "", role: "assistant", tool_calls: [openAiCall("b"), openAiCall("c")] },
    { content: "y".repeat(6000), role: "tool", tool_call_id: "b" },
    { content: "", role: "assistant", tool_calls: [openAiCall("d")] },
    { content: "y".repeat(6000), role: "tool", tool_call_id: "d" }
  ];
  const plan = planCompactFold(messages, 2, 100, true);
  assert.ok(plan);

  // 真正的安全不变量:kept 侧每个 tool_call 都有结果、每个结果都有对应调用。
  const uses = new Set();
  const results = new Set();
  for (const message of plan.kept) {
    for (const call of message.tool_calls ?? []) uses.add(call.id);
    if (message.role === "tool" && message.tool_call_id) results.add(message.tool_call_id);
  }
  assert.deepEqual([...uses].sort(), [...results].sort(), "kept 侧必须成对");
  assert.equal(plan.kept[0].role, "user", "保留区第一条必须是 user 轮起点");
});

// ============= 2026-11-08 缓存稳定:摘要复用必须让 body 保持纯前缀扩展 =============

/** 长会话:固定内容,便于比较两轮 body 的前缀。 */
function cacheStableBody(extraPairs = 0) {
  const messages = [
    { content: "task: wire i18n", role: "user" },
    ...Array.from({ length: 4 }, (_, i) => anthropicToolPair(`s${i}`, 5000)).flat()
  ];
  if (extraPairs > 0) {
    messages.push({ content: "next turn", role: "user" });
    messages.push(...Array.from({ length: extraPairs }, (_, i) => anthropicToolPair(`x${i}`, 5000)).flat());
  }
  return messages;
}

function compactWith(messages, session, settingsOverrides = {}) {
  return applyHelixProactiveCompact({
    body: { messages, system: "client system" },
    config: testConfig(),
    headers: { "x-claude-code-session-id": session },
    model: "MiniMax-M3",
    postCompressionTokens: 100000,
    settings: settings({
      aggressiveFolding: true,
      minFoldedTokens: 0,
      minNewMessages: 100,
      tokenBudget: 2500,
      ...settingsOverrides
    })
  });
}

test("缓存稳定: 第二轮复用摘要,body 是首轮的纯前缀扩展(不打断上游缓存)", async () => {
  resetCacheIndex();
  const first = cacheStableBody(0);
  const second = [...JSON.parse(JSON.stringify(first))];
  second.push(...cacheStableBody(1).slice(first.length));
  // 第二轮只追加了 1 个新用户轮 + 1 个 tool 对,新增待折内容远小于 minNewMessages

  await withMockFetch(() => openAiSummaryResponse("STABLE HANDOFF"), async (calls) => {
    const a = await compactWith(JSON.parse(JSON.stringify(first)), "sess-cache-stable");
    assert.ok(a, "首轮应折叠并生成摘要");
    assert.equal(calls.length, 1);
    assert.equal(a.source, "model");

    const b = await compactWith(second, "sess-cache-stable");
    assert.ok(b, "第二轮应复用摘要并折叠");
    assert.equal(calls.length, 1, "第二轮不得再发起摘要调用");
    assert.equal(b.source, "cache");
    assert.equal(b.requestBody.system, a.requestBody.system, "摘要文本必须逐字节不变");

    const prefixLen = a.requestBody.messages.length;
    assert.ok(b.requestBody.messages.length > prefixLen, "第二轮应在首轮 body 后追加消息");
    assert.deepEqual(
      b.requestBody.messages.slice(0, prefixLen),
      a.requestBody.messages,
      "第二轮 messages 必须以首轮 messages 为逐字节前缀(上游 prompt 缓存可整段复用)"
    );
  });
});

test("缓存稳定: 新增待折内容达到 minNewMessages 后才允许重生成摘要", async () => {
  resetCacheIndex();
  const first = cacheStableBody(0);
  const second = cacheStableBody(1);

  await withMockFetch(() => openAiSummaryResponse("REGENERATED HANDOFF"), async (calls) => {
    await compactWith(JSON.parse(JSON.stringify(first)), "sess-cache-regen", { minNewMessages: 100 });
    assert.equal(calls.length, 1);
    // minNewMessages=1 → 本轮新增折叠内容超过阈值,允许重摘(仍可能命中同一缓存 key)
    const b = await compactWith(second, "sess-cache-regen", { minNewMessages: 1 });
    assert.ok(b);
    assert.ok(calls.length <= 2, "允许重生成,但不得无限调用");
  });
});

test("缓存稳定: 复用会让 body 超过 2× 预算时宁可重生成", async () => {
  resetCacheIndex();
  const first = cacheStableBody(0);
  const grown = JSON.parse(JSON.stringify(first));
  grown.push({ content: "huge turn", role: "user" });
  grown.push({ role: "assistant", content: [{ type: "tool_use", id: "huge", name: "Bash", input: {} }] });
  grown.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "huge", content: "z".repeat(40000) }] });

  await withMockFetch(() => openAiSummaryResponse("BOUNDED HANDOFF"), async (calls) => {
    const a = await compactWith(JSON.parse(JSON.stringify(first)), "sess-cache-bound", { tokenBudget: 2500 });
    assert.ok(a);
    assert.equal(calls.length, 1);
    const b = await compactWith(grown, "sess-cache-bound", { tokenBudget: 2500 });
    assert.ok(b, "仍应输出折叠后的 body");
    assert.equal(calls.length, 2, "复用会超过 2× 预算 → 必须重生成摘要");
  });
});

test("buildSummaryPrompt: transcript 超限时保留尾部(最近折叠内容)", () => {
  const delta = [];
  for (let i = 0; i < 12; i += 1) {
    delta.push({ content: `MSG_${i}_` + "x".repeat(30000), role: i % 2 === 0 ? "user" : "assistant" });
  }
  const prompt = buildSummaryPrompt(undefined, delta);
  assert.match(prompt, /older messages omitted/, "应有截断标记");
  assert.ok(prompt.includes("MSG_11_"), "最新消息必须保留");
  assert.ok(!prompt.includes("MSG_0_"), "最旧消息应被省略");
  assert.ok(prompt.length < 204000, `prompt 总长必须受控,实际 ${prompt.length}`);
});

test("默认 minNewMessages = 200(降低重摘频率,减少摘要改写导致的整段前缀失效)", () => {
  // 背景:每次重摘都会改写 system 尾部摘要 → 全 prompt 前缀缓存失效(实测 pro 单次 ~$0.018)。
  //   复用条件下 threshold 与断点频率成反比,故默认从 100 提到 200;显式配置仍优先。
  const defaults = readProactiveCompactSettingsFromConfig({});
  assert.equal(defaults.minNewMessages, 200);
  const explicit = readProactiveCompactSettingsFromConfig({ proactiveCompactMinNewMessages: 100 });
  assert.equal(explicit.minNewMessages, 100);
});
