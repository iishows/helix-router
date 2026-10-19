/**
 * Helix 主动 compact 摘要缓存 — append-only JSONL（零依赖）
 *
 * 设计动机（见 docs 计划 `fizzy-meandering-russell`）:
 *   网关在 helix 压缩后仍超 token 预算时，会折叠更早历史成一个摘要再转发。
 *   同一会话后续轮次的历史「前缀」通常不变（只是追加新轮），因此按
 *   `sessionId + 折叠前缀 hash` 缓存摘要，前缀未变即命中复用（零额外上游调用），
 *   前缀变长则只摘要 delta 并与旧摘要合并。
 *
 * 语义（对齐 helix-recall-local-store.ts）:
 *   - 内容寻址:key = sha256(sessionId + "|" + foldHash);同 key 重复写是幂等(后者覆盖)。
 *   - 每行一条完整 JSON,以 '\n' 结尾;读者忽略不以 '\n' 结尾的末行(半写)。
 *   - 目录由环境变量 HELIX_RECALL_CACHE_DIR 指定(与 recall 缓存同源,子目录 helix-compact)。
 *   - TTL 默认 3 天。
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";

export interface CompactSummaryEntry {
  /** 内容寻址 key = sha256(sessionId + "|" + foldHash)。 */
  key: string;
  /** 会话 id(对齐 context-archive 的 resolveArchiveSessionId 候选)。 */
  sessionId: string;
  /** 被摘要覆盖的每条消息的 hash(按序)。用于前缀命中判定。 */
  messageHashes: string[];
  /** 摘要文本。 */
  summary: string;
  /** 该摘要覆盖的消息条数(= messageHashes.length)。 */
  coveredCount: number;
  /** 写入时间(ms)。 */
  createdAt?: number;
  /** 过期时间(ms)。 */
  expiresAt?: number;
}

const CACHE_FILE_NAME = "summaries.jsonl";
const COMPACT_DIR_NAME = "helix-compact";
const DEFAULT_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const COMPACT_SIZE_BYTES = 32 * 1024 * 1024;
const MAX_LINE_READ_BYTES = 4 * 1024 * 1024;
/**
 * 前缀复用所需的最低同位一致率。见 `approxPrefixLength` 说明:compact 跑在
 * helix-compressor 之后,压缩器每轮会重写 1~4 条消息的字节,严格前缀必然 miss。
 * 线上实测(真实会话重放):严格前缀 0% 命中,≥0.95 命中 90%
 * (0.90~0.99 区间平坦,故取 0.95)。
 */
const PREFIX_MATCH_MIN_RATIO = 0.95;

/** 解析缓存目录:HELIX_RECALL_CACHE_DIR 下的 helix-compact 子目录。未配置则抛错。 */
export function resolveCompactSummaryDir(): string {
  const dir = process.env.HELIX_RECALL_CACHE_DIR;
  if (!dir) {
    throw new Error("HELIX_RECALL_CACHE_DIR is not set; cannot access helix compact summary cache");
  }
  return pathJoin(dir, COMPACT_DIR_NAME);
}

// ============= 进程内索引 (offset) =============

interface CompactIndex {
  dir: string;
  file: string;
  /** 已扫描的字节数 */
  scanned: number;
  /** key -> 该 key 最近一次出现的行起始字节偏移 */
  offsets: Map<string, number>;
  /** sessionId -> 该会话所有行的偏移(文件顺序) */
  sessionOffsets: Map<string, number[]>;
}

let index: CompactIndex | undefined;

function ensureIndex(): CompactIndex {
  const dir = resolveCompactSummaryDir();
  const file = pathJoin(dir, CACHE_FILE_NAME);
  if (index && index.dir === dir && index.file === file) {
    if (existsSync(file)) {
      const size = statSync(file).size;
      if (size > index.scanned) {
        scanInto(index, size);
      }
    }
    return index;
  }
  index = { dir, file, offsets: new Map(), scanned: 0, sessionOffsets: new Map() };
  if (existsSync(file)) {
    scanInto(index, statSync(file).size);
  }
  return index;
}

/** 从 index.scanned 扫描到 limit,登记每行。忽略未以 \n 结尾的末行。 */
function scanInto(idx: CompactIndex, limit: number): void {
  const start = idx.scanned;
  if (limit <= start) return;
  const fd = openSync(idx.file, "r");
  try {
    const len = limit - start;
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    let lineStart = start;
    for (let i = 0; i < read; i++) {
      if (buf[i] === 0x0a) {
        registerLine(idx, buf.subarray(lineStart - start, i), lineStart);
        lineStart = start + i + 1;
      }
    }
    idx.scanned = lineStart;
  } finally {
    closeSync(fd);
  }
}

function registerLine(idx: CompactIndex, lineBuf: Buffer, offset: number): void {
  const header = extractHeader(lineBuf);
  if (!header) return;
  idx.offsets.set(header.h, offset);
  if (header.s) {
    const list = idx.sessionOffsets.get(header.s);
    if (list) {
      list.push(offset);
    } else {
      idx.sessionOffsets.set(header.s, [offset]);
    }
  }
}

function extractHeader(lineBuf: Buffer): { h: string; s?: string } | undefined {
  try {
    const text = lineBuf.toString("utf-8");
    if (!text) return undefined;
    const obj = JSON.parse(text) as { h?: unknown; s?: unknown };
    if (typeof obj.h !== "string") return undefined;
    return { h: obj.h, ...(typeof obj.s === "string" ? { s: obj.s } : {}) };
  } catch {
    return undefined;
  }
}

// ============= public API =============

/** 写入(内容寻址,幂等)。返回是否写入成功。 */
export function putCompactSummary(entry: CompactSummaryEntry, ttlMs: number = DEFAULT_TTL_MS): boolean {
  if (!entry || typeof entry.key !== "string" || !entry.key) return false;
  if (typeof entry.sessionId !== "string" || !entry.sessionId) return false;
  if (typeof entry.summary !== "string" || !entry.summary.trim()) return false;
  if (!Array.isArray(entry.messageHashes) || entry.messageHashes.length === 0) return false;

  const idx = ensureIndex();
  mkdirSync(idx.dir, { recursive: true });
  const now = Date.now();
  const expiresAt = entry.expiresAt ?? now + ttlMs;
  const line = JSON.stringify({
    e: expiresAt,
    h: entry.key,
    mh: entry.messageHashes,
    n: entry.coveredCount ?? entry.messageHashes.length,
    s: entry.sessionId,
    sum: entry.summary,
    t: entry.createdAt ?? now
  }) + "\n";
  appendFileSync(idx.file, line, "utf-8");
  // 追加后使索引失效(下次读重建/续扫)
  index = undefined;
  maybeCompact(idx.dir);
  return true;
}

/** 读取单条(key → 摘要)。未命中 / 过期 → null。 */
export function getCompactSummary(key: string, now: number = Date.now()): CompactSummaryEntry | null {
  const idx = ensureIndex();
  const offset = idx.offsets.get(key);
  if (offset === undefined) return null;
  return parseEntry(readLineAt(idx.file, offset), key, now);
}

/**
 * 查找该会话下 `messageHashes` 的**前缀**摘要(取覆盖条数最多的一条)。
 * 采用容差匹配(见 `approxPrefixLength`):compact 跑在 helix-compressor 之后,
 * 压缩器逐轮重写的少量消息会让严格 hash 前缀失配,放宽到同位一致率 ≥
 * `PREFIX_MATCH_MIN_RATIO` 才能命中。命中返回 { entry, matchedCount };未命中返回 null。
 */
export function findPrefixSummary(
  sessionId: string,
  messageHashes: string[],
  now: number = Date.now()
): { entry: CompactSummaryEntry; matchedCount: number } | null {
  if (!sessionId || !Array.isArray(messageHashes) || messageHashes.length === 0) return null;
  const idx = ensureIndex();
  const offsets = idx.sessionOffsets.get(sessionId);
  if (!offsets || offsets.length === 0) return null;

  let best: { entry: CompactSummaryEntry; matchedCount: number } | null = null;
  // 逆向:最近写入者优先(同一前缀的新摘要覆盖旧的)
  for (let i = offsets.length - 1; i >= 0; i -= 1) {
    const entry = parseEntryLoose(readLineAt(idx.file, offsets[i]), now);
    if (!entry) continue;
    const mh = entry.messageHashes;
    if (mh.length === 0 || mh.length > messageHashes.length) continue;
    if (best && mh.length <= best.matchedCount) continue;
    const matched = approxPrefixLength(mh, messageHashes);
    if (matched < 0) continue;
    best = { entry, matchedCount: matched };
  }
  return best;
}

/** TTL 清理 + compaction:重写为仅含未过期、每 key 最后一行的新文件。返回保留条数。 */
export function cleanup(now: number = Date.now()): number {
  const idx = ensureIndex();
  const file = idx.file;
  if (!existsSync(file)) return 0;
  const kept = new Map<string, string>();
  for (const [key, offset] of idx.offsets) {
    const raw = readLineAt(file, offset);
    if (!raw) continue;
    const entry = parseEntryLoose(raw, now);
    if (!entry) continue;
    kept.set(key, raw.endsWith("\n") ? raw : raw + "\n");
  }
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, [...kept.values()].join(""), "utf-8");
  renameSync(tmp, file);
  index = undefined;
  return kept.size;
}

// ============= helpers =============

/**
 * 容差前缀:同位一致率 ≥ `PREFIX_MATCH_MIN_RATIO` 且不超出 `value` 长度。
 * 覆盖两种线上漂移形态:① 等长重写(压缩器就地改写某条消息);
 * ② 少量插入(个别消息字节变动导致其 hash 改变)。
 * 返回匹配到的前缀长度(用于 matchedCount);不满足则返回 -1。
 *
 * 安全边界:折叠区间由历史原文的切片决定,`matchedCount` 只作为「该条摘要覆盖到哪」
 * 的标注;若上游字节确实变了,覆盖段本就会重新进入被丢弃的前缀,不会泄漏错误摘要。
 */
function approxPrefixLength(prefix: string[], value: string[]): number {
  if (prefix.length === 0 || prefix.length > value.length) return -1;
  // 允许的最大失配位数:超过即可提前判定不达标(避免对长前缀做全量比较)。
  const maxDiff = Math.floor(prefix.length * (1 - PREFIX_MATCH_MIN_RATIO));
  let diff = 0;
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix[i] !== value[i]) {
      diff += 1;
      if (diff > maxDiff) return -1;
    }
  }
  return prefix.length;
}

function readLineAt(file: string, offset: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const chunks: Buffer[] = [];
    let pos = offset;
    let total = 0;
    while (total < MAX_LINE_READ_BYTES) {
      const buf = Buffer.allocUnsafe(64 * 1024);
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      const slice = buf.subarray(0, n);
      const nl = slice.indexOf(0x0a);
      if (nl >= 0) {
        chunks.push(slice.subarray(0, nl));
        return Buffer.concat(chunks).toString("utf-8");
      }
      chunks.push(slice);
      pos += n;
      total += n;
    }
    return chunks.length ? Buffer.concat(chunks).toString("utf-8") : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function parseEntry(line: string | undefined, key: string, now: number): CompactSummaryEntry | null {
  if (!line) return null;
  const entry = parseEntryLoose(line, now);
  return entry && entry.key === key ? entry : null;
}

function parseEntryLoose(line: string | undefined, now: number): CompactSummaryEntry | null {
  if (!line) return null;
  let obj: { e?: unknown; h?: unknown; mh?: unknown; n?: unknown; s?: unknown; sum?: unknown; t?: unknown };
  try {
    obj = JSON.parse(line) as typeof obj;
  } catch {
    return null;
  }
  if (typeof obj.h !== "string" || typeof obj.sum !== "string") return null;
  if (typeof obj.e === "number" && obj.e <= now) return null;
  if (typeof obj.s !== "string" || !obj.s) return null;
  const messageHashes = Array.isArray(obj.mh) ? obj.mh.filter((h): h is string => typeof h === "string") : [];
  return {
    coveredCount: typeof obj.n === "number" ? obj.n : messageHashes.length,
    ...(typeof obj.e === "number" ? { expiresAt: obj.e } : {}),
    key: obj.h,
    messageHashes,
    sessionId: obj.s,
    summary: obj.sum,
    ...(typeof obj.t === "number" ? { createdAt: obj.t } : {})
  };
}

function maybeCompact(dir: string): void {
  const file = pathJoin(dir, CACHE_FILE_NAME);
  if (!existsSync(file)) return;
  if (statSync(file).size >= COMPACT_SIZE_BYTES) {
    try { cleanup(); } catch { /* best-effort */ }
  }
}

/** 仅供测试:重置进程内索引缓存。 */
export function _resetIndexForTest(): void {
  index = undefined;
}

/** 仅供测试:删除缓存文件。 */
export function _clearCacheForTest(): void {
  const dir = process.env.HELIX_RECALL_CACHE_DIR;
  if (!dir) return;
  const file = pathJoin(dir, COMPACT_DIR_NAME, CACHE_FILE_NAME);
  if (existsSync(file)) {
    try { unlinkSync(file); } catch { /* ignore */ }
  }
  index = undefined;
}
