/**
 * Helix Compressor — Claude Code Router Built-in Plugin（本地闭环）
 *
 * ⚠️ 基于 CCR 真实接口（musistudio/claude-code-router, @ccr/core v1）：
 *   - GatewayPluginRequestTransformHandler / Input / Result / Context
 *   - 文件位置：packages/core/src/plugins/built-ins/helix-compressor.ts
 *   - 在 packages/core/src/gateway/core-runtime/router-plugin.ts 里 import + 注册
 *
 * 全部压缩在本机进程内完成（`hc-local.ts` 的 compressV3x）:占位符替换后的原文落
 * 本地召回缓存({DATADIR}/helix-recall),由 recall response hook + MCP 工具兑现。
 * 云端 /v1/compress、LLM 质量评估、/v1/quality/feedback 上报已整体移除。
 *
 * 集成步骤见 docs/PLUGIN_INTEGRATION.md 附录 A
 */

import { randomUUID } from "node:crypto";
import { encode as gptEncode } from "gpt-tokenizer";
import type {
  GatewayPluginRequestTransformHandler,
  GatewayPluginRequestTransformResult,
  GatewayPluginResponseHookHandler,
  GatewayPluginResponseHookResult
} from "@ccr/core/plugins/service";
import { helixCompressorRecallToolName, helixCompressorMaxRecallPerRequest, helixCompressorLoopTimeoutMs } from "@ccr/core/gateway/core-runtime/router-plugin-contract";
import { compressV3x, type LocalCompressMessage } from "@ccr/core/plugins/built-ins/helix-compressor/hc-local";
import {
  putBatch as putRecallCacheBatch,
  batchGet as batchGetRecallCache,
  type RecallCacheEntry
} from "@ccr/core/observability/helix-recall-local-store";
import { HELIX_RECALL_DIR } from "@ccr/core/config/constants";
import type { AppConfig } from "@ccr/core/contracts/app";
import { HELIX_RECALL_MODEL_PREFIX } from "@ccr/core/contracts/app";

/**
 * helix 本地召回(recall)是否启用。
 *
 * 判定:helix-compressor 插件存在且未禁用。本地压缩把原文落本地 JSONL,
 * helix-recall MCP(hc_recall / history_recall)才有数据可召回。
 *
 * gateway 侧(透明工具执行)与客户端侧(Claude Code MCP 注入)共用同一判据,避免两处漂移。
 */
export function helixLocalRecallEnabled(config: AppConfig | undefined): boolean {
  const helixPlugin = (config?.plugins ?? []).find((plugin) => plugin.id === "helix-compressor");
  return Boolean(helixPlugin && helixPlugin.enabled !== false);
}

/**
 * glob → 正则:仅 `*` 是通配符(任意串),其余字符全部转义。大小写不敏感。
 * 例:`MiniMax-*` → /^MiniMax-.*$/i;`MiniMax-M3` → /^MiniMax\-M3$/i(等价精确匹配)。
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? "\u0000" : `\\${ch}`));
  const body = escaped.split("\u0000").join(".*");
  return new RegExp(`^${body}$`, "i");
}

/** 模型名对单条 glob 是否命中:匹配完整名,也匹配最后一个 `/` 之后的段(剥 provider 前缀)。 */
function modelMatchesGlob(model: string, pattern: string): boolean {
  const re = globToRegExp(pattern);
  if (re.test(model)) {
    return true;
  }
  const lastSlash = model.lastIndexOf("/");
  return lastSlash >= 0 && re.test(model.slice(lastSlash + 1));
}

/**
 * 模型是否支持本地 recall 压缩(⟦QA:⟧/⟦HC:⟧ 占位符 + 落缓存 + model 改写)。
 *
 * - `recallModelPatterns` 为空/未配 → true(所有模型都支持,向后兼容)。
 * - 命中任一 include 且**不**命中任一 exclude → true;否则 false。
 * - 未命中的模型跳过占位符压缩(不产生不可还原的 ⟦QA:⟧),后续只走主动 compact。
 *
 * 与 `helixLocalRecallEnabled`(全局总开关)正交:本判据只在本地压缩路径的模型维度收窄。
 */
export function recallModelSupported(model: string, config: HelixCompressorConfig): boolean {
  const patterns = config.recallModelPatterns ?? [];
  const excludes = config.recallModelExcludePatterns ?? [];
  const name = typeof model === "string" ? model.trim() : "";
  // 空白名单语义:
  //   - 未检测(recallModelDetected !== true):空 = 全部纳入(向后兼容);
  //   - 已检测(recallModelDetected === true):空 = 真的没有模型支持,不回退「全部」。
  const included = patterns.length === 0
    ? config.recallModelDetected !== true
    : (name.length > 0
      && patterns.some((pattern) => typeof pattern === "string" && pattern.length > 0 && modelMatchesGlob(name, pattern)));
  if (!included) {
    return false;
  }
  // exclude 在 include 之后收窄(空白名单 + 非空 exclude = 全部支持但排除命中项)。
  return !(name.length > 0
    && excludes.some((pattern) => typeof pattern === "string" && pattern.length > 0 && modelMatchesGlob(name, pattern)));
}

// ============= 类型定义 =============

/**
 * Helix Compressor 用户配置（写在 CCR AppConfig.plugins[].config）
 */
export interface HelixCompressorConfig {
  /**
   * V3.2:是否在压缩时同时存原 media bytes(image / video / doc / audio)
   * 默认 false —— A 文本已包含 LLM 对媒体的文字描述,占位符召回 q+a 文本即可
   * 设 true —— 把 Q 里的原 media 块也存进 cache,recall with_media=true 才能取回
   */
  storeWithMedia?: boolean;
  /**
   * V3.2 严格压缩:保留最新 K 对 Q&A verbatim
   * 默认 1 —— 只最新提交的图片必看,anchor + 历史全部 ⟦QA:⟧ 占位符
   * 设 0 —— 全部压缩(当前问题必看的图片也跟着隐藏,LLM 看不到当前图)
   * 设 2+ —— 较宽松,2 对 Q&A 不动(默认旧行为)
   */
  keepRecentPairs?: number;
  /**
   * V3.3 block 级压缩阈值(字符):任意 role 的 text 块 ≥ 该阈值即纳入压缩候选
   * 默认 0 = 关闭(向后兼容);200 是实测推荐的甜区
   * 设为 0 走原 V3.2 Q&A pair 压缩,>0 额外压缩任意 role 的大文本块
   */
  blockThresholdChars?: number;
  /**
   * V3.4 媒体块压缩开关(默认 true):image/image_url/document/video/audio 块有即压,
   * 独立于 `blockThresholdChars`(threshold 只管文本块)。
   * 被压的媒体块落本地缓存,`history_recall with_media=true` 可召回原图。
   * 设 false = 完全不压媒体块。
   */
  compressMedia?: boolean;
  /**
   * V1.12 tool_result 压缩开关(默认 true):工具输出 ≥ `toolResultThresholdChars` 即压成
   * ⟦QA:hash⟧(保留 tool_use_id 与原 block,只换 content)。独立于 `blockThresholdChars`。
   * 真实 agent 会话的主要节省来源(实测工具输出占 body 53%)。设 false = 完全不压。
   */
  compressToolResults?: boolean;
  /** tool_result 输出 ≥ 该字符数才压(默认 1000)。 */
  toolResultThresholdChars?: number;
  /** 最近 N 条 tool_result 永不压缩(默认 2)。 */
  keepRecentToolResults?: number;
  /** 单请求 tool_result 压缩条数上限(默认 20)。 */
  maxCompressToolResults?: number;
  /**
   * 主动 compact(2026-10-15):helix 压缩后提交 token 数 > 该预算时,网关折叠更早历史
   * 成一个摘要再转发(只保留最近 `keepRecentTurns` 个新用户轮原文)。默认 100000。
   * 设 0 = 关闭主动 compact。
   */
  tokenBudget?: number;
  /** 主动 compact 时保留最近 N 个「新用户轮」原文(默认 2)。 */
  keepRecentTurns?: number;
  /** 主动 compact 摘要调用超时(ms,默认 60000)。 */
  proactiveCompactTimeoutMs?: number;
  /** 主动 compact 摘要模型覆盖(默认空 = 用当前路由模型)。 */
  proactiveCompactModel?: string;
  /** 主动 compact 摘要缓存 TTL(ms,默认 3 天)。 */
  proactiveCompactCacheTtlMs?: number;
  /**
   * 主动 compact「积攒」阈值(默认 100):已有前缀摘要时,只有当**未覆盖的新历史**
   * 条数 ≥ 该值才重新(增量)摘要;否则复用旧摘要、中间段留原文(零上游调用)。
   * 设 0 = 关闭积攒(每轮边界变化都重摘)。
   */
  proactiveCompactMinNewMessages?: number;
  /**
   * recall 支持模型的 glob 白名单(2026-10-16):只有命中的模型才做本地 recall 占位符
   * 压缩(⟦QA:⟧/⟦HC:⟧ + 落召回缓存 + model 改写成 ccr-helix-recall/<model>)。
   * 未命中的模型跳过占位符压缩,只保留安全预清理,后续仅走主动 compact。
   *
   * - `*` 是唯一通配符(任意串);无 `*` 的模式即精确匹配。大小写不敏感。
   * - 匹配对象是真实模型名(如 `MiniMax-M3` 或 `MiniMax (China) 2/MiniMax-M3`):
   *   同时匹配完整名与最后一个 `/` 之后的段,兼容 provider 前缀差异。
   * - **空/未配 → 所有模型都支持**(向后兼容,行为不变)。
   */
  recallModelPatterns?: string[];
  /**
   * recall 白名单的排除表(2026-10-16):即使命中 `recallModelPatterns` 也不做 recall 压缩。
   * 空/未配 → 不排除。匹配规则同 `recallModelPatterns`。
   */
  recallModelExcludePatterns?: string[];
  /**
   * recall 白名单是否来自「自动检测」(2026-10-16):自动探测模型 tool-calling 能力后写白名单时置 true。
   * 置 true 后 `recallModelPatterns` 为空 = **真的没有模型支持**(不再回退「空=全部」),
   * 避免「检测出 0 个支持」被误当成「未配置 → 全部支持」。默认 false(未检测,空=全部,向后兼容)。
   */
  recallModelDetected?: boolean;
  /**
   * 主动 compact 预算按上下文长度百分比驱动(2026-10-16):
   * `budget = min(ceiling, max(floor, floor(有效上下文长度 × percent/100)))`。
   * 0/未设 = 关闭 percent 路径,回退绝对 `tokenBudget`(向后兼容)。
   */
  compactBudgetPercent?: number;
  /** percent 预算下限(默认 48000)。 */
  compactBudgetFloorTokens?: number;
  /** percent 预算上限 / 硬顶(默认 120000)。 */
  compactBudgetCeilingTokens?: number;
  /** 按真实 model 名覆盖 percent(优先于全局 `compactBudgetPercent`)。 */
  compactBudgetPercentOverrides?: Record<string, number>;
}

/**
 * LLM 消息（OpenAI Chat Completions 格式）
 */
type LLMMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string }>;
};

/**
 * 压缩结果(本地 compressV3x 产出)
 */
interface CompressResponse {
  compressed: LLMMessage[];
  scenario?: string;
  stats?: {
    originalChars: number;
    compressedChars: number;
    ratio: number;
    compressedCount: number;
    duration_ms?: number;
  };
}

// ============= 默认配置 =============

export const HELIX_COMPRESSOR_DEFAULTS: HelixCompressorConfig = {
  compressMedia: true,
  compressToolResults: true,
  toolResultThresholdChars: 1000,
  keepRecentToolResults: 2,
  // 真实 agent 会话单请求可达 600+ 条 tool_result(实测某请求 662 条、278 条超阈值)。
  // 旧默认 20 导致 95% 的超阈值工具输出原样明文发给上游(663k 字符仅压 20 条)。
  // 放宽到 200 覆盖真实历史;真正的预算兜底是"压缩后超预算 → 主动 compact"。
  maxCompressToolResults: 200,
  keepRecentTurns: 2,
  proactiveCompactCacheTtlMs: 259200000,
  proactiveCompactMinNewMessages: 100,
  proactiveCompactModel: "",
  proactiveCompactTimeoutMs: 60000,
  tokenBudget: 100000,
  recallModelPatterns: [],
  recallModelExcludePatterns: [],
  recallModelDetected: false,
  compactBudgetPercent: 0,
  compactBudgetFloorTokens: 48000,
  compactBudgetCeilingTokens: 120000,
  compactBudgetPercentOverrides: {}
};

// ============= Plugin Key 常量（用于 CCR 注册） =============

export const helixCompressorRequestTransformKey = "helix-compressor-request-transform";
export const helixCompressorModelHeader = "x-helix-compressor-model";
export const helixCompressorRatioHeader = "x-helix-compressor-ratio";
export const helixCompressorRequestIdHeader = "x-helix-compressor-request-id";
// v1.1：日志压缩量列 — 让 request_logs.response_headers 自动带上"压缩了多少"
export const helixCompressorInputCharsHeader = "x-helix-compressor-input-chars";
// V3.2: Q&A pair 压缩占位符数(⟦QA:hash⟧ 出现次数)
export const helixCompressorQACompressedHeader = "x-helix-compressor-qa-compressed";
export const helixCompressorOutputCharsHeader = "x-helix-compressor-output-chars";
export const helixCompressorHashCountHeader = "x-helix-compressor-hash-count";
export const helixCompressorScenarioHeader = "x-helix-compressor-scenario";
export const helixCompressorEnabledHeader = "x-helix-compressor-enabled";
// v1.3：端到端压缩率 — 估算原始 messages 的 tokens(baseline),
//   UI 拿到真实 inputTokens 后算 e2e_saved = baseline - inputTokens(扣 cache 后)。
export const helixCompressorBaselineTokensHeader = "x-helix-compressor-baseline-tokens";
// v1.5：压缩后 messages 的 tokens(真 tokenizer 算)—— UI 用来显示 "~X→Y tok" 全 token 视图
export const helixCompressorCompressedTokensHeader = "x-helix-compressor-compressed-tokens";
// v1.6：ccr 实际提交给 LLM 的 messages token 数(= 压缩后)。request_logs 的
//   compression_submitted_tokens 列由 DB trigger(request_logs_compression_extract/_update)
//   从 request_headers 的此 key 解析,插件不 emit 则该列永远为 0。
export const helixCompressorSubmittedTokensHeader = "x-helix-compressor-submitted-tokens";

// ============= 主 Transform =============

/**
 * Helix Compressor Request Transform
 *
 * 适配 CCR 真实接口（GatewayPluginRequestTransformHandler）：
 *   - input.body: Record<string, unknown>  (从 body 提取 messages 和 model)
 *   - input.headers: Record<string, string>
 *   - input.requestId: string
 *   - input.routedModel?: string
 *   - context.pluginConfig: 用户配置
 *
 * 流程：
 *   1. 安全预清理(空消息/skills 索引)
 *   2. 命中 recall 白名单 → 本地 compressV3x 压缩并落本地召回缓存;
 *      未命中 → 原样透传(scenario=skip-recall)
 *   3. 返回替换 messages 的 body
 *
 * 失败处理：compress 失败返回 undefined（CCR 跳过该 transform，原 body 不变）
 */
export const helixCompressorTransform: GatewayPluginRequestTransformHandler = async (
  input,
  context
): Promise<GatewayPluginRequestTransformResult | undefined> => {
  const config = parseConfig(context.pluginConfig);

  // 提取 messages 和 model
  const body = input.body;
  if (!isRecord(body)) return undefined;

  let messages = body.messages as LLMMessage[];
  const model = (typeof input.routedModel === "string" ? input.routedModel : undefined)
    ?? (typeof body.model === "string" ? body.model : undefined);

  if (!Array.isArray(messages) || typeof model !== "string") return undefined;

  // 归一化 request_id：Fastify 默认 req.id 是 "req-<letter>"，太短无法用于日志关联；
  // 客户端若有完整 ID（>=8 字符）就用它，否则用 randomUUID()。
  const upstreamRequestId = input.requestId && input.requestId.length >= 8
    ? input.requestId
    : randomUUID();

  // PR-1: 客户端 preprocess（删空消息 + task-notif 死信）
  // CCR_HELIX_PREPROCESS=off 时跳过,行为与之前一致
  const preprocessEnabled = process.env.CCR_HELIX_PREPROCESS !== "off";
  if (preprocessEnabled) {
    messages = clientPreprocess(messages);
  }

  // PR-2: 客户端 skills reminder 压缩索引（仅当本会话未调 Skill tool 时）
  // CCR_HELIX_SKILLS_COMPACT=off 时跳过
  const skillsCompactEnabled = process.env.CCR_HELIX_SKILLS_COMPACT !== "off";
  if (skillsCompactEnabled) {
    messages = clientCompactSkills(messages);
  }

  // 1. 本地压缩:只有命中 recall 白名单的模型才做占位符压缩,否则原样透传。
  let compressed: CompressResponse;
  // 按模型门控 recall(2026-10-16):只有命中 recall 白名单的模型才做本地占位符压缩。
  //   未命中的模型 → 跳过 compressV3x(不产 ⟦QA:⟧/⟦HC:⟧、不落召回缓存、model 不改写),
  //   仅保留上面的安全预清理,后续只走主动 compact。空白名单 = 支持全部(向后兼容)。
  const recallSupported = recallModelSupported(model, config);
  if (recallSupported) {
    // 本地确定性 V3.x:移植自 helix-compressor/src/compress/hc.js,与其逐字节 parity。
    // 被替换的原文写入本地召回缓存(供 hc_recall/history_recall 工具读取)。
    try {
      const local = compressV3x(messages as LocalCompressMessage[], {
        keepRecentPairs: config.keepRecentPairs ?? 1,
        storeMedia: config.storeWithMedia === true,
        blockThresholdChars: config.blockThresholdChars ?? 0,
        compressMedia: config.compressMedia !== false,
        compressToolResults: config.compressToolResults !== false,
        toolResultThresholdChars: config.toolResultThresholdChars,
        keepRecentToolResults: config.keepRecentToolResults,
        maxCompressToolResults: config.maxCompressToolResults
      });
      const cacheEntries = Object.entries(local.hashMap);
      if (cacheEntries.length > 0) {
        try {
          // 缓存目录默认 {DATADIR}/helix-recall;若外部已通过环境变量指定则由 store 读取该值。
          ensureLocalRecallCacheDir();
          putRecallCacheBatch(cacheEntries as Array<[string, RecallCacheEntry]>);
        } catch (cacheErr) {
          context.logger.warn(`[helix-compressor] local cache write failed: ${(cacheErr as Error).message}`);
        }
      }
      compressed = {
        compressed: local.messages as unknown as LLMMessage[],
        scenario: "local",
        stats: {
          originalChars: countChars(messages),
          compressedChars: countChars(local.messages as unknown as LLMMessage[]),
          ratio: local.stats.ratio,
          compressedCount: local.stats.compressedCount
        }
      };
    } catch (err) {
      context.logger.warn(`[helix-compressor] local compress failed: ${(err as Error).message}, skip`);
      return undefined;
    }
  } else {
    // 模型不在 recall 白名单:跳过本地占位符压缩,原样透传(预清理后的)messages。
    //   不产生 ⟦QA:⟧/⟦HC:⟧ → hasHC/hasQA 恒 false → model 不改写 → 不命中 recall profile。
    //   scenario="skip-recall" 便于 UI/日志区分该请求未做 recall 压缩。
    compressed = {
      compressed: messages,
      scenario: "skip-recall",
      stats: {
        originalChars: countChars(messages),
        compressedChars: countChars(messages),
        ratio: 0,
        compressedCount: 0
      }
    };
  }

  // 2. 返回替换 messages 的 body
  let outputMessages = compressed.compressed as LLMMessage[];
  const outputBody: Record<string, unknown> = {
    ...body,
    messages: outputMessages
  };

  const hasHC = hasHCPlaceholder(outputMessages);
  const hasQA = hasQAPlaceholder(outputMessages);

  // helix V1.11 / 2026-10-15: 不再注入**裸** recall 工具。
  //   旧做法往 body.tools push `history_recall` / `hc_recall`,它与客户端已注入的
  //   MCP 命名空间工具(`mcp__ccr-helix-recall__history_recall`)或网关 virtualModel
  //   profile 的 internal 工具同名 → 网关 buildVirtualTooling 直接 400
  //   (`Client tool "history_recall" conflicts with virtual model tool.`)。
  //   改为:只要 body 里仍有可召回占位符,就把 model 改写成 `ccr-helix-recall/<真 model>`,
  //   网关据此命中 helix virtualModelProfile → internal tool 循环(支持流式)兑现 recall。
  //   无占位符 → 不改写 → 不命中 profile → 保持原 live 直通(零 TTFB 回归,对齐 headroom #3071)。
  const recallNeeded = (hasHC || hasQA) && model.length > 0;
  const routedModel = recallNeeded ? `${HELIX_RECALL_MODEL_PREFIX}${model}` : undefined;

  // 教学 prompt:告诉模型占位符的含义与何时调用 recall 工具。
  //   工具定义本身由 profile 提供(见 config-compiler 的 helixRecallVirtualModelProfile),
  //   这里只负责 prompt 侧的"何时调/怎么调"。两个 marker 段独立 prepend,互不覆盖。
  if (hasHC) {
    outputMessages = injectRecallInstruction(outputMessages);
    outputBody.messages = outputMessages;
  }
  if (hasQA) {
    outputMessages = injectHistoryRecallInstruction(outputMessages);
    outputBody.messages = outputMessages;
  }

  return {
    ...(routedModel ? { routedModel } : {}),
    body: outputBody,
    headers: {
      [helixCompressorRequestIdHeader]: upstreamRequestId,
      [helixCompressorModelHeader]: model,
      [helixCompressorRatioHeader]: String(compressed.stats?.ratio ?? 0),
      [helixCompressorInputCharsHeader]: String(compressed.stats?.originalChars ?? 0),
      [helixCompressorQACompressedHeader]: String(compressed.stats?.compressedCount ?? 0),
      // v1.3: output_chars 改写为"最终消息的实际 chars"(发给 LLM 的),
      //   而不是 helix 返回的 compressedChars(那是"省了多少",短消息时是 0)。
      //   这样 UI 看到 input=output 时知道是 pass-through,看到 input>output 时知道真的压了。
      [helixCompressorOutputCharsHeader]: String(countChars(outputMessages)),
      [helixCompressorHashCountHeader]: String(compressed.stats?.compressedCount ?? 0),
      [helixCompressorScenarioHeader]: compressed.scenario ?? "",
      [helixCompressorEnabledHeader]: "1",
      // v1.4: 端到端 baseline = 原始 messages 用 gpt-tokenizer(cl100k_base)真实 token 化。
      //   UI 拿真实 inputTokens 后能对比。注意:这只算 user messages 字段,
      //   system/tool/cache 不在 baseline 里(那些本来也不被压缩)。
      [helixCompressorBaselineTokensHeader]: String(tokenizeMessages(messages)),
      // v1.5: 压缩后 messages 的 token 数。UI 显示 "X→Y tok (Z%)" 时用,
      //   全 token 视图避免 chars/tokens 混用的歧义。
      [helixCompressorCompressedTokensHeader]: String(tokenizeMessages(outputMessages)),
      // v1.6: ccr 实际提交给 LLM 的 token 数(= 压缩后 body)。DB trigger 读这个 key
      //   填 request_logs.compression_submitted_tokens,不 emit 则 s 列恒为 0。
      [helixCompressorSubmittedTokensHeader]: String(tokenizeMessages(outputMessages))
    },
    responseHeaders: {
      [helixCompressorRequestIdHeader]: upstreamRequestId,
      [helixCompressorInputCharsHeader]: String(compressed.stats?.originalChars ?? 0),
      [helixCompressorQACompressedHeader]: String(compressed.stats?.compressedCount ?? 0),
      [helixCompressorOutputCharsHeader]: String(countChars(outputMessages)),
      [helixCompressorHashCountHeader]: String(compressed.stats?.compressedCount ?? 0),
      [helixCompressorScenarioHeader]: compressed.scenario ?? "",
      [helixCompressorRatioHeader]: String(compressed.stats?.ratio ?? 0),
      [helixCompressorEnabledHeader]: "1",
      [helixCompressorBaselineTokensHeader]: String(tokenizeMessages(messages)),
      [helixCompressorCompressedTokensHeader]: String(tokenizeMessages(outputMessages)),
      [helixCompressorSubmittedTokensHeader]: String(tokenizeMessages(outputMessages))
    }
  };
};

// ============= 辅助函数 =============

function parseConfig(value: unknown): HelixCompressorConfig {
  if (!isRecord(value)) return HELIX_COMPRESSOR_DEFAULTS;
  return {
    ...HELIX_COMPRESSOR_DEFAULTS,
    ...(typeof value.storeWithMedia === "boolean" ? { storeWithMedia: value.storeWithMedia } : {}),
    ...(typeof value.keepRecentPairs === "number" ? { keepRecentPairs: value.keepRecentPairs } : {}),
    ...(typeof value.blockThresholdChars === "number" ? { blockThresholdChars: value.blockThresholdChars } : {}),
    ...(typeof value.compressMedia === "boolean" ? { compressMedia: value.compressMedia } : {}),
    ...(typeof value.compressToolResults === "boolean" ? { compressToolResults: value.compressToolResults } : {}),
    ...(typeof value.toolResultThresholdChars === "number" ? { toolResultThresholdChars: value.toolResultThresholdChars } : {}),
    ...(typeof value.keepRecentToolResults === "number" ? { keepRecentToolResults: value.keepRecentToolResults } : {}),
    ...(typeof value.maxCompressToolResults === "number" ? { maxCompressToolResults: value.maxCompressToolResults } : {}),
    ...(typeof value.tokenBudget === "number" ? { tokenBudget: value.tokenBudget } : {}),
    ...(typeof value.keepRecentTurns === "number" ? { keepRecentTurns: value.keepRecentTurns } : {}),
    ...(typeof value.proactiveCompactTimeoutMs === "number" ? { proactiveCompactTimeoutMs: value.proactiveCompactTimeoutMs } : {}),
    ...(typeof value.proactiveCompactModel === "string" ? { proactiveCompactModel: value.proactiveCompactModel } : {}),
    ...(typeof value.proactiveCompactCacheTtlMs === "number" ? { proactiveCompactCacheTtlMs: value.proactiveCompactCacheTtlMs } : {}),
    ...(typeof value.proactiveCompactMinNewMessages === "number" ? { proactiveCompactMinNewMessages: value.proactiveCompactMinNewMessages } : {}),
    ...(Array.isArray(value.recallModelPatterns)
      ? { recallModelPatterns: value.recallModelPatterns.filter((p): p is string => typeof p === "string") }
      : {}),
    ...(Array.isArray(value.recallModelExcludePatterns)
      ? { recallModelExcludePatterns: value.recallModelExcludePatterns.filter((p): p is string => typeof p === "string") }
      : {}),
    ...(typeof value.recallModelDetected === "boolean" ? { recallModelDetected: value.recallModelDetected } : {}),
    ...(typeof value.compactBudgetPercent === "number" ? { compactBudgetPercent: value.compactBudgetPercent } : {}),
    ...(typeof value.compactBudgetFloorTokens === "number" ? { compactBudgetFloorTokens: value.compactBudgetFloorTokens } : {}),
    ...(typeof value.compactBudgetCeilingTokens === "number" ? { compactBudgetCeilingTokens: value.compactBudgetCeilingTokens } : {}),
    ...(isRecord(value.compactBudgetPercentOverrides)
      ? {
          compactBudgetPercentOverrides: Object.fromEntries(
            Object.entries(value.compactBudgetPercentOverrides as Record<string, unknown>)
              .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
          )
        }
      : {})
  };
}

function countChars(messages: LLMMessage[]): number {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce<number>((total, msg) => {
    const content = msg.content;
    if (typeof content === "string") {
      return total + content.length;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "string") {
          return total + (block as string).length;
        }
        if (block && typeof block === "object") {
          const text = (block as { text?: unknown }).text;
          if (typeof text === "string") {
            return total + text.length;
          }
        }
      }
    }
    return total;
  }, 0);
}

/**
 * 用 gpt-tokenizer(cl100k_base)真实 token 化原始 messages。
 * 比 chars/3 估算准很多——实测 1 token ≈ 4-5 chars,messages 字段可能更密(role/JSON)。
 * 注意:这是 OpenAI tokenizer 估算,Anthropic tokenizer 会略有差异(±5%)。
 * 返回值写进 x-helix-compressor-baseline-tokens,UI 用它和真实 inputTokens 对比。
 */
function tokenizeMessages(messages: LLMMessage[]): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  // 用 messages 的 JSON 表示做 token 化(更接近实际 LLM 看到的格式)
  try {
    const serialized = JSON.stringify(messages);
    return gptEncode(serialized).length;
  } catch {
    // fallback:chars 估算
    return Math.round((countChars(messages) / 3) * 1.05);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ============= hc_recall Tool Schema（Recall 能力）=============

export const HC_RECALL_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: helixCompressorRecallToolName,
    description:
      "Recall the original content of a HC-compressed block. " +
      "When you see ⟦HC:hash⟧ placeholders (hex hash) in the conversation, " +
      "call this tool with the hash_id to get the full original text. " +
      "Only call when you genuinely need the original content to answer accurately. " +
      "Do NOT call repeatedly — there's a per-request budget.",
    parameters: {
      type: "object",
      properties: {
        hash_id: {
          type: "string",
          pattern: "^[0-9a-f]+$",
          description: "Hex hash from the ⟦HC:hash⟧ placeholder (without prefix and suffix)"
        },
        reason: {
          type: "string",
          description: "Brief reason why you need to recall (for audit logging)"
        }
      },
      required: ["hash_id"],
      additionalProperties: false
    }
  }
} as const;

// Anthropic 协议版本: 字段名从 parameters 改为 input_schema,顶层去 type/function 包裹
export const HC_RECALL_TOOL_SCHEMA_ANTHROPIC = {
  name: helixCompressorRecallToolName,
  description:
    "Recall the original content of a HC-compressed block. " +
    "When you see ⟦HC:hash⟧ placeholders (hex hash) in the conversation, " +
    "call this tool with the hash_id to get the full original text. " +
    "Only call when you genuinely need the original content to answer accurately. " +
    "Do NOT call repeatedly — there's a per-request budget.",
  input_schema: {
    type: "object",
    properties: {
      hash_id: {
        type: "string",
        pattern: "^[0-9a-f]+$",
        description: "Hex hash from the ⟦HC:hash⟧ placeholder (without prefix and suffix)"
      },
      reason: {
        type: "string",
        description: "Brief reason why you need to recall (for audit logging)"
      }
    },
    required: ["hash_id"],
    additionalProperties: false
  }
} as const;

const HC_RECALL_INSTRUCTION_MARKER = "<<HC_RECALL_INSTRUCTION_v1>>";

const HC_RECALL_INSTRUCTION = `${HC_RECALL_INSTRUCTION_MARKER}
## 工具调用: ${helixCompressorRecallToolName}

你会在对话中看到形如 ⟦HC:hash⟧ 的占位符（hash 为十六进制字符串）。
这些占位符代表被压缩缓存的**原始内容**（工具结果、长文件、长 RAG chunk 等）。

**规则**：
1. 当你需要被压缩的**原文细节**来准确回答（例如：关键代码、文件路径、数字、工具返回 JSON），
   立即调用 \`${helixCompressorRecallToolName}\` 工具，参数 hash_id 取占位符中的 hash（不含 ⟦HC:⟧ 前缀和 ⟧ 后缀）。
2. **不要**把 ⟦HC:hash⟧ 当作完整信息处理（那只是压缩后的极简摘要，信息可能不全）。
3. **不要**反复调同一个 hash_id（有 per-request 上限 ${helixCompressorMaxRecallPerRequest} 次，多了就拒绝）。
4. **不要**为每个占位符都 recall — 只在你**真正需要原文**时调。
5. 你也可以直接基于已有的摘要信息作答，没必要全文 recall。

**示例**：
占位符：\`⟦HC:abcdef0123456789⟧\`
调用：${helixCompressorRecallToolName}(hash_id="abcdef0123456789", reason="need original file content")
`;

// hash_id 格式校验：8-128 位 hex
const HASH_PATTERN = /^[0-9a-f]{8,128}$/;

// ============= PR-1: 客户端 preprocess(空消息 + task-notif 死信) =============

/**
 * 提取消息文本(content 是 string / array 都支持)
 */
function extractMessageText(m: unknown): string {
  if (!isRecord(m)) return "";
  const c = (m as Record<string, unknown>).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((b: unknown) => {
      if (isRecord(b) && typeof (b as Record<string, unknown>).text === "string") {
        return (b as Record<string, unknown>).text as string;
      }
      return "";
    }).join("");
  }
  return "";
}

/**
 * 判定消息是否"事实上为空":
 * - content 是空字符串
 * - content 是空数组
 * - content 是 array 且"只有" text 块,且所有 text 块都空/缺失
 *   (实测本样本 98 条 assistant 是这种形态,光判 length===0 会漏)
 *
 * 注意: 含 tool_use / image / tool_result 等非 text 块的 content 不算空,
 *   因为这些块本身承载语义(工具调用、图片内容等)
 */
function isEffectivelyEmpty(m: unknown): boolean {
  if (!isRecord(m)) return false;
  const c = (m as Record<string, unknown>).content;
  if (c === "") return true;
  if (Array.isArray(c) && c.length === 0) return true;
  if (Array.isArray(c)) {
    // 提取所有 type==="text" 的块
    const textBlocks = c.filter((b: unknown) =>
      isRecord(b) && (b as Record<string, unknown>).type === "text"
    );
    // 如果没有任何 text 块但有其他块(tool_use/image/tool_result),不算空
    if (textBlocks.length === 0) return false;
    // 所有 text 块都空/缺失才算空
    return textBlocks.every((b: unknown) => {
      if (!isRecord(b)) return false;
      const t = (b as Record<string, unknown>).text;
      return !t || (typeof t === "string" && t.trim() === "");
    });
  }
  return false;
}

/**
 * 客户端 preprocess 钩子(Helix 不做的事)
 * - 删除已结束的 <task-notification> 死信
 * - 删除 assistant / user 事实上为空的消息
 * - 保留 file_modified 类 <system-reminder>(影响后续 Read 决策)
 * - 保留 cache_control 字段(Anthropic prompt caching)
 */
export function clientPreprocess(messages: LLMMessage[]): LLMMessage[] {
  return messages.filter((m) => {
    const text = extractMessageText(m);

    // A1: task-notification 死信
    // 实测本样本 7 条 task-notif 总 ~3.4 KB / ~850 tokens
    // 分布在 user 消息顶层,不是 tool_result 块内
    if (text.includes("<task-notification>") &&
        text.includes("<retrieval_status>success</retrieval_status>")) {
      return false;
    }

    // A2: 空消息
    // 实测本样本 124 user(content=""空串) + 98 assistant(content 是 [{...empty text...}])
    if (isEffectivelyEmpty(m)) return false;

    return true;
  });
}

// ============= PR-2: 客户端 skills reminder 压缩索引 =============

/**
 * 压缩后的 skills reminder 索引(原 27 KB → ~3 KB)
 * 当本会话未调用 Skill tool 时,把 123 个 skill 列表压成目录,
 * 真正需要时通过 Skill 工具调用(原文会展开)。
 */
const COMPRESSED_SKILLS_INDEX = `可用 skills (共 123) 分类索引:
- ai-drama / novel-* / ads-* / wigolo-* / yt-dlp / hypit / mmx-cli
- update-config / co-math-* / math-proof / life-decision-guide
- ego-browser / capture / executor / nuclei / mcp-builder
- gpt-image-2 / mmx-cli / awesome-gpt-image-api-proxy-skills
触发词匹配后用 Skill 工具调用(参数=name),无需完整列表。`;

/**
 * 客户端 skills reminder 压缩(仅当本会话未调 Skill tool 时)
 * 实测本样本 0 次 Skill 调用,skills reminder 26,686 字节 ≈ 6.7 K tokens;
 * 压缩索引 ~600 字节 ≈ 150 tokens,节省 ~6.5 K tokens。
 */
export function clientCompactSkills(messages: LLMMessage[]): LLMMessage[] {
  // 判定: 本会话是否调用过 Skill tool?
  const usedSkill = messages.some((m) =>
    Array.isArray(m.content) &&
    m.content.some((b: unknown) =>
      isRecord(b) && (b as Record<string, unknown>).type === "tool_use" &&
      (b as Record<string, unknown>).name === "Skill"
    )
  );
  if (usedSkill) return messages;

  // 替换 skills reminder 为压缩索引
  return messages.map((m): LLMMessage => {
    const text = extractMessageText(m);
    if (!text.includes("The following skills are available for use with the Skill tool")) {
      return m;
    }
    // 替换顶层文本;content 是 string 的直接换,array 的找 type=text 块换
    if (typeof m.content === "string") {
      return { ...m, content: COMPRESSED_SKILLS_INDEX };
    }
    if (Array.isArray(m.content)) {
      const newContent = m.content.map((b: unknown) => {
        if (!isRecord(b)) return b;
        const bRec = b as Record<string, unknown>;
        if (bRec.type === "text" && typeof bRec.text === "string" &&
            bRec.text.includes("The following skills are available for use with the Skill tool")) {
          return { ...bRec, text: COMPRESSED_SKILLS_INDEX };
        }
        return b;
      });
      return { ...m, content: newContent as LLMMessage["content"] };
    }
    return m;
  });
}

// ============= history_recall Tool Schema（V3.2 Q&A pair 召回）=============

export const HISTORY_RECALL_TOOL_NAME = "history_recall";

export const HISTORY_RECALL_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: HISTORY_RECALL_TOOL_NAME,
    description:
      "Recall a compressed Q&A pair from conversation history. " +
      "When you see ⟦QA:hash⟧ placeholders (16-char hex) in the conversation, " +
      "call this tool to get the original user question and assistant answer. " +
      "By default only the text content is returned; set with_media=true to include " +
      "the original image/video/document that was in the question. " +
      "Only call when you genuinely need the original content to answer accurately.",
    parameters: {
      type: "object",
      properties: {
        hash_id: {
          type: "string",
          pattern: "^[0-9a-f]{16}$",
          description: "Hex hash from the ⟦QA:hash⟧ placeholder (without prefix and suffix)"
        },
        with_media: {
          type: "boolean",
          default: false,
          description: "If true, include the original image/video/document that was in the user question. Default false (text-only, smaller)."
        },
        reason: {
          type: "string",
          description: "Brief reason why you need to recall (for audit logging)"
        }
      },
      required: ["hash_id"],
      additionalProperties: false
    }
  }
} as const;

// Anthropic 协议版本
export const HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC = {
  name: HISTORY_RECALL_TOOL_NAME,
  description:
    "Recall a compressed Q&A pair from conversation history. " +
    "When you see ⟦QA:hash⟧ placeholders (16-char hex) in the conversation, " +
    "call this tool to get the original user question and assistant answer. " +
    "By default only the text content is returned; set with_media=true to include " +
    "the original image/video/document that was in the question. " +
    "Only call when you genuinely need the original content to answer accurately.",
  input_schema: {
    type: "object",
    properties: {
      hash_id: {
        type: "string",
        pattern: "^[0-9a-f]{16}$",
        description: "Hex hash from the ⟦QA:hash⟧ placeholder (without prefix and suffix)"
      },
      with_media: {
        type: "boolean",
        default: false,
        description: "If true, include the original image/video/document that was in the user question. Default false (text-only, smaller)."
      },
      reason: {
        type: "string",
        description: "Brief reason why you need to recall (for audit logging)"
      }
    },
    required: ["hash_id"],
    additionalProperties: false
  }
} as const;

const HISTORY_RECALL_INSTRUCTION_MARKER = "<<HISTORY_RECALL_INSTRUCTION_v1>>";

const HISTORY_RECALL_INSTRUCTION = `${HISTORY_RECALL_INSTRUCTION_MARKER}
## ⚠️ 历史 Q&A 召回机制

对话中形如 \`⟦QA:abc123def4567890⟧\` 的标记是 **被压缩掉的历史内容**,可能是:
- **历史的 Q&A 对**(原用户问题 + 原助手回答),或
- **被折叠的工具输出**(旧的 tool_result,如超大文件读取 / 命令输出 —— 为省 token 已折叠成占位符)。

**这条占位符本身只携带"曾存在过"信号**,不含具体细节 —— 看 hash 名不会让你知道被压的是什么。

### 🎯 必须调用 \`${HISTORY_RECALL_TOOL_NAME}\` 的场景
1. 当前任务需要某个历史 Q&A 里的 **具体数字 / 名称 / 代码 / 原文片段**
2. 用户提问明确指向历史:"刚才/之前/我们前面聊过的 X 是什么"
3. 比较/引用:**"对比之前那张图"**、"**用前面那份 PDF** 里的某段"
4. 上下文依赖:**不调回历史内容,当前任务就无法正确完成**
5. 需要某段**已折叠的工具输出原文**(之前 Read/Bash/Grep 的完整结果被折叠成 ⟦QA:⟧ 了)

### ✅ 通常**不需要**调用的场景
- 只关心"我们讨论过 X"的方向感,不需要细节
- 答案能在上文 recent 段找到,不依赖压缩区

### 🔧 调用方法
- 占位符: \`⟦QA:abc123def4567890⟧\`
- \`hash_id\` = 中间 16 位 hex(去掉 \`⟦QA:\` 前缀和 \`⟧\` 后缀):**\`abc123def4567890\`**
- 默认 \`with_media=false\`,只返回 Q+A 文本 —— **A 已包含助手对图片/视频/文档内容的文字描述**,绝大多数情况已够用
- 仅当历史 Q 中含**图片**(image)且你需要**像素级细节**时,才设 \`with_media=true\` —— 此时会返回**可直接查看的原图**,你能真正看到它

### 调用示例
\`\`\`
${HISTORY_RECALL_TOOL_NAME}(hash_id="abc123def4567890", reason="需要前面那张图的细节")
${HISTORY_RECALL_TOOL_NAME}(hash_id="abc123def4567890", with_media=true, reason="对比新旧两份 PDF")
\`\`\`

### ⚠️ 禁止
- ❌ 把 \`⟦QA:hash⟧\` 当作完整信息处理 —— 它只是摘要标签
- ❌ 一次请求里为**所有**占位符都 recall —— 每请求有预算,浪费且无意义
- ❌ 同一 \`hash_id\` 反复调 —— 一次即可
`;

/** 检测 ⟦QA:hash⟧ 占位符(V3.2 Q&A pair 压缩) */
export function hasQAPlaceholder(messages: LLMMessage[]): boolean {
  if (!Array.isArray(messages)) return false;
  // 必须同时处理字符串 content 与**数组块** content —— 真实 Claude Code 的
  //   content 恒为 [{type:"text",text:"⟦QA:hash⟧"}] 数组形状,只检查字符串会永远漏检
  //   → history_recall 工具与教学 prompt 从不注入(与 hasHCPlaceholder 对齐)。
  for (const msg of messages) {
    if (!msg) continue;
    const content = msg.content;
    if (typeof content === "string" && content.includes("⟦QA:")) return true;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && typeof block.text === "string" && block.text.includes("⟦QA:")) {
          return true;
        }
      }
    }
  }
  return false;
}

/** 注入 history_recall 工具的教学 prompt(同 V2 injectRecallInstruction 模式 + marker 幂等) */
export function injectHistoryRecallInstruction(messages: LLMMessage[]): LLMMessage[] {
  // marker 去重:避免多轮压缩时 system message 不断 prepend 同一段 instruction。
  // V2 injectRecallInstruction 已用此模式,V3.2 历史版本漏了。
  for (const m of messages) {
    if (
      m?.role === "system" &&
      typeof m.content === "string" &&
      m.content.includes(HISTORY_RECALL_INSTRUCTION_MARKER)
    ) {
      return messages;
    }
  }
  const out: LLMMessage[] = [];
  let injected = false;
  for (const m of messages) {
    if (!injected && m?.role === "system" && typeof m.content === "string") {
      out.push({ ...m, content: HISTORY_RECALL_INSTRUCTION + "\n" + m.content });
      injected = true;
    } else if (!injected && m?.role !== "system") {
      out.push({ role: "system", content: HISTORY_RECALL_INSTRUCTION });
      out.push(m);
      injected = true;
    } else {
      out.push(m);
    }
  }
  if (!injected) {
    out.unshift({ role: "system", content: HISTORY_RECALL_INSTRUCTION });
  }
  return out;
}

export function hasHCPlaceholder(messages: LLMMessage[]): boolean {
  for (const msg of messages) {
    if (!msg) continue;
    const content = msg.content;
    if (typeof content === "string" && content.includes("⟦HC:")) return true;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && typeof block.text === "string" && block.text.includes("⟦HC:")) {
          return true;
        }
      }
    }
  }
  return false;
}

export function injectRecallInstruction(messages: LLMMessage[]): LLMMessage[] {
  // 检测是否已注入
  for (const m of messages) {
    if (m?.role === "system" && typeof m.content === "string" && m.content.includes(HC_RECALL_INSTRUCTION_MARKER)) {
      return messages;
    }
  }

  const newMessages: LLMMessage[] = [];
  let injected = false;
  for (const m of messages) {
    if (!injected && m?.role === "system" && typeof m.content === "string") {
      newMessages.push({ ...m, content: HC_RECALL_INSTRUCTION + "\n" + m.content });
      injected = true;
    } else if (!injected && m?.role !== "system") {
      newMessages.push({ role: "system", content: HC_RECALL_INSTRUCTION });
      newMessages.push(m);
      injected = true;
    } else {
      newMessages.push(m);
    }
  }
  return newMessages;
}

// ============= Response Hook =============

export const helixCompressorResponseHook: GatewayPluginResponseHookHandler = async (
  input,
  context
): Promise<GatewayPluginResponseHookResult> => {
  const response = input.responsePayload;

  if (!isRecord(response)) {
    return { continueLoop: false };
  }

  // 根据协议提取 tool calls(hc_recall V2 + history_recall V3.2)
  const hcCalls = input.protocol === "anthropic"
    ? extractAnthropicHcrecallCalls(response)
    : extractOpenAIHcrecallCalls(response);
  const historyCalls = input.protocol === "anthropic"
    ? extractAnthropicHistoryRecallCalls(response)
    : extractOpenAIHistoryRecallCalls(response);

  if (hcCalls.length === 0 && historyCalls.length === 0) {
    return { continueLoop: false };
  }

  // 校验 hash_id 格式 + 限流(V2 + V3.2)
  const QA_HASH_PATTERN = /^[0-9a-f]{16}$/;
  const validHcCalls = hcCalls
    .filter(c => HASH_PATTERN.test(c.hash_id))
    .slice(0, helixCompressorMaxRecallPerRequest);
  const validHistoryCalls = historyCalls
    .filter(c => QA_HASH_PATTERN.test(c.hash_id))
    .slice(0, helixCompressorMaxRecallPerRequest);

  if (validHcCalls.length === 0 && validHistoryCalls.length === 0) {
    context.logger.warn?.(`[helix-compressor] no valid recall calls after hash_id validation`);
    return { continueLoop: false };
  }

  // 并发批量召回(V2 hc_recall + V3.2 history_recall 各自调)
  // V3.2: history_recall 调用带 with_media,LLM 决定是否回原图
  const hcHashes = validHcCalls.map(c => c.hash_id);
  const [hcResults, historyResults] = await Promise.all([
    hcHashes.length > 0 ? fetchRecallBatch(hcHashes) : Promise.resolve([]),
    validHistoryCalls.length > 0 ? fetchHistoryRecallBatch(validHistoryCalls) : Promise.resolve([])
  ]);

  // 构造 tool result messages(V2 + V3.2 合并)
  const hcMessages = validHcCalls.map(call => {
    const result = hcResults.find(r => r.hash === call.hash_id);
    const originalContent = result?.original ?? null;
    const content = originalContent !== null
      ? originalContent
      : `[helix-compressor] hash not found or expired: ${call.hash_id}`;
    return makeToolResultMessage(input.protocol, call.tool_call_id, content, originalContent === null);
  });

  const historyMessages = validHistoryCalls.map(call => {
    const result = historyResults.find(r => r.hash === call.hash_id);
    if (!result || !result.pair) {
      return makeToolResultMessage(input.protocol, call.tool_call_id, `[helix-compressor] Q&A pair not found: ${call.hash_id}`, true);
    }
    // V3.2: history_recall 返回 q + a 两段;LLM 传 with_media=true 时附带 q_media(原图/原文档字节)
    const images = result.pair.qMedia ? normalizeMediaImages(result.pair.qMedia) : [];
    const textContent = JSON.stringify({
      q: result.pair.q,
      a: result.pair.a,
      ...(result.pair.qMedia && images.length === 0 ? { q_media: result.pair.qMedia } : {})
    }, null, 2);
    // V3.4: 图片以真实 image 内容块返回(anthropic tool_result 支持块数组),
    //   模型可直接查看;非 anthropic 协议或无图片时保持纯文本。
    if (images.length > 0 && input.protocol === "anthropic") {
      return makeToolResultMessageBlocks(call.tool_call_id, textContent, images);
    }
    return makeToolResultMessage(input.protocol, call.tool_call_id, textContent, false);
  });

  const messagesToAppend: LLMMessage[] = [...hcMessages, ...historyMessages];

  // 2026-10-16: 统计本次回填的召回原文 token 数 —— 「真实端到端节省」要把这部分
  //   从 post(压缩后 messages)口径里扣掉(上游实收 = post + 召回回填 + system/tools)。
  //   用与 baseline 相同的 gpt-tokenizer(cl100k_base)口径,保证和 post 可比。
  const recallTokens = messagesToAppend.length > 0
    ? gptEncode(JSON.stringify(messagesToAppend)).length
    : 0;

  // 审计日志(V2 hc_recall + V3.2 history_recall 合并统计)
  // 旧版此处引用 V2 时代的 `recallResults`/`validCalls`(V3.2 已拆分),
  // 未定义变量导致 hook 抛 TypeError,gateway 吞掉 → LLM tool_call 没回结果,
  // 表面看起来像 "LLM 不知道怎么用占位符"。
  const hcHit = hcResults.filter(r => r.original !== null).length;
  const qaHit = historyResults.filter(r => r.pair !== null).length;
  const hcCount = validHcCalls.length;
  const qaCount = validHistoryCalls.length;
  context.logger.info?.(
    `[helix-compressor] recall request=${input.requestId} protocol=${input.protocol} ` +
    `hc=${hcCount}/${hcHit} qa=${qaCount}/${qaHit}`
  );

  return {
    continueLoop: true,
    messagesToAppend,
    recallTokens
  };
};

// 提取 OpenAI 协议 hc_recall 调用
export function extractOpenAIHcrecallCalls(response: Record<string, unknown>): Array<{
  tool_call_id: string;
  hash_id: string;
  reason: string;
}> {
  const calls: Array<{ tool_call_id: string; hash_id: string; reason: string }> = [];
  const choices = response.choices as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(choices)) return calls;

  for (const choice of choices) {
    const message = choice.message as Record<string, unknown> | undefined;
    if (!message) continue;
    const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(toolCalls)) continue;

    for (const tc of toolCalls) {
      if (tc.type !== "function") continue;
      const fn = tc.function as Record<string, unknown> | undefined;
      if (!fn || fn.name !== helixCompressorRecallToolName) continue;

      try {
        const args = JSON.parse(typeof fn.arguments === "string" ? fn.arguments : "{}");
        if (typeof args.hash_id === "string") {
          calls.push({
            tool_call_id: typeof tc.id === "string" ? tc.id : "",
            hash_id: args.hash_id,
            reason: typeof args.reason === "string" ? args.reason : ""
          });
        }
      } catch {
        // 忽略解析失败
      }
    }
  }
  return calls;
}

// 提取 Anthropic 协议 tool_use 调用
export function extractAnthropicHcrecallCalls(response: Record<string, unknown>): Array<{
  tool_call_id: string;
  hash_id: string;
  reason: string;
}> {
  const calls: Array<{ tool_call_id: string; hash_id: string; reason: string }> = [];
  const content = response.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return calls;

  for (const block of content) {
    if (block.type !== "tool_use") continue;
    if (block.name !== helixCompressorRecallToolName) continue;

    const input = block.input as Record<string, unknown> | undefined;
    if (!input || typeof input.hash_id !== "string") continue;

    calls.push({
      tool_call_id: typeof block.id === "string" ? block.id : "",
      hash_id: input.hash_id,
      reason: typeof input.reason === "string" ? input.reason : ""
    });
  }
  return calls;
}

// ============= Recall 读取（本地 store） =============
//
// 2026-10-15 P2：占位符原文只存在于本地 JSONL 缓存（压缩 transform 落盘），
// 召回不调任何云端 API。设计见
// docs/issue-reviews/2026-10-14-local-closed-loop-recall-design.md §7。
// 云端压缩 / 召回路径已整体移除——原文一律由本地 store 持有。

/** 兜底配置缓存目录：transform 路径已设置；无压缩发生的进程回退到默认 DATADIR 目录。 */
function ensureLocalRecallCacheDir(): void {
  if (!process.env.HELIX_RECALL_CACHE_DIR) {
    process.env.HELIX_RECALL_CACHE_DIR = HELIX_RECALL_DIR;
  }
}

/** 批量召回 hc_recall(block/文本块):hash → 原文(q 字段)。未命中 → null。 */
async function fetchRecallBatch(
  hashes: string[]
): Promise<Array<{ hash: string; original: string | null }>> {
  if (hashes.length === 0) return [];
  ensureLocalRecallCacheDir();
  let entries: Record<string, RecallCacheEntry>;
  try {
    entries = batchGetRecallCache(hashes);
  } catch {
    return hashes.map((hash) => ({ hash, original: null }));
  }
  return hashes.map((hash) => {
    const entry = entries[hash];
    return { hash, original: typeof entry?.q === "string" ? entry.q : null };
  });
}

// V3.2: history_recall 批量召回(Q&A pair,含 q + a;with_media 时附带 qMedia 原媒体块)
async function fetchHistoryRecallBatch(
  calls: Array<{ hash_id: string; with_media?: boolean }>
): Promise<Array<{
  hash: string;
  pair: { q: string; a: string; qMedia?: unknown[] } | null;
}>> {
  if (calls.length === 0) return [];
  ensureLocalRecallCacheDir();
  const hashes = calls.map((c) => c.hash_id);
  let entries: Record<string, RecallCacheEntry>;
  try {
    entries = batchGetRecallCache(hashes);
  } catch {
    return calls.map((c) => ({ hash: c.hash_id, pair: null }));
  }
  return calls.map(({ hash_id: hash, with_media = false }) => {
    const entry = entries[hash];
    if (!entry) return { hash, pair: null };
    const pair: { q: string; a: string; qMedia?: unknown[] } = {
      q: typeof entry.q === "string" ? entry.q : "",
      a: typeof entry.a === "string" ? entry.a : ""
    };
    if (with_media && Array.isArray(entry.qMedia) && entry.qMedia.length > 0) {
      pair.qMedia = entry.qMedia;
    }
    return { hash, pair };
  });
}

// V3.2: 构造 tool result message(anthropic + openai 两种协议共用)
function makeToolResultMessage(
  protocol: "anthropic" | "openai",
  toolCallId: string,
  content: string,
  isError: boolean
): LLMMessage {
  if (protocol === "anthropic") {
    return {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: toolCallId,
        content,
        is_error: isError
      }]
    } as unknown as LLMMessage;
  }
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content
  } as unknown as LLMMessage;
}

/**
 * V3.4: anthropic tool_result 用**块数组**承载文本 + 真实 image 块,
 * 使模型可直接查看召回的原图(而非把 base64 当文本读)。
 */
function makeToolResultMessageBlocks(
  toolCallId: string,
  text: string,
  images: Array<{ data: string; mimeType: string }>
): LLMMessage {
  return {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: toolCallId,
      content: [
        { type: "text", text },
        ...images.map((img) => ({
          type: "image",
          source: { type: "base64", media_type: img.mimeType, data: img.data }
        }))
      ],
      is_error: false
    }]
  } as unknown as LLMMessage;
}

/**
 * 归一化 qMedia 的两种形状为可渲染图片:
 *   ① pair 路径 `{type:"image", mime, data}`(extractMediaBlocks 归一化产物)
 *   ② 媒体候选原块 `{type:"image", source:{type:"base64", media_type, data}}`
 * 非图片(document/video/audio/url)忽略,保持文本承载。
 */
function normalizeMediaImages(qMedia: unknown[]): Array<{ data: string; mimeType: string }> {
  const out: Array<{ data: string; mimeType: string }> = [];
  for (const item of qMedia) {
    if (!isRecord(item)) continue;
    if (item.type !== "image" && item.type !== "image_url") continue;
    const src = isRecord(item.source) ? item.source : undefined;
    const data = typeof item.data === "string"
      ? item.data
      : src && typeof src.data === "string" ? src.data : undefined;
    const mimeType =
      (src && typeof src.media_type === "string" ? src.media_type : undefined) ??
      (typeof item.mime === "string" ? item.mime : "image/png");
    if (data) out.push({ data, mimeType });
  }
  return out;
}

// V3.2: history_recall 调用提取
export function extractAnthropicHistoryRecallCalls(response: Record<string, unknown>): Array<{ hash_id: string; tool_call_id: string; with_media?: boolean }> {
  const calls: Array<{ hash_id: string; tool_call_id: string; with_media?: boolean }> = [];
  const content = response.content;
  if (!Array.isArray(content)) return calls;
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "tool_use" &&
      block.name === HISTORY_RECALL_TOOL_NAME &&
      isRecord(block.input) &&
      typeof block.input.hash_id === "string" &&
      typeof block.id === "string"
    ) {
      // with_media 是 LLM 决定本次召回要不要原图(默认 false=只文本)
      const wm = block.input.with_media;
      calls.push({
        hash_id: block.input.hash_id,
        tool_call_id: block.id,
        with_media: typeof wm === "boolean" ? wm : false
      });
    }
  }
  return calls;
}

export function extractOpenAIHistoryRecallCalls(response: Record<string, unknown>): Array<{ hash_id: string; tool_call_id: string; with_media?: boolean }> {
  const calls: Array<{ hash_id: string; tool_call_id: string; with_media?: boolean }> = [];
  const choices = response.choices;
  if (!Array.isArray(choices)) return calls;
  for (const choice of choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue;
    const toolCalls = choice.message.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      if (
        isRecord(tc) &&
        tc.type === "function" &&
        isRecord(tc.function) &&
        tc.function.name === HISTORY_RECALL_TOOL_NAME &&
        typeof tc.id === "string"
      ) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(String(tc.function.arguments || "{}"));
        } catch {
          args = {};
        }
        if (typeof args.hash_id === "string") {
          const wm = args.with_media;
          calls.push({
            hash_id: args.hash_id,
            tool_call_id: tc.id,
            with_media: typeof wm === "boolean" ? wm : false
          });
        }
      }
    }
  }
  return calls;
}

// 抑制未使用变量的 lint 警告
void helixCompressorLoopTimeoutMs;

// ============= 默认导出 =============

export default helixCompressorTransform;
