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
  foldBoundary,
  mergeSystemSummary,
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
    cacheTtlMs: 3 * 24 * 60 * 60 * 1000,
    ceilingTokens: 120000,
    floorTokens: 48000,
    keepRecentTurns: 2,
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
      settings: settings({ minNewMessages: 100 })
    });
    assert.ok(acc);
    assert.equal(acc.source, "accumulate");
    assert.match(acc.diagnostic, /source=accumulate/);
    assert.match(acc.diagnostic, /pending=2/);
    assert.equal(calls.length, 0, "未达阈值不得再调上游");
    // 复用旧摘要(matchedCount=6 之前) + 中间段 [6..boundary) 留原文
    assert.match(acc.requestBody.system, /FIRST HANDOFF/);
    assert.equal(acc.requestBody.messages.length, grown.length - 6, "kept 从旧覆盖点(6)切起");
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
