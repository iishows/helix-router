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
 *   - 只丢完整消息 + 改 system，不动单条消息内部 → 不会触发 role 交替 400。
 *   - 切点只落在「新用户轮起点」;保留区内折叠只丢**完整 tool 交换对**
 *     (assistant tool_use + 其后纯 tool_result) → tool_use/tool_result 绝不跨切点。
 *   - 头部连续 system 消息(含压缩器插入的合成 recall 教学)永远保留,不参与折叠。
 *   - 折叠收益 < `minFoldedTokens` 时不做(避免「折叠 1 条」的无意义摘要)。
 *   - 任何失败（fetch 抛错 / 超时 / 非 2xx / 空文本）都返回 undefined，原 body 照常转发。
 *
 * 2026-11-08: 原实现只保留最近 `keepRecentTurns` 轮且把头部 system 也算进可折前缀,
 *   在 agent 长循环里会退化成「折叠 1 条 system(2.5k)/预算 100k 却仍 220k」。
 *   新增 `aggressiveFolding`:整轮折叠压不进预算时,继续在保留区内丢完整 tool 交换对。
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
  findLatestSummary,
  findPrefixSummary,
  getCompactSummary,
  putCompactSummary,
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
  /**
   * 激进折叠(默认 true):保留轮数不足以压进预算时,继续整轮向前折叠;仍超预算时,
   * 在保留区内按「完整 tool 交换对」从旧到新丢弃。agent 长循环里单个用户轮就能占满
   * 整个上下文,只保留最近 N 轮等于不折叠(实测 220k 仍为 100k 预算的 2.2 倍)。
   * 设 false = 旧行为(只保留最近 keepRecentTurns 轮,绝不进入保留区)。
   */
  aggressiveFolding: boolean;
  /**
   * 最小折叠收益(token,默认 1024)。折叠内容低于该值时不做 compact —— 避免
   * 「折叠 1 条 / 省 2.5k」这种无意义摘要与缓存抖动。
   */
  minFoldedTokens: number;
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

  // 2026-11-08: 折叠只在「会话消息」上进行。Anthropic 客户端的 system 在 messages 外,
  // helix 压缩器会为 recall 教学 prompt 往 messages 头部插入一条 role=system 的合成消息。
  // 旧实现把它算进可折叠前缀 → boundary=1、只折叠这条合成消息(实测省 2.5k / 预算 100k),
  // 既没效果,还会把 recall 教学提示一起折掉。这里统一保护头部 system 消息。
  const protectedCount = leadingSystemMessageCount(messages);
  const protectedMessages = messages.slice(0, protectedCount);
  const conversation = messages.slice(protectedCount);
  if (conversation.length === 0) {
    return undefined;
  }
  const protectedTokens = protectedCount > 0 ? tokenize(protectedMessages) : 0;
  const plan = planCompactFold(
    conversation,
    settings.keepRecentTurns,
    resolvedBudget.budget - protectedTokens,
    settings.aggressiveFolding
  );
  if (!plan) {
    return undefined;
  }
  let folded = plan.folded;
  let kept = plan.kept;
  let usedIntraTurn = plan.usedIntraTurn;
  if (folded.length === 0 || kept.length === 0) {
    return undefined;
  }

  const sessionId = resolveCompactSessionId(input.body, input.headers);
  const minNew = Math.max(0, Math.floor(settings.minNewMessages));
  // 缓存稳定(2026-11-08):只要「相对上一条摘要新增的历史」还不够多,就复用该摘要
  //   与它覆盖的**原消息集合**,把新增内容当原文保留。这样 outbound body = 上一轮 body
  //   + 追加消息(纯前缀扩展),上游 prompt 缓存不被打断。
  //   背景:上游缓存价 = 输入价 2%;摘要文本挂在 system 尾部,一旦变化,后面所有 messages
  //   全部失效(实测命中从 ~99% 掉到 18-33%)。
  //   注意判据必须是「会话新增条数」而不是「本次计划折叠条数」:每次请求都携带完整历史,
  //   预算驱动的折叠集合会随历史增长而变大,用它做判据会导致每轮都重生成摘要。
  let reusedSummary: { summary: string; coveredCount: number } | undefined;
  if (minNew > 0) {
    const latest = findLatestSummary(sessionId);
    if (latest && latest.keptCount !== undefined) {
      const appended = conversation.length - (latest.coveredCount + latest.keptCount);
      if (appended >= 0 && appended < minNew) {
        const reuse = reconstructDroppedSet(conversation, latest.messageHashes);
        // 复用会让 body 随新增历史增长;超过预算 2 倍时宁可重生成一次,避免上下文膨胀。
        if (reuse && tokenize([...protectedMessages, ...reuse.kept]) <= resolvedBudget.budget * 2) {
          folded = reuse.folded;
          kept = reuse.kept;
          usedIntraTurn = reuse.usedIntraTurn;
          reusedSummary = { coveredCount: latest.coveredCount, summary: latest.summary };
        }
      }
    }
  }
  if (folded.length === 0 || kept.length === 0) {
    return undefined;
  }
  // 最小收益门槛:折叠 1 条/几百 token 不值得发起摘要调用,也避免缓存抖动。
  if (settings.minFoldedTokens > 0 && tokenize(folded) < settings.minFoldedTokens) {
    return undefined;
  }
  const keptOutput = [...protectedMessages, ...kept];
  const diagnosticSuffix = usedIntraTurn ? ",intra=1" : "";

  const messageHashes = folded.map(messageHash);
  const foldHash = sha256(messageHashes.join("\n"));
  const key = sha256(`${sessionId}|${foldHash}`);

  const cached = getCompactSummary(key);
  if (cached) {
    const keptTokens = tokenize(keptOutput);
    return assemble(input.body, keptOutput, cached.summary, {
      budgetTokens: resolvedBudget.budget,
      coveredCount: cached.coveredCount,
      diagnostic: `gen=${cached.coveredCount},source=cache,folded=${folded.length},tokens_after=${keptTokens},budget=${resolvedBudget.budget}${diagnosticSuffix}`,
      foldedCount: folded.length,
      source: "cache",
      tokensAfter: keptTokens
    });
  }
  if (reusedSummary) {
    // 复用集合与摘要都已确定时理论上 key 会命中;若索引/TTL 边界导致 miss,仍直接复用,
    //   绝不因为一次查询落空就重新生成摘要(否则缓存前缀被打断)。
    const keptTokens = tokenize(keptOutput);
    return assemble(input.body, keptOutput, reusedSummary.summary, {
      budgetTokens: resolvedBudget.budget,
      coveredCount: reusedSummary.coveredCount,
      diagnostic: `gen=${reusedSummary.coveredCount},source=cache,folded=${folded.length},tokens_after=${keptTokens},budget=${resolvedBudget.budget}${diagnosticSuffix}`,
      foldedCount: folded.length,
      source: "cache",
      tokensAfter: keptTokens
    });
  }

  const stored = usedIntraTurn ? null : findPrefixSummary(sessionId, messageHashes);
  const target = resolveSummaryTarget(input.config, settings.model || input.model);
  if (!target) {
    return undefined;
  }

  const summary = await summarizeFolded({
    folded,
    keptCount: conversation.length - folded.length,
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
  const keptTokens = tokenize(keptOutput);
  const summaryTokens = tokenize([{ content: summary.text, role: "assistant" }]);
  return assemble(input.body, keptOutput, summary.text, {
    budgetTokens: resolvedBudget.budget,
    coveredCount: summary.coveredCount,
    diagnostic: `gen=${summary.coveredCount},source=${source},folded=${folded.length},tokens_after=${keptTokens},summary_tokens=${summaryTokens},budget=${resolvedBudget.budget}${diagnosticSuffix}`,
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

/** 头部连续 system 消息的条数:这些是协议/合成消息(如 recall 教学 prompt),永远不折叠。 */
export function leadingSystemMessageCount(messages: unknown[]): number {
  let count = 0;
  while (count < messages.length) {
    const message = messages[count];
    if (!isRecord(message) || message.role !== "system") {
      break;
    }
    count += 1;
  }
  return count;
}

type CompactFoldPlan = {
  /** 被折叠的消息(按原始顺序;含保留区内被丢弃的完整 tool 交换对)。 */
  folded: unknown[];
  /** 保留的消息(不含头部受保护的 system 消息)。 */
  kept: unknown[];
  /** 是否在保留区内做了 tool 交换对折叠(此时 folded 不是会话前缀)。 */
  usedIntraTurn: boolean;
};

/**
 * 计算折叠计划(2026-11-08 二次重写:尾部填满预算)。
 *
 * 旧策略按「人类轮」整轮丢弃:上一轮装不进预算就整轮扔掉,实测把 259k 折成 2.8k,
 * 只剩最后 3 条消息 —— 上下文损失巨大,而多保留的 token 几乎都命中缓存(2% 价)。
 *
 * 新策略:
 *   1. 非 aggressive = 旧行为(保留最近 keepRecentTurns 轮,只折更早历史);
 *   2. aggressive = 从尾部按 token 填预算:选**最早**一个「新用户轮起点」,
 *      使 [起点, 末尾] 的 token ≤ budget(尽可能多保留上下文);
 *   3. 若连最后一轮都装不下,则保留该轮起点 + 尾部尽可能多的完整后缀
 *      (切点只落在 assistant 消息上 → 不会产生孤儿 tool_result / 半截 tool 对),
 *      中间段一并折叠。
 *
 * 协议约束:保留区第一条必须是「无 tool_result 的 user 消息」(轮起点),因此切点
 * 只能是轮起点或 assistant 消息;绝不从 tool_result 消息开始保留。
 */
export function planCompactFold(
  conversation: unknown[],
  keepRecentTurns: number,
  budget: number,
  aggressive: boolean
): CompactFoldPlan | undefined {
  const turns = Math.max(1, Math.floor(keepRecentTurns));
  const starts: number[] = [];
  for (let i = 0; i < conversation.length; i += 1) {
    if (isNewUserTurnStart(conversation[i])) {
      starts.push(i);
    }
  }
  if (starts.length === 0 || (!aggressive && starts.length < turns)) {
    return undefined;
  }

  if (!aggressive) {
    const boundary = starts[starts.length - turns];
    if (!(boundary > 0)) {
      return undefined;
    }
    return buildPrefixPlan(conversation, boundary);
  }

  const messageTokens = conversation.map((message) => tokenize([message]));
  const suffixTokens = new Array<number>(conversation.length + 1).fill(0);
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    suffixTokens[i] = suffixTokens[i + 1] + (messageTokens[i] ?? 0);
  }

  if (budget <= 0) {
    // 受保护 system 已超预算:退回旧的「保留最近 N 轮」,不做预算填充。
    return buildPrefixPlan(conversation, starts[starts.length - Math.min(turns, starts.length)]);
  }

  // 在「每个人类轮起点」上尝试:整轮保留(suffix ≤ budget),或保留该轮起点消息 +
  // 轮内某个 assistant 之后的后缀(不跨过下一个轮起点,保证上下文连续)。
  // 取 kept token 最大的方案(≤budget 优先),从而把预算填满、保留最多最近上下文。
  let bestFit: PartialTurnPlan | undefined;
  let bestFallback: PartialTurnPlan | undefined;
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const startTokens = messageTokens[start] ?? 0;
    const nextStart = index + 1 < starts.length ? starts[index + 1] : conversation.length;
    const candidate = (cut: number): PartialTurnPlan => ({
      cut,
      keptTokens: cut === start ? suffixTokens[start] : startTokens + suffixTokens[cut],
      start
    });
    const consider = (plan: PartialTurnPlan) => {
      if (plan.start === 0 && plan.cut === plan.start) {
        return; // 无任何可折内容(整段都保留)
      }
      if (plan.keptTokens <= budget) {
        if (!bestFit || plan.keptTokens > bestFit.keptTokens) {
          bestFit = plan;
        }
      } else if (!bestFallback || plan.keptTokens < bestFallback.keptTokens) {
        // 预算太小、没有合法方案时,选择「保留最少」的方案(丢得最多,协议仍合法)。
        bestFallback = plan;
      }
    };

    if (suffixTokens[start] <= budget) {
      consider(candidate(start));
      continue;
    }
    // 该轮本身装不下:轮起点必须保留;在轮内找最早的 assistant 切点使总量 ≤ budget。
    let found: PartialTurnPlan | undefined;
    for (let cut = start + 1; cut < nextStart; cut += 1) {
      if (!isSafeKeptStart(conversation[cut])) {
        continue;
      }
      const plan = candidate(cut);
      if (plan.keptTokens <= budget) {
        found = plan;
        break;
      }
    }
    if (!found) {
      // 最小可行:保留轮起点 + 轮内最新的 assistant 后缀(可能略超预算)。
      for (let cut = nextStart - 1; cut > start; cut -= 1) {
        if (isSafeKeptStart(conversation[cut])) {
          found = candidate(cut);
          break;
        }
      }
    }
    if (found) {
      consider(found);
    }
  }

  const best = bestFit ?? bestFallback;
  if (!best) {
    return undefined;
  }
  if (best.cut === best.start) {
    return buildPrefixPlan(conversation, best.start);
  }
  return buildPartialTurnPlan(conversation, best.start, best.cut);
}

type PartialTurnPlan = { start: number; cut: number; keptTokens: number };

function buildPrefixPlan(conversation: unknown[], boundary: number): CompactFoldPlan | undefined {
  if (!(boundary > 0) || boundary >= conversation.length) {
    return undefined;
  }
  const folded = conversation.slice(0, boundary);
  const kept = conversation.slice(boundary);
  if (folded.length === 0 || kept.length === 0) {
    return undefined;
  }
  return { folded, kept, usedIntraTurn: false };
}

/**
 * 最后一轮自身超预算:保留轮起点消息 + 从某个 assistant 消息开始的后缀。
 * kept = [turnStart, ...conversation[cut..]],folded = 前缀 + (turnStart, cut) 中间段。
 */
function buildPartialTurnPlan(
  conversation: unknown[],
  turnStart: number,
  cut: number
): CompactFoldPlan | undefined {
  if (!(cut > turnStart) || cut >= conversation.length) {
    return undefined;
  }
  if (cut === turnStart + 1) {
    // 没有中间段可丢 → 等价于前缀折叠。
    return buildPrefixPlan(conversation, turnStart);
  }
  const folded: unknown[] = [];
  for (let i = 0; i < turnStart; i += 1) {
    folded.push(conversation[i]);
  }
  for (let i = turnStart + 1; i < cut; i += 1) {
    folded.push(conversation[i]);
  }
  const kept = [conversation[turnStart], ...conversation.slice(cut)];
  if (folded.length === 0 || kept.length === 0) {
    return undefined;
  }
  return { folded, kept, usedIntraTurn: true };
}

/**
 * 保留区切点:只能是 assistant 消息(其 tool_result 必然紧随其后、一起保留)
 * 或轮起点(单独处理)。绝不能从 user/tool_result 消息开始,否则会产生孤儿 tool_result。
 */
function isSafeKeptStart(message: unknown): boolean {
  return isRecord(message) && message.role === "assistant";
}

/**
 * 按「上一次摘要覆盖的消息 hash 多重集」重建 keep/fold。
 *   - 必须每条 stored hash 都能在当前会话里找到(逐条消费,支持重复内容);
 *   - 重建后 kept 的第一条不能是孤立 tool_result;
 *   - 返回的 usedIntraTurn 以最终集合是否「连续前缀」为准。
 * 任何一步不满足 → undefined(退回正常折叠/重摘,绝不冒险)。
 */
function reconstructDroppedSet(
  conversation: unknown[],
  storedHashes: string[]
): { folded: unknown[]; kept: unknown[]; usedIntraTurn: boolean } | undefined {
  if (!Array.isArray(storedHashes) || storedHashes.length === 0) {
    return undefined;
  }
  const wanted = new Map<string, number>();
  for (const hash of storedHashes) {
    wanted.set(hash, (wanted.get(hash) ?? 0) + 1);
  }
  const dropped = new Set<number>();
  for (let i = 0; i < conversation.length && wanted.size > 0; i += 1) {
    const hash = messageHash(conversation[i]);
    const remaining = wanted.get(hash);
    if (!remaining) {
      continue;
    }
    dropped.add(i);
    if (remaining === 1) {
      wanted.delete(hash);
    } else {
      wanted.set(hash, remaining - 1);
    }
  }
  if (wanted.size > 0 || dropped.size === 0) {
    return undefined;
  }
  const folded: unknown[] = [];
  const kept: unknown[] = [];
  for (let i = 0; i < conversation.length; i += 1) {
    (dropped.has(i) ? folded : kept).push(conversation[i]);
  }
  if (kept.length === 0 || isPureToolResultMessage(kept[0])) {
    return undefined;
  }
  let prefix = 0;
  while (prefix < conversation.length && dropped.has(prefix)) {
    prefix += 1;
  }
  return { folded, kept, usedIntraTurn: dropped.size !== prefix };
}

/** 纯 tool_result 消息(OpenAI: role=tool;Anthropic: user + 全部块都是 tool_result)。 */
function isPureToolResultMessage(message: unknown): boolean {
  if (!isRecord(message)) {
    return false;
  }
  if (message.role === "tool") {
    return true;
  }
  if (message.role !== "user" || !Array.isArray(message.content) || message.content.length === 0) {
    return false;
  }
  return message.content.every((block) => isRecord(block) && block.type === "tool_result");
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
  /** 生成摘要时未被折叠的会话消息条数(用于后续「增量是否够大」的判断)。 */
  keptCount: number;
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
    endpoints: input.target.endpoints,
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
        keptCount: input.keptCount,
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
  /** 按优先级排列的候选端点。第一个失败(5xx/HTML/非 JSON)时自动尝试下一个。 */
  endpoints: string[];
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
  if (!protocol) {
    return undefined;
  }
  const endpoints = resolveSummaryEndpoints(provider, protocol);
  if (endpoints.length === 0) {
    return undefined;
  }
  return { endpoints, model: upstreamModel, protocol, provider };
}

/**
 * 摘要端点候选。优先级:
 *   1. provider 已探测/声明的 capability endpoint(最准确,通常带 `/v1`);
 *   2. 从 baseUrl 推导的候选,带版本号的排前。
 *
 * 2026-11 事故:provider `api_base_url` 常写成 `https://host`(不带 `/v1`),
 * 旧实现直接取「不带版本」的候选 → 请求落到 `https://host/chat/completions`,
 * 上游 SPA 兜底页以 200 + text/html 返回,被当成摘要注入,历史上下文被网页替换。
 */
function resolveSummaryEndpoints(provider: GatewayProviderConfig, protocol: GatewayProviderProtocol): string[] {
  const endpoints: string[] = [];
  for (const capability of provider.capabilities ?? []) {
    if (
      isRecord(capability) &&
      capability.type === protocol &&
      typeof capability.endpoint === "string" &&
      capability.endpoint.trim()
    ) {
      endpoints.push(capability.endpoint.trim());
    }
  }

  const raw = providerBaseUrl(provider);
  if (raw) {
    const bases: string[] = [];
    try {
      const parsed = parseProviderBaseUrl(raw);
      const candidates = protocol === "anthropic_messages"
        ? parsed.anthropicBaseUrlCandidates
        : protocol === "openai_chat_completions" || protocol === "openai_responses"
          ? parsed.openaiBaseUrlCandidates
          : [];
      // 带版本号的候选排前:unversioned 命中 SPA 兜底页的概率更高。
      const versioned = candidates.filter((base) => /\/v\d+(?:$|\/)/i.test(base));
      const rest = candidates.filter((base) => !versioned.includes(base));
      bases.push(...versioned, ...rest);
    } catch {
      bases.push(raw);
    }
    if (bases.length === 0) {
      bases.push(raw);
    }
    for (const base of bases) {
      const endpoint = summaryEndpoint(base, protocol);
      if (endpoint) {
        endpoints.push(endpoint);
      }
    }
  }

  const seen = new Set<string>();
  return endpoints.filter((endpoint) => {
    if (seen.has(endpoint)) {
      return false;
    }
    seen.add(endpoint);
    return true;
  });
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
  endpoints: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  if (!input.model.trim() || input.endpoints.length === 0) {
    return undefined;
  }
  const apiKey = providerApiKey(input.provider);
  for (const endpoint of input.endpoints) {
    // 先试「关思考」。只有当 provider **拒绝**该字段(4xx)时才退回「原样请求」——
    //   若返回 200 但正文为空(reasoning 吃光预算),重试同样形状无意义,直接放弃该端点(与原行为一致)。
    const withDisable = await attemptSummary(
      { endpoint, protocol: input.protocol, timeoutMs: input.timeoutMs, signal: input.signal },
      buildSummaryRequest(input.protocol, input.model, input.prompt, apiKey, true)
    );
    if (withDisable.text !== undefined) {
      return withDisable.text;
    }
    if (withDisable.rejected) {
      const fallback = await attemptSummary(
        { endpoint, protocol: input.protocol, timeoutMs: input.timeoutMs, signal: input.signal },
        buildSummaryRequest(input.protocol, input.model, input.prompt, apiKey, false)
      );
      if (fallback.text !== undefined) {
        return fallback.text;
      }
    }
    // retryable(含 5xx / HTML / 非 JSON)→ 尝试下一个候选端点;否则本端点已给出确定结论。
    if (!withDisable.retryable) {
      return undefined;
    }
  }
  return undefined;
}

type SummaryAttempt = { text?: string; rejected: boolean; retryable: boolean };

/** 发一次摘要请求并提取助手文本。 */
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
      // 4xx = 请求体形状被拒,可换形状重试;5xx = 端点临时故障,换候选端点。
      return { rejected: response.status >= 400 && response.status < 500, retryable: response.status >= 500 };
    }
    const contentType = response.headers.get("content-type") ?? "";
    const rawText = await response.text();
    // 绝不把 HTML / 非 JSON 正文当摘要(上游 SPA 兜底页会说 200 + text/html)。
    if (!isUsableSummaryResponse(rawText, contentType)) {
      return { rejected: false, retryable: true };
    }
    const text = extractArchiveAssistantText(rawText, input.protocol, contentType);
    return { rejected: false, retryable: false, text: text.trim() ? text : undefined };
  } catch {
    return { rejected: false, retryable: true };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 摘要响应是否可用:必须是 JSON 或 SSE 的模型响应,不能是 HTML/XML 页面。
 * 导出以便单测。
 */
export function isUsableSummaryResponse(rawText: string, contentType?: string): boolean {
  const trimmed = (rawText ?? "").trim();
  if (!trimmed) {
    return false;
  }
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("text/html") || type.includes("application/xhtml")) {
    return false;
  }
  if (trimmed.startsWith("<")) {
    return false;
  }
  if (type.includes("text/event-stream") || /^event:|^data:/m.test(trimmed)) {
    return true;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
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
    aggressiveFolding: config.aggressiveFolding !== false,
    cacheTtlMs: num(config.proactiveCompactCacheTtlMs, 3 * 24 * 60 * 60 * 1000),
    ceilingTokens: Math.max(0, num(config.compactBudgetCeilingTokens, 120000)),
    floorTokens: Math.max(0, num(config.compactBudgetFloorTokens, 48000)),
    minFoldedTokens: Math.max(0, num(config.minFoldedTokens, 1024)),
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
  // 2026-11-08: 超长时保留**尾部**(折叠内容里最近的部分),而不是头部。
  // 旧实现从第 0 条开始累计,超过上限就停 —— 折叠 1774 条时摘要只能看到很早的历史,
  // 最近被折叠的内容(通常才是交接最需要的)反而被截掉。
  const lines: string[] = [];
  let total = 0;
  let truncatedFrom = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const role = isRecord(message) && typeof message.role === "string" ? message.role : "user";
    const text = stringifyContent(isRecord(message) ? message.content : message);
    const entry = `## [${i}] ${role}\n${text}`;
    if (total + entry.length > MAX_SUMMARY_TRANSCRIPT_CHARS) {
      if (lines.length === 0) {
        // 单条最新消息就超限:截断它本身,保证摘要至少能看到最近内容。
        const budget = Math.max(0, MAX_SUMMARY_TRANSCRIPT_CHARS - 200);
        lines.push(`## [${i}] ${role}\n${text.slice(0, budget)}\n... (message truncated at ${budget} chars)`);
      } else {
        truncatedFrom = i;
      }
      break;
    }
    total += entry.length;
    lines.push(entry);
  }
  const ordered = lines.reverse();
  if (truncatedFrom >= 0) {
    ordered.unshift(
      `## [0..${truncatedFrom}] ... (${truncatedFrom + 1} older messages omitted; transcript capped at ${MAX_SUMMARY_TRANSCRIPT_CHARS} chars, most recent kept)`
    );
  }
  return ordered.join("\n\n");
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
