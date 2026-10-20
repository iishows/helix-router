/**
 * helix-local parity tests (P0)
 *
 * 锁定 `hc-local.ts` 与云端 `helix-compressor/src/compress/hc.js` 的逐字节一致性。
 * 金值由 tools/helix-golden-gen.mjs 生成(该脚本 import 云端 hc.js),命令:
 *   node --no-warnings tools/helix-golden-gen.mjs
 *
 * 覆盖:
 *   - computeHash 纯函数值
 *   - compressV3x 的 hash key 集合 / 输出 messages
 *   - extractText 的 '\n' 拼接口径
 *   - media 块 JSON.stringify 键序
 *   - 末轮 user 提问保留(云端的真实行为:keepFrom = 最后一条 assistant)
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  computeHash,
  makePlaceholder,
  extractText,
  compressV3x,
  MEDIA_BLOCK_TYPES,
  HC_DEFAULTS
} from "@ccr/core/plugins/built-ins/helix-compressor/hc-local.ts";

// ============= fixture（与 tools/helix-golden-gen.mjs 完全一致）=============

const LONG =
  "### Section 3 — Architecture review notes\n" +
  "The ingestion pipeline batch 3 processes telemetry events through a chain of transforms. " +
  "Each transform is idempotent and keyed by (tenant_id, event_seq). Retries use exponential backoff. " +
  "Known issue 3: partial writes to the segment store when the writer crashes mid-flush. " +
  "Mitigation: two-phase commit with a WAL. We measured p99 latency 141ms under load. " +
  "Decision 3: keep the current sharding scheme; revisit in Q4. Ref: RFC-1003, ticket ENG-403. Owner: team-3.";
const LONG2 =
  "### Section 7 — Architecture review notes\n" +
  "The ingestion pipeline batch 7 processes telemetry events through a chain of transforms. " +
  "Each transform is idempotent and keyed by (tenant_id, event_seq). Retries use exponential backoff. " +
  "Known issue 7: partial writes to the segment store when the writer crashes mid-flush. " +
  "Mitigation: two-phase commit with a WAL. We measured p99 latency 169ms under load. " +
  "Decision 7: keep the current sharding scheme; revisit in Q3. Ref: RFC-1007, ticket ENG-407. Owner: team-2.";
const A1 =
  "Acknowledged section 3. Noted the issue and the mitigation. The two-phase commit with a WAL is the right call given the crash-mid-flush failure mode we discussed for batch 3. " +
  "The exponential backoff retries remain idempotent under (tenant_id, event_seq), so replaying a partial flush is safe. I recorded the p99 latency 141ms figure and the decision to keep the current sharding scheme. " +
  "Open question: do we want to revisit the segment store writer crash handling in Q4 as the notes suggest, or pull it forward? Flagging for the next sync. Anything else to reconcile before we close out this review thread?";
const A7 =
  "Acknowledged section 7. Noted the issue and the mitigation. Partial writes to the segment store remain the main risk when the writer crashes mid-flush, and the two-phase commit with a WAL addresses it directly. " +
  "I logged the p99 latency 169ms and the decision to keep the current sharding scheme, with a revisit scheduled for Q3. Owner is team-2 with backup from team-3. " +
  "Follow-up: confirm the WAL replay path is covered by the integration suite before the next release cut. Anything else to reconcile?";
const FINAL_Q =
  "Summarize in ONE sentence: for Section 3, what was the p99 latency, and what decision did we take?";

const FIXTURE = [
  { role: "user", content: LONG },
  { role: "assistant", content: A1 },
  { role: "user", content: LONG2 },
  { role: "assistant", content: A7 },
  { role: "user", content: FINAL_Q }
];

// ============= 金值（tools/helix-golden-gen.mjs 输出）=============

const GOLDEN = {
  plainHash: "b94d27b9934d3e08", // sha256("hello world")[:16]
  textHash: "0709b4759f88b7db",
  pairStrHash: "15a8642789cbe4ca",
  mediaJsonHash: "e45cae9902e497db",
  cloudHashKeys: ["15a8642789cbe4ca", "c9ab156f029e1827"],
  cloudCompressedCount: 2
};

// ============= computeHash ==============

test("computeHash matches cloud sha256[:16] golden values", () => {
  assert.equal(computeHash("hello world"), GOLDEN.plainHash);
  assert.equal(computeHash(LONG), GOLDEN.textHash);
  assert.equal(computeHash(JSON.stringify({ q: LONG, a: A1 })), GOLDEN.pairStrHash);
});

test("computeHash is sha256 hex[:16] and unsalted", () => {
  assert.equal(computeHash("hello world").length, 16);
  assert.match(computeHash("hello world"), /^[a-f0-9]{16}$/);
  // 无 salt:同输入必同值
  assert.equal(computeHash("x"), computeHash("x"));
});

test("makePlaceholder emits ⟦QA:hash⟧", () => {
  assert.equal(makePlaceholder("abcdef0123456789"), "⟦QA:abcdef0123456789⟧");
  assert.equal(HC_DEFAULTS.PLACEHOLDER_PREFIX, "⟦QA:");
});

// ============= extractText ==============

test("extractText joins text blocks with '\\n' and ignores non-text blocks", () => {
  assert.equal(extractText("plain"), "plain");
  const blocks = [
    { type: "text", text: "line1" },
    { type: "image", source: {} },
    { type: "text", text: "line2" }
  ];
  assert.equal(extractText(blocks), "line1\nline2");
  assert.equal(extractText([]), "");
  assert.equal(extractText(undefined), "");
});

test("extractText of single text block equals raw string ('' join of one)", () => {
  assert.equal(extractText([{ type: "text", text: "only" }]), "only");
});

// ============= media hash 键序 ==============

test("media block hash matches cloud JSON.stringify key order", () => {
  const mediaBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
  assert.equal(computeHash(JSON.stringify(mediaBlock)), GOLDEN.mediaJsonHash);
  assert.ok(MEDIA_BLOCK_TYPES.has("image"));
  assert.ok(MEDIA_BLOCK_TYPES.has("document"));
  assert.ok(!MEDIA_BLOCK_TYPES.has("text"));
});

// ============= compressV3x 全量 parity ==============

test("compressV3x hash keys match cloud golden set", () => {
  const r = compressV3x(FIXTURE, { keepRecentPairs: 1, minChars: 500 });
  assert.deepEqual(Object.keys(r.hashMap).sort(), GOLDEN.cloudHashKeys);
  assert.equal(r.stats.compressedCount, GOLDEN.cloudCompressedCount);
});

test("compressV3x replaces Q&A pairs with placeholders and drops assistant", () => {
  const r = compressV3x(FIXTURE, { keepRecentPairs: 1, minChars: 500 });
  // pair1 Q → placeholder, pair1 A dropped; pair2 Q → placeholder, pair2 A dropped
  assert.equal(r.messages.length, 3);
  assert.equal(r.messages[0].content, `⟦QA:${GOLDEN.cloudHashKeys[0]}⟧`);
  assert.equal(r.messages[0].role, "user");
  assert.equal(r.messages[1].role, "user");
  assert.deepEqual(r.hashMap[GOLDEN.pairStrHash], {
    q: LONG,
    a: A1,
    qIdx: 0,
    aIdx: 1
  });
});

test("final user question is preserved verbatim (cloud keepFrom semantics)", () => {
  // 云端 keepFrom = 最后一条 assistant 的 index,末轮 user 落在候选范围之外,原文保留。
  // 本地端口默认行为与云端一致。这是对"压缩吞提问"的一次结构性复核(见设计稿修订)。
  const r = compressV3x(FIXTURE, { keepRecentPairs: 1, minChars: 500 });
  const last = r.messages[r.messages.length - 1];
  assert.equal(last.role, "user");
  assert.equal(last.content, FINAL_Q);
  assert.ok(!String(last.content).includes("⟦QA:"));
});

test("12-pair realistic scenario preserves the trailing question", () => {
  const filler = (i) =>
    `### Section ${i} — notes\nThe ingestion pipeline batch ${i} processes telemetry events through a chain of transforms. ` +
    `Each transform is idempotent and keyed by (tenant_id, event_seq). Retries use exponential backoff. ` +
    `Known issue ${i}: partial writes. Mitigation: two-phase commit with a WAL. We measured p99 latency ${120 + i * 7}ms under load. ` +
    `Decision ${i}: keep the current sharding scheme. Ref: RFC-${i}.`;
  const msgs = [];
  for (let i = 0; i < 12; i++) {
    msgs.push({ role: "user", content: filler(i) });
    msgs.push({
      role: "assistant",
      content:
        `Acknowledged section ${i}. Noted the issue and the mitigation. Anything else to reconcile in this thread before we proceed further with the rollout plan?`
    });
  }
  msgs.push({ role: "user", content: FINAL_Q });
  const r = compressV3x(msgs, { keepRecentPairs: 1, minChars: 500 });
  const last = r.messages[r.messages.length - 1];
  assert.equal(last.content, FINAL_Q);
});

// ============= 幂等性 ==============

test("already-compressed content is skipped (idempotent)", () => {
  const once = compressV3x(FIXTURE, { keepRecentPairs: 1, minChars: 500 });
  const twice = compressV3x(once.messages, { keepRecentPairs: 1, minChars: 500 });
  // 第二次输入已含 ⟦QA:⟧,不应再产生新候选
  assert.deepEqual(Object.keys(twice.hashMap), []);
});

// ============= F1(2026-10-19): "提到"占位符语法的工具输出不得免疫 =============
//
// 旧守卫用 `includes("⟦QA:")` 判幂等 → 任何只是**提到**该语法的正常工具输出
// (读文档/读 hc-local.ts 本身/git log 关于 helix 的提交/memory 文件)被误判为
// 已压缩而永久不漏压。实测审计流量里 89.9% 的未压工具字符因这条误判免疫。
// 修复:幂等判断改为"整体即占位符"(isPlaceholderOnly 全匹配)。

const F1_TOOL_PREFIX = [
  { role: "user", content: "问题描述 ".repeat(80) },
  { role: "assistant", content: "回答内容 ".repeat(80) }
];
const bigToolBody = (kw) => `工具输出开始 ${kw} ` + "数据".repeat(1200) + ` 工具输出结束 ${kw}`;

test("F1: 工具输出里『提到』⟦QA:⟧ 语法仍应被压缩(旧 includes 守卫的误伤)", () => {
  const msgs = [
    ...F1_TOOL_PREFIX,
    { role: "tool", tool_call_id: "t1", content: bigToolBody("文档里写了 ⟦QA:abc123⟧ 这种占位符语法") }
  ];
  const r = compressV3x(JSON.parse(JSON.stringify(msgs)), {
    keepRecentPairs: 1, storeMedia: false, blockThresholdChars: 0, compressMedia: true,
    compressToolResults: true, toolResultThresholdChars: 1000, keepRecentToolResults: 0, maxCompressToolResults: 200
  });
  assert.equal(Object.keys(r.hashMap).length, 1, "提到语法的工具输出应被压缩,而非免疫");
  const tool = r.messages.find((m) => m.role === "tool");
  assert.match(String(tool.content), /^⟦QA:[0-9a-f]{16}⟧$/, "整条应替换成占位符");
});

test("F1: 整体即占位符的工具输出仍幂等跳过", () => {
  const msgs = [
    ...F1_TOOL_PREFIX,
    { role: "tool", tool_call_id: "t1", content: "⟦QA:abcdef0123456789⟧" }
  ];
  const r = compressV3x(JSON.parse(JSON.stringify(msgs)), {
    keepRecentPairs: 1, storeMedia: false, blockThresholdChars: 0, compressMedia: true,
    compressToolResults: true, toolResultThresholdChars: 1000, keepRecentToolResults: 0, maxCompressToolResults: 200
  });
  assert.equal(Object.keys(r.hashMap).length, 0, "已是占位符 → 幂等,不再产生候选");
});

test("F1: 整体即占位符(带空白)的消息也跳过", () => {
  const msgs = [
    ...F1_TOOL_PREFIX,
    { role: "user", content: "  ⟦QA:abcdef0123456789⟧  " }
  ];
  const r = compressV3x(JSON.parse(JSON.stringify(msgs)), { keepRecentPairs: 1, minChars: 500 });
  assert.equal(Object.keys(r.hashMap).length, 0);
});

// ============= 本地修正:tool block 不得产生孤儿 tool_result =============
//
// 云端 hc.js 会把 pair 的 assistant 整条删除。真实 Claude Code 请求里 assistant
// 常携带 tool_use,删掉后引用它的 tool_result 变孤儿,上游以 400
// `tool result's tool id(...) not found (2013)` 拒绝。
// 本地修正:含 tool block 的消息只压缩 text 块,保留 tool 块与配对的消息。

function orphanToolResults(out) {
  const use = new Set();
  const refs = [];
  for (const m of out.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_use") use.add(b.id);
      if (b.type === "tool_result") refs.push(b.tool_use_id);
    }
  }
  return refs.filter((id) => !use.has(id));
}

function textBlockChars(msg) {
  if (typeof msg.content === "string") return msg.content.length;
  if (!Array.isArray(msg.content)) return 0;
  return msg.content.reduce(
    (n, b) => n + (b && b.type === "text" && typeof b.text === "string" ? b.text.length : 0),
    0
  );
}

const TOOL_LONG =
  ("### Section 3 — notes\nThe ingestion pipeline batch 3 processes telemetry events through a chain of idempotent transforms. " +
    "Known issue 3: partial writes to the segment store when the writer crashes mid-flush. Decision 3: keep the current sharding scheme. " +
    "We measured p99 latency 141ms under load. Ref: RFC-1003, ticket ENG-403. Owner: team-3. ").repeat(2);
const TOOL_LONG_A =
  ("Acknowledged section 3. Noted the issue and the mitigation. The two-phase commit with a WAL is the right call given the crash-mid-flush " +
    "failure mode we discussed for batch 3. The exponential backoff retries remain idempotent under (tenant_id, event_seq). " +
    "Open question: do we want to revisit the segment store writer crash handling in Q4 as the notes suggest, or pull it forward? ").repeat(2);

test("tool_use assistant pair compresses text but keeps tool blocks (no orphan tool_result)", () => {
  const msgs = [
    { role: "user", content: TOOL_LONG },
    {
      role: "assistant",
      content: [
        { type: "text", text: TOOL_LONG_A },
        { type: "tool_use", id: "T1", name: "Bash", input: { cmd: "ls" } }
      ]
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "T1", content: "file1\nfile2" }] },
    { role: "user", content: "Final question: what did we decide?" }
  ];
  const r = compressV3x(msgs, { keepRecentPairs: 1, minChars: 500 });
  assert.deepEqual(orphanToolResults(r), []);
  // tool_use 与其 tool_result 都在
  const all = JSON.stringify(r.messages);
  assert.ok(all.includes('"T1"'));
  // 消息数不减(无整条删除)
  assert.equal(r.messages.length, 4);
  // Q 的 text 被替换为占位符,assistant text 也被压缩
  assert.match(String(r.messages[0].content), /^⟦QA:[a-f0-9]{16}⟧$/);
  assert.ok(textBlockChars(r.messages[1]) < TOOL_LONG_A.length);
});

test("orphan tool_result never appears across a mixed tool/text history", () => {
  const filler = (i) =>
    `### Section ${i} — notes\nThe ingestion pipeline batch ${i} processes telemetry events through a chain of transforms. ` +
    `Known issue ${i}: partial writes. Mitigation: two-phase commit with a WAL. Measured p99 latency ${120 + i * 7}ms under load. Ref: RFC-${i}.`;
  const msgs = [
    { role: "user", content: filler(0) },
    {
      role: "assistant",
      content: [
        { type: "text", text: filler(100) },
        { type: "tool_use", id: "T1", name: "Read", input: { f: "a" } }
      ]
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "T1", content: "aaa" }] },
    { role: "assistant", content: filler(200) },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "T2", content: "bbb" }] },
    { role: "user", content: "Final question?" }
  ];
  const r = compressV3x(msgs, { keepRecentPairs: 1, minChars: 500 });
  // T2 无对应 tool_use(输入本身即孤儿),不在修正范围内;只断言 T1 不产生新孤儿
  assert.deepEqual(orphanToolResults(r).filter((id) => id === "T1"), []);
});

test("user with tool_result+text paired with plain assistant keeps the tool_use", () => {
  const msgs = [
    {
      role: "assistant",
      content: [
        { type: "text", text: TOOL_LONG_A },
        { type: "tool_use", id: "T1", name: "Bash", input: { cmd: "ls" } }
      ]
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "T1", content: "file1" },
        { type: "text", text: TOOL_LONG }
      ]
    },
    { role: "assistant", content: TOOL_LONG_A },
    { role: "user", content: "Final question?" }
  ];
  const r = compressV3x(msgs, { keepRecentPairs: 1, minChars: 500 });
  assert.deepEqual(orphanToolResults(r), []);
  assert.ok(JSON.stringify(r.messages).includes('"T1"'));
});

test("string-content pair still drops assistant (cloud parity preserved)", () => {
  const r = compressV3x(FIXTURE, { keepRecentPairs: 1, minChars: 500 });
  assert.equal(r.messages.length, 3);
  assert.equal(r.messages[0].content, `⟦QA:${GOLDEN.cloudHashKeys[0]}⟧`);
});

// ============= 边界 ==============

test("empty / non-array input returns passthrough", () => {
  const e = compressV3x([], {});
  assert.deepEqual(e.messages, []);
  assert.deepEqual(e.hashMap, {});
  assert.equal(e.stats.compressedCount, 0);
});

test("block-level compression (blockThresholdChars>0) compresses large text blocks", () => {
  const msgs = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "system", content: LONG } // system 不可压(Q&A 路径),但 block 路径可
  ];
  const r = compressV3x(msgs, { keepRecentPairs: 1, minChars: 500, blockThresholdChars: 200 });
  // LONG(505 chars) > 200 阈值 → 应被 block 压缩
  assert.ok(Object.keys(r.hashMap).length >= 1);
});

// ============= 媒体块压缩(独立于 blockThresholdChars) =============
//
// 线上配置无 blockThresholdChars → 默认 0。此前媒体块只在 selectBlockCandidates 内产出,
// 被 threshold=0 门控 → 图片永不压、不入缓存、无法召回。现媒体块独立成 pass(有即压),
// 但仍尊重 recent/当前轮保护(当期必看的图不压)。

const IMG_A = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
const IMG_FINAL = { type: "image", source: { type: "base64", media_type: "image/png", data: "FFFF" } };

function collectImageBlocks(msgs) {
  const out = [];
  for (const m of msgs) {
    if (Array.isArray(m.content)) for (const b of m.content) if (b && b.type === "image") out.push(b);
  }
  return out;
}

const MEDIA_FIXTURE = [
  { role: "user", content: "anchor question" }, // idx0 firstUser → 保护
  { role: "assistant", content: "anchor answer" },
  { role: "user", content: [{ type: "text", text: "here is a pic" }, IMG_A] }, // idx2 媒体 → 压
  { role: "assistant", content: "saw it" },
  { role: "user", content: "latest" },
  { role: "assistant", content: "latest ans" },
  { role: "user", content: [{ type: "text", text: "what is this?" }, IMG_FINAL] } // 末轮媒体 → 保护
];

test("media block is compressed with no blockThresholdChars (independent switch)", () => {
  const r = compressV3x(MEDIA_FIXTURE, { keepRecentPairs: 1, minChars: 500 });
  const hashA = computeHash(JSON.stringify(IMG_A));
  const entry = r.hashMap[hashA];
  assert.ok(entry, "media hash entry must exist");
  assert.equal(entry.kind, "media");
  assert.equal(entry.blockOnly, true);
  // qMedia 携带原块(供 with_media 召回)
  assert.deepEqual(entry.qMedia, [IMG_A]);
  // q 是小标记,不含 base64 正文
  assert.match(entry.q, /^\[media block: image .+, \d+ bytes\]$/);
  assert.ok(!entry.q.includes("AAAA"));
});

test("compressed media block becomes a ⟦QA:hash⟧ text placeholder", () => {
  const r = compressV3x(MEDIA_FIXTURE, { keepRecentPairs: 1, minChars: 500 });
  const hashA = computeHash(JSON.stringify(IMG_A));
  const msg = r.messages[2];
  assert.equal(msg.role, "user");
  // 原 text 块保留;image 块被替换为占位符 text 块
  assert.deepEqual(msg.content[1], { type: "text", text: `⟦QA:${hashA}⟧` });
  assert.deepEqual(msg.content[0], { type: "text", text: "here is a pic" });
});

test("recent / current-turn media is protected (model still sees the image it must answer)", () => {
  const r = compressV3x(MEDIA_FIXTURE, { keepRecentPairs: 1, minChars: 500 });
  const hashFinal = computeHash(JSON.stringify(IMG_FINAL));
  assert.equal(r.hashMap[hashFinal], undefined, "final-turn image must NOT be compressed");
  // 末轮图片仍在 messages 里
  assert.ok(collectImageBlocks(r.messages).some((b) => b.source.data === "FFFF"));
});

test("compressMedia:false disables media compression entirely", () => {
  const r = compressV3x(MEDIA_FIXTURE, { keepRecentPairs: 1, minChars: 500, compressMedia: false });
  const hashA = computeHash(JSON.stringify(IMG_A));
  assert.equal(r.hashMap[hashA], undefined);
  assert.ok(collectImageBlocks(r.messages).some((b) => b.source.data === "AAAA"));
});

// ============= V1.12: tool_result 压缩 =============
// 真实 agent 会话内容主体在工具输出里(实测占 body 53%),但旧算法只认 text/media
// 块,导致 12 万 token 请求只压掉 0.2%。以下用例钉住新行为。

function makeToolHistory(bodyChars = 4000, n = 6) {
  const msgs = [{ role: "system", content: "sys" }];
  for (let i = 0; i < n; i++) {
    const body = `OUT${i} ` + "x".repeat(bodyChars);
    msgs.push({
      role: "user",
      content: [
        { type: "text", text: `read file ${i}` },
        { type: "tool_result", tool_use_id: `call_${i}`, content: body }
      ]
    });
    msgs.push({
      role: "assistant",
      content: [
        { type: "text", text: `ok ${i}` },
        { type: "tool_use", id: `call_${i}`, name: "Read", input: { path: `/x${i}` } }
      ]
    });
  }
  return msgs;
}

function toolResultBlocks(messages) {
  const out = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) if (b && b.type === "tool_result") out.push(b);
  }
  return out;
}

function toolResultTextOf(messages, toolUseId) {
  const blk = toolResultBlocks(messages).find((b) => b.tool_use_id === toolUseId);
  return typeof blk?.content === "string" ? blk.content : "";
}

test("tool_result over threshold is compressed to ⟦QA:hash⟧, block + tool_use_id preserved", () => {
  const msgs = makeToolHistory(4000, 6);
  const r = compressV3x(msgs, {});
  // call_0 所在消息是第一条 user(anchor 保护),call_2 是稳定的可压目标
  const text2 = toolResultTextOf(msgs, "call_2");
  const hash = computeHash(text2);
  const entry = r.hashMap[hash];
  assert.ok(entry, "tool_result hash entry must exist");
  assert.equal(entry.kind, "tool_result");
  assert.equal(entry.blockOnly, true);
  assert.equal(entry.q, text2, "召回原文存 entry.q");
  const blk = toolResultBlocks(r.messages).find((b) => b.tool_use_id === "call_2");
  assert.ok(blk, "block 保留(只换 content)");
  assert.equal(blk.content, `⟦QA:${hash}⟧`);
});

test("tool_result compression keeps tool_use ↔ tool_result pairing (no orphan)", () => {
  const msgs = makeToolHistory(4000, 6);
  const r = compressV3x(msgs, {});
  const useIds = [];
  const resultIds = new Set();
  for (const m of r.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_use") useIds.push(b.id);
      if (b.type === "tool_result") resultIds.add(b.tool_use_id);
    }
  }
  assert.equal(useIds.length, 6);
  assert.deepEqual(useIds.filter((id) => !resultIds.has(id)), [], "不得出现孤儿 tool_use");
});

test("recent N tool_results are protected (model keeps most recent tool output)", () => {
  const msgs = makeToolHistory(4000, 6);
  const r = compressV3x(msgs, { keepRecentToolResults: 2 });
  const trs = toolResultBlocks(r.messages);
  // 最后 2 条原文保留
  const tail = trs.slice(-2);
  assert.ok(tail.every((b) => !String(b.content).includes("QA:")), "最近 2 条不得被压");
  // 前面的被压
  assert.ok(trs.slice(0, -2).some((b) => String(b.content).includes("⟦QA:")));
});

test("toolResultThresholdChars gates small outputs", () => {
  const msgs = makeToolHistory(200, 4); // 每条 body 仅 ~205 字符
  const r = compressV3x(msgs, { toolResultThresholdChars: 1000, keepRecentToolResults: 0 });
  assert.equal(r.stats.compressedCount, 0);
  assert.deepEqual(Object.keys(r.hashMap), []);
});

test("maxCompressToolResults caps count (largest savings first)", () => {
  const msgs = makeToolHistory(4000, 8);
  const r = compressV3x(msgs, { keepRecentToolResults: 0, maxCompressToolResults: 3 });
  const compressed = toolResultBlocks(r.messages).filter((b) => String(b.content).includes("⟦QA:"));
  assert.equal(compressed.length, 3);
});

test("default maxCompressToolResults covers real agent sessions (not capped at 20)", () => {
  // 真实 Claude Code 会话单请求可达 600+ 条 tool_result(实测某请求 278 条超阈值),
  // 旧默认 20 导致 95% 的超阈值工具输出原样明文发给上游。默认上限须足以覆盖真实历史。
  const msgs = makeToolHistory(3000, 60);
  const r = compressV3x(msgs, { keepRecentToolResults: 2 });
  const compressed = toolResultBlocks(r.messages).filter((b) => String(b.content).includes("⟦QA:"));
  // 远超旧默认 20 即证明上限已放宽;具体条数取决于 anchor/recent 保护。
  assert.ok(
    compressed.length > 50,
    `默认上限须覆盖真实会话(>50),实际 ${compressed.length}(旧默认只压 20)`
  );
});

test("compressToolResults:false disables tool_result compression", () => {
  const msgs = makeToolHistory(4000, 6);
  const r = compressV3x(msgs, { compressToolResults: false });
  assert.equal(r.stats.compressedCount, 0);
  assert.deepEqual(Object.keys(r.hashMap), []);
});

test("array-form tool_result content ([{type:text}]) is compressed too", () => {
  const body = "y".repeat(3000);
  const msgs = [
    { role: "user", content: [{ type: "text", text: "anchor" }] }, // 锚点消息(anchor 保护)
    { role: "assistant", content: "ack" },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "T1", content: [{ type: "text", text: body }] }] },
    { role: "assistant", content: "done" },
    { role: "user", content: "next" }
  ];
  const r = compressV3x(msgs, { keepRecentToolResults: 0 });
  const hash = computeHash(body);
  assert.ok(r.hashMap[hash], "array-form tool_result 也应被压");
  const blk = toolResultBlocks(r.messages).find((b) => b.tool_use_id === "T1");
  assert.ok(blk);
  assert.deepEqual(blk.content, [{ type: "text", text: `⟦QA:${hash}⟧` }]);
});

test("tool-dense history is no longer skipped as 'too short' (shouldSkipMessage counts tool bytes)", () => {
  // 每 pair 的 text 都很短,体量全在 tool_result;旧算法 charCount≈0 → 整条跳过
  const msgs = makeToolHistory(3000, 5);
  const r = compressV3x(msgs, {});
  assert.ok(
    r.stats.compressedCount > 0,
    "工具密集历史必须被压缩(旧算法只数 text 块导致 0)"
  );
});

// ============= OpenAI 形状的 tool 输出必须被压缩(真实 Claude Code 流量) =============
// 真实流量经 ccr 转成 OpenAI chat 形状:tool 输出是 `{role:"tool", content:"<字符串>"}`,
// 不是 Anthropic 的 `content:[{type:"tool_result"}]` 数组块。旧实现只扫数组块 →
// 真实流量 95% 工具输出(占 body 大半)从不被压缩、原样明文发给上游。

test("OpenAI role:tool string output is compressed (real Claude Code shape)", () => {
  const body = "SECRET-marker " + "y".repeat(3000);
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "run cmd" },
    { role: "assistant", content: "running", tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: body },
    { role: "user", content: "next" }
  ];
  const r = compressV3x(msgs, { keepRecentToolResults: 0 });
  const hash = computeHash(body);
  assert.ok(r.hashMap[hash], "OpenAI role:tool 的字符串输出必须进召回缓存");
  const toolMsg = r.messages.find((m) => m.role === "tool");
  assert.equal(toolMsg.content, `⟦QA:${hash}⟧`, "tool 消息内容应被替换为占位符");
  assert.equal(toolMsg.tool_call_id, "c1", "tool_call_id 必须保留(与原 tool_use 配对)");
});

test("OpenAI role:tool below threshold stays plaintext", () => {
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "run cmd" },
    { role: "assistant", content: "running", tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "short output" },
    { role: "user", content: "next" }
  ];
  const r = compressV3x(msgs, { keepRecentToolResults: 0 });
  assert.equal(r.messages.find((m) => m.role === "tool").content, "short output");
});

// ============= V1.13: 嵌套图片(块数组的 JSON 字符串)必须按媒体压缩 =============
// 真实流量:role:"tool" 的 content 是"Anthropic 块数组的 JSON 字符串",例如
// `[{"type":"image","source":{...}}]`(实测 66KB 的纯媒体数组)。旧实现里媒体 pass /
// extractMediaBlocks 只认 `Array.isArray(content)`,内层图片完全不可见,整条被
// tool_result pass 折成 kind:"text" 占位符 → 召回时图片以文本返回、模型看不到图。
// 修复后:识别嵌套数组里的媒体块,产出 kind:"media" 候选(召回携带可渲染 image 块)。

const NESTED_IMG = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };

function nestedMediaToolHistory() {
  return [
    { role: "system", content: "sys" },
    { role: "user", content: "u1 " + "x".repeat(60) },
    { role: "assistant", content: "a1 " + "y".repeat(60) },
    { role: "user", content: "u2 " + "z".repeat(60) },
    {
      role: "assistant",
      content: JSON.stringify([{ type: "tool_use", id: "call_1", name: "Read", input: { path: "/img" } }])
    },
    // 关键:tool 输出是"块数组的 JSON 字符串",内层是一张 base64 图片
    { role: "tool", tool_call_id: "call_1", content: JSON.stringify([NESTED_IMG]) },
    { role: "user", content: "look at it" },
    { role: "assistant", content: "ok" }
  ];
}

test("nested media in a JSON-string tool message compresses as kind:media (not text)", () => {
  const r = compressV3x(nestedMediaToolHistory(), { keepRecentToolResults: 0 });
  const kinds = Object.values(r.hashMap).map((e) => e.kind);
  assert.ok(kinds.includes("media"), `expected a media candidate, got ${JSON.stringify(kinds)}`);
  // 不得把这条图片消息误压成 text/tool_result(那会让召回变成纯文本)
  const mediaEntry = Object.values(r.hashMap).find((e) => e.kind === "media");
  assert.deepEqual(mediaEntry.qMedia, [NESTED_IMG], "召回须携带可渲染的 image 块");
  // 图片原块以占位符文本块形式回填(tool_result pass 不得覆盖为纯文本)
  const toolMsg = r.messages.find((m) => m.role === "tool");
  assert.equal(typeof toolMsg.content, "string");
  assert.equal(toolMsg.content, `⟦QA:${computeHash(JSON.stringify([NESTED_IMG]))}⟧`);
  assert.equal(toolMsg.tool_call_id, "call_1", "tool_call_id 保留");
});

test("nested media tool message: no text/tool_result candidate claims the same message", () => {
  const r = compressV3x(nestedMediaToolHistory(), { keepRecentToolResults: 0 });
  // 同一条消息(msgIdx)在 hashMap 里只应有一个条目,且其 kind 必须是 media
  const toolMsgIdx = nestedMediaToolHistory().findIndex((m) => m.role === "tool");
  const entriesForMsg = Object.values(r.hashMap).filter((e) => e.msgIdx === toolMsgIdx);
  assert.equal(entriesForMsg.length, 1, "同一媒体消息不得被两个 pass 重复认领");
  assert.equal(entriesForMsg[0].kind, "media");
});

// ============= V1.13 回归:超大 JSON 数组字符串不得触发无上限解析(OOM 防护) =============
// normalizeContentBlocks 会对"看起来像块数组"的字符串做 JSON.parse。工具输出里
// 几十万行、每行带 `type` 字段的 JSON 记录恰好满足该守卫,旧实现无上限解析,
// 实测 ~290MB 字符串可打爆 512MB 堆(ERR_WORKER_OUT_OF_MEMORY)。修复后
// 长度 > NESTED_BLOCK_PARSE_MAX_CHARS(1MB) 直接放弃解析,按纯文本 tool_result 处理。

test("oversized JSON-array tool output is not parsed / stays tool_result", () => {
  const row = '{"type":"row","payload":"' + "x".repeat(60) + '"},';
  const big = "[" + row.repeat(20000) + '{"type":"row","payload":""}]'; // 超 1MB 上限
  assert.ok(big.length > 1_000_000, "fixture 必须超过解析上限");
  const r = compressV3x(
    [
      { role: "system", content: "sys" },
      { role: "user", content: "u1 " + "x".repeat(6000) },
      { role: "assistant", content: "a1 " + "y".repeat(6000) },
      { role: "user", content: "u2 " + "z".repeat(6000) },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Bash", input: {} }] },
      { role: "tool", tool_call_id: "c1", content: big },
      { role: "user", content: "go" },
      { role: "assistant", content: "ok" }
    ],
    { keepRecentToolResults: 0 }
  );
  const kinds = Object.values(r.hashMap).map((e) => e.kind);
  assert.ok(!kinds.includes("media"), `超大字符串必须按文本处理: ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes("tool_result"), `expected tool_result, got ${JSON.stringify(kinds)}`);
});

// ============= 回归:含 base64 大图的媒体容器字符串必须被压缩(不再被 1MB 上限误杀) =============
// 真实故障:OpenAI 形状 role:"tool" 的 content 是"块数组 JSON 字符串",内含一张
// 1.2MB 的 base64 PNG,字符串总长 > NESTED_BLOCK_PARSE_MAX_CHARS(1MB) → 旧实现
// 放弃解析 → 图片对媒体 pass 不可见 → 被 tool_result pass 折成文本占位符,整条
// 请求只省 ~1.4%(实测 compression_ratio=0.9966)。修复:头部含媒体标记的容器字符串
// 放行解析(仍受 MEDIA_CONTAINER_PARSE_MAX_CHARS 硬上限保护)。
// 注意:媒体 pass 不受 keepRecentToolResults 约束;旧实现下 kRT=2 时该图落在"最近
// 两条工具结果"内,同时被回退保护跳过,故线上默认配置(kRT=2)必然命中此 bug。

function bigImageContainer(dataChars) {
  const data = "iVBORw0KGgoAAAANSUhEUg".repeat(Math.ceil(dataChars / 21)).slice(0, dataChars);
  return JSON.stringify([{ type: "image", source: { type: "base64", media_type: "image/png", data } }]);
}

test("oversized media-container string is compressed and stays recallable", () => {
  const imgJson = bigImageContainer(1_215_252);
  assert.ok(imgJson.length > 1_000_000, "fixture 必须超过通用解析上限");

  const msgs = [{ role: "system", content: "sys" }, { role: "user", content: "hello" }];
  for (let k = 0; k < 13; k++) {
    msgs.push({ role: "assistant", content: `call ${k}`, tool_calls: [{ id: `t${k}` }] });
    // 图片落在倒数第 2 条工具结果(与线上一致):kRT=2 时会落进回退保护窗口。
    msgs.push({
      role: "tool",
      tool_call_id: `t${k}`,
      content: k === 11 ? imgJson : "x".repeat(3000) + " out " + k
    });
  }
  msgs.push({ role: "user", content: "next?" });

  const before = JSON.stringify(msgs).length;
  const r = compressV3x(msgs, {
    keepRecentToolResults: 2,
    compressMedia: true,
    compressToolResults: true,
    toolResultThresholdChars: 1000,
    blockThresholdChars: 0,
    keepRecentPairs: 1
  });
  const after = JSON.stringify(r.messages).length;
  const savedRatio = 1 - after / before;

  assert.ok(savedRatio > 0.9, `大图必须被压掉(实测仅省 ${(savedRatio * 100).toFixed(1)}%)`);

  const mediaEntries = Object.values(r.hashMap).filter((e) => e.kind === "media");
  assert.equal(mediaEntries.length, 1, `图片必须作为 media 块压缩,而非文本: ${JSON.stringify(Object.values(r.hashMap).map((e) => e.kind))}`);
  // 召回保真:qMedia 携带真实 image 块(base64),而非占位符文本。
  const qMedia = mediaEntries[0].qMedia;
  assert.ok(Array.isArray(qMedia) && qMedia.length === 1, "qMedia 必须携带全部媒体块");
  assert.equal(qMedia[0].type, "image");
  assert.equal(qMedia[0].source.media_type, "image/png");
  assert.ok(String(qMedia[0].source.data).length > 1_000_000, "召回必须带回原始 base64 数据");
});

test("media-container string beyond absolute ceiling is still refused", () => {
  const imgJson = bigImageContainer(17_000_000);
  assert.ok(imgJson.length > 16_000_000, "fixture 必须超过媒体硬上限");
  const r = compressV3x(
    [
      { role: "system", content: "sys" },
      { role: "user", content: "u1 " + "x".repeat(6000) },
      { role: "assistant", content: "a1 " + "y".repeat(6000) },
      { role: "assistant", content: [{ type: "tool_use", id: "c2", name: "Bash", input: {} }] },
      { role: "tool", tool_call_id: "c2", content: imgJson },
      { role: "user", content: "go" },
      { role: "assistant", content: "ok" }
    ],
    { keepRecentToolResults: 0 }
  );
  const kinds = Object.values(r.hashMap).map((e) => e.kind);
  assert.ok(!kinds.includes("media"), `超过媒体硬上限必须放弃解析: ${JSON.stringify(kinds)}`);
});

// ============= V1.13 回归:字符串"伪媒体"不得误判为图片 =============
// mediaBlockFromString 只接受自证媒体的 `data:<image|video|audio>;base64,`。
// 裸 http(s) URL(内容类型未知)与 `data:text/plain;base64,` 都是文本,必须保持纯文本,
// 否则召回会把普通工具输出当图片回填。

function toolMsgHistory(content) {
  return [
    { role: "system", content: "sys" },
    { role: "user", content: "u1 " + "x".repeat(6000) },
    { role: "assistant", content: "a1 " + "y".repeat(6000) },
    { role: "user", content: "u2 " + "z".repeat(6000) },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Bash", input: {} }] },
    { role: "tool", tool_call_id: "c1", content },
    { role: "user", content: "go" },
    { role: "assistant", content: "ok" }
  ];
}

test("plain URL and non-media data-URL tool output stay text (not media)", () => {
  for (const content of [
    "https://example.com/reports/2026-q3-summary.csv",
    "data:text/plain;base64,SGVsbG8gd29ybGQ="
  ]) {
    const r = compressV3x(toolMsgHistory(content), { keepRecentToolResults: 0 });
    const kinds = Object.values(r.hashMap).map((e) => e.kind);
    assert.ok(!kinds.includes("media"), `${content.slice(0, 32)} 不得识别为媒体: ${JSON.stringify(kinds)}`);
  }
});

test("a genuine image data-URL tool output IS recognised as media", () => {
  const r = compressV3x(
    toolMsgHistory("data:image/png;base64," + "A".repeat(3000)),
    { keepRecentToolResults: 0 }
  );
  const kinds = Object.values(r.hashMap).map((e) => e.kind);
  assert.ok(kinds.includes("media"), `expected media, got ${JSON.stringify(kinds)}`);
});

test("entryFitsBudget veto prevents orphan placeholders", () => {
  // Every emitted placeholder must correspond to a hashMap entry that the store would
  // actually accept. Simulate a byte-budget veto and assert no placeholder leaks through.
  const big = "B".repeat(64 * 1024);
  const history = toolMsgHistory(big);

  const baseline = compressV3x(history, { keepRecentToolResults: 0 });
  assert.ok(Object.keys(baseline.hashMap).length > 0, "fixture must produce a candidate");

  const vetoAll = compressV3x(history, { keepRecentToolResults: 0, entryFitsBudget: () => false });
  assert.deepEqual(Object.keys(vetoAll.hashMap), [], "vetoed entries must not enter hashMap");

  // The vetoed run must not have swapped in any placeholder it cannot back with an entry.
  const asText = JSON.stringify(vetoAll.messages ?? []);
  for (const hash of Object.keys(baseline.hashMap)) {
    assert.ok(
      !asText.includes(hash),
      `hash ${hash} appears in messages but was vetoed — orphan placeholder`
    );
  }
});
