import type {
  CompressionProactiveCompactStat,
  RequestLogBody,
  RequestLogEntry
} from "@ccr/core/contracts/app";
import {
  formatCompactNumber
} from "./usage";

import { isPlainRecord, stringValue } from "./common";

export function formatLogDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetHours = offsetMinutes / 60;
  const offset = Number.isInteger(offsetHours)
    ? `GMT${offsetHours >= 0 ? "+" : ""}${offsetHours}`
    : `GMT${offsetHours >= 0 ? "+" : ""}${(offsetMinutes / 60).toFixed(1)}`;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} ${offset}`;
}

/**
 * V3.2 压缩率格式化:把巨大 token 数用 K/M 缩写,1 位小数百分比
 * 例: 2,934,201 → "2.9M", 350,908 → "350.9K"
 */
function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/**
 * 读取 helix-compressor plugin 写入的 headers,生成压缩状态摘要。
 * v1.7: cell 只显示「净端到端节省」百分比 = (baseline - 上游实收) / baseline,
 *   其中上游实收 = input_tokens + cache_read_tokens(含 history_recall 回填的原文)。
 *   这才是"真正省了多少";纯压缩比 baseline→post 不再放 cell。
 *   完整分解(压缩后 post / 净额 / 召回回填 / content chars / hash / scenario)进 title,
 *   点击行展开详情(LogCompressDetails)有同样的数字。
 * v1.6: baseline 用真 tokenizer (gpt-tokenizer cl100k_base) 算 user messages 的 token 数。
 * v1.2: 兼容 cli serve 模式下 response_headers 为空的场景——
 *   plugin transform 实际跑了(stats.ratio 写入 request_headers),
 *   但 CCR 本地 pipeline 的 response_headers 是 {}。
 *   所以 fallback 从 request_headers 读。
 */
export function formatLogCompressSummary(
  entry: RequestLogEntry,
  t: (value: string) => string
): { text: string; title: string } {
  // 优先读 response_headers(理想路径);fallback 到 request_headers(cli serve bug workaround)
  const headers = entry.responseHeaders ?? {};
  const requestHeaders = entry.requestHeaders ?? {};
  const inputChars = readHeaderNumber(headers["x-helix-compressor-input-chars"])
    || readHeaderNumber(requestHeaders["x-helix-compressor-input-chars"]);
  const outputChars = readHeaderNumber(headers["x-helix-compressor-output-chars"])
    || readHeaderNumber(requestHeaders["x-helix-compressor-output-chars"]);
  const ratioHeader = readHeaderNumber(headers["x-helix-compressor-ratio"])
    || readHeaderNumber(requestHeaders["x-helix-compressor-ratio"]);
  // helix V1.2 / 2026-10-13: 优先用 entry 字段(从 DB compression_* 列读),fallback 到 headers(老数据/transform 时)
  const baselineTokens = entry.compressionBaselineTokens
    ?? readHeaderNumber(headers["x-helix-compressor-baseline-tokens"])
    ?? readHeaderNumber(requestHeaders["x-helix-compressor-baseline-tokens"]) ?? 0;
  const compressedTokens = entry.compressionPostTokens
    ?? readHeaderNumber(headers["x-helix-compressor-compressed-tokens"])
    ?? readHeaderNumber(requestHeaders["x-helix-compressor-compressed-tokens"]) ?? 0;
  const scenario = readHeaderString(headers["x-helix-compressor-scenario"])
    || readHeaderString(requestHeaders["x-helix-compressor-scenario"]);
  // V3.2: Q&A pair 压缩占位数(⟦QA:hash⟧ 出现次数)
  const qaCompressed = readHeaderNumber(headers["x-helix-compressor-qa-compressed"])
    || readHeaderNumber(requestHeaders["x-helix-compressor-qa-compressed"]);
  const hashCount = readHeaderNumber(headers["x-helix-compressor-hash-count"])
    || readHeaderNumber(requestHeaders["x-helix-compressor-hash-count"]);
  const enabled = readHeaderString(headers["x-helix-compressor-enabled"])
    || readHeaderString(requestHeaders["x-helix-compressor-enabled"]);

  const inputTokens = typeof entry.inputTokens === "number" ? entry.inputTokens : 0;
  const cacheReadTokens = typeof entry.cacheReadTokens === "number" ? entry.cacheReadTokens : 0;
  const freshTokens = Math.max(0, inputTokens - cacheReadTokens);
  // helix V1.4 / 2026-10-15: "净额" = 上游实际收到的 prompt token 总量
  //   = input_tokens + cache_read_tokens(MiniMax 命中 prompt cache 时 input_tokens
  //   只计未缓存部分,cache_read 才是命中部分,两者之和才等于上游看到的 prompt)。
  //   与"压缩后"(post)分开显示:post 是 transform 出口的 messages(纯压缩),
  //   净额是真正发往 provider 的 prompt —— 含模型调用 history_recall 后回填进来的原文。
  //   两者之差 = 召回回填的代价。
  const netPromptTokens = inputTokens + cacheReadTokens;

  // 没经过 helix / 跳过 / silent fail → -
  if (!enabled && ratioHeader === 0 && (inputChars === 0 || outputChars === 0) && inputTokens === 0) {
    return { text: "-", title: t("未压缩（helix 跳过或未调用）") };
  }

  // 内容压缩率(chars 维度)—— **必须与旁边的 input/output chars 同口径**。
  //   2026-10-19 修正:此前优先用 `ratioHeader`(`x-helix-compressor-ratio`),但它是
  //   **候选口径**(只算入选块的占比,如 0.9935),而标题里把它贴在**整消息字符**
  //   (input→output chars,如 44,780→14,569)旁边 → 同一行数字自相矛盾
  //   (实为 67.5% 却显示 99.4%)。故一律由 chars 现算,不用候选 ratio。
  const contentRatio = inputChars > 0 ? 1 - outputChars / inputChars : 0;
  const contentRatioPct = (contentRatio * 100).toFixed(1);

  // cell 文本:只显示"净端到端节省"百分比。
  //   helix 2026-10-16 修正口径:节省必须与 baseline **同域**(都只算 messages)。
  //   baseline = 原始 messages(gpt-tokenizer);post = 压缩后 messages;
  //   召回回填 = 模型调 history_recall 后回填进 messages 的原文 token。
  //   saved = baseline − (post + 召回回填)。
  //   ⚠️ 旧公式用 (input_tokens + cache_read) 当被减项是**跨域比较**:那是上游收到的全量
  //   prompt(含 system + tools,从不被 helix 压缩),拿它减 messages 口径的 baseline 会凭空
  //   产生等于 system+tools 的"负债",把真实节省抹成"无净节省"。system/tools 的开销由
  //   「上下文开销」一栏单独呈现,不进节省率。
  const hasBaseline = baselineTokens > 0;
  const hasCompressed = compressedTokens > 0 && compressedTokens < baselineTokens;
  const recallTokens = entry.compressionRecallTokens ?? 0;
  const messagesAfterRecall = compressedTokens + recallTokens;
  const e2eSaved = hasCompressed && messagesAfterRecall > 0
    ? Math.max(0, baselineTokens - messagesAfterRecall)
    : 0;
  const e2eSavedPct = e2eSaved > 0 ? (e2eSaved / baselineTokens) * 100 : 0;

  let text: string;
  if (e2eSaved > 0) {
    // 净端到端节省(含召回回填的代价)
    text = `-${e2eSavedPct.toFixed(1)}%`;
  } else if (hasBaseline && hasCompressed) {
    // 压缩了,但召回把原文基本捞回(messages 口径下无净节省)
    text = "无净节省";
  } else if (hasBaseline) {
    // helix 跑了但没有可压缩内容(post == baseline)→ pass-through,未压缩
    text = "未压缩";
  } else if (inputTokens > 0) {
    text = `${formatTokenCount(inputTokens)} tok`;
  } else if (inputChars > 0) {
    text = `${inputChars.toLocaleString()} chars`;
  } else {
    text = "-";
  }

  // title:悬停显示完整分解(点击行展开详情有同样的数字)。cell 已被砍到只剩净端到端 %。
  const titleParts: string[] = [];
  if (baselineTokens > 0) {
    titleParts.push(`messages baseline ${baselineTokens.toLocaleString()} tok (gpt-tokenizer)`);
  }
  if (e2eSaved > 0) {
    // 净端到端节省(含召回回填的代价)
    titleParts.push(`净端到端节省 -${e2eSavedPct.toFixed(1)}% (省 ${e2eSaved.toLocaleString()} tok)`);
  } else if (hasBaseline && hasCompressed) {
    titleParts.push("messages 口径无净节省(召回把原文捞回)");
  }
  if (compressedTokens > 0 && hasCompressed) {
    const savedPost = baselineTokens - compressedTokens;
    const pctPost = (savedPost / baselineTokens * 100).toFixed(1);
    titleParts.push(`压缩后 msgs ${compressedTokens.toLocaleString()} tok (纯压缩省 ${savedPost.toLocaleString()}, -${pctPost}%)`);
  } else if (compressedTokens > 0) {
    titleParts.push(`压缩后 msgs ${compressedTokens.toLocaleString()} tok (=baseline,pass-through)`);
  }
  if (inputTokens > 0) {
    const cachePart = cacheReadTokens > 0 ? ` (缓存 ${cacheReadTokens.toLocaleString()})` : "";
    titleParts.push(`实际 LLM input ${inputTokens.toLocaleString()} tokens${cachePart}`);
    if (freshTokens > 0 && freshTokens !== inputTokens) {
      titleParts.push(`本请求新 token ${freshTokens.toLocaleString()}`);
    }
  }
  // helix V1.4 / 2026-10-15: 净额栏(上游实收 prompt = input + cache_read)。
  //   与"压缩后 msgs"是不同计量点:净额是真正发往 provider 的 prompt。
  //   2026-10-16: 净额 − post 拆成「召回回填」(compressionRecallTokens 真值)+「上下文开销」
  //   (system/tools)。注意:净额**含** system/tools,与 messages 口径的节省率不同域,
  //   故只作展示、不参与节省率计算。
  if (netPromptTokens > 0 && hasCompressed) {
    const overhead = Math.max(0, netPromptTokens - compressedTokens - recallTokens);
    const recallPart = recallTokens > 0 ? `, 召回回填 +${recallTokens.toLocaleString()}` : "";
    const overheadPart = overhead > 0 ? `, 上下文开销(system/tools) +${overhead.toLocaleString()}` : "";
    titleParts.push(`净额(上游实收 prompt) ${netPromptTokens.toLocaleString()} tok = input ${inputTokens.toLocaleString()} + cache_read ${cacheReadTokens.toLocaleString()}${recallPart}${overheadPart}`);
  }
  // 2026-10-17: 压缩过但召回回填为 0 时**显式**画出来,免得每次都猜"是没召回还是没渲染"。
  //   0 分两种:响应体里仍残留 recall 调用 = 模型调了但没被执行;否则 = 模型压根没调。
  if (hasCompressed && recallTokens === 0) {
    titleParts.push(logRecallCallLeaked(entry)
      ? "召回回填 0 tok（模型已调用 recall 但未执行）"
      : "召回回填 0 tok（本轮模型未调用）");
  }
  if (inputChars > 0) {
    titleParts.push(`内容 ${inputChars.toLocaleString()}→${outputChars.toLocaleString()} chars (${contentRatioPct}%)`);
  }
  // helix V1.4 / 2026-10-15: 主动 compact(压缩后仍超预算 → 折叠更早历史成摘要)
  const compact = logProactiveCompact(entry);
  if (compact) {
    const sourceLabel = compactSourceLabel(compact.source);
    const budgetPart = compact.budgetTokens !== undefined ? ` · 预算 ${compact.budgetTokens.toLocaleString()} tok` : "";
    titleParts.push(
      `主动 compact(${sourceLabel}): 折叠 ${compact.foldedCount.toLocaleString()} 条 · ${compact.preCompactTokens.toLocaleString()}→${compact.tokensAfter.toLocaleString()} tok${budgetPart}`
    );
  }
  if (hashCount > 0) titleParts.push(`hash 占位 ${hashCount}`);
  if (qaCompressed > 0) titleParts.push(`Q&A 对占位 ${qaCompressed}`);
  if (scenario) titleParts.push(`场景 ${scenario}`);
  return { text, title: titleParts.join(" · ") };
}

/**
 * 2026-10-17: 响应体里是否残留 recall 调用(history_recall / hc_recall)。
 * 压缩过但 compressionRecallTokens==0 时,用它区分两种 0:
 *   true  → 模型**调了** recall,但调用没被执行(未回填)→ 网关/客户端没兑现;
 *   false → 模型压根没调 → 直接凭可见文本作答。
 */
export function logRecallCallLeaked(entry: RequestLogEntry): boolean {
  const text = entry.responseBody?.text ?? "";
  return /"name"\s*:\s*"(history_recall|hc_recall)"/.test(text);
}

function readHeaderNumber(value: string | string[] | undefined): number {
  if (value === undefined) return 0;
  const s = Array.isArray(value) ? value[0] : value;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * helix V1.4 / 2026-10-15: 读取主动 compact 明细。
 * 优先 entry.compressionProactiveCompact(DB 列),fallback 到 response header。
 * 生产落库的 request_headers 里 `x-ccr-*` 会被 sanitize 剥掉,存活的是
 * `x-helix-compressor-compact-json`;两个 key 都读以兼容两种通道。
 */
export function logProactiveCompact(
  entry: RequestLogEntry
): CompressionProactiveCompactStat | undefined {
  if (entry.compressionProactiveCompact) {
    return entry.compressionProactiveCompact;
  }
  return parseCompactHeader(entry.responseHeaders?.["x-ccr-helix-compact-json"])
    ?? parseCompactHeader(entry.requestHeaders?.["x-helix-compressor-compact-json"])
    ?? parseCompactHeader(entry.requestHeaders?.["x-ccr-helix-compact-json"]);
}

function parseCompactHeader(
  value: string | string[] | undefined
): CompressionProactiveCompactStat | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainRecord(parsed) || typeof parsed.source !== "string") return undefined;
    const num = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;
    const tokensAfter = num(parsed.tokensAfter);
    const preCompactTokens = num(parsed.preCompactTokens);
    if (tokensAfter === undefined || preCompactTokens === undefined) return undefined;
    const summaryTokens = num(parsed.summaryTokens);
    const budgetTokens = num(parsed.budgetTokens);
    return {
      coveredCount: num(parsed.coveredCount) ?? 0,
      foldedCount: num(parsed.foldedCount) ?? 0,
      preCompactTokens,
      source: parsed.source,
      ...(summaryTokens !== undefined ? { summaryTokens } : {}),
      ...(budgetTokens !== undefined ? { budgetTokens } : {}),
      tokensAfter
    };
  } catch {
    return undefined;
  }
}

export function compactSourceLabel(source: string): string {
  if (source === "cache") return "缓存命中";
  if (source === "accumulate") return "复用小摘要";
  if (source === "incremental") return "增量合并";
  if (source === "model") return "模型摘要";
  return source || "未知";
}

function readHeaderString(value: string | string[] | undefined): string {
  if (value === undefined) return "";
  const s = Array.isArray(value) ? value[0] : value;
  return typeof s === "string" ? s : "";
}

export function formatLogTokenSummary(entry: RequestLogEntry, t: (value: string) => string, locale?: Intl.LocalesArgument): string {
  if (
    entry.totalTokens === 0 &&
    entry.inputTokens === 0 &&
    entry.outputTokens === 0 &&
    entry.reasoningTokens === 0 &&
    entry.cacheReadTokens === 0 &&
    entry.cacheWriteTokens === 0
  ) {
    return "-";
  }
  const values = [
    `${formatCompactNumber(entry.inputTokens, locale)} ${t("入")}`,
    `${formatCompactNumber(entry.outputTokens, locale)} ${t("出")}`
  ];

  if (entry.cacheReadTokens > 0) {
    values.push(`${formatCompactNumber(entry.cacheReadTokens, locale)} ${t("Cache")}`);
  }
  if (entry.cacheWriteTokens > 0) {
    values.push(`${formatCompactNumber(entry.cacheWriteTokens, locale)} ${t("Cache write")}`);
  }
  if (entry.reasoningTokens > 0) {
    values.push(`${formatCompactNumber(entry.reasoningTokens, locale)} ${t("Thinking")}`);
  }

  return values.join("  ");
}

export function logRequestModel(entry: RequestLogEntry): string {
  return entry.requestedModel || logBodyModel(entry.requestBody) || entry.model || "unknown";
}

export function logResponseModel(entry: RequestLogEntry): string {
  return entry.responseModel ||
    logBodyModel(entry.responseBody) ||
    entry.resolvedModel ||
    entry.model ||
    "unknown";
}

export function logResolvedRouteModel(entry: RequestLogEntry): string {
  const resolvedModel = entry.resolvedModel || entry.model || "unknown";
  return logRouteModelName(resolvedModel);
}

function logRouteModelName(value: string): string {
  const resolvedModel = value.trim();
  if (!resolvedModel || resolvedModel === "unknown") {
    return "unknown";
  }
  const selectorIndex = resolvedModel.indexOf("::");
  const routedModel = selectorIndex >= 0 ? resolvedModel.slice(selectorIndex + 2) : resolvedModel;
  const separator = routedModel.lastIndexOf("/");
  const model = separator >= 0 ? routedModel.slice(separator + 1) : routedModel;
  return model || resolvedModel;
}

export function logBodyModel(body: RequestLogBody | undefined): string | undefined {
  if (!body || body.encoding === "base64" || !body.text.trim()) {
    return undefined;
  }

  const direct = modelFromPayload(parseLogJson(body.text));
  if (direct) {
    return direct;
  }

  for (const payload of parseLogStreamPayloads(body.text)) {
    const model = modelFromPayload(payload);
    if (model) {
      return model;
    }
  }

  return undefined;
}

export function modelFromPayload(payload: unknown): string | undefined {
  if (!isPlainRecord(payload)) {
    return undefined;
  }
  const response = isPlainRecord(payload.response) ? payload.response : payload;
  return stringValue(response.model) ||
    stringValue(payload.model) ||
    stringValue(response.modelVersion) ||
    stringValue(payload.modelVersion);
}

export type FormattedLogBody = {
  json?: unknown;
  text: string;
};

export function logBodyKey(body: RequestLogBody | undefined): string {
  if (!body) {
    return "missing";
  }
  return JSON.stringify([
    body.bodyRef ?? "",
    body.encoding ?? "",
    body.preview ? "preview" : "full",
    body.sizeBytes,
    body.text ?? ""
  ]);
}

export function formatLogBodyView(body: RequestLogBody | undefined): FormattedLogBody {
  if (!body || (!body.text && body.sizeBytes === 0)) {
    return { text: "No body" };
  }
  if (body.encoding === "base64") {
    return { text: body.text || "No body" };
  }

  const text = body.text || "";
  const json = parseLogJson(text);
  if (json !== undefined) {
    const normalizedJson = aggregateParsedStreamJson(json);
    return { json: normalizedJson, text: JSON.stringify(normalizedJson, null, 2) };
  }

  const streamPayloads = parseLogStreamPayloads(text);
  if (streamPayloads.length > 0) {
    const streamedJson = aggregateLogStreamPayloads(streamPayloads);
    return { json: streamedJson, text: JSON.stringify(streamedJson, null, 2) };
  }

  return { text: text || "No body" };
}

export function filterLogText(value: string, query: string): string {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return value;
  }
  const lines = value.split(/\r?\n/);
  const matched = lines.filter((line) => line.toLowerCase().includes(normalized));
  return matched.length > 0 ? matched.join("\n") : "No matching lines";
}

export function parseLogJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function parseLogStreamPayloads(value: string): unknown[] {
  const payloads: unknown[] = [];
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    const payload = line.startsWith("data:")
      ? line.slice(5).trim()
      : line.startsWith("{") || line.startsWith("[")
        ? line
        : "";
    if (!payload || payload === "[DONE]") {
      continue;
    }
    const parsed = parseLogJson(payload);
    if (parsed !== undefined) {
      payloads.push(parsed);
    }
  }
  return payloads;
}

export function aggregateLogStreamPayloads(payloads: unknown[]): Record<string, unknown> {
  const normalizedPayloads = flattenStreamPayloads(payloads);
  return {
    ...(aggregateKnownStreamPayloads(normalizedPayloads) ?? {}),
    streamed_data: payloads
  };
}

function aggregateParsedStreamJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    const aggregated = aggregateKnownStreamPayloads(flattenStreamPayloads(value));
    return aggregated
      ? { ...aggregated, streamed_data: value }
      : value;
  }

  if (!isPlainRecord(value) || !Array.isArray(value.streamed_data)) {
    return value;
  }

  const aggregated = aggregateKnownStreamPayloads(flattenStreamPayloads(value.streamed_data));
  if (!aggregated) {
    return value;
  }

  const { streamed_data: streamedData, ...rest } = value;
  return {
    ...aggregated,
    ...rest,
    streamed_data: streamedData
  };
}

function flattenStreamPayloads(payloads: unknown[]): unknown[] {
  const flattened: unknown[] = [];
  for (const payload of payloads) {
    if (Array.isArray(payload)) {
      flattened.push(...flattenStreamPayloads(payload));
    } else {
      flattened.push(payload);
    }
  }
  return flattened;
}

function aggregateKnownStreamPayloads(payloads: unknown[]): Record<string, unknown> | undefined {
  return aggregateOpenAiStreamPayloads(payloads) ??
    aggregateOpenAiResponsesStreamPayloads(payloads) ??
    aggregateAnthropicStreamPayloads(payloads) ??
    aggregateGeminiStreamPayloads(payloads);
}

type OpenAiStreamChoiceState = {
  deltaTextParts: Map<string, string[]>;
  deltaValues: Map<string, unknown>;
  finishReason?: unknown;
  functionArgumentsParts: string[];
  functionArgumentsValue?: unknown;
  functionName?: string;
  index: string | number;
  logprobs?: unknown;
  order: number;
  role?: string;
  toolCallIndexKeys: Map<string, string>;
  toolCallOrder: string[];
  toolCalls: Map<string, OpenAiStreamToolCallState>;
};

type OpenAiStreamToolCallState = {
  functionArgumentsParts: string[];
  functionArgumentsValue?: unknown;
  functionName?: string;
  id?: string;
  index?: string | number;
  order: number;
  type?: string;
};

const openAiDeltaTextFields = new Set([
  "content",
  "output_text",
  "reasoning",
  "reasoning_content",
  "reasoning_text",
  "refusal",
  "text",
  "thinking"
]);

function aggregateOpenAiStreamPayloads(payloads: unknown[]): Record<string, unknown> | undefined {
  const choices = new Map<string, OpenAiStreamChoiceState>();
  let created: number | undefined;
  let id: string | undefined;
  let model: string | undefined;
  let object: string | undefined;
  let sawChoices = false;
  let serviceTier: string | undefined;
  let systemFingerprint: string | undefined;
  let usage: unknown;

  for (const payload of payloads) {
    if (!isPlainRecord(payload)) {
      continue;
    }

    id ??= stringValue(payload.id);
    model ??= stringValue(payload.model);
    object ??= stringValue(payload.object);
    serviceTier ??= stringValue(payload.service_tier);
    systemFingerprint ??= stringValue(payload.system_fingerprint);
    if (created === undefined && typeof payload.created === "number" && Number.isFinite(payload.created)) {
      created = payload.created;
    }
    if (isPlainRecord(payload.usage)) {
      usage = payload.usage;
    }

    if (!Array.isArray(payload.choices)) {
      continue;
    }

    sawChoices = true;
    payload.choices.forEach((choice, index) => collectOpenAiStreamChoice(choice, choices, index));
  }

  if (!sawChoices) {
    return undefined;
  }

  const aggregated: Record<string, unknown> = {};
  if (id) {
    aggregated.id = id;
  }
  const normalizedObject = normalizeOpenAiStreamObject(object);
  if (normalizedObject) {
    aggregated.object = normalizedObject;
  }
  if (created !== undefined) {
    aggregated.created = created;
  }
  if (model) {
    aggregated.model = model;
  }
  if (systemFingerprint) {
    aggregated.system_fingerprint = systemFingerprint;
  }
  if (serviceTier) {
    aggregated.service_tier = serviceTier;
  }
  aggregated.choices = Array.from(choices.values())
    .sort((left, right) => left.order - right.order)
    .map(formatOpenAiStreamChoice);
  if (usage !== undefined) {
    aggregated.usage = usage;
  }
  return aggregated;
}

function collectOpenAiStreamChoice(
  choice: unknown,
  choices: Map<string, OpenAiStreamChoiceState>,
  fallbackIndex: number
): void {
  if (!isPlainRecord(choice)) {
    return;
  }

  const key = streamIndexKey(choice.index) ?? `position:${fallbackIndex}`;
  const state = ensureOpenAiStreamChoice(choices, key, choice.index ?? fallbackIndex);

  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    state.finishReason = choice.finish_reason;
  }
  if (choice.logprobs !== undefined && choice.logprobs !== null) {
    state.logprobs = choice.logprobs;
  }
  if (typeof choice.text === "string") {
    appendOpenAiDeltaText(state, "text", choice.text);
  }

  collectOpenAiDelta(choice.delta, state);
  collectOpenAiDelta(choice.message, state);
}

function collectOpenAiDelta(delta: unknown, state: OpenAiStreamChoiceState): void {
  if (!isPlainRecord(delta)) {
    return;
  }

  const role = stringValue(delta.role);
  if (role) {
    state.role = role;
  }

  for (const [key, value] of Object.entries(delta)) {
    if (key === "role" || key === "tool_calls" || key === "function_call") {
      continue;
    }
    if (typeof value === "string" && openAiDeltaTextFields.has(key)) {
      appendOpenAiDeltaText(state, key, value);
      continue;
    }
    if (value !== undefined && value !== null) {
      state.deltaValues.set(key, value);
    }
  }

  collectOpenAiStreamToolCalls(delta.tool_calls, state);
  collectOpenAiStreamFunctionCall(delta.function_call, state);
}

function ensureOpenAiStreamChoice(
  choices: Map<string, OpenAiStreamChoiceState>,
  key: string,
  rawIndex: unknown
): OpenAiStreamChoiceState {
  const existing = choices.get(key);
  if (existing) {
    return existing;
  }

  const state: OpenAiStreamChoiceState = {
    deltaTextParts: new Map(),
    deltaValues: new Map(),
    functionArgumentsParts: [],
    index: normalizeStreamIndex(rawIndex) ?? key,
    order: choices.size,
    toolCallIndexKeys: new Map(),
    toolCallOrder: [],
    toolCalls: new Map()
  };
  choices.set(key, state);
  return state;
}

function appendOpenAiDeltaText(state: OpenAiStreamChoiceState, key: string, value: string): void {
  const parts = state.deltaTextParts.get(key) ?? [];
  parts.push(value);
  state.deltaTextParts.set(key, parts);
}

function collectOpenAiStreamFunctionCall(value: unknown, state: OpenAiStreamChoiceState): void {
  if (!isPlainRecord(value)) {
    return;
  }

  const name = stringValue(value.name);
  if (name) {
    state.functionName = name;
  }
  const argumentsValue = value.arguments ?? value.parameters ?? value.input;
  if (typeof argumentsValue === "string") {
    state.functionArgumentsParts.push(argumentsValue);
  } else if (argumentsValue !== undefined && argumentsValue !== null) {
    state.functionArgumentsValue = argumentsValue;
  }
}

function collectOpenAiStreamToolCalls(value: unknown, state: OpenAiStreamChoiceState): void {
  if (!Array.isArray(value)) {
    return;
  }

  value.forEach((item, fallbackIndex) => {
    if (!isPlainRecord(item)) {
      return;
    }

    const rawIndex = normalizeStreamIndex(item.index);
    const indexKey = rawIndex === undefined ? undefined : `index:${rawIndex}`;
    const id = stringValue(item.id) || stringValue(item.call_id) || stringValue(item.tool_call_id);
    const mappedKey = indexKey ? state.toolCallIndexKeys.get(indexKey) : undefined;
    let key = id || mappedKey || indexKey || `position:${fallbackIndex}`;

    if (id && indexKey) {
      key = remapOpenAiStreamToolCall(state, indexKey, id);
    } else if (indexKey && !mappedKey) {
      state.toolCallIndexKeys.set(indexKey, key);
    }

    const tool = ensureOpenAiStreamToolCall(state, key);
    if (id) {
      tool.id = id;
    }
    if (rawIndex !== undefined) {
      tool.index = rawIndex;
    }
    const type = stringValue(item.type);
    if (type) {
      tool.type = type;
    }

    const functionRecord = isPlainRecord(item.function) ? item.function : undefined;
    const functionName = stringValue(functionRecord?.name) || stringValue(item.name);
    if (functionName) {
      tool.functionName = functionName;
    }
    const argumentsValue = functionRecord
      ? functionRecord.arguments ?? functionRecord.parameters ?? functionRecord.input
      : undefined;
    if (typeof argumentsValue === "string") {
      tool.functionArgumentsParts.push(argumentsValue);
    } else if (argumentsValue !== undefined && argumentsValue !== null) {
      tool.functionArgumentsValue = argumentsValue;
    }
  });
}

function remapOpenAiStreamToolCall(state: OpenAiStreamChoiceState, indexKey: string, id: string): string {
  const currentKey = state.toolCallIndexKeys.get(indexKey) ?? indexKey;
  state.toolCallIndexKeys.set(indexKey, id);
  if (currentKey === id || !state.toolCalls.has(currentKey)) {
    return id;
  }

  const tool = state.toolCalls.get(currentKey);
  if (tool) {
    state.toolCalls.delete(currentKey);
    state.toolCalls.set(id, tool);
    const orderIndex = state.toolCallOrder.indexOf(currentKey);
    if (orderIndex >= 0) {
      state.toolCallOrder[orderIndex] = id;
    }
  }
  return id;
}

function ensureOpenAiStreamToolCall(state: OpenAiStreamChoiceState, key: string): OpenAiStreamToolCallState {
  const existing = state.toolCalls.get(key);
  if (existing) {
    return existing;
  }

  const tool: OpenAiStreamToolCallState = {
    functionArgumentsParts: [],
    order: state.toolCallOrder.length
  };
  state.toolCalls.set(key, tool);
  state.toolCallOrder.push(key);
  return tool;
}

function formatOpenAiStreamChoice(state: OpenAiStreamChoiceState): Record<string, unknown> {
  const choice: Record<string, unknown> = {
    index: state.index,
    delta: formatOpenAiStreamChoiceDelta(state)
  };
  if (state.logprobs !== undefined) {
    choice.logprobs = state.logprobs;
  }
  if (state.finishReason !== undefined) {
    choice.finish_reason = state.finishReason;
  }
  return choice;
}

function formatOpenAiStreamChoiceDelta(state: OpenAiStreamChoiceState): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  if (state.role) {
    delta.role = state.role;
  }
  for (const [key, parts] of state.deltaTextParts) {
    delta[key] = parts.join("");
  }
  for (const [key, value] of state.deltaValues) {
    if (delta[key] === undefined) {
      delta[key] = value;
    }
  }

  const toolCalls = formatOpenAiStreamToolCalls(state);
  if (toolCalls.length > 0) {
    delta.tool_calls = toolCalls;
  }
  const functionCall = formatOpenAiStreamFunctionCall(state);
  if (functionCall) {
    delta.function_call = functionCall;
  }
  return delta;
}

function formatOpenAiStreamToolCalls(state: OpenAiStreamChoiceState): Record<string, unknown>[] {
  return state.toolCallOrder
    .map((key) => state.toolCalls.get(key))
    .filter((tool): tool is OpenAiStreamToolCallState => Boolean(tool))
    .sort((left, right) => left.order - right.order)
    .map((tool) => {
      const value: Record<string, unknown> = {};
      if (tool.index !== undefined) {
        value.index = tool.index;
      }
      if (tool.id) {
        value.id = tool.id;
      }
      if (tool.type) {
        value.type = tool.type;
      }
      const functionRecord: Record<string, unknown> = {};
      if (tool.functionName) {
        functionRecord.name = tool.functionName;
      }
      if (tool.functionArgumentsParts.length > 0) {
        functionRecord.arguments = tool.functionArgumentsParts.join("");
      } else if (tool.functionArgumentsValue !== undefined) {
        functionRecord.arguments = tool.functionArgumentsValue;
      }
      if (Object.keys(functionRecord).length > 0) {
        value.function = functionRecord;
      }
      return value;
    });
}

function formatOpenAiStreamFunctionCall(state: OpenAiStreamChoiceState): Record<string, unknown> | undefined {
  const functionCall: Record<string, unknown> = {};
  if (state.functionName) {
    functionCall.name = state.functionName;
  }
  if (state.functionArgumentsParts.length > 0) {
    functionCall.arguments = state.functionArgumentsParts.join("");
  } else if (state.functionArgumentsValue !== undefined) {
    functionCall.arguments = state.functionArgumentsValue;
  }
  return Object.keys(functionCall).length > 0 ? functionCall : undefined;
}

function normalizeOpenAiStreamObject(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.endsWith(".chunk") ? value.slice(0, -".chunk".length) : value;
}

type OpenAiResponseItemState = {
  argumentsParts: string[];
  argumentsValue?: unknown;
  callId?: string;
  content: Map<string, OpenAiResponseContentPartState>;
  extras: Record<string, unknown>;
  id?: string;
  name?: string;
  order: number;
  outputIndex: string | number;
  role?: string;
  status?: string;
  type?: string;
};

type OpenAiResponseContentPartState = {
  annotations?: unknown;
  extras: Record<string, unknown>;
  index: string | number;
  order: number;
  refusalParts: string[];
  refusalValue?: string;
  textParts: string[];
  textValue?: string;
  type?: string;
};

function aggregateOpenAiResponsesStreamPayloads(payloads: unknown[]): Record<string, unknown> | undefined {
  const output = new Map<string, OpenAiResponseItemState>();
  let response: Record<string, unknown> = {};
  let sawResponsesEvent = false;

  for (const payload of payloads) {
    if (!isPlainRecord(payload)) {
      continue;
    }

    const type = stringValue(payload.type);
    const nestedResponse = isPlainRecord(payload.response) ? payload.response : undefined;
    if (type?.startsWith("response.") || nestedResponse) {
      sawResponsesEvent = true;
    }

    if (nestedResponse) {
      response = { ...response, ...nestedResponse };
    }

    if (type === "response.output_item.added" || type === "response.output_item.done") {
      collectOpenAiResponseOutputItem(payload.item, output, payload.output_index);
      continue;
    }

    if (type === "response.content_part.added" || type === "response.content_part.done") {
      collectOpenAiResponseContentPart(payload.part, output, payload.output_index, payload.content_index);
      continue;
    }

    if (type === "response.output_text.delta" || type === "response.refusal.delta") {
      const part = ensureOpenAiResponseContentPart(output, payload.output_index, payload.content_index);
      if (typeof payload.delta === "string") {
        if (type === "response.refusal.delta") {
          part.type = "refusal";
          part.refusalParts.push(payload.delta);
        } else {
          part.type = part.type || "output_text";
          part.textParts.push(payload.delta);
        }
      }
      continue;
    }

    if (type === "response.output_text.done" || type === "response.refusal.done") {
      const part = ensureOpenAiResponseContentPart(output, payload.output_index, payload.content_index);
      if (type === "response.refusal.done") {
        part.type = "refusal";
        if (typeof payload.refusal === "string") {
          part.refusalValue = payload.refusal;
        }
      } else {
        part.type = part.type || "output_text";
        if (typeof payload.text === "string") {
          part.textValue = payload.text;
        }
      }
      continue;
    }

    if (type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta") {
      const part = ensureOpenAiResponseContentPart(output, payload.output_index, payload.content_index);
      if (typeof payload.delta === "string") {
        part.type = type === "response.reasoning_summary_text.delta" ? "summary_text" : "reasoning_text";
        part.textParts.push(payload.delta);
      }
      continue;
    }

    if (type === "response.reasoning_text.done" || type === "response.reasoning_summary_text.done") {
      const part = ensureOpenAiResponseContentPart(output, payload.output_index, payload.content_index);
      part.type = type === "response.reasoning_summary_text.done" ? "summary_text" : "reasoning_text";
      if (typeof payload.text === "string") {
        part.textValue = payload.text;
      }
      continue;
    }

    if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
      const item = ensureOpenAiResponseItem(output, payload.output_index);
      item.type = item.type || "function_call";
      if (typeof payload.delta === "string") {
        item.argumentsParts.push(payload.delta);
      }
      if (typeof payload.arguments === "string") {
        item.argumentsValue = payload.arguments;
      }
    }
  }

  if (!sawResponsesEvent) {
    return undefined;
  }

  const aggregated: Record<string, unknown> = { ...response };
  if (!aggregated.object) {
    aggregated.object = "response";
  }
  const outputItems = Array.from(output.values())
    .sort((left, right) => left.order - right.order)
    .map(formatOpenAiResponseOutputItem);
  if (outputItems.length > 0) {
    aggregated.output = outputItems;
  }

  const outputText = collectOpenAiResponseOutputText(outputItems.length > 0 ? outputItems : aggregated.output);
  if (outputText) {
    aggregated.output_text = outputText;
  }
  return aggregated;
}

function collectOpenAiResponseOutputItem(
  value: unknown,
  output: Map<string, OpenAiResponseItemState>,
  rawOutputIndex: unknown
): void {
  if (!isPlainRecord(value)) {
    return;
  }

  const item = ensureOpenAiResponseItem(output, value.output_index ?? rawOutputIndex);
  item.id = stringValue(value.id) || item.id;
  item.callId = stringValue(value.call_id) || item.callId;
  item.name = stringValue(value.name) || item.name;
  item.role = stringValue(value.role) || item.role;
  item.status = stringValue(value.status) || item.status;
  item.type = stringValue(value.type) || item.type;

  for (const [key, itemValue] of Object.entries(value)) {
    if (["arguments", "call_id", "content", "id", "name", "output_index", "role", "status", "type"].includes(key)) {
      continue;
    }
    if (itemValue !== undefined && itemValue !== null) {
      item.extras[key] = itemValue;
    }
  }

  if (typeof value.arguments === "string") {
    item.argumentsValue = value.arguments;
  } else if (value.arguments !== undefined && value.arguments !== null) {
    item.argumentsValue = value.arguments;
  }

  if (Array.isArray(value.content)) {
    value.content.forEach((part, index) => collectOpenAiResponseContentPart(part, output, item.outputIndex, index));
  }
}

function collectOpenAiResponseContentPart(
  value: unknown,
  output: Map<string, OpenAiResponseItemState>,
  rawOutputIndex: unknown,
  rawContentIndex: unknown
): void {
  if (!isPlainRecord(value)) {
    return;
  }

  const part = ensureOpenAiResponseContentPart(output, rawOutputIndex, value.content_index ?? rawContentIndex);
  part.type = stringValue(value.type) || part.type;
  if (typeof value.text === "string") {
    part.textValue = value.text;
  }
  if (typeof value.refusal === "string") {
    part.refusalValue = value.refusal;
  }
  if (value.annotations !== undefined && value.annotations !== null) {
    part.annotations = value.annotations;
  }
  for (const [key, partValue] of Object.entries(value)) {
    if (["annotations", "content_index", "refusal", "text", "type"].includes(key)) {
      continue;
    }
    if (partValue !== undefined && partValue !== null) {
      part.extras[key] = partValue;
    }
  }
}

function ensureOpenAiResponseItem(output: Map<string, OpenAiResponseItemState>, rawOutputIndex: unknown): OpenAiResponseItemState {
  const outputIndex = normalizeStreamIndex(rawOutputIndex) ?? output.size;
  const key = String(outputIndex);
  const existing = output.get(key);
  if (existing) {
    return existing;
  }

  const item: OpenAiResponseItemState = {
    argumentsParts: [],
    content: new Map(),
    extras: {},
    order: output.size,
    outputIndex
  };
  output.set(key, item);
  return item;
}

function ensureOpenAiResponseContentPart(
  output: Map<string, OpenAiResponseItemState>,
  rawOutputIndex: unknown,
  rawContentIndex: unknown
): OpenAiResponseContentPartState {
  const item = ensureOpenAiResponseItem(output, rawOutputIndex);
  const contentIndex = normalizeStreamIndex(rawContentIndex) ?? item.content.size;
  const key = String(contentIndex);
  const existing = item.content.get(key);
  if (existing) {
    return existing;
  }

  const part: OpenAiResponseContentPartState = {
    extras: {},
    index: contentIndex,
    order: item.content.size,
    refusalParts: [],
    textParts: []
  };
  item.content.set(key, part);
  return part;
}

function formatOpenAiResponseOutputItem(item: OpenAiResponseItemState): Record<string, unknown> {
  const value: Record<string, unknown> = { ...item.extras };
  if (item.id) {
    value.id = item.id;
  }
  if (item.type) {
    value.type = item.type;
  }
  if (item.status) {
    value.status = item.status;
  }
  if (item.role) {
    value.role = item.role;
  }
  if (item.callId) {
    value.call_id = item.callId;
  }
  if (item.name) {
    value.name = item.name;
  }

  const content = Array.from(item.content.values())
    .sort((left, right) => left.order - right.order)
    .map(formatOpenAiResponseContentPart);
  if (content.length > 0) {
    value.content = content;
  }
  if (item.argumentsParts.length > 0) {
    value.arguments = item.argumentsParts.join("");
  } else if (item.argumentsValue !== undefined) {
    value.arguments = item.argumentsValue;
  }
  return value;
}

function formatOpenAiResponseContentPart(part: OpenAiResponseContentPartState): Record<string, unknown> {
  const value: Record<string, unknown> = { ...part.extras };
  if (part.type) {
    value.type = part.type;
  }
  const text = part.textValue ?? (part.textParts.length > 0 ? part.textParts.join("") : undefined);
  if (text !== undefined) {
    value.text = text;
  }
  const refusal = part.refusalValue ?? (part.refusalParts.length > 0 ? part.refusalParts.join("") : undefined);
  if (refusal !== undefined) {
    value.refusal = refusal;
  }
  if (part.annotations !== undefined) {
    value.annotations = part.annotations;
  }
  return value;
}

function collectOpenAiResponseOutputText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const textParts: string[] = [];
  for (const item of value) {
    if (!isPlainRecord(item) || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      if (isPlainRecord(part) && stringValue(part.type) === "output_text" && typeof part.text === "string") {
        textParts.push(part.text);
      }
    }
  }
  return textParts.join("");
}

type AnthropicStreamBlockState = {
  extras: Record<string, unknown>;
  id?: string;
  index: string | number;
  inputJsonParts: string[];
  inputValue?: unknown;
  name?: string;
  order: number;
  signature?: string;
  textParts: string[];
  thinkingParts: string[];
  type?: string;
};

function aggregateAnthropicStreamPayloads(payloads: unknown[]): Record<string, unknown> | undefined {
  const content = new Map<string, AnthropicStreamBlockState>();
  let message: Record<string, unknown> = {};
  let sawAnthropicEvent = false;
  let usage: Record<string, unknown> | undefined;

  for (const payload of payloads) {
    if (!isPlainRecord(payload)) {
      continue;
    }

    const type = stringValue(payload.type);
    if (type && [
      "content_block_delta",
      "content_block_start",
      "content_block_stop",
      "message_delta",
      "message_start",
      "message_stop",
      "ping"
    ].includes(type)) {
      sawAnthropicEvent = true;
    }

    if (type === "message_start" && isPlainRecord(payload.message)) {
      message = { ...message, ...payload.message };
      if (isPlainRecord(payload.message.usage)) {
        usage = { ...(usage ?? {}), ...payload.message.usage };
      }
      if (Array.isArray(payload.message.content)) {
        payload.message.content.forEach((block, index) => collectAnthropicContentBlockStart(content, block, index));
      }
      continue;
    }

    if (type === "content_block_start") {
      collectAnthropicContentBlockStart(content, payload.content_block, payload.index);
      continue;
    }

    if (type === "content_block_delta" && isPlainRecord(payload.delta)) {
      collectAnthropicContentBlockDelta(content, payload.delta, payload.index);
      continue;
    }

    if (type === "message_delta") {
      if (isPlainRecord(payload.delta)) {
        message = { ...message, ...payload.delta };
      }
      if (isPlainRecord(payload.usage)) {
        usage = { ...(usage ?? {}), ...payload.usage };
      }
    }
  }

  if (!sawAnthropicEvent) {
    return undefined;
  }

  const aggregated: Record<string, unknown> = { ...message };
  aggregated.type = stringValue(aggregated.type) || "message";
  aggregated.role = stringValue(aggregated.role) || "assistant";
  const contentBlocks = Array.from(content.values())
    .sort((left, right) => left.order - right.order)
    .map(formatAnthropicContentBlock);
  if (contentBlocks.length > 0) {
    aggregated.content = contentBlocks;
  }
  if (usage) {
    aggregated.usage = usage;
  }
  return aggregated;
}

function collectAnthropicContentBlockStart(
  content: Map<string, AnthropicStreamBlockState>,
  value: unknown,
  rawIndex: unknown
): void {
  if (!isPlainRecord(value)) {
    return;
  }

  const block = ensureAnthropicContentBlock(content, rawIndex);
  block.id = stringValue(value.id) || block.id;
  block.name = stringValue(value.name) || block.name;
  block.type = stringValue(value.type) || block.type;
  if (typeof value.text === "string") {
    block.textParts.push(value.text);
  }
  if (typeof value.thinking === "string") {
    block.thinkingParts.push(value.thinking);
  }
  if (value.input !== undefined && value.input !== null) {
    block.inputValue = value.input;
  }
  for (const [key, blockValue] of Object.entries(value)) {
    if (["id", "input", "name", "text", "thinking", "type"].includes(key)) {
      continue;
    }
    if (blockValue !== undefined && blockValue !== null) {
      block.extras[key] = blockValue;
    }
  }
}

function collectAnthropicContentBlockDelta(
  content: Map<string, AnthropicStreamBlockState>,
  delta: Record<string, unknown>,
  rawIndex: unknown
): void {
  const block = ensureAnthropicContentBlock(content, rawIndex);
  const type = stringValue(delta.type);
  if (type === "text_delta" && typeof delta.text === "string") {
    block.type = block.type || "text";
    block.textParts.push(delta.text);
    return;
  }
  if (type === "thinking_delta" && typeof delta.thinking === "string") {
    block.type = block.type || "thinking";
    block.thinkingParts.push(delta.thinking);
    return;
  }
  if (type === "input_json_delta" && typeof delta.partial_json === "string") {
    block.inputJsonParts.push(delta.partial_json);
    return;
  }
  if (type === "signature_delta" && typeof delta.signature === "string") {
    block.signature = delta.signature;
    return;
  }
  for (const [key, value] of Object.entries(delta)) {
    if (key !== "type" && value !== undefined && value !== null) {
      block.extras[key] = value;
    }
  }
}

function ensureAnthropicContentBlock(content: Map<string, AnthropicStreamBlockState>, rawIndex: unknown): AnthropicStreamBlockState {
  const index = normalizeStreamIndex(rawIndex) ?? content.size;
  const key = String(index);
  const existing = content.get(key);
  if (existing) {
    return existing;
  }

  const block: AnthropicStreamBlockState = {
    extras: {},
    index,
    inputJsonParts: [],
    order: content.size,
    textParts: [],
    thinkingParts: []
  };
  content.set(key, block);
  return block;
}

function formatAnthropicContentBlock(block: AnthropicStreamBlockState): Record<string, unknown> {
  const value: Record<string, unknown> = { ...block.extras };
  const type = block.type || (block.inputJsonParts.length > 0 || block.inputValue !== undefined ? "tool_use" : "text");
  value.type = type;
  if (block.id) {
    value.id = block.id;
  }
  if (block.name) {
    value.name = block.name;
  }
  if (block.textParts.length > 0) {
    value.text = block.textParts.join("");
  }
  if (block.thinkingParts.length > 0) {
    value.thinking = block.thinkingParts.join("");
  }
  if (block.signature) {
    value.signature = block.signature;
  }
  if (block.inputJsonParts.length > 0) {
    value.input = parseJsonLikeText(block.inputJsonParts.join(""));
  } else if (block.inputValue !== undefined) {
    value.input = block.inputValue;
  }
  return value;
}

type GeminiCandidateState = {
  contentRole?: string;
  extras: Record<string, unknown>;
  finishReason?: string;
  index: string | number;
  order: number;
  parts: Map<string, GeminiPartState>;
};

type GeminiPartState = {
  extras: Record<string, unknown>;
  index: string | number;
  order: number;
  textParts: string[];
};

function aggregateGeminiStreamPayloads(payloads: unknown[]): Record<string, unknown> | undefined {
  const candidates = new Map<string, GeminiCandidateState>();
  let sawGeminiPayload = false;
  let modelVersion: string | undefined;
  let promptFeedback: unknown;
  let responseId: string | undefined;
  let usageMetadata: unknown;

  for (const payload of payloads) {
    if (!isPlainRecord(payload)) {
      continue;
    }

    if (Array.isArray(payload.candidates) || isPlainRecord(payload.usageMetadata)) {
      sawGeminiPayload = true;
    }
    modelVersion = stringValue(payload.modelVersion) || modelVersion;
    responseId = stringValue(payload.responseId) || responseId;
    if (payload.promptFeedback !== undefined && payload.promptFeedback !== null) {
      promptFeedback = payload.promptFeedback;
    }
    if (isPlainRecord(payload.usageMetadata)) {
      usageMetadata = payload.usageMetadata;
    }
    if (Array.isArray(payload.candidates)) {
      payload.candidates.forEach((candidate, index) => collectGeminiCandidate(candidates, candidate, index));
    }
  }

  if (!sawGeminiPayload) {
    return undefined;
  }

  const aggregated: Record<string, unknown> = {
    candidates: Array.from(candidates.values())
      .sort((left, right) => left.order - right.order)
      .map(formatGeminiCandidate)
  };
  if (usageMetadata !== undefined) {
    aggregated.usageMetadata = usageMetadata;
  }
  if (modelVersion) {
    aggregated.modelVersion = modelVersion;
  }
  if (responseId) {
    aggregated.responseId = responseId;
  }
  if (promptFeedback !== undefined) {
    aggregated.promptFeedback = promptFeedback;
  }
  return aggregated;
}

function collectGeminiCandidate(
  candidates: Map<string, GeminiCandidateState>,
  value: unknown,
  fallbackIndex: number
): void {
  if (!isPlainRecord(value)) {
    return;
  }

  const candidate = ensureGeminiCandidate(candidates, value.index ?? fallbackIndex);
  candidate.finishReason = stringValue(value.finishReason) || candidate.finishReason;
  if (isPlainRecord(value.content)) {
    candidate.contentRole = stringValue(value.content.role) || candidate.contentRole;
    if (Array.isArray(value.content.parts)) {
      value.content.parts.forEach((part, index) => collectGeminiPart(candidate, part, index));
    }
  }
  for (const [key, candidateValue] of Object.entries(value)) {
    if (["content", "finishReason", "index"].includes(key)) {
      continue;
    }
    if (candidateValue !== undefined && candidateValue !== null) {
      candidate.extras[key] = candidateValue;
    }
  }
}

function collectGeminiPart(candidate: GeminiCandidateState, value: unknown, rawIndex: unknown): void {
  if (!isPlainRecord(value)) {
    return;
  }

  const part = ensureGeminiPart(candidate, rawIndex);
  if (typeof value.text === "string") {
    part.textParts.push(value.text);
  }
  for (const [key, partValue] of Object.entries(value)) {
    if (key === "text") {
      continue;
    }
    if (partValue !== undefined && partValue !== null) {
      part.extras[key] = partValue;
    }
  }
}

function ensureGeminiCandidate(candidates: Map<string, GeminiCandidateState>, rawIndex: unknown): GeminiCandidateState {
  const index = normalizeStreamIndex(rawIndex) ?? candidates.size;
  const key = String(index);
  const existing = candidates.get(key);
  if (existing) {
    return existing;
  }

  const candidate: GeminiCandidateState = {
    extras: {},
    index,
    order: candidates.size,
    parts: new Map()
  };
  candidates.set(key, candidate);
  return candidate;
}

function ensureGeminiPart(candidate: GeminiCandidateState, rawIndex: unknown): GeminiPartState {
  const index = normalizeStreamIndex(rawIndex) ?? candidate.parts.size;
  const key = String(index);
  const existing = candidate.parts.get(key);
  if (existing) {
    return existing;
  }

  const part: GeminiPartState = {
    extras: {},
    index,
    order: candidate.parts.size,
    textParts: []
  };
  candidate.parts.set(key, part);
  return part;
}

function formatGeminiCandidate(candidate: GeminiCandidateState): Record<string, unknown> {
  const value: Record<string, unknown> = { ...candidate.extras, index: candidate.index };
  const parts = Array.from(candidate.parts.values())
    .sort((left, right) => left.order - right.order)
    .map(formatGeminiPart);
  if (parts.length > 0 || candidate.contentRole) {
    value.content = {
      parts,
      ...(candidate.contentRole ? { role: candidate.contentRole } : {})
    };
  }
  if (candidate.finishReason) {
    value.finishReason = candidate.finishReason;
  }
  return value;
}

function formatGeminiPart(part: GeminiPartState): Record<string, unknown> {
  const value: Record<string, unknown> = { ...part.extras };
  if (part.textParts.length > 0) {
    value.text = part.textParts.join("");
  }
  return value;
}

function parseJsonLikeText(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return value;
  }
  return parseLogJson(trimmed) ?? value;
}

function normalizeStreamIndex(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function streamIndexKey(value: unknown): string | undefined {
  const index = normalizeStreamIndex(value);
  return index === undefined ? undefined : String(index);
}

export function isJsonContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

export function jsonContainerEntries(value: Record<string, unknown> | unknown[]): Array<[string, unknown]> {
  if (Array.isArray(value)) {
    return value.map((item, index) => [String(index), item]);
  }
  return Object.entries(value);
}

export function createInitialLogJsonExpandedPaths(value: unknown): Set<string> {
  return isJsonContainer(value) ? new Set(["$"]) : new Set();
}

export function jsonChildPath(parentPath: string, key: string): string {
  return `${parentPath}/${encodeURIComponent(key)}`;
}

export function jsonContainerSummary(value: Record<string, unknown> | unknown[]): string {
  if (Array.isArray(value)) {
    return `Array(${value.length})`;
  }
  return `Object(${Object.keys(value).length})`;
}
