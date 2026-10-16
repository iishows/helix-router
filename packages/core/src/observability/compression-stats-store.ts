/**
 * helix V1.2 / 2026-10-13: 提取 compressionStatsStore 到独立模块。
 *
 * 原位置: `packages/core/src/gateway/core-runtime/router-plugin.ts`
 * - type `CompressionStat` (line 201-210)
 * - const `compressionStatsStore` (line 212-...)
 *
 * 提取原因：
 * 1. request-log worker (独立子进程) 需要读到 `requestId → stats` 的映射
 *    把 stats 写进 request_logs 表的 compression_* 列。
 * 2. 让 router-plugin.ts (core gateway 进程) 和 request-log-store.ts (worker 进程)
 *    共享同一个 in-memory store shape, 避免重复实现 + 漂移。
 * 3. 加 `preCompressionTokens` / `postCompressionTokens` 字段
 *    (之前 `applyHelixCompressorTransform` line 1057-1069 算过但没存到 store)。
 *
 * 容量保护：MAX_ENTRIES=1000,超过时按插入顺序淘汰最早的 key。
 * (keyed by upstreamRequestId, 同一 id 在 transform/hook 间稳定)
 */

/**
 * 主动 compact 统计(2026-10-15):当 helix 压缩后仍超 token 预算时,网关折叠更早历史成一个摘要。
 * 该结构随之写进 compression stat,供 sidecar / request_logs / UI 展示。
 */
export type ProactiveCompactStat = {
  /** 摘要来源:cache / accumulate / incremental / model。 */
  source: string;
  /** 摘要覆盖的历史代次(累计被折叠消息条数)。 */
  coveredCount: number;
  /** 本次折叠掉的更早历史条数。 */
  foldedCount: number;
  /** 折叠后提交给上游的 messages token 数(= 修正后的 postCompressionTokens)。 */
  tokensAfter: number;
  /** 摘要自身 token 数(model/incremental 才有)。 */
  summaryTokens?: number;
  /** 本次生效的 compact 预算(percent 路径为 clamp 后值,否则 = tokenBudget)。 */
  budgetTokens?: number;
  /** compact 之前(仅 helix 压缩后)的 token 数,用于对比。 */
  preCompactTokens: number;
};

export type CompressionStat = {
  /** 压缩前 user messages 的字符数 (helix 返回的 stats.originalChars) */
  inputChars: number;
  /** 压缩后实际发给 LLM 的 messages 字符数 (helix 返回的 stats.finalTokens 折算 chars) */
  compressedChars: number;
  /** 压缩比 (1 - compressed/original), 0 表示没压缩 */
  ratio: number;
  /** Q&A pair 压缩占位数 (⟦QA:hash⟧ 出现次数) */
  compressedCount: number;
  /** Helix 内部 cache hash map 大小 */
  hashMapSize: number;
  /** LLM 模型名 (例如 "MiniMax-M3") */
  model?: string;
  /** helix 场景标识 ("chat" / "code_generation" / "tool_use" 等) */
  scenario?: string;
  /** helix 处理耗时 (毫秒) */
  durationMs?: number;
  /** 是否存储了 media bytes (用于 recall 时还原) */
  qMediaStored?: boolean;
  /**
   * helix V1.2 / 2026-10-13: 压缩前 user messages 用 gpt-tokenizer (cl100k_base) 算的真实 token 数。
   * 这是 UI 显示的 "197 tok" 这类数据。`applyHelixCompressorTransform` 内部已算 (router-plugin.ts:1057-1069),
   * 但之前没存到 store,导致 UI 只能从 response_headers["x-helix-compressor-baseline-tokens"] 读(实际是空 {})。
   * 现在存到 store 后,request-log worker 可以读到并写进 request_logs.compression_baseline_tokens 列。
   */
  preCompressionTokens?: number;
  /** 压缩后发给 LLM 的 messages 用 gpt-tokenizer 算的真实 token 数。 */
  postCompressionTokens?: number;
  /**
   * 主动 compact 统计(2026-10-15)。命中时 postCompressionTokens 会被修正为 compact 后的
   * 真实提交量(= tokensAfter);此字段保留 compact 的完整分解供 UI 展示。
   */
  proactiveCompact?: ProactiveCompactStat;
};

const MAX_ENTRIES = 1000;

/**
 * 模块级 Map: upstreamRequestId → CompressionStat
 * 单 gateway 实例就够 (一个 ccr-cli 跑一个 core gateway 子进程)。
 * request-log worker 是不同进程,不能直接 import,需要通过 IPC 或持久化层传递。
 * 当前架构: router-plugin.ts (gateway 进程) 写, request-log worker 通过 raw trace
 * sync 拉 raw response headers,反解出 stats。
 *
 * 注意: request-log worker 跟 core gateway 是同一个 Node 进程内 spawn 出来的子进程
 * (gateway-bootstrap.js fork 出来), 实际上 ccr 的架构是:
 *   ccr-cli (主进程) → spawn → core gateway (子进程) + request-log worker (独立子进程)
 *  所以两边不能直接共享内存 — 这个 store 必须在 core gateway 进程内。
 *
 * 但 UI 拿到的 `RequestLogEntry.compressionBaselineTokens` 来自 raw trace sync 的 data,
 * 那是 core gateway 写 raw trace event, request-log worker 读后写 DB。
 * 所以 store 必须从 router-plugin 推到 raw trace event。
 */
const store = (() => {
  const m = new Map<string, CompressionStat>();
  const origSet = m.set.bind(m);
  m.set = (key: string, value: CompressionStat) => {
    if (m.size >= MAX_ENTRIES && !m.has(key)) {
      const firstKey = m.keys().next().value;
      if (firstKey !== undefined) m.delete(firstKey);
    }
    return origSet(key, value);
  };
  return m;
})();

/**
 * 写 stats (transform 阶段调用,keyed by upstreamRequestId)
 */
export function setCompressionStat(key: string, value: CompressionStat): void {
  store.set(key, value);
}

/**
 * 读 stats (response hook / request-log worker 消费)
 * 返回 undefined 表示没找到 (例如 transform 没跑,或已经被 delete)。
 */
export function getCompressionStat(key: string): CompressionStat | undefined {
  return store.get(key);
}

/**
 * 读后立刻删除 — 一次性消费 (response hook 推到 client 后,内存里就不需要了)。
 * 但是为了写 DB (request-log worker 也能消费), 改成"读但不删",
 * 由 raw trace sync 端保证去重。
 *
 * 暂时保留 `consume` 用于 response hook 推 headers 的场景 (推完即删,避免内存泄漏)。
 */
export function consumeCompressionStat(key: string): CompressionStat | undefined {
  const v = store.get(key);
  if (v) store.delete(key);
  return v;
}

/**
 * 全局 store (直接暴露,供已经持有 reference 的调用方使用)。
 * 建议优先用上面三个具名函数,避免散弹式访问。
 */
export const compressionStatsStore = store;
