/**
 * helix 按模型门控 recall 压缩 — router-plugin 层集成测试（2026-10-16）
 *
 * 起真实 `createGatewayPlugin`(与生产单网关模式同一层),驱动 helix-compressor 的
 * request transform,验证 `recallModelPatterns` 白名单在**真实网关管线**里的端到端效果:
 *   (a) 未命中的模型 → 输出 body 无 ⟦QA:⟧、transform 不返回 model(不改写);
 *   (b) 命中/空白名单的模型 → 输出 body 有 ⟦QA:⟧ 且 model 被改写为 ccr-helix-recall/…;
 *   (c) 未命中的模型仍走主动 compact(超预算时 compact 头出现)—— 证明「只做 compact」。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { helixCompressorRequestTransformKey } from "@ccr/core/plugins/built-ins/helix-compressor.ts";
import { createGatewayPlugin } from "@ccr/core/gateway/core-runtime/router-plugin.ts";
import { HELIX_RECALL_MODEL_PREFIX } from "@ccr/core/contracts/app.ts";

let cacheDir;

before(() => {
  cacheDir = mkdtempSync(path.join(os.tmpdir(), "helix-recall-model-gate-integ-"));
  process.env.HELIX_RECALL_CACHE_DIR = cacheDir;
});

after(() => {
  rmSync(cacheDir, { force: true, recursive: true });
  delete process.env.HELIX_RECALL_CACHE_DIR;
});

/** 一段足够长、会被本地压缩成 ⟦QA:hash⟧ 的历史(每条 ≥500 字符,合并 ≥1000)。 */
function longHistoryBody(model) {
  return {
    messages: [
      { content: "A".repeat(600), role: "user" },
      { content: "B".repeat(600), role: "assistant" },
      { content: "final question", role: "user" }
    ],
    model,
    system: "You are Claude Code."
  };
}

function buildConfig(pluginConfig) {
  const config = createDefaultAppConfig();
  config.Providers = [
    { api_base_url: "http://127.0.0.1:9999/v1", api_key: "k", models: ["MiniMax-M3"], name: "MiniMax", type: "openai_chat_completions" }
  ];
  config.plugins = [{ config: pluginConfig, enabled: true, id: "helix-compressor" }];
  return config;
}

async function runTransform(plugin, body, sessionId) {
  const transform = plugin.requestTransforms.find((t) => t.key === helixCompressorRequestTransformKey);
  assert.ok(transform, "helix transform must be registered");
  return transform.transform({
    model: body.model,
    request: {
      headers: { "content-type": "application/json", "x-claude-code-session-id": sessionId },
      id: `req-${sessionId}`,
      method: "POST",
      url: "/v1/messages"
    },
    requestBody: body,
    route: { method: "POST", url: "/v1/messages" }
  });
}

function hasPlaceholder(body) {
  return JSON.stringify(body.messages ?? []).includes("⟦QA:");
}

test("集成: 未命中白名单的模型 → 无 ⟦QA:⟧、transform 不改写 model", async () => {
  const plugin = await createGatewayPlugin({
    plugin: { config: { appConfig: buildConfig({ recallModelPatterns: ["claude-*"] }) } }
  });
  const body = longHistoryBody("MiniMax-M3");
  const result = await runTransform(plugin, body, "gate-integ-skip");

  assert.ok(result, "transform must return a result");
  assert.equal(result.model, undefined, "未命中白名单的模型不得改写 model");
  assert.equal(hasPlaceholder(result.requestBody), false, "不得产生 ⟦QA:⟧ 占位符");
  assert.equal(result.headers["x-helix-compressor-scenario"], "skip-recall");
});

test("集成: 命中白名单的模型 → 有 ⟦QA:⟧ 且 model 改写为 ccr-helix-recall/…", async () => {
  const plugin = await createGatewayPlugin({
    plugin: { config: { appConfig: buildConfig({ keepRecentPairs: 0, recallModelPatterns: ["MiniMax-*"] }) } }
  });
  const body = longHistoryBody("MiniMax-M3");
  const result = await runTransform(plugin, body, "gate-integ-hit");

  assert.ok(result);
  assert.equal(result.model, `${HELIX_RECALL_MODEL_PREFIX}MiniMax-M3`);
  assert.equal(hasPlaceholder(result.requestBody), true, "命中白名单应产生 ⟦QA:⟧ 占位符");
});

test("集成: 未命中白名单的模型仍走主动 compact(超预算时 compact 头出现)", async () => {
  // 关掉 recall 压缩(白名单不含该模型),但 tokenBudget 调低 → 压缩后仍超预算 → 触发 compact。
  const plugin = await createGatewayPlugin({
    plugin: {
      config: {
        appConfig: buildConfig({
          keepRecentTurns: 2,
          proactiveCompactTimeoutMs: 3000,
          recallModelPatterns: ["claude-*"],
          tokenBudget: 100
        })
      }
    }
  });
  // 多轮 + 大量文本,确保远超 tokenBudget。
  const messages = [];
  for (let i = 0; i < 8; i += 1) {
    messages.push({ content: `question ${i} ${"x".repeat(300)}`, role: "user" });
    messages.push({ content: [{ text: `answer ${i} ${"y".repeat(300)}`, type: "text" }], role: "assistant" });
  }
  messages.push({ content: "final question", role: "user" });

  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ choices: [{ message: { content: "HANDOFF", role: "assistant" } }] }), {
      headers: { "content-type": "application/json" },
      status: 200
    });
  };
  try {
    const result = await runTransform(plugin, { messages, model: "MiniMax-M3", system: "sys" }, "gate-integ-compact");
    assert.ok(result);
    assert.equal(hasPlaceholder(result.requestBody), false, "未命中白名单:仍无 ⟦QA:⟧");
    assert.ok(
      result.responseHeaders?.["x-ccr-helix-proactive-compact"],
      "未命中白名单的模型仍应触发主动 compact"
    );
    assert.ok(calls.length >= 1, "compact 摘要调用应打到上游");
  } finally {
    globalThis.fetch = original;
  }
});
