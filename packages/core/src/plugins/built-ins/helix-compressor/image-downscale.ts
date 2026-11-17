/**
 * V1.16(2026-11-17):媒体降采样。
 *
 * 实测计费(2026-11-17,doitx-3.0-pro):
 *   - 同一张图放在 user 消息的 `image_url`(data URL):prompt_tokens=228(按图片解析);
 *   - 放在 tool 消息(字符串化块数组):prompt_tokens=53,291(base64 按文本计费)。
 *   所以 1M 爆炸的根因是「base64 进了 tool 消息」,不是当前轮用户图。
 *
 * 主要用途:**上传前压缩**。线上 /mcp 请求体有 4MB 硬上限(超出返回 413),
 * cos-upload 对超过预算的图片先降采样再上传,见 `compressForUpload`。
 * 压缩失败(格式不支持/压不下来)时放弃上传,由调用方折成标记,绝不外发 base64。
 *
 * 执行位置:优先 worker_threads,避免纯 JS 解码阻塞网关事件循环;worker 不可用/超时
 * → 回退主线程同步。解码像素上限 `maxInputPixels`(默认 24MP),超过直接跳过;
 * 任何失败都保持原图。结果按(base64 + 参数)缓存。
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

export type ImageDownscaleSettings = {
  enabled: boolean;
  /** 仅当 base64 字符数 ≥ 此值才尝试(默认 64KB)。 */
  minDataChars: number;
  /** 目标最长边(默认 1024px)。 */
  maxEdge: number;
  /** 输出 JPEG 质量(默认 72)。 */
  jpegQuality: number;
  /** 单图编码后 base64 目标上限,超过则继续降档(默认 128KB)。 */
  targetMaxChars: number;
  /** 单请求全部 base64 媒体的总量上限(默认 512KB),超过则从最大的继续压。 */
  totalMaxChars: number;
  /** 解码像素上限,防病态大图(默认 24MP)。 */
  maxInputPixels: number;
};

export const IMAGE_DOWNSCALE_DEFAULTS: ImageDownscaleSettings = {
  enabled: true,
  // 用户图片按视觉解析、几乎不花 token:默认只对超大 payload 做保护性降采样。
  minDataChars: 4 * 1024 * 1024,
  maxEdge: 1024,
  jpegQuality: 72,
  targetMaxChars: 128 * 1024,
  totalMaxChars: 8 * 1024 * 1024,
  maxInputPixels: 24_000_000
};

export type ImageDownscaleStats = {
  /** 被降采样的媒体块数。 */
  count: number;
  /** 节省的 base64 字符数(近似 token 节省)。 */
  savedChars: number;
};

type DecodedImage = { width: number; height: number; data: Uint8Array };
export type DownscaledImage = { data: string; mime: string; savedChars: number };

type MediaEntry = {
  msgIndex: number;
  blockIndex: number;
  /** 媒体嵌在 `tool_result.content` 内时的下标。 */
  innerIndex?: number;
  innerIsString?: boolean;
  mime: string;
  /** 当前(可能已降采样)的数据。 */
  data: string;
  originalData: string;
};

type DownscaleOptions = {
  /** 只处理这些消息下标(降采样前置 pass 用:只动压缩器会保留的「最近消息」)。 */
  onlyIndices?: Set<number>;
  /** 是否执行单请求媒体总量预算(默认 true)。 */
  enforceTotalBudget?: boolean;
};

// ============= 缓存 =============

const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_CHARS = 32 * 1024 * 1024;
const downscaleCache = new Map<string, DownscaledImage | null>();
let downscaleCacheChars = 0;

/** 清空缓存(测试用)。 */
export function _clearDownscaleCacheForTest(): void {
  downscaleCache.clear();
  downscaleCacheChars = 0;
}

export function downscaleCacheKey(data: string, settings: ImageDownscaleSettings): string {
  // 参数必须进 key：总量预算会把同一张图以更严格的目标再压一次，
  // 若只按数据 hash 缓存会直接返回上一档的较大结果，预算永远压不下去。
  const signature = `${settings.maxEdge}|${settings.jpegQuality}|${settings.targetMaxChars}|${settings.maxInputPixels}`;
  return createHash("sha256").update(data).update("|").update(signature).digest("hex");
}

export function downscaleCacheGet(key: string): DownscaledImage | null | undefined {
  return downscaleCache.get(key);
}

export function downscaleCacheSet(key: string, value: DownscaledImage | null): void {
  const existing = downscaleCache.get(key);
  if (existing) downscaleCacheChars -= existing.data.length;
  downscaleCache.set(key, value);
  if (value) downscaleCacheChars += value.data.length;
  while (downscaleCache.size > CACHE_MAX_ENTRIES || downscaleCacheChars > CACHE_MAX_CHARS) {
    const oldest = downscaleCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const removed = downscaleCache.get(oldest);
    if (removed) downscaleCacheChars -= removed.data.length;
    downscaleCache.delete(oldest);
  }
}

// ============= 公共 API =============

/**
 * 对一批 messages 里的 base64 媒体块做降采样。copy-on-write:
 * 无变化时返回原数组,避免无谓复制。
 */
export async function downscaleMessagesMedia(
  messages: unknown[],
  settings: ImageDownscaleSettings,
  options: DownscaleOptions = {}
): Promise<{ messages: unknown[]; stats: ImageDownscaleStats }> {
  const stats: ImageDownscaleStats = { count: 0, savedChars: 0 };
  if (!settings.enabled || !Array.isArray(messages) || messages.length === 0) {
    return { messages, stats };
  }

  const entries = collectMediaEntries(messages);
  if (entries.length === 0) return { messages, stats };

  const eligible = options.onlyIndices
    ? entries.filter((entry) => options.onlyIndices!.has(entry.msgIndex))
    : entries;

  // 1) 单图降采样
  for (const entry of eligible) {
    const down = await downscaleImageDataAsync(entry.data, entry.mime, settings);
    if (!down) continue;
    stats.count += 1;
    stats.savedChars += down.savedChars;
    entry.data = down.data;
    entry.mime = down.mime;
  }

  // 2) 单请求媒体总量预算:从最大的开始继续压,直到总量 ≤ totalMaxChars
  if (options.enforceTotalBudget !== false && settings.totalMaxChars > 0) {
    let total = entries.reduce((sum, entry) => sum + entry.data.length, 0);
    if (total > settings.totalMaxChars) {
      const ordered = [...entries].sort((a, b) => b.data.length - a.data.length);
      for (const entry of ordered) {
        if (total <= settings.totalMaxChars) break;
        const excess = total - settings.totalMaxChars;
        const allowance = Math.max(16 * 1024, entry.data.length - excess);
        const before = entry.data.length;
        const down = await downscaleImageDataAsync(entry.data, entry.mime, {
          ...settings,
          minDataChars: 1,
          targetMaxChars: Math.min(settings.targetMaxChars, allowance)
        });
        if (!down) continue;
        entry.data = down.data;
        entry.mime = down.mime;
        total -= before - entry.data.length;
        stats.count += 1;
        stats.savedChars += down.savedChars;
      }
    }
  }

  return { messages: rebuildMessages(messages, entries), stats };
}

/**
 * 单张图降采样(同步)。输入输出都是 base64 字符串。
 * 返回 undefined 表示不处理(不需要/不支持/失败),调用方保持原图。
 */
export function downscaleImageData(
  data: string,
  mime: string,
  settings: ImageDownscaleSettings
): DownscaledImage | undefined {
  if (!settings.enabled || typeof data !== "string" || data.length < settings.minDataChars) {
    return undefined;
  }
  const key = downscaleCacheKey(data, settings);
  const cached = downscaleCache.get(key);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  const result = downscaleUncached(data, mime, settings);
  downscaleCacheSet(key, result ?? null);
  return result;
}

/** 单张图降采样(worker 优先,失败回退同步)。 */
export async function downscaleImageDataAsync(
  data: string,
  mime: string,
  settings: ImageDownscaleSettings
): Promise<DownscaledImage | undefined> {
  if (!settings.enabled || typeof data !== "string" || data.length < settings.minDataChars) {
    return undefined;
  }
  const key = downscaleCacheKey(data, settings);
  const cached = downscaleCache.get(key);
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const workerResult = await runOnWorker(data, mime, settings);
  if (workerResult.ok) {
    downscaleCacheSet(key, workerResult.result ?? null);
    return workerResult.result ?? undefined;
  }
  if (workerResult.timedOut) {
    // 超时说明这张图的处理可能异常地慢:跳过本次(保持原图),不缓存空值,
    //   避免把一次偶发超时变成永久不处理。
    return undefined;
  }

  // worker 不可用/异常:同步兜底(结果仍缓存;worker 故障不缓存空值)
  if (process.env.CCR_IMAGE_DOWNSCALE_DEBUG === "1") {
    console.log("[image-downscale] worker unavailable, sync fallback");
  }
  const result = downscaleUncached(data, mime, settings);
  downscaleCacheSet(key, result ?? null);
  return result;
}

// ============= worker =============

type WorkerOutcome = { ok: boolean; result?: DownscaledImage | null; timedOut?: boolean };

const WORKER_TIMEOUT_MS = 20_000;
let worker: Worker | undefined;
let workerSeq = 0;
const workerPending = new Map<number, {
  resolve: (value: DownscaledImage | null) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();

function workerEnabled(): boolean {
  return process.env.CCR_IMAGE_DOWNSCALE_WORKER !== "off";
}

function resolveWorkerPath(): string | undefined {
  if (typeof __dirname !== "string" || !__dirname) return undefined;
  const candidate = join(__dirname, "image-downscale-worker.js");
  return existsSync(candidate) ? candidate : undefined;
}

function ensureWorker(): Worker | undefined {
  if (!workerEnabled()) return undefined;
  if (worker) return worker;
  const workerPath = resolveWorkerPath();
  if (!workerPath) return undefined;
  try {
    const spawned = new Worker(workerPath);
    spawned.unref();
    spawned.on("message", (message: { id: number; result?: DownscaledImage | null; error?: string }) => {
      const pending = workerPending.get(message.id);
      if (!pending) return;
      workerPending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result ?? null);
    });
    const failAll = (error: Error) => {
      const entries = [...workerPending.values()];
      workerPending.clear();
      for (const pending of entries) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      if (worker === spawned) worker = undefined;
    };
    spawned.on("error", failAll);
    spawned.on("exit", () => failAll(new Error("image downscale worker exited")));
    worker = spawned;
    if (process.env.CCR_IMAGE_DOWNSCALE_DEBUG === "1") {
      console.log(`[image-downscale] using worker: ${workerPath}`);
    }
    return worker;
  } catch {
    worker = undefined;
    return undefined;
  }
}

function runOnWorker(
  data: string,
  mime: string,
  settings: ImageDownscaleSettings
): Promise<WorkerOutcome> {
  const active = ensureWorker();
  if (!active) return Promise.resolve({ ok: false });
  const id = ++workerSeq;
  return new Promise<WorkerOutcome>((resolve) => {
    const timer = setTimeout(() => {
      const pending = workerPending.get(id);
      if (!pending) return;
      workerPending.delete(id);
      // 超时认为 worker 已不可用:终止并跳过本次(不再同步重试同一份重活)。
      const dead = worker;
      worker = undefined;
      void dead?.terminate().catch(() => undefined);
      resolve({ ok: false, timedOut: true });
    }, WORKER_TIMEOUT_MS);
    workerPending.set(id, {
      resolve: (result) => resolve({ ok: true, result }),
      reject: () => resolve({ ok: false }),
      timer
    });
    try {
      active.postMessage({ id, data, mime, settings });
    } catch {
      const pending = workerPending.get(id);
      if (pending) {
        workerPending.delete(id);
        clearTimeout(pending.timer);
      }
      resolve({ ok: false });
    }
  });
}

// ============= 核心算法 =============

function downscaleUncached(
  data: string,
  mime: string,
  settings: ImageDownscaleSettings
): DownscaledImage | undefined {
  let decoded: DecodedImage | undefined;
  try {
    decoded = decodeImage(Buffer.from(data, "base64"), mime);
  } catch {
    return undefined;
  }
  if (!decoded) return undefined;
  if (decoded.width <= 0 || decoded.height <= 0) return undefined;
  if (decoded.width * decoded.height > settings.maxInputPixels) return undefined;

  const longest = Math.max(decoded.width, decoded.height);
  if (longest <= settings.maxEdge && data.length <= settings.targetMaxChars) {
    return undefined;
  }

  const usePng = /png/i.test(mime || "") && imageHasAlpha(decoded.data);
  const edges = [...new Set([
    settings.maxEdge,
    Math.min(settings.maxEdge, 768),
    Math.min(settings.maxEdge, 512),
    Math.min(settings.maxEdge, 384),
    Math.min(settings.maxEdge, 256),
    Math.min(settings.maxEdge, 192),
    Math.min(settings.maxEdge, 128)
  ])].filter((edge) => edge > 0);

  let best: { data: string; mime: string } | undefined;
  try {
    for (let rung = 0; rung < edges.length; rung += 1) {
      const edge = edges[rung];
      const scale = Math.min(1, edge / longest);
      const width = Math.max(1, Math.round(decoded.width * scale));
      const height = Math.max(1, Math.round(decoded.height * scale));
      const rgba = width === decoded.width && height === decoded.height
        ? decoded.data
        : resizeBox(decoded.data, decoded.width, decoded.height, width, height);
      // 每降一档再降 6 点质量(下限 45):高熵/多图累加时只靠缩边可能仍超目标。
      const quality = Math.max(45, settings.jpegQuality - rung * 6);
      const encoded = encodeImage(rgba, width, height, usePng, quality);
      const encodedData = encoded.bytes.toString("base64");
      if (!best || encodedData.length < best.data.length) {
        best = { data: encodedData, mime: encoded.mime };
      }
      if (encodedData.length <= settings.targetMaxChars) break;
    }
  } catch {
    return undefined;
  }

  if (!best || best.data.length >= data.length) return undefined;
  return { ...best, savedChars: data.length - best.data.length };
}

function decodeImage(bytes: Buffer, mime: string): DecodedImage | undefined {
  if (isJpeg(bytes) || /jpe?g/i.test(mime)) {
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
    return { width: decoded.width, height: decoded.height, data: decoded.data as Uint8Array };
  }
  if (isPng(bytes) || /png/i.test(mime)) {
    const png = PNG.sync.read(bytes);
    return { width: png.width, height: png.height, data: png.data };
  }
  return undefined;
}

function encodeImage(
  rgba: Uint8Array,
  width: number,
  height: number,
  usePng: boolean,
  quality: number
): { bytes: Buffer; mime: string } {
  if (usePng) {
    const bytes = PNG.sync.write(
      { width, height, data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength) } as PNG,
      { colorType: 6 }
    );
    return { bytes, mime: "image/png" };
  }
  const encoded = jpeg.encode(
    { data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height },
    clampQuality(quality)
  );
  return { bytes: encoded.data, mime: "image/jpeg" };
}

/** 面积平均(box filter):纯降采样场景下质量/速度平衡最好。 */
function resizeBox(
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number
): Uint8Array {
  const out = new Uint8Array(dstWidth * dstHeight * 4);
  const xRatio = srcWidth / dstWidth;
  const yRatio = srcHeight / dstHeight;
  for (let y = 0; y < dstHeight; y += 1) {
    const sy0 = Math.floor(y * yRatio);
    const sy1 = Math.max(sy0 + 1, Math.min(srcHeight, Math.ceil((y + 1) * yRatio)));
    for (let x = 0; x < dstWidth; x += 1) {
      const sx0 = Math.floor(x * xRatio);
      const sx1 = Math.max(sx0 + 1, Math.min(srcWidth, Math.ceil((x + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        let offset = (sy * srcWidth + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx += 1, offset += 4) {
          r += src[offset];
          g += src[offset + 1];
          b += src[offset + 2];
          a += src[offset + 3];
          n += 1;
        }
      }
      const target = (y * dstWidth + x) * 4;
      out[target] = Math.round(r / n);
      out[target + 1] = Math.round(g / n);
      out[target + 2] = Math.round(b / n);
      out[target + 3] = Math.round(a / n);
    }
  }
  return out;
}

function imageHasAlpha(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) return true;
  }
  return false;
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isPng(bytes: Buffer): boolean {
  return bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function clampQuality(value: number): number {
  if (!Number.isFinite(value)) return 72;
  return Math.max(1, Math.min(100, Math.round(value)));
}

// ============= messages 遍历 =============

/**
 * V1.17:收集所有可定位的 base64 媒体块(顶层 + tool_result 内嵌)。
 * 供「禁止外发 base64」的最终清理 pass 使用。
 */
export function collectBase64MediaSlots(messages: unknown[]): Array<{
  msgIndex: number;
  blockIndex: number;
  innerIndex?: number;
  innerIsString?: boolean;
  mime: string;
  data: string;
  block: Record<string, unknown>;
}> {
  const slots: Array<{
    msgIndex: number;
    blockIndex: number;
    innerIndex?: number;
    innerIsString?: boolean;
    mime: string;
    data: string;
    block: Record<string, unknown>;
  }> = [];
  for (let msgIndex = 0; msgIndex < messages.length; msgIndex += 1) {
    const message = messages[msgIndex];
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const block = content[blockIndex];
      if (!isRecord(block)) continue;
      const top = mediaOfBlock(block);
      if (top) {
        slots.push({ msgIndex, blockIndex, mime: top.mime, data: top.data, block });
        continue;
      }
      if (block.type !== "tool_result") continue;
      const innerIsString = typeof block.content === "string";
      const inner = normalizeBlocks(block.content);
      if (!inner) continue;
      for (let innerIndex = 0; innerIndex < inner.length; innerIndex += 1) {
        const innerBlock = inner[innerIndex];
        const nested = mediaOfBlock(innerBlock);
        if (!nested || !isRecord(innerBlock)) continue;
        slots.push({
          msgIndex,
          blockIndex,
          innerIndex,
          innerIsString,
          mime: nested.mime,
          data: nested.data,
          block: innerBlock
        });
      }
    }
  }
  return slots;
}

/** 把指定媒体块替换成占位符文本(copy-on-write)。 */
export function replaceBase64MediaSlots(
  messages: unknown[],
  replacements: Array<{
    slot: { msgIndex: number; blockIndex: number; innerIndex?: number; innerIsString?: boolean };
    text: string;
  }>
): unknown[] {
  if (replacements.length === 0) return messages;
  const byMessage = new Map<number, typeof replacements>();
  for (const replacement of replacements) {
    const list = byMessage.get(replacement.slot.msgIndex);
    if (list) list.push(replacement);
    else byMessage.set(replacement.slot.msgIndex, [replacement]);
  }
  const output = messages.slice();
  for (const [msgIndex, list] of byMessage) {
    const message = messages[msgIndex] as Record<string, unknown>;
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

function collectMediaEntries(messages: unknown[]): MediaEntry[] {
  const entries: MediaEntry[] = [];
  for (let msgIndex = 0; msgIndex < messages.length; msgIndex += 1) {
    const message = messages[msgIndex];
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const block = content[blockIndex];
      if (!isRecord(block)) continue;
      const top = mediaOfBlock(block);
      if (top) {
        entries.push({ msgIndex, blockIndex, mime: top.mime, data: top.data, originalData: top.data });
        continue;
      }
      if (block.type !== "tool_result") continue;
      const innerIsString = typeof block.content === "string";
      const inner = normalizeBlocks(block.content);
      if (!inner) continue;
      for (let innerIndex = 0; innerIndex < inner.length; innerIndex += 1) {
        const nested = mediaOfBlock(inner[innerIndex]);
        if (!nested) continue;
        entries.push({
          msgIndex,
          blockIndex,
          innerIndex,
          innerIsString,
          mime: nested.mime,
          data: nested.data,
          originalData: nested.data
        });
      }
    }
  }
  return entries;
}

function mediaOfBlock(block: unknown): { mime: string; data: string } | undefined {
  if (!isRecord(block)) return undefined;
  if (block.type === "image") {
    const source = block.source as Record<string, unknown> | undefined;
    if (!source || source.type !== "base64" || typeof source.data !== "string") return undefined;
    return { mime: typeof source.media_type === "string" ? source.media_type : "", data: source.data };
  }
  if (block.type === "image_url") {
    const imageUrl = block.image_url as Record<string, unknown> | undefined;
    const url = imageUrl && typeof imageUrl.url === "string" ? imageUrl.url : "";
    const match = url.match(/^data:([^;,]+);base64,(.*)$/s);
    if (!match) return undefined;
    return { mime: match[1], data: match[2] };
  }
  return undefined;
}

function rebuildMessages(messages: unknown[], entries: MediaEntry[]): unknown[] {
  const changed = entries.filter((entry) => entry.data !== entry.originalData);
  if (changed.length === 0) return messages;

  const byMessage = new Map<number, MediaEntry[]>();
  for (const entry of changed) {
    const list = byMessage.get(entry.msgIndex);
    if (list) list.push(entry);
    else byMessage.set(entry.msgIndex, [entry]);
  }

  const output = messages.slice();
  for (const [msgIndex, list] of byMessage) {
    const message = messages[msgIndex] as Record<string, unknown>;
    const content = ((message.content as unknown[]) ?? []).slice();
    for (const entry of list) {
      if (entry.innerIndex === undefined) {
        content[entry.blockIndex] = withMediaData(content[entry.blockIndex], entry);
        continue;
      }
      const outer = content[entry.blockIndex] as Record<string, unknown>;
      const inner = (normalizeBlocks(outer.content) ?? []).slice();
      inner[entry.innerIndex] = withMediaData(inner[entry.innerIndex], entry);
      content[entry.blockIndex] = {
        ...outer,
        content: entry.innerIsString ? JSON.stringify(inner) : inner
      };
    }
    output[msgIndex] = { ...message, content };
  }
  return output;
}

function withMediaData(block: unknown, entry: MediaEntry): Record<string, unknown> {
  const b = block as Record<string, unknown>;
  if (b.type === "image") {
    const source = b.source as Record<string, unknown>;
    return { ...b, source: { ...source, data: entry.data, media_type: entry.mime } };
  }
  const imageUrl = b.image_url as Record<string, unknown>;
  return { ...b, image_url: { ...imageUrl, url: `data:${entry.mime};base64,${entry.data}` } };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
