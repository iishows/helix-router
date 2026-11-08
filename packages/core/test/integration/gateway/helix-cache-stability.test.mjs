/**
 * 缓存稳定性集成测试(2026-11-08)
 *
 * 走**生产路径** createGatewayPlugin → helix compressor transform,验证:
 *   (a) 压缩器选择是单调的:会话追加新的大工具输出后,旧占位符绝不还原;
 *   (b) 占位符清单不足 40 条时不注入(头部 system 文本保持逐字节稳定);
 *   (c) compact 摘要复用:第二轮 body 是首轮 body 的纯前缀扩展,摘要逐字节相同、零额外调用。
 *
 * 背景:上游 prompt 缓存是纯前缀匹配、缓存价 = 输入价 2%;任何已发送字节变化都会让
 * 其后全部按输入价重算(实测单会话多花约 $1.9)。
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
  cacheDir = mkdtempSync(path.join(os.tmpdir(), "helix-cache-stability-"));
  process.env.HELIX_RECALL_CACHE_DIR = cacheDir;
});

after(() => {
  rmSync(cacheDir, { force: true, recursive: true });
  delete process.env.HELIX_RECALL_CACHE_DIR;
});

function baseConfig(pluginConfig) {
  const config = createDefaultAppConfig();
  config.Providers = [{
    api_base_url: "http://127.0.0.1:9999/v1",
    api_key: "test-key",
    models: ["MiniMax-M3"],
    name: "MiniMax",
    type: "openai_chat_completions"
  }];
  config.plugins = [{ config: pluginConfig, enabled: true, id: "helix-compressor" }];
  return config;
}

async function buildPlugin(pluginConfig) {
  return createGatewayPlugin({ plugin: { config: { appConfig: baseConfig(pluginConfig) } } });
}

async function runTransform(plugin, body, sessionId) {
  const transform = plugin.requestTransforms.find((item) => item.key === helixCompressorRequestTransformKey);
  assert.ok(transform, "helix transform must be registered");
  return transform.transform({
    model: "MiniMax-M3",
    request: {
      headers: { "content-type": "application/json", "x-session-id": sessionId },
      id: `req-${sessionId}`,
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
  return Promise.resolve().then(() => run(calls)).finally(() => {
    globalThis.fetch = original;
  });
}

function summaryResponse(text) {
  return new Response(JSON.stringify({ choices: [{ message: { content: text, role: "assistant" } }] }), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

/** Anthropic 形状的 tool 交换对,内容可控大小。 */
function anthropicPair(id, bodyChars) {
  return [
    { content: [{ type: "text", text: `read ${id}` }], role: "user" },
    { content: [{ id, input: {}, name: "Read", type: "tool_use" }], role: "assistant" },
    { content: [{ content: `${id} ` + "x".repeat(bodyChars), tool_use_id: id, type: "tool_result" }], role: "user" }
  ];
}

function placeholderIds(body) {
  const text = JSON.stringify(body.messages ?? []);
  return new Set([...text.matchAll(/⟦QA:([a-f0-9]{16})⟧/g)].map((m) => m[1]));
}

function toolResultPlaceholderIds(body) {
  const out = new Set();
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type !== "tool_result") continue;
      const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      const match = /⟦QA:([a-f0-9]{16})⟧/.exec(text);
      if (match) out.add(block.tool_use_id);
    }
  }
  return out;
}

function systemWithMarker(body, marker) {
  for (const message of body.messages ?? []) {
    if (message?.role === "system" && typeof message.content === "string" && message.content.includes(marker)) {
      return message.content;
    }
  }
  return undefined;
}

// ============= (a) 压缩选择单调 =============

test("生产路径: 追加更大的工具输出后,旧占位符绝不还原(缓存前缀稳定)", async () => {
  _resetIndexForTest();
  const plugin = await buildPlugin({
    compressToolResults: true,
    keepRecentToolResults: 0,
    maxCompressToolResults: 3,
    toolResultThresholdChars: 1000,
    tokenBudget: 0
  });
  const base = [
    { content: "task", role: "user" },
    ...anthropicPair("a", 1500).slice(1),
    ...anthropicPair("b", 1600).slice(1),
    ...anthropicPair("c", 1700).slice(1),
    ...anthropicPair("d", 1800).slice(1),
    ...anthropicPair("e", 1900).slice(1),
    { content: "continue", role: "user" }
  ];
  const first = await runTransform(plugin, { messages: structuredClone(base), model: "MiniMax-M3" }, "sess-monotonic");
  assert.ok(first, "transform must return");
  const firstIds = toolResultPlaceholderIds(first.requestBody);
  assert.equal(firstIds.size, 3, "cap=3 应压缩 3 条(位置序最旧的 3 条)");
  assert.deepEqual([...firstIds].sort(), ["a", "b", "c"]);

  // 追加一条比所有旧结果都大的工具输出;savings 排序会挤掉旧候选,位置序不会。
  const grown = structuredClone(base);
  grown.push(...anthropicPair("z", 40000));
  const second = await runTransform(plugin, { messages: grown, model: "MiniMax-M3" }, "sess-monotonic");
  const secondIds = toolResultPlaceholderIds(second.requestBody);
  for (const id of firstIds) {
    assert.ok(secondIds.has(id), `已压缩的 ${id} 不得被还原成原文(否则整段 prompt 缓存失效)`);
  }
  assert.ok(!secondIds.has("z"), "cap=3 时新的大输出不得挤掉旧候选");
});

// ============= (b) 清单不足 40 条不注入 =============

test("生产路径: 占位符 <40 条时头部教学 prompt 逐字节稳定", async () => {
  _resetIndexForTest();
  const plugin = await buildPlugin({
    blockThresholdChars: 1000,
    compressToolResults: true,
    keepRecentToolResults: 0,
    maxCompressToolResults: 100,
    toolResultThresholdChars: 1000,
    tokenBudget: 0
  });
  const marker = "<<HISTORY_RECALL_INSTRUCTION_v2>>";
  // 用**文本块**占位符触发教学 prompt(⟦QA⟧ 落在 block.text 上)。
  const longText = (id) => ({
    content: [{ text: `${id} ` + "x".repeat(1500), type: "text" }],
    role: "assistant"
  });
  // 末尾固定放一对 assistant/user,确保 longText 不在“最近 2 条 user/assistant”保护窗内。
  const one = [
    { content: "task", role: "user" },
    longText("t1"),
    { content: "ok", role: "assistant" },
    { content: "continue", role: "user" }
  ];
  const first = await runTransform(plugin, { messages: structuredClone(one), model: "MiniMax-M3" }, "sess-index");
  const firstSystem = systemWithMarker(first.requestBody, marker);
  assert.ok(firstSystem, "应有教学 prompt");

  const two = structuredClone(one);
  two.splice(two.length - 2, 0, longText("t2"));
  const second = await runTransform(plugin, { messages: two, model: "MiniMax-M3" }, "sess-index");
  const secondSystem = systemWithMarker(second.requestBody, marker);
  assert.equal(
    secondSystem,
    firstSystem,
    "新增占位符不得改写头部教学 prompt(否则 system 之后的所有消息缓存全部失效)"
  );
});

// ============= (c) compact 摘要复用 =============

function compactableBody(extraPairs = 0) {
  const messages = [
    { content: "task: wire i18n", role: "user" },
    ...Array.from({ length: 6 }, (_, i) => anthropicPair(`k${i}`, 4000).slice(1)).flat()
  ];
  if (extraPairs > 0) {
    messages.push({ content: "next turn", role: "user" });
    messages.push(...Array.from({ length: extraPairs }, (_, i) => anthropicPair(`n${i}`, 4000).slice(1)).flat());
  }
  return { messages, model: "MiniMax-M3", system: "You are Claude Code." };
}

test("生产路径: compact 第二轮复用摘要,body 纯前缀扩展、零额外摘要调用", async () => {
  _resetIndexForTest();
  const plugin = await buildPlugin({
    // 关闭 recall 压缩,让 compact 直接处理原始 body(隔离变量)。
    compressMedia: false,
    compressToolResults: false,
    blockThresholdChars: 0,
    recallModelPatterns: [],
    recallModelExcludePatterns: ["*"],
    aggressiveFolding: true,
    minFoldedTokens: 0,
    proactiveCompactMinNewMessages: 100,
    tokenBudget: 2500
  });
  const body1 = compactableBody(0);
  const body2 = compactableBody(1);

  await withMockFetch(() => summaryResponse("PROD STABLE HANDOFF"), async (calls) => {
    const first = await runTransform(plugin, body1, "sess-compact-stable");
    assert.ok(first, "首轮应输出 compact 后的 body");
    assert.equal(calls.length, 1, "首轮应调用一次摘要");
    assert.match(JSON.stringify(first.requestBody), /PROD STABLE HANDOFF/);

    const second = await runTransform(plugin, body2, "sess-compact-stable");
    assert.ok(second);
    assert.equal(calls.length, 1, "第二轮不得再调用摘要");
    assert.equal(
      JSON.stringify(second.requestBody.system),
      JSON.stringify(first.requestBody.system),
      "摘要文本必须逐字节相同"
    );
    const firstMessages = JSON.stringify(first.requestBody.messages);
    const secondPrefix = JSON.stringify(
      second.requestBody.messages.slice(0, first.requestBody.messages.length)
    );
    assert.equal(secondPrefix, firstMessages, "第二轮 messages 必须以首轮为逐字节前缀");
    assert.ok(
      second.requestBody.messages.length > first.requestBody.messages.length,
      "第二轮应在首轮 body 之后追加消息"
    );
  });
});

// ============= (d) tool_result 占位符:recall 激活 + 教学 prompt 稳定 =============

test("生产路径: tool_result 占位符触发 recall 改写,且教学 prompt 跨轮逐字节稳定", async () => {
  _resetIndexForTest();
  const plugin = await buildPlugin({
    compressToolResults: true,
    keepRecentToolResults: 0,
    maxCompressToolResults: 100,
    toolResultThresholdChars: 1000,
    tokenBudget: 0
  });
  const marker = "<<HISTORY_RECALL_INSTRUCTION_v2>>";
  const toolUse = (id) => ({ content: [{ id, input: {}, name: "Read", type: "tool_use" }], role: "assistant" });
  const toolResult = (id) => ({
    content: [{ content: `${id} ` + "x".repeat(1500), tool_use_id: id, type: "tool_result" }],
    role: "user"
  });
  const one = [
    { content: "task", role: "user" },
    toolUse("p1"),
    toolResult("p1"),
    { content: "ok", role: "assistant" },
    { content: "continue", role: "user" }
  ];
  const first = await runTransform(plugin, { messages: structuredClone(one), model: "MiniMax-M3" }, "sess-tool-qa");
  assert.ok(first);
  const recalledModel = String(first.model ?? first.headers?.["x-ccr-routed-model"] ?? "");
  assert.match(recalledModel, /^ccr-helix-recall\//, "tool_result 占位符必须触发 recall 虚拟模型改写");
  const firstSystem = systemWithMarker(first.requestBody, marker);
  assert.ok(firstSystem, "必须注入 history_recall 教学 prompt");

  // 追加一条更大的 tool_result 占位符;清单未满 40 条 → 教学 prompt 必须逐字节不变。
  const two = structuredClone(one);
  two.splice(two.length - 2, 0, toolUse("p2"), toolResult("p2"));
  const second = await runTransform(plugin, { messages: two, model: "MiniMax-M3" }, "sess-tool-qa");
  assert.ok(second);
  assert.equal(
    systemWithMarker(second.requestBody, marker),
    firstSystem,
    "新增占位符不得改写头部教学 prompt(缓存前缀稳定)"
  );
});
