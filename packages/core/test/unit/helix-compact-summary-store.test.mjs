/**
 * Helix 主动 compact 摘要缓存 store 单测(2026-10-15)
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import {
  cleanup,
  findPrefixSummary,
  getCompactSummary,
  putCompactSummary,
  resolveCompactSummaryDir,
  _clearCacheForTest,
  _resetIndexForTest
} from "@ccr/core/observability/helix-compact-summary-store.ts";

let cacheDir;

before(() => {
  cacheDir = mkdtempSync(path.join(os.tmpdir(), "helix-compact-store-"));
  process.env.HELIX_RECALL_CACHE_DIR = cacheDir;
});

after(() => {
  rmSync(cacheDir, { force: true, recursive: true });
  delete process.env.HELIX_RECALL_CACHE_DIR;
});

function fresh() {
  _resetIndexForTest();
  _clearCacheForTest();
}

test("resolveCompactSummaryDir: 未设环境变量时抛错", () => {
  const saved = process.env.HELIX_RECALL_CACHE_DIR;
  delete process.env.HELIX_RECALL_CACHE_DIR;
  try {
    assert.throws(() => resolveCompactSummaryDir(), /HELIX_RECALL_CACHE_DIR is not set/);
  } finally {
    process.env.HELIX_RECALL_CACHE_DIR = saved;
  }
});

test("resolveCompactSummaryDir: 落在 helix-compact 子目录", () => {
  assert.equal(resolveCompactSummaryDir(), path.join(cacheDir, "helix-compact"));
});

test("put/get: 内容寻址读写,幂等覆盖取最后一次", () => {
  fresh();
  assert.equal(putCompactSummary({
    coveredCount: 2,
    key: "k1",
    messageHashes: ["a", "b"],
    sessionId: "s1",
    summary: "first"
  }), true);
  assert.equal(getCompactSummary("k1").summary, "first");

  // 同 key 再写(模拟并发/更新) → 读到最后一次
  putCompactSummary({ coveredCount: 3, key: "k1", messageHashes: ["a", "b", "c"], sessionId: "s1", summary: "second" });
  assert.equal(getCompactSummary("k1").summary, "second");
  assert.equal(getCompactSummary("k1").coveredCount, 3);
});

test("get: 未命中 → null", () => {
  fresh();
  assert.equal(getCompactSummary("missing"), null);
});

test("put: 拒绝空摘要 / 空 key / 空 messageHashes", () => {
  fresh();
  assert.equal(putCompactSummary({ coveredCount: 0, key: "", messageHashes: ["a"], sessionId: "s", summary: "x" }), false);
  assert.equal(putCompactSummary({ coveredCount: 0, key: "k", messageHashes: ["a"], sessionId: "s", summary: "  " }), false);
  assert.equal(putCompactSummary({ coveredCount: 0, key: "k", messageHashes: [], sessionId: "s", summary: "x" }), false);
  assert.equal(putCompactSummary({ coveredCount: 0, key: "k", messageHashes: ["a"], sessionId: "", summary: "x" }), false);
});

test("get: TTL 过期 → null", () => {
  fresh();
  const now = Date.now();
  putCompactSummary({
    coveredCount: 1,
    expiresAt: now - 1000,
    key: "k-exp",
    messageHashes: ["a"],
    sessionId: "s",
    summary: "stale"
  });
  assert.equal(getCompactSummary("k-exp", now), null);
});

test("findPrefixSummary: 命中严格前缀,取覆盖最多的一条", () => {
  fresh();
  putCompactSummary({ coveredCount: 2, key: "k2", messageHashes: ["a", "b"], sessionId: "s1", summary: "two" });
  putCompactSummary({ coveredCount: 3, key: "k3", messageHashes: ["a", "b", "c"], sessionId: "s1", summary: "three" });

  const found = findPrefixSummary("s1", ["a", "b", "c", "d"]);
  assert.ok(found);
  assert.equal(found.matchedCount, 3);
  assert.equal(found.entry.summary, "three");
});

test("findPrefixSummary: 非前缀(内容不符) → null", () => {
  fresh();
  putCompactSummary({ coveredCount: 2, key: "k2", messageHashes: ["a", "X"], sessionId: "s1", summary: "two" });
  assert.equal(findPrefixSummary("s1", ["a", "b", "c"]), null);
});

test("findPrefixSummary: 等长 → 命中(压缩器就地改写场景)", () => {
  fresh();
  putCompactSummary({ coveredCount: 3, key: "k3", messageHashes: ["a", "b", "c"], sessionId: "s1", summary: "three" });
  const found = findPrefixSummary("s1", ["a", "b", "c"]);
  assert.ok(found);
  assert.equal(found.matchedCount, 3);
  assert.equal(found.entry.summary, "three");
});

test("findPrefixSummary: 容差内近似前缀 → 命中(1/20 位不同 = 0.95)", () => {
  fresh();
  const stored = Array.from({ length: 20 }, (_, i) => `h${i}`);
  const current = stored.slice();
  current[7] = "drifted";
  putCompactSummary({ coveredCount: 20, key: "k20", messageHashes: stored, sessionId: "s1", summary: "s" });

  const found = findPrefixSummary("s1", [...current, "tail"]);
  assert.ok(found);
  assert.equal(found.matchedCount, 20);
});

test("findPrefixSummary: 容差外(1/10 位不同 = 0.90) → null", () => {
  fresh();
  const stored = Array.from({ length: 10 }, (_, i) => `h${i}`);
  const current = stored.slice();
  current[4] = "drifted";
  putCompactSummary({ coveredCount: 10, key: "k10", messageHashes: stored, sessionId: "s1", summary: "s" });

  assert.equal(findPrefixSummary("s1", [...current, "tail"]), null);
});

test("findPrefixSummary: 存储前缀长于当前消息(非前缀) → null", () => {
  fresh();
  putCompactSummary({ coveredCount: 4, key: "k4", messageHashes: ["a", "b", "c", "d"], sessionId: "s1", summary: "s" });
  assert.equal(findPrefixSummary("s1", ["a", "b", "c"]), null);
});

test("findPrefixSummary: 跨会话隔离", () => {
  fresh();
  putCompactSummary({ coveredCount: 2, key: "k2", messageHashes: ["a", "b"], sessionId: "s1", summary: "one" });
  assert.equal(findPrefixSummary("s2", ["a", "b", "c"]), null);
});

test("cleanup: 丢掉过期与重复行,保留每 key 最后一行", () => {
  fresh();
  const now = Date.now();
  putCompactSummary({ coveredCount: 1, key: "keep", messageHashes: ["a"], sessionId: "s", summary: "v1" });
  putCompactSummary({ coveredCount: 1, key: "keep", messageHashes: ["a"], sessionId: "s", summary: "v2" });
  putCompactSummary({
    coveredCount: 1,
    expiresAt: now - 1,
    key: "drop",
    messageHashes: ["b"],
    sessionId: "s",
    summary: "stale"
  });
  const kept = cleanup(now);
  assert.equal(kept, 1);
  _resetIndexForTest();
  assert.equal(getCompactSummary("keep").summary, "v2");
  assert.equal(getCompactSummary("drop"), null);
  assert.equal(existsSync(path.join(cacheDir, "helix-compact", "summaries.jsonl")), true);
});
