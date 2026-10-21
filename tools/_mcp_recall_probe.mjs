/**
 * 通过 stdio 驱动**生产 MCP 召回服务** helix-recall-mcp.js（真实读取路径
 * = 带 MAX_LINE_READ_BYTES 预算的那条），对给定 hash 做 hc_recall / history_recall。
 *
 * ⚠️ 该服务用 **LSP 风格帧**（`Content-Length: N\r\n\r\n<json>`），
 *    不是行分隔 JSON —— 用换行分隔的客户端会静默超时。
 *
 * 用法: node tools/_mcp_recall_probe.mjs <mcpBundle> <cacheDir> <tool> <hash> [...]
 * 输出: 每行一个 JSON
 */
import { spawn } from "node:child_process";
import path from "node:path";

const [, , mcpBundle, cacheDir, tool, ...hashes] = process.argv;
if (!mcpBundle || !cacheDir || !tool || hashes.length === 0) {
  throw new Error("usage: _mcp_recall_probe.mjs <mcpBundle> <cacheDir> <tool> <hash...>");
}

const child = spawn(process.execPath, [path.resolve(mcpBundle)], {
  env: { ...process.env, HELIX_RECALL_CACHE_DIR: cacheDir },
  stdio: ["pipe", "pipe", "pipe"]
});

let buf = Buffer.alloc(0);
let stderr = "";
child.stdout.on("data", (d) => { buf = Buffer.concat([buf, d]); });
child.stderr.on("data", (d) => { stderr += d; });

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}

function drain() {
  const out = [];
  for (;;) {
    const sep = buf.indexOf("\r\n\r\n");
    if (sep < 0) break;
    const m = buf.subarray(0, sep).toString("utf8").match(/content-length:\s*(\d+)/i);
    if (!m) { buf = buf.subarray(sep + 4); continue; }
    const len = Number(m[1]);
    const start = sep + 4;
    if (buf.length < start + len) break;
    const text = buf.subarray(start, start + len).toString("utf8");
    buf = buf.subarray(start + len);
    try { out.push(JSON.parse(text)); } catch { /* 忽略坏帧 */ }
  }
  return out;
}

const waitFor = (predicate, timeoutMs = 60_000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const found = drain().find(predicate);
      if (found) return resolve(found);
      if (Date.now() - t0 > timeoutMs) {
        return reject(new Error(`timeout; stderr=${stderr.slice(0, 400)}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });

try {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await waitFor((m) => m.id === 1);

  let id = 2;
  for (const hash of hashes) {
    const reqId = id++;
    send({
      jsonrpc: "2.0", id: reqId, method: "tools/call",
      params: { name: tool, arguments: { hash_id: hash } }
    });
    const res = await waitFor((m) => m.id === reqId);
    const content = res?.result?.content ?? [];
    const text = content.find((c) => c?.type === "text")?.text ?? "";
    // 真实响应形状：{"results":[{"hash_id","source","q","a"}]}
    // 未命中：{"results":[{"error":"not_found","hash_id"}]}
    let entry = null;
    try { entry = JSON.parse(text)?.results?.[0] ?? null; } catch { /* 保留原文本 */ }
    console.log(JSON.stringify({
      hash,
      found: Boolean(entry) && !entry.error,
      error: entry?.error ?? null,
      source: entry?.source ?? null,
      qLen: typeof entry?.q === "string" ? entry.q.length : null,
      aLen: typeof entry?.a === "string" ? entry.a.length : null,
      hasImageBlock: content.some((c) => c?.type === "image")
    }));
  }
} finally {
  child.kill();
}
