/**
 * 变异测试：把第五批三处修复逐一回退，产出 3 个变异 bundle。
 * 期望：对应用例在变异体上 FAIL、在原版上 PASS → 证明用例真的锁定这些修复。
 *
 * 用法: node tools/_mutate_fifth_batch.mjs <inBundle> <outDir>
 */
import fs from "node:fs";
import path from "node:path";

const [, , inBundle, outDir] = process.argv;
const src = fs.readFileSync(inBundle, "utf8");
fs.mkdirSync(outDir, { recursive: true });

/** 每个变异：name / 期望被回退的行为 / 精确的目标串 → 替换串 */
const MUTATIONS = [
  {
    name: "M1-revert-fix1-media-parse",
    desc: "回退 19fee513：>1MB 的无条件放弃（去掉媒体头哨兵放行）",
    from: "n.length>zv&&(n.length>Ov||!Dv(n))",
    to: "n.length>zv"
  },
  {
    name: "M2-revert-fix2-read-budget",
    desc: "回退 50506513：读预算改回 8MB（< 9MB/15MB 条目 → 半截行）",
    // 读预算 = MAX_ENTRY_BYTES + 64KB；把 MAX_ENTRY_BYTES 从 20MB 改回 8MB
    from: "go=20*1024*1024",
    to: "go=8*1024*1024"
  },
  {
    name: "M3-revert-fix3-budget-gate",
    desc: "回退 45aa23ba：摘掉 entryFitsBudget 接线（闸失效）",
    from: "m=n.entryFitsBudget",
    to: "m=void 0"
  }
];

const report = [];
for (const m of MUTATIONS) {
  const count = src.split(m.from).length - 1;
  if (count !== 1) {
    report.push(`${m.name}: 目标串出现 ${count} 次（期望恰 1）→ 跳过，需人工核对`);
    continue;
  }
  const out = path.join(outDir, `${m.name}.js`);
  fs.writeFileSync(out, src.replace(m.from, m.to));
  report.push(`${m.name}: OK → ${out}  (${m.desc})`);
}
console.log(report.join("\n"));
