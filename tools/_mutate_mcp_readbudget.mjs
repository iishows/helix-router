/**
 * 变异 helix-recall-mcp.js 的**读取预算**（唯一真源 MAX_ENTRY_BYTES），
 * 用于在**真实读路径**上做修复2的正/反对照。
 * 用法: node tools/_mutate_mcp_readbudget.mjs <inBundle> <outBundle> <mb>
 */
import fs from "node:fs";
const [, , inBundle, outBundle, mbArg] = process.argv;
const mb = Number(mbArg);
if (!inBundle || !outBundle || !Number.isFinite(mb)) {
  throw new Error("usage: _mutate_mcp_readbudget.mjs <in> <out> <mb>");
}
const src = fs.readFileSync(inBundle, "utf8");
const from = "E=20*1024*1024";
const count = src.split(from).length - 1;
if (count !== 1) throw new Error(`期望 ${from} 恰出现 1 次，实际 ${count}`);
fs.writeFileSync(outBundle, src.replace(from, `E=${mb}*1024*1024`));
console.log(`OK: ${from} -> E=${mb}*1024*1024  (${outBundle})`);
