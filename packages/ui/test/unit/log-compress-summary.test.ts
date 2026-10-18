import assert from "node:assert/strict";
import test from "node:test";
import type { RequestLogEntry } from "@ccr/core/contracts/app";
import { compactSourceLabel, formatLogCompressSummary, logProactiveCompact, logRecallCallLeaked } from "@ccr/ui/pages/home/shared/logs.ts";

const t = (v: string) => v;

function entry(overrides: Partial<RequestLogEntry>): RequestLogEntry {
  return {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    client: "claude-code",
    createdAt: "2026-10-15T03:00:00.000Z",
    credentialChain: [],
    credentialSaturated: false,
    durationMs: 1200,
    id: 1,
    inputTokens: 0,
    isStream: false,
    method: "POST",
    model: "MiniMax-M2.7",
    ok: true,
    outputTokens: 0,
    path: "/v1/messages",
    provider: "anthropic",
    requestHeaders: {},
    responseHeaders: {
      "x-helix-compressor-enabled": "1",
      "x-helix-compressor-baseline-tokens": "3461",
      "x-helix-compressor-compressed-tokens": "274"
    },
    retryAttempts: [],
    statusCode: 200,
    totalTokens: 0,
    url: "https://api.minimaxi.com/anthropic/v1/messages",
    ...overrides
  } as RequestLogEntry;
}

test("压缩列只显示「净端到端节省」百分比 = (baseline - post - 召回) / baseline(messages 同域)", () => {
  // 真实请求 id 3581 的形状:baseline 3461 → 压缩后 274 → 上游实收 1129(input 0 + cache 1129)
  const { text, title } = formatLogCompressSummary(
    entry({ inputTokens: 0, cacheReadTokens: 1129 }),
    t
  );
  // messages 口径净节省 = (3461 - 274 - 0) / 3461 = 92.1%
  //   ⚠️ 不再拿 (input+cache_read)=1129(含 system/tools)当被减项。
  assert.equal(text, "-92.1%");
  // 纯压缩比 / 净额 不再进 cell,只在 title
  assert.doesNotMatch(text, /净额/);
  assert.doesNotMatch(text, /tok/);
  // title 里保留完整分解
  assert.match(title, /净端到端节省/);
  assert.match(title, /净额/);
  assert.match(title, /cache_read/);
  // 2026-10-16: 无 compressionRecallTokens → 上游实收−post 全部是 system/tools 上下文开销,
  //   不得误标成「召回回填 **+N**」(正的召回回填)。
  // 2026-10-17: 但仍**显式**画「召回回填 0 tok(...)」,免得每次都要猜"是没召回还是没渲染"。
  assert.doesNotMatch(title, /召回回填 \+/);
  assert.match(title, /召回回填 0 tok（本轮模型未调用）/);
  assert.match(title, /上下文开销\(system\/tools\) \+855/);
});

test("召回回填只认 compressionRecallTokens 真值,不把 system/tools 误标为召回", () => {
  // 真实流量形状(参考 id 4039):baseline 99835 → post 48806 → 上游实收 74765。
  // 网关 recall loop 回填原文 = 24000 tok(input 309 + cache 74456,其中 24000 是召回)。
  const { text, title } = formatLogCompressSummary(
    entry({
      inputTokens: 309,
      cacheReadTokens: 74456,
      compressionRecallTokens: 24000,
      responseHeaders: {
        "x-helix-compressor-enabled": "1",
        "x-helix-compressor-baseline-tokens": "99835",
        "x-helix-compressor-compressed-tokens": "48806"
      }
    }),
    t
  );
  // messages 口径净节省 = (99835 − 48806 − 24000) / 99835 = 27.1%
  assert.equal(text, "-27.1%");
  assert.match(title, /召回回填 \+24,000/);
  // 上下文开销 = 74765 − 48806 − 24000 = 1959
  assert.match(title, /上下文开销\(system\/tools\) \+1,959/);
});

test("system/tools 开销不再稀释节省率(跨域比较修复)", () => {
  // max/OpenAI 类请求:system+tools 巨大(30k),messages 压缩良好(baseline 4000 → post 500)。
  //   旧公式 (4000 − 30500)/4000 < 0 → 误报"无净节省"。
  //   新公式 (4000 − 500)/4000 = 87.5%。
  const { text } = formatLogCompressSummary(
    entry({
      inputTokens: 500,
      cacheReadTokens: 30000,
      responseHeaders: {
        "x-helix-compressor-enabled": "1",
        "x-helix-compressor-baseline-tokens": "4000",
        "x-helix-compressor-compressed-tokens": "500"
      }
    }),
    t
  );
  assert.equal(text, "-87.5%");
});

test("压缩了但召回把原文全捞回(messages 口径无净节省)显示「无净节省」", () => {
  const { text } = formatLogCompressSummary(
    entry({
      inputTokens: 3000,
      compressionRecallTokens: 2800,
      responseHeaders: {
        "x-helix-compressor-enabled": "1",
        "x-helix-compressor-baseline-tokens": "2800",
        "x-helix-compressor-compressed-tokens": "274"
      }
    }),
    t
  );
  // messagesAfterRecall = 274 + 2800 = 3074 ≥ baseline 2800 → 无净节省
  assert.equal(text, "无净节省");
});

test("QA 占位数不再进 cell(只显示净端到端 %),移入 title", () => {
  const { text, title } = formatLogCompressSummary(
    entry({
      inputTokens: 0,
      cacheReadTokens: 1129,
      responseHeaders: {
        "x-helix-compressor-enabled": "1",
        "x-helix-compressor-baseline-tokens": "3461",
        "x-helix-compressor-compressed-tokens": "274",
        "x-helix-compressor-qa-compressed": "14"
      }
    }),
    t
  );
  assert.equal(text, "-92.1%");
  assert.doesNotMatch(text, /QA/);
  assert.match(title, /Q&A 对占位 14/);
});

test("helix 跑了但无可压缩内容(post == baseline)显示「未压缩」", () => {
  const { text } = formatLogCompressSummary(
    entry({
      inputTokens: 75,
      cacheReadTokens: 1722,
      responseHeaders: {
        "x-helix-compressor-enabled": "1",
        "x-helix-compressor-baseline-tokens": "1123",
        "x-helix-compressor-compressed-tokens": "1123"
      }
    }),
    t
  );
  assert.equal(text, "未压缩");
});

test("未触发 helix 返回 -", () => {
  const { text } = formatLogCompressSummary(entry({ responseHeaders: {} }), t);
  assert.equal(text, "-");
});

test("主动 compact: entry 字段存在时 title 带 compact 明细", () => {
  const { title } = formatLogCompressSummary(
    entry({
      compressionProactiveCompact: {
        coveredCount: 8,
        foldedCount: 6,
        preCompactTokens: 120000,
        source: "model",
        summaryTokens: 900,
        tokensAfter: 12000
      },
      inputTokens: 1129,
      cacheReadTokens: 0
    }),
    t
  );
  assert.match(title, /主动 compact\(模型摘要\)/);
  assert.match(title, /折叠 6 条/);
  assert.match(title, /120,000→12,000 tok/);
});

// ============== 2026-10-17: 召回回填 == 0 的显式渲染 ==============

test("压缩过但召回回填 0 → title 显式画「召回回填 0 tok（本轮模型未调用）」", () => {
  const { title } = formatLogCompressSummary(
    entry({
      inputTokens: 300,
      cacheReadTokens: 1000,
      responseHeaders: {
        "x-helix-compressor-enabled": "1",
        "x-helix-compressor-baseline-tokens": "5000",
        "x-helix-compressor-compressed-tokens": "1200"
      }
    }),
    t
  );
  assert.match(title, /召回回填 0 tok（本轮模型未调用）/);
});

test("压缩过、召回回填 0、响应含 recall 调用 → 提示「已调用但未执行」", () => {
  const { title } = formatLogCompressSummary(
    entry({
      inputTokens: 300,
      cacheReadTokens: 1000,
      responseBody: {
        encoding: "utf8",
        sizeBytes: 200,
        text: '{"content":[{"type":"tool_use","name":"history_recall","id":"x"}]}',
        truncated: false
      },
      responseHeaders: {
        "x-helix-compressor-enabled": "1",
        "x-helix-compressor-baseline-tokens": "5000",
        "x-helix-compressor-compressed-tokens": "1200"
      }
    }),
    t
  );
  assert.match(title, /召回回填 0 tok（模型已调用 recall 但未执行）/);
});

test("未压缩(pass-through)时不画召回回填 0(没有占位符,谈不上召回)", () => {
  const { title } = formatLogCompressSummary(
    entry({
      inputTokens: 75,
      responseHeaders: {
        "x-helix-compressor-enabled": "1",
        "x-helix-compressor-baseline-tokens": "1123",
        "x-helix-compressor-compressed-tokens": "1123"
      }
    }),
    t
  );
  assert.doesNotMatch(title, /召回回填/);
});

test("logRecallCallLeaked: 检测响应体里残留的 history_recall / hc_recall 调用", () => {
  assert.equal(logRecallCallLeaked(entry({
    responseBody: { encoding: "utf8", sizeBytes: 10, text: '"name":"history_recall"', truncated: false }
  })), true);
  assert.equal(logRecallCallLeaked(entry({
    responseBody: { encoding: "utf8", sizeBytes: 10, text: '"name":"hc_recall"', truncated: false }
  })), true);
  assert.equal(logRecallCallLeaked(entry({
    responseBody: { encoding: "utf8", sizeBytes: 10, text: '"name":"Bash"', truncated: false }
  })), false);
  assert.equal(logRecallCallLeaked(entry({})), false);
});

test("主动 compact: 无 entry 字段时 fallback 到 x-ccr-helix-compact-json 响应头", () => {
  const compact = logProactiveCompact(
    entry({
      responseHeaders: {
        "x-ccr-helix-compact-json": JSON.stringify({
          coveredCount: 4, foldedCount: 3, preCompactTokens: 5000, source: "cache", tokensAfter: 800
        }),
        "x-helix-compressor-enabled": "1"
      }
    })
  );
  assert.ok(compact);
  assert.equal(compact.source, "cache");
  assert.equal(compact.tokensAfter, 800);
  assert.equal(compact.summaryTokens, undefined);
});

test("主动 compact: 非法 header JSON → undefined(不抛错)", () => {
  assert.equal(logProactiveCompact(entry({ responseHeaders: { "x-ccr-helix-compact-json": "{bad" } })), undefined);
  assert.equal(logProactiveCompact(entry({ responseHeaders: { "x-ccr-helix-compact-json": "{}" } })), undefined);
});

test("compactSourceLabel: 已知来源中文化", () => {
  assert.equal(compactSourceLabel("cache"), "缓存命中");
  assert.equal(compactSourceLabel("incremental"), "增量合并");
  assert.equal(compactSourceLabel("model"), "模型摘要");
  assert.equal(compactSourceLabel("other"), "other");
});
