/**
 * 独立验收 harness（第五批：19fee513 / 50506513 / 45aa23ba）
 *
 * 原则（按用户既有要求）：
 *   - 不引用作者自报数字，全部本脚本现算
 *   - 正对照：先证明管线真的跑了（否则用例是空过）
 *   - 驱动**生产产物** packages/electron/dist/main/router-plugin.js
 *     （与已安装 app.asar 内那份逐字节相同），走真实 requestTransforms 接线，
 *     不手动注入 entryFitsBudget
 *   - 变异测试由外部驱动：本脚本换 bundle 即为变异（见报告命令）
 *
 * 用法: node --max-old-space-size=8192 tools/_verify_fifth_batch.mjs [<bundlePath>]
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUNDLE = process.argv[2]
  ? (path.isAbsolute(process.argv[2]) ? process.argv[2] : join(ROOT, process.argv[2]))
  : join(ROOT, "packages/electron/dist/main/router-plugin.js");
// 召回读路径是**独立的轻量 bundle**（自带 store 副本，带 MAX_LINE_READ_BYTES 预算）。
// 必须经它读回才能验证「写得进必读得回」；用 readFileSync 自读会绕过预算。
const MCP_BUNDLE = process.argv[3]
  ? (path.isAbsolute(process.argv[3]) ? process.argv[3] : join(ROOT, process.argv[3]))
  : join(ROOT, "packages/electron/dist/main/helix-recall-mcp.js");

const CACHE_DIR = mkdtempSync(join(tmpdir(), "hc-verify5-"));
process.env.HELIX_RECALL_CACHE_DIR = CACHE_DIR;
process.env.CCR_HELIX_PREPROCESS = "off";
process.env.CCR_HELIX_SKILLS_COMPACT = "off";
const CACHE_FILE = join(CACHE_DIR, "cache.jsonl");

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ── appConfig 取线上真实 config.sqlite（最贴生产），只覆盖本次要控的 helix 旋钮 ──
const { DatabaseSync } = require("node:sqlite");
const CONFIG_DB = join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? "", "AppData/Roaming"),
  "claude-code-router", "config.sqlite"
);
const appConfig = structuredClone(
  JSON.parse(new DatabaseSync(CONFIG_DB).prepare("select value_json from app_config where key='default'").get().value_json)
);
appConfig.plugins = (appConfig.plugins ?? []).filter((p) => p.id !== "helix-compressor");
appConfig.plugins.push({
  id: "helix-compressor", enabled: true,
  config: { compressMedia: true, storeWithMedia: true, blockThresholdChars: 0, compressToolResults: true, keepRecentPairs: 1 }
});

const bundleStat = statSync(BUNDLE);
const plugin = await require(BUNDLE).createGatewayPlugin({ plugin: { config: { appConfig } } });
const helixTransform = plugin.requestTransforms.find((t) => t.key === "helix-compressor-request-transform");
if (!helixTransform) throw new Error("生产产物里找不到 helix transform —— 接线缺失");
console.log(`bundle      = ${BUNDLE}`);
console.log(`bundle sha  = ${crypto.createHash("sha256").update(readFileSync(BUNDLE)).digest("hex").slice(0, 32)}`);
console.log(`bundle mtime= ${bundleStat.mtime.toISOString()}`);
console.log(`cache dir   = ${CACHE_DIR}\n`);

const CTX = {
  logger: { warn() {}, info() {}, error() {}, debug() {} },
  pluginConfig: {}, pluginId: "helix-compressor",
  openSqliteStore: async () => { throw new Error("unused"); }
};
const MODEL = "MiniMax-M2.7";

// 生产接线读 requestBody（见 router-plugin.ts applyHelixCompressorTransform 首行）
function callTransform(messages, requestId = "verify5") {
  return helixTransform.transform({
    requestBody: { model: MODEL, messages },
    request: { headers: {}, id: requestId, method: "POST", url: "/v1/messages" },
    route: { method: "POST", url: "/v1/messages" },
    model: MODEL,
    sourceAdapterKey: "anthropic"
  }, CTX);
}

// ── 缓存读回：一次性建索引（按文件 size+mtime 失效），避免 O(n²) ──────────────
let idxKey = "";
let idx = new Map();
function ensureIndex() {
  if (!existsSync(CACHE_FILE)) { idx = new Map(); return; }
  const st = statSync(CACHE_FILE);
  const key = `${st.size}:${st.mtimeMs}`;
  if (key === idxKey) return;
  idx = new Map();
  for (const line of readFileSync(CACHE_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj && typeof obj.h === "string") idx.set(obj.h, obj.c);
  }
  idxKey = key;
}
const storeGet = (hash) => { ensureIndex(); return idx.get(hash) ?? null; };

// ── 真实读路径（生产 MCP bundle，带读取预算）────────────────────────────────
// 关键：f2 组必须走这条，否则「写得进读不回」永远测不出来（自读无预算）。
import { execFileSync } from "node:child_process";
function mcpRecall(hashes) {
  if (hashes.length === 0) return new Map();
  const out = execFileSync(
    process.execPath,
    [join(ROOT, "tools", "_mcp_recall_probe.mjs"), MCP_BUNDLE, CACHE_DIR, "hc_recall", ...hashes],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const m = new Map();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    m.set(r.hash, r.found);
  }
  return m;
}

const PLACEHOLDER_RE = /⟦(?:HC|QA):([0-9a-f]{16})⟧/g;
const DOC_EXAMPLE_HASH = "abc123def4567890"; // 注入 system 的教学示例，不是真占位符
const placeholdersIn = (text) =>
  [...String(text).matchAll(PLACEHOLDER_RE)].map((m) => m[1]).filter((h) => h !== DOC_EXAMPLE_HASH);

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/**
 * 确定性「多样」base64 —— 真实图片 base64 字符分布均匀。
 * 不能用 `'A'.repeat(n)`：那是 BPE 的病态输入（'A'×200KB 要 ~40s，
 * 而同等长度的真实 base64 只要 ~1.2s/1.2MB），会把 harness 拖成小时级。
 * 用 LCG 保证可复现（同输入 → 同 hash）。
 */
function b64(n) {
  let out = "";
  let s = 0x2545f491;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out += B64_ALPHABET[s >>> 26];
  }
  return out;
}
/** OpenAI 形状：role:"tool", content = 块数组的 JSON 字符串（真实形态）。 */
const mediaToolResultString = (payloadChars) => JSON.stringify([
  { type: "text", text: "screenshot captured" },
  { type: "image", source: { type: "base64", media_type: "image/png", data: b64(payloadChars) } }
]);
/** 4 消息形状：给 pair 压缩留候选（末轮提问受保护）。 */
const messagesWith = (toolContent) => [
  { role: "user", content: "please read the logs" },
  { role: "assistant", content: "running command" },
  { role: "tool", tool_call_id: "call_1", content: toolContent },
  { role: "user", content: "what did you find in the file" },
  { role: "assistant", content: "here is the summary" }
];
/** pair 形状：CJK 条目走 pair 压缩通道（qText+aText ≥ minChars×2 才入选）。 */
const pairMessagesWith = (longText) => [
  { role: "user", content: longText },
  { role: "assistant", content: "answer one" },
  { role: "user", content: "small follow up" },
  { role: "assistant", content: "answer two" }
];

async function probe(label, toolContent, id) {
  const r = await callTransform(messagesWith(toolContent), id);
  const body = JSON.stringify(r?.requestBody ?? null);
  const ph = placeholdersIn(body);
  const entries = ph.map((h) => storeGet(h));
  return {
    body,
    ph,
    readable: ph.filter((h) => storeGet(h)),
    entry: entries.find(Boolean) ?? null
  };
}
/** 直接给定 messages（pair 形状用）。 */
async function probeMessages(messages, id) {
  const r = await callTransform(messages, id);
  const body = JSON.stringify(r?.requestBody ?? null);
  const ph = placeholdersIn(body);
  return { body, ph, readable: ph.filter((h) => storeGet(h)) };
}
const entryHasImage = (e) =>
  Array.isArray(e?.qMedia) && e.qMedia.some((b) => b?.type === "image");
const entryImageBytes = (e) =>
  e?.qMedia?.find((b) => b?.type === "image")?.source?.data?.length ?? -1;

// ═══════════ 修复 1（19fee513）：1MB 通用解析上限误杀大媒体容器 ═══════════
console.log("── 修复 1：大媒体容器解析 ──");
{
  const SMALL = mediaToolResultString(50_000);      // 容器 ~50KB  < 1MB
  const BIG = mediaToolResultString(1_200_000);     // 容器 ~1.2MB > 1MB（核心）
  const HUGE = mediaToolResultString(17_000_000);   // 容器 ~17MB  > 16MB 硬顶
  const NONMEDIA = JSON.stringify(
    Array.from({ length: 60_000 }, (_, i) => ({ type: "record", i, pad: "x".repeat(30) }))
  );
  console.log(`  容器字符数: small=${SMALL.length} big=${BIG.length} huge=${HUGE.length} nonmedia=${NONMEDIA.length}`);

  const small = await probe("small", SMALL, "f1-small");
  record("f1 正对照 | 50KB 媒体容器 → 占位符可召回且携带 image 块",
    small.ph.length > 0 && small.readable.length === small.ph.length && entryHasImage(small.entry),
    `占位符=${small.ph.length} 可召回=${small.readable.length} hasImage=${entryHasImage(small.entry)} kind=${small.entry?.kind}`);

  const big = await probe("big", BIG, "f1-big");
  record("f1 核心 | >1MB 媒体容器仍进入媒体通道（可召回 + 真实 image 块）",
    big.ph.length > 0 && big.readable.length === big.ph.length && entryHasImage(big.entry),
    `占位符=${big.ph.length} 可召回=${big.readable.length} hasImage=${entryHasImage(big.entry)} kind=${big.entry?.kind}`);
  record("f1 核心 | 媒体 payload 字节完整（未被截断）",
    entryImageBytes(big.entry) === 1_200_000,
    `读回=${entryImageBytes(big.entry)} 期望=1200000`);

  const huge = await probe("huge", HUGE, "f1-huge");
  record("f1 边界 | >16MB 放弃解析且不留孤儿占位符",
    huge.ph.every((h) => storeGet(h)),
    `占位符=${huge.ph.length} 孤儿=${huge.ph.filter((h) => !storeGet(h)).length}`);

  const nonmedia = await probe("nonmedia", NONMEDIA, "f1-nonmedia");
  const kept = nonmedia.body.includes("record") && !nonmedia.ph.some((h) => storeGet(h));
  record("f1 反向 | >1MB 非媒体大数组未被媒体放行（OOM 防护不收窄）",
    kept && !entryHasImage(nonmedia.entry),
    `原文保留=${nonmedia.body.includes("record")} 有image块=${entryHasImage(nonmedia.entry)}`);
}

// ═══════════ 修复 2（50506513）：读预算 < 写入尺寸 → 写得进读不回 ═══════════
console.log("\n── 修复 2：多 MB 媒体条目往返（真实 MCP 读路径，旧 8MB 预算会 not_found） ──");
{
  const cases = [6, 9, 15];
  const observed = [];
  for (const mb of cases) {
    const payload = mb * 1024 * 1024;
    const r = await probe(`fix2-${mb}mb`, mediaToolResultString(payload), `f2-${mb}`);
    const viaMcp = mcpRecall(r.ph);
    const bytes = entryImageBytes(r.entry);
    observed.push({ mb, ph: r.ph.length, mcpOk: [...viaMcp.values()].filter(Boolean).length, bytes, payload });
    // 「写得进」：必须有占位符（= 条目已被 putBatch 接受）
    const written = r.ph.length > 0;
    // 「读得回」：同 hash 经**真实读路径**能取回，且写入侧确实存了完整字节
    const readable = written && r.ph.every((h) => viaMcp.get(h) === true);
    const intact = bytes === payload;
    record(`f2 | ${mb}MB 条目：写入成功且经真实读路径读回（字节完整）`,
      written && readable && intact,
      `占位符=${r.ph.length} MCP读回=${[...viaMcp.values()].filter(Boolean).length}/${r.ph.length} 写入侧字节=${bytes} 期望=${payload}`);
  }
  globalThis.__f2observed = observed;
}

// ═══════════ 修复 3（45aa23ba）：字节预算闸前置（CJK 多字节） ═══════════
console.log("\n── 修复 3：字节闸前置（CJK，1 字符 ≈ 3 字节） ──");
{
  const OVER = "中".repeat(7_000_000);   // ≈21MB 字节 > 20MB 闸
  const UNDER = "中".repeat(2_000);
  console.log(`  OVER 字符=${OVER.length} 字节=${Buffer.byteLength(OVER, "utf8")}（字符串上限 20MB）`);

  record("f3 前置 | fixture 真的越过 20MB 字节闸（否则本组是空测）",
    Buffer.byteLength(OVER, "utf8") > 20 * 1024 * 1024,
    `bytes=${Buffer.byteLength(OVER, "utf8")}`);

  const over = await probeMessages(pairMessagesWith(OVER), "f3-over");
  record("f3 核心 | 超字节预算 → 零孤儿占位符",
    over.ph.every((h) => storeGet(h)),
    `占位符=${over.ph.length} 孤儿=${over.ph.filter((h) => !storeGet(h)).length}`);
  record("f3 核心 | 超预算原文逐字保留（证明是闸否决，非整体跳过）",
    over.body.includes("中中中"),
    `原文保留=${over.body.includes("中中中")}`);

  const under = await probeMessages(pairMessagesWith(UNDER), "f3-under");
  record("f3 正对照 | 预算内 CJK 条目 → 占位符且可召回",
    under.ph.length > 0 && under.ph.every((h) => storeGet(h)),
    `占位符=${under.ph.length} 可召回=${under.ph.filter((h) => storeGet(h)).length}`);
}

// ═══════════ 全局不变式 ═══════════
{
  const ok = existsSync(CACHE_FILE) && statSync(CACHE_FILE).size > 0;
  record("全局 | 召回缓存已落盘（内容寻址 JSONL）", ok, `size=${ok ? statSync(CACHE_FILE).size : 0}`);
}

console.log("\n──── 汇总 ────");
const pass = results.filter((r) => r.pass).length;
console.log(`${pass}/${results.length} 通过`);
for (const r of results.filter((x) => !x.pass)) console.log(`  FAIL: ${r.name} — ${r.detail}`);
rmSync(CACHE_DIR, { recursive: true, force: true });
process.exit(pass === results.length ? 0 : 1);
