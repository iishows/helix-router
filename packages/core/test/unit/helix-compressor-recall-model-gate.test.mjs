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

function mockContext(pluginConfig = {}) {
  return {
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    paths: { configDir: "", dataDir: "", pluginDataDir: "" },
    permissions: [],
    pluginConfig: { ...pluginConfig },
    pluginId: "helix-compressor",
    openSqliteStore: async () => { throw new Error("not implemented"); }
  };
}

function runTransform(model, pluginConfig) {
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
    mockContext(pluginConfig)
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
