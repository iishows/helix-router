# 全本地闭环：本地压缩 + 本地缓存 + 本地召回（设计稿）

本文档给出把 helix 的**压缩 / 缓存 / 召回**三个环节全部搬到 CCR 本地执行的方案，去掉对云端 `helix-compressor` 服务的运行时依赖（V3.x 确定性路径）。目标是让 `⟦QA:hash⟧` / `⟦HC:hash⟧` 占位符在**同一个进程边界内**可压缩、可缓存、可召回，从而真正闭环。

收稿日期：2026-10-14。分支：`feature/helix-compressor-recall`。

---

## 1. 背景：为什么现在 recall 跑不通

现状（详见 `project_helix_recall_gateway` 记忆与实机验证）是三层断裂叠加：

| # | 断裂点 | 事实 |
| --- | --- | --- |
| 1 | **recall 执行体零注册** | `helixCompressorResponseHook`（`packages/core/src/plugins/built-ins/helix-compressor.ts:1076`，返回 `continueLoop:true` 那段）在生产代码里**无任何调用方**，只在单元测试（`helix-compressor-recall.test.mjs` / `helix-compressor-qa-recall.test.mjs`）里被调。**注意同名双值常量隐患**：`helixCompressorResponseHookKey` 在两处定义且值不同——contract 侧 `packages/core/src/gateway/core-runtime/router-plugin-contract.ts:21` = `"helix-compressor-response-hook"`，插件侧 `helix-compressor.ts:133` = `"helix-compressor-quality-feedback"`，两者均无生产引用。改造时须先统一命名，否则极易注册错 key。 |
| 2 | **运行网关不支持续跑协议** | 真实请求路径由外部包 `@the-next-ai/ai-gateway`（部署为 `dist/main/next-ai-gateway.js`）处理。它的 response hook 只有 `transformResponse`（原地改写），bundle 里 `continueLoop` / `messagesToAppend` / `runHelixCompressorRecallLoop` **零出现** → 网关无法"追加 tool result 消息 + 重发" → recall 无法闭环。 |
| 3 | ~~**压缩把最终提问也吞了**~~ → **实为 mock 假象，非产品 bug** | 现场"末轮提问变占位符"的现象**已定位为 mock 测试桩的产物，不是真实算法行为**：<br>① 云端真实 `hc.js` 的 `keepFrom` = 最后一条 assistant 索引 → 末轮 user 提问天然保留（金值测试已证，见 §4.4）；<br>② 请求日志 DB（`request-logs.sqlite`）中**所有**带压缩的请求 `x-helix-compressor-scenario` 均为 **`mock`**（近 200 条无一例外），即从未真正经云端压缩；<br>③ 直连 mock 压缩服务（`127.0.0.1:7788/v1/compress`）实测：它把**首条 user 之外的所有消息（含 assistant 与末轮 user 提问）全部替成 `⟦HC:hash⟧`**（V2 前缀），是朴素测试替身。<br>**结论**：recall 断链的真实原因只有 断裂点 1 + 2；断裂点 3 撤销。附带：mock 发 `⟦HC:⟧` → 触发 `hc_recall`，与云端的 `⟦QA:⟧` → `history_recall` 是**不同工具路径**，用 mock 测 recall 测的是错的那条。 |

结论：**不是 LLM 不配合，也不是算法不对**——是"谁负责续跑 loop"这件事在外部网关下没有落点，且本地既没有原文缓存、也没有可拦截的 local recall 工具。

---

## 2. 目标与不变量

**目标**：`ℒ` = 本地闭环。一次请求里：

1. 压缩在 CCR 本地完成（确定性、无网络）。
2. 被替换的原文立刻落到**本地缓存**（hash → 原文），`ℒ` 内可即时取回。
3. LLM 若调用 `hc_recall` / `history_recall`，由**网关内部的 tool loop** 拦截并回填，无需客户端参与、无需 response hook 续跑。

**不变量（必须逐字节成立）**：

- **hash 一致性**：本地 `computeHash` 的结果必须与云端 `hc.js` 逐字节一致（无 salt，纯 sha256 前 16 hex）。
- **口径一致性**：hash 的输入必须是**即将发给上游的那份 content**，`extractText` 的 `\n` 拼接口径、media 块的 `JSON.stringify(block)` 键序必须完全对齐。
- **无网络依赖**：`ℒ` 内不出现对 `helixApiUrl` 的运行时调用（V3.x 路径）。

---

## 3. 总体架构

```
┌─────────────────────────── CCR core (main process) ───────────────────────────┐
│                                                                                │
│  config-compiler.ts ──► 编译虚拟模型 profile                                    │
│        │                     │                                                  │
│        │                     ├─ mcpServers += helix-recall-mcp (stdio 子进程)   │
│        │                     └─ virtualModelProfiles[*].execution.matchRecall   │
│        │                                                                        │
│   router-plugin.ts (gateway 进程内)                                             │
│        └─ helixCompressorTransform                                              │
│             1. 本地 compressV3x(messages)  ← 端口自 helix-compressor/src/compress│
│             2. hashMap → LocalCacheStore.putBatch()                             │
│             3. 占位符替换后的 messages 发上游                                     │
│                                                                                │
│  helix-recall-mcp.js (stdio MCP server, 网关 spawn)                            │
│        └─ tool hc_recall / history_recall → LocalCacheStore.get()              │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
                                   │
                    gateway internal tool loop（网关自己续跑）
                                   ▼
                          upstream LLM (MiniMax / …)
```

四个组件：**① 本地压缩器**、**② 本地缓存**、**③ 召回 MCP 工具**、**④ profile 挂载**。①③ 共用一份本地 JSONL 缓存（内容寻址，写一次读多次；不用 SQLite，见 §5.1 修订）。

---

## 4. 组件①：本地压缩器

### 4.1 端口范围

把 `D:/projects/helix-compressor/src/compress/hc.js` 的 **V3.x 确定性路径**移植成 TS：

| 云端函数 | 位置 | 作用 |
| --- | --- | --- |
| `computeHash(content)` | `hc.js:39` | `sha256(content,'utf-8').digest('hex').slice(0,16)` |
| `makePlaceholder(hash)` | `hc.js:46` | `⟦QA:<hash>⟧` |
| `selectCompressibleIndices` | `hc.js:91` | anchor + recent 策略选 Q&A 候选 |
| `extractText(content)` | `hc.js:247` | string 原样；array 的 text 块用 `\n` 拼接 |
| `selectBlockCandidates` | `hc.js:161` | V3.3 block 级候选（text / media） |
| `extractMediaBlocks` | `hc.js:272` | 媒体块提取（`storeMedia` opt-in） |
| `compressV3x(messages, options)` | `hc.js:341` | 主入口，返回 `{messages, hashMap, stats}` |
| `HC_DEFAULTS` | `hc.js:726` | `MIN_CHARS=500` / `KEEP_RECENT_PAIRS=1` / 前缀常量 |

**不移植**（第一期）：`budget.js`（V4.5，954 行）、`compact.js`（True Compact 语义摘要，需 LLM）、`measure.js`、PostgreSQL `cache.js`、`billing/`。

### 4.2 落地位置

```
packages/core/src/plugins/built-ins/helix-compressor/
  ├─ hc-local.ts        # 端口 compressV3x / computeHash / extractText / selectBlockCandidates
  ├─ hc-local-types.ts  # CompressOptions / HashMapEntry / CompressResult
  └─ index.ts
```

`hc-local.ts` 是**纯函数模块**（无 IO、无网络），便于单测与 hash 金值回归。既有 `helix-compressor.ts` 保持为 transform 外壳，内部改为调用 `hc-local.ts` 而非 `fetch(/v1/compress)`。

### 4.3 接口契约（与云端对齐）

```ts
export interface HashMapEntry {
  q: string;              // user 文本（block 级为块文本）
  a: string;              // assistant 文本（block 级为 ""）
  blockOnly?: boolean;
  kind?: "text" | "media";
  msgIdx?: number;
  blockIdx?: number;
  qMedia?: unknown[];     // storeMedia=true 时的原媒体块
}

export interface CompressResult {
  messages: LLMMessage[];
  hashMap: Record<string, HashMapEntry>;
  stats: { ratio: number; compressedCount: number; /* … */ };
}

export function compressV3x(messages: LLMMessage[], options: CompressOptions): CompressResult;
```

返回形状与云端 `CompressResponse.compressed` + `hashMap` 一一对应（`helix-compressor.ts:88`），使 transform 改动面最小。

### 4.4 压缩策略修正（对应断裂点 3）— 已修订

> **修订（2026-10-14，P0 金值测试推翻原假设）**：本节初稿断言"云端 `keepRecentPairs=1` 会把最后一轮 user 提问压掉"。**实机比对云端 `hc.js` 证明此假设错误**——`keepFrom` 被赋值为**最后一条 assistant 消息的索引**（`hc.js:122-131`），因此末轮 user 提问（位于该 assistant 之后）**天然落在候选范围 `[0, keepFrom)` 之外，原文保留**。用 12 对历史 + 末轮提问的真实结构跑云端 `compressCCR(..., {keepRecentPairs:1})`，输出最后一条即完整提问，非占位符。
>
> 结论：**cloud V3.x 本身不会吞掉末轮提问**。断裂点 3 的"提问被压掉"若真实发生，根因不在 `compressV3x` 的末轮处理，而须另找（候选见 §4.4 下方）。本地端口因此**默认与云端一致（`protectFinalUserQuestion: true`，但该开关在此结构下为 no-op）**，不引入行为分叉。

**仍保留的保护开关（防御性）**：`hc-local.ts` 的 `protectFinalUserQuestion`（默认 `true`）在 `selectCompressibleIndices` 内额外剔除"最后一条 user 消息的索引"。当前 fixture 下它与云端产出一致（末轮提问本就在 `keepFrom` 之外，剔除是 no-op）；仅在**末轮提问恰落在 `keepFrom` 之前**的畸形结构（例如末尾是 `assistant` 收尾、最后一对之后又跟了 user 却缺少配对的 assistant）下才会生效。可置 `false` 复现金值比对。

**断裂点 3 的真实根因待查（P0 未消解）**：金值测试同时证明——**云端在 12 对上返回 `compressedCount=0`**：`shouldSkipMessage`（`hc.js:60`）按**单条 content 字符数**计，我的 fixture 每条 user ≈505 字符 ≥ `minChars=500`，但 `qText.length + aText.length < minChars * 2`（`hc.js:394`，阈值实为 1000）把配对筛掉了。真实长上下文的配对待压缩，故压缩是活的。**但"提问被吞"的现场观测（末轮 user 变 `⟦QA:hash⟧`）另有来源**，最可能的两个方向：
> 1. **客户端 preprocess / skills 压缩**（`helix-compressor.ts` 的 `clientPreprocess` / `clientCompactSkills`）在提交云端前改动了消息结构或索引，使"最后一条 user"不再是真实提问；
> 2. **cloud 端 V4.5/True Compact 路径**（§10 caveat 所述，由云端 DB `compression_settings` 决定）而非 V3.x 路径在生产实际执行。
>
> 此项列为 P1 的**必查前置**：在接入本地压缩前，先复现"提问被吞"的确切输入结构，否则本地端口会继承一个未定位的 bug。

### 4.5 本地修正：含 tool block 的消息不得整条删除（2026-10-15）

> **背景（实机 400 定位）**：真实 Claude Code 请求（`request_logs` id 3584，MiniMax-M3）返回 HTTP 400
> `invalid params, tool result's tool id(call_01a13e359eb373548be41054) not found (2013)`。压缩后 body 只剩
> `system + ⟦QA:d1e0fad99226a6f8⟧ + tool_result ×2`——两条 `tool_result` 引用的 `tool_use` 已在压缩中被删。

**根因**：`compressV3x` 的 Q&A pair 压缩会把 **assistant 消息整条设 `null` 删除**（`hc-local.ts` `newMessages[c.aIdx] = null`）。真实 Claude Code 历史里 assistant 常携带 `tool_use`；删掉整条后，下游 user 消息中引用它的 `tool_result` 变成孤儿，上游以 400 `2013` 拒绝。`shouldSkipMessage` 的 `charCount` 只累加 `type==="text"` 块，故含 `tool_use` 的大 assistant 消息仍会入选候选。

**修正**（对云端 `hc.js` 的**有意行为分叉**，会偏离逐字节 parity）：

1. 新增 `hasToolBlock` / `hasToolUseBlock` / `isToolResultOnly` / `replaceTextBlocksWithPlaceholder` 辅助函数。
2. pair 候选中，若 user 或 assistant **含 tool block**（`tool_use`/`tool_result`），仍按 pair 收集，但标记 `toolBoundary: true`。
3. 应用阶段对 `toolBoundary` 的 pair：**不删除消息**，而是把两侧的 **text 块**替换为 `⟦QA:hash⟧`，**保留所有 tool 块**；若 `aIdx+1` 是"仅含 `tool_result`"的 user 消息，也把其 text 块一并压缩（pair 与 tool 边界一起收尾），从而消除孤儿。
4. 纯字符串内容的 pair 仍沿用云端行为（整条删除 assistant），**parity 不变**。

**代价**：含 tool 的 pair 压缩率略低于云端（保留 tool_use/tool_result 结构），但换取了不产生 400 的正确性。回归测试见 `helix-local-parity.test.mjs` 的 "tool_use assistant pair compresses text but keeps tool blocks" / "orphan tool_result never appears..." 两例。

---

## 5. 组件②：本地缓存

### 5.1 存储选型（已修订：不用 SQLite）

> **修订（2026-10-14，P1 实测约束）**：初稿选 `node:sqlite`/SQLite，**不可行**：
> - ccr 用的是 **`better-sqlite3`（原生）**，不是 `node:sqlite`（`request-log-store.ts:13` 经 `@ccr/core/storage/sqlite-native` 包装）。
> - 但召回读取发生在 **MCP stdio 子进程**，而 esbuild 明确把轻量 MCP bundle 限制为 **≤128 KB 且禁止原生 SQLite**（`esbuild.config.mjs:75-85`：`better-sqlite3/` 前缀被列 `forbiddenLightweightMcpInputs`，`better-sqlite3` 在 `forbiddenLightweightMcpExternalImports`）。
> - `node:sqlite` 在 Electron 的 Node 里是实验特性、默认无 flag 不可用，同样不保险。
>
> **改为**：**零依赖的 append-only JSONL 缓存**（`node:fs` only，压缩端与 MCP 子进程都能轻量加载）。

- **文件**：`{HELIX_RECALL_CACHE_DIR}/cache.jsonl`（目录默认 `{DATADIR}/helix-recall/`；DATADIR = `C:/Users/lenovo/AppData/Roaming/claude-code-router`，来自 `config/constants.ts:16` `DATADIR`）。
- **格式**：每行一条 JSON `{"h":"<hash>","c":{...HashMapEntry},"t":<createdAtMs>,"e":<expiresAtMs>}`。
- **语义**：append-only、不可变行；读取时后者覆盖前者（同 hash 幂等）。TTL 默认 3 天。

### 5.2 读取索引与 compaction

- **进程内索引**：首读时流式扫一遍文件建 `Map<hash, {offset}>`，`get(hash)` 用 `readSync(file, len, offset)` 只读该行（O(1) 读，不整文件加载）。
- **写入**：`appendFileSync(dir, line + "\n")`，随后更新进程内 Map。内容寻址写入幂等。
- **compaction**：文件超过阈值（如 64 MB）或过期行占比高时，重写为仅含未过期、每 hash 最后一行的新文件（写 `.tmp` 后 `renameSync` 原子替换）。
- **响应体积**：召回工具只回"被请求的 hash → 原文"，单条通常 < 4 KB，不受文件总大小影响。

### 5.3 访问层

```
packages/core/src/observability/helix-recall-local-store.ts
```

导出（无原生依赖，可被 MCP 子进程直接引用）：

```ts
export function putBatch(entries: Array<[string, HashMapEntry]>): number;   // transform 写入(append)
export function get(hash: string): HashMapEntry | null;                     // 召回读取
export function batchGet(hashes: string[]): Record<string, HashMapEntry>;   // 批量召回
export function cleanup(): number;                                          // TTL 清理 + compaction
export function resolveCacheDir(): string;                                  // HELIX_RECALL_CACHE_DIR ?? {DATADIR}/helix-recall
```

### 5.4 多进程共享与并发

压缩发生在 **gateway 进程内的 router-plugin transform**；召回发生在**网关 spawn 的 MCP stdio 子进程**。两进程访问**同一 JSONL 文件**：

- **写（压缩端，单进程）**：`appendFileSync` 追加。POSIX/Windows 对小于 PIPE_BUF/单次 write 的 append 行基本原子；每行末尾 `\n` 保证可切分。
- **读（召回端）**：只读已完整写入的行；**忽略最后一行若不以 `\n` 结尾**（正在写）。读到半写行即丢弃，下次索引重建时纳入。
- **一致性**：内容寻址 + 幂等 ⇒ 重复 append 或半写丢弃都不会导致错读。
- 不做跨进程锁（无依赖前提下不可靠）；改为"写者唯一 + 读者容忍半行"的设计。

缓存目录通过**环境变量 `HELIX_RECALL_CACHE_DIR`** 同时传给 router-plugin 与 MCP 子进程（MCP server 的 `env` 里带上，见 §6.2），避免依赖各自工作目录。

### 5.5 与现状的差异

现状 `router-plugin.ts:950` 给 helix 的 context 传的是**假路径** `{configDir:"",dataDir:"",pluginDataDir:""}`，且 `openSqliteStore` 直接 `throw`（`"Helix Compressor does not use plugin SQLite storage in the core gateway plugin."`）。本方案**不复用**插件 sqlite 通道，而是走独立路径常量 + 环境变量，改动点见 §8。

---

## 6. 组件③：召回 MCP 工具

### 6.1 为什么做成 MCP internal tool（而非 response hook）

外部网关 `@the-next-ai/ai-gateway` 只支持 `transformResponse`，**不支持 `continueLoop` / `messagesToAppend`**（见 §1）。因此 recall 的续跑只能由网关**原生 tool loop** 完成。

> **⚠️ 修订（2026-10-14 P2 实测，推翻初稿的 fusion 类比）**：初稿断言"照抄 fusion 模式"，把 recall 挂到 `virtualModelProfiles` 的 internal tool loop。**实测证明此路对普通请求不通**：
> - 网关的虚拟模型 profile internal tool loop（`sat` @1674396）**只在请求命中 `virtualModelProfiles` 时激活**（`N1` 里 `config.virtualModelProfiles` 默认 **空数组**，ccr 真实配置亦为 `[]`）。fusion 之所以能跑，是因为它**总是创建 profile**（`withFusionVirtualModelAliases` 给每个启用的 profile 加 alias）。ccr 普通的 Claude Code 请求**不经过 profile**。
> - 为普通请求强行建一个"全局 catch-all profile"代价高（要改写所有模型的路由选择）。
> - `matchRecall` 这个开关**网关根本不认识**：`U8e`（execution 解析 @1295635）只认 `mode / clientToolsPolicy / streamMode / maxTurns / maxToolCalls / matchMultimodal / matchWebSearch / foldInternalResults`，`matchRecall` 被硬丢弃（bundle 中出现 0 次）。
>
> **实际采用的路（已验证闭环）**：网关的**透明工具执行**（transparent tool execution，`iat` @1668975 / `Mat` @1700327）——它读 **`config.transparentToolExecution`**（**不是** profile.execution），对**任意请求**的 assistant 函数调用，只要名字能解析到已注册 MCP 工具（`que`：精确名或唯一 `.name` 后缀）、且在 `allowTools` 白名单内，就由网关执行、回填、续同一轮。`config-compiler.ts` 在本地压缩模式下注入：
> ```jsonc
> "transparentToolExecution": {
>   "enabled": true,
>   "allowTools": ["hc_recall", "history_recall"],
>   "requireClientDeclaration": false,   // 关键
>   "unknownToolPolicy": "return_to_client",
>   "maxTurns": 4, "maxToolCalls": 8
> }
> ```
> `requireClientDeclaration:false` 是关键：默认 `true` 时网关比对 **客户端原始 `standardRequest.tools`**，而 recall 工具是 helix transform 在 `beforeUpstream` 阶段注入的（不在其中）→ 被判 undeclared → return_to_client（LLM 只看到 tool_call、无结果）。`allowTools` 白名单保证只放行 recall，**客户端自带的其它工具调用仍 return_to_client**（Claude Code / Codex 照旧由客户端自己执行自己的工具）。
>
> 数据流细节：transform 写 `requestBody.tools`（含 recall schema）→ 网关 `Yl` 从 `requestBody` 建 `standardRequest`（含 tools）→ 发出的请求带 recall 工具 → LLM 调 → `iat`/`Mat` 命中 MCP → 执行 → `D1` 回填 tool_result 到 standardRequest → 二次上游 → LLM 作答。见 §7。

### 6.2 工具服务

```
packages/core/src/mcp/helix-recall-mcp.ts   →  编译产物 helix-recall-mcp.js
```

stdio MCP server，条目形如 `fusionBuiltinMcpServer`（`fusion-config.ts:128`）：

```ts
{
  args: [entry],
  command: process.execPath,
  env: { ELECTRON_RUN_AS_NODE: "1", HELIX_RECALL_CACHE_DIR: cacheDir },
  name: "helix-recall",
  protocolVersion: "2024-11-05",
  transport: "stdio",
  requestTimeoutMs: 600000,
  startupTimeoutMs: 600000,
  stdioMessageMode: "content-length"
}
```

暴露两个工具（名字与 `helix-compressor.ts` 现有注入常量 `helixCompressorRecallToolName` 对齐）：

**`hc_recall`** — 批量召回 block / 文本块：

```jsonc
// input
{ "calls": [ { "hash_id": "a1b2…", "reason": "需要 §3 的 p99 数值" } ] }
// output（每条）
{ "hash_id": "a1b2…", "source": "block", "q": "…", "a": "…", "q_media": [ /* opt */ ] }
```

**`history_recall`** — 按 Q&A pair 召回（等价 `hc_recall` 但语义带 pair）：

```jsonc
{ "calls": [ { "hash_id": "a1b2…", "with_media": false } ] }
```

两个工具的 handler 都只是 `helix-recall-local-store.get(hash_id)`，命中回填、未命中回 `{ error: "not_found" }`（对齐云端 `routes.js:545` 的 `error: "not_found"`）。

### 6.3 工具声明方式

照 fusion 模式，在虚拟模型 profile 上声明工具名并开启匹配：

```jsonc
{
  "tools": [ { "name": "hc_recall" }, { "name": "history_recall" } ],
  "execution": { "matchRecall": true }
}
```

`matchRecall` 是新引入的匹配开关（与 `matchWebSearch` / `matchMultimodal` 同族，见 `fusion-config.ts:490` 的 `fusionProfileExecutionFlag`），语义为"当客户端/压缩器声明了 recall 工具时，网关用本地 MCP 实现来兑现它"。它加在 `VirtualModelExecutionConfig`（`contracts/app.ts:1119`）上——该类型是 `VirtualModelProfileConfig`（`contracts/app.ts:1114`）的 `execution` 字段（注意：contract 里**没有** `VirtualModelProfile` 这个类型名）。profile 组装处（§8）按 `matchRecall` 决定是否把 `helix-recall` MCP server 绑到该 profile。

---

## 7. 端到端数据流

```
请求入网关
  │
  ├─ router-plugin: helixCompressorTransform
  │     1. clientPreprocess / clientCompactSkills（保留）
  │     2. r = compressV3x(messages, { keepRecentPairs:1, … })   ← 组件①
  │     3. putBatch(Object.entries(r.hashMap))                    ← 组件②
  │     4. body.messages = r.messages（含 ⟦QA:hash⟧）
  │     5. emit x-helix-compressor-* headers（沿用现有统计链路）
  ▼
上游 LLM 看到占位符 + recall 工具声明
  │
  ├─ LLM 调 hc_recall({calls:[…]})
  │     ▼
  │   网关 internal tool loop → helix-recall-mcp.get(hash)        ← 组件③
  │     ▼
  │   回填 tool_result，同一轮续跑 → LLM 拿到原文作答
  ▼
响应返回（网关不再需要 response hook 续跑）
```

关键点：**组件③ 的调用与续跑完全在网关内部**，不经过客户端，也不依赖 ccr 自身的 `pipeline.ts`（那条路在外部网关下不可达，见 `project_helix_recall_gateway`）。

### 7.1 按模型门控 recall（2026-10-16）

recall 压缩（换 `⟦QA:⟧/⟦HC:⟧` 占位符）**依赖模型会按教学 prompt 调用 recall 工具**。对不会调用 recall 工具的模型，占位符换不来还原 —— 内容被不可逆隐藏，模型只拿到一堆 `⟦QA:⟧` 却不去 recall，等于凭空丢上下文。

因此新增按模型的 recall 白名单（helix-compressor 插件配置）：

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `recallModelPatterns` | `string[]` | `[]` | recall 支持模型的 glob 白名单;**空/未配 = 全部支持**(向后兼容) |
| `recallModelExcludePatterns` | `string[]` | `[]` | 在白名单之后收窄的排除表;空 = 不排除 |

匹配规则:
- `*` 是唯一通配符(任意串);无 `*` 的模式即精确匹配。大小写不敏感。
- 匹配对象是**真实模型名**(如 `MiniMax-M3` 或 `MiniMax (China) 2/MiniMax-M3`):
  同时匹配完整名与最后一个 `/` 之后的段,兼容 provider 前缀差异。
- `included = 空白名单 || 命中任一 include`;`supported = included && !命中任一 exclude`。

生效点(`helixCompressorTransform`,`packages/core/src/plugins/built-ins/helix-compressor.ts`):
`recallSupported = recallModelSupported(model, config)`。

- **命中** → 照旧走 `compressV3x`(占位符 + 落缓存 + model 改写 `ccr-helix-recall/<model>` + recall profile)。
- **未命中** → 跳过 `compressV3x`(不产占位符、不写召回缓存、不改写 model),但**保留安全预清理**(`clientPreprocess` 删空/死信、`clientCompactSkills` 索引),输出 `scenario="skip-recall"`。此请求后续仍走**主动 compact**(摘要折叠,模型能读到摘要)。

**与 compact 的关系**:两者正交。compact(`gateway/features/helix-proactive-compact.ts`)完全不读此配置;不支持的模型因此是「只做 compact 压缩」。全局总开关是 `helixLocalRecallEnabled`(插件存在且未禁用),白名单只在本地压缩路径的模型维度收窄,不影响 `helixLocalRecallEnabled` 对 MCP/profile 注入的判定。

> **形状对齐（P2 实测补）**：LLM 实测按 helix transform 注入的 **扁平** client 工具 schema 发调用（`{hash_id, reason}`，见 `HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC`），而 MCP 广告的 schema 是 `{calls:[{hash_id}]}`。网关 `Mat` 只按工具**名**解析（`que`），**不校验 arguments 形状**，直接把 LLM 的 arguments 透传给 MCP `execute`。故 `helix-recall-mcp.ts` 的 handler 必须**同时接受两种形态**：`args.calls[]`（批量）或 `args.hash_id`（扁平单条）。否则网关透明执行会拿到空 calls → 全 not_found。

### 7.2 自动检测哪些模型支持 recall（2026-10-16）

§7.1 的白名单只能手配，逐个试模型既繁琐又易错。本轮补一条「自动探测 → 自动写白名单」的通路。

**判据**：模型能否走通 **tool-calling 往返** —— recall 依赖模型按教学 prompt 调用 `hc_recall` 工具。探测结果是一个深度分级：

| depth | 含义 | 是否 recallCapable |
|---|---|---|
| `tools` | 在线工具握手通过（模型确实发出了一个工具调用） | ✅ |
| `offline` | 工具握手失败，但最简文本请求能正常作答（说明模型在线可用，只是不保证按 schema 调工具） | ✅ |
| `none` | 两段都失败 / 明确拒绝工具 | ❌ |

`depth` 仅作 provenance（供 UI 区分强弱），白名单只看 `recallCapable`（即 `depth !== "none"`）。

**探测序列**（首个通过即停，`packages/core/src/providers/probe.ts` 新增 `probeModelRecallSupport`）：

1. **tools 段** —— body 带一个 `recall_probe` 工具声明 + 强制 `tool_choice`：
   - `openai_chat_completions`：`tools:[{type:"function",function:{name:"recall_probe",…}}]` + `tool_choice:{type:"function",function:{name:"recall_probe"}}`；正信号 = `choices[0].message.tool_calls[0].function.name === "recall_probe"`。
   - `anthropic_messages`：`tools:[{name:"recall_probe",input_schema:{…}}]` + `tool_choice:{type:"tool",name:"recall_probe"}`；正信号 = `content` 含 `{type:"tool_use", name:"recall_probe"}`。
   - **注意**：工具名叫 `other_tool`（模型自选别的工具）不算通过 —— 必须命中 `recall_probe`。
2. **offline 段**（第 1 步非 tools 时）—— 不带 tools 的最简 body（`content:"Answer with the single word: ok."`）；HTTP 2xx 且 assistant 文本非空 → `offline`。
3. 其余 → `none`。
   - 显式 `400/422` 且 message 命中 `/tool|function|tool_choice|unsupported|not support|invalid.*tool/i` → `none`（明确判定，落缓存）。
   - `401/403` → **未知**（返回 `depth:"none"` 但标记 `skipped:true`）—— **不落缓存、不进白名单**，下次重探。
   - 全程拿不到任何 HTTP 状态（超时 / DNS / 连接被拒）→ **未知**（`skipped:true`）—— 链路不可达不等于模型不支持，不得缓存。见下「审计修复（可达性）」。
   - 未实现的协议（`openai_responses` / `gemini_*`）→ **未知**（`skipped:true`），不伪造 `none`。见下「审计修复（协议覆盖）」。
   - 无 `baseUrl` / 空 model → 直接 `none`（不发请求）。

**枚举范围**（`packages/core/src/providers/recall-model-detect.ts`）：只取 `availableGatewayModelIds(config)`（已启用 provider 的真实模型），经 `modelRegistryForConfig(config).resolveProviderModel(id)` 解析出 `{model, provider}` 与协议 `normalizeProviderProtocol(provider.type/provider)`；解析为 gateway/virtual profile 的派生串跳过；同一 `model+providerKey` 去重；并发探测。

**结果与写回**：
- `patterns` = 所有 `recallCapable` 模型的**精确 model 名**（无 `*`，见 §7.1 精确匹配语义），去重 + 排序。
- `changed` = 与现有 `config.plugins[helix].config.recallModelPatterns` 相比是否变化。
- `applyRecallDetection(config, result)` 纯函数浅拷贝，只改 helix 插件 config（写 `recallModelPatterns` + `recallModelDetected:true`）。

**探测缓存**（`packages/core/src/observability/helix-recall-probe-cache.ts`）：append-only JSONL `HELIX_RECALL_CACHE_DIR/helix-recall-probe/probe-cache.jsonl`，key = `<providerKey>|<model>`，TTL **24h**，last-line-wins 重放成 `Map`。**已判定（含 `none`）的结果都落缓存** —— 判为不支持的也缓存，避免每次重探；只有 `skipped`（401/403 未知）不落。

> **2026-10-16 审计修复（缓存目录回退）**：检测 RPC 跑在**父进程**（Electron main / `ccr-core-server`），而 `HELIX_RECALL_CACHE_DIR` 只在**网关子进程**的压缩 transform（`helix-compressor.ts:ensureLocalRecallCacheDir`）里惰性设置。父进程未设该变量 → `resolveRecallProbeDir()` 原先直接抛错 → 缓存**永远写不进去**：每次检测都重打上游（`detected` 恒为 true），24h 兜底与防回环的第四重缓解全部失效。修复：`resolveRecallProbeDir()` 未配置时回退 `HELIX_RECALL_DIR`（DATADIR/helix-recall），与压缩端/召回端同源。

**触发与回环防护**：显式 RPC `detectRecallModels`（`management-server.ts`）→ 检测 → **仅 `changed` 时** `saveAppConfig(applyRecallDetection(...))` → `gatewayService.updateConfig(saved)`（**热更新非 restart**）→ 失效 provider 快照缓存。`plugins` 在 `runtimeGatewayConfigSignature` 内，改白名单会翻转签名；三重缓解：① 仅 `changed` 写；② 触发源只有「显式 RPC / 可选启动一次性」，**绝不监听 config 保存事件**；③ `updateConfig` 热更新而非 restart；④ 24h 缓存兜底。

> **2026-10-16 审计修复（协议覆盖）**：探测只实现了 `openai_chat_completions` / `anthropic_messages` 两种协议体的构造与解析。其它协议（`openai_responses` / `gemini_*`）若沿用 chat 形状会**被上游判 400 → 落到 `depth:"none"` 且写入缓存**，把一个本可能支持 recall 的模型误判为不支持（24h 内不再重探）。修复：`probeModelRecallSupport` 对未实现协议显式返回 `skipped:true`（视为「未知」）—— **不落缓存、不进白名单**，而非伪造 `none`。

> **2026-10-16 审计修复（可达性）**：探测全程若**拿不到任何 HTTP 状态**（超时 / DNS 失败 / 连接被拒），原实现会落到 `depth:"none"` 并**写入缓存** —— 一次瞬时网络抖动就把一个可用模型误判为「不支持」并冻结 24h。修复：`probeModelRecallSupport` 记录是否观测到任何 HTTP 状态,全程无状态 → `skipped:true`（未知,不落缓存）。同类问题：`detectRecallModelsForConfig` 里 probe 调用**抛错**时原先也生成非 `skipped` 的 `none`,同样修正为 `skipped:true`。

**门控读取**（`helix-compressor.ts` 的 `recallModelSupported`）：新增配置键 `recallModelDetected?: boolean` 区分「检测出空集」与「未配置」：

```
included = config.recallModelDetected === true
  ? (patterns.length > 0 && matches(patterns))   // 检测过:空列表 = 真的都不支持
  : (patterns.length === 0 || matches(patterns)) // 未检测:空 = 全部(向后兼容)
```

**为什么需要这个标志**：§7.1 原语义「空列表 = 全部」下，「检测出 0 个支持」与「未配置」无法区分 —— 前者应表示「无」（不许 recall 压缩），后者应回退全部。该标志让检测出的空集合法地表示「无」。（不采用 metadata capability 位，避免被 model-auto-refresh 的目录重建覆盖。）

### 7.3 上下文长度驱动的 compact 阈值（2026-10-16）

主动 compact（§8 `helix-proactive-compact.ts`）的门控原为单一绝对值：`postCompressionTokens > tokenBudget`（默认 100000）。大上下文模型（如 200k/900k）用同一阈值要么过于激进、要么迟迟不压。本轮改为**阈值随模型上下文长度自适应**：

```
budget = clamp(floor(有效上下文长度 × percent/100), floorTokens, ceilingTokens)
```

新增 4 个 helix 插件配置键：

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `compactBudgetPercent` | `number` | `0` | 预算 = 有效上下文 × percent/100，再 clamp；**`0`/未设 = 回退绝对 `tokenBudget`**（向后兼容） |
| `compactBudgetFloorTokens` | `number` | `48000` | 下限 |
| `compactBudgetCeilingTokens` | `number` | `120000` | 上限（硬顶） |
| `compactBudgetPercentOverrides` | `Record<string,number>` | `{}` | 按真实 model 名覆盖 percent |

**解析器** `resolveCompactBudgetTokens(config, settings, model)`（`helix-proactive-compact.ts`）：
- `percent <= 0` → `{ budget: tokenBudget }`（原比较逐字节一致）。
- 拿不到上下文长度（未知模型 / gateway profile）→ 回退 `tokenBudget`。
- 否则 `percent = overrides[upstream] ?? overrides[selector] ?? percent`（`selector` 经 `stripRecallPrefix` 剥掉 recall 前缀，`upstream` 是解析后的真实模型名），`budget = min(ceiling, max(floor, floor(contextWindow × percent/100)))`。

**上下文长度来源**（`gateway/model-catalog.ts` 新增 `resolveModelContextWindow(provider, model)`）：优先 `provider.modelMetadata[model].contextWindow/maxContextWindow`（按 `effectiveContextWindowPercentFor` 折算），回退目录 `limits.contextTokens`（`modelCatalogMaxInputTokens` + `findProviderModelCatalogEntry`）。这些数据已随 `packages/core/models.json` 目录自动填充进 provider metadata，无需新增抓取。

**门控改动**（`helix-proactive-compact.ts`）：解析提到比较之前（只读 metadata/目录，不依赖折叠结果）：
```ts
if (settings.tokenBudget <= 0 && !(settings.percent > 0)) return undefined;
const { budget } = resolveCompactBudgetTokens(input.config, settings, input.model);
if (budget <= 0 || input.postCompressionTokens <= budget) return undefined;
```

**暴露有效预算**：`ProactiveCompactResult.budgetTokens` / `ProactiveCompactStat.budgetTokens` / diagnostic 串追加 `,budget=N`；经 `router-plugin.ts` 的 `proactiveCompact` + `compactJson` → `x-ccr-helix-compact-json` / `x-helix-compressor-compact-json` + sidecar → UI/DB（`request-log-store.ts` `parseProactiveCompactJson` 读、UI `shared/logs.ts` `parseCompactHeader` 显示「· 预算 N tok」）。**无需新 header。**

---

## 8. CCR 集成点（文件清单）

| 文件 | 改动 |
| --- | --- |
| `packages/core/src/plugins/built-ins/helix-compressor/hc-local.ts`（新） | 端口 §4.1 的算法 |
| `packages/core/src/plugins/built-ins/helix-compressor.ts` | transform 内 `fetch(/v1/compress)` → `compressV3x`；`fetch(/v1/recall…)` → 本地 store |
| `packages/core/src/observability/helix-recall-local-store.ts`（新） | 组件② 访问层（§5.3） |
| `packages/core/src/mcp/helix-recall-mcp.ts`（新） | 组件③ stdio MCP server |
| `packages/core/src/mcp/fusion-config.ts` | 新增 `helixRecallMcpServer()`（仿 `fusionBuiltinMcpServer`）；`fusionBuiltinToolArtifacts` 保留 `matchRecall` 分支（profile 路，未启用但无害） |
| `packages/core/src/gateway/core-runtime/config-compiler.ts` | **实际集成点**：本地压缩模式下注入 `transparentToolExecution`（`helixTransparentToolExecution()`）+ 把 `helixRecallMcpServer()` 追加进 `mcpServers` |
| `packages/core/src/gateway/core-runtime/router-plugin.ts` | 删掉/改造 `helixCompressorTransformContext` 的空路径；从环境注入 `HELIX_RECALL_CACHE_DIR` |
| `packages/core/src/contracts/app.ts` | 新增 `TransparentToolExecutionConfig` + `AppConfig.transparentToolExecution?`；`VirtualModelExecutionConfig` 增 `matchRecall?: boolean`（未消费）；`HELIX_RECALL_MCP_SERVER_NAME` / `HELIX_RECALL_TOOL_NAMES` |
| `packages/core/src/providers/probe.ts` | **§7.2** 新增 `probeModelRecallSupport`（两段式 tools→offline 探测） |
| `packages/core/src/providers/recall-model-detect.ts`（新） | **§7.2** 检测服务：枚举已配置模型 → 探测 → 白名单 + `applyRecallDetection` |
| `packages/core/src/observability/helix-recall-probe-cache.ts`（新） | **§7.2** 探测缓存（append-only JSONL，TTL 24h） |
| `packages/core/src/web/management-server.ts` | **§7.2** 新增 RPC `detectRecallModels`（仅 changed 时 `updateConfig` 热更新） |
| `packages/core/src/gateway/model-catalog.ts` | **§7.3** 新增 `resolveModelContextWindow(provider, model)` |
| `packages/core/src/gateway/features/helix-proactive-compact.ts` | **§7.3** settings 扩键 + `resolveCompactBudgetTokens` + 门控 + `budgetTokens` |
| `packages/core/src/observability/compression-stats-store.ts` | **§7.3** `ProactiveCompactStat.budgetTokens?` |
| `packages/core/src/gateway/core-runtime/router-plugin.ts` | **§7.3** proactiveCompact 统计 + compactJson 带 `budgetTokens` |
| `build/esbuild.config.mjs` | 新 MCP entry `helix-recall-mcp.ts` 必须加到**三处** `entryPoints` 数组（`esbuild.config.mjs:314-323`、`:351-358`、`:383-390`，对应不同 target），并加入 `lightweightMcpBundleNames`（`:75`）。仅改 `build/build.mjs` 不够——它只调用 esbuild，不定义 entry 清单。 |

---

## 9. 一致性 / 正确性

| 项 | 要求 | 验证手段 |
| --- | --- | --- |
| hash 逐字节一致 | `computeHash` 与云端 `hc.js:39` 相同 | 金值向量单测：给定固定 messages，断言全部 hash 与云端产出一致 |
| `extractText` 口径 | array 的 text 块 `\n` 拼接、忽略非 text 块 | 单测覆盖 string / array / mixed |
| media hash 键序 | `JSON.stringify(block)` 与即将上游发送的对象**同源**（同一对象引用，键序天然一致） | 单测：对同一 block 计算两次 hash 相等；断言 `⟦HC:hash⟧` 与缓存 key 对应 |
| TTL | 默认 3 天，过期召回返回 `not_found` | 单测：伪造 `expires_at` 过去值 |
| 幂等 | 同一 hash 重复 `putBatch` 不报错、内容一致 | 单测：重复写后 `get` 返回一致 |
| 提问不被吞 | 最后一轮 user 消息永不在候选内 | 单测：构造 12 段历史 + 最终提问，断言最终提问原文保留 |

**最脆弱的一环**是 hash 口径——`JSON.stringify({q,a})` 的键序固定为 `q` 先 `a` 后（与 `hc.js:397` 一致），不可用其它序列化器替换。

---

## 10. 与云端的关系

- **ℒ 完全本地**，V3.x 确定性路径**不联网**。

  > **前提 caveat（审计补）**：ccr 请求体确实不带 `maxTokens`，**但这不足以断定云端跑 V3.x**。云端 `routes.js:150-199` 在 options 未给 `maxTokens` / `true_compact_enabled` 时**读 DB 表 `compression_settings`**：`maxTokens>0 && true_compact_enabled` → 走 True Compact（`compactByAggressiveness`），否则才落 `compressCCR`（V3.x）；DB 不可达时 fallback `maxTokens=0` / `trueCompact=true`。**即云端实际路径由服务端 DB 状态决定，与 ccr body 无关。** 本方案把路径选择权收回本地（确定性 V3.x），正是为消除这一不确定性。
- **云端路径已整体移除（2026-10-16）**：`POST /v1/compress`（`helixApiUrl` / `helixApiKey` / `localMode`）、质量评估 `evaluateCompression`（`evaluatorApiUrl` / `evaluatorModel` / `evaluatorApiKey` / `sampleMod`）、评分上报 `/v1/quality/feedback`（`reportFeedback`）已从 `helix-compressor.ts` 删除。摘要语义仍走 LLM，但由本地主动 compact 模块（`gateway/features/helix-proactive-compact.ts`）用**当前路由模型**发起，不再依赖云端。
- **无云端开关**：不再有 `localMode` / `helixApiUrl` 配置；本地压缩是唯一路径。老 `config.sqlite` 里残留的云端键被 `parseConfig` 忽略，无害。

---

## 11. 迁移与兼容

- **占位符兼容**：`⟦QA:hash⟧` / `⟦HC:hash⟧` 格式不变，`decompressCCR` 兼容 `⟦CCR:⟧` / `⟦M:*:⟧` / `⟦img:⟧`（`hc.js:662`）。
- **旧数据**：历史请求里的占位符对应的原文只存在于云端缓存（已 TTL 过期则无解）。本地缓存**只保证新请求**可召回；不迁移云端存量。
- **多 provider**：本地压缩与 provider 无关，`MiniMax` / OpenAI / Claude 均适用。
- **回滚**：停用 helix 插件（`plugins[helix].enabled=false`）即回到无压缩直通，无 schema 破坏性变更（本地缓存可空置）。

---

## 12. 风险

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| hash 口径漂移导致召回 miss | 高 | 金值单测锁死；`hc-local.ts` 与云端算法并行比对脚本（`tools/`） |
| 半写行被读到（JSONL 并发） | 中 | 写者唯一 + 读者只认 `\n` 结尾的完整行 + 内容寻址幂等；compaction 原子 rename |
| JSONL 文件膨胀 | 低 | 阈值 compaction（64 MB / 过期占比高）+ TTL 清理 |
| MCP 子进程无法加载原生依赖 | 中（**已规避**） | 缓存层零依赖（`node:fs` only），不 import `better-sqlite3`/`storage/` 前缀，满足 128 KB 轻量包约束 |
| gateway 侧拿不到真实 DATADIR | 中 | 用环境变量 `HELIX_RECALL_CACHE_DIR` 注入（不依赖 router-plugin 的假 context） |
| 网关 tool loop 对 recall 的兑现方式与 fusion 不同 | 中（**已解决**） | 实测改用网关**透明工具执行**（`transparentToolExecution` + `allowTools` 白名单 + `requireClientDeclaration:false`），不走 profile internal loop。见 §6.1 修订 |
| 压缩过度仍吞提问 | 中 | §4.4 强制保护最后一轮 user；单测锁死 |
| 检测写回触发 config 重启回环 | 中 | §7.2：仅 `changed` 写 + 触发源不含保存监听 + `updateConfig` 热更新 + 24h 缓存 |
| 「检测出 0 支持」与「未配置」混淆 | 中 | §7.2：`recallModelDetected` 标志区分空集语义 |
| 探测把可用模型误判为不支持 | 中 | §7.2：tools→offline 两段式；401/403 记未知不写缓存 |
| 探测成本/延迟 | 低 | §7.2：仅已配置模型 + 并发 + 24h 缓存，稳态零请求 |
| percent 路径拿不到上下文长度 | 低 | §7.3：一律先 `stripRecallPrefix` 再查 metadata/目录；查不到回退绝对 `tokenBudget` |
| schema 演进 | 低 | `CREATE TABLE IF NOT EXISTS` + 预留 `addColumn` 迁移模式 |

---

## 13. 验证计划

### 单元测试

- `packages/core/test/unit/helix-local-hash-parity.test.mjs` — hash 与云端算法金值一致。
- `packages/core/test/unit/helix-local-compress.test.mjs` — 候选选择 / anchor+recent / 提问不被吞 / block 级。
- `packages/core/test/unit/helix-recall-local-store.test.mjs` — putBatch / get / batchGet / TTL / 幂等。
- `packages/core/test/unit/helix-compressor-recall-model-gate.test.mjs` — `recallModelSupported` glob/exclude/provider 前缀/`recallModelDetected` 空集语义 + transform 门控。
- `packages/core/test/unit/providers/provider-probe-recall.test.mjs` — `probeModelRecallSupport` 两协议 tools 正/负信号、offline 回退、401/403 skipped、400 不支持、无 baseUrl 早退。
- `packages/core/test/unit/providers/recall-model-detect.test.mjs` — 枚举 + 缓存命中零网络 + `changed` 判定 + skipped 不落缓存 + `applyRecallDetection` 不可变性。
- `packages/core/test/unit/helix-proactive-compact.test.mjs` — `resolveCompactBudgetTokens`（floor/ceiling/中间值/无 CW 回退/override 优先）+ 门控触发 + `budgetTokens` 断言。

### 端到端（真实 LLM）

复用 `tools/ccr-real-llm-recall-test.mjs`（长上下文 + 最终提问 + 带 tools）。期望：

1. `HTTP 200`；`x-helix-compressor-ratio` < 1，`x-helix-compressor-hash-count` > 0。
2. 提交给 LLM 的 `messages` 最后一条是**完整提问**（非 `⟦QA:…⟧`）。
3. LLM 发出 `hc_recall` 调用 → 网关回填 → 同一轮给出**引用 §3 p99 数值的正确答案**。
   - 注：末轮提问"是完整原文"由云端 V3.x 天然保证（§4.4 修订）；本条端到端断言主要验证**召回闭环**，不再作为"提问保护"的证据。
4. 请求日志 `compression_baseline/post/submitted` 四列有非零值（沿用现有 DB 链路）。

**§7.2/§7.3 的端到端验证**：

- **compact 预算（§7.3）**：配 `compactBudgetPercent:50` 后，对某模型 CW=200k → DB `x-helix-compressor-compact-json.budgetTokens` ≈100000；CW=900k → 120000（ceiling）；CW=80k → 48000（floor）。
- **recall 检测（§7.2）**：调 RPC `detectRecallModels` → 检查 `config.plugins[helix].config.recallModelPatterns` 被写入 + `recallModelDetected:true`；再调一次 → 零写入（缓存命中，无 gateway reload）。
- **UI 手验**：`extensions.tsx` helix 面板拖百分比滑块 → 保存 → `config.sqlite` 的 helix config 更新 + 网关热重载无重启；点「Auto-detect recall models」→ 显示逐模型 depth 结果。

### 回归

```bash
pnpm --filter @ccr/core test
```

重点：`router-plugin.test.mjs`、`gateway-config-acceptance-timeout.test.mjs`、`fusion-config` 相关。

---

## 14. 分期落地

| 阶段 | 内容 | 产出 |
| --- | --- | --- |
| **P0** | 端口 `hc-local.ts` + 金值单测；修 §4.4 提问保护 | 本地压缩可跑、hash 对齐 |
| **P1** | 本地 store（§5）+ transform 落盘；撤掉 `fetch(/v1/compress)` | 压缩后原文本地可查 |
| **P2** | `helix-recall-mcp` + profile `matchRecall` 挂载（仿 fusion） | 网关内 recall loop 闭环 |
| **P3** | 删 response-hook 死代码 / 修 `inferRequestFormat` 无 tools 误判；云端降级为可选旁路 | 清理 + 可选云端 |

**P2 之前**，`ℒ` 仍是"能压、能存、但还召不回"——不要把 P0/P1 的中间态当成闭环完成。

---

## 附：与既有文档 / 记忆的关系

- `docs/issue-reviews/2026-10-11-prompt-compression.md`：上一版压缩方案（Helix 云端 B/C + 客户端 A/D）。本稿把 B/C 搬到本地，A/D 不变。
- 记忆 `project_helix_recall_gateway`：recall 三重断裂根因。本稿是其"正确修复方向 (a) internal tool"的完整展开。
- 记忆 `project_helix_compression` / `project_ccr_local_workspace`：压缩统计链路与本地 build/deploy/restart 循环，实施时沿用。
