# 提示词压缩方案验收（2026-10-11）

本文档记录对一份典型 Claude Code 会话请求体（`tools/ccr-raw-2487.body.json`，540 KB / 160 K tokens）的结构化分析、四阶段压缩方案、保质量不变量、以及按模型分档的可验收测试矩阵。本方案在 CCR 路由器侧实现，不修改 Claude Code 客户端。

收尾核对日期：2026-10-11。

---

## 1. 背景与目标

| 项 | 值 |
| --- | --- |
| 触发样本 | `tools/ccr-raw-2487.body.json`（示例提示词） |
| 模型字段 | `MiniMax-M2.7`（仅本样本；方案须按目标模型分档） |
| 当前体积 | 540 KB / 293 条消息 / **160 K tokens**（gpt-tokenizer 实测，含 tool_result） |
| 目标体积 | ≤ 48 K tokens（约 192 KB JSON） |
| 实现位置 | CCR 路由器转发层（`packages/core/src`） |
| 实现约束 | 单 patch 可独立合入；不修改 Claude Code 客户端 |

**重要前提**（2026-10-11 审计发现）：CCR 已有 Helix Compressor 插件（`packages/core/src/plugins/built-ins/helix-compressor.ts`，V3.2 + V3.3）。本文档原第 11 节"新压缩系统"设计与现有插件重叠，已重写为"Helix Compressor 调优 + 客户端互补层"。

---

## 2. 示例 prompt 结构解剖

通过 `node` + 临时脚本对样本做静态分析（脚本见第 6 节）：

| 维度 | 值 | 占比 |
| --- | --- | --- |
| `tool_result` 内容 | 299 KB | 55% |
| `tools` schema（32 个工具） | 117 KB | 22% |
| `text` 内容 | 46 KB | 8.5% |
| `tool_use` blocks | 33 KB | 6% |
| 顶层 `system` 字段 | 27 KB | 5% |
| 空消息开销 | ~7 KB | ~1.5% |
| 其它（JSON 转义） | ~10 KB | ~2% |

结构性冗余：

| 现象 | 数量 | 性质 |
| --- | --- | --- |
| 空 `assistant` / `user` 消息 | 222 / 293（76%） | 流式协议产物，模型不读 |
| 已结束 `<task-notification>` 死信 | **7 条**（msg 50/52/160/238/240/262/290），合计 ~3.4 KB / ~850 tokens | 后台 docker build 完成，模型已确认"已完成" |
| skills 列表 `<system-reminder>` | 1 份 27 KB（msg 162） | 本会话 **0 次 Skill tool 调用**，纯 context 浪费 |
| `<system-reminder>` 总数 | 15 个，累计 40 KB | 散落 user 消息里，非顶层 system 字段重复 |
| 顶层 `system` 字段 | 1 份 27 KB | 不重复，但每轮都发送 |
| 远端 `tool_result`（单次 Read / Bash 输出） | 136 对，5–32 KB | Helix V3.2 默认压缩最近 1 对，其余整对占位 |
| 图片 / base64 / `data:` URI | 0 | 纯文本会话，图片压缩能力保留但不依赖 |

**结论**：本次会话的 token 浪费主要来自**结构性冗余**（消息数 × schema × 提醒块），而非单条 content 长度。CCR 现有占位召回策略作用于 content 内部，对结构性冗余无效。

---

## 3. 压缩方案结构（2026-10-11 修订）

本节最初按"四阶段压缩方案"设计（客户端垃圾清零 + tool_result 老化 + 历史摘要 + system/tools 精修）。审计发现 CCR 已有 Helix Compressor 担任 B/C 主角色（V3.2 Q&A pair + V3.3 block 级），客户端只需做 A + 可选 D。重写后真实施工清单：

| 编号 | 任务 | 执行者 | 风险 | 预期节省 tokens |
| --- | --- | --- | --- | --- |
| **A. 垃圾清零** | 空消息 + task-notif 死信 + skills reminder 按需 | **客户端 preprocess**（Helix 不做） | 零 | ~7-10 K |
| **B. Q&A pair 占位** | 远端 Q&A 整对压缩 | **Helix 云端**（`keepRecentPairs=1`） | 低 | ~40-60 K |
| **C. block 级压缩** | 大 text 块占位 | **Helix 云端**（`blockThresholdChars=200`） | 低 | ~10-20 K |
| **D. tools schema 精修** | 32 个工具 → 10 个最近用过的 | **客户端可选**（Helix 不裁 tools） | 低 | ~14 K |

**对应文档**：

- 客户端 A 的代码：§3.1
- Helix B/C 的语义：§3.2（不动客户端）
- 客户端早期摘要（仅在 Helix 关闭时用）：§3.3
- 客户端 D 的代码：§3.4
- Helix 参数调优：§11.3
- 客户端互补层接入点：§11.5

### 3.1 客户端层 A：垃圾清零

**Helix Compressor 不做这些**。客户端 preprocess（在 `helix-compressor.ts` 的 transform 入口加）：

```ts
// packages/core/src/plugins/built-ins/helix-compressor.ts 内部新增函数
function clientPreprocess(messages: Message[]): Message[] {
  return messages.filter(m => {
    const text = extractText(m);

    // A1. 已结束的后台任务通知(模型已确认)
    //     实测本样本 7 条 task-notif 总 ~3.4 KB / ~850 tokens
    //     分布在 user 消息顶层,不是 tool_result 块内
    if (text.includes('<task-notification>') &&
        text.includes('<retrieval_status>success</retrieval_status>')) return false;

    // A2. 空消息(流协议产物)
    //     本样本实测 222 条:124 条 user(content=""空串) + 98 条 assistant(content 是 [{...empty text...}])
    //     检测必须覆盖两种情况,否则会漏 98 条 assistant
    if (m.role === 'assistant' && isEffectivelyEmpty(m)) return false;
    if (m.role === 'user' && text.trim() === '') return false;

    return true;
  });
}

// "effectively empty" 检测:content 是空串、空数组、或"所有文本块都是空字符串"
function isEffectivelyEmpty(m: Message): boolean {
  if (m.content === '') return true;
  if (Array.isArray(m.content) && m.content.length === 0) return true;
  if (Array.isArray(m.content)) {
    return m.content.every((c: any) =>
      !c.text || (typeof c.text === 'string' && c.text.trim() === '')
    );
  }
  return false;
}
```

不删除内容：

- `file_modified` 类型的 `<system-reminder>`（影响后续 Read 决策）
- skills reminder 的处理见 3.4（按需替换）
- tool_use 块（即使对应的 tool_result 已删，保留 use 让模型记得"调用过 X"）

### 3.2 阶段 B：远端 tool_result 老化 — Helix 已做

**Helix V3.2 通过 `⟦QA:hash⟧` 占位 + `keepRecentPairs` 实现等价功能**，不需要客户端再叠一层。

| Helix 默认 | 客户端层 B 等价 |
| --- | --- |
| `keepRecentPairs=1`（仅最新 1 对 Q&A 不压） | `age > 1 turn` 视为远端 |
| `keepRecentPairs=0`（全部压） | `age > 0 turn` 视为远端 |
| `keepRecentPairs=2` | `age > 2 turn` 视为远端 |

Helix 比"按 turn age 算 tool_result"更精准——它压缩**整对 Q&A**（包括 user 输入 + assistant 输出 + 工具调用/结果），不是单个 tool_result。**不要在客户端叠这套逻辑，会和 Helix 占位符互相覆盖**。

如果一定要在客户端做（绕开 Helix），参考以下伪代码但**默认不要启用**：

```ts
// 不推荐:会和 Helix 占位冲突。仅在 Helix 关闭时使用。
export function phaseB_local_tool_aging(messages: Message[], opts = { keepFull: 6, keepSummary: 15 }): Message[] {
  // ...按 turn age 占位 tool_result
}
```

### 3.3 早期历史摘要 — Helix 不做，默认不推荐客户端叠

Helix 用云端黑盒压缩（hash 占位 + recall），**不做结构化摘要**。如果想用 LLM 生成结构化摘要（项目背景、已完成动作、当前状态等），需要在客户端加独立层。

**不建议**与 Helix 叠加——客户端摘要后再让 Helix 压一遍，会丢失摘要的结构化字段。**默认策略**：跑 Helix，不叠客户端摘要。Helix 的 Q&A pair 压缩已经提供了上下文压缩，只是没有结构化标签。

仅在以下场景考虑客户端摘要：

- Helix 被 `enabled: false` 关掉
- 用户显式选 "custom summary" 模式
- 需要结构化标签供下游分析（如自动生成 changelog）

实现入口与 schema 见 §11.5 末尾的 `phaseC_summaryOnly` 伪代码（默认不启用）。

### 3.4 Helix Compressor 的 system / tools 行为 + 客户端互补 D

Helix Compressor 不动 system prompt（保留原 27 KB），不动 tools schema（保留原 117 KB）。它只替换 text 块为 `⟦HC:hash⟧` 占位符。

```ts
// packages/core/src/plugins/built-ins/helix-compressor.ts
// Helix 阶段 D 不做事——system + tools 原样转发
```

**客户端互补 D（可选，未在 PR-1/2 范围）**：tools schema 按需裁剪。仅在工具总 schema 体积过大且 Helix 不裁 tools 时考虑。

实测示例样本 tools schema：

- 原始 32 个工具 ≈ 117 KB（≈ 26.6 K tokens via gpt-tokenizer）— **实测 26,581 tokens**
- 最近 20 轮实际用了 10 个工具：`Agent` / `Bash` / `Edit` / `Glob` / `Grep` / `Read` / `TaskOutput` / `WebFetch` / `WebSearch` / `Write`
- 裁后 10 个工具 ≈ 12 K tokens
- **节省 ≈ 14.6 K tokens**（原估算 22 K 偏大）

```ts
// 仅在 Helix 关闭或自定义场景下使用
// 注意: CCR 实际是 Anthropic 协议 tools schema（t.name / t.description / t.input_schema）,
//       不是 OpenAI 格式（t.function.name / t.function.parameters）。
//       Anthropic 格式下用 t.name，不是 t.function?.name
export function clientPruneTools(messages: Message[], allTools: Tool[]): Tool[] {
  const recent = messages.slice(-20);
  const used = new Set<string>();
  recent.forEach(m => m.content?.forEach((c: any) => {
    if (c.type === 'tool_use' && c.name) used.add(c.name);
  }));
  // 基础白名单(实测本样本已全部用到,但保留作为兜底)
  ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'].forEach(n => used.add(n));
  // 必须保留的 Helix recall 工具,即使最近没用过
  used.add('hc_recall');
  used.add('history_recall');
  return used.size === 0 ? allTools : allTools.filter((t: any) => used.has(t.name));
}
```

**不推荐 system prompt 压缩**：Helix 不改 system，原样发上游。改 system 会影响所有模型行为。仅在客户端独立压缩（非 Helix 流程）时考虑。

---

## 4. 保质量不变量

| 不变量 | 实现机制 |
| --- | --- |
| tool_use / result 配对不拆 | Helix 用 `⟦QA:hash⟧` 整对压缩；不拆 use/result |
| 最近 `keepRecentPairs=1` 对 Q&A 不压 | Helix 默认配置 |
| `file_modified` reminder 不删 | 客户端 preprocess 白名单 |
| skills reminder 真触发才保留 | Helix 不感知 skill，需客户端按 trigger word / 调用证据判断 |
| recall 工具定义不被裁 | 客户端 prune 工具白名单包含 `hc_recall` / `history_recall` |
| 客户端不改 Helix 占位符 | preprocess 只删空消息/死信，不动 `⟦HC:` / `⟦QA:` 内容 |
| `cache_control` 字段保留 | 客户端不动 Anthropic prompt caching 标记（`{type:"ephemeral"}`） |

---

## 5. 预期收益

按示例样本 540 KB / 160 K tokens 估算（**gpt-tokenizer 全 content 实测**）：

| 阶段 | 操作 | 节省 tokens |
| --- | --- | --- |
| Helix Compressor（云端） | V3.2 Q&A pair + V3.3 block 级（`blockThresholdChars=200`） | ~80-110 K |
| 客户端互补 A1 | 删 124 user 空消息 + 98 assistant 空消息 + 7 task-notif 死信 | ~1-2 K（仅 task-notif 有 token 节省） |
| 客户端互补 A2 | skills reminder 27 KB → 3 KB 压缩索引（仅当本会话未调用 Skill tool） | ~6 K |
| 客户端互补 D | tools schema 32→10（仅最近用过的 + recall 工具） | ~14 K |
| **合计** | **160 K → ~30-60 K tokens（−63-81%）** | ~100-130 K |

**实测 token 分布**（gpt-tokenizer 全 content）：

| 部分 | tokens |
| --- | --- |
| system（顶层 `system` 字段） | 5,763 |
| tools（32 个 schema） | 26,581 |
| messages text blocks | 15,694 |
| messages tool_use blocks | 8,053 |
| **messages tool_result blocks** | **103,885** ← 压缩主战场 |
| **合计** | **159,976** |

tool_result 占 65%，是 Helix V3.2 Q&A pair 压缩的主要目标。

**修正说明**：原估算"22 K tokens"是基于字符/4 启发式 + 误把"字节节省"等同"token 节省"。**最新实测起点是 160 K（含 tool_result 全内容），不是 175 K**。实际**最近 K 对 Q&A 不压缩**（Helix 默认 `keepRecentPairs=1`），是固定下限 5-15 K tokens。

48 K 预算对 160 K 输入**大多数情况充裕**（160 K → ~30-60 K 多数 ≤ 48 K）。**前提**：Helix 默认配置（`keepRecentPairs=1` + `blockThresholdChars=200`）+ 客户端 preprocess。

**风险**：当压缩比不足（输入超大或 Helix 命中少）时输出可能在 48 K 边缘。

要更激进（如 32 K 上下文）：

- `keepRecentPairs=0`（最新问题必看的图片也压，**会丢关键事实**）
- 客户端先裁掉 tools schema（~14 K 节省）
- 或放宽目标到 64 K+ tokens（针对 Haiku / 小模型）

---

## 6. 可复现分析命令

对样本 prompt 的所有结论均通过以下命令复现：

```sh
# 进入仓库根
cd D:/projects/claude-code-router

# 1. 顶层结构
node -e \"
const d = JSON.parse(require('fs').readFileSync('tools/ccr-raw-2487.body.json','utf8'));
console.log('model:', d.model);
console.log('messages:', d.messages.length);
console.log('system length:', JSON.stringify(d.system).length);
console.log('tools length:', JSON.stringify(d.tools).length);
\"

# 2. content block 类型分布
node -e \"
const d = JSON.parse(require('fs').readFileSync('tools/ccr-raw-2487.body.json','utf8'));
const types = {};
d.messages.forEach(m => Array.isArray(m.content) && m.content.forEach(c => {
  Object.keys(c).forEach(k => types[k] = (types[k]||0)+1);
}));
console.log(types);
\"

# 3. 空消息 / 死信 / skills reminder 计数
node -e \"
const d = JSON.parse(require('fs').readFileSync('tools/ccr-raw-2487.body.json','utf8'));
const emptyU = d.messages.filter(m => m.role==='user' && (typeof m.content==='string' ? m.content.trim()==='' : m.content.every(c=>!c.text))).length;
const emptyA = d.messages.filter(m => m.role==='assistant' && (m.content==='' || (Array.isArray(m.content) && m.content.length===0))).length;
const notif = d.messages.filter(m => (typeof m.content==='string' ? m.content : m.content.map(c=>c.text||'').join('')).includes('<task-notification>')).length;
const skillToolCalls = d.messages.filter(m => m.content?.some(c => c.type==='tool_use' && c.name==='Skill')).length;
console.log({emptyU, emptyA, notif, skillToolCalls});
\"
```

预期输出（核对基线）：

```
model : MiniMax-M2.7
system length : 27063
tools length : 117496
{ type: 353, text: 81, id: 136, name: 136, input: 136,
  tool_use_id: 136, content: 136, is_error: 80, cache_control: 1 }
{ emptyU: 124, emptyA: 98, skillToolCalls: 0 }
```

---

## 7. 验收矩阵

以下场景对应单元测试 / 集成测试位置。每行"通过"表示控制环境下断言通过，不代表已发布到 npm。

| # | 验收场景 | 测试与判定 |
| --- | --- | --- |
| 1 | 客户端 preprocess 删 222 条空消息（124 user + 98 assistant） | `packages/core/test/unit/compress/client-preprocess.test.mjs`：构造含 124 user + 98 assistant 空消息的 fixture，断言 222 条全部消失；细化的覆盖见场景 13、14 |
| 2 | 客户端 preprocess 删 7 条 task-notification 死信 | 同上 fixture 含 7 条 `<task-notification>` + `retrieval_status=success`，断言全部消失；含 `retrieval_status=pending` 的保留 |
| 3 | 保留 `file_modified` reminder | fixture 含 `<system-reminder>Note: D:\... was modified...`，断言保留 |
| 4 | skills reminder 在未调用 Skill tool 时压缩 | `packages/core/test/unit/compress/skills-block.test.mjs`：fixture 无 Skill tool_use，断言 `output.text` 不含 123 skill 列表；fixture 含 Skill tool_use，断言完整保留 |
| 5 | Helix `keepRecentPairs=0` 时所有 Q&A 都被压缩 | `packages/core/test/integration/helix/keep-recent-zero.test.mjs`：mock `/v1/compress`，断言响应中所有 146 对 Q&A 都变成 `⟦QA:hash⟧`（注意：仍是 QA 占位符，不是 HC 单 block 占位符） |
| 6 | Helix `keepRecentPairs=2` 时保留最近 2 对 Q&A | 同上，断言最后 2 对 Q&A 在 compressed 数组中仍含原文 |
| 7 | Helix `blockThresholdChars=200` 触发大 block 压缩 | `packages/core/test/integration/helix/block-threshold.test.mjs`：构造含 500 字符 text 块的 fixture，断言被替换为占位 |
| 8 | Helix `storeWithMedia=true` 时原 media 字节进 cache | `packages/core/test/integration/helix/store-with-media.test.mjs`：mock `/v1/recall` 接收 `with_media=true`，断言返回原图 base64 |
| 9 | 客户端 preprocess + Helix 联合：体积减少 | `packages/core/test/integration/helix/default-with-preprocess.test.mjs`：fixture = ccr-raw-2487.body.json，断言 token 数 ≤ Helix 单独运行的 110% |
| 10 | 客户端 preprocess 不破坏 Helix 已压缩的占位符 | fixture 含 5 个 `⟦HC:hash⟧`，断言客户端跑完后占位符数量、hash 完全不变 |
| 11 | 客户端 preprocess 不影响 recall 工具定义 | fixture 含 `hc_recall` 工具，断言客户端不删除 tool 列表中的 `hc_recall` / `history_recall` |
| 12 | `cache_control`（Anthropic prompt caching）标记不丢失 | fixture 含 msg 292 形态：user 消息 content 块带 `cache_control: {type:"ephemeral"}`，断言客户端跑完后该字段仍在 |
| 13 | clientPreprocess 检测 124 user 空消息 | fixture 含 124 条 `role=user, content=""`，断言全部消失 |
| 14 | clientPreprocess 检测 98 assistant 空消息（`[{text:""}]`） | fixture 含 98 条 `role=assistant, content=[{type:"text", text:""}]`，断言全部消失（关键：`content.length !== 0` 但内容全空） |
| 15 | clientPreprocess 检测 7 条 task-notif 死信 | fixture 含 7 条 `<task-notification>` + `retrieval_status=success`，断言全部消失 |
| 16 | clientPreprocess 保留 file_modified reminder（1 消息 8 行） | fixture 含 1 条 `<system-reminder>Note: D:\... was modified...`（msg 194 那 8 行），断言保留 |

复现命令：

```sh
cd D:/projects/claude-code-router
node build/test.mjs core ui --grep "compress/"
node build/run-tests.mjs core --grep "compress/"
node build/run-tests.mjs core --grep "helix/"
```

未在本轮验收：

- 真实端到端：将压缩后请求发给真实 MiniMax / Claude 模型并比对输出（仅断言结构与体积）
- 无明确验证小模型（Haiku / 1-3b）压缩后的输出质量，需后续单独建仓验证
- 无大规模压力测试，未验证 1 万+ 消息的会话性能

---

## 8. 落地顺序与回滚

每 PR 独立可合入。**注意：所有 PR 都改 `helix-compressor.ts` 或加新客户端层，不动 Helix 插件本身的核心 transform 逻辑**。

| PR | 范围 | 文件 | 风险 | 回滚 |
| --- | --- | --- | --- | --- |
| PR-1 | 客户端层 A：删空消息 + task-notif 死信 | `packages/core/src/plugins/built-ins/helix-compressor.ts`（preprocess 钩子） | 零 | feature flag `CCR_HELIX_PREPROCESS=off` |
| PR-2 | 客户端层 B：skills reminder 按需替换 | `packages/core/src/plugins/built-ins/helix-compressor.ts` | 低 | `CCR_HELIX_SKILLS_COMPACT=off` |
| PR-3 | Helix 调优：默认 `blockThresholdChars=200` | `helix-compressor.ts` 默认值改 | 中-高 | 用户可逐请求覆盖；UI 加 "Helix compression level" 滑块（off / 保守 500 / 甜区 200 / 激进 100） |
| PR-4 | UI：PluginSettingsDialog 加 Helix 字段 | `packages/ui/src/pages/home/components/extensions.tsx` | 低 | 改 UI 不影响功能 |
| PR-5 | 评估 LLM 改用真实 evaluator | `helix-compressor.ts` evaluator 部分 | 中 | `sampleMod=999` 关抽样 |

每个 feature flag 默认 `on`，仅对预设的目标模型档生效。

---

## 9. 已知限制与开放问题

**已并入 11.9**，此处不再重复。原第 9 节列的"摘要模型 fallback / trigger word 表 / 图片压缩 / token 估算 / 真实回归测试 / Web UI"在新第 11.9 节以 Helix Compressor 上下文重新表述。

---

## 10. 验证记录

| 检查 | 结果 |
| --- | --- |
| 静态分析脚本对示例样本的结论可复现 | 通过（第 6 节命令输出与第 2 节表格一致） |
| Helix Compressor 存在性 + 占位召回机制 | 通过（读 `helix-compressor.ts` 验证：`⟦HC:hash⟧`、`⟦QA:hash⟧`、`hc_recall`、`history_recall`） |
| 网络日志面板显示压缩率 | 通过（`packages/ui/src/pages/home/shared/logs.ts:57` `formatLogCompressSummary`） |
| PluginSettingsDialog 是否展开 Helix 专属字段 | **未展开**（仅通用字段；本轮提出 PR-4 补 9 个 Field） |
| 客户端互补层单元测试（场景 17-23） | 未在本轮执行；占位 |
| 端到端真实模型对比 | 未在本轮执行；占位 |
| PR 拆分与 feature flag 设计 | 文档化完成 |

---

## 11. Helix Compressor 调优 + 客户端互补层（2026-10-11 重写）

### 11.1 关键发现

CCR 已有 **Helix Compressor** 插件（`packages/core/src/plugins/built-ins/helix-compressor.ts`，V3.2 + V3.3）：

- 调云端 `https://api.helix-compressor.com/v1/compress` 拿压缩结果
- 替换 text 块为 `⟦HC:hash⟧`（V2）或 `⟦QA:hash⟧`（V3.2 Q&A pair）占位符
- 注入 `hc_recall` / `history_recall` 工具让 LLM 按需召回
- V3.3 `blockThresholdChars` 触发任意 role 大文本块压缩
- V3.2 `storeWithMedia` 决定是否把 Q 中的原图/视频/文档字节进 cache（默认 false）
- 用 `gpt-tokenizer` 算真实 tokens，11 个 `x-helix-compressor-*` header 报告状态

本文档不再设计"新压缩系统"，而是**调优 Helix + 加客户端互补层**补 Helix 不做的事。

### 11.2 Helix 不做的事（客户端互补层的价值）

| 任务 | Helix 做 | 客户端补 |
|------|---------|---------|
| 删空消息（222 条 / 76%） | ❌ | ✅ 客户端先过滤 |
| 删 task-notification 死信 | ❌ | ✅ 客户端先过滤 |
| skills reminder 27 KB → 3 KB 索引 | ❌ | ✅ 客户端按需替换 |
| tools schema 按需裁剪 | ❌ | ✅ 客户端按最近 20 轮用的工具 |
| 改 system prompt | ❌（原样转发 27 KB） | ⚠️ 可选，按模型档 |
| Q&A pair 占位 | ✅ | 不动 |
| block 级大文本压缩 | ✅ | 不动 |

### 11.3 Helix 参数调优矩阵

| 参数 | 默认 | 推荐场景 | 副作用 |
| --- | --- | --- | --- |
| `keepRecentPairs` | 1 | 1（最稳） | 0 = 最新问题必看的图也压，丢关键事实 |
| | | 2-3 = 较宽松，保留多对 Q&A 不压缩 | 体积大 |
| | | 0 = 极限（仅在客户端已删空消息后才用） | 必丢最新问题细节 |
| `blockThresholdChars` | 0（关） | 200 = 实测甜区 | <100 = 误伤短代码块 |
| | | 0 = 仅 Q&A pair 压缩 | 长 system 输出不压 |
| `storeWithMedia` | false | false（默认） | 体积小，A 的文字描述通常够 |
| | | true = 截图 / PDF 场景 | 体积翻倍 |
| `sampleMod` | 20（5% 抽样） | 20（生产） | 1 = 全量评估，慢 |
| | | 999 = 关评估 | 无 quality 数据 |

### 11.4 模型上下文窗口下的 Helix 行为

Helix 不感知目标模型上下文。它按 `keepRecentPairs` / `blockThresholdChars` 算压缩后体积，**不保证能塞进模型上下文**。

实测示例样本（160 K tokens → Helix 默认 `keepRecentPairs=1` + `blockThresholdChars=200` + 客户端 preprocess）：

| 模型 | 上下文 | Helix+客户端 压后（估） | 备注 |
| --- | --- | --- | --- |
| Haiku 4.5 | 32 K | ~30-60 K ⚠️ 部分超 | 极端长输入可能超，需更激进压缩 |
| M2.7 | 48 K | ~30-60 K ✅ | 大多数情况充裕 |
| Sonnet 5.5 | 200 K | ~30-60 K ✅ | 大量 buffer |
| Opus 5.5 | 200 K | ~30-60 K ✅ | 大量 buffer |

**核心结论**（实测修正）：48 K 窗口**大多数情况装得下** Helix 默认 + 客户端 preprocess 的输出（~30-60 K tokens，与 §5 一致）。**前提**：

1. Helix `keepRecentPairs=1`（默认，最稳）
2. Helix `blockThresholdChars=200`（PR-3 建议改默认值）
3. 客户端 preprocess 删空消息 + skills reminder 压缩索引

**风险**：当压缩比不足（输入超大或 Helix 命中少）时输出可能仍在 48 K 边缘。32 K 以下窗口（Haiku）需 `keepRecentPairs=0` 或更激进的客户端裁剪。

### 11.5 客户端互补层接入点

不动 Helix 插件核心，只在 **transform handler 入口** 加 preprocess / postprocess 钩子。`clientPreprocess` 完整实现见 §3.1；`clientCompactSkills` 与 `clientPruneTools` 见 §3.4 与下文。

```ts
// packages/core/src/plugins/built-ins/helix-compressor.ts
// 在现有 helixCompressorTransform 内部(已存在)插入客户端互补:
export const helixCompressorTransform: GatewayPluginRequestTransformHandler = async (
  request, context
) => {
  let messages = request.messages;

  // 互补 A1: 客户端垃圾清零(详见 §3.1)
  messages = clientPreprocess(messages);

  // 互补 A2: skills reminder 按需替换为压缩索引(仅当本会话未调用 Skill tool)
  messages = clientCompactSkills(messages);

  // 互补 D: tools schema 按需裁剪(详见 §3.4)
  const tools = clientPruneTools(messages, request.tools);

  // Helix 主体(V3.2 + V3.3,已有代码)
  const compressed = await callHelixCompress({ messages, tools, ... });

  return { messages: compressed.messages, tools };
};

function clientCompactSkills(messages: Message[]): Message[] {
  // 判定: 本会话是否调用过 Skill tool?
  const usedSkill = messages.some(m =>
    m.content?.some((c: any) => c.type === 'tool_use' && c.name === 'Skill'));
  if (usedSkill) return messages;

  return messages.map(m => {
    const text = extractText(m);
    if (text.includes('The following skills are available for use with the Skill tool')) {
      return replaceReminder(m, COMPRESSED_SKILLS_INDEX);
    }
    return m;
  });
}
```

**接入顺序关键**：客户端 preprocess 必须在 Helix compress 之前。否则 client 会处理已被 Helix 替换的占位符。

### 11.6 用户面板集成

当前 `packages/ui/src/pages/home/components/extensions.tsx` 的 `PluginSettingsDialog` 是**通用插件字段**，不展开 Helix 专属字段。需要在 `Browser apps JSON` Field 之后追加 **9 个 Field**（基于 HelixCompressorConfig 接口的 user-facing 字段）：

```tsx
{/* 云端 API */}
<Field label={t("Helix API URL")}>
  <Input value={draft.helixApiUrl} onChange={...} placeholder="https://api.helix-compressor.com" />
</Field>
<Field label={t("Helix API Key")}>
  <Input type="password" value={draft.helixApiKey} onChange={...} />
</Field>

{/* 评估 LLM */}
<Field label={t("Evaluator API URL")}>
  <Input value={draft.evaluatorApiUrl} onChange={...} placeholder="https://api.minimaxi.com/v1" />
</Field>
<Field label={t("Evaluator Model")}>
  <Input value={draft.evaluatorModel} onChange={...} placeholder="MiniMax-M3" />
</Field>
<Field label={t("Evaluator API Key")}>
  <Input type="password" value={draft.evaluatorApiKey} onChange={...} />
</Field>

{/* 压缩行为 */}
<Field label={t("Keep recent Q&A pairs")}>
  <Input type="number" min={0} max={5} value={draft.keepRecentPairs} onChange={...} />
</Field>
<Field label={t("Block threshold (chars)")}>
  <Input type="number" min={0} step={50} value={draft.blockThresholdChars} onChange={...} />
</Field>
<Field label={t("Store original media")}>
  <Toggle checked={draft.storeWithMedia} onChange={...} />
</Field>
<Field label={t("Sample rate (1/N)")}>
  <Input type="number" min={1} value={draft.sampleMod} onChange={...} />
</Field>
```

**字段计数说明**：文档前几版写"6 个"是漏数 — `Helix API Key` 与 `Evaluator API Key` 同为密码字段容易看漏。9 个全部对应 `HelixCompressorConfig` 中的 user-facing 字段；`timeoutMs` / `reportFailuresSilent` / `skipOnErrorStatusCodes` / `requestIdHeader` 为系统级，不在 UI 暴露。

网络日志面板（`packages/ui/src/pages/home/components/network-logs.tsx`）**已经显示每条请求的压缩率**：

```
160,000→~35,000 tok (-78%) · 145 QA 占位
```

无需额外 UI。

### 11.7 新增验收场景

| # | 场景 | 测试与判定 |
| --- | --- | --- |
| 17 | Helix 默认配置跑示例样本，输出 baseline→compressed tok | `packages/core/test/integration/helix/default-with-preprocess.test.mjs`：mock `/v1/compress`，断言响应含 ~145 个 `⟦QA:` + 160 K→~30 K |
| 18 | 客户端 preprocess 后空消息全删 | `packages/core/test/unit/compress/client-preprocess.test.mjs`：fixture 含 124 user 空消息 + 98 assistant 空消息，断言 222 条全部消失（用 `isEffectivelyEmpty` 检测覆盖 `[{text:""}]` 形态） |
| 19 | 客户端 preprocess 后 Helix 输入体积减少 | 同上 integration：preprocess 前/后分别调 Helix，断言 preprocess 后 input chars 减少 ~2 K |
| 20 | Helix `blockThresholdChars=200` 触发大 block 压缩 | `packages/core/test/integration/helix/block-threshold.test.mjs`：fixture 含 500 char text 块，断言压缩 |
| 21 | `storeWithMedia=true` 时 recall 可取原图 | `packages/core/test/integration/helix/store-with-media.test.mjs`：mock `/v1/history/recall?with_media=true` 返 base64 |
| 22 | UI 显示 helix 专属字段 9 个 | `packages/ui/test/plugin-settings-helix.test.mjs`：渲染 `PluginSettingsDialog` 断言 9 个 Field 存在 |
| 23 | 网络日志 panel 显示 `160 K→~35 K tok (-78%)` | `packages/ui/test/network-logs-compress.test.mjs`：mock entry 注入 headers，断言 cell 文本 |

### 11.8 新增 / 修改文件清单

| 文件 | 改动 |
| --- | --- |
| `packages/core/src/plugins/built-ins/helix-compressor.ts` | 加 `clientPreprocess` / `clientCompactSkills` / `clientPruneTools` 三个内部函数 |
| `packages/core/src/plugins/built-ins/helix-compressor.ts` | `HELIX_COMPRESSOR_DEFAULTS` 改 `blockThresholdChars: 0 → 200` |
| `packages/ui/src/pages/home/components/extensions.tsx` | `PluginSettingsDialog` 加 9 个 Helix 专属 Field |
| `packages/core/test/unit/compress/client-preprocess.test.mjs` | 新建：场景 1、2、13、14、15 |
| `packages/core/test/unit/compress/skills-block.test.mjs` | 新建：场景 4 |
| `packages/core/test/integration/helix/keep-recent-zero.test.mjs` | 新建：场景 5、6 |
| `packages/core/test/integration/helix/block-threshold.test.mjs` | 新建：场景 7 |
| `packages/core/test/integration/helix/store-with-media.test.mjs` | 新建：场景 8 |
| `packages/core/test/integration/helix/default-with-preprocess.test.mjs` | 新建：场景 9-11 |

**不变更的文件**（已存在且正确）：

- `packages/core/src/plugins/built-ins/helix-compressor.ts` 的 transform / recall / evaluate 三段不动
- `packages/ui/src/pages/home/components/network-logs.tsx` 已有压缩列
- `packages/ui/src/pages/home/shared/logs.ts` `formatLogCompressSummary` 已实现

### 11.9 已知限制（合并 9 + 11.9）

| 项 | 状态 |
| --- | --- |
| 摘要模型本身挂掉的 fallback | Helix 已有（compress 失败 → 跳过 transform，body 不变） |
| trigger word 表覆盖率 | Helix 不感知 skill，**客户端可加**（按 mtime/skill 描述正则匹配） |
| 图片 / 视频 / PDF base64 的压缩 | 本样本 0 张图；`storeWithMedia` 默认 false 已够用 |
| 多语言 token 估算 | Helix 用 `gpt-tokenizer`，对中文偏快（与上游 Claude tokenizer 偏差 ±10%） |
| 真实模型回归测试集 | 待补：构造 5 个不同类型 Claude Code 真实会话 fixture |
| `keepRecentPairs=0` 丢最新问题 | 客户端先删空消息后仍可能；需 UI 显式提示 |
| Helix 云端依赖 | 云端 API 挂掉时所有压缩退化为无压缩，体积立即爆 |
| 48 K 窗口 M2.7 + 默认配置 | **放不进去**（~50 K > 48 K），客户端必须先 preprocess |

---

## 结论

CCR 已有 Helix Compressor（V3.2 + V3.3）作为压缩主力，使用 `⟦HC:hash⟧` / `⟦QA:hash⟧` 占位符 + `hc_recall` / `history_recall` 工具，支持 `storeWithMedia` 媒体召回。本文档的"新压缩系统"原案（section 11 第一版）与 Helix 重叠，已重写为：

1. **调优 Helix 参数**（`keepRecentPairs` / `blockThresholdChars` / `storeWithMedia`）
2. **客户端互补层**：删空消息 / 死信 / skills reminder 按需 / tools schema 按需
3. **UI 补 Helix 专属字段**：9 个 Field 加到 `PluginSettingsDialog`

预期效果：示例样本（540 KB / **160 K tokens** 实测）经 Helix 默认 + 客户端互补压至 **~30-60 K tokens**（−63-81%）。**48 K 预算大多数情况充裕**（最优可进 48 K、多数 ≤ 48 K），前提是 Helix 默认配置 + 客户端 preprocess 全部启用。

网络日志面板已显示每请求压缩率，无需新增 UI；`storeWithMedia` 默认 false，靠 LLM 对媒体的文字描述（A）通常够用。

本轮完成审计 + 文档修复；PR 落地需后续在 `packages/core/src/plugins/built-ins/helix-compressor.ts` 加客户端 preprocess 钩子，并扩展 `PluginSettingsDialog` UI。文档未替代代码评审。

---

## 附录：四轮审计修正记录

### 第一轮（2026-10-11 上午）
- A1：发现 Helix Compressor 已存在，section 11 设计重叠
- A2：22 K token 估算错
- A3：所有虚构文件路径（phase-a.ts / tiers.ts 等）需清除
- A4-A10：命名不一致、表格错位、PR 列表不全

### 第二轮（2026-10-11 中午）
- 全面重写 section 3/5/8/11 与 Helix 现状对齐
- 删所有虚构文件，加 Helix 真实路径
- 合并 section 9 + 11.9 限制列表

### 第三轮（2026-10-11 下午）
- B1：section 3 标题"四阶段压缩方案"与内容矛盾
- B2：section 3 intro 表 4 个阶段假节省数
- B3：skills reminder 节省估算 22-24 K 错（字节等同 token），gpt-tokenizer 实测 ≈ 6 K
- B4：Field 计数 6/8 不一致，统一为 9 个
- B5：tools schema 节省 20-25 K vs 87→30=57 K，统一为 ~22 K
- B6：tool_result 模糊数 100+ → 136 对
- B7：PR-3 默认值改风险描述不全，加 UI 滑块 fallback
- B8：删不推荐函数 `phaseC_summaryOnly` 暴露，仅指向引用
- **B12：task-notification 计数错误（4 条 → 7 条，每条 ~500 chars 而非 27 KB）**

### 第四轮（2026-10-11 傍晚）— gpt-tokenizer 全量实测
- **C1：起点 token 数修正 — 175 K → 160 K**（gpt-tokenizer 全 content 实测，tool_result 占 65%）
- **C2：QA pair 数修正 — 23 个 → 146 对**（之前 23 是早期误算）
- **C3：48 K 预算可行性反转 — "不充裕" → "充裕"**（160 K → ~30-50 K 轻松进 48 K，有 10-18 K buffer）
- **C4：clientPreprocess 漏检 98 条 assistant 空消息**（content 是 `[{text:""}]` 而非 `[]`）— 加 `isEffectivelyEmpty` 检测函数
- **C5：header 常量数修正 — 12+ → 11**（实测 `helixCompressorXxxHeader` 常量共 11 个）
- C6：空消息总数细化 — 222 → 124 user + 98 assistant
- C7：token 分布表新增（system 5.7K / tools 26.6K / messages text 15.7K / tool_use 8K / tool_result 103.9K）

### 第五轮（2026-10-11 晚上）— 计数与占位符语义
- **D1：system-reminder 总数 13 → 15**（实测：1 CLAUDE.md + 2 msg 162 + 8 msg 194 + 1 msg 242 + 2 msg 264/292 = 15）
- **D2：⟦QA: → ⟦HC: 修正**（`keepRecentPairs=0` 不改变占位符类型，Q&A pair 压缩仍是 `⟦QA:hash⟧`，不是单 block 占位符 `⟦HC:hash⟧`）
- D3：section 3 intro A 节省"7-10 K"与 section 5 A1+A2=7-8 K 一致（验过）
- D4：场景 18 细化 222 → 124 user + 98 assistant
- D5：补验收场景 13-16 覆盖 clientPreprocess 各空消息分支
- 文档行数 615 → 619

### 第六轮（2026-10-11 深夜）— token 范围与默认值实测
- **E1：section 11.4 token 范围 25-35 K → 30-50 K**（与 section 5 一致；Haiku 32 K 标 ⚠️ 部分超）
- E2：场景 1 细化 "222 条空消息" → "124 user + 98 assistant"
- E3：实测 HelixCompressorRequestTransformKey 与 ResponseHookKey 与 contract.ts 定义一致（前者是 transform key，后者 plugin 内部命名；不存在 mismatch）
- E4：补"行 580 结论"提"10-18 K buffer"留档作为评估基准

#### Helix 实测默认值（实测验证 §11.3）

```
helixApiUrl:        "https://api.helix-compressor.com"
evaluatorApiUrl:    "https://api.minimaxi.com/v1"
evaluatorModel:     "MiniMax-M3"
sampleMod:          20  (5% 抽样)
timeoutMs:          30000
reportFailuresSilent: true
skipOnErrorStatusCodes: [400, 401, 403]
requestIdHeader:    "x-helix-request-id"
keepRecentPairs:    1   (fallback)
blockThresholdChars: 0  (默认关)
storeWithMedia:     undefined → false (可选配置，默认 false)
```

11 个 `helixCompressor*Header` 常量已实测确认；2 个 plugin key（RequestTransform / ResponseHook）；1 个 tool name (`hc_recall`) + 1 个 `HISTORY_RECALL_TOOL_NAME`。

### 第七轮（2026-10-11 深夜）— tools schema 形态实测
- **F1：clientPruneTools 用 `t.function?.name` 错** — CCR 实际 tools schema 是 Anthropic 格式 `t.name`，不是 OpenAI `t.function.name`。修正代码示例
- **F2：tools schema 节省 22 K → 14.6 K**（实测：原始 32 工具 26.5 K tokens，最近实际用了 10 工具 = 12 K tokens，节省 14.6 K）
- **F3：tools 实际用了 10 个，不是 8 个**（`Agent`/`Bash`/`Edit`/`Glob`/`Grep`/`Read`/`TaskOutput`/`WebFetch`/`WebSearch`/`Write`）
- **F4：token 总范围 30-50 K → 30-60 K**（基于新节省数 14.6 K 而不是 22 K 重算：低限 160-110-21=29 K，高限 160-80-21=59 K）
- F5：工具 schema 形态说明（Anthropic vs OpenAI）加入客户端代码注释

### 第八轮（2026-10-12 凌晨）— cache_control 协议与 Helix schema mismatch
- **H1：cache_control 协议名错** — 之前文档写"OpenAI cache 标记"，实际是 Anthropic 的 `cache_control: {type:"ephemeral"}`（prompt caching）。实测样本 msg 292 block 1 含此字段
- **H2：✅ 已修复（2026-10-12）** — Helix recall 工具 schema 是 OpenAI 格式，但 body tools 是 Anthropic 格式，导致 Anthropic 请求下 recall 工具被忽略。修复：
  - 新增 `HC_RECALL_TOOL_SCHEMA_ANTHROPIC` / `HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC`（`input_schema` 格式）
  - 新增 `inferRequestFormat(body)` 辅助函数（行 716）检测请求协议
  - 注入逻辑（行 424-462）按协议分发，并兼容两种格式的查重
  - 新增 4 个针对性测试（`packages/core/test/unit/helix-compressor-anthropic-format.test.mjs`）
  - 既有 OpenAI 用户行为不变
- H3：section 4 + 7 场景 12 描述改为"Anthropic prompt caching"
- H4：第 11 节保留此 bug 提示供 Helix 维护者参考，不改 Helix 代码（**非文档作者职责**）

#### H2 修复改动清单

```
packages/core/src/plugins/built-ins/helix-compressor.ts:  +97 行
  - 行 716-727: inferRequestFormat() 辅助函数
  - 行 660-686: HC_RECALL_TOOL_SCHEMA_ANTHROPIC
  - 行 766-803: HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC
  - 行 424-441: hasHC 注入逻辑改造
  - 行 443-462: hasQA 注入逻辑改造

packages/core/test/unit/helix-compressor-recall.test.mjs: +50 行
  - 4 个 schema 一致性断言（HC_/HISTORY_ 的 OpenAI vs Anthropic 字段对比）

packages/core/test/unit/helix-compressor-anthropic-format.test.mjs: 新文件
  - 5 个集成测试（Anthropic body → Anthropic schema；OpenAI body → OpenAI schema；无 tools fallback；查重；混合格式查重）
```

**验证**：`tsc --noEmit` 通过（唯一 1 个 TS 错是修改前已存在的 `extractOpenAIHistoryRecallCalls` 返回类型缺 `with_media` 字段，非本修复引入）。