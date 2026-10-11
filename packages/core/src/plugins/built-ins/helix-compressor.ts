/**
 * Helix Compressor — Claude Code Router Built-in Plugin (v1.1 评估边界重构)
 *
 * ⚠️ 基于 CCR 真实接口（musistudio/claude-code-router, @ccr/core v1）：
 *   - GatewayPluginRequestTransformHandler / Input / Result / Context
 *   - 文件位置：packages/core/src/plugins/built-ins/helix-compressor.ts
 *   - 在 packages/core/src/gateway/core-runtime/router-plugin.ts 里 import + 注册
 *
 * 对应 helix-compressor 云端 API：
 *   - POST /v1/compress           — 压缩 messages
 *   - POST /v1/quality/feedback   — 上报客户端评估的评分
 *
 * 设计原则（v1.1）：
 *   - 抽样决策：客户端插件（hash % sample_mod）
 *   - LLM 评估：客户端（用 evaluator_api_* 配置）
 *   - 评分上报：客户端 → 云端 POST /v1/quality/feedback
 *   - 云端：不参与评估，只记账
 *
 * 集成步骤见 docs/PLUGIN_INTEGRATION.md 附录 A
 */

import { createHash, randomUUID } from "node:crypto";
import { encode as gptEncode } from "gpt-tokenizer";
import type {
  GatewayPluginRequestTransformHandler,
  GatewayPluginRequestTransformResult,
  GatewayPluginResponseHookHandler,
  GatewayPluginResponseHookResult
} from "@ccr/core/plugins/service";
import { helixCompressorRecallToolName, helixCompressorMaxRecallPerRequest, helixCompressorLoopTimeoutMs } from "@ccr/core/gateway/core-runtime/router-plugin-contract";

// ============= 类型定义 =============

/**
 * Helix Compressor 用户配置（写在 CCR AppConfig.plugins[].config）
 */
export interface HelixCompressorConfig {
  /** 云端 API 地址 */
  helixApiUrl: string;
  /** 云端 API Key */
  helixApiKey: string;
  /** 评估 LLM 地址（OpenAI 兼容） */
  evaluatorApiUrl: string;
  /** 评估模型名 */
  evaluatorModel: string;
  /** 评估 LLM Key */
  evaluatorApiKey: string;
  /** 抽样率（1/N），默认 20 = 5% */
  sampleMod?: number;
  /** 评估超时（ms），默认 30000 */
  timeoutMs?: number;
  /** 上报失败是否静默（默认 true） */
  reportFailuresSilent?: boolean;
  /** 跳过的 HTTP 错误码（默认 [400, 401, 403]） */
  skipOnErrorStatusCodes?: number[];
  /** 自定义 header 名（用于传递 request_id 等） */
  requestIdHeader?: string;
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
}

/**
 * LLM 消息（OpenAI Chat Completions 格式）
 */
type LLMMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string }>;
};

/**
 * /v1/compress 响应
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
  feedback_endpoint: string;
}

/**
 * LLM 评分结构
 */
interface QualityScore {
  information_loss: number;
  coherence: number;
  accuracy: number;
  reason: string;
  evaluator_model: string;
  evaluator_response?: Record<string, unknown>;
}

// ============= 默认配置 =============

export const HELIX_COMPRESSOR_DEFAULTS: HelixCompressorConfig = {
  helixApiUrl: "https://api.helix-compressor.com",
  helixApiKey: "",
  evaluatorApiUrl: "https://api.minimaxi.com/v1",
  evaluatorModel: "MiniMax-M3",
  evaluatorApiKey: "",
  sampleMod: 20,
  timeoutMs: 30000,
  reportFailuresSilent: true,
  skipOnErrorStatusCodes: [400, 401, 403],
  requestIdHeader: "x-helix-request-id"
};

// ============= Plugin Key 常量（用于 CCR 注册） =============

export const helixCompressorRequestTransformKey = "helix-compressor-request-transform";
export const helixCompressorResponseHookKey = "helix-compressor-quality-feedback";
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

// ============= Few-shot Prompt =============

const EVAL_SYSTEM_PROMPT = `你是 AI 上下文压缩质量评估专家。客户使用上下文压缩服务，请客观评估压缩前后质量变化。

【关键】返回纯 JSON，不含 markdown 包装或解释文字。

## 评分维度（1-5，5=最佳）

1. **information_loss（信息保留度）** — 压缩后是否丢失关键信息？
2. **coherence（连贯性）** — 压缩后对话是否连贯？
3. **accuracy（准确性）** — 关键数据/事实是否保留？

## Few-shot 示例

### 示例 1：高质量压缩
原始：[50字符的订单详情 "订单号#12345，价格$99"]
压缩：[⟦HC:abc123⟧]
评分：{"information_loss": 5, "coherence": 5, "accuracy": 5, "reason": "订单关键信息全部保留"}

### 示例 2：低质量压缩（代码被压）
原始：[详细代码+注释+日志 "def calculate(x): ...# 注释...print(x)"]
压缩：[⟦HC:xyz789⟧]
评分：{"information_loss": 2, "coherence": 4, "accuracy": 2, "reason": "代码注释被压缩，关键逻辑丢失"}

### 示例 3：低质量压缩（思考过程被压）
原始：[思考过程 "让我分析...首先X，然后Y..."]
压缩：[⟦HC:thinking⟧]
评分：{"information_loss": 2, "coherence": 3, "accuracy": 2, "reason": "推理步骤被压缩，影响思考质量"}

## 输出格式

严格 JSON：
{
  "information_loss": 1-5,
  "coherence": 1-5,
  "accuracy": 1-5,
  "reason": "中文/英文评估理由"
}`;

// ============= 抽样决策 =============

/**
 * 判断本次请求是否需要评估
 *
 * @param requestId  CCR 框架提供的 requestId
 * @param sampleMod  抽样率（1/N）
 */
export function shouldSample(requestId: string, sampleMod: number = HELIX_COMPRESSOR_DEFAULTS.sampleMod!): boolean {
  if (!requestId) return false;
  const hashHex = createHash("sha256").update(String(requestId)).digest("hex").slice(0, 8);
  const hashInt = parseInt(hashHex, 16);
  return hashInt % sampleMod === 0;
}

// ============= LLM 评估 =============

/**
 * 调用 LLM 评估压缩质量（失败返回 null，不抛异常）
 */
export async function evaluateCompression(
  originalMessages: LLMMessage[],
  compressedMessages: LLMMessage[],
  subjectModel: string,
  config: HelixCompressorConfig
): Promise<QualityScore | null> {
  if (!config.evaluatorApiKey || !config.evaluatorApiUrl || !config.evaluatorModel) {
    return null;
  }

  const timeoutMs = config.timeoutMs ?? HELIX_COMPRESSOR_DEFAULTS.timeoutMs!;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const userPrompt = formatEvalPayload(originalMessages, compressedMessages, subjectModel);

    const resp = await fetch(`${config.evaluatorApiUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.evaluatorApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.evaluatorModel,
        messages: [
          { role: "system", content: EVAL_SYSTEM_PROMPT },
          { role: "user", content: userPrompt }
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 500
      }),
      signal: controller.signal
    });

    if (!resp.ok) {
      console.warn(`[helix-compressor] evaluator ${resp.status}: ${await resp.text().catch(() => "")}`);
      return null;
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = robustParseJson(content);
    if (!parsed) return null;

    return {
      information_loss: clamp(parsed.information_loss),
      coherence: clamp(parsed.coherence),
      accuracy: clamp(parsed.accuracy),
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      evaluator_model: config.evaluatorModel,
      evaluator_response: { raw: parsed, source: "ccr_plugin" }
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.warn(`[helix-compressor] evaluator timeout after ${timeoutMs}ms`);
    } else {
      console.warn(`[helix-compressor] evaluator failed: ${(err as Error).message}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ============= 上报云端 =============

/**
 * 上报评分到云端（失败不抛异常）
 */
export async function reportFeedback(
  requestId: string,
  quality: QualityScore,
  config: HelixCompressorConfig
): Promise<boolean> {
  if (!requestId || !quality) return false;

  try {
    const resp = await fetch(`${config.helixApiUrl}/v1/quality/feedback`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.helixApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ request_id: requestId, quality })
    });

    if (!resp.ok) {
      const silent = config.reportFailuresSilent ?? HELIX_COMPRESSOR_DEFAULTS.reportFailuresSilent!;
      if (!silent) {
        console.warn(`[helix-compressor] report failed: ${resp.status}`);
      }
      return false;
    }
    return true;
  } catch (err) {
    const silent = config.reportFailuresSilent ?? HELIX_COMPRESSOR_DEFAULTS.reportFailuresSilent!;
    if (!silent) {
      console.warn(`[helix-compressor] report error: ${(err as Error).message}`);
    }
    return false;
  }
}

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
 *   1. 调云端 POST /v1/compress 拿压缩结果
 *   2. 客户端抽样（hash % sample_mod）
 *   3. 被抽样时调 LLM 评估（用 evaluator_api_* 配置）
 *   4. 评估成功时上报云端（POST /v1/quality/feedback，异步）
 *   5. 返回替换 messages 的 body
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

  // 决定传给云端的 request_id。
  // Fastify 默认 req.id 是 "req-<letter>"，太短会被 helix 记成单字符；
  // 客户端若有完整 ID（>=8 字符）就用它，否则用 randomUUID() 生成稳定的 nanoid。
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

  // 1. 调云端压缩
  let compressed: CompressResponse;
  try {
    const resp = await fetch(`${config.helixApiUrl}/v1/compress`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.helixApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        request_id: upstreamRequestId,
        messages,
        model,
        thinking_mode: extractThinkingMode(body),
        // V3.2: 默认不存原 media bytes。LLM 真要看像素级细节时手动开启
        store_media: config.storeWithMedia === true,
        // 严格压缩:只保留最新 1 对 Q&A(默认 1),anchor + 历史消息(含图片/PDF)都替成 ⟦QA:⟧
        keep_recent_pairs: config.keepRecentPairs ?? 1,
        // V3.3 block 级压缩:任意 role 的 text 块 ≥ 阈值字符即纳入候选
        // 默认 0 = 关闭(向后兼容);设为 >0 启用
        block_threshold_chars: config.blockThresholdChars ?? 0
      })
    });

    if (!resp.ok) {
      const skipCodes = config.skipOnErrorStatusCodes ?? HELIX_COMPRESSOR_DEFAULTS.skipOnErrorStatusCodes!;
      if (skipCodes.includes(resp.status)) {
        context.logger.warn(`[helix-compressor] compress ${resp.status}, skip`);
        return undefined;
      }
      throw new Error(`compress ${resp.status}: ${await resp.text().catch(() => "")}`);
    }

    compressed = (await resp.json()) as CompressResponse;
  } catch (err) {
    context.logger.warn(`[helix-compressor] compress failed: ${(err as Error).message}, skip`);
    return undefined;
  }

  // 2. 抽样
  if (shouldSample(upstreamRequestId, config.sampleMod)) {
    // 3. 评估
    const quality = await evaluateCompression(messages, compressed.compressed, model, config);

    // 4. 上报（异步，不阻塞 transform 返回）
    if (quality) {
      void reportFeedback(upstreamRequestId, quality, config).catch((err) => {
        context.logger.warn(`[helix-compressor] report error: ${(err as Error).message}`);
      });
    }
  }

  // 5. 返回替换 messages 的 body
  // 如果有 ⟦HC:hash⟧ 或 ⟦QA:hash⟧ 占位符，注入对应召回工具 + 教学 prompt
  let outputMessages = compressed.compressed as LLMMessage[];
  const outputBody: Record<string, unknown> = {
    ...body,
    messages: outputMessages
  };

  const hasHC = hasHCPlaceholder(outputMessages);
  const hasQA = hasQAPlaceholder(outputMessages);

  if (hasHC) {
    // 注入 hc_recall 工具定义（去重）。协议分发: Anthropic 用 input_schema, OpenAI 用 parameters
    const existingTools = Array.isArray(body.tools) ? body.tools : [];
    const format = inferRequestFormat(body);
    const recallName = helixCompressorRecallToolName;
    const hasRecall = existingTools.some((t: unknown) => {
      if (!isRecord(t)) return false;
      // 兼容两种格式的查重
      const fnName = (t.function as Record<string, unknown> | undefined)?.name;
      return t.name === recallName || fnName === recallName;
    });
    if (!hasRecall) {
      const schema = format === "anthropic"
        ? HC_RECALL_TOOL_SCHEMA_ANTHROPIC
        : HC_RECALL_TOOL_SCHEMA;
      outputBody.tools = [...existingTools, schema];
    }

    // 注入教学 prompt
    outputBody.messages = injectRecallInstruction(outputMessages);
  }

  // V3.2: ⟦QA:hash⟧ 占位符(history_recall 工具)。同样按协议分发
  if (hasQA) {
    const existingTools = Array.isArray(outputBody.tools) ? outputBody.tools : [];
    const format = inferRequestFormat(body);
    const historyName = HISTORY_RECALL_TOOL_NAME;
    const hasHistoryRecall = existingTools.some((t: unknown) => {
      if (!isRecord(t)) return false;
      const fnName = (t.function as Record<string, unknown> | undefined)?.name;
      return t.name === historyName || fnName === historyName;
    });
    if (!hasHistoryRecall) {
      const schema = format === "anthropic"
        ? HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC
        : HISTORY_RECALL_TOOL_SCHEMA;
      outputBody.tools = [...existingTools, schema];
    }
    // 注入教学 prompt(QA 版本)
    outputBody.messages = injectHistoryRecallInstruction(outputMessages);
  }

  return {
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
      [helixCompressorCompressedTokensHeader]: String(tokenizeMessages(outputMessages))
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
      [helixCompressorCompressedTokensHeader]: String(tokenizeMessages(outputMessages))
    }
  };
};

// ============= 辅助函数 =============

function parseConfig(value: unknown): HelixCompressorConfig {
  if (!isRecord(value)) return HELIX_COMPRESSOR_DEFAULTS;
  return {
    ...HELIX_COMPRESSOR_DEFAULTS,
    ...(typeof value.helixApiUrl === "string" ? { helixApiUrl: value.helixApiUrl } : {}),
    ...(typeof value.helixApiKey === "string" ? { helixApiKey: value.helixApiKey } : {}),
    ...(typeof value.evaluatorApiUrl === "string" ? { evaluatorApiUrl: value.evaluatorApiUrl } : {}),
    ...(typeof value.evaluatorModel === "string" ? { evaluatorModel: value.evaluatorModel } : {}),
    ...(typeof value.evaluatorApiKey === "string" ? { evaluatorApiKey: value.evaluatorApiKey } : {}),
    ...(typeof value.sampleMod === "number" ? { sampleMod: value.sampleMod } : {}),
    ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
    ...(typeof value.reportFailuresSilent === "boolean" ? { reportFailuresSilent: value.reportFailuresSilent } : {}),
    ...(Array.isArray(value.skipOnErrorStatusCodes) ? { skipOnErrorStatusCodes: value.skipOnErrorStatusCodes as number[] } : {}),
    ...(typeof value.storeWithMedia === "boolean" ? { storeWithMedia: value.storeWithMedia } : {}),
    ...(typeof value.keepRecentPairs === "number" ? { keepRecentPairs: value.keepRecentPairs } : {}),
    ...(typeof value.blockThresholdChars === "number" ? { blockThresholdChars: value.blockThresholdChars } : {})
  };
}

function extractThinkingMode(body: Record<string, unknown>): boolean {
  if (typeof body.thinking_mode === "boolean") return body.thinking_mode;
  if (typeof body.thinkingMode === "boolean") return body.thinkingMode;
  return false;
}

function clamp(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(1, Math.min(5, Math.round(n * 100) / 100));
}

/**
 * 鲁棒 JSON 解析：剥 <think> / 剥 markdown / 抽 {...}
 */
function robustParseJson(content: string): Record<string, unknown> | null {
  let text = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  const mdMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (mdMatch) text = mdMatch[1].trim();

  if (!text.startsWith("{")) {
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) text = objMatch[0];
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function formatEvalPayload(
  original: LLMMessage[],
  compressed: LLMMessage[],
  subjectModel: string
): string {
  return `## 待评估（被评模型：${subjectModel}）

【原始】（${countChars(original)}字符）:
${JSON.stringify(original).slice(0, 6000)}

【压缩后】（${countChars(compressed)}字符）:
${JSON.stringify(compressed).slice(0, 6000)}

只返回 JSON。`;
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

/**
 * 脱敏 API Key 用于日志
 */
export function maskApiKey(key: string): string {
  if (!key || key.length <= 8) return "***";
  return `${key.slice(0, 8)}***${key.slice(-4)}`;
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

/**
 * 检测请求 body 的工具 schema 协议
 * - Anthropic: 工具用 {name, description, input_schema}
 * - OpenAI:    工具用 {type:"function", function:{...}}
 * 不存在或无法识别时默认 "OpenAI"（向后兼容原行为）
 */
function inferRequestFormat(body: unknown): "anthropic" | "openai" {
  if (!isRecord(body)) return "openai";
  const tools = (body as Record<string, unknown>).tools;
  if (!Array.isArray(tools) || tools.length === 0) return "openai";
  const sample = tools[0];
  if (!isRecord(sample)) return "openai";
  if ("input_schema" in sample) return "anthropic";
  return "openai";
}

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

对话中形如 \`⟦QA:abc123def4567890⟧\` 的标记是 **已被压缩的历史 Q&A 对**(原用户问题 + 原助手回答)。
**这条占位符本身只携带"曾讨论过"信号**,不含具体细节 —— 看 hash 名不会让你知道那对 Q&A 说了什么。

### 🎯 必须调用 \`${HISTORY_RECALL_TOOL_NAME}\` 的场景
1. 当前任务需要某个历史 Q&A 里的 **具体数字 / 名称 / 代码 / 原文片段**
2. 用户提问明确指向历史:"刚才/之前/我们前面聊过的 X 是什么"
3. 比较/引用:**"对比之前那张图"**、"**用前面那份 PDF** 里的某段"
4. 上下文依赖:**不调回历史内容,当前任务就无法正确完成**

### ✅ 通常**不需要**调用的场景
- 只关心"我们讨论过 X"的方向感,不需要细节
- 答案能在上文 recent 段找到,不依赖压缩区

### 🔧 调用方法
- 占位符: \`⟦QA:abc123def4567890⟧\`
- \`hash_id\` = 中间 16 位 hex(去掉 \`⟦QA:\` 前缀和 \`⟧\` 后缀):**\`abc123def4567890\`**
- 默认 \`with_media=false\`,只返回 Q+A 文本 —— **A 已包含助手对图片/视频/文档内容的文字描述**,绝大多数情况已够用
- 仅当 Q 中含**图片/视频/原文档**且你需要**像素级细节**或**原文某段引用**时,才设 \`with_media=true\`

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
  for (const m of messages) {
    if (typeof m.content === "string" && m.content.includes("⟦QA:")) return true;
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
  const config = parseConfig(context.pluginConfig);
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
    hcHashes.length > 0 ? fetchRecallBatch(hcHashes, config) : Promise.resolve([]),
    validHistoryCalls.length > 0 ? fetchHistoryRecallBatch(validHistoryCalls, config) : Promise.resolve([])
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
    const content = JSON.stringify({
      q: result.pair.q,
      a: result.pair.a,
      ...(result.pair.qMedia ? { q_media: result.pair.qMedia } : {})
    }, null, 2);
    return makeToolResultMessage(input.protocol, call.tool_call_id, content, false);
  });

  const messagesToAppend: LLMMessage[] = [...hcMessages, ...historyMessages];

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
    messagesToAppend
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

// 并发批量召回
async function fetchRecallBatch(
  hashes: string[],
  config: HelixCompressorConfig
): Promise<Array<{ hash: string; original: string | null }>> {
  // 优先 batch API
  try {
    const resp = await fetch(`${config.helixApiUrl}/v1/recall/batch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.helixApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ hashes }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 10000)
    });

    if (resp.ok) {
      const data = await resp.json();
      const raw = data.results || {};
      // 兼容两种格式：
      // 1. { hash: "content" } 对象（当前云端实现）
      // 2. [{ hash, original }] 数组（未来可能改）
      const items = Array.isArray(raw)
        ? raw
        : Object.entries(raw).map(([hash, original]) => ({
            hash,
            original: typeof original === "string" ? original : null
          }));
      return items.map((r: { hash: string; original?: string | null }) => ({
        hash: r.hash,
        original: r.original ?? null
      }));
    }
  } catch {
    // Fallback 到并发单接口
  }

  // Fallback：并发调用
  return Promise.all(
    hashes.map(async (hash) => {
      try {
        const resp = await fetch(`${config.helixApiUrl}/v1/recall`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.helixApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ hash }),
          signal: AbortSignal.timeout(5000)
        });
        if (!resp.ok) return { hash, original: null };
        const data = await resp.json();
        return { hash, original: data.original ?? null };
      } catch {
        return { hash, original: null };
      }
    })
  );
}

// V3.2: history_recall 批量召回(Q&A pair,含 q + a,可按 LLM 选择回原图)
// 参数:calls[].with_media → 告诉服务端是否回原图(默认 false = 只文本)
async function fetchHistoryRecallBatch(
  calls: Array<{ hash_id: string; with_media?: boolean }>,
  config: HelixCompressorConfig
): Promise<Array<{
  hash: string;
  pair: { q: string; a: string; qMedia?: unknown[] } | null;
}>> {
  return Promise.all(
    calls.map(async ({ hash_id: hash, with_media = false }) => {
      try {
        const resp = await fetch(`${config.helixApiUrl}/v1/history/recall`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.helixApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ hash_id: hash, with_media }),
          signal: AbortSignal.timeout(5000)
        });
        if (!resp.ok) return { hash, pair: null };
        const data = await resp.json();
        if (data && data.q !== undefined) {
          return {
            hash,
            pair: {
              q: data.q || "",
              a: data.a || "",
              ...(Array.isArray(data.q_media) && data.q_media.length > 0 ? { qMedia: data.q_media } : {})
            }
          };
        }
        return { hash, pair: null };
      } catch {
        return { hash, pair: null };
      }
    })
  );
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

export function extractOpenAIHistoryRecallCalls(response: Record<string, unknown>): Array<{ hash_id: string; tool_call_id: string }> {
  const calls: Array<{ hash_id: string; tool_call_id: string }> = [];
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
