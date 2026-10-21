import asar from "@electron/asar";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const p = "C:/Users/lenovo/AppData/Local/Programs/Helix Router/resources/app.asar";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const count = (b, needle) => {
  let c = 0;
  let i = 0;
  while ((i = b.indexOf(needle, i)) !== -1) {
    c += 1;
    i += needle.length;
  }
  return c;
};
const marks = (b) => ({
  "16e6": count(b, "16e6"),
  "20*1024*1024": count(b, "20*1024*1024"),
  "4*1024*1024": count(b, "4*1024*1024"),
  entryFitsBudget: count(b, "entryFitsBudget"),
});

for (const name of ["router-plugin.js", "next-ai-gateway.js", "helix-recall-mcp.js"]) {
  const repoPath = `packages/electron/dist/main/${name}`;
  const repo = fs.existsSync(repoPath) ? fs.readFileSync(repoPath) : null;
  // asar 内路径按 path.sep 切分，win32 下必须是反斜杠
  const inAsar = path.join("dist", "main", name);
  let data;
  try {
    data = asar.extractFile(p, inAsar);
  } catch (e) {
    console.log(`### ${name}: asar 提取失败 -> ${e.message}`);
    continue;
  }
  console.log(`### ${name}  asar=${data.length}B repo=${repo ? repo.length : "MISSING"}B`);
  console.log(`   asar sha=${sha(data).slice(0, 16)} ${JSON.stringify(marks(data))}`);
  if (repo) {
    console.log(`   repo sha=${sha(repo).slice(0, 16)} ${JSON.stringify(marks(repo))}`);
    console.log(`   => ${sha(data) === sha(repo) ? "*** IDENTICAL ***" : "DIFFER（安装包 ≠ 当前仓库产物）"}`);
  }
}
