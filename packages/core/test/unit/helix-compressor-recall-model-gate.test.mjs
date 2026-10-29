/**
 * helix-compressor 按模型门控 recall 压缩测试（2026-10-16）
 *
 * 目标：验证 `recallModelPatterns` / `recallModelExcludePatterns` 的语义，以及
 * transform 在模型未命中白名单时跳过本地占位符压缩、但仍保留安全预清理。
 *
 * 覆盖：
 *  - recallModelSupported: glob / 空=全部 / exclude / provider 前缀段 / 大小写不敏感
 *  - transform: 不在白名单 → 无 ⟦QA:⟧ / 无 model 改写 / 不写召回缓存；预清理仍生效
 *  - transform: 在白名单 → 有占位符 + 改写（回归保护）
 *  - transform: 空白名单 → 有占位符 + 改写（向后兼容）
 */

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  helixCompressorTransform,
  recallModelSupported
} from "@ccr/core/plugins/built-ins/helix-compressor.ts";
import { HELIX_RECALL_MODEL_PREFIX } from "@ccr/core/contracts/app.ts";
import {
  configureCacheDir,
  _clearCacheForTest,
  _resetIndexForTest
} from "@ccr/core/observability/helix-recall-local-store";

const TEST_MODEL = "MiniMax-M3";
const CACHE_DIR = mkdtempSync(join(tmpdir(), "helix-recall-model-gate-"));
configureCacheDir(CACHE_DIR);

/** 读本地召回缓存文件的行数(文件不存在 = 0 行)。 */
function recallCacheLineCount() {
  const file = join(CACHE_DIR, "cache.jsonl");
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8").split("\n").filter(Boolean).length;
}

/** 一段足够长、会被本地压缩成 ⟦QA:hash⟧ 的历史（每条 ≥500 字符，合并 ≥1000）。 */
const LONG_HISTORY = [
  { role: "user", content: "A".repeat(600) },
  { role: "assistant", content: "B".repeat(600) },
  { role: "user", content: "final question" }
];

function mockContext(pluginConfig = {}, appConfig = {}) {
  return {
    config: appConfig,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    paths: { configDir: "", dataDir: "", pluginDataDir: "" },
    permissions: [],
    pluginConfig: { ...pluginConfig },
    pluginId: "helix-compressor",
    openSqliteStore: async () => { throw new Error("not implemented"); }
  };
}

function runTransform(model, pluginConfig, appConfig) {
  return helixCompressorTransform(
    {
      body: { model, messages: LONG_HISTORY },
      headers: {},
      method: "POST",
      path: "/v1/messages",
      requestId: `gate-${model}`,
      routedModel: model,
      url: "/v1/messages"
    },
    mockContext(pluginConfig, appConfig)
  );
}

function bodyHasPlaceholder(body) {
  return JSON.stringify(body.messages ?? []).includes("⟦QA:");
}

beforeEach(() => {
  _clearCacheForTest();
  _resetIndexForTest();
});

// ============== recallModelSupported ==============

test("recallModelSupported: 空/未配白名单 → 支持全部", () => {
  assert.equal(recallModelSupported("MiniMax-M3", {}), true);
  assert.equal(recallModelSupported("MiniMax-M3", { recallModelPatterns: [] }), true);
  assert.equal(recallModelSupported("anything", { recallModelPatterns: [] }), true);
});

test("recallModelSupported: glob 通配（前缀 / 后缀 / 通配全部）", () => {
  assert.equal(recallModelSupported("MiniMax-M3", { recallModelPatterns: ["MiniMax-*"] }), true);
  assert.equal(recallModelSupported("MiniMax-M2.7", { recallModelPatterns: ["MiniMax-*"] }), true);
  assert.equal(recallModelSupported("claude-opus-5-5", { recallModelPatterns: ["*opus*"] }), true);
  assert.equal(recallModelSupported("MiniMax-M3", { recallModelPatterns: ["*"] }), true);
  assert.equal(recallModelSupported("gpt-5", { recallModelPatterns: ["MiniMax-*"] }), false);
});

test("recallModelSupported: 无通配即精确匹配", () => {
  assert.equal(recallModelSupported("MiniMax-M3", { recallModelPatterns: ["MiniMax-M3"] }), true);
  assert.equal(recallModelSupported("MiniMax-M3-extra", { recallModelPatterns: ["MiniMax-M3"] }), false);
});

test("recallModelSupported: provider 前缀段匹配", () => {
  const cfg = { recallModelPatterns: ["MiniMax-M3"] };
  assert.equal(recallModelSupported("MiniMax (China) 2/MiniMax-M3", cfg), true, "匹配末段");
  assert.equal(recallModelSupported("MiniMax (China) 2/Other", cfg), false);
});

test("recallModelSupported: 大小写不敏感", () => {
  assert.equal(recallModelSupported("minimax-m3", { recallModelPatterns: ["MiniMax-M3"] }), true);
  assert.equal(recallModelSupported("MiniMax-M3", { recallModelPatterns: ["minimax-m3"] }), true);
});

test("recallModelSupported: exclude 表在 include 之后收窄", () => {
  const cfg = {
    recallModelPatterns: ["MiniMax-*"],
    recallModelExcludePatterns: ["*M2.7"]
  };
  assert.equal(recallModelSupported("MiniMax-M3", cfg), true);
  assert.equal(recallModelSupported("MiniMax-M2.7", cfg), false);
});

test("recallModelSupported: 空白名单 + 非空 exclude → 全部支持但排除命中项", () => {
  const cfg = { recallModelExcludePatterns: ["MiniMax-*"] };
  assert.equal(recallModelSupported("gpt-5", cfg), true);
  assert.equal(recallModelSupported("MiniMax-M3", cfg), false);
});

test("recallModelSupported: recallModelDetected 区分「检测出空集」与「未配置」", () => {
  // 已检测 + 空白名单 = 真的没有模型支持(tool-calling 探测全失败),不回退「全部」。
  const detected = { recallModelDetected: true, recallModelPatterns: [] };
  assert.equal(recallModelSupported("MiniMax-M3", detected), false);
  assert.equal(recallModelSupported("gpt-5", detected), false);
  // 未检测 + 空白名单 = 向后兼容,全部纳入。
  assert.equal(recallModelSupported("MiniMax-M3", { recallModelDetected: false, recallModelPatterns: [] }), true);
  assert.equal(recallModelSupported("MiniMax-M3", {}), true);
  // 已检测 + 非空白名单 = 按精确/glob 匹配(检测 written 的精确名)。
  const detectedNonEmpty = { recallModelDetected: true, recallModelPatterns: ["MiniMax-M3"] };
  assert.equal(recallModelSupported("MiniMax-M3", detectedNonEmpty), true);
  assert.equal(recallModelSupported("gpt-5", detectedNonEmpty), false);
});

// ============== transform 门控 ==============

test("模型不在白名单 → 无占位符、无 model 改写、不写召回缓存，预清理仍生效", async () => {
  const body = {
    model: TEST_MODEL,
    // 一条 task-notification 死信 + 一条空消息,预清理应删除
    messages: [
      { role: "user", content: "<task-notification><retrieval_status>success</retrieval_status></task-notification>" },
      { role: "user", content: "" },
      ...LONG_HISTORY
    ]
  };
  const result = await helixCompressorTransform(
    {
      body,
      headers: {},
      method: "POST",
      path: "/v1/messages",
      requestId: "gate-skip",
      routedModel: TEST_MODEL,
      url: "/v1/messages"
    },
    mockContext({ recallModelPatterns: ["claude-*"] })
  );

  assert.ok(result, "transform 必须返回结果(透传)");
  assert.equal(result.routedModel, undefined, "不支持的模型不得改写 model");
  assert.equal(bodyHasPlaceholder(result.body), false, "不得产生 ⟦QA:⟧ 占位符");
  assert.equal(result.headers["x-helix-compressor-scenario"], "skip-recall");
  assert.equal(result.headers["x-helix-compressor-qa-compressed"], "0");

  // 预清理:死信 + 空消息被删除
  const roles = result.body.messages.map((m) => m.content);
  assert.equal(roles.some((c) => typeof c === "string" && c.includes("<task-notification>")), false, "死信应被预清理");
  assert.equal(roles.some((c) => c === ""), false, "空消息应被预清理");

  // 不写召回缓存:跳过后缓存文件应为空(无新行)
  assert.equal(recallCacheLineCount(), 0, "跳过的模型不得写召回缓存");
});

test("模型在白名单 → 有占位符 + model 改写 + 写召回缓存", async () => {
  const result = await runTransform(TEST_MODEL, {
    recallModelPatterns: ["MiniMax-*"],
    keepRecentPairs: 0
  });
  assert.ok(result);
  assert.equal(result.routedModel, `${HELIX_RECALL_MODEL_PREFIX}${TEST_MODEL}`);
  assert.equal(bodyHasPlaceholder(result.body), true, "应产生 ⟦QA:⟧ 占位符");
  assert.ok(recallCacheLineCount() > 0, "白名单模型应落召回缓存");
});

test("空白名单 → 有占位符 + model 改写（向后兼容）", async () => {
  const result = await runTransform(TEST_MODEL, { recallModelPatterns: [], keepRecentPairs: 0 });
  assert.ok(result);
  assert.equal(result.routedModel, `${HELIX_RECALL_MODEL_PREFIX}${TEST_MODEL}`);
  assert.equal(bodyHasPlaceholder(result.body), true);
});

test("provider 前缀模型在白名单命末段 → 有占位符", async () => {
  const model = "MiniMax (China) 2/MiniMax-M3";
  const result = await runTransform(model, { recallModelPatterns: ["MiniMax-M3"], keepRecentPairs: 0 });
  assert.ok(result);
  assert.equal(result.routedModel, `${HELIX_RECALL_MODEL_PREFIX}${model}`);
  assert.equal(bodyHasPlaceholder(result.body), true);
});

// 回归(2026-10-29):客户端发 `Doitx/DeepSeek-V4.1-Flash` 这类 provider 限定模型时,
// 召回前缀内层若保留 `Doitx/` 前缀,网关只剥召回前缀、不再解析 provider 前缀 →
// 大请求压缩后 400 `Model "Doitx/..." is not configured for target provider`。
// 内层固定写网关认识的 runtime id(`provider-4/...`):裸模型名在多 provider 同名时
// 会回退到默认 provider,带 runtime id 才能保持客户端显式选择。
test("provider 限定模型 → 召回首层写 runtime id 限定名", async () => {
  const appConfig = {
    Providers: [
      { id: "provider-4", name: "Doitx", models: ["DeepSeek-V4.1-Flash", "GLM-5.3-flash"] }
    ]
  };
  const result = await runTransform(
    "Doitx/DeepSeek-V4.1-Flash",
    { recallModelPatterns: ["DeepSeek-*"], keepRecentPairs: 0 },
    appConfig
  );
  assert.ok(result);
  assert.equal(result.routedModel, `${HELIX_RECALL_MODEL_PREFIX}provider-4/DeepSeek-V4.1-Flash`);
  assert.equal(bodyHasPlaceholder(result.body), true);
});

test("多 provider 同名模型 → 改写保留命中 provider 的 runtime id(不被默认 provider 抢走)", async () => {
  const appConfig = {
    Providers: [
      { id: "provider-1", name: "First", models: ["DeepSeek-V4.1-Flash"] },
      { id: "provider-2", name: "Second", models: ["DeepSeek-V4.1-Flash"] }
    ]
  };
  const result = await runTransform(
    "Second/DeepSeek-V4.1-Flash",
    { recallModelPatterns: [], keepRecentPairs: 0 },
    appConfig
  );
  assert.ok(result);
  assert.equal(result.routedModel, `${HELIX_RECALL_MODEL_PREFIX}provider-2/DeepSeek-V4.1-Flash`);
});

test("provider 前缀未命中已配置 provider → 原样保留", async () => {
  const appConfig = {
    Providers: [{ id: "provider-4", name: "Doitx", models: ["DeepSeek-V4.1-Flash"] }]
  };
  const model = "VendorX/Some-Model";
  const result = await runTransform(model, { recallModelPatterns: ["Some-*"], keepRecentPairs: 0 }, appConfig);
  assert.ok(result);
  assert.equal(result.routedModel, `${HELIX_RECALL_MODEL_PREFIX}${model}`);
});

// ============== 虚拟模型 (virtualModelProfiles) 别名解析 ==============
// 回归:模型是虚拟别名(如 `Fusion/Doitx`)时,召回前缀必须写**真实 base model**,
// 否则网关剥前缀后拿别名去校验 provider 白名单 → 400
// `Model "<alias>" is not configured for target provider ...`。

/** 构造一个 `baseModel.mode=fixed` 的虚拟模型 profile。 */
function fixedProfile(profileKey, displayName, fixedModel, match = {}) {
  return {
    id: profileKey,
    key: profileKey,
    enabled: true,
    displayName,
    baseModel: { mode: "fixed", fixedModel },
    match: { exactAliases: [], prefixes: [], suffixes: [], ...match }
  };
}

test("虚拟别名（网关物化 Fusion/<alias>）→ 前缀写真实 base model", async () => {
  const appConfig = {
    virtualModelProfiles: [fixedProfile("fusion-1", "Doitx", "autodl-3/DeepSeek-V4.1-Flash", { exactAliases: ["Doitx"] })]
  };
  const result = await runTransform("Fusion/Doitx", { recallModelPatterns: [], keepRecentPairs: 0 }, appConfig);
  assert.ok(result);
  assert.equal(
    result.routedModel,
    `${HELIX_RECALL_MODEL_PREFIX}autodl-3/DeepSeek-V4.1-Flash`,
    "虚拟别名必须解析成 base model 后才加召回前缀"
  );
  assert.equal(bodyHasPlaceholder(result.body), true, "解析成功后仍应压缩并召回");
});

test("裸别名（Doitx）同样解析成 base model", async () => {
  const appConfig = {
    virtualModelProfiles: [fixedProfile("fusion-1", "Doitx", "autodl-3/DeepSeek-V4.1-Flash", { exactAliases: ["Doitx"] })]
  };
  const result = await runTransform("Doitx", { recallModelPatterns: [], keepRecentPairs: 0 }, appConfig);
  assert.ok(result);
  assert.equal(result.routedModel, `${HELIX_RECALL_MODEL_PREFIX}autodl-3/DeepSeek-V4.1-Flash`);
});

test("虚拟模型但 baseModel 非 fixed（无法静态解析）→ 跳过压缩、不改写 model", async () => {
  const appConfig = {
    virtualModelProfiles: [
      { id: "dynamic-1", key: "dynamic-1", enabled: true, displayName: "Dyn", baseModel: { mode: "request" }, match: { exactAliases: ["Dyn"], prefixes: [], suffixes: [] } }
    ]
  };
  const result = await runTransform("Fusion/Dyn", { recallModelPatterns: [], keepRecentPairs: 0 }, appConfig);
  assert.ok(result, "transform 仍应返回结果(透传)");
  assert.equal(result.routedModel, undefined, "无法解析的虚拟模型不得改写 model(否则网关 400)");
  assert.equal(bodyHasPlaceholder(result.body), false, "不得产生占位符");
  assert.equal(result.headers["x-helix-compressor-scenario"], "skip-recall");
  assert.equal(recallCacheLineCount(), 0, "跳过时不得写召回缓存");
});

test("虚拟模型命中 prefixes 匹配 → 同样解析 base model", async () => {
  const appConfig = {
    virtualModelProfiles: [
      { id: "p1", key: "p1", enabled: true, displayName: "PX", baseModel: { mode: "fixed", fixedModel: "autodl-3/GLM-5.3-flash" }, match: { exactAliases: [], prefixes: ["ccr-px-"], suffixes: [] } }
    ]
  };
  const result = await runTransform("ccr-px-anything", { recallModelPatterns: [], keepRecentPairs: 0 }, appConfig);
  assert.ok(result);
  assert.equal(result.routedModel, `${HELIX_RECALL_MODEL_PREFIX}autodl-3/GLM-5.3-flash`);
});

test("非虚拟模型（无 profile 匹配）→ 保持原有行为：前缀 + 原名", async () => {
  const appConfig = { virtualModelProfiles: [fixedProfile("fusion-1", "Doitx", "autodl-3/DeepSeek-V4.1-Flash", { exactAliases: ["Doitx"] })] };
  const result = await runTransform(TEST_MODEL, { recallModelPatterns: [], keepRecentPairs: 0 }, appConfig);
  assert.ok(result);
  assert.equal(result.routedModel, `${HELIX_RECALL_MODEL_PREFIX}${TEST_MODEL}`, "非虚拟模型不受影响");
  assert.equal(bodyHasPlaceholder(result.body), true);
});

// ============== 白名单判据用「解析后的 base model」而非虚拟别名 ==============
// `recallModelPatterns` 由 recall-model-detect 从 provider 模型清单生成,**不含**
// virtual profile 派生串。若拿别名去比白名单,别名不在列表 → 误判「不支持」→
// 静默跳过压缩(无报错、无收益)。故判据须用实际发往 provider 的模型。

const VIRTUAL_APP_CONFIG = {
  virtualModelProfiles: [fixedProfile("fusion-1", "Doitx", "autodl-3/DeepSeek-V4.1-Flash", { exactAliases: ["Doitx"] })]
};

test("白名单含 base model、不含别名 → 虚拟别名仍压缩（判据用 base model）", async () => {
  const result = await runTransform(
    "Fusion/Doitx",
    { recallModelPatterns: ["DeepSeek-V4.1-Flash"], keepRecentPairs: 0 },
    VIRTUAL_APP_CONFIG
  );
  assert.ok(result);
  assert.equal(
    result.routedModel,
    `${HELIX_RECALL_MODEL_PREFIX}autodl-3/DeepSeek-V4.1-Flash`,
    "base model 命中白名单即应压缩,别名不在白名单不得成为阻断理由"
  );
  assert.equal(bodyHasPlaceholder(result.body), true);
  assert.equal(result.headers["x-helix-compressor-scenario"], "local");
});

test("白名单含别名、不含 base model → 跳过压缩（判据不是别名）", async () => {
  const result = await runTransform(
    "Fusion/Doitx",
    { recallModelPatterns: ["Fusion/Doitx"], keepRecentPairs: 0 },
    VIRTUAL_APP_CONFIG
  );
  assert.ok(result);
  assert.equal(result.routedModel, undefined, "别名命中白名单不足以判定支持");
  assert.equal(bodyHasPlaceholder(result.body), false);
  assert.equal(result.headers["x-helix-compressor-scenario"], "skip-recall");
  assert.equal(recallCacheLineCount(), 0);
});

test("base model 被 exclude 命中 → 虚拟别名同样跳过（exclude 作用于真实模型）", async () => {
  const result = await runTransform(
    "Fusion/Doitx",
    { recallModelPatterns: [], recallModelExcludePatterns: ["DeepSeek-V4.1-Flash"], keepRecentPairs: 0 },
    VIRTUAL_APP_CONFIG
  );
  assert.ok(result);
  assert.equal(result.routedModel, undefined);
  assert.equal(bodyHasPlaceholder(result.body), false);
  assert.equal(result.headers["x-helix-compressor-scenario"], "skip-recall");
});
