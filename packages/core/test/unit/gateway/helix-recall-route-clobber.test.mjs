/**
 * helix recall 虚拟 model 改写不得被 CCR 路由解析器覆盖(2026-10-16 修)。
 *
 * 背景:beforeRouting transform 写下的 `ccr-helix-recall/<真 model>` 会被之后运行的
 * CCR 路由解析器（resolveCcrGatewayRoute）从 body.model 反解成的普通 model 覆盖
 * （handler 无条件用 routeResolution.model 覆盖 requestedModelSelector）→ recall
 * virtual-model profile 永不命中 → 内部 tool 循环不跑 → 真实流量 recall 恒 0。
 *
 * 修复:transform 把改写后的 model 同步写进 `x-ccr-routed-model` header,解析器读到后
 * 用带前缀的 model 反解 → 不带前缀的 model 不在注册表 → 返回 undefined → 不再覆盖。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayPlugin } from "@ccr/core/gateway/core-runtime/router-plugin";
import { ccrRouterRouteResolverKey, ccrRoutedModelHeader } from "@ccr/core/gateway/core-runtime/router-plugin-contract";
import { helixCompressorRequestTransformKey } from "@ccr/core/plugins/built-ins/helix-compressor";
import { HELIX_RECALL_MODEL_PREFIX } from "@ccr/core/contracts/app";
import { createDefaultAppConfig } from "@ccr/core/config/default-config";

const MODEL = "DeepSeek-V4.1-Flash";
const LONG = "y".repeat(4000);

function historyMsgs() {
  const m = [{ role: "system", content: "You are Claude Code." }];
  for (let i = 0; i < 12; i++) {
    m.push({ role: "user", content: "run " + i + " " + "q".repeat(600) });
    m.push({ role: "assistant", content: "answer " + i + " " + "a".repeat(600) });
    m.push({ role: "tool", tool_call_id: "c" + i, content: "OUT" + i + "\n" + LONG });
  }
  m.push({ role: "user", content: "What did command 3 print?" });
  return m;
}

async function buildPlugin() {
  const config = createDefaultAppConfig();
  config.Providers = [{ models: [MODEL], name: "autodl-3", type: "openai_chat_completions" }];
  config.plugins = [{ config: {}, enabled: true, id: "helix-compressor" }];
  return createGatewayPlugin({ plugin: { config: { appConfig: config } } });
}

test("helix 改写后 router resolver 不再覆盖 model(clobber 修复)", async () => {
  const plugin = await buildPlugin();
  const helix = plugin.requestTransforms.find((t) => t.key === helixCompressorRequestTransformKey);
  // 模拟 router transform 已先设过 header（真实 handler 里 router transform 在 helix 之前）。
  const ht = await helix.transform({
    request: { headers: { [ccrRoutedModelHeader]: MODEL }, id: "probe", method: "POST", url: "/v1/chat/completions" },
    requestBody: { model: MODEL, messages: historyMsgs() },
    route: { method: "POST", url: "/v1/chat/completions" }
  });
  assert.equal(ht.model, `${HELIX_RECALL_MODEL_PREFIX}${MODEL}`, "含占位符时应改写成 recall 虚拟 model");
  // 修复点:改写后的 model 必须同步写进路由 header。
  assert.equal(ht.headers[ccrRoutedModelHeader], `${HELIX_RECALL_MODEL_PREFIX}${MODEL}`);

  const resolver = plugin.routeResolvers.find((r) => r.key === ccrRouterRouteResolverKey);
  const resolved = resolver.resolve({
    model: ht.model,
    request: { headers: ht.headers, method: "POST", url: "/v1/chat/completions" },
    requestBody: ht.requestBody,
    route: { method: "POST", url: "/v1/chat/completions" }
  });
  // 解析器必须放弃(undefined),否则 handler 会用普通 model 覆盖 wreflect 改写。
  assert.equal(resolved, undefined, "带 ccr-helix-recall/ 前缀的 model 不可被解析器解析为普通路由");
});

test("无占位符时不改写 model、不写路由 header(live 直通保持不变)", async () => {
  const plugin = await buildPlugin();
  const helix = plugin.requestTransforms.find((t) => t.key === helixCompressorRequestTransformKey);
  const ht = await helix.transform({
    request: { headers: {}, id: "probe2", method: "POST", url: "/v1/chat/completions" },
    requestBody: { model: MODEL, messages: [{ role: "user", content: "hi" }] },
    route: { method: "POST", url: "/v1/chat/completions" }
  });
  assert.equal(ht.model, undefined, "无占位符不应改写 model");
  assert.equal(ht.headers[ccrRoutedModelHeader], undefined, "无改写则不应写路由 header");
});
