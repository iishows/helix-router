/**
 * V1.17(2026-11-17):把 base64 图片上传到 COS,消息里只留短 URL。
 *
 * 实测计费(doitx-3.0-pro):
 *   - user 消息 `image_url`(data URL):按图片解析,228 prompt tokens;
 *   - tool 消息里的 base64(字符串化块数组):按文本计费,同一张图 53,291 tokens。
 * 所以 tool 消息里的 base64 是 1M 爆炸的根因。上游接受 http(s) 图片 URL(实测 220 tokens),
 * 且 doitx MCP 提供 `cos_upload_image`(返回公网 URL)。
 *
 * 策略:
 *   - scope="tool"(默认 all 之外的保守选项):只替换 tool_result 内嵌媒体 → 换成短文本 URL;
 *   - scope="all":用户消息媒体也换成 URL 形式(image → source.url / image_url → url);
 *   - 上传失败/未配置 → 保持原样,后续仍由占位符/召回兜底;
 *   - 结果按 base64 sha256 缓存,同一张图后续轮次零上传。
 *
 * 配置(helix-compressor plugin config):
 *   imageUploadEnabled / imageUploadMcpUrl / imageUploadMcpToken /
 *   imageUploadMinChars / imageUploadTimeoutMs / imageUploadScope
 * 环境变量兜底:CCR_IMAGE_UPLOAD_MCP_URL / CCR_IMAGE_UPLOAD_MCP_TOKEN。
 */

import { createHash } from "node:crypto";

export type CosUploadScope = "tool" | "all";

export type CosUploadSettings = {
  enabled: boolean;
  mcpUrl: string;
  mcpToken: string;
  /** 仅上传 base64 字符数 ≥ 该值的媒体(默认 32KB)。 */
  minDataChars: number;
  timeoutMs: number;
  scope: CosUploadScope;
  /** 大文本工具输出上传开关(默认 true,随 enabled 生效)。 */
  textEnabled: boolean;
  /** tool 输出文本 ≥ 该字符数才上传(默认 32KB)。 */
  textMinChars: number;
  /** 替换后保留的预览字符数(默认 400)。 */
  textPreviewChars: number;
};

export const COS_UPLOAD_DEFAULTS: CosUploadSettings = {
  enabled: false,
  mcpUrl: "",
  mcpToken: "",
  // 强制上传:所有图片都走 COS,不再外发 base64。
  minDataChars: 1,
  timeoutMs: 30_000,
  // V1.17:启用上传后,用户图与工具图都必须走 URL(配置要求:不外发 base64)。
  scope: "all",
  textEnabled: true,
  textMinChars: 32 * 1024,
  textPreviewChars: 400
};

type MediaSlot = {
  msgIndex: number;
  blockIndex: number;
  innerIndex?: number;
  innerIsString?: boolean;
  /** 媒体嵌在 tool_result 内。 */
  nested: boolean;
  type: string;
  mime: string;
  data: string;
};

const uploadCache = new Map<string, string>();
const UPLOAD_CACHE_MAX = 128;
/**
 * MCP 故障退避(60s):窗口内直接跳过上传,避免每个请求都卡在
 * initialize/超时上。上传关闭时调用方会走「禁止外发 base64」的清理 pass。
 */
const UPLOAD_BACKOFF_MS = 60_000;
let uploadBackoffUntil = 0;

/** 测试用:清空上传缓存、MCP 会话与退避状态。 */
export function _clearUploadCacheForTest(): void {
  uploadCache.clear();
  sessions.clear();
  failedUploads.clear();
  uploadBackoffUntil = 0;
  lastRejectionWarningAt = 0;
}

/** 小并发执行(默认 3),用于同请求内多张图片/多段文本的上传。 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 上传消息里的 base64 媒体并用 URL 替换。copy-on-write:无变化返回原数组。
 */
export async function uploadMessagesMedia(
  messages: unknown[],
  settings: CosUploadSettings,
  requestId?: string
): Promise<{ messages: unknown[]; uploaded: number; failed: number }> {
  if (!settings.enabled || !settings.mcpUrl) {
    return { messages, uploaded: 0, failed: 0 };
  }
  const slots = collectMediaSlots(messages);
  const eligible = slots.filter((slot) =>
    slot.data.length >= settings.minDataChars &&
    (settings.scope === "all" || slot.nested)
  );
  if (eligible.length === 0) return { messages, uploaded: 0, failed: 0 };

  let uploaded = 0;
  let failed = 0;
  // 同一请求内的重复图片只上传一次;上传并发 3,缩短多图首轮的等待。
  const pending = new Map<string, Promise<string | undefined>>();
  const urls = await mapLimit(eligible, 3, (slot) => {
    const key = createHash("sha256").update(slot.data).digest("hex");
    let promise = pending.get(key);
    if (!promise) {
      promise = uploadImageBase64(slot.data, slot.mime, settings, requestId);
      pending.set(key, promise);
    }
    return promise;
  });
  const replacements: Array<{ slot: MediaSlot; url: string }> = [];
  for (let index = 0; index < eligible.length; index += 1) {
    const url = urls[index];
    if (!url) {
      failed += 1;
      continue;
    }
    replacements.push({ slot: eligible[index], url });
    uploaded += 1;
  }
  if (replacements.length === 0) return { messages, uploaded, failed };
  return { messages: replaceMediaWithUrls(messages, replacements), uploaded, failed };
}

/** 单张图上传(带 sha256 缓存)。返回公网 URL 或 undefined。 */
export async function uploadImageBase64(
  data: string,
  mime: string,
  settings: CosUploadSettings,
  requestId?: string
): Promise<string | undefined> {
  if (!settings.enabled || !settings.mcpUrl || !data) return undefined;
  if (Date.now() < uploadBackoffUntil) return undefined;
  const key = createHash("sha256").update(data).digest("hex");
  const cached = uploadCache.get(key);
  if (cached) return cached;
  if (isUploadFailed(key)) return undefined;

  const url = await callCosUpload({
    data,
    contentType: mime || "image/png",
    filename: `ccr-${requestId ? requestId.slice(0, 24) : "image"}-${key.slice(0, 8)}${mimeToExt(mime)}`,
    settings,
    cacheKey: key
  });
  if (url) cacheUpload(key, url);
  return url;
}

/**
 * 上传大段文本工具输出并替换成 URL + 预览。
 *
 * 适用:tool_result / role:"tool" 的纯文本内容 ≥ textMinChars。
 * 替换后模型只看到 URL 与短预览;需要全文时由客户端的 fetch 工具按需读取
 * (COS 是公网可访问的)。上传失败保持原文,后续仍由占位符/召回压缩兜底。
 */
export async function uploadLargeToolOutputs(
  messages: unknown[],
  settings: CosUploadSettings,
  requestId?: string
): Promise<{ messages: unknown[]; uploaded: number; failed: number }> {
  if (!settings.enabled || !settings.textEnabled || !settings.mcpUrl) {
    return { messages, uploaded: 0, failed: 0 };
  }
  const targets = collectToolTextTargets(messages, settings.textMinChars);
  if (targets.length === 0) return { messages, uploaded: 0, failed: 0 };

  let uploaded = 0;
  let failed = 0;
  const pending = new Map<string, Promise<string | undefined>>();
  const urls = await mapLimit(targets, 3, (target) => {
    const key = createHash("sha256").update("text:").update(target.text).digest("hex");
    let promise = pending.get(key);
    if (!promise) {
      promise = uploadTextContent(target.text, settings, requestId);
      pending.set(key, promise);
    }
    return promise;
  });
  const output = messages.slice();
  for (let index = 0; index < targets.length; index += 1) {
    const url = urls[index];
    if (!url) {
      failed += 1;
      continue;
    }
    uploaded += 1;
    const target = targets[index];
    const marker = textMarker(target.text, url, settings.textPreviewChars);
    output[target.msgIndex] = applyToolTextReplacement(output[target.msgIndex], target, marker);
  }
  return { messages: uploaded > 0 ? output : messages, uploaded, failed };
}

/** 单段文本上传(带 sha256 缓存)。 */
export async function uploadTextContent(
  text: string,
  settings: CosUploadSettings,
  requestId?: string
): Promise<string | undefined> {
  if (!settings.enabled || !settings.mcpUrl || !text) return undefined;
  if (Date.now() < uploadBackoffUntil) return undefined;
  const key = createHash("sha256").update("text:").update(text).digest("hex");
  const cached = uploadCache.get(key);
  if (cached) return cached;
  if (isUploadFailed(key)) return undefined;

  const json = looksLikeJson(text);
  const url = await callCosUpload({
    data: Buffer.from(text, "utf8").toString("base64"),
    contentType: json ? "application/json" : "text/plain",
    filename: `ccr-${requestId ? requestId.slice(0, 24) : "text"}-${key.slice(0, 8)}${json ? ".json" : ".txt"}`,
    settings,
    cacheKey: key
  });
  if (url) cacheUpload(key, url);
  return url;
}

/** 上传到 COS(图片/文本共用),返回公网 URL。 */
async function callCosUpload(input: {
  data: string;
  contentType: string;
  filename: string;
  settings: CosUploadSettings;
  cacheKey: string;
}): Promise<string | undefined> {
  const session = await ensureSession(input.settings);
  if (!session) {
    uploadBackoffUntil = Date.now() + UPLOAD_BACKOFF_MS;
    return undefined;
  }
  const payload = {
    jsonrpc: "2.0",
    id: `upload-${Date.now()}`,
    method: "tools/call",
    params: {
      name: "cos_upload_image",
      arguments: {
        image_base64: input.data,
        content_type: input.contentType,
        filename: input.filename
      }
    }
  };
  const response = await postMcp(session, payload, input.settings);
  const url = extractUrl(response.payload);
  if (url) return url;

  const looksHtml = response.text.trimStart().startsWith("<");
  const deterministic = looksHtml || (response.status >= 400 && response.status < 500);
  if (deterministic) {
    // 典型的 Nginx/WAF 请求体上限(返回 200 + HTML)。这是“这份内容太大”的确定性拒绝,
    // 不是服务故障:不要全局退避(会连累小图),只对该内容做短期负缓存。
    markUploadFailed(input.cacheKey);
    warnDeterministicRejection(response.status, looksHtml);
    return undefined;
  }
  // 会话可能已过期/服务临时故障:丢掉会话并进入退避窗口。
  sessions.delete(sessionKey(input.settings));
  uploadBackoffUntil = Date.now() + UPLOAD_BACKOFF_MS;
  return undefined;
}

const FAILED_UPLOAD_TTL_MS = 10 * 60 * 1000;
const failedUploads = new Map<string, number>();
let lastRejectionWarningAt = 0;

function markUploadFailed(key: string): void {
  failedUploads.set(key, Date.now() + FAILED_UPLOAD_TTL_MS);
  while (failedUploads.size > 512) {
    const oldest = failedUploads.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    failedUploads.delete(oldest);
  }
}

function isUploadFailed(key: string): boolean {
  const until = failedUploads.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  failedUploads.delete(key);
  return false;
}

function warnDeterministicRejection(status: number, looksHtml: boolean): void {
  const now = Date.now();
  if (now - lastRejectionWarningAt < 5 * 60 * 1000) return;
  lastRejectionWarningAt = now;
  const detail = looksHtml ? "HTML body (HTTP " + status + ")" : "HTTP " + status;
  console.warn(
    `[helix-compressor] COS upload rejected by gateway: ${detail}. ` +
      "This usually means the /mcp endpoint's Nginx/WAF request-body limit is too small " +
      "(raise client_max_body_size / parameter buffer, or whitelist /mcp). " +
      "Oversized media will be replaced with markers until uploads succeed."
  );
}

function cacheUpload(key: string, url: string): void {
  uploadCache.set(key, url);
  while (uploadCache.size > UPLOAD_CACHE_MAX) {
    const oldest = uploadCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    uploadCache.delete(oldest);
  }
}

// ============= MCP 会话 =============

type McpSession = { url: string; sessionId: string };
const sessions = new Map<string, McpSession>();

function sessionKey(settings: CosUploadSettings): string {
  return `${settings.mcpUrl}|${settings.mcpToken}`;
}

async function ensureSession(settings: CosUploadSettings): Promise<McpSession | undefined> {
  const key = sessionKey(settings);
  const existing = sessions.get(key);
  if (existing) return existing;
  try {
    const headers = baseHeaders(settings);
    const res = await fetchWithTimeout(settings.mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "ccr-helix-image-upload", version: "1.0" }
        }
      })
    }, settings.timeoutMs);
    if (!res.ok) return undefined;
    const sessionId = res.headers.get("mcp-session-id");
    await res.text();
    if (!sessionId) return undefined;
    const session: McpSession = { url: settings.mcpUrl, sessionId };
    // notifications/initialized 不带 id,失败不阻断后续 tools/call。
    await fetchWithTimeout(settings.mcpUrl, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    }, settings.timeoutMs).then((r) => r.text()).catch(() => "");
    sessions.set(key, session);
    return session;
  } catch {
    return undefined;
  }
}

async function postMcp(
  session: McpSession,
  payload: unknown,
  settings: CosUploadSettings
): Promise<{ payload?: unknown; status: number; text: string }> {
  try {
    const res = await fetchWithTimeout(session.url, {
      method: "POST",
      headers: { ...baseHeaders(settings), "mcp-session-id": session.sessionId },
      body: JSON.stringify(payload)
    }, settings.timeoutMs);
    const text = await res.text();
    return { payload: res.ok ? parseJsonRpc(text) : undefined, status: res.status, text };
  } catch {
    return { status: 0, text: "" };
  }
}

function baseHeaders(settings: CosUploadSettings): Record<string, string> {
  return {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
    ...(settings.mcpToken ? { authorization: `Bearer ${settings.mcpToken}` } : {})
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonRpc(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  // SSE: 取第一条 data: {...}
  const match = trimmed.match(/data:\s*(\{.*\})/s);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

function extractUrl(response: unknown): string | undefined {
  if (!isRecord(response)) return undefined;
  const result = isRecord(response.result) ? response.result : undefined;
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const item of content) {
    if (!isRecord(item) || typeof item.text !== "string") continue;
    const match = item.text.match(/https?:\/\/[^\s"'<>]+/);
    if (match) return match[0];
  }
  return undefined;
}

// ============= 大文本工具输出 =============

type ToolTextTarget =
  | { kind: "openai"; msgIndex: number; text: string }
  | { kind: "string"; msgIndex: number; blockIndex: number; text: string }
  | { kind: "blocks"; msgIndex: number; blockIndex: number; textIndexes: number[]; text: string };

function collectToolTextTargets(messages: unknown[], minChars: number): ToolTextTarget[] {
  const targets: ToolTextTarget[] = [];
  for (let msgIndex = 0; msgIndex < messages.length; msgIndex += 1) {
    const message = messages[msgIndex];
    if (!isRecord(message)) continue;
    const content = message.content;
    if (typeof content === "string") {
      if (message.role !== "tool") continue;
      if (isUploadMarker(content)) continue;
      if (content.length >= minChars) {
        targets.push({ kind: "openai", msgIndex, text: content });
      }
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const block = content[blockIndex];
      if (!isRecord(block) || block.type !== "tool_result") continue;
      if (typeof block.content === "string") {
        if (isUploadMarker(block.content)) continue;
        if (block.content.length >= minChars) {
          targets.push({ msgIndex, blockIndex, kind: "string", text: block.content });
        }
        continue;
      }
      const inner = normalizeBlocks(block.content);
      if (!inner) continue;
      const textIndexes: number[] = [];
      const parts: string[] = [];
      for (let index = 0; index < inner.length; index += 1) {
        const item = inner[index];
        if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
          textIndexes.push(index);
          parts.push(item.text);
        }
      }
      const text = parts.join("\n");
      if (textIndexes.length === 0 || text.length < minChars || isUploadMarker(text)) continue;
      targets.push({ msgIndex, blockIndex, kind: "blocks", textIndexes, text });
    }
  }
  return targets;
}

function applyToolTextReplacement(
  message: unknown,
  target: ToolTextTarget,
  marker: string
): unknown {
  const msg = message as Record<string, unknown>;
  if (target.kind === "openai") {
    return { ...msg, content: marker };
  }
  const content = ((msg.content as unknown[]) ?? []).slice();
  const block = content[target.blockIndex] as Record<string, unknown>;
  if (target.kind === "string") {
    content[target.blockIndex] = { ...block, content: marker };
    return { ...msg, content };
  }
  const inner = (normalizeBlocks(block.content) ?? []).slice();
  const first = target.textIndexes[0];
  const textIndexes = new Set(target.textIndexes);
  const nextInner: Array<Record<string, unknown>> = [];
  for (let index = 0; index < inner.length; index += 1) {
    if (textIndexes.has(index)) {
      if (index === first) nextInner.push({ type: "text", text: marker });
      continue;
    }
    nextInner.push(inner[index]);
  }
  content[target.blockIndex] = { ...block, content: nextInner };
  return { ...msg, content };
}

function textMarker(text: string, url: string, previewChars: number): string {
  const limit = Math.max(0, Math.floor(previewChars));
  const preview = text.slice(0, limit).replace(/\s+/g, " ").trim();
  return `[tool output uploaded: ${text.length} chars; url: ${url}; preview: ${preview}${text.length > limit ? "..." : ""}]`;
}

function isUploadMarker(text: string): boolean {
  return text.trimStart().startsWith("[tool output uploaded:");
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

// ============= 消息遍历/替换 =============

function collectMediaSlots(messages: unknown[]): MediaSlot[] {
  const slots: MediaSlot[] = [];
  for (let msgIndex = 0; msgIndex < messages.length; msgIndex += 1) {
    const message = messages[msgIndex];
    if (!isRecord(message)) continue;
    const content = message.content;
    if (typeof content === "string") {
      // OpenAI 形状的 role:"tool":content 是"块数组的 JSON 字符串"。
      if (message.role !== "tool") continue;
      const inner = normalizeBlocks(content);
      if (!inner) continue;
      for (let innerIndex = 0; innerIndex < inner.length; innerIndex += 1) {
        const nested = mediaOfBlock(inner[innerIndex]);
        if (!nested) continue;
        slots.push({
          msgIndex,
          blockIndex: -1,
          innerIndex,
          innerIsString: true,
          nested: true,
          type: nested.type,
          mime: nested.mime,
          data: nested.data
        });
      }
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const block = content[blockIndex];
      if (!isRecord(block)) continue;
      const top = mediaOfBlock(block);
      if (top) {
        slots.push({ msgIndex, blockIndex, nested: false, type: top.type, mime: top.mime, data: top.data });
        continue;
      }
      if (block.type !== "tool_result") continue;
      const innerIsString = typeof block.content === "string";
      const inner = normalizeBlocks(block.content);
      if (!inner) continue;
      for (let innerIndex = 0; innerIndex < inner.length; innerIndex += 1) {
        const nested = mediaOfBlock(inner[innerIndex]);
        if (!nested) continue;
        slots.push({
          msgIndex,
          blockIndex,
          innerIndex,
          innerIsString,
          nested: true,
          type: nested.type,
          mime: nested.mime,
          data: nested.data
        });
      }
    }
  }
  return slots;
}

/**
 * V1.17:把所有残余 base64 媒体替换成文本标记(上传失败/未启用上传时的兜底)。
 * 不写召回、不留原文——召回也不会再把大 base64 带回来。
 */
export function stripBase64Media(
  messages: unknown[],
  marker: (mime: string, dataLength: number) => string
): { messages: unknown[]; stripped: number } {
  const slots = collectMediaSlots(messages);
  if (slots.length === 0) return { messages, stripped: 0 };
  const replacements = slots.map((slot) => ({ slot, text: marker(slot.mime, slot.data.length) }));
  return { messages: replaceMediaWithText(messages, replacements), stripped: slots.length };
}

function replaceMediaWithText(
  messages: unknown[],
  replacements: Array<{ slot: MediaSlot; text: string }>
): unknown[] {
  const byMessage = new Map<number, Array<{ slot: MediaSlot; text: string }>>();
  for (const replacement of replacements) {
    const list = byMessage.get(replacement.slot.msgIndex);
    if (list) list.push(replacement);
    else byMessage.set(replacement.slot.msgIndex, [replacement]);
  }
  const output = messages.slice();
  for (const [msgIndex, list] of byMessage) {
    const message = messages[msgIndex] as Record<string, unknown>;
    if (list.every(({ slot }) => slot.blockIndex === -1)) {
      const inner = (normalizeBlocks(message.content) ?? []).slice();
      for (const { slot, text } of list) {
        inner[slot.innerIndex!] = { type: "text", text };
      }
      output[msgIndex] = { ...message, content: JSON.stringify(inner) };
      continue;
    }
    const content = ((message.content as unknown[]) ?? []).slice();
    for (const { slot, text } of list) {
      if (slot.innerIndex === undefined) {
        content[slot.blockIndex] = { type: "text", text };
        continue;
      }
      const outer = content[slot.blockIndex] as Record<string, unknown>;
      const inner = (normalizeBlocks(outer.content) ?? []).slice();
      inner[slot.innerIndex] = { type: "text", text };
      content[slot.blockIndex] = {
        ...outer,
        content: slot.innerIsString ? JSON.stringify(inner) : inner
      };
    }
    output[msgIndex] = { ...message, content };
  }
  return output;
}

function replaceMediaWithUrls(
  messages: unknown[],
  replacements: Array<{ slot: MediaSlot; url: string }>
): unknown[] {
  const byMessage = new Map<number, Array<{ slot: MediaSlot; url: string }>>();
  for (const replacement of replacements) {
    const list = byMessage.get(replacement.slot.msgIndex);
    if (list) list.push(replacement);
    else byMessage.set(replacement.slot.msgIndex, [replacement]);
  }
  const output = messages.slice();
  for (const [msgIndex, list] of byMessage) {
    const message = messages[msgIndex] as Record<string, unknown>;
    if (list.every(({ slot }) => slot.blockIndex === -1)) {
      // OpenAI 形状:content 是块数组 JSON 字符串,整体重写。
      const inner = (normalizeBlocks(message.content) ?? []).slice();
      for (const { slot, url } of list) {
        inner[slot.innerIndex!] = { type: "text", text: `[image uploaded: ${url}]` };
      }
      output[msgIndex] = { ...message, content: JSON.stringify(inner) };
      continue;
    }
    const content = ((message.content as unknown[]) ?? []).slice();
    for (const { slot, url } of list) {
      if (slot.innerIndex === undefined) {
        content[slot.blockIndex] = urlBlock(slot.type, url);
        continue;
      }
      const outer = content[slot.blockIndex] as Record<string, unknown>;
      const inner = (normalizeBlocks(outer.content) ?? []).slice();
      // tool 消息里的媒体本来就按文本计费/不被上游当图:换成短文本 URL 最安全。
      inner[slot.innerIndex] = { type: "text", text: `[image uploaded: ${url}]` };
      content[slot.blockIndex] = {
        ...outer,
        content: slot.innerIsString ? JSON.stringify(inner) : inner
      };
    }
    output[msgIndex] = { ...message, content };
  }
  return output;
}

function urlBlock(type: string, url: string): Record<string, unknown> {
  if (type === "image_url") {
    return { type: "image_url", image_url: { url } };
  }
  return { type: "image", source: { type: "url", url } };
}

function mediaOfBlock(block: unknown): { type: string; mime: string; data: string } | undefined {
  if (!isRecord(block)) return undefined;
  if (block.type === "image") {
    const source = isRecord(block.source) ? block.source : undefined;
    if (!source || source.type !== "base64" || typeof source.data !== "string") return undefined;
    return {
      type: "image",
      mime: typeof source.media_type === "string" ? source.media_type : "",
      data: source.data
    };
  }
  if (block.type === "image_url") {
    const imageUrl = isRecord(block.image_url) ? block.image_url : undefined;
    const url = imageUrl && typeof imageUrl.url === "string" ? imageUrl.url : "";
    const match = url.match(/^data:([^;,]+);base64,(.*)$/s);
    if (!match) return undefined;
    return { type: "image_url", mime: match[1], data: match[2] };
  }
  return undefined;
}

function normalizeBlocks(content: unknown): Array<Record<string, unknown>> | undefined {
  if (Array.isArray(content)) return content as Array<Record<string, unknown>>;
  if (typeof content !== "string") return undefined;
  const trimmed = content.trim();
  if (!trimmed.startsWith("[")) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function mimeToExt(mime: string): string {
  if (/jpe?g/i.test(mime)) return ".jpg";
  if (/png/i.test(mime)) return ".png";
  if (/webp/i.test(mime)) return ".webp";
  if (/gif/i.test(mime)) return ".gif";
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
