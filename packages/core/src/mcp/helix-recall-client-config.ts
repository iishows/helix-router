/**
 * Claude Code 客户端 MCP 配置:helix 本地召回 server。
 *
 * 背景(2026-10-15):网关的"透明工具执行"(唯一能拦截 internal tool 调用、回填、续同一轮的
 * 路径)被硬门控 `!streaming`(见 @the-next-ai/ai-gateway handler 的
 * shouldUseTransparentToolExecutionPath)。真实 Claude Code 永远发 stream:true → 走流式分支,
 * 模型发出的 hc_recall / history_recall tool_use 从不被网关执行,而是原样泄漏给客户端。
 *
 * 修复:把同一个 helix-recall MCP server 也注入到 Claude Code 客户端的 MCP 配置
 * (profiles/service.ts writeClaudeCodeToolHubMcpConfig),让客户端在流式下原生执行召回调用。
 * server 复用 helixRecallMcpServer()(与网关侧同一 descriptor),command/args/env 完全一致,
 * 因此与压缩端(gateway 进程内写 helix-recall-local-store)共享同一份本地 JSONL 缓存。
 */
import type { AppConfig } from "@ccr/core/contracts/app";
import { helixLocalRecallEnabled } from "@ccr/core/plugins/built-ins/helix-compressor";
import { helixRecallMcpServer } from "@ccr/core/mcp/fusion-config";
import type { ClaudeCodeMcpServerConfig } from "@ccr/core/mcp/toolhub-config";

/**
 * 生成 Claude Code 客户端形状的 helix-recall MCP server 配置;未启用本地召回时返回 undefined。
 *
 * 客户端只认 {args, command, cwd?, env?},故剥掉网关专属字段(transport / protocolVersion /
 * requestTimeoutMs / startupTimeoutMs / stdioMessageMode)。
 */
export function claudeCodeHelixRecallMcpConfig(config: AppConfig | undefined): ClaudeCodeMcpServerConfig | undefined {
  if (!helixLocalRecallEnabled(config)) {
    return undefined;
  }
  const server = helixRecallMcpServer();
  if (server.transport !== "stdio") {
    return undefined;
  }
  return {
    args: server.args,
    command: server.command,
    env: server.env
  };
}
