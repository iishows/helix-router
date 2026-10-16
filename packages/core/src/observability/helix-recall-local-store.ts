/**
 * Helix 本地召回缓存 — append-only JSONL（零依赖）
 *
 * 设计动机（见 docs/issue-reviews/2026-10-14-local-closed-loop-recall-design.md §5）:
 *   召回读取发生在网关 spawn 的 MCP stdio 子进程,esbuild 强制轻量 MCP 包
 *   ≤128KB 且禁止原生 SQLite(better-sqlite3)。因此不用 SQLite,改用 node:fs 的
 *   append-only JSONL:压缩端(gateway 进程)追加写,召回端(MCP 子进程)按需读。
 *
 * 语义:
 *   - 内容寻址:key = 占位符里的 hash;同 hash 重复写是幂等(后者覆盖)。
 *   - 每行一条完整 JSON,以 '\n' 结尾;读者忽略不以 '\n' 结尾的末行(半写)。
 *   - 目录由环境变量 HELIX_RECALL_CACHE_DIR 指定(压缩端与 MCP 子进程一致)。
 *   - TTL 默认 3 天。
 */

import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, renameSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { join as pathJoin } from "node:path";

export interface RecallCacheEntry {
  q: string;
  a: string;
  blockOnly?: boolean;
  kind?: "text" | "media";
  msgIdx?: number;
  blockIdx?: number;
  qIdx?: number;
  aIdx?: number;
  qMedia?: unknown[];
}

const CACHE_FILE_NAME = "cache.jsonl";
const DEFAULT_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const COMPACT_SIZE_BYTES = 64 * 1024 * 1024;
const MAX_LINE_READ_BYTES = 8 * 1024 * 1024;

/** 解析缓存目录:优先环境变量,否则抛错(调用方须显式提供)。 */
export function resolveCacheDir(): string {
  const dir = process.env.HELIX_RECALL_CACHE_DIR;
  if (!dir) {
    throw new Error("HELIX_RECALL_CACHE_DIR is not set; cannot access helix recall cache");
  }
  return dir;
}

/** 用 DATADIR 风格目录兜底,并写入环境变量(供子进程继承)。 */
export function configureCacheDir(dir: string): void {
  process.env.HELIX_RECALL_CACHE_DIR = dir;
}

// ============= 进程内索引 (offset) =============

interface CacheIndex {
  dir: string;
  file: string;
  /** 已扫描的字节数 */
  scanned: number;
  /** hash -> 该 hash 最近一次出现的行起始字节偏移 */
  offsets: Map<string, number>;
}

let index: CacheIndex | undefined;

function ensureIndex(): CacheIndex {
  const dir = resolveCacheDir();
  const file = pathJoin(dir, CACHE_FILE_NAME);
  if (index && index.dir === dir && index.file === file) {
    // 文件增长则增量续扫
    if (existsSync(file)) {
      const size = statSync(file).size;
      if (size > index.scanned) {
        scanInto(index, size);
      }
    }
    return index;
  }
  index = { dir, file, scanned: 0, offsets: new Map() };
  if (existsSync(file)) {
    scanInto(index, statSync(file).size);
  }
  return index;
}

/** 从 index.scanned 扫描到 limit,登记每行的 hash→offset。忽略未以 \n 结尾的末行。 */
function scanInto(idx: CacheIndex, limit: number): void {
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
    // 只在完整行(以 \n 结尾)范围内登记;半写尾部留待下次
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

function registerLine(idx: CacheIndex, lineBuf: Buffer, offset: number): void {
  const hash = extractHash(lineBuf);
  if (hash) {
    idx.offsets.set(hash, offset);
  }
}

function extractHash(lineBuf: Buffer): string | undefined {
  // 快速解析:信任写入方格式 {"h":"<hash>",...}
  try {
    const text = lineBuf.toString("utf-8");
    if (!text) return undefined;
    const obj = JSON.parse(text) as { h?: unknown };
    return typeof obj.h === "string" ? obj.h : undefined;
  } catch {
    return undefined;
  }
}

// ============= public API =============

/** 追加写入(内容寻址,幂等)。返回写入条数。 */
export function putBatch(entries: Array<[string, RecallCacheEntry]>, ttlMs: number = DEFAULT_TTL_MS): number {
  if (!entries || entries.length === 0) return 0;
  const dir = resolveCacheDir();
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const expiresAt = now + ttlMs;

  const idx = ensureIndex();
  let lines = "";
  for (const [hash, content] of entries) {
    if (typeof hash !== "string" || !hash) continue;
    lines += JSON.stringify({ h: hash, c: content, t: now, e: expiresAt }) + "\n";
  }
  if (!lines) return 0;
  appendFileSync(idx.file, lines, "utf-8");
  // 追加后使索引失效(下次读重建/续扫)
  index = undefined;
  maybeCompact(idx.dir);
  return entries.length;
}

/** 读取单条(hash → 原文)。未命中 / 过期 → null。 */
export function get(hash: string, now: number = Date.now()): RecallCacheEntry | null {
  const idx = ensureIndex();
  const offset = idx.offsets.get(hash);
  if (offset === undefined) return null;
  const line = readLineAt(idx.file, offset);
  return parseEntry(line, hash, now);
}

/** 批量读取。返回 { hash: entry }(仅命中的)。 */
export function batchGet(hashes: string[], now: number = Date.now()): Record<string, RecallCacheEntry> {
  const out: Record<string, RecallCacheEntry> = {};
  if (!Array.isArray(hashes)) return out;
  const idx = ensureIndex();
  for (const hash of hashes) {
    const offset = idx.offsets.get(hash);
    if (offset === undefined) continue;
    const entry = parseEntry(readLineAt(idx.file, offset), hash, now);
    if (entry) out[hash] = entry;
  }
  return out;
}

/** TTL 清理 + compaction:重写为仅含未过期、每 hash 最后一行的新文件。返回保留条数。 */
export function cleanup(now: number = Date.now()): number {
  const dir = resolveCacheDir();
  const file = pathJoin(dir, CACHE_FILE_NAME);
  if (!existsSync(file)) return 0;
  const idx = ensureIndex();
  const kept = new Map<string, string>(); // hash -> raw line
  for (const [hash, offset] of idx.offsets) {
    const raw = readLineAt(file, offset);
    if (!raw) continue;
    const entry = safeParse(raw);
    if (!entry) continue;
    if (typeof entry.e === "number" && entry.e <= now) continue;
    kept.set(hash, raw.endsWith("\n") ? raw : raw + "\n");
  }
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, [...kept.values()].join(""), "utf-8");
  renameSync(tmp, file);
  index = undefined;
  return kept.size;
}

// ============= helpers =============

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

function safeParse(line: string): { h?: unknown; c?: unknown; t?: unknown; e?: unknown } | null {
  try {
    return JSON.parse(line) as { h?: unknown; c?: unknown; t?: unknown; e?: unknown };
  } catch {
    return null;
  }
}

function parseEntry(line: string | undefined, hash: string, now: number): RecallCacheEntry | null {
  if (!line) return null;
  const obj = safeParse(line);
  if (!obj || obj.h !== hash) return null;
  if (typeof obj.e === "number" && obj.e <= now) return null;
  const c = obj.c;
  if (!c || typeof c !== "object") return null;
  return c as RecallCacheEntry;
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
  const file = pathJoin(dir, CACHE_FILE_NAME);
  if (existsSync(file)) {
    try { unlinkSync(file); } catch { /* ignore */ }
  }
  index = undefined;
}
