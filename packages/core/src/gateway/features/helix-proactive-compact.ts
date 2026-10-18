/**
 * Helix 主动 compact — 压缩后仍超 token 预算时，网关侧折叠更早历史再转发
 *
 * 背景（见 docs 计划 `fizzy-meandering-russell`）:
 *   helix 压缩后请求体仍可能远超预算（最近几轮原文 / system / tools / 压不掉的部分）。
 *   该层在 router-plugin 的 `applyHelixCompressorTransform` 内、压缩算完之后运行:
 *   一旦压缩后 token > tokenBudget，就把更早的历史折成一个摘要、只保留最近
 *   `keepRecentTurns` 个「新用户轮」原文，再用折叠后的 body 转发。
 *
 * 摘要复用当前路由模型（两次调用：本模块的摘要调用 + 网关正常转发）。
 * 跨轮去重 = 缓存 + 增量:按 `sessionId + 折叠前缀 hash` 缓存摘要;前缀未变→命中复用
 * （零额外调用）;前缀变长→只摘要 delta 并与旧摘要合并。
 *
 * 设计约束:
 *   - 只做「丢前缀 + 改 system」，不动 role 序列 → 不会触发 role 交替 400。
 *   - 切点只落在「新用户轮起点」→ tool_use/tool_result 对绝不跨切点。
 *   - 任何失败（fetch 抛错 / 超时 / 非 2xx / 空文本）都返回 undefined，原 body 照常转发。
 */

import { createHash } from "node:crypto";
import { encode as gptEncode } from "gpt-tokenizer";
import type { AppConfig, GatewayProviderConfig, GatewayProviderProtocol } from "@ccr/core/contracts/app";
import { HELIX_RECALL_MODEL_PREFIX } from "@ccr/core/contracts/app";
import { hasExplicitCompactSignal, extractArchiveAssistantText } from "@ccr/core/gateway/context-archive/protocol";
import { modelRegistryForConfig } from "@ccr/core/routing/model-registry";
import { resolveModelContextWindow } from "@ccr/core/gateway/model-catalog";
import { normalizeProviderProtocol } from "@ccr/core/providers/runtime-topology";
import { parseProviderBaseUrl } from "@ccr/core/providers/url";
import {
  findPrefixSummary,
  getCompactSummary,
  putCompactSummary,
  _resetIndexForTest as resetCompactSummaryIndex,
  type CompactSummaryEntry
} from "@ccr/core/observability/helix-compact-summary-store";

type JsonObject = Record<string, unknown>;

export interface ProactiveCompactSettings {
  /** 绝对 token 预算;<=0 关闭。 */
  tokenBudget: number;
  /** 保留最近 N 个「新用户轮」原文。 */
  keepRecentTurns: number;
  /** 摘要调用超时(ms)。 */
  timeoutMs: number;
  /** 可选摘要模型覆盖;空 = 用当前路由模型。 */
  model: string;
  /** 摘要缓存 TTL(ms)。 */
  cacheTtlMs: number;
  /**
   * 「积攒」阈值:复用已有前缀摘要时,只有当**未覆盖的新历史**条数 ≥ 该值,
   * 才重新做一次(增量)摘要;否则一律复用旧摘要、把未覆盖区间当原文一起发。
   * 0 = 关闭积攒(每轮边界变化都重摘,即旧行为)。
   */
  minNewMessages: number;
  /** 上下文百分比预算:>0 时启用「有效上下文长度 × percent%」,clamp 到 [floor,ceiling];否则用绝对 tokenBudget。 */
  percent: number;
  /** percent 预算下限(token)。 */
  floorTokens: number;
  /** percent 预算上限 / 硬顶(token)。 */
  ceilingTokens: number;
  /** 按真实 model 名覆盖 percent。 */
  percentOverrides: Record<string, number>;
}

export type ProactiveCompactSource = "accumulate" | "cache" | "incremental" | "model";

export type ProactiveCompactResult = {
  /** 折叠后的 body。 */
  requestBody: JsonObject;
  /** 诊断串,写进 `x-ccr-helix-proactive-compact` 响应头。 */
  diagnostic: string;
  /** 摘要来源:cache(逐字节命中)/ accumulate(复用旧前缀摘要,中间段留原文)/ incremental(前缀增量)/ model(整段新摘要)。 */
  source: ProactiveCompactSource;
  /** 该摘要覆盖的历史代次(累计被折叠过的消息条数)。 */
  coveredCount: number;
  /** 本次折叠掉的更早历史条数。 */
  foldedCount: number;
  /** 折叠后保留区(kept)的 token 数 —— 即最终提交给上游的 messages token。 */
  tokensAfter: number;
  /** 注入 system 的摘要自身 token 数(model/incremental 调用时才有)。 */
  summaryTokens?: number;
  /** 本次生效的 compact 预算(percent 路径时为 clamp 后的值,否则 = tokenBudget)。 */
  budgetTokens?: number;
};

export type ProactiveCompactInput = {
  body: JsonObject;
  config: AppConfig;
  headers: Record<string, string>;
  /** 真 model(已剥掉 ccr-helix-recall/ 前缀)。 */
  model: string;
  postCompressionTokens: number;
  /** 预算 / 保留轮数 / 超时等设置(由 router-plugin 从 helix 插件 config 解析)。 */
  settings: ProactiveCompactSettings;
  signal?: AbortSignal;
};

const MAX_SUMMARY_TRANSCRIPT_CHARS = 200_000;
const SUMMARY_MAX_TOKENS = 2048;
/**
 * 推理模型(DeepSeek-R1/V3.x、Qwen3、GLM 等)会把 `max_tokens` 全花在 `reasoning_content` 上,
 * 导致 `finish_reason=length` 且 `content` 为空 —— 摘要拿不到文本 → compact 被静默跳过。
 * 实测 autodl/DeepSeek-V4.1-Flash:2048/4096/8192 的 content 全为 0。
 * 对策:先发 `enable_thinking:false`(或 `reasoning.effort:minimal`)关思考;个别 provider
 * 拒绝该字段时退回「今天的原样请求」,保证零回归。
 */
const SUMMARY_DISABLE_THINKING_FIELDS = { enable_thinking: false } as const;

/** 主动 compact 主入口。命中门控则返回折叠后的 body;否则返回 undefined。 */
export async function applyHelixProactiveCompact(
  input: ProactiveCompactInput
): Promise<ProactiveCompactResult | undefined> {
  const settings = input.settings;
  // 测试隔离:重置进程内索引,避免上一用例的缓存目录/文件被复用。
  try {
    resetCompactSummaryIndex();
  } catch {
    // ignore
  }
  if (settings.tokenBudget <= 0 && !(settings.percent > 0)) {
    return undefined;
  }
  // 预算:percent 路径 = clamp(有效上下文长度 × percent%, floor, ceiling);否则 = 绝对 tokenBudget。
  const resolvedBudget = resolveCompactBudgetTokens(input.config, settings, input.model);
  if (resolvedBudget.budget <= 0 || input.postCompressionTokens <= resolvedBudget.budget) {
    return undefined;
  }
  const messages = Array.isArray(input.body.messages) ? (input.body.messages as unknown[]) : [];
  if (messages.length === 0) {
    return undefined;
  }
  // 与客户端 compact 双折叠互斥
  if (hasExplicitCompactSignal(input.body, input.headers as Record<string, string | string[] | undefined>)) {
    return undefined;
  }

  const boundary = foldBoundary(messages, settings.keepRecentTurns);
  if (boundary === undefined) {
    return undefined;
  }
  const folded = messages.slice(0, boundary);
  const kept = messages.slice(boundary);
  if (folded.length === 0 || kept.length === 0) {
    return undefined;
  }

  const sessionId = resolveCompactSessionId(input.body, input.headers);
  const messageHashes = folded.map(messageHash);
  const foldHash = sha256(messageHashes.join("\n"));
  const key = sha256(`${sessionId}|${foldHash}`);

  const cached = getCompactSummary(key);
  if (cached) {
    const keptTokens = tokenize(kept);
    return assemble(input.body, kept, cached.summary, {
      budgetTokens: resolvedBudget.budget,
      coveredCount: cached.coveredCount,
      diagnostic: `gen=${cached.coveredCount},source=cache,folded=${folded.length},tokens_after=${keptTokens},budget=${resolvedBudget.budget}`,
      foldedCount: folded.length,
      source: "cache",
      tokensAfter: keptTokens
    });
  }

  // 「积攒」:folded 前缀已有缓存摘要时,只有未覆盖的新历史累计到阈值才重摘。
  const stored = findPrefixSummary(sessionId, messageHashes);
  const minNew = Math.max(0, Math.floor(settings.minNewMessages));
  if (stored && minNew > 0 && folded.length - stored.matchedCount < minNew) {
    // 未达阈值 → 不重摘:复用旧摘要(matchedCount 之前已被它覆盖),
    //   matchedCount..boundary 这段「新历史」当原文保留。folded 前缀逐字节不变 ⇒ 零上游调用。
    const coverage = stored.matchedCount;
    const keptAcc = messages.slice(coverage);
    if (keptAcc.length > 0) {
      const keptTokens = tokenize(keptAcc);
      return assemble(input.body, keptAcc, stored.entry.summary, {
        budgetTokens: resolvedBudget.budget,
        coveredCount: stored.entry.coveredCount,
        diagnostic: `gen=${stored.entry.coveredCount},source=accumulate,pending=${folded.length - coverage},folded=${coverage},tokens_after=${keptTokens},budget=${resolvedBudget.budget}`,
        foldedCount: coverage,
        source: "accumulate",
        tokensAfter: keptTokens
      });
    }
  }

  const target = resolveSummaryTarget(input.config, settings.model || input.model);
  if (!target) {
    return undefined;
  }

  const summary = await summarizeFolded({
    folded,
    key,
    prefix: stored,
    sessionId,
    settings,
    target,
    signal: input.signal
  });
  if (!summary) {
    return undefined;
  }
  const source: ProactiveCompactSource = stored ? "incremental" : "model";
  const keptTokens = tokenize(kept);
  const summaryTokens = tokenize([{ content: summary.text, role: "assistant" }]);
  return assemble(input.body, kept, summary.text, {
    budgetTokens: resolvedBudget.budget,
    coveredCount: summary.coveredCount,
    diagnostic: `gen=${summary.coveredCount},source=${source},folded=${folded.length},tokens_after=${keptTokens},summary_tokens=${summaryTokens},budget=${resolvedBudget.budget}`,
    foldedCount: folded.length,
    source,
    summaryTokens,
    tokensAfter: keptTokens
  });
}

// ============= 切点 =============

/**
 * 计算折叠边界:从尾向前数第 `keepRecentTurns` 个「新用户轮起点」的索引。
 * 「新用户轮起点」= role === "user" 且 content 不含 tool_result 块。
 * 不足 keepRecentTurns 个起点 → undefined(不折叠)。
 */
export function foldBoundary(messages: unknown[], keepRecentTurns: number): number | undefined {
  const turns = Math.max(1, Math.floor(keepRecentTurns));
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (isNewUserTurnStart(messages[i])) {
      starts.push(i);
    }
  }
  if (starts.length < turns) {
    return undefined;
  }
  const boundary = starts[starts.length - turns];
  return boundary > 0 ? boundary : undefined;
}

function isNewUserTurnStart(message: unknown): boolean {
  if (!isRecord(message) || message.role !== "user") {
    return false;
  }
  const content = message.content;
  if (typeof content === "string") {
    return true;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return !content.some((block) => isRecord(block) && block.type === "tool_result");
}

// ============= 组装 =============

function assemble(
  body: JsonObject,
  kept: unknown[],
  summary: string,
  meta: {
    diagnostic: string;
    source: ProactiveCompactSource;
    coveredCount: number;
    foldedCount: number;
    tokensAfter: number;
    summaryTokens?: number;
    budgetTokens?: number;
  }
): ProactiveCompactResult {
  const trimmed = summary.trim();
  return {
    coveredCount: meta.coveredCount,
    diagnostic: meta.diagnostic,
    foldedCount: meta.foldedCount,
    requestBody: {
      ...body,
      messages: kept,
      system: mergeSystemSummary(body.system, trimmed)
    },
    source: meta.source,
    ...(meta.summaryTokens !== undefined ? { summaryTokens: meta.summaryTokens } : {}),
    ...(meta.budgetTokens !== undefined ? { budgetTokens: meta.budgetTokens } : {}),
    tokensAfter: meta.tokensAfter
  };
}

/** 把摘要注入 system:原 system(字符串或块数组) + 一段 `[CCR compacted summary]`。 */
export function mergeSystemSummary(system: unknown, summary: string): unknown {
  const block = `[CCR compacted summary]\n${summary}`;
  if (typeof system === "string") {
    return system.trim() ? `${system}\n\n${block}` : block;
  }
  if (Array.isArray(system)) {
    return [...system, { type: "text", text: block }];
  }
  return block;
}

// ============= 摘要调用 =============

async function summarizeFolded(input: {
  folded: unknown[];
  key: string;
  prefix: { entry: CompactSummaryEntry; matchedCount: number } | null;
  sessionId: string;
  settings: ProactiveCompactSettings;
  target: SummaryTarget;
  signal?: AbortSignal;
}): Promise<{ coveredCount: number; text: string } | undefined> {
  const delta = input.prefix ? input.folded.slice(input.prefix.matchedCount) : input.folded;
  if (delta.length === 0 && !input.prefix) {
    return undefined;
  }
  const prompt = buildSummaryPrompt(input.prefix?.entry.summary, delta);
  const text = await callSummary({
    model: input.target.model,
    prompt,
    protocol: input.target.protocol,
    provider: input.target.provider,
    timeoutMs: input.settings.timeoutMs,
    ...(input.signal ? { signal: input.signal } : {})
  });
  if (!text) {
    return undefined;
  }
  try {
    putCompactSummary(
      {
        key: input.key,
        messageHashes: input.folded.map(messageHash),
        sessionId: input.sessionId,
        summary: text,
        coveredCount: input.folded.length
      },
      input.settings.cacheTtlMs
    );
  } catch {
    // 缓存写失败不影响本次转发
  }
  return { coveredCount: input.folded.length, text };
}

export function buildSummaryPrompt(previous: string | undefined, delta: unknown[]): string {
  const parts = [
    "CCR compact handoff task:",
    "You are the previous-context agent. Produce a concise, action-oriented handoff for a successor agent that will start with a fresh context.",
    "Do not solve new work. Do not call tools. Do not invent details. Use only the conversation and tool results given below.",
    "Keep the handoff under 1200 words. Preserve exact file paths, identifiers, command names, and error messages.",
    "",
    "Write these sections, in this order:",
    "1. Current objective and status.",
    "2. Exact remaining blocker or open question (with the latest error text if any).",
    "3. Decisions and constraints already established that the successor must respect.",
    "4. Work completed so far (files/APIs touched, marked as implementation details, not requirements).",
    "5. Exact next action (one to three smallest steps)."
  ];
  if (previous?.trim()) {
    parts.push(
      "",
      "An existing handoff covering earlier history is provided first. Merge it with the new conversation into a single updated handoff.",
      "",
      "=== EXISTING HANDOFF ===",
      previous.trim()
    );
  }
  parts.push("", "=== CONVERSATION TO SUMMARIZE ===", transcriptOf(delta));
  return parts.join("\n");
}

/**
 * 摘要出站目标:provider + 协议 + **上游真实 model 名**。
 *
 * 关键:路由层给的 selector 可能是网关内部复合串(`ProviderName/model`、`Provider A,,B/model`),
 * 也可能是 recall 虚拟串;这些都不是上游 API 承认的 model。必须用 registry 解析出的
 * **配置内真实 model 名**发请求,否则上游回 400 unknown model,摘要静默降级。
 */
type SummaryTarget = {
  model: string;
  provider: GatewayProviderConfig;
  protocol: GatewayProviderProtocol;
};

function resolveSummaryTarget(config: AppConfig, model: string): SummaryTarget | undefined {
  const selector = stripRecallPrefix(model);
  const resolved = modelRegistryForConfig(config).resolveProviderModel(selector);
  const provider = resolved?.provider;
  const upstreamModel = (resolved?.model ?? selector).trim();
  if (!provider || !upstreamModel) {
    return undefined;
  }
  const protocol = normalizeProviderProtocol(provider.type) ?? normalizeProviderProtocol(provider.provider);
  if (!protocol || !summaryEndpoint(providerBaseUrl(provider), protocol)) {
    return undefined;
  }
  return { model: upstreamModel, protocol, provider };
}

/** 剥掉 helix recall 虚拟 model 前缀,避免摘要请求命中 recall virtual-profile。 */
export function stripRecallPrefix(model: string): string {
  const prefix = HELIX_RECALL_MODEL_PREFIX;
  const trimmed = (model ?? "").trim();
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

async function callSummary(input: {
  model: string;
  prompt: string;
  protocol: GatewayProviderProtocol;
  provider: GatewayProviderConfig;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const endpoint = summaryEndpoint(providerBaseUrl(input.provider), input.protocol);
  if (!endpoint || !input.model.trim()) {
    return undefined;
  }
  const apiKey = providerApiKey(input.provider);
  // 先试「关思考」。只有当 provider **拒绝**该字段(4xx)时才退回「原样请求」——
  //   若返回 200 但正文为空(reasoning 吃光预算),重试同样形状无意义,直接放弃(与原行为一致)。
  const withDisable = await attemptSummary(
    { endpoint, protocol: input.protocol, timeoutMs: input.timeoutMs, signal: input.signal },
    buildSummaryRequest(input.protocol, input.model, input.prompt, apiKey, true)
  );
  if (withDisable.text !== undefined) {
    return withDisable.text;
  }
  if (!withDisable.rejected) {
    return undefined;
  }
  const fallback = await attemptSummary(
    { endpoint, protocol: input.protocol, timeoutMs: input.timeoutMs, signal: input.signal },
    buildSummaryRequest(input.protocol, input.model, input.prompt, apiKey, false)
  );
  return fallback.text;
}

type SummaryAttempt = { text?: string; rejected: boolean };

/** 发一次摘要请求并提取助手文本。`rejected=true` 表示 provider 4xx 拒了请求体(可换形状重试)。 */
async function attemptSummary(
  input: { endpoint: string; protocol: GatewayProviderProtocol; timeoutMs: number; signal?: AbortSignal },
  request: { headers: Record<string, string>; body: JsonObject }
): Promise<SummaryAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, input.timeoutMs));
  const onAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onAbort);
  try {
    const response = await fetch(input.endpoint, {
      body: JSON.stringify(request.body),
      headers: request.headers,
      method: "POST",
      signal: controller.signal
    });
    if (!response.ok) {
      return { rejected: true };
    }
    const rawText = await response.text();
    const text = extractArchiveAssistantText(rawText, input.protocol, response.headers.get("content-type") ?? undefined);
    return { rejected: false, text: text.trim() ? text : undefined };
  } catch {
    return { rejected: false };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

function buildSummaryRequest(
  protocol: GatewayProviderProtocol,
  model: string,
  prompt: string,
  apiKey: string,
  disableThinking = false
): { headers: Record<string, string>; body: JsonObject } {
  // 推理模型的「关思考」开关(OpenAI Chat 协议):`enable_thinking:false` 让模型直出正文,
  //   否则 `max_tokens` 会被 `reasoning_content` 吃光 → 摘要为空。见 SUMMARY_DISABLE_THINKING_FIELDS。
  const thinkingFields = disableThinking && protocol === "openai_chat_completions"
    ? { ...SUMMARY_DISABLE_THINKING_FIELDS }
    : {};
  if (protocol === "anthropic_messages") {
    return {
      body: {
        max_tokens: SUMMARY_MAX_TOKENS,
        messages: [{ content: prompt, role: "user" }],
        model,
        stream: false,
        temperature: 0.2
      },
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {})
      }
    };
  }
  if (protocol === "openai_responses") {
    return {
      body: {
        input: prompt,
        max_output_tokens: SUMMARY_MAX_TOKENS,
        model,
        stream: false
      },
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      }
    };
  }
  return {
    body: {
      ...thinkingFields,
      max_tokens: SUMMARY_MAX_TOKENS,
      messages: [{ content: prompt, role: "user" }],
      model,
      stream: false,
      temperature: 0.2
    },
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    }
  };
}

function summaryEndpoint(baseUrl: string, protocol: GatewayProviderProtocol): string | undefined {
  const base = summaryBaseUrl(baseUrl, protocol);
  if (!base) {
    return undefined;
  }
  const trimmed = base.replace(/\/+$/, "");
  if (protocol === "anthropic_messages") {
    return `${trimmed}/v1/messages`;
  }
  if (protocol === "openai_chat_completions") {
    return `${trimmed}/chat/completions`;
  }
  if (protocol === "openai_responses") {
    return `${trimmed}/responses`;
  }
  return undefined;
}

function summaryBaseUrl(raw: string, protocol: GatewayProviderProtocol): string {
  const value = (raw ?? "").trim();
  if (!value) {
    return "";
  }
  try {
    const parsed = parseProviderBaseUrl(value);
    const candidates = protocol === "anthropic_messages"
      ? parsed.anthropicBaseUrlCandidates
      : protocol === "openai_chat_completions" || protocol === "openai_responses"
        ? parsed.openaiBaseUrlCandidates
        : undefined;
    if (candidates && candidates.length > 0) {
      return candidates[0];
    }
  } catch {
    // fall through to raw value
  }
  return value;
}

// ============= helpers =============

function readProactiveCompactSettings(pluginConfig: unknown): ProactiveCompactSettings {
  const config = isRecord(pluginConfig) ? pluginConfig : {};
  const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
  const overrides = isRecord(config.compactBudgetPercentOverrides)
    ? Object.fromEntries(
        Object.entries(config.compactBudgetPercentOverrides as Record<string, unknown>)
          .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
      )
    : {};
  return {
    cacheTtlMs: num(config.proactiveCompactCacheTtlMs, 3 * 24 * 60 * 60 * 1000),
    ceilingTokens: Math.max(0, num(config.compactBudgetCeilingTokens, 120000)),
    floorTokens: Math.max(0, num(config.compactBudgetFloorTokens, 48000)),
    keepRecentTurns: Math.max(1, Math.floor(num(config.keepRecentTurns, 2))),
    minNewMessages: Math.max(0, Math.floor(num(config.proactiveCompactMinNewMessages, 100))),
    model: typeof config.proactiveCompactModel === "string" ? config.proactiveCompactModel : "",
    percent: Math.max(0, num(config.compactBudgetPercent, 0)),
    percentOverrides: overrides,
    timeoutMs: Math.max(1000, num(config.proactiveCompactTimeoutMs, 60000)),
    tokenBudget: num(config.tokenBudget, 100000)
  };
}

/** 从 helix 插件 config 解析主动 compact 设置(router-plugin 调用)。 */
export function readProactiveCompactSettingsFromConfig(pluginConfig: unknown): ProactiveCompactSettings {
  return readProactiveCompactSettings(pluginConfig);
}

/**
 * 解析本次 compact 生效的 token 预算。
 * percent <= 0 → 绝对 `tokenBudget`(向后兼容);
 * percent > 0 → `clamp(floor(有效上下文长度 × percent/100), floor, ceiling)`,拿不到上下文长度则回退 `tokenBudget`。
 * percent 可用 `percentOverrides[真实 model 名]` 覆盖。
 */
export function resolveCompactBudgetTokens(
  config: AppConfig,
  settings: ProactiveCompactSettings,
  model: string
): { budget: number; contextWindow?: number; percent?: number } {
  if (!(settings.percent > 0)) {
    return { budget: settings.tokenBudget };
  }
  const selector = stripRecallPrefix(model);
  const resolved = modelRegistryForConfig(config).resolveProviderModel(selector);
  const upstream = (resolved?.model ?? selector).trim();
  const contextWindow = resolveModelContextWindow(resolved?.provider, upstream);
  if (!contextWindow) {
    return { budget: settings.tokenBudget };
  }
  const percent = settings.percentOverrides[upstream] ?? settings.percentOverrides[selector] ?? settings.percent;
  const raw = Math.floor((contextWindow * percent) / 100);
  const floor = Math.max(0, settings.floorTokens);
  const ceiling = Math.max(floor, settings.ceilingTokens);
  return {
    budget: Math.min(ceiling, Math.max(floor, raw)),
    contextWindow,
    percent
  };
}

function resolveCompactSessionId(body: JsonObject, headers: Record<string, string>): string {
  const read = (name: string): string | undefined => {
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
    const value = Array.isArray(entry) ? entry.join(",") : entry;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const metadata = isRecord(body.metadata) ? body.metadata : {};
  const candidates = [
    read("x-claude-code-session-id"),
    read("x-claude-session-id"),
    read("x-codex-session-id"),
    read("x-openai-session-id"),
    read("x-agent-session-id"),
    read("x-session-id"),
    safeString(metadata.session_id),
    safeString(metadata.sessionId),
    safeString(metadata.conversation_id),
    safeString(body.conversation_id)
  ];
  const selected = candidates.find((value) => value?.trim());
  return selected ? selected.trim().slice(0, 160) : "unknown-session";
}

function messageHash(message: unknown): string {
  return sha256(stableStringify(message));
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 粗算 messages 的 token 数(与 helix-compressor 的 tokenizeMessages 同口径)。 */
function tokenize(messages: unknown[]): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  try {
    return gptEncode(JSON.stringify(messages)).length;
  } catch {
    return 0;
  }
}

function transcriptOf(messages: unknown[]): string {
  const lines: string[] = [];
  let total = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const role = isRecord(message) && typeof message.role === "string" ? message.role : "user";
    const text = stringifyContent(isRecord(message) ? message.content : message);
    const entry = `## [${i}] ${role}\n${text}`;
    if (total + entry.length > MAX_SUMMARY_TRANSCRIPT_CHARS) {
      lines.push(`## [${i}] ... (transcript truncated at ${MAX_SUMMARY_TRANSCRIPT_CHARS} chars)`);
      break;
    }
    total += entry.length;
    lines.push(entry);
  }
  return lines.join("\n\n");
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") {
          return block;
        }
        if (!isRecord(block)) {
          return String(block);
        }
        if (typeof block.text === "string") {
          return block.text;
        }
        const type = typeof block.type === "string" ? block.type : "block";
        return `[${type}] ${safeStringify(block)}`;
      })
      .join("\n");
  }
  return content === undefined ? "" : safeStringify(content);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function providerBaseUrl(provider: GatewayProviderConfig): string {
  return provider.api_base_url || provider.baseUrl || provider.baseurl || "";
}

function providerApiKey(provider: GatewayProviderConfig): string {
  return provider.api_key || provider.apiKey || provider.apikey || "";
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
