/**
 * Helix Compress V3.x — 本地端口（确定性路径）
 *
 * 逐字节对齐 `helix-compressor/src/compress/hc.js`（Node.js/ESM）的 V3.x 算法：
 *   computeHash / makePlaceholder / selectCompressibleIndices / extractText
 *   selectBlockCandidates / extractMediaBlocks / compressV3x / HC_DEFAULTS
 *
 * 不移植:budget.js(V4.5,依赖 LLM/网络)、compact.js(True Compact 语义摘要)、
 *         measure.js、PostgreSQL cache.js、billing/。V3.x 路径纯确定性、无 IO、无网络。
 *
 * 本地修正(见 docs/issue-reviews/2026-10-14-local-closed-loop-recall-design.md §4.4):
 *   强制保护"最后一轮 user 提问",使当前提问永不进入压缩候选
 *   (云端 keepRecentPairs 语义下最后一轮问题可能被吞,导致 LLM 无题可答)。
 *
 * 本地修正(§4.5, 2026-10-15):
 *   含 tool block(tool_use / tool_result)的消息不得在 pair 压缩中整条删除。
 *   云端把 assistant 整条设 null;若其携带 tool_use,下游引用它的 tool_result
 *   变孤儿,上游以 400 `tool result's tool id(...) not found (2013)` 拒绝。
 *   本端口改为只压缩这类消息的 text 块、保留 tool 块,并把 pair 边界扩展到
 *   依赖的 tool_result 消息。此举有意偏离逐字节 parity。
 */

import { createHash } from "node:crypto";

// ============= 常量（对齐 hc.js:19-34, 726-732）=============

const DEFAULT_MIN_CHARS = 500;
// V3.2:默认只保留最新 1 对 Q&A(最新提交的图片必看),其他全部候选压缩
const DEFAULT_KEEP_RECENT_PAIRS = 1;
// V3.3 block 级压缩:任意 role 的 text 块 ≥ 该阈值字符即纳入候选(0=关闭)
const DEFAULT_BLOCK_THRESHOLD_CHARS = 0;
// V1.12 tool_result 压缩:真实 agent 会话里工具输出占大头(实测 53%),
//   但 V3.x 只认 text/media 块 → 工具输出从不压缩(线上省 0.2% 的真因)。
//   超过以下阈值的 tool_result 输出纳入候选,压成 ⟦QA:hash⟧,需要时用 history_recall 取回。
const DEFAULT_TOOL_RESULT_THRESHOLD_CHARS = 1000;
// 最近 N 条 tool_result 永不压缩(模型最依赖近因工具输出)。
const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 2;
// 单请求 tool_result 压缩条数上限。真实 agent 会话(实测)单请求可达 600+ 条 tool_result、
//   其中 200+ 条超阈值;旧默认 20 导致 95% 的超阈值工具输出原样明文发给上游
//   (实测某请求 663k 字符仅压 20 条)。放宽到 200:覆盖真实会话历史,同时保留一个
//   合理上界避免病态输入。真正该兜底的是"压缩后仍超预算→主动 compact",而非此处硬顶。
const DEFAULT_MAX_COMPRESS_TOOL_RESULTS = 200;
const PLACEHOLDER_PREFIX = "⟦QA:";
const PLACEHOLDER_SUFFIX = "⟧";
const LEGACY_PLACEHOLDER_PREFIX = "⟦CCR:";

/** V4.5.10: media block 类型常量（budget.js 共享） */
export const MEDIA_BLOCK_TYPES = new Set(["image", "image_url", "document", "video", "audio"]);

// ============= 类型 =============

export interface LocalCompressMessage {
  role: string;
  content: string | Array<Record<string, unknown>> | unknown;
  [key: string]: unknown;
}

export interface HashMapEntry {
  q: string;
  a: string;
  blockOnly?: boolean;
  kind?: "text" | "media" | "tool_result";
  msgIdx?: number;
  blockIdx?: number;
  qIdx?: number;
  aIdx?: number;
  qMedia?: unknown[];
}

export interface CompressStats {
  candidateOrigTotal: number;
  candidatePlaceholderTotal: number;
  sessionCompressedChars: number;
  ratio: number;
  compressedCount: number;
  candidateCount: number;
  naturalRatio: number;
  skipped: boolean;
  skipReason: string | null;
  blockCandidates?: number;
  blockThresholdChars?: number;
}

export interface CompressResult {
  messages: LocalCompressMessage[];
  hashMap: Record<string, HashMapEntry>;
  stats: CompressStats;
}

export interface CompressV3xOptions {
  minChars?: number;
  keepRecentPairs?: number;
  maxCompressionRatio?: number;
  storeMedia?: boolean;
  blockThresholdChars?: number;
  /**
   * 媒体块压缩开关(默认 true)：media 块(image/image_url/document/video/audio)
   * 有即压,独立于 `blockThresholdChars`。置 false 完全不压媒体。
   */
  compressMedia?: boolean;
  /**
   * tool_result 压缩开关(默认 true):工具输出超过 `toolResultThresholdChars` 即压成
   * ⟦QA:hash⟧(保留 tool_use_id 与原 block,只换 content)。独立于 `blockThresholdChars`。
   * 这是真实 agent 会话的主要节省来源(工具输出占大头)。置 false 完全不压。
   */
  compressToolResults?: boolean;
  /** tool_result 输出 ≥ 该字符数才纳入候选(默认 1000)。 */
  toolResultThresholdChars?: number;
  /** 最近 N 条 tool_result 永不压缩(默认 2)。 */
  keepRecentToolResults?: number;
  /** 单请求 tool_result 压缩条数上限(默认 20)。 */
  maxCompressToolResults?: number;
  /**
   * 本地修正:是否强制保护最后一轮 user 提问(默认 true)。
   * 置 false 可复现云端原始行为(用于金值比对测试)。
   */
  protectFinalUserQuestion?: boolean;
}

// ============= 基础算法（对齐 hc.js:39-48）=============

/** 生成 hash:sha256(content,'utf-8') 前 16 位 hex（无 salt） */
export function computeHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16);
}

/** 生成占位符 ⟦QA:<hash>⟧ */
export function makePlaceholder(hash: string): string {
  return `${PLACEHOLDER_PREFIX}${hash}${PLACEHOLDER_SUFFIX}`;
}

// ============= 选块（对齐 hc.js:53-146）=============

/** 检查是否应该跳过某条消息（system/tool/过短/已含占位符） */
function shouldSkipMessage(msg: LocalCompressMessage, minChars: number): boolean {
  const role = msg.role;
  if (role === "system" || role === "tool") return true;

  const content = msg.content;
  let charCount = 0;

  if (typeof content === "string") {
    charCount = content.length;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "string") {
        charCount += block.length;
      } else if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          charCount += b.text.length;
        } else if (b.type === "tool_result") {
          // V1.12:工具输出计入体量,否则工具密集的消息 charCount≈0 被误判"太短"
          //   而整条跳过——真实 agent 会话内容主体恰在 tool_result 里。
          charCount += toolResultText(b).length;
        } else if (b.type === "tool_use") {
          charCount += JSON.stringify(b).length;
        }
      }
    }
  } else {
    return true;
  }

  if (charCount < minChars) return true;

  // 已含占位符(QA/旧CCR) → 幂等跳过(对齐 hc.js:80-83)
  if (
    typeof content === "string" &&
    (content.includes(PLACEHOLDER_PREFIX) || content.includes(LEGACY_PLACEHOLDER_PREFIX))
  ) {
    return true;
  }

  return false;
}

/**
 * V3.x 本地修正(2026-10-15):消息是否含 tool block(tool_use / tool_result)。
 *
 * 压缩 pair 会把 user 消息内容替换为 ⟦QA:⟧、把 assistant 消息整条删除。
 *   ① 若被删的 assistant 含 `tool_use`,后续 user 消息里引用它的 `tool_result`
 *      成孤儿 → 上游 400 `tool result's tool id(...) not found (2013)`。
 *   ② 若被替换的 user 含 `tool_result`(带 text 时仍可入选),前一条 assistant 的
 *      `tool_use` 失去配对 `tool_result` → 同样非法。
 * 故 pair 任一含 tool block 时,不删除消息,只压缩 text 块并保留 tool 块
 * (block 级 V3.3 压缩本就只改 text 块,不受影响)。
 *
 * 这是对云端 hc.js 的本地修正,会偏离逐字节 parity(见 helix-local-parity.test.mjs
 * 的 "tool-block messages" 用例)。
 */
function hasToolBlock(msg: LocalCompressMessage): boolean {
  if (!msg || !Array.isArray(msg.content)) return false;
  for (const block of msg.content) {
    if (!block || typeof block !== "object") continue;
    const type = (block as Record<string, unknown>).type;
    if (type === "tool_use" || type === "tool_result") return true;
  }
  return false;
}

/** 该消息是否只含 tool_result 块(用于找 tool 边界的收尾消息)。 */
function isToolResultOnly(msg: LocalCompressMessage): boolean {
  if (!msg || !Array.isArray(msg.content) || msg.content.length === 0) return false;
  for (const block of msg.content) {
    if (!block || typeof block !== "object" || (block as Record<string, unknown>).type !== "tool_result") {
      return false;
    }
  }
  return true;
}

/**
 * 把消息里的 text 块就地替换成占位符,保留所有非 text 块(tool_use / tool_result / image …)。
 * 无 text 块时原样返回(不注入新块)。
 */
function replaceTextBlocksWithPlaceholder(
  msg: LocalCompressMessage,
  placeholder: string
): LocalCompressMessage {
  const content = msg.content;
  if (typeof content === "string") return { ...msg, content: placeholder };
  if (!Array.isArray(content)) return msg;
  let hasText = false;
  const out: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
      if (!hasText) {
        out.push({ ...(block as Record<string, unknown>), text: placeholder });
        hasText = true;
      }
      continue;
    }
    out.push(block as Record<string, unknown>);
  }
  if (!hasText) return msg;
  return { ...msg, content: out };
}

/**
 * 找出应被压缩的 Q&A 消息索引（对齐 hc.js:91-146）
 *
 * anchor + recent 策略:
 *   - Local 修正:protectFinalUserQuestion=true 时,最后一条 user 消息的索引
 *     从候选范围中剔除(云端 [0, keepFrom) 会把它包含进去)。
 */
function selectCompressibleIndices(
  messages: LocalCompressMessage[],
  keepRecentPairs: number,
  minChars: number,
  protectFinalUserQuestion: boolean
): number[] {
  const n = messages.length;
  if (n === 0) return [];

  // 找 keepFrom(倒数 keepRecentPairs 对 user-assistant 的起始)

  // 找 keepFrom(倒数 keepRecentPairs 对 user-assistant 的起始)
  let pairCount = 0;
  let keepFrom = n;
  for (let i = n - 1; i >= 0; i--) {
    const role = messages[i].role;
    if (role !== "user" && role !== "assistant") continue;
    if (role === "assistant") {
      pairCount++;
      if (pairCount === 1) {
        keepFrom = i + 1;
      }
      if (pairCount >= keepRecentPairs) {
        keepFrom = i;
        break;
      }
    }
  }

  // 本地修正:定位最后一条 user 提问,从候选中排除
  let lastUserIdx = -1;
  if (protectFinalUserQuestion) {
    for (let i = n - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
  }

  // 选 [0, keepFrom) 这个范围(含 anchor)
  const selected: number[] = [];
  for (let i = 0; i < keepFrom; i++) {
    if (protectFinalUserQuestion && i === lastUserIdx) continue;
    const msg = messages[i];
    if (shouldSkipMessage(msg, minChars)) continue;
    if (msg.role === "user" || msg.role === "assistant") {
      selected.push(i);
    }
  }
  return selected;
}

/**
 * 提取文本(对齐 hc.js:247-261)
 *   - string 原样
 *   - array: text 块用 '\n' 拼接
 */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
        parts.push(((block as Record<string, unknown>).text as string) || "");
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * 提取媒体 blocks(对齐 hc.js:272-299)
 * 返回 [{ type, mime, data, source? }] 或 null(无媒体)
 */
function extractMediaBlocks(content: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(content)) return null;
  const out: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const type = b.type;
    if (type === "image") {
      const src = b.source as Record<string, unknown> | undefined;
      if (src && src.type === "base64" && typeof src.data === "string") {
        out.push({ type: "image", mime: src.media_type || "image/*", data: src.data });
      }
    } else if (type === "image_url") {
      const url = (b.image_url as Record<string, unknown> | undefined)?.url;
      if (typeof url === "string") {
        const m = url.match(/^data:([^;]+);base64,(.+)$/);
        if (m) {
          out.push({ type: "image", mime: m[1], data: m[2] });
        } else if (url.startsWith("http")) {
          out.push({ type: "image_url", url });
        }
      }
    } else if (type === "document" || type === "video" || type === "audio") {
      out.push({ type, ...b });
    }
  }
  return out.length > 0 ? out : null;
}

interface BlockCandidate {
  msgIdx: number;
  blockIdx: number;
  text: string;
  hash: string;
  placeholder: string;
  originalLen: number;
  placeholderLen: number;
  savings: number;
  kind: "text" | "media" | "tool_result";
  mediaBlock?: Record<string, unknown>;
  toolResultBlock?: Record<string, unknown>;
}

/**
 * V3.3 block 级压缩候选选择(对齐 hc.js:161-242)
 *
 * `includeMedia`(默认 true)保留与 hc.js 一致的行为:文本块与媒体块同在此函数内产出。
 * 调用方若另跑 `selectMediaCandidates` 做"独立媒体 pass",应传 `includeMedia:false`
 * 避免媒体候选重复。
 */
function selectBlockCandidates(
  messages: LocalCompressMessage[],
  options: { threshold: number; skipIndices?: Set<number>; includeMedia?: boolean }
): BlockCandidate[] {
  const threshold = options.threshold;
  const skipIndices = options.skipIndices || new Set<number>();
  const includeMedia = options.includeMedia !== false;
  if (!threshold || threshold <= 0) return [];

  const candidates: BlockCandidate[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const content = msg.content;

    if (typeof content === "string") {
      if (content.includes(PLACEHOLDER_PREFIX) || content.includes(LEGACY_PLACEHOLDER_PREFIX)) continue;
      if (skipIndices.has(i)) continue;
      if (content.length >= threshold) {
        const hash = computeHash(content);
        const placeholder = makePlaceholder(hash);
        candidates.push({
          msgIdx: i,
          blockIdx: -1,
          text: content,
          hash,
          placeholder,
          originalLen: content.length,
          placeholderLen: placeholder.length,
          savings: content.length - placeholder.length,
          kind: "text"
        });
      }
    } else if (Array.isArray(content)) {
      for (let bi = 0; bi < content.length; bi++) {
        const b = content[bi] as Record<string, unknown> | undefined;
        if (!b || typeof b !== "object") continue;
        const isMedia = MEDIA_BLOCK_TYPES.has(b.type as string);
        if (b.type !== "text" && !isMedia) continue;

        if (b.type === "text") {
          if (skipIndices.has(i)) continue;
          const text = (b.text as string) || "";
          if (text.length < threshold) continue;
          if (text.includes(PLACEHOLDER_PREFIX) || text.includes(LEGACY_PLACEHOLDER_PREFIX)) continue;
          const hash = computeHash(text);
          const placeholder = makePlaceholder(hash);
          candidates.push({
            msgIdx: i,
            blockIdx: bi,
            text,
            hash,
            placeholder,
            originalLen: text.length,
            placeholderLen: placeholder.length,
            savings: text.length - placeholder.length,
            kind: "text"
          });
          continue;
        }
        if (!includeMedia) continue;
        candidates.push(makeMediaCandidate(i, bi, b));
      }
    }
  }
  return candidates;
}

/** 构造单个媒体块候选(hash 基于块 JSON.stringify,保 parity) */
function makeMediaCandidate(msgIdx: number, blockIdx: number, b: Record<string, unknown>): BlockCandidate {
  const mediaJson = JSON.stringify(b);
  const hash = computeHash(mediaJson);
  const placeholder = makePlaceholder(hash);
  return {
    msgIdx,
    blockIdx,
    text: mediaJson,
    hash,
    placeholder,
    originalLen: mediaJson.length,
    placeholderLen: placeholder.length,
    savings: mediaJson.length - placeholder.length,
    kind: "media",
    mediaBlock: b
  };
}

/**
 * 媒体块专用候选选择——独立于 `blockThresholdChars`,有媒体块即压。
 *
 * 与 `selectBlockCandidates` 的差异:
 *   - 无 threshold 门槛(threshold 只服务文本块,媒体块"每张图几十 K tokens 必须压缩")。
 *   - 尊重 `skipIndices`(recent/当前轮保护):模型正要提问的那张当期图不压,否则看不到。
 */
function selectMediaCandidates(
  messages: LocalCompressMessage[],
  skipIndices: Set<number>
): BlockCandidate[] {
  const candidates: BlockCandidate[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (let bi = 0; bi < content.length; bi++) {
      const b = content[bi] as Record<string, unknown> | undefined;
      if (!b || typeof b !== "object") continue;
      if (!MEDIA_BLOCK_TYPES.has(b.type as string)) continue;
      if (skipIndices.has(i)) continue;
      const mediaJson = JSON.stringify(b);
      if (mediaJson.includes(PLACEHOLDER_PREFIX) || mediaJson.includes(LEGACY_PLACEHOLDER_PREFIX)) continue;
      candidates.push(makeMediaCandidate(i, bi, b));
    }
  }
  return candidates;
}

/** 媒体块的小标记描述(落库 entry.q,避免把几十 KB base64 当"问题文本") */
function mediaMarker(b: Record<string, unknown> | undefined): string {
  const type = (b?.type as string) || "media";
  const src = b?.source as Record<string, unknown> | undefined;
  const mime =
    (src?.media_type as string) ||
    (b?.mime as string) ||
    ((b?.image_url as Record<string, unknown> | undefined)?.url as string | undefined) ||
    "unknown";
  const data =
    (src?.data as string) ||
    (b?.data as string) ||
    "";
  const bytes = typeof data === "string" ? data.length : 0;
  return `[media block: ${type} ${mime}, ${bytes} bytes]`;
}

// ============= V1.12 tool_result 压缩 =============

/**
 * 取 tool_result 块的文本内容(对齐真实 anthropic 形状)。
 *   - string:原样
 *   - array:`[{type:"text",text}]` 拼接(非 text 块如 image 忽略)
 * 返回空串表示无文本(不参与压缩)。
 */
function toolResultText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === "object" && (item as Record<string, unknown>).type === "text") {
        parts.push(((item as Record<string, unknown>).text as string) || "");
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * tool_result 候选选择——独立于 `blockThresholdChars`,工具输出超阈值即压。
 *
 * 语义(与媒体候选不同):**保留原 block 与 tool_use_id,只把 content 换成占位符**。
 *   - tool_use_id 不动 → assistant 的 tool_use 与它仍配对,不会产生
 *     `tool result's tool id(...) not found (2013)` 400(比媒体候选的整块替换更安全)。
 *   - content 是 string 时直接换字符串;是 array 时换成单个 text 块(占位符)。
 *
 * 保护:
 *   - `skipIndices`(recent/当前轮)不压。
 *   - `keepRecentToolResults`:最近 N 条 tool_result 永不压(模型最依赖近因工具输出)。
 *   - `threshold`:只压 ≥ 阈值的输出。
 *   - `maxCount`:单请求压缩条数上限(按 savings 从大到小优先)。
 */
function selectToolResultCandidates(
  messages: LocalCompressMessage[],
  skipIndices: Set<number>,
  opts: { threshold: number; keepRecent: number; maxCount: number }
): BlockCandidate[] {
  if (opts.threshold <= 0 || opts.maxCount <= 0) return [];

  // 先收集全部 tool_result 出现位置(按消息逆序)以定位"最近 N 条"
  // 两种形状都收:
  //   ① Anthropic:`{role, content:[{type:"tool_result", content:<str|block[]>}]}`
  //   ② OpenAI:`{role:"tool", content:"<str>", tool_call_id}` —— 真实 Claude Code
  //      经 ccr 转成 OpenAI chat 形状后,tool 输出是**顶层字符串**,不是数组块。
  //      旧实现只扫数组块 → 真实流量里 95% 工具输出从不被压缩(最大杠杆漏压)。
  const all: Array<{ msgIdx: number; blockIdx: number; block: Record<string, unknown>; text: string }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === "tool" && typeof msg.content === "string") {
      // OpenAI 形状:blockIdx=-1 表示整条消息内容(string)就是 tool 输出。
      all.push({ msgIdx: i, blockIdx: -1, block: msg as unknown as Record<string, unknown>, text: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const b = msg.content[bi] as Record<string, unknown> | undefined;
      if (!b || typeof b !== "object" || b.type !== "tool_result") continue;
      all.push({ msgIdx: i, blockIdx: bi, block: b, text: toolResultText(b) });
    }
  }

  // 保护最近 keepRecent 条(按出现顺序取末尾 keepRecent 个)
  const protectedSet = new Set<string>();
  for (let k = Math.max(0, all.length - opts.keepRecent); k < all.length; k++) {
    protectedSet.add(`${all[k].msgIdx}:${all[k].blockIdx}`);
  }

  const candidates: BlockCandidate[] = [];
  for (const item of all) {
    if (skipIndices.has(item.msgIdx)) continue;
    if (protectedSet.has(`${item.msgIdx}:${item.blockIdx}`)) continue;
    const text = item.text;
    if (text.length < opts.threshold) continue;
    if (text.includes(PLACEHOLDER_PREFIX) || text.includes(LEGACY_PLACEHOLDER_PREFIX)) continue;
    const hash = computeHash(text);
    const placeholder = makePlaceholder(hash);
    candidates.push({
      msgIdx: item.msgIdx,
      blockIdx: item.blockIdx,
      text,
      hash,
      placeholder,
      originalLen: text.length,
      placeholderLen: placeholder.length,
      savings: text.length - placeholder.length,
      kind: "tool_result",
      toolResultBlock: item.block
    });
  }

  if (candidates.length <= opts.maxCount) return candidates;
  // 超额:按 savings 从大到小优先,保留前 maxCount 个,并按 msgIdx 还原顺序
  return [...candidates]
    .sort((a, b) => b.savings - a.savings)
    .slice(0, opts.maxCount)
    .sort((a, b) => (a.msgIdx - b.msgIdx) || (a.blockIdx - b.blockIdx));
}

/** 汇总三类 block 候选:文本(受 threshold)/媒体(独立)/tool_result(独立)。 */
function collectBlockCandidates(
  messages: LocalCompressMessage[],
  skipIndices: Set<number>,
  opts: {
    blockThresholdChars: number;
    compressMedia: boolean;
    compressToolResults: boolean;
    toolResultThresholdChars: number;
    keepRecentToolResults: number;
    maxCompressToolResults: number;
  }
): BlockCandidate[] {
  const textCands = opts.blockThresholdChars > 0
    ? selectBlockCandidates(messages, {
        threshold: opts.blockThresholdChars,
        skipIndices,
        includeMedia: false
      })
    : [];
  const mediaCands = opts.compressMedia ? selectMediaCandidates(messages, skipIndices) : [];
  const toolCands = opts.compressToolResults
    ? selectToolResultCandidates(messages, skipIndices, {
        threshold: opts.toolResultThresholdChars,
        keepRecent: opts.keepRecentToolResults,
        maxCount: opts.maxCompressToolResults
      })
    : [];
  return [...textCands, ...mediaCands, ...toolCands];
}

/** 把 block 候选的占位符写回消息(tool_result 保留 block 与 tool_use_id,只换 content)。 */
function applyBlockCandidate(m: LocalCompressMessage, bc: BlockCandidate): void {
  const content = m.content;
  // OpenAI 形状的 role:"tool" 消息:content 是顶层字符串,blockIdx=-1 → 整条换占位符。
  //   保留 role / tool_call_id,只替换 content(与 Anthropic tool_result 的"只换 content"语义一致)。
  if (bc.blockIdx === -1) {
    if (typeof content === "string") m.content = bc.placeholder;
    return;
  }
  if (!Array.isArray(content) || bc.blockIdx < 0 || bc.blockIdx >= content.length) {
    // 顶层字符串(仅 text 候选)
    if (typeof content === "string") m.content = bc.placeholder;
    return;
  }
  const newBlocks = content.slice();
  if (bc.kind === "tool_result") {
    const block = content[bc.blockIdx] as Record<string, unknown>;
    const newContent = Array.isArray(block.content)
      ? [{ type: "text", text: bc.placeholder }]
      : bc.placeholder;
    newBlocks[bc.blockIdx] = { ...block, content: newContent };
  } else {
    newBlocks[bc.blockIdx] = { type: "text", text: bc.placeholder };
  }
  m.content = newBlocks;
}

/** 由 block 候选构造召回缓存条目(media 用描述符,其余用原文)。 */
function blockCandidateEntry(bc: BlockCandidate): HashMapEntry {
  const qMedia = bc.kind === "media" && bc.mediaBlock ? [bc.mediaBlock] : undefined;
  return {
    q: bc.kind === "media" ? mediaMarker(bc.mediaBlock) : bc.text,
    a: "",
    blockOnly: true,
    kind: bc.kind || "text",
    msgIdx: bc.msgIdx,
    blockIdx: bc.blockIdx,
    ...(qMedia ? { qMedia } : {})
  };
}

// ============= 主入口（对齐 hc.js:341-648）=============

function emptyStats(): CompressStats {
  return {
    candidateOrigTotal: 0,
    candidatePlaceholderTotal: 0,
    sessionCompressedChars: 0,
    ratio: 0,
    compressedCount: 0,
    candidateCount: 0,
    naturalRatio: 0,
    skipped: false,
    skipReason: null
  };
}

/**
 * V3.x 压缩(threshold-based)。纯确定性、无 IO。
 */
export function compressV3x(
  messages: LocalCompressMessage[],
  options: CompressV3xOptions = {}
): CompressResult {
  const minChars = options.minChars || DEFAULT_MIN_CHARS;
  const keepRecentPairs = options.keepRecentPairs ?? DEFAULT_KEEP_RECENT_PAIRS;
  const maxRatio =
    typeof options.maxCompressionRatio === "number" ? options.maxCompressionRatio : null;
  const storeMedia = options.storeMedia === true;
  const blockThresholdChars = options.blockThresholdChars ?? DEFAULT_BLOCK_THRESHOLD_CHARS;
  const compressMedia = options.compressMedia !== false;
  const compressToolResults = options.compressToolResults !== false;
  const toolResultThresholdChars =
    typeof options.toolResultThresholdChars === "number"
      ? options.toolResultThresholdChars
      : DEFAULT_TOOL_RESULT_THRESHOLD_CHARS;
  const keepRecentToolResults =
    typeof options.keepRecentToolResults === "number"
      ? options.keepRecentToolResults
      : DEFAULT_KEEP_RECENT_TOOL_RESULTS;
  const maxCompressToolResults =
    typeof options.maxCompressToolResults === "number"
      ? options.maxCompressToolResults
      : DEFAULT_MAX_COMPRESS_TOOL_RESULTS;
  // 本地修正默认开启(设计稿 §4.4)
  const protectFinalUserQuestion = options.protectFinalUserQuestion !== false;

  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: messages || [], hashMap: {}, stats: emptyStats() };
  }

  const indices = selectCompressibleIndices(
    messages,
    keepRecentPairs,
    minChars,
    protectFinalUserQuestion
  );

  // V3.2: 收集 PAIRS(user + assistant) 为候选
    const candidates: Array<{
    qIdx: number;
    aIdx: number;
    text: string;
    hash: string;
    placeholder: string;
    originalLen: number;
    placeholderLen: number;
    savings: number;
    /** 本地修正:pair 含 tool block,保留 tool 块并把边界扩到依赖的 tool_result。 */
    toolBoundary?: boolean;
  }> = [];
  for (const qIdx of indices) {
    const qMsg = messages[qIdx];
    if (qMsg.role !== "user") continue;
    const aIdx = qIdx + 1;
    if (aIdx >= messages.length) continue;
    const aMsg = messages[aIdx];
    if (aMsg.role !== "assistant") continue;
    // 本地修正(2026-10-15):pair 任一含 tool block 时仍压缩其 text 块,
    //   但保留 tool_use / tool_result,并把 pair 边界扩展到紧随的
    //   "仅 tool_result" user 消息,避免残留孤儿 tool_result。
    //   见 replaceTextBlocksWithPlaceholder / isToolResultOnly / hasToolBlock。
    const pairToolBoundary = hasToolBlock(aMsg) || hasToolBlock(qMsg);

    const qText = extractText(qMsg.content);
    const aText = extractText(aMsg.content);
    if (qText.length + aText.length < minChars * 2) continue;

    const pairStr = JSON.stringify({ q: qText, a: aText });
    const hash = computeHash(pairStr);
    const placeholder = makePlaceholder(hash);
    candidates.push({
      qIdx,
      aIdx,
      text: qText,
      hash,
      placeholder,
      originalLen: qText.length + aText.length,
      placeholderLen: placeholder.length,
      savings: qText.length + aText.length - placeholder.length,
      ...(pairToolBoundary ? { toolBoundary: true } : {})
    });
  }

  if (candidates.length === 0) {
    // V3.3: 0 Q&A 候选时,也跑 block 压缩(任意 role 大文本)
    const newMessages: LocalCompressMessage[] = messages.map((m) => ({ ...m }));
    const newHashMap: Record<string, HashMapEntry> = {};
    let blockCandidates: BlockCandidate[] = [];
    let blockOrigTotal = 0,
      blockPlaceholderTotal = 0,
      blockCompressedCount = 0;
    if (blockThresholdChars > 0 || compressMedia || compressToolResults) {
      const skipMsgIndices = new Set<number>();
      const firstUserIdx = newMessages.findIndex((m) => m?.role === "user");
      if (firstUserIdx >= 0) skipMsgIndices.add(firstUserIdx);
      let recentCount = 0;
      for (let i = newMessages.length - 1; i >= 0 && recentCount < keepRecentPairs * 2; i--) {
        const role = newMessages[i]?.role;
        if (role === "user" || role === "assistant") {
          skipMsgIndices.add(i);
          recentCount++;
        }
      }
      blockCandidates = collectBlockCandidates(newMessages, skipMsgIndices, {
        blockThresholdChars,
        compressMedia,
        compressToolResults,
        toolResultThresholdChars,
        keepRecentToolResults,
        maxCompressToolResults
      });
      for (const bc of blockCandidates) {
        const m = newMessages[bc.msgIdx];
        if (!m) continue;
        applyBlockCandidate(m, bc);
        newHashMap[bc.hash] = blockCandidateEntry(bc);
        blockOrigTotal += bc.originalLen;
        blockPlaceholderTotal += bc.placeholderLen;
        blockCompressedCount++;
      }
    }
    const ratio = blockOrigTotal > 0 ? 1 - blockPlaceholderTotal / blockOrigTotal : 0;
    return {
      messages: newMessages,
      hashMap: newHashMap,
      stats: {
        candidateOrigTotal: blockOrigTotal,
        candidatePlaceholderTotal: blockPlaceholderTotal,
        sessionCompressedChars: blockPlaceholderTotal,
        ratio,
        compressedCount: blockCompressedCount,
        candidateCount: blockCandidates.length,
        naturalRatio: ratio,
        skipped: false,
        skipReason: null,
        blockCandidates: blockCandidates.length,
        blockThresholdChars
      }
    };
  }

  const totalOrig = candidates.reduce((s, c) => s + c.originalLen, 0);
  const totalCompressedAll = candidates.reduce((s, c) => s + c.placeholderLen, 0);
  const naturalRatio = totalOrig > 0 ? 1 - totalCompressedAll / totalOrig : 0;

  let chosen = candidates;
  let skipped = false;
  let skipReason: string | null = null;

  if (maxRatio !== null && naturalRatio > maxRatio) {
    const sorted = [...candidates].sort((a, b) => b.savings - a.savings);
    let runningOrig = 0;
    let runningComp = 0;
    const picked: typeof candidates = [];
    let capped = false;

    for (const c of sorted) {
      const projOrig = runningOrig + c.originalLen;
      const projComp = runningComp + c.placeholderLen;
      const projRatio = projOrig > 0 ? 1 - projComp / projOrig : 0;
      if (picked.length > 0 && projRatio > maxRatio) {
        capped = true;
        continue;
      }
      picked.push(c);
      runningOrig = projOrig;
      runningComp = projComp;
    }

    if (picked.length === 0) {
      skipped = true;
      skipReason = "no_candidates";
      chosen = [];
    } else {
      chosen = picked;
      skipReason = capped ? "capped_by_max_ratio" : null;
    }
  }

  const candidateOrigTotal = candidates.reduce((s, c) => s + c.originalLen, 0);
  const candidatePlaceholderTotal = candidates.reduce((s, c) => s + c.placeholderLen, 0);

  const newMessages: (LocalCompressMessage | null)[] = messages.map((m) => ({ ...m }));
  const pickedPairs = new Set<number>();
  const hashMap: Record<string, HashMapEntry> = {};
  let compressedCount = 0;

  for (const c of chosen) {
    const qMsg = messages[c.qIdx];
    const qMedia = storeMedia ? extractMediaBlocks(qMsg?.content) : null;
    hashMap[c.hash] = {
      q: c.text,
      a: (messages[c.aIdx]?.content as string) || "",
      ...(qMedia ? { qMedia } : {}),
      qIdx: c.qIdx,
      aIdx: c.aIdx
    };
    if (c.toolBoundary) {
      // 本地修正:含 tool_use 的 pair → 只压缩 text 块,保留 tool_use /
      //   tool_result 块;pair 连同其依赖的 tool_result 一起压,避免孤儿。
      newMessages[c.qIdx] = replaceTextBlocksWithPlaceholder(messages[c.qIdx], c.placeholder);
      newMessages[c.aIdx] = replaceTextBlocksWithPlaceholder(messages[c.aIdx], c.placeholder);
      const boundaryMsg = messages[c.aIdx + 1];
      if (boundaryMsg && boundaryMsg.role === "user" && isToolResultOnly(boundaryMsg)) {
        newMessages[c.aIdx + 1] = replaceTextBlocksWithPlaceholder(boundaryMsg, c.placeholder);
      }
    } else {
      newMessages[c.qIdx] = { ...messages[c.qIdx], content: c.placeholder };
      newMessages[c.aIdx] = null;
    }
    pickedPairs.add(c.qIdx);
    compressedCount++;
  }
  let filteredMessages = newMessages.filter((m): m is LocalCompressMessage => m !== null);

  let blockCandidates: BlockCandidate[] = [];
  let blockOrigTotal = 0;
  let blockPlaceholderTotal = 0;
  let blockCompressedCount = 0;
  if (blockThresholdChars > 0 || compressMedia || compressToolResults) {
    const skipMsgIndices = new Set<number>();
    const firstUserIdx = filteredMessages.findIndex((m) => m?.role === "user");
    if (firstUserIdx >= 0) skipMsgIndices.add(firstUserIdx);
    let recentCount = 0;
    for (let i = filteredMessages.length - 1; i >= 0 && recentCount < keepRecentPairs * 2; i--) {
      const role = filteredMessages[i]?.role;
      if (role === "user" || role === "assistant") {
        skipMsgIndices.add(i);
        recentCount++;
      }
    }
    filteredMessages.forEach((m, i) => {
      if (skipMsgIndices.has(i)) return;
      if (!m) return;
      const c = m.content;
      if (
        typeof c === "string" &&
        (c.startsWith(PLACEHOLDER_PREFIX) || c.startsWith(LEGACY_PLACEHOLDER_PREFIX))
      ) {
        skipMsgIndices.add(i);
      }
    });
    blockCandidates = collectBlockCandidates(filteredMessages, skipMsgIndices, {
      blockThresholdChars,
      compressMedia,
      compressToolResults,
      toolResultThresholdChars,
      keepRecentToolResults,
      maxCompressToolResults
    });
    for (const bc of blockCandidates) {
      const m = filteredMessages[bc.msgIdx];
      if (!m) continue;
      applyBlockCandidate(m, bc);
      hashMap[bc.hash] = blockCandidateEntry(bc);
      blockOrigTotal += bc.originalLen;
      blockPlaceholderTotal += bc.placeholderLen;
      blockCompressedCount++;
    }
  }

  const totalCandidateOrig = candidateOrigTotal + blockOrigTotal;
  const totalCandidatePlaceholder = candidatePlaceholderTotal + blockPlaceholderTotal;
  const ratio =
    totalCandidateOrig > 0 ? 1 - totalCandidatePlaceholder / totalCandidateOrig : 0;

  return {
    messages: skipped ? messages.map((m) => ({ ...m })) : filteredMessages,
    hashMap: skipped ? {} : hashMap,
    stats: {
      candidateOrigTotal: totalCandidateOrig,
      candidatePlaceholderTotal: totalCandidatePlaceholder,
      sessionCompressedChars: totalCandidatePlaceholder,
      ratio,
      compressedCount: skipped ? 0 : compressedCount + blockCompressedCount,
      candidateCount: candidates.length + blockCandidates.length,
      naturalRatio,
      skipped,
      skipReason,
      blockCandidates: blockCandidates.length,
      blockThresholdChars
    }
  };
}

export const HC_DEFAULTS = {
  MIN_CHARS: DEFAULT_MIN_CHARS,
  KEEP_RECENT_PAIRS: DEFAULT_KEEP_RECENT_PAIRS,
  TOOL_RESULT_THRESHOLD_CHARS: DEFAULT_TOOL_RESULT_THRESHOLD_CHARS,
  KEEP_RECENT_TOOL_RESULTS: DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  MAX_COMPRESS_TOOL_RESULTS: DEFAULT_MAX_COMPRESS_TOOL_RESULTS,
  PLACEHOLDER_PREFIX,
  PLACEHOLDER_SUFFIX,
  LEGACY_PLACEHOLDER_PREFIX
};
