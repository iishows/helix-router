/**
 * 生产路径端到端：经真实 HTTP :3456 发请求，验证第五批三项修复在
 * **运行中的网关进程**里生效（而不是只在我的进程内直接调 transform）。
 *
 * 观测点全部是进程外的、可独立复核的产物：
 *   ① 真实召回库 {DATADIR}/helix-recall/cache.jsonl 新增行
 *   ② {HOME}/.helix-router/logs/compression-stats.jsonl 的 pre/post/saved_pct
 *
 * 用法: node tools/_verify_fifth_batch_prod.mjs <apiKey> [bigMediaMB]
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";

const KEY = process.argv[2];
const BIG_MB = Number(process.argv[3] ?? 1.2);
if (!KEY) throw new Error("usage: node _verify_fifth_batch_prod.mjs <apiKey> [bigMediaMB]");

const ROOT = join(process.env.APPDATA, "claude-code-router");
const CACHE = join(ROOT, "helix-recall", "cache.jsonl");
const STATS = join(process.env.USERPROFILE, ".helix-router", "logs", "compression-stats.jsonl");

const BASE = "http://127.0.0.1:3456/v1/messages";
const MODEL = "autodl-3/DeepSeek-V4.1-Flash";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64(n) {
  let out = "";
  let s = 0x9e3779b9;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; out += B64[s >>> 26]; }
  return out;
}

const size = (p) => (existsSync(p) ? statSync(p).size : 0);
const lines = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : []);

/** 带上足够长的历史，触发压缩；最后一条是当期提问（受保护）。 */
function body(mediaData) {
  const msgs = [];
  for (let i = 0; i < 4; i++) {
    msgs.push({ role: "user", content: `history question ${i} ` + "调研内容".repeat(400) });
    msgs.push({ role: "assistant", content: `history answer ${i} ` + "分析结论".repeat(400) });
  }
  msgs.push({
    role: "user",
    content: [
      { type: "text", text: "here is the screenshot, please summarize the build log" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: mediaData } }
    ]
  });
  msgs.push({ role: "assistant", content: "ok" });
  msgs.push({ role: "user", content: "what did you find?" });
  return { model: MODEL, max_tokens: 24, messages: msgs };
}

async function send(label, mediaData) {
  const beforeCache = size(CACHE);
  const beforeStats = lines(STATS).length;
  const t0 = Date.now();
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body(mediaData))
  });
  const text = await res.text();
  const ms = Date.now() - t0;
  return { label, status: res.status, ms, bodyHead: text.slice(0, 200), cacheGrowth: size(CACHE) - beforeCache, statsAdded: lines(STATS).length - beforeStats };
}

// ── 会话开始前先记录基线 ──
const startCacheSize = size(CACHE);
const startCacheLines = lines(CACHE).length;
const startStatsLines = lines(STATS).length;
console.log(`基线: cache.jsonl ${startCacheSize} bytes / ${startCacheLines} 行`);
console.log(`      compression-stats.jsonl ${startStatsLines} 行\n`);

const SMALL = b64(50_000);
const BIG = b64(Math.round(BIG_MB * 1024 * 1024));
console.log(`payload: small=${SMALL.length}  big=${BIG.length} (${BIG_MB}MB)\n`);

const r1 = await send("small-50KB", SMALL);
console.log(`[small] http=${r1.status} ${r1.ms}ms cache+${r1.cacheGrowth}B`);
console.log(`        ${r1.bodyHead.replace(/\s+/g, " ").slice(0, 160)}`);

const r2 = await send(`big-${BIG_MB}MB`, BIG);
console.log(`[big]   http=${r2.status} ${r2.ms}ms cache+${r2.cacheGrowth}B`);
console.log(`        ${r2.bodyHead.replace(/\s+/g, " ").slice(0, 160)}`);

// ── 判定：新增缓存条目里能否找到本次的媒体条目，且字节完整 ──
const after = lines(CACHE);
const delta = after.slice(startCacheLines);
console.log(`\n本次新增召回条目: ${delta.length} 行`);
let mediaEntries = 0, maxMediaBytes = 0, kinds = {};
for (const l of delta) {
  let o; try { o = JSON.parse(l); } catch { continue; }
  const c = o.c ?? {};
  kinds[c.kind ?? "(none)"] = (kinds[c.kind ?? "(none)"] ?? 0) + 1;
  const imgs = Array.isArray(c.qMedia) ? c.qMedia : [];
  for (const b of imgs) {
    if (b?.type === "image") {
      mediaEntries++;
      const blen = b?.source?.data?.length ?? b?.data?.length ?? 0;
      maxMediaBytes = Math.max(maxMediaBytes, blen);
    }
  }
}
console.log(`  条目 kind 分布: ${JSON.stringify(kinds)}`);
console.log(`  含 image 块的条目: ${mediaEntries}，最大图片字节: ${maxMediaBytes}`);

const newStats = lines(STATS).slice(startStatsLines).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
console.log(`\n本次新增压缩统计: ${newStats.length} 条`);
for (const s of newStats) {
  console.log(`  model=${s.model} pre=${s.pre_tokens} post=${s.post_tokens} saved=${s.saved_pct}% qa=${s.qa_compressed} scenario=${s.scenario}${s.compact ? ` compact=${s.compact.source}` : ""}`);
}

// ── 结论 ──
const ok =
  r1.status === 200 && r2.status === 200 &&
  mediaEntries > 0 &&
  maxMediaBytes >= BIG.length;
console.log(`\n${ok ? "PASS" : "FAIL"}  生产路径: 大媒体条目经真实 :3456 写入召回库且字节完整`);
console.log(`  依据: http=${r1.status}/${r2.status} 媒体条目=${mediaEntries} 最大字节=${maxMediaBytes} 期望≥${BIG.length}`);
process.exit(ok ? 0 : 1);
