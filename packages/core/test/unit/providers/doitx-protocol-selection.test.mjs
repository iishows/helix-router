import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  _resetAnthropicEndpointProbeForTest,
  _setAnthropicEndpointProbeResultForTest,
  probeAnthropicEndpoint,
  providerCapabilityForClientProtocol
} from "@ccr/core/providers/runtime-topology.ts";

beforeEach(() => {
  _resetAnthropicEndpointProbeForTest();
});

function doitxProvider() {
  return {
    api_base_url: "https://router.doitx.ai",
    api_key: "test-key",
    capabilities: [
      {
        baseUrl: "https://router.doitx.ai/v1",
        endpoint: "https://router.doitx.ai/v1/chat/completions",
        source: "detected",
        type: "openai_chat_completions"
      },
      {
        baseUrl: "https://router.doitx.ai",
        endpoint: "https://router.doitx.ai/messages",
        source: "detected",
        type: "anthropic_messages"
      }
    ],
    models: ["DeepSeek-V4.1-Flash"],
    name: "Doitx",
    type: "openai_chat_completions"
  };
}

// 2026-11-03: Doitx 的 /v1/messages 实测无 prompt cache(同 prompt 两次 input_tokens 相同,
// 无 cache_read/cache_creation);/v1/chat/completions 命中 99%+。Anthropic 客户端必须改走
// OpenAI chat 端点,否则单位成本约高 8 倍。
test("Doitx: Anthropic 客户端优先走 OpenAI chat 端点(可命中 prompt cache)", () => {
  const capability = providerCapabilityForClientProtocol(doitxProvider(), "anthropic_messages");
  assert.equal(capability?.type, "openai_chat_completions");
  assert.equal(capability?.baseUrl, "https://router.doitx.ai/v1");
});

test("Doitx: OpenAI 客户端仍走 OpenAI chat 端点", () => {
  assert.equal(
    providerCapabilityForClientProtocol(doitxProvider(), "openai_chat_completions")?.type,
    "openai_chat_completions"
  );
});

test("非 Doitx provider: Anthropic 客户端仍按原协议走 anthropic_messages", () => {
  const provider = {
    ...doitxProvider(),
    api_base_url: "https://api.example.com",
    name: "Example",
    capabilities: [
      { baseUrl: "https://api.example.com", source: "detected", type: "anthropic_messages" }
    ]
  };
  assert.equal(providerCapabilityForClientProtocol(provider, "anthropic_messages")?.type, "anthropic_messages");
});

// ============= anthropicEndpointPreference =============

test("anthropicEndpointPreference=messages: 强制走 Anthropic 端点", () => {
  const provider = { ...doitxProvider(), anthropicEndpointPreference: "messages" };
  assert.equal(providerCapabilityForClientProtocol(provider, "anthropic_messages")?.type, "anthropic_messages");
});

test("anthropicEndpointPreference=chat: 强制走 OpenAI chat 端点", () => {
  const provider = { ...doitxProvider(), anthropicEndpointPreference: "chat" };
  assert.equal(providerCapabilityForClientProtocol(provider, "anthropic_messages")?.type, "openai_chat_completions");
});

test("anthropicEndpointPreference=auto: 使用缓存的探测结果", () => {
  const provider = { ...doitxProvider(), anthropicEndpointPreference: "auto" };
  _setAnthropicEndpointProbeResultForTest(provider, true);
  assert.equal(providerCapabilityForClientProtocol(provider, "anthropic_messages")?.type, "anthropic_messages");
  _setAnthropicEndpointProbeResultForTest(provider, false);
  assert.equal(providerCapabilityForClientProtocol(provider, "anthropic_messages")?.type, "openai_chat_completions");
});

test("probeAnthropicEndpoint: 缓存命中 + 长上下文不截断 → true", async () => {
  let call = 0;
  const calls = [];
  const fakeFetch = async (url, init) => {
    call += 1;
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const usage = call <= 2
      ? { cache_read_input_tokens: call === 2 ? 15000 : 0, input_tokens: 15000 }
      : { input_tokens: 260000 };
    return new Response(JSON.stringify({ content: [], usage }), {
      headers: { "content-type": "application/json" },
      status: 200
    });
  };
  assert.equal(await probeAnthropicEndpoint(doitxProvider(), undefined, fakeFetch), true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://router.doitx.ai/v1/messages");
});

test("probeAnthropicEndpoint: 无缓存字段 → false", async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ content: [], usage: { input_tokens: 15000 } }), {
    headers: { "content-type": "application/json" },
    status: 200
  });
  assert.equal(await probeAnthropicEndpoint(doitxProvider(), undefined, fakeFetch), false);
});

test("probeAnthropicEndpoint: 长上下文被截断 → false", async () => {
  let call = 0;
  const fakeFetch = async () => {
    call += 1;
    const usage = call <= 2
      ? { cache_read_input_tokens: call === 2 ? 15000 : 0, input_tokens: 15000 }
      : { input_tokens: 139000 };
    return new Response(JSON.stringify({ content: [], usage }), {
      headers: { "content-type": "application/json" },
      status: 200
    });
  };
  assert.equal(await probeAnthropicEndpoint(doitxProvider(), undefined, fakeFetch), false);
});
