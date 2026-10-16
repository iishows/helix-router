import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const runtimeEntry = () => path.join(process.cwd(), ".test-dist", "core", "runtime", "helix-recall-mcp.js");

async function withCacheDir(t, lines) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "helix-recall-mcp-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  await writeFile(path.join(dir, "cache.jsonl"), lines.join("\n") + "\n", "utf-8");
  return dir;
}

function spawnServer(t, cacheDir) {
  const child = spawn(process.execPath, [runtimeEntry()], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      HELIX_RECALL_CACHE_DIR: cacheDir
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(() => {
    if (!child.killed) {
      child.kill();
    }
  });
  return child;
}

function entry(hash, content) {
  const expiresAt = Date.now() + 60 * 60 * 1000;
  return JSON.stringify({ h: hash, c: content, t: 1, e: expiresAt });
}

test("helix recall MCP lists hc_recall and history_recall tools", async (t) => {
  const dir = await withCacheDir(t, [entry("aaaaaaaaaaaaaaaa", { q: "Q", a: "A" })]);
  const child = spawnServer(t, dir);
  const response = await sendJsonRpc(child, { id: 1, jsonrpc: "2.0", method: "tools/list" });
  assert.equal(response.error, undefined);
  assert.deepEqual(
    response.result.tools.map((tool) => tool.name).sort(),
    ["hc_recall", "history_recall"]
  );
});

test("helix recall MCP returns the original content for a cache hit", async (t) => {
  const dir = await withCacheDir(t, [
    entry("aaaaaaaaaaaaaaaa", { q: "original question", a: "original answer" })
  ]);
  const child = spawnServer(t, dir);
  const response = await sendJsonRpc(child, {
    id: 1,
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      arguments: { calls: [{ hash_id: "aaaaaaaaaaaaaaaa", reason: "need it" }] },
      name: "history_recall"
    }
  });

  assert.equal(response.error, undefined);
  assert.equal(response.result?.isError, undefined);
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0].hash_id, "aaaaaaaaaaaaaaaa");
  assert.equal(payload.results[0].source, "pair");
  assert.equal(payload.results[0].q, "original question");
  assert.equal(payload.results[0].a, "original answer");
  assert.equal(payload.results[0].q_media, undefined);
});

test("helix recall MCP returns the folded tool output for a kind:tool_result entry", async (t) => {
  const dir = await withCacheDir(t, [
    entry("ffffffffffffffff", {
      a: "",
      blockIdx: 1,
      blockOnly: true,
      kind: "tool_result",
      msgIdx: 3,
      q: "file content that was folded away"
    })
  ]);
  const child = spawnServer(t, dir);
  const response = await sendJsonRpc(child, {
    id: 1,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: { calls: [{ hash_id: "ffffffffffffffff" }] }, name: "history_recall" }
  });

  assert.equal(response.error, undefined);
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.results[0].source, "block");
  assert.equal(payload.results[0].q, "file content that was folded away");
  assert.equal(payload.results[0].a, "");
});

test("helix recall MCP returns not_found for a cache miss", async (t) => {
  const dir = await withCacheDir(t, [entry("aaaaaaaaaaaaaaaa", { q: "Q", a: "A" })]);
  const child = spawnServer(t, dir);
  const response = await sendJsonRpc(child, {
    id: 1,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: { calls: [{ hash_id: "bbbbbbbbbbbbbbbb" }] }, name: "hc_recall" }
  });

  assert.equal(response.error, undefined);
  const payload = JSON.parse(response.result.content[0].text);
  assert.deepEqual(payload.results[0], { error: "not_found", hash_id: "bbbbbbbbbbbbbbbb" });
});

test("helix recall MCP returns a real image content block only when with_media is true", async (t) => {
  const dir = await withCacheDir(t, [
    entry("cccccccccccccccc", {
      q: "[media block: image image/png, 4 bytes]",
      a: "",
      blockOnly: true,
      kind: "media",
      qMedia: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }]
    })
  ]);

  const childTextOnly = spawnServer(t, dir);
  const withoutMedia = await sendJsonRpc(childTextOnly, {
    id: 1,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: { calls: [{ hash_id: "cccccccccccccccc" }] }, name: "history_recall" }
  });
  // with_media=false:不应出现 image 内容块
  assert.equal(withoutMedia.result.content.every((c) => c.type !== "image"), true);
  const textPayload = JSON.parse(withoutMedia.result.content[0].text);
  assert.equal(textPayload.results[0].source, "block");
  assert.equal(textPayload.results[0].q, "[media block: image image/png, 4 bytes]");

  const childWithMedia = spawnServer(t, dir);
  const withMedia = await sendJsonRpc(childWithMedia, {
    id: 1,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: { calls: [{ hash_id: "cccccccccccccccc", with_media: true }] }, name: "history_recall" }
  });
  // with_media=true:追加真实 image 内容块(MCP 规范形状),不再把 base64 当文本
  const imageBlocks = withMedia.result.content.filter((c) => c.type === "image");
  assert.deepEqual(imageBlocks, [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
  const mediaPayload = JSON.parse(withMedia.result.content.find((c) => c.type === "text").text);
  assert.equal(mediaPayload.results[0].q_media, undefined);
});

test("helix recall MCP normalizes the pair-path qMedia shape {type,mime,data}", async (t) => {
  const dir = await withCacheDir(t, [
    entry("eeeeeeeeeeeeeeee", {
      q: "[media block: image image/jpeg, 8 bytes]",
      a: "",
      kind: "media",
      qMedia: [{ type: "image", mime: "image/jpeg", data: "BBBBBBBB" }]
    })
  ]);
  const child = spawnServer(t, dir);
  const response = await sendJsonRpc(child, {
    id: 1,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: { calls: [{ hash_id: "eeeeeeeeeeeeeeee", with_media: true }] }, name: "history_recall" }
  });
  const imageBlocks = response.result.content.filter((c) => c.type === "image");
  assert.deepEqual(imageBlocks, [{ type: "image", data: "BBBBBBBB", mimeType: "image/jpeg" }]);
});

// 2026-10-14 P2:LLM 实测按 helix transform 注入的 **扁平** client 工具 schema 调用
// (HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC 顶层是 hash_id,不是 {calls:[...]})。
// MCP handler 必须同时接受扁平单条与批量两种形态,否则网关透明执行会解析不到 hash → not_found。
test("helix recall MCP accepts the flat single-hash_id call form (LLM 实测形态)", async (t) => {
  const dir = await withCacheDir(t, [
    entry("dddddddddddddddd", { q: "flat question", a: "flat answer" })
  ]);
  const child = spawnServer(t, dir);
  const response = await sendJsonRpc(child, {
    id: 1,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: { hash_id: "dddddddddddddddd", reason: "flat" }, name: "history_recall" }
  });

  assert.equal(response.error, undefined);
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0].hash_id, "dddddddddddddddd");
  assert.equal(payload.results[0].q, "flat question");
  assert.equal(payload.results[0].a, "flat answer");
});

test("helix recall MCP reports not_found when the cache dir is not configured", async (t) => {
  const child = spawn(process.execPath, [runtimeEntry()], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", HELIX_RECALL_CACHE_DIR: "" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(() => {
    if (!child.killed) {
      child.kill();
    }
  });

  const response = await sendJsonRpc(child, {
    id: 1,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: { calls: [{ hash_id: "aaaaaaaaaaaaaaaa" }] }, name: "hc_recall" }
  });

  assert.equal(response.error, undefined);
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.results[0].error, "not_found");
});

function sendJsonRpc(child, payload) {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = "";
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const finish = (value) => {
      cleanup();
      resolve(value);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onStdout = (chunk) => {
      stdout = Buffer.concat([stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const parsed = readJsonRpcFrame(stdout);
      if (!parsed) {
        return;
      }
      finish(parsed.value);
    };
    const onStderr = (chunk) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    };
    const onExit = (code, signal) => {
      fail(new Error(`helix-recall MCP exited before response: code=${code ?? ""} signal=${signal ?? ""} stderr=${stderr}`));
    };
    const onError = (error) => fail(error);
    const timer = setTimeout(() => fail(new Error(`Timed out waiting for helix-recall MCP response. stderr=${stderr}`)), 5000);

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", onError);

    const message = Buffer.from(JSON.stringify(payload), "utf8");
    child.stdin.write(`Content-Length: ${message.byteLength}\r\n\r\n`);
    child.stdin.write(message);
  });
}

function readJsonRpcFrame(buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) {
    return undefined;
  }
  const header = buffer.subarray(0, headerEnd).toString("utf8");
  const match = header.match(/content-length:\s*(\d+)/i);
  if (!match) {
    throw new Error(`Missing Content-Length in MCP response: ${header}`);
  }
  const length = Number(match[1]);
  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd) {
    return undefined;
  }
  return {
    rest: buffer.subarray(bodyEnd),
    value: JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"))
  };
}
