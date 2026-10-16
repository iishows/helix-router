/**
 * Helix 主动 compact 集成测试(2026-10-15)
 *
 * 起真实 createGatewayPlugin + mock 上游 provider,验证:
 *   (a) 压缩后超预算的 anthropic 请求 → 触发恰好 1 次摘要上游调用;
 *   (b) 转发 body 的 messages 只剩最近 2 轮,且 system 含摘要;
 *   (c) 同会话相邻第二次请求只发生 1 次摘要调用(缓存命中);
 *   (d) 保留区 tool 对完整。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { helixCompressorRequestTransformKey } from "@ccr/core/plugins/built-ins/helix-compressor.ts";
import { createGatewayPlugin } from "@ccr/core/gateway/core-runtime/router-plugin.ts";
import { _resetIndexForTest } from "@ccr/core/observability/helix-compact-summary-store.ts";

let cacheDir;

before(() => {
  cacheDir = mkdtempSync(path.join(os.tmpdir(), "helix-compact-integration-"));
  process.env.HELIX_RECALL_CACHE_DIR = cacheDir;
});

after(() => {
  rmSync(cacheDir, { force: true, recursive: true });
  delete process.env.HELIX_RECALL_CACHE_DIR;
});

/** 造一个超预算的 anthropic messages 请求(足够多轮 + 大 tool_result)。 */
function oversizedAnthropicBody(extraTurns = 0) {
  const big = "X".repeat(4000);
  const messages = [];
  for (let i = 1; i <= 3; i += 1) {
    messages.push({ content: `question ${i}`, role: "user" });
    messages.push({
      content: [{ id: `tu_${i}`, input: { path: `/f${i}` }, name: "Read", type: "tool_use" }],
      role: "assistant"
    });
    messages.push({
      content: [{ content: `${big} file body ${i}`, tool_use_id: `tu_${i}`, type: "tool_result" }],
      role: "user"
    });
    messages.push({ content: [{ text: `answer ${i}`, type: "text" }], role: "assistant" });
  }
  for (let i = 0; i < extraTurns; i += 1) {
    messages.push({ content: `extra question ${i}`, role: "user" });
    messages.push({ content: [{ text: `extra answer ${i}`, type: "text" }], role: "assistant" });
  }
  messages.push({ content: "final question", role: "user" });
  return {
    messages,
    model: "MiniMax-M3",
    system: "You are Claude Code."
  };
}

function buildConfig() {
  const config = createDefaultAppConfig();
  config.Providers = [
    {
      api_base_url: "http://127.0.0.1:9999/v1",
      api_key: "test-key",
      models: ["MiniMax-M3"],
      name: "MiniMax",
      type: "openai_chat_completions"
    }
  ];
  config.plugins = [{
    config: {
      // 保留本地压缩但预算调低,确保压缩后仍超预算。
      keepRecentTurns: 2,
      proactiveCompactTimeoutMs: 5000,
      tokenBudget: 200
    },
    enabled: true,
    id: "helix-compressor"
  }];
  return config;
}

async function runTransform(plugin, body, sessionId) {
  const transform = plugin.requestTransforms.find(
    (item) => item.key === helixCompressorRequestTransformKey
  );
  assert.ok(transform, "helix transform must be registered");
  return transform.transform({
    model: "MiniMax-M3",
    request: {
      headers: { "content-type": "application/json", "x-session-id": sessionId },
      id: `req-${sessionId}-${Math.random()}`,
      method: "POST",
      url: "/v1/messages"
    },
    requestBody: body,
    route: { method: "POST", url: "/v1/messages" }
  });
}

function withMockFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ body, url });
    return handler({ body, url });
  };
  return Promise.resolve()
    .then(() => run(calls))
    .finally(() => {
      globalThis.fetch = original;
    });
}

function summaryResponse(text) {
  return new Response(JSON.stringify({ choices: [{ message: { content: text, role: "assistant" } }] }), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

test("集成: 超预算请求触发一次摘要调用,messages 只剩最近 2 轮 + system 含摘要", async () => {
  _resetIndexForTest();
  const plugin = await createGatewayPlugin({ plugin: { config: { appConfig: buildConfig() } } });
  const body = oversizedAnthropicBody();

  await withMockFetch(
    ({ url }) => (url.includes(":9999") ? summaryResponse("INTEGRATION HANDOFF") : summaryResponse("x")),
    async (calls) => {
      const result = await runTransform(plugin, body, "integ-session-1");
      assert.ok(result, "transform must return a result");

      // (a) 恰好 1 次摘要上游调用
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /:9999/);

      // 压缩诊断头存在,source=model
      const diagnostic = result.responseHeaders?.["x-ccr-helix-proactive-compact"];
      assert.ok(diagnostic, "x-ccr-helix-proactive-compact must be present");
      assert.match(diagnostic, /source=model/);

      // 结构化 compact 明细头(供 worker/UI 跨进程读取)
      const compactJson = result.responseHeaders?.["x-ccr-helix-compact-json"];
      assert.ok(compactJson, "x-ccr-helix-compact-json must be present");
      const parsed = JSON.parse(compactJson);
      assert.equal(parsed.source, "model");
      assert.ok(parsed.foldedCount > 0);
      assert.ok(parsed.tokensAfter > 0);
      assert.ok(parsed.preCompactTokens > 0);
      assert.ok(parsed.summaryTokens > 0);

      // 修正后的 compressed-tokens 头应等于 compact 后的提交量(tokensAfter)
      assert.equal(
        Number(result.responseHeaders?.["x-helix-compressor-compressed-tokens"]),
        parsed.tokensAfter,
        "x-helix-compressor-compressed-tokens 必须被修正为 compact 后提交量"
      );

      // 关键:compact 明细必须同时落 request headers —— 生产 DB 的
      //   request_logs_compression_extract trigger 只读 request_headers,
      //   是 compression_* 列(含 compact)真正的跨进程通道。
      //   且必须用 `x-helix-compressor-compact-json` 这个名字:落进 request_headers 列的
      //   header 会经过 sanitizeUpstreamProviderHeaders,所有 `x-ccr-*` 会被剥掉。
      const reqHeaders = result.headers;
      assert.ok(reqHeaders, "transform 必须返回 headers");
      assert.ok(reqHeaders["x-ccr-helix-compact-json"], "compact 明细必须落 request headers");
      assert.ok(
        reqHeaders["x-helix-compressor-compact-json"],
        "compact 明细必须以 x-helix-compressor-* 别名落 request headers(sanitize 后存活)"
      );
      assert.deepEqual(
        JSON.parse(reqHeaders["x-helix-compressor-compact-json"]),
        JSON.parse(reqHeaders["x-ccr-helix-compact-json"]),
        "两个 key 的 compact 明细必须一致"
      );
      assert.equal(JSON.parse(reqHeaders["x-ccr-helix-compact-json"]).source, "model");
      assert.equal(
        Number(reqHeaders["x-helix-compressor-compressed-tokens"]),
        parsed.tokensAfter,
        "request headers 里的 compressed-tokens 也要被修正"
      );
      assert.equal(
        Number(reqHeaders["x-helix-compressor-submitted-tokens"]),
        parsed.tokensAfter,
        "request headers 里的 submitted-tokens 也要被修正"
      );

      // (b) messages 只剩最近 2 个新用户轮(含当前轮)
      const out = result.requestBody;
      const starts = out.messages.filter((m) =>
        m.role === "user" && (typeof m.content === "string" || !JSON.stringify(m.content).includes("tool_result"))
      );
      assert.equal(starts.length, 2, "保留最近 2 个新用户轮");
      assert.equal(out.messages.at(-1).content, "final question");

      // (d) 保留区 tool 对完整:kept 内 tool_use 与 tool_result 成对
      const keptText = JSON.stringify(out.messages);
      const toolUseIds = [...keptText.matchAll(/"id":"(tu_\d+)"/g)].map((m) => m[1]);
      const toolResultIds = [...keptText.matchAll(/"tool_use_id":"(tu_\d+)"/g)].map((m) => m[1]);
      assert.deepEqual(toolUseIds.sort(), toolResultIds.sort(), "每个 tool_use 都应有配对 tool_result");

      // system 注入摘要
      const systemText = typeof out.system === "string" ? out.system : JSON.stringify(out.system);
      assert.match(systemText, /\[CCR compacted summary\]/);
      assert.match(systemText, /INTEGRATION HANDOFF/);
      assert.match(systemText, /You are Claude Code\./);
    }
  );
});

test("集成: 同会话相邻第二次请求命中缓存(仅 1 次摘要调用)", async () => {
  _resetIndexForTest();
  const plugin = await createGatewayPlugin({ plugin: { config: { appConfig: buildConfig() } } });
  const body = oversizedAnthropicBody();

  await withMockFetch(() => summaryResponse("FIRST HANDOFF"), async (first) => {
    const a = await runTransform(plugin, body, "integ-session-2");
    assert.match(a.responseHeaders?.["x-ccr-helix-proactive-compact"], /source=model/);
    assert.equal(JSON.parse(a.responseHeaders["x-ccr-helix-compact-json"]).source, "model");
    assert.equal(first.length, 1);
  });

  // 用相同 body 再发(前缀未变)→ 缓存命中,零额外 fetch
  _resetIndexForTest();
  await withMockFetch(() => summaryResponse("SHOULD NOT RUN"), async (second) => {
    const b = await runTransform(plugin, body, "integ-session-2");
    assert.match(b.responseHeaders?.["x-ccr-helix-proactive-compact"], /source=cache/);
    assert.equal(JSON.parse(b.responseHeaders["x-ccr-helix-compact-json"]).source, "cache");
    assert.equal(JSON.parse(b.headers["x-ccr-helix-compact-json"]).source, "cache", "request headers 也要带 compact 明细");
    assert.equal(second.length, 0);
  });
});

test("集成: 摘要调用失败时静默降级(无 compact 头,原 body 照常返回)", async () => {
  _resetIndexForTest();
  const plugin = await createGatewayPlugin({ plugin: { config: { appConfig: buildConfig() } } });
  const body = oversizedAnthropicBody();

  await withMockFetch(() => {
    throw new Error("upstream down");
  }, async () => {
    const result = await runTransform(plugin, body, "integ-session-3");
    assert.ok(result, "transform must still return the compressed body");
    assert.equal(result.responseHeaders?.["x-ccr-helix-proactive-compact"], undefined);
    // 原(压缩后)body 里仍有更多轮次
    assert.ok(result.requestBody.messages.length > 3);
  });
});
