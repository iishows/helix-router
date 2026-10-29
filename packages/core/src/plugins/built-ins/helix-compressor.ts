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
import { helixCompressorRecallToolName, helixCompressorMaxRecallPerRequest, helixCompressorLoopTimeoutMs, helixRecallProfileMaxToolCalls, helixRecallProfileMaxTurns } from "@ccr/core/gateway/core-runtime/router-plugin-contract";
import { compressV3x, type LocalCompressMessage } from "@ccr/core/plugins/built-ins/helix-compressor/hc-local";
import {
  putBatch as putRecallCacheBatch,
  batchGet as batchGetRecallCache,
  entryFitsBudget,
  type RecallCacheEntry
} from "@ccr/core/observability/helix-recall-local-store";
import { HELIX_RECALL_DIR } from "@ccr/core/config/constants";
import type { AppConfig, VirtualModelProfileConfig } from "@ccr/core/contracts/app";
import { HELIX_RECALL_MODEL_PREFIX } from "@ccr/core/contracts/app";
import { providerRuntimeId } from "@ccr/core/routing/model-registry";

/** Claude Code 的 1M 上下文标记后缀(与 `gateway/internal/shared` 保持一致)。 */
const CLAUDE_CODE_ONE_MILLION_CONTEXT_SUFFIX = "[1m]";

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
 * 解析"召回改写"应写入前缀的**真实模型名**。
 *
 * 背景:召回触发时会把请求 model 改写成 `${HELIX_RECALL_MODEL_PREFIX}<model>`,
 * 网关据此命中召回 virtual model profile 并剥掉前缀,但**不会**再解析内层 ——
 * 既不解析虚拟模型别名,也不解析 `provider/model` 限定前缀,而是直接拿内层
 * 去做目标 provider 的白名单校验。因此内层必须是网关能解析的模型选择器:
 *   - `Fusion/Doitx` 这类虚拟别名 → 解析成 fixedModel;
 *   - `Doitx/DeepSeek-V4.1-Flash` 这类 provider 限定名 → 换成网关认识的
 *     `<providerRuntimeId>/DeepSeek-V4.1-Flash`(不能保留 `Doitx/`,网关只认 runtime id)。
 * 否则大请求压缩后即报
 *   `Model "<内层>" is not configured for target provider ...` → HTTP 400。
 * 小请求不压缩、不写前缀,所以只在大请求上暴露。
 *
 * 返回:
 *   - 非虚拟模型 → 原样返回(provider 前缀见下);
 *   - 虚拟模型且 `baseModel` 可静态解析(mode=fixed)→ 返回 `fixedModel`;
 *   - 虚拟模型但无法静态解析(缺 baseModel / mode=request 等)→ undefined,
 *     调用方据此**整体跳过压缩与改写**(宁可不召回,也不能 400)。
 */
function resolveRecallRoutableModel(
  model: string,
  appConfig: AppConfig | undefined
): string | undefined {
  const profiles = appConfig?.virtualModelProfiles;
  if (!Array.isArray(profiles) || profiles.length === 0) {
    return stripProviderQualifier(model, appConfig);
  }

  const profile = profiles.find((candidate) => virtualProfileMatchesModel(candidate, model));
  if (!profile) return stripProviderQualifier(model, appConfig);

  const fixed = typeof profile.baseModel?.fixedModel === "string" ? profile.baseModel.fixedModel.trim() : "";
  return fixed.length > 0 ? stripProviderQualifier(fixed, appConfig) : undefined;
}

/**
 * 把 `provider/model` 形式的模型名改写为网关可解析的 `<runtimeId>/model`。
 *
 * 召回改写写入 `ccr-helix-recall/<model>` 后,网关只剥掉召回前缀,**不会**再解析
 * 内层的 provider 限定前缀,而是直接拿它做目标 provider 的白名单校验。所以若
 * 内层仍是 `Doitx/DeepSeek-V4.1-Flash`(客户端常用这种写法),大请求一旦压缩产生
 * 占位符就会 400:
 *   Model "Doitx/DeepSeek-V4.1-Flash" is not configured for target provider ...
 * (小请求不压缩 → 不写前缀 → 不受影响,表现为"只有大请求报错")
 *
 * 仅在可安全判定时改写:前缀命中某个已配置 provider 的 name/id,且该 provider
 * 未限定 models 或裸模型就在其 models 白名单内。否则原样返回,保持旧行为。
 *
 * 改写结果用 **provider 的 runtime id**(`providerRuntimeId(pre)`,即配置里的 `id`,
 * 缺省时按 name/baseUrl 生成)而非裸模型名:网关的 provider 选择别名正是 runtime id
 * (见 `toCoreGatewayProviders` / 网关 `providerConfigSelectorAliases`)。若只写裸模型,
 * 多个 provider 暴露同名模型时会落到默认 provider(网关 `resolveTargetProviders`
 * 无 provider 引用时回退),导致"压缩后请求被路由到别的 provider";带 runtime id
 * 则显式指定目标,与客户端的 `Doitx/...` 意图一致。
 */
function stripProviderQualifier(model: string, appConfig: AppConfig | undefined): string {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash >= model.length - 1) return model;
  const hint = model.slice(0, slash).trim().toLowerCase();
  const bare = model.slice(slash + 1).trim();
  if (!hint || !bare) return model;

  const providers = appConfig?.Providers ?? [];
  const provider = providers.find((candidate) =>
    [candidate?.id, candidate?.name].some(
      (alias) => typeof alias === "string" && alias.trim().length > 0 && alias.trim().toLowerCase() === hint
    )
  );
  if (!provider) return model;

  const models = Array.isArray(provider.models) ? provider.models : [];
  const bareWithoutSuffix = bare.toLowerCase().endsWith(CLAUDE_CODE_ONE_MILLION_CONTEXT_SUFFIX)
    ? bare.slice(0, -CLAUDE_CODE_ONE_MILLION_CONTEXT_SUFFIX.length).trim()
    : bare;
  const bareAllowed = models.length === 0
    || models.some((entry) =>
      typeof entry === "string" && (entry.trim() === bare || entry.trim() === bareWithoutSuffix)
    );
  if (!bareAllowed) return model;
  const runtimeId = providerRuntimeId(provider).trim();
  return runtimeId ? `${runtimeId}/${bare}` : bare;
}

/** 虚拟模型 profile 是否匹配该模型名(exactAliases / prefixes / suffixes)。 */
function virtualProfileMatchesModel(profile: VirtualModelProfileConfig, model: string): boolean {
  const match = profile?.match;
  if (!match) return false;
  if (match.exactAliases.some((alias) => virtualAliasMatches(model, alias))) return true;
  if (match.prefixes.some((prefix) => prefix.length > 0 && model.startsWith(prefix))) return true;
  return match.suffixes.some((suffix) => suffix.length > 0 && model.endsWith(suffix));
}

/** 精确别名比对:`Doitx` 同时匹配 `Doitx` 与网关物化后的 `Fusion/Doitx`。 */
function virtualAliasMatches(model: string, alias: string): boolean {
  const trimmed = typeof alias === "string" ? alias.trim() : "";
  if (trimmed.length === 0) return false;
  return model === trimmed || model.toLowerCase() === `fusion/${trimmed}`.toLowerCase();
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

  // 本地压缩:只有命中 recall 白名单的模型才做占位符压缩,否则原样透传。
  let compressed: CompressResponse;
  // 本轮压缩产物的 hashMap(用于生成教学 prompt 里的「hash → 主题」清单)。
  let recallIndex = "";
  // 按模型门控 recall(2026-10-16):只有命中 recall 白名单的模型才做本地占位符压缩。
  //   未命中的模型 → 跳过 compressV3x(不产 ⟦QA:⟧/⟦HC:⟧、不落召回缓存、model 不改写),
  //   仅保留上面的安全预清理,后续只走主动 compact。空白名单 = 支持全部(向后兼容)。
  //   白名单比对用**实际发往 provider 的模型**(虚拟别名解析后的 base model):
  //   `recallModelPatterns` 由 recall-model-detect 从 provider 模型清单生成,不含
  //   virtual profile 派生串(见 recall-model-detect.ts 顶部注释),拿别名去比会
  //   误判为「不支持」而静默跳过压缩。
  const recallRoutableModel = resolveRecallRoutableModel(model, context.config);
  const recallSupported = recallRoutableModel !== undefined && recallModelSupported(recallRoutableModel, config);
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
        maxCompressToolResults: config.maxCompressToolResults,
        // 与 putBatch 同源(同一序列化 + 同一字节上限):超过上限的条目在替换占位符前
        // 就被跳过,保证凡出现在消息里的 ⟦HC:hash⟧ 都必然可读回。
        entryFitsBudget
      });
      const cacheEntries = Object.entries(local.hashMap);
      if (cacheEntries.length > 0) {
        recallIndex = buildHistoryRecallIndex(local.hashMap);
        try {
          // 缓存目录默认 {DATADIR}/helix-recall;若外部已通过环境变量指定则由 store 读取该值。
          ensureLocalRecallCacheDir();
          const written = putRecallCacheBatch(cacheEntries as Array<[string, RecallCacheEntry]>);
          if (written < cacheEntries.length) {
            // 预检已按同一字节上限过滤,走到这里说明两处口径意外分叉 — 明确指出,
            // 否则表现为"占位符在但召不回"的静默数据丢失。
            context.logger.warn(
              `[helix-compressor] recall cache dropped ${cacheEntries.length - written}/${cacheEntries.length} entries (over byte budget); placeholders may be unrecallable`
            );
          }
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
  const routedModel = recallNeeded ? `${HELIX_RECALL_MODEL_PREFIX}${recallRoutableModel}` : undefined;

  // 教学 prompt:告诉模型占位符的含义与何时调用 recall 工具。
  //   工具定义本身由 profile 提供(见 config-compiler 的 helixRecallVirtualModelProfile),
  //   这里只负责 prompt 侧的"何时调/怎么调"。两个 marker 段独立 prepend,互不覆盖。
  if (hasHC) {
    outputMessages = injectRecallInstruction(outputMessages);
    outputBody.messages = outputMessages;
  }
  if (hasQA) {
    outputMessages = injectHistoryRecallInstruction(outputMessages, recallIndex);
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

/**
 * 统计 messages 的"可见字符数"(不含 role/JSON 结构开销)。
 *
 * ⚠️ 2026-10-19 修 bug:旧实现有两个缺陷,导致 input/output-chars 与 ratio 全是坏数:
 *   1. **early-return**:`for` 循环里 `return total + text.length` —— 只累加第一个
 *      text 块就返回,同一消息的后续块全部丢失(实测两 text 块 100+900 → 只算 100)。
 *   2. **只认 `.text`**:漏掉真实 Claude Code 形状里的 `tool_result.content`(字符串或
 *      块数组)、`tool_use.input`、`tool_calls[].function.arguments` 等 —— 一条纯
 *      tool_result 消息会被算成 0 字符。
 *   修复:正确累加(continue 而非 return),并覆盖 string / text / tool_result.content /
 *   tool_use.input / 其余块的 JSON 序列化长度。
 */
function countChars(messages: LLMMessage[]): number {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === "string") {
      total += content.length;
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content as unknown[]) {
        if (typeof block === "string") {
          total += block.length;
          continue;
        }
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") total += b.text.length;
        // tool_result.content:字符串或块数组(真实 CC 形状)
        if (typeof b.content === "string") total += b.content.length;
        else if (Array.isArray(b.content)) {
          for (const ib of b.content) {
            if (typeof ib === "string") total += ib.length;
            else if (ib && typeof ib === "object" && typeof (ib as { text?: unknown }).text === "string") {
              total += ((ib as { text: string }).text).length;
            }
          }
        }
        // tool_use.input / 其余非文本块:按 JSON 长度近似
        if (b.input !== undefined) {
          try { total += JSON.stringify(b.input).length; } catch { /* 循环引用忽略 */ }
        }
        // image / document 等媒体块用 base64 data 长度
        const src = b.source as Record<string, unknown> | undefined;
        if (src && typeof src.data === "string") total += src.data.length;
        else if (typeof b.data === "string") total += b.data.length;
      }
      continue;
    }
    // 兜底:非常规 content,按 JSON 长度计
    try { total += JSON.stringify(content).length; } catch { /* ignore */ }
  }
  return total;
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

const HC_RECALL_TOOL_DESCRIPTION =
  "Retrieve the original text behind a ⟦HC:hash⟧ placeholder. Content in this conversation was " +
  "compressed: long tool results, file reads and command output were replaced by ⟦HC:<16-hex>⟧ " +
  "markers that hold NO information on their own. Call this tool with the hash_id to get the exact " +
  "original content back. Recall ONLY when the fact you need is genuinely hidden behind a placeholder " +
  "and cannot be answered from the visible conversation — every recall re-injects the original text " +
  "and gives back the tokens that were saved, so do not recall \"just in case\". Do not recall every " +
  "placeholder, and never repeat the same hash_id.";

export const HC_RECALL_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: helixCompressorRecallToolName,
    description: HC_RECALL_TOOL_DESCRIPTION,
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
  description: HC_RECALL_TOOL_DESCRIPTION,
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

const HC_RECALL_INSTRUCTION_MARKER = "<<HC_RECALL_INSTRUCTION_v2>>";

const HC_RECALL_INSTRUCTION = `${HC_RECALL_INSTRUCTION_MARKER}
## ⚠️ Compressed content: recall only when the answer is NOT visible

Long content in this conversation (tool results, file reads, command output, retrieved documents)
was replaced by **placeholders** of the form \`⟦HC:<16-hex>⟧\`. A placeholder carries NO
information of its own — it only marks that original content once existed and can be retrieved.

**Recall is the exception, not the default.** Compressed content was collapsed for a reason: the
whole point is to keep the prompt small. Every recall re-injects the original text and gives back
the tokens that were saved. Call \`${helixCompressorRecallToolName}\` **only when the specific fact
you need is genuinely hidden behind a placeholder and cannot be answered from what is already
visible** — otherwise answer directly and do NOT recall.

### Recall ONLY when
1. The answer needs a **specific value that lives inside compressed content** — a number, name, file
   path, code snippet, config key, or verbatim string you cannot produce from the visible text.
2. The user explicitly asks you to retrieve or quote an earlier artifact.
3. You are about to **guess, assume, or claim the information is unavailable** — if that fact is
   behind a placeholder, recall it instead of guessing.

### Do NOT recall when
- The question can be answered from the visible conversation (summary already suffices, it is a
  follow-up/opinion/next-step, or you recognise the answer from context). Answer directly.
- You would only be recalling "just in case" — that wastes the tokens compression saved.

### How to call
- The placeholder looks like \`⟦HC:abcdef0123456789⟧\`.
- \`hash_id\` = the 16 hex chars only (drop the \`⟦HC:\` prefix and the \`⟧\` suffix): \`abcdef0123456789\`.
- Put **every hash the current task needs into ONE call**: \`${helixCompressorRecallToolName}(calls=[{hash_id, reason}, ...])\`.
  Batching matters: the recall loop is budgeted per turn, and one call can carry all needed hashes.

### Hard limits
- ❌ Never treat \`⟦HC:hash⟧\` as the content. It is a pointer, never an answer.
- ❌ Never recall every placeholder — recall only what the current task actually needs.
- ❌ Never call the same \`hash_id\` twice.
- ⏱ The request allows at most ${helixRecallProfileMaxTurns} recall turns / ${helixRecallProfileMaxToolCalls} tool calls — batch all hashes instead of spreading recalls across turns.

### Example
Only if the exact file content is needed: \`⟦HC:abcdef0123456789⟧\`
→ Call: \`${helixCompressorRecallToolName}(calls=[{hash_id: "abcdef0123456789", reason: "need the original file content"}])\`
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

const HISTORY_RECALL_TOOL_DESCRIPTION =
  "Retrieve the original content behind a ⟦QA:hash⟧ placeholder. Earlier turns of this conversation " +
  "were compressed: past Q&A pairs and folded tool outputs were replaced by ⟦QA:<16-hex>⟧ markers " +
  "that hold NO information on their own. Call this tool with the hash_id to bring the exact original " +
  "question, answer or tool output back. The placeholder is NOT a summary, but recall is the " +
  "exception: call this ONLY when the specific fact you need is genuinely hidden behind a placeholder " +
  "and cannot be answered from the visible text — every recall re-injects the original and gives back " +
  "the saved tokens, so do not recall \"just in case\". Set with_media=true only when you need the " +
  "original image/video/document from the earlier question. Do not recall every placeholder; never " +
  "repeat the same hash_id.";

export const HISTORY_RECALL_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: HISTORY_RECALL_TOOL_NAME,
    description: HISTORY_RECALL_TOOL_DESCRIPTION,
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
  description: HISTORY_RECALL_TOOL_DESCRIPTION,
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

const HISTORY_RECALL_INSTRUCTION_MARKER = "<<HISTORY_RECALL_INSTRUCTION_v2>>";
/** 清单最多列多少条占位符主题(超出部分仍可召回,只是不进清单)。 */
const HISTORY_RECALL_TOPIC_LIMIT = 40;

// 教学 prompt 拆成「固定规则」+「本轮占位符清单」两段:
//   BASE 讲清何时调/怎么调(与具体 hash 无关),INDEX 把每个 ⟦QA:hash⟧ 映射到一句话主题。
//   动机(2026-10-17):只给 hash 时模型无法把「我需要的事实」映射到某个 hash,「按需召回」
//   就成了空话 —— 实测调用率仅 ~6.7%(128/1952;见 tools/_diag-rate.mjs),其余要么全召回
//   (撞 maxToolCalls → 400)要么完全不召回。清单给了「哪块折叠内容讲什么」之后,模型才能
//   精确挑出真正需要的那一两个 hash 去要原文。
const HISTORY_RECALL_INSTRUCTION_BASE = `${HISTORY_RECALL_INSTRUCTION_MARKER}
## ⚠️ Compressed history: recall only when the answer is NOT visible

Earlier turns were compressed into placeholders of the form \`⟦QA:<16-hex>⟧\`. Each placeholder
replaces **compressed-away content**, which may be:
- an earlier **Q&A pair** (user question + assistant answer), or
- a **folded tool output** (an old tool_result — a large file read or command output — collapsed to save tokens).

The placeholder itself holds NO content — reading the hash tells you nothing on its own. But each hash IS
listed below with a one-line **topic**, so you can tell which compressed block covers what.

Recall re-injects the original text and gives back the tokens that were saved: recall is the exception, not the default.
Call \`${HISTORY_RECALL_TOOL_NAME}\` **only when the specific fact you need is genuinely hidden behind a
placeholder and cannot be answered from what is already visible.**

### Recall ONLY when
1. The current task needs a **specific number / name / code / verbatim snippet** that lives inside
   compressed history and you cannot produce it from the visible text. Match the need against the
   topic list below, then recall just those \`hash_id\`s.
2. The user explicitly asks you to retrieve or quote an earlier artifact ("compare against the earlier
   diagram/PDF", "what was the file from before").
3. You are about to **guess, assume, or say the information is unavailable** — if that fact is behind
   a placeholder, recall it instead of guessing.

### Do NOT recall when
- The question can be answered from the visible conversation (summary suffices, it is a follow-up,
  or you recognise the answer from context). Answer directly.
- You would only be recalling "just in case" — that wastes the tokens compression saved.

### How to call
- Placeholder: \`⟦QA:abc123def4567890⟧\`; \`hash_id\` = the 16 hex chars only: \`abc123def4567890\`.
- Put **every hash the current task needs into ONE call**: \`${HISTORY_RECALL_TOOL_NAME}(calls=[{hash_id, reason}, ...])\`.
  Batching matters: the recall loop is budgeted per turn, and one call can carry all needed hashes.
- Default \`with_media=false\` returns the Q+A text only — the answer already contains the assistant's
  textual description of any image/video/document, which is enough in most cases.
- Set \`with_media=true\` **only** when the earlier question contained an **image** and you need
  pixel-level detail; the call then returns the original image you can actually look at.

### Hard limits
- ❌ Never treat \`⟦QA:hash⟧\` as complete information — it is a pointer label, not the content.
- ❌ Never recall **every** placeholder — recall only what the current task actually needs.
- ❌ Never call the same \`hash_id\` twice.
- ⏱ The request allows at most ${helixRecallProfileMaxTurns} recall turns / ${helixRecallProfileMaxToolCalls} tool calls — batch all hashes instead of spreading recalls across turns.

### Examples
\`\`\`
${HISTORY_RECALL_TOOL_NAME}(calls=[{hash_id: "abc123def4567890", reason: "need the detail from that earlier image"}])
${HISTORY_RECALL_TOOL_NAME}(calls=[{hash_id: "abc123def4567890", with_media: true, reason: "compare the old and new PDF"}])
\`\`\`
`;

/**
 * 由压缩产物 hashMap 生成「hash → 一句话主题」清单(紧跟固定规则之后注入)。
 * topic 取原文首段的有信息片段:Q&A pair 用提问、折叠的工具/媒体输出用类型标记。
 * 截断到 100 字、最多列 ${HISTORY_RECALL_TOPIC_LIMIT} 条,避免清单本身吃掉压缩省下的
 * token、或把首轮 prompt 推得过大。
 */
export function buildHistoryRecallIndex(
  hashMap: Record<string, {
    q?: unknown;
    a?: unknown;
    kind?: "text" | "media" | "tool_result";
    blockOnly?: boolean;
  }>
): string {
  const lines: string[] = [];
  let count = 0;
  for (const [hash, entry] of Object.entries(hashMap)) {
    if (count >= HISTORY_RECALL_TOPIC_LIMIT) break;
    if (!/^[0-9a-f]{16}$/.test(hash)) continue;
    lines.push(`- \`${hash}\` — ${historyRecallTopic(entry)}`);
    count++;
  }
  if (lines.length === 0) return "";
  return `### Compressed blocks in this conversation (hash → topic)\n${lines.join("\n")}\n`;
}

function historyRecallTopic(entry: {
  q?: unknown;
  a?: unknown;
  kind?: "text" | "media" | "tool_result";
  blockOnly?: boolean;
}): string {
  if (entry.kind === "media") return "[image/video/document dropped during compression]";
  // q/a 不保证是字符串:tool_result/媒体块的 entry.q 可能是 JSON 字符串或块数组,
  //   直接 `.replace` 会抛 TypeError → 整个 compressV3x try 块 bail → 完全不压缩。
  const raw = coerceTopicText(entry.q) || coerceTopicText(entry.a);
  if (!raw) return "[compressed content]";
  const label = entry.blockOnly || entry.kind === "tool_result" ? "tool output: " : "Q: ";
  const limit = 100 - label.length;
  return label + (raw.length > limit ? `${raw.slice(0, limit)}…` : raw);
}

function coerceTopicText(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) {
    return value
      .map((block) =>
        block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : ""
      )
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

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

/**
 * 注入 history_recall 工具的教学 prompt(同 V2 injectRecallInstruction 模式 + marker 幂等)。
 * `index` 是本轮占位符清单(见 buildHistoryRecallIndex),为空时退化为仅规则段。
 */
export function injectHistoryRecallInstruction(
  messages: LLMMessage[],
  index = ""
): LLMMessage[] {
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
  const instruction = index ? `${HISTORY_RECALL_INSTRUCTION_BASE}\n${index}` : HISTORY_RECALL_INSTRUCTION_BASE;
  const out: LLMMessage[] = [];
  let injected = false;
  for (const m of messages) {
    if (!injected && m?.role === "system" && typeof m.content === "string") {
      out.push({ ...m, content: instruction + "\n" + m.content });
      injected = true;
    } else if (!injected && m?.role !== "system") {
      out.push({ role: "system", content: instruction });
      out.push(m);
      injected = true;
    } else {
      out.push(m);
    }
  }
  if (!injected) {
    out.unshift({ role: "system", content: instruction });
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
