/**
 * helix 客户端 MCP 召回装配测试(2026-10-15)
 *
 * 背景:网关的"透明工具执行"(唯一能拦截 hc_recall / history_recall 并续跑同一轮的路径)
 * 被硬门控 `!streaming`(@the-next-ai/ai-gateway handler.ts shouldUseTransparentToolExecutionPath)。
 * 真实 Claude Code 永远发 stream:true → 模型发出的 recall tool_use 从不被网关执行。
 *
 * 修复:把同一个 helix-recall MCP server(helixRecallMcpServer)也注入 Claude Code 客户端的
 * MCP 配置,让客户端在流式下原生执行召回。本测试锁定:
 *   1. helixLocalRecallEnabled 判据(插件存在且未禁用);
 *   2. claudeCodeHelixRecallMcpConfig 产出的客户端形状({args, command, env},无网关专属字段);
 *   3. 与 gateway 侧共享同一份本地缓存(env.HELIX_RECALL_CACHE_DIR === HELIX_RECALL_DIR)。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { helixLocalRecallEnabled } from "@ccr/core/plugins/built-ins/helix-compressor.ts";
import { claudeCodeHelixRecallMcpConfig } from "@ccr/core/mcp/helix-recall-client-config.ts";
import { helixRecallMcpServer } from "@ccr/core/mcp/fusion-config.ts";
import { HELIX_RECALL_DIR } from "@ccr/core/config/constants.ts";

function configWithHelixPlugin(pluginConfig) {
  const config = createDefaultAppConfig();
  config.plugins = [{ config: pluginConfig, enabled: true, id: "helix-compressor" }];
  return config;
}

// ---------- helixLocalRecallEnabled 真值表 ----------

test("helixLocalRecallEnabled: 插件存在且启用 → true", () => {
  assert.equal(helixLocalRecallEnabled(configWithHelixPlugin({})), true);
  assert.equal(helixLocalRecallEnabled(configWithHelixPlugin({ keepRecentPairs: 1 })), true);
});

test("helixLocalRecallEnabled: 无插件 / 插件禁用 → false", () => {
  assert.equal(helixLocalRecallEnabled(createDefaultAppConfig()), false);
  assert.equal(helixLocalRecallEnabled(undefined), false);
  const disabled = configWithHelixPlugin({});
  disabled.plugins[0].enabled = false;
  assert.equal(helixLocalRecallEnabled(disabled), false);
});

// ---------- claudeCodeHelixRecallMcpConfig ----------

test("启用 helix 插件 → 产出客户端形状的 helix-recall server,与 gateway 侧同源", () => {
  const config = configWithHelixPlugin({});
  const client = claudeCodeHelixRecallMcpConfig(config);
  assert.ok(client, "应产出客户端 MCP 配置");

  const gatewayServer = helixRecallMcpServer();
  // 同一份 descriptor:command/args/env 逐一致(从而读同一份本地 JSONL 缓存)
  assert.equal(client.command, gatewayServer.command);
  assert.deepEqual(client.args, gatewayServer.args);
  assert.equal(client.env.HELIX_RECALL_CACHE_DIR, HELIX_RECALL_DIR);
  assert.equal(client.env.HELIX_RECALL_CACHE_DIR, gatewayServer.env.HELIX_RECALL_CACHE_DIR);
  assert.match(client.args[0], /helix-recall-mcp\.js$/);

  // 客户端形状:不得带网关专属字段
  assert.equal("transport" in client, false);
  assert.equal("protocolVersion" in client, false);
  assert.equal("name" in client, false);
});

test("未启用本地召回(无插件/禁用) → undefined(不注入客户端 MCP)", () => {
  const disabled = configWithHelixPlugin({});
  disabled.plugins[0].enabled = false;
  assert.equal(claudeCodeHelixRecallMcpConfig(disabled), undefined);
  assert.equal(claudeCodeHelixRecallMcpConfig(createDefaultAppConfig()), undefined);
  assert.equal(claudeCodeHelixRecallMcpConfig(undefined), undefined);
});
