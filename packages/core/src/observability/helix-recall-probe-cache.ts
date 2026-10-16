/**
 * Helix recall 能力探测缓存 — append-only JSONL（零依赖）
 *
 * 设计动机（见 docs 计划 `fizzy-meandering-russell`）:
 *   自动检测「哪些模型支持 recall」需要向每个已配置模型发一次 tool-calling 探测请求。
 *   为避免每次检测都打上游,把逐模型结果落缓存(TTL 24h),稳态零网络调用。
 *
 * 语义:
 *   - key = `<providerKey>|<model>`;同 key 重复写是幂等(后者覆盖,last-line-wins)。
 *   - 每行一条完整 JSON,以 '\n' 结尾;忽略不以 '\n' 结尾的末行(半写)。
 *   - 目录由环境变量 HELIX_RECALL_CACHE_DIR 指定(与 recall 缓存同源,子目录 helix-recall-probe)。
 *   - TTL 默认 24h;过期的行读时视为未命中。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { HELIX_RECALL_DIR } from "@ccr/core/config/constants";

export type RecallProbeDepth = "none" | "offline" | "tools";

export interface RecallProbeCacheEntry {
  /** provider 标识(name 或 base url)。 */
  providerKey: string;
  /** 真实模型名(上游承认的名字)。 */
  model: string;
  /** 协议(openai_chat_completions / anthropic_messages)。 */
  protocol: string;
  /** 探测深度。 */
  depth: RecallProbeDepth;
  /** 写入时间(ms)。 */
  probedAt: number;
  /** 过期时间(ms)。 */
  expiresAt: number;
}

const CACHE_FILE_NAME = "probe-cache.jsonl";
const PROBE_DIR_NAME = "helix-recall-probe";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 缓存目录:HELIX_RECALL_CACHE_DIR 下的 helix-recall-probe 子目录。
 * 未配置时回退到 DATADIR/helix-recall(与压缩端/召回端同源)。
 *
 * 注意:检测 RPC 跑在父进程(Electron main / ccr-core-server),那里从未设置
 * HELIX_RECALL_CACHE_DIR(只有网关子进程的压缩 transform 会惰性设置)。若不回退,
 * 探测缓存永远写不进去 → 每次检测都重打上游,24h 兜底也失效。
 */
export function resolveRecallProbeDir(): string {
  const dir = process.env.HELIX_RECALL_CACHE_DIR || HELIX_RECALL_DIR;
  return pathJoin(dir, PROBE_DIR_NAME);
}

export function recallProbeCacheKey(providerKey: string, model: string): string {
  return `${providerKey}|${model}`;
}

/** 读全部未过期条目 → Map<key, entry>(last-line-wins)。目录/文件缺失 → 空 Map。 */
export function readRecallProbeCache(now: number = Date.now()): Map<string, RecallProbeCacheEntry> {
  const result = new Map<string, RecallProbeCacheEntry>();
  let dir: string;
  try {
    dir = resolveRecallProbeDir();
  } catch {
    return result;
  }
  const file = pathJoin(dir, CACHE_FILE_NAME);
  if (!existsSync(file)) {
    return result;
  }
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return result;
  }
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    const entry = parseLine(raw);
    if (!entry) continue;
    if (entry.expiresAt <= now) continue;
    result.set(recallProbeCacheKey(entry.providerKey, entry.model), entry);
  }
  return result;
}

/** 查单条(未过期)。 */
export function getRecallProbeCacheEntry(
  providerKey: string,
  model: string,
  now: number = Date.now()
): RecallProbeCacheEntry | undefined {
  return readRecallProbeCache(now).get(recallProbeCacheKey(providerKey, model));
}

/** 写入(幂等,后者覆盖)。ttlMs 默认 24h。返回是否写入成功。 */
export function putRecallProbeCacheEntry(
  entry: Omit<RecallProbeCacheEntry, "expiresAt" | "probedAt"> & { probedAt?: number; ttlMs?: number },
  now: number = Date.now()
): boolean {
  if (!entry || typeof entry.providerKey !== "string" || !entry.providerKey) return false;
  if (typeof entry.model !== "string" || !entry.model) return false;
  let dir: string;
  try {
    dir = resolveRecallProbeDir();
  } catch {
    return false;
  }
  mkdirSync(dir, { recursive: true });
  const probedAt = entry.probedAt ?? now;
  const expiresAt = now + (entry.ttlMs ?? DEFAULT_TTL_MS);
  const line = JSON.stringify({
    d: entry.depth,
    e: expiresAt,
    m: entry.model,
    p: entry.protocol,
    pk: entry.providerKey,
    t: probedAt
  }) + "\n";
  try {
    appendFileSync(pathJoin(dir, CACHE_FILE_NAME), line, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** TTL 清理:重写为仅含未过期、每 key 最后一行的新文件。返回保留条数。 */
export function cleanupRecallProbeCache(now: number = Date.now()): number {
  let dir: string;
  try {
    dir = resolveRecallProbeDir();
  } catch {
    return 0;
  }
  const file = pathJoin(dir, CACHE_FILE_NAME);
  if (!existsSync(file)) return 0;
  const kept = new Map<string, string>();
  for (const raw of readFileSync(file, "utf-8").split("\n")) {
    if (!raw) continue;
    const entry = parseLine(raw);
    if (!entry || entry.expiresAt <= now) continue;
    kept.set(recallProbeCacheKey(entry.providerKey, entry.model), raw.endsWith("\n") ? raw : raw + "\n");
  }
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, [...kept.values()].join(""), "utf-8");
  renameSync(tmp, file);
  return kept.size;
}

// ============= helpers =============

function parseLine(line: string): RecallProbeCacheEntry | undefined {
  let obj: { d?: unknown; e?: unknown; m?: unknown; p?: unknown; pk?: unknown; t?: unknown };
  try {
    obj = JSON.parse(line) as typeof obj;
  } catch {
    return undefined;
  }
  if (typeof obj.pk !== "string" || typeof obj.m !== "string") return undefined;
  if (typeof obj.e !== "number" || typeof obj.t !== "number") return undefined;
  const depth = obj.d === "tools" || obj.d === "offline" || obj.d === "none" ? obj.d : "none";
  return {
    depth,
    expiresAt: obj.e,
    model: obj.m,
    probedAt: obj.t,
    protocol: typeof obj.p === "string" ? obj.p : "",
    providerKey: obj.pk
  };
}
