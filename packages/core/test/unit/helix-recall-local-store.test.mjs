/**
 * helix-recall-local-store (append-only JSONL) unit tests
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  configureCacheDir,
  putBatch,
  get,
  batchGet,
  cleanup,
  _resetIndexForTest,
  _clearCacheForTest
} from "@ccr/core/observability/helix-recall-local-store.ts";

function freshDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-recall-"));
  configureCacheDir(dir);
  _resetIndexForTest();
  return dir;
}

test("putBatch + get round-trips entries", () => {
  const dir = freshDir();
  try {
    const n = putBatch([
      ["aaa", { q: "Q1 text", a: "A1 text" }],
      ["bbb", { q: "Q2", a: "A2", blockOnly: true, kind: "media", qMedia: [{ type: "image" }] }]
    ]);
    assert.equal(n, 2);
    assert.deepEqual(get("aaa"), { q: "Q1 text", a: "A1 text" });
    const b = get("bbb");
    assert.equal(b.q, "Q2");
    assert.equal(b.kind, "media");
    assert.deepEqual(b.qMedia, [{ type: "image" }]);
    assert.equal(get("missing"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("same hash written twice → last wins (idempotent, content-addressed)", () => {
  const dir = freshDir();
  try {
    putBatch([["h1", { q: "old", a: "" }]]);
    putBatch([["h1", { q: "new", a: "" }]]);
    assert.equal(get("h1").q, "new");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("batchGet returns only hits", () => {
  const dir = freshDir();
  try {
    putBatch([["x", { q: "X", a: "" }], ["y", { q: "Y", a: "" }]]);
    const r = batchGet(["x", "z", "y"]);
    assert.deepEqual(Object.keys(r).sort(), ["x", "y"]);
    assert.equal(r.x.q, "X");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expired entries are not returned", () => {
  const dir = freshDir();
  try {
    putBatch([["exp", { q: "gone", a: "" }]], -1); // already expired
    assert.equal(get("exp"), null);
    assert.deepEqual(batchGet(["exp"]), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("half-written trailing line (no newline) is ignored until completed", () => {
  const dir = freshDir();
  try {
    const file = path.join(dir, "cache.jsonl");
    const exp = Date.now() + 100000;
    // simulate a writer mid-flush: complete line + partial line (no trailing newline)
    writeFileSync(
      file,
      JSON.stringify({ h: "done", c: { q: "ok", a: "" }, t: 1, e: exp }) + "\n" +
        '{"h":"partial","c":{"q":"half"',
      "utf-8"
    );
    _resetIndexForTest();
    assert.equal(get("done").q, "ok");
    assert.equal(get("partial"), null); // half line ignored
    // complete the line
    appendFileSync(file, `,"a":""},"t":1,"e":${exp}}\n`, "utf-8");
    _resetIndexForTest();
    assert.equal(get("partial").q, "half");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("index picks up appended lines after reset (incremental rescan)", () => {
  const dir = freshDir();
  try {
    putBatch([["a", { q: "1", a: "" }]]);
    assert.equal(get("a").q, "1");
    putBatch([["b", { q: "2", a: "" }]]);
    assert.equal(get("b").q, "2"); // new line visible without manual reset
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup removes expired and rewrites compacted file", () => {
  const dir = freshDir();
  try {
    putBatch([["keep", { q: "keep", a: "" }]]);
    putBatch([["drop", { q: "drop", a: "" }]], -1); // expired
    const kept = cleanup();
    assert.equal(kept, 1);
    assert.equal(get("keep").q, "keep");
    assert.equal(get("drop"), null);
    // file should now be one line
    const lines = readFileSync(path.join(dir, "cache.jsonl"), "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveCacheDir throws when env not set", () => {
  const saved = process.env.HELIX_RECALL_CACHE_DIR;
  delete process.env.HELIX_RECALL_CACHE_DIR;
  try {
    assert.throws(() => get("x"), /HELIX_RECALL_CACHE_DIR/);
  } finally {
    if (saved !== undefined) process.env.HELIX_RECALL_CACHE_DIR = saved;
  }
});

test("empty putBatch is a no-op", () => {
  const dir = freshDir();
  try {
    assert.equal(putBatch([]), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
