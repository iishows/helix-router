/**
 * helix-compressor × recall-local-store byte-budget integration tests.
 *
 * 回归目标:压缩器按**字符**上限挑候选,而 recall store 按**字节**上限(20MB)落盘。
 * 多字节(CJK)条目可能过得了压缩器的字符闸,却被 putBatch 静默丢弃 → prompt 里留下
 * 一个永远召不回的孤儿占位符 ⟦QA:hash⟧ / ⟦HC:hash⟧。
 *
 * 这些用例走**生产入口** helixCompressorTransform(即真实接线),
 * 而不是手动注入 entryFitsBudget —— 后者无法发现接线被摘掉。
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  helixCompressorTransform
} from "@ccr/core/plugins/built-ins/helix-compressor.ts";
import { compressV3x } from "@ccr/core/plugins/built-ins/helix-compressor/hc-local.ts";
import {
  MAX_ENTRY_BYTES,
  configureCacheDir,
  get,
  _clearCacheForTest,
  _resetIndexForTest
} from "@ccr/core/observability/helix-recall-local-store";

configureCacheDir(mkdtempSync(join(tmpdir(), "helix-budget-test-")));

const MODEL = "MiniMax-M2.7";

/**
 * abc123def4567890 是注入到 system prompt 里的**教学示例** hash
 * (helix-compressor.ts 的工具描述文本),不是真占位符,必须排除。
 */
const DOC_EXAMPLE_HASH = "abc123def4567890";
const PLACEHOLDER_RE = /⟦(?:HC|QA):([0-9a-f]{16})⟧/g;

/** 7M CJK 字符:过得了压缩器字符闸,但 UTF-8 ≈ 21MB > 20MB 字节闸。 */
const OVER_BUDGET = "中".repeat(7_000_000);
const IN_BUDGET = "中".repeat(2_000);

/**
 * 4 消息形状:第 2 对(最新)受"保护最后一轮提问"规则守护,第 1 对进入候选。
 */
function fixture(bigText) {
  return [
    { role: "user", content: bigText },
    { role: "assistant", content: "answer one" },
    { role: "user", content: "small follow up" },
    { role: "assistant", content: "answer two" }
  ];
}

function mockContext() {
  return {
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    pluginConfig: {},
    pluginId: "helix-compressor",
    openSqliteStore: async () => {
      throw new Error("not implemented");
    }
  };
}

function transformInput(messages) {
  return {
    body: { model: MODEL, messages },
    headers: {},
    method: "POST",
    path: "/v1/messages",
    requestId: "budget-test-0001",
    routedModel: MODEL,
    url: "/v1/messages"
  };
}

/** 抽取 prompt 中所有**真**占位符(排除文档示例 hash)。 */
function placeholdersIn(text) {
  return [...String(text).matchAll(PLACEHOLDER_RE)]
    .map((m) => m[1])
    .filter((hash) => hash !== DOC_EXAMPLE_HASH);
}

function seedEmpty() {
  _clearCacheForTest();
  _resetIndexForTest();
}

test("前置条件:OVER_BUDGET 确实超过 store 字节上限", () => {
  assert.ok(
    Buffer.byteLength(OVER_BUDGET, "utf-8") > MAX_ENTRY_BYTES,
    "fixture 必须真的越过字节闸,否则本文件是空测"
  );
});

test("生产路径:超字节预算条目 → 不产生孤儿占位符,原文逐字保留", async () => {
  seedEmpty();
  const result = await helixCompressorTransform(
    transformInput(fixture(OVER_BUDGET)),
    mockContext()
  );

  const body = JSON.stringify(result?.body?.messages);
  const placeholders = placeholdersIn(body);
  const readable = placeholders.filter((hash) => get(hash));

  assert.equal(
    placeholders.length,
    0,
    `超预算条目留下了 ${placeholders.length} 个占位符,其中 ${placeholders.length - readable.length} 个召不回`
  );
  assert.ok(body.includes("中中中"), "超预算原文必须原样保留,而不是被吞掉");
});

test("正对照:预算内条目 → 占位符可召回(证明管线确实跑过)", async () => {
  seedEmpty();
  const result = await helixCompressorTransform(
    transformInput(fixture(IN_BUDGET)),
    mockContext()
  );

  const body = JSON.stringify(result?.body?.messages);
  const placeholders = placeholdersIn(body);
  const readable = placeholders.filter((hash) => get(hash));

  assert.ok(
    placeholders.length > 0,
    "正对照失败:管线没产生任何占位符,说明其他用例是空过"
  );
  assert.equal(readable.length, placeholders.length, "每个占位符都必须可召回");
});

test("混合请求:同一次调用内,超预算被否、预算内仍可召回", async () => {
  seedEmpty();
  const messages = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: OVER_BUDGET },
    { role: "assistant", content: "c" },
    { role: "user", content: IN_BUDGET },
    { role: "assistant", content: "d" },
    { role: "user", content: "tail" },
    { role: "assistant", content: "e" }
  ];

  const result = await helixCompressorTransform(
    transformInput(messages),
    mockContext()
  );

  const body = JSON.stringify(result?.body?.messages);
  const placeholders = placeholdersIn(body);
  const readable = placeholders.filter((hash) => get(hash));

  assert.ok(placeholders.length > 0, "同一次调用里预算内的对仍应被压缩");
  assert.equal(
    placeholders.length,
    readable.length,
    `混合请求出现 ${placeholders.length - readable.length} 个孤儿占位符`
  );
  assert.ok(body.includes("中中中"), "超预算原文逐字保留 → 证明是闸否决,而非管线整体跳过");
});

test("反证:不加闸的 compressV3x 同一输入确实产生孤儿(缺陷真实存在)", async () => {
  seedEmpty();
  const result = compressV3x(fixture(OVER_BUDGET), {});
  const body = JSON.stringify(result.messages);
  const placeholders = placeholdersIn(body);
  const readable = placeholders.filter((hash) => get(hash));

  assert.ok(
    placeholders.length > 0,
    "未加闸路径本应产生占位符,若为 0 说明本用例无法证明闸的作用"
  );
  assert.equal(
    readable.length,
    0,
    "未加闸时占位符一个都召不回 —— 这正是被修复的缺陷"
  );
});
