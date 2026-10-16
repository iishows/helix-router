# 主动 compact：压缩后仍超预算时，网关侧折叠老历史再转发（实现说明）

本文档记录 `fizzy-meandering-russell` 计划的落地实现与配置说明。分支：`feature/helix-compressor-recall`。

---

## 1. 问题

helix 压缩后请求体仍可能远超 token 预算：整轮「必保」内容（最近几轮原文、system、tools、压不掉的部分）不会因为压缩而消失。ccr 在此之前**没有任何 token 预算概念**——压缩不达标时不会触发任何 compact，12 万 token 的请求照样原样打给上游。

**关键架构事实（决定接入点）**：生产跑「单网关模式」——只有 :3456 在听，托管 core gateway 用外部 `next-ai-gateway.js` + 我们的 `router-plugin.js`。`packages/core` 的 `GatewayRequestPipeline`（`pipeline.ts`）**不在流量链路上**。因此主动 compact 必须做在 `router-plugin.ts` 的 `applyHelixCompressorTransform` 内。

## 2. 行为

一旦 helix 压缩后 `postCompressionTokens > tokenBudget`：

1. 把更早的历史折叠成一个摘要，**只保留最近 `keepRecentTurns` 个「新用户轮」原文**，用折叠后的 body 转发。
2. 摘要复用当前路由模型（两次上游调用：本模块摘要调用 + 网关正常转发）。
3. 跨轮去重 = 缓存 + 增量：按 `sessionId + 折叠前缀 hash` 缓存摘要；前缀未变 → 命中复用（零额外调用）；前缀变长 → 只摘要 delta 并与旧摘要合并。

**设计约束**：

- 只做「丢前缀 + 改 system」，**不动 role 序列** → 不会触发 role 交替 400。
- 切点只落在「新用户轮起点」→ `tool_use`/`tool_result` 对绝不跨切点。
- 任何失败（fetch 抛错 / 超时 / 非 2xx / 空文本）都返回 `undefined`，原 body 照常转发（静默降级，绝不报错）。

诊断写进响应头 `x-ccr-helix-proactive-compact`，形如：

```
gen=6,source=model,folded=6,tokens_after=1234,summary_tokens=210
```

`source` 取值：`model`（整段新摘要）/ `incremental`（前缀命中增量摘要）/ `cache`（逐字节前缀命中，零调用）/ `accumulate`（积攒期复用旧前缀摘要、中间段留原文，零调用）。

> 「积攒」机制（2026-10-16）：一旦某会话已有前缀摘要，只有**未覆盖的新历史**累计到 `proactiveCompactMinNewMessages` 条，才重做一次（增量）摘要；否则一律复用旧摘要、把未覆盖区间当原文一起发。这样把「每轮一次摘要调用」降到「每 N 条一次」，同时 folded 前缀逐字节不变 ⇒ 零额外调用。

## 3. 配置（helix-compressor 插件 config）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `tokenBudget` | number | `100000` | 绝对预算（token）；`0` = 关闭主动 compact |
| `keepRecentTurns` | number | `2` | 保留最近 N 个「新用户轮」原文 |
| `proactiveCompactTimeoutMs` | number | `60000` | 摘要调用超时（ms） |
| `proactiveCompactModel` | string | 空 | 可选覆盖摘要模型；空 = 用当前路由模型 |
| `proactiveCompactCacheTtlMs` | number | `259200000`（3 天） | 摘要缓存 TTL（ms） |
| `proactiveCompactMinNewMessages` | number | `100` | 积攒阈值：未覆盖新历史 ≥ 该值才重摘；`0` = 关闭积攒 |

示例：

```json
{
  "id": "helix-compressor",
  "enabled": true,
  "config": {
    "tokenBudget": 100000,
    "keepRecentTurns": 2,
    "proactiveCompactTimeoutMs": 60000,
    "proactiveCompactModel": "",
    "proactiveCompactCacheTtlMs": 259200000,
    "proactiveCompactMinNewMessages": 100
  }
}
```

> E2E 验证若要触发主动 compact，需把 `tokenBudget` 调到小于压缩后 token（如 `200`）。

## 4. 涉及的代码

| 文件 | 作用 |
|---|---|
| `packages/core/src/gateway/features/helix-proactive-compact.ts` | 门控 / 切点 / 缓存 / 摘要调用 / 组装 |
| `packages/core/src/observability/helix-compact-summary-store.ts` | 内容寻址 JSONL 摘要缓存（`{HELIX_RECALL_CACHE_DIR}/helix-compact/summaries.jsonl`） |
| `packages/core/src/observability/compression-stats-store.ts` | `ProactiveCompactStat` 类型 + 进程内 stat 汇总 |
| `packages/core/src/plugins/built-ins/helix-compressor.ts` | 5 个配置键 + 默认值 + parseConfig |
| `packages/core/src/gateway/core-runtime/router-plugin.ts` | 接入 `applyHelixCompressorTransform` + 双通道诊断头 + sidecar |
| `packages/core/src/contracts/app.ts` | `CompressionProactiveCompactStat` + `RequestLogEntry.compressionProactiveCompact` |
| `packages/core/src/observability/request-log-store.ts` | `compression_proactive_compact_json` 列 + 解析（见 §6） |
| `packages/ui/src/pages/home/shared/logs.ts` / `components/network-logs.tsx` | compact 摘要展示（见 §6） |

## 5. 门控（任一不满足 → 不折叠）

- `tokenBudget > 0` 且 `postCompressionTokens > tokenBudget`。
- `hasExplicitCompactSignal(body, headers)` 为假（避免与客户端 compact 双折叠）。
- 「新用户轮」数 ≥ `keepRecentTurns`（否则无更早历史可折）。

## 6. 跨进程落库 + UI（彻底修复）

诊断头只存在于单进程内存里，UI 与 DB 都在别的进程/连接，因此需要一条真正的跨进程通道。生产 DB 的 `request_logs_compression_extract` trigger 只从 **`request_headers`** 反解 `x-helix-compressor-*` 填 `compression_*` 列（helix 插件把 token 头 emit 到 request headers，见 `helix-compressor.ts` 的 header 段），而 `response_headers` 实测为空。故 compact 明细也必须走 request headers。

- **双通道诊断头**：compact 命中时，除响应头外，把 `x-ccr-helix-proactive-compact`、结构化 `x-ccr-helix-compact-json`、以及**修正后**的 `x-helix-compressor-compressed-tokens`/`-submitted-tokens` 一并写进 request headers（`router-plugin.ts` 的 `applyHelixCompressorTransform`，用 `requestHeadersOut` 叠加）。
- **结构化明细** `x-ccr-helix-compact-json`：`{source,coveredCount,foldedCount,preCompactTokens,tokensAfter,summaryTokens?}`。
- **DB 列** `request_logs.compression_proactive_compact_json`（`request-log-store.ts` DDL + migration + 三处 SELECT）。
- **trigger 不认该 key**：worker 在 raw-trace update 路径显式 `pushValue("compression_proactive_compact_json", ...)`；insert 路径 `pickHeader` 优先 request headers、fallback response headers。读回经 `parseProactiveCompactRow` → `RequestLogEntry.compressionProactiveCompact`。
- **UI**：`packages/ui/src/pages/home/shared/logs.ts` 的 `logProactiveCompact`（entry 字段优先，fallback header）+ `compactSourceLabel`；`network-logs.tsx` 的 `LogCompressDetails` 渲染「主动 compact 节省 / 来源 / 折叠条数 / 摘要 token」。

## 7. 不做的

- 不把这条链改造/迁移到 `pipeline.ts`（当前单网关模式下它不服务流量）。
- 不实现真正的「语义摘要」本地算法（复用上游 handoff 范式）。
- 首版摘要不注入 archive / `ccr_history_ask`（折叠掉的原文进本地缓存，可选后续增强）。
- 不改 `auto_compact_windows` 的 1M clamp（那是「让 CC 自己 compact」的另一条路，与本方案独立）。
