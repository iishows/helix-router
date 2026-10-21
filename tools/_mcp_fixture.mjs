/**
 * 建一个探针缓存目录，条目 hash 用明文（合法 16-hex），便于跨语言比对。
 * 用法: node tools/_mcp_fixture.mjs <dir> <mb1,mb2,...>
 */
import { mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";

const [, , dir, sizesArg] = process.argv;
if (!dir || !sizesArg) throw new Error("usage: _mcp_fixture.mjs <dir> <mb1,mb2,...>");

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const h = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const now = Date.now();
const exp = now + 3 * 24 * 60 * 60 * 1000;

const hashes = {};
let out = "";
for (const mbStr of sizesArg.split(",")) {
  const mb = Number(mbStr);
  const name = `probe${mb}mb`;
  const hash = h(name);
  hashes[name] = hash;
  const data = "A".repeat(mb * 1024 * 1024);
  out += JSON.stringify({
    h: hash,
    c: { q: "Q", a: "A", kind: "media", qMedia: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }] },
    t: now, e: exp
  }) + "\n";
}
const file = join(dir, "cache.jsonl");
writeFileSync(file, out, "utf8");
console.log(JSON.stringify({ file, bytes: statSync(file).size, hashes }));
