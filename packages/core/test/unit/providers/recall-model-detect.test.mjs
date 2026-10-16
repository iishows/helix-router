/**
 * detectRecallModelsForConfig / applyRecallDetection 单测(2026-10-16)
 *
 * 覆盖:枚举已配置模型 → 逐模型探测 → 汇总白名单;缓存命中跳过网络;changed 判定;
 * applyRecallDetection 只改 helix 插件 config 且注入 recallModelDetected=true。
 * 探测与文件系统均注入/隔离:probe 走 fake,缓存目录走临时 HELIX_RECALL_CACHE_DIR。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";
import {
  applyRecallDetection,
  detectRecallModelsForConfig,
  readConfiguredRecallPatterns
} from "@ccr/core/providers/recall-model-detect.ts";
import { readRecallProbeCache, recallProbeCacheKey, resolveRecallProbeDir } from "@ccr/core/observability/helix-recall-probe-cache.ts";

let cacheDir;

before(() => {
  cacheDir = mkdtempSync(path.join(os.tmpdir(), "helix-recall-detect-"));
  process.env.HELIX_RECALL_CACHE_DIR = cacheDir;
});

after(() => {
  rmSync(cacheDir, { force: true, recursive: true });
  delete process.env.HELIX_RECALL_CACHE_DIR;
});

beforeEach(() => {
  // 每个用例前清空探测缓存文件(缓存是 append-only JSONL,读时 last-line-wins)。
  rmSync(path.join(cacheDir, "helix-recall-probe", "probe-cache.jsonl"), { force: true });
});

function config(pluginConfig = {}, models = ["alpha", "beta"]) {
  return {
    plugins: [{ config: pluginConfig, enabled: true, id: "helix-compressor" }],
    Providers: [
      {
        api_base_url: "http://127.0.0.1:9999/v1",
        api_key: "k",
        enabled: true,
        models,
        name: "Demo",
        type: "openai_chat_completions"
      }
    ],
    Router: { fallback: { mode: "off", models: [], retryCount: 0 } },
    gateway: {}
  };
}

/** 造一个可控 probe:alpha 支持 tools,beta 不支持。 */
function fakeProbe() {
  const calls = [];
  const probe = async (_provider, model, protocol) => {
    calls.push({ model, protocol });
    const capable = model === "alpha";
    return { depth: capable ? "tools" : "none", message: capable ? "ok" : "no", model, protocol, recallCapable: capable };
  };
  return { calls, probe };
}

test("detectRecallModelsForConfig: 枚举 + 探测 → 只把支持者写入白名单", async () => {
  const { calls, probe } = fakeProbe();
  const result = await detectRecallModelsForConfig(config(), { probe });
  assert.deepEqual(result.patterns, ["alpha"]);
  assert.equal(result.detected, true);
  assert.equal(result.changed, true, "现有白名单为空 → 变化");
  assert.equal(calls.length, 2, "两个模型各探一次");
  const alpha = result.results.find((r) => r.model === "alpha");
  assert.equal(alpha.recallCapable, true);
  assert.equal(alpha.depth, "tools");
});

test("detectRecallModelsForConfig: 二次调用命中缓存,零网络", async () => {
  const first = fakeProbe();
  await detectRecallModelsForConfig(config(), { probe: first.probe });
  assert.equal(first.calls.length, 2);

  const second = fakeProbe();
  const result = await detectRecallModelsForConfig(config(), { probe: second.probe });
  assert.equal(second.calls.length, 0, "缓存命中不得再打上游");
  assert.equal(result.detected, false, "全部命中缓存 → detected=false");
  assert.deepEqual(result.patterns, ["alpha"]);
});

test("detectRecallModelsForConfig: 白名单与现有 config 相同 → changed=false", async () => {
  const { probe } = fakeProbe();
  const result = await detectRecallModelsForConfig(config({ recallModelDetected: true, recallModelPatterns: ["alpha"] }), { probe });
  assert.equal(result.changed, false);
});

test("detectRecallModelsForConfig: 401/403 未知结果不落缓存(下次重探)", async () => {
  const probe = async (_provider, model, protocol) => ({
    depth: "none", message: "unauthorized", model, protocol, recallCapable: false, skipped: true, status: 401
  });
  await detectRecallModelsForConfig(config(), { probe });
  const second = fakeProbe();
  await detectRecallModelsForConfig(config(), { probe: second.probe });
  assert.equal(second.calls.length, 2, "skipped 结果不缓存,应重新探测");
});

test("detectRecallModelsForConfig: 探测抛错 → 该模型判 none skipped,不中断其它、不落缓存", async () => {
  const probe = async (_provider, model, protocol) => {
    if (model === "alpha") {
      throw new Error("boom");
    }
    return { depth: "tools", message: "ok", model, protocol, recallCapable: true };
  };
  const result = await detectRecallModelsForConfig(config(), { probe });
  assert.deepEqual(result.patterns, ["beta"]);
  const alpha = result.results.find((r) => r.model === "alpha");
  assert.equal(alpha.recallCapable, false);
  assert.equal(alpha.skipped, true, "抛错属未知,不得落缓存");
  assert.equal(readRecallProbeCache().get(recallProbeCacheKey("Demo", "alpha")), undefined, "抛错结果不落缓存");
});

test("readConfiguredRecallPatterns: 读白名单 + detected 标志", () => {
  const empty = readConfiguredRecallPatterns(config());
  assert.deepEqual(empty.patterns, []);
  assert.equal(empty.detected, false);

  const filled = readConfiguredRecallPatterns(config({ recallModelDetected: true, recallModelPatterns: ["alpha", "beta"] }));
  assert.deepEqual(filled.patterns, ["alpha", "beta"]);
  assert.equal(filled.detected, true);
});

test("applyRecallDetection: 只改 helix 插件 config,写白名单 + detected=true,不动原对象", () => {
  const original = config({ keepRecentPairs: 2 }, ["alpha"]);
  const next = applyRecallDetection(original, { changed: true, detected: true, patterns: ["alpha"], results: [] });
  assert.notEqual(next, original, "返回新对象");
  assert.equal(original.plugins[0].config.recallModelDetected, undefined, "原对象不被修改");
  const pluginConfig = next.plugins[0].config;
  assert.equal(pluginConfig.recallModelDetected, true);
  assert.deepEqual(pluginConfig.recallModelPatterns, ["alpha"]);
  assert.equal(pluginConfig.keepRecentPairs, 2, "保留其它键");
});

test("applyRecallDetection: 检测出空集 → 写空白名单 + detected=true(区分未配置)", () => {
  const next = applyRecallDetection(config(), { changed: true, detected: true, patterns: [], results: [] });
  assert.deepEqual(next.plugins[0].config.recallModelPatterns, []);
  assert.equal(next.plugins[0].config.recallModelDetected, true);
});

test("recallProbeCacheKey: providerKey|model 稳定", () => {
  assert.equal(recallProbeCacheKey("Demo", "alpha"), "Demo|alpha");
});

test("resolveRecallProbeDir: 未设置 HELIX_RECALL_CACHE_DIR 时回退 DATADIR(检测 RPC 跑在父进程)", () => {
  const saved = process.env.HELIX_RECALL_CACHE_DIR;
  try {
    delete process.env.HELIX_RECALL_CACHE_DIR;
    const dir = resolveRecallProbeDir();
    assert.equal(dir.endsWith(path.join("helix-recall", "helix-recall-probe")), true, `unexpected dir: ${dir}`);
  } finally {
    if (saved !== undefined) process.env.HELIX_RECALL_CACHE_DIR = saved;
  }
});

test("探测缓存: 已判定的结果(支持与不支持)都落缓存", async () => {
  const { probe } = fakeProbe();
  await detectRecallModelsForConfig(config(), { probe });
  const cache = readRecallProbeCache();
  assert.equal(cache.get(recallProbeCacheKey("Demo", "alpha"))?.depth, "tools");
  assert.equal(cache.get(recallProbeCacheKey("Demo", "beta"))?.depth, "none", "判定为不支持的也缓存,避免重复探测");
});
