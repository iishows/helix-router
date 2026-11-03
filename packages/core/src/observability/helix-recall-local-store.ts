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
  /** "tool_result" 由 helix-compressor 的块候选写入(见 hc-local.ts HashMapEntry)。 */
  kind?: "text" | "media" | "tool_result";
  msgIdx?: number;
  blockIdx?: number;
  qIdx?: number;
  aIdx?: number;
  qMedia?: unknown[];
}

const CACHE_FILE_NAME = "cache.jsonl";
const DEFAULT_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const COMPACT_SIZE_BYTES = 64 * 1024 * 1024;
/**
 * 单条记录(一行 JSONL,不含换行)的硬上限。这是**写入与读取共用的唯一真源**:
 * `putBatch` 拒绝超过它的条目,`readLineAt` 的读取预算由它推导 —— 两者不会各自漂移,
 * 从而保证"凡写入的必然可读回"。
 *
 * 取值须覆盖 helix-compressor 的媒体上限 `MEDIA_CONTAINER_PARSE_MAX_CHARS`
 * (16,000,000 字符),留出结构开销后取 20MB。
 *
 * 注意:媒体是 base64(ASCII,1 字符≈1 字节),但同一张表也存**任意 UTF-8 文本**条目
 * (CJK 约 3 字节/字符)。因此字节预算不能由字符上限直接推导 —— 调用方必须用
 * `entryFitsBudget()` 按**序列化后的真实字节数**判定,否则会出现"压缩器按字符放行、
 * 存储层按字节拒收"的错配,留下永远读不回的孤儿占位符。
 */
export const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
/** 读取预算 = 条目上限 + 余量,确保任何合法写入(含结尾换行)都能读到行尾。 */
const MAX_LINE_READ_BYTES = MAX_ENTRY_BYTES + 64 * 1024;

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
  /** 已登记完整行的字节数(半写尾部不计入,下次从该偏移续扫) */
  scanned: number;
  /** 上次扫描时文件的 inode;被 compaction(renameSync)替换后会变化 */
  ino: number;
  /** hash -> 该 hash 最近一次出现的行起始字节偏移 */
  offsets: Map<string, number>;
}

let index: CacheIndex | undefined;

/**
 * 返回当前缓存文件的索引(hash→offset)。
 *
 * 跨进程注意:写入端(gateway 进程)触发 compaction(见 `cleanup`,用 renameSync
 * 整体重写文件)或追加时,**读取端**(长驻的 helix-recall MCP 子进程)的进程内
 * index 不会自动同步。若仅用「文件变大则续扫」判断,会漏掉两类情况:
 *   1. 文件被 compaction 重写后变小 → 旧 offsets 指向新文件的错误位置;
 *   2. 文件被替换后仍然变大 → 续扫点之前的旧 offsets 已经错位。
 * 因此这里以**文件身份(ino)**为判据:ino 变化即视为换了一个文件,索引整体重建。
 * 无法取得 ino(部分平台返回 0)时,退化为「size 不小于已扫描量才续扫」的安全近似。
 */
function ensureIndex(): CacheIndex {
  const dir = resolveCacheDir();
  const file = pathJoin(dir, CACHE_FILE_NAME);
  if (index && index.dir === dir && index.file === file && existsSync(file)) {
    const st = statSync(file);
    // 文件身份未变(同 inode 或两端都拿不到 inode)且未被截断 → 可增量续扫。
    const sameFile = (index.ino === 0 || st.ino === 0 || st.ino === index.ino)
      && st.size >= index.scanned;
    if (sameFile) {
      if (st.size > index.scanned) {
        scanInto(index, st.size);
      }
      return index;
    }
  }
  // 首次建立,或文件被替换/截断 → 整体重建。
  index = { dir, file, scanned: 0, ino: 0, offsets: new Map() };
  if (existsSync(file)) {
    const st = statSync(file);
    index.ino = st.ino;
    scanInto(index, st.size);
  }
  return index;
}

/**
 * 从 index.scanned 扫描到 limit,登记每行的 hash→offset。忽略未以 \n 结尾的末行。
 *
 * 分块读取:缓存文件可达 COMPACT_SIZE_BYTES(64MB),一次性 `Buffer.allocUnsafe(len)`
 * 会在内存紧张时抛 "Failed to allocate memory" 并拖垮网关(2026-11-03 线上事故)。
 * 这里每块最多 SCAN_CHUNK_BYTES,跨块未闭合的行留在 pending 里(最多一行,受
 * MAX_ENTRY_BYTES 限制),内存占用与文件大小无关。
 */
const SCAN_CHUNK_BYTES = 1024 * 1024;

function scanInto(idx: CacheIndex, limit: number): void {
  const start = idx.scanned;
  if (limit <= start) return;
  const fd = openSync(idx.file, "r");
  try {
    let pos = start;
    let pending = Buffer.alloc(0);
    let pendingStart = start;
    while (pos < limit) {
      const want = Math.min(SCAN_CHUNK_BYTES, limit - pos);
      const buf = Buffer.allocUnsafe(want);
      let read = 0;
      while (read < want) {
        const n = readSync(fd, buf, read, want - read, pos + read);
        if (n <= 0) break;
        read += n;
      }
      if (read <= 0) break;
      pos += read;
      const chunk = read === want ? buf : buf.subarray(0, read);
      const data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      // 只在完整行(以 \n 结尾)范围内登记;半写尾部留待下次
      let lineStart = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 0x0a) {
          registerLine(idx, data.subarray(lineStart, i), pendingStart + lineStart);
          lineStart = i + 1;
        }
      }
      pending = lineStart < data.length ? Buffer.from(data.subarray(lineStart)) : Buffer.alloc(0);
      pendingStart += lineStart;
    }
    idx.scanned = pendingStart;
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

/**
 * 条目 → JSONL 行(含结尾换行)。`putBatch` 与调用方预检(`entryFitsBudget`)共用同一实现,
 * 从而保证"预检判定为可写"与"实际写入"在字节数上完全一致,不会因两处格式漂移而错配。
 */
export function serializeEntryLine(
  hash: string,
  content: RecallCacheEntry,
  now: number,
  expiresAt: number
): string {
  return JSON.stringify({ h: hash, c: content, t: now, e: expiresAt }) + "\n";
}

/**
 * 该条目写入后是否会被 `putBatch` 接受。
 *
 * 供压缩器在**替换占位符之前**调用:凡返回 false 的条目一律不得写入占位符,
 * 否则消息里会留下一个永远读不回的孤儿 ⟦HC:hash⟧。
 *
 * 用定宽时间戳探测:`t`/`e` 真实值恒为 13 位毫秒数,固定值保证预检与真实写入同宽。
 */
const PROBE_TIMESTAMP = 9_999_999_999_999;
export function entryFitsBudget(hash: string, content: RecallCacheEntry): boolean {
  const line = serializeEntryLine(hash, content, PROBE_TIMESTAMP, PROBE_TIMESTAMP);
  return Buffer.byteLength(line, "utf-8") <= MAX_ENTRY_BYTES;
}

/** 追加写入(内容寻址,幂等)。返回写入条数。 */
export function putBatch(entries: Array<[string, RecallCacheEntry]>, ttlMs: number = DEFAULT_TTL_MS): number {
  if (!entries || entries.length === 0) return 0;
  const dir = resolveCacheDir();
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const expiresAt = now + ttlMs;

  const idx = ensureIndex();
  let lines = "";
  let written = 0;
  for (const [hash, content] of entries) {
    if (typeof hash !== "string" || !hash) continue;
    const line = serializeEntryLine(hash, content, now, expiresAt);
    // 与 readLineAt 共用 MAX_ENTRY_BYTES:超限条目宁可丢弃,也不写入一条永远读不回的记录。
    // 调用方应先经 entryFitsBudget 预检,避免这里丢弃后留下孤儿占位符。
    if (Buffer.byteLength(line, "utf-8") > MAX_ENTRY_BYTES) continue;
    lines += line;
    written++;
  }
  if (!lines) return 0;
  const beforeSize = existsSync(idx.file) ? statSync(idx.file).size : 0;
  appendFileSync(idx.file, lines, "utf-8");
  // 增量续扫刚追加的部分,而不是丢弃索引让下一次调用整体重扫 60MB+ 文件:
  // 每个请求都全量重建索引会在低内存下触发 "Failed to allocate memory"。
  if (index && index.dir === idx.dir && index.file === idx.file) {
    scanInto(index, beforeSize + Buffer.byteLength(lines, "utf-8"));
  } else {
    index = undefined;
  }
  maybeCompact(idx.dir);
  return written;
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
  const tmp = `${file}.tmp-${process.pid}`;
  const out = openSync(tmp, "w");
  let kept = 0;
  try {
    // 逐行读取并写入临时文件,不再把所有原文行收集到 Map / join 成一个 60MB+
    // 字符串 —— 那会在 compaction 时把内存峰值抬到数百 MB。
    for (const [, offset] of idx.offsets) {
      const raw = readLineAt(file, offset);
      if (!raw) continue;
      const entry = safeParse(raw);
      if (!entry) continue;
      if (typeof entry.e === "number" && entry.e <= now) continue;
      writeFileSync(out, raw.endsWith("\n") ? raw : raw + "\n", "utf-8");
      kept += 1;
    }
  } finally {
    closeSync(out);
  }
  renameSync(tmp, file);
  index = undefined;
  return kept;
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
    // 预算内未见换行 ⇒ 这不是一条完整记录(损坏/超限)。宁可判为未命中,
    // 也不再返回半截 JSON —— 半截行只会让 parseEntry 静默失败,掩盖真实原因。
    return undefined;
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
