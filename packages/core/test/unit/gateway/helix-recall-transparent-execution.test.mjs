/**
 * helix recall 闭环(2026-10-15 V1.11) — 网关 virtualModelProfile 装配测试
 *
 * 为什么不再是 transparentToolExecution:外部网关 @the-next-ai/ai-gateway 的透明工具
 * 执行有 `!streaming` 闸门(handler.ts `shouldUseTransparentToolExecutionPath`),而真实
 * Claude Code 恒 stream:true → 永远够不着。profile 的 internal tool 循环**支持流式**
 * (buffered 收集 → 跑 loop → 重合成 SSE),因此 recall 迁到 profile。
 *
 * 背景/见 docs/issue-reviews/2026-10-14-local-closed-loop-recall-design.md §6.1。
 *
 * 本地压缩模式下 ccr 需要在编译网关配置时:
 *   1. 追加一个 helix virtualModelProfile,以 **model 前缀** 命中(transform 只在 body
 *      含可召回占位符时改写 model → 命中 profile 才 buffer,无占位符保持 live 直通);
 *   2. profile 工具 hc_recall / history_recall 标 internal,由网关通过 MCP 兑现;
 *   3. 挂载 helix-recall MCP server,网关 tool provider 才能解析 / 执行 recall 工具。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { compileCoreGatewayConfig } from "@ccr/core/gateway/core-runtime/config-compiler.ts";
import {
  HELIX_RECALL_MCP_SERVER_NAME,
  HELIX_RECALL_MODEL_PREFIX,
  HELIX_RECALL_PROFILE_KEY,
  HELIX_RECALL_TOOL_NAMES
} from "@ccr/core/contracts/app.ts";

function configWithHelixPlugin(pluginConfig) {
  const config = createDefaultAppConfig();
  config.Providers = [{
    api_base_url: "https://api.minimaxi.com/v1",
    capabilities: [{ baseUrl: "https://api.minimaxi.com/v1", source: "detected", type: "openai_chat_completions" }],
    credentials: [{ apiKey: "key", enabled: true, id: "primary", priority: 1 }],
    id: "minimax",
    models: ["MiniMax-M2.7"],
    name: "MiniMax",
    type: "openai_chat_completions"
  }];
  config.plugins = [{
    config: pluginConfig,
    enabled: true,
    id: "helix-compressor"
  }];
  return config;
}

function helixRecallServer(compiled) {
  const servers = compiled.agent?.mcpServers ?? [];
  return servers.find((server) => server.name === HELIX_RECALL_MCP_SERVER_NAME);
}

function helixRecallProfile(compiled) {
  const profiles = compiled.virtualModelProfiles ?? [];
  return profiles.find((profile) => profile.key === HELIX_RECALL_PROFILE_KEY);
}

test("启用 helix 插件 → 追加 helix virtualModelProfile,model 前缀命中,recall 工具 internal", async () => {
  const compiled = await compileCoreGatewayConfig(
    configWithHelixPlugin({}),
    "raw-trace-token",
    "billing-token",
    "core-token"
  );

  const profile = helixRecallProfile(compiled);
  assert.ok(profile, "应当追加 ccr-helix-recall-stream profile");
  assert.equal(profile.enabled, true);
  assert.deepEqual(profile.match.prefixes, [HELIX_RECALL_MODEL_PREFIX]);
  assert.ok(profile.match.prefixes[0].endsWith("/"), "前缀需带斜杠,便于剥离后拿到真 model");
  assert.deepEqual(
    profile.tools.slice().sort((a, b) => a.name.localeCompare(b.name)),
    [...HELIX_RECALL_TOOL_NAMES].slice().sort((a, b) => a.localeCompare(b)).map((name) => ({ name, visibility: "internal" })),
    "hc_recall / history_recall 都必须是 internal"
  );
  assert.equal(profile.execution.mode, "tool_loop");
  assert.equal(profile.execution.clientToolsPolicy, "allow", "客户端工具必须放行,否则 Claude Code 自带工具被拒");
  assert.equal(profile.execution.streamMode, "buffered", "流式需 buffered 才能跑 internal tool loop");
  assert.ok(profile.execution.maxTurns > 0 && profile.execution.maxTurns < Number.MAX_SAFE_INTEGER);
  assert.ok(profile.execution.maxToolCalls > 0 && profile.execution.maxToolCalls < Number.MAX_SAFE_INTEGER);
});

test("启用 helix 插件 → helix profile 不进 gateway 模型列表(materialization 关闭)", async () => {
  const compiled = await compileCoreGatewayConfig(
    configWithHelixPlugin({}),
    "raw-trace-token",
    "billing-token",
    "core-token"
  );

  const profile = helixRecallProfile(compiled);
  assert.equal(profile.materialization.enabled, false, "内部 profile 不应被物化成可枚举模型");
  assert.equal(profile.materialization.includeInGatewayModels, false);
});

test("启用 helix 插件 → 挂载 helix-recall MCP server(网关工具 provider 前提)", async () => {
  const compiled = await compileCoreGatewayConfig(
    configWithHelixPlugin({}),
    "raw-trace-token",
    "billing-token",
    "core-token"
  );

  const server = helixRecallServer(compiled);
  assert.ok(server, "应当挂载 ccr-helix-recall MCP server");
  assert.equal(server.transport, "stdio");
  assert.ok(Array.isArray(server.args) && server.args.length > 0);
  assert.ok(server.env?.HELIX_RECALL_CACHE_DIR, "MCP 子进程需共享 HELIX_RECALL_CACHE_DIR");
});

test("默认配置(内置插件默认启用) → 追加 helix profile,挂 recall MCP", async () => {
  const config = createDefaultAppConfig();
  const compiled = await compileCoreGatewayConfig(config, "raw-trace-token", "billing-token", "core-token");

  assert.ok(helixRecallProfile(compiled));
  assert.ok(helixRecallServer(compiled));
});

test("helix 插件被移除 → 不追加 helix profile,不挂 recall MCP", async () => {
  const config = createDefaultAppConfig();
  config.plugins = [];
  const compiled = await compileCoreGatewayConfig(config, "raw-trace-token", "billing-token", "core-token");

  assert.equal(helixRecallProfile(compiled), undefined);
  assert.equal(helixRecallServer(compiled), undefined);
});

test("helix 插件 disabled → 不追加", async () => {
  const config = configWithHelixPlugin({});
  config.plugins[0].enabled = false;
  const compiled = await compileCoreGatewayConfig(config, "raw-trace-token", "billing-token", "core-token");
  assert.equal(helixRecallProfile(compiled), undefined);
});

test("用户显式配置 transparentToolExecution.enabled=true → 原样透传,不受影响", async () => {
  const config = configWithHelixPlugin({});
  config.transparentToolExecution = {
    allowTools: ["custom_tool"],
    enabled: true,
    maxToolCalls: 3,
    maxTurns: 2,
    requireClientDeclaration: true,
    unknownToolPolicy: "fail"
  };
  const compiled = await compileCoreGatewayConfig(config, "raw-trace-token", "billing-token", "core-token");

  assert.deepEqual(compiled.transparentToolExecution, config.transparentToolExecution);
  // 用户配置与 helix profile 并存:profile 仍然追加(两者互不冲突)
  assert.ok(helixRecallProfile(compiled), "helix profile 仍应追加");
});
