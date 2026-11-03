import assert from "node:assert/strict";
import test from "node:test";
import { providerCapabilityForClientProtocol } from "@ccr/core/providers/runtime-topology.ts";

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
