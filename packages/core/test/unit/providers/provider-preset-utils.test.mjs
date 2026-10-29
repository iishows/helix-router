import assert from "node:assert/strict";
import test from "node:test";

test("#1819 verified endpoints outrank synthesized presets while explicit choices win", () => {
  const preset = { type: "openai_chat_completions", baseUrl: "https://example.test/api/compatible", source: "preset" };
  const detected = { type: "openai_chat_completions", baseUrl: "https://example.test/api/v3", source: "detected" };
  const manual = { type: "openai_chat_completions", baseUrl: "https://example.test/manual" };
  for (const capabilities of [[preset, detected], [detected, preset]]) {
    assert.deepEqual(normalizedProviderCapabilities({ name: "custom", models: ["model"], capabilities }), [detected]);
  }
  assert.deepEqual(normalizedProviderCapabilities({ name: "custom", models: ["model"], capabilities: [preset, detected, manual] }), [manual]);
});
import {
  normalizeProviderPresetCapabilitiesForTest
} from "@ccr/core/config/config.ts";
import {
  findProviderPresetByBaseUrlInList,
  findProviderPresetByIdentityInList,
  providerApiKeySafetyIssueInList,
  providerEndpointCanReceiveProviderApiKeyInList,
  providerIdentitySafetyIssueInList,
  providerPresetMatchesBaseUrl
} from "@ccr/core/providers/presets/utils.ts";
import {
  doitxProviderPreset
} from "@ccr/core/providers/presets/doitx/index.ts";
import {
  providerPresets
} from "@ccr/core/providers/presets/index.ts";
import {
  normalizedProviderCapabilities,
  providerCapabilityForClientProtocol
} from "@ccr/core/providers/runtime-topology.ts";

const openAiPreset = {
  aliases: ["OpenAI", "ChatGPT"],
  endpoints: [{ baseUrl: "https://api.openai.com/v1", protocols: ["openai_chat_completions"] }],
  id: "openai",
  name: "OpenAI",
  officialApiKeyPatterns: [{ source: "^sk-openai-" }]
};

const anthropicPreset = {
  aliases: ["Claude"],
  endpoints: [{ baseUrl: "https://api.anthropic.com", protocols: ["anthropic_messages"] }],
  id: "anthropic",
  name: "Anthropic",
  officialApiKeyPatterns: [{ source: "^sk-ant-" }]
};

const presets = [openAiPreset, anthropicPreset];

test("provider preset matching accepts endpoint subpaths but rejects different hosts", () => {
  const openRouterPreset = {
    aliases: ["openrouter"],
    endpoints: [{ baseUrl: "https://openrouter.ai/api/v1", protocols: ["openai_chat_completions"] }],
    id: "openrouter",
    name: "OpenRouter"
  };

  assert.equal(providerPresetMatchesBaseUrl(openAiPreset, "https://api.openai.com/v1/chat/completions"), true);
  assert.equal(providerPresetMatchesBaseUrl(openAiPreset, "https://api.openai.com"), true);
  assert.equal(providerPresetMatchesBaseUrl(openRouterPreset, "https://openrouter.ai/api"), true);
  assert.equal(providerPresetMatchesBaseUrl(openAiPreset, "https://proxy.example.com/v1"), false);
  assert.equal(findProviderPresetByBaseUrlInList(presets, "api.anthropic.com/v1/messages")?.id, "anthropic");
});

test("provider identity lookup normalizes aliases and punctuation", () => {
  assert.equal(findProviderPresetByIdentityInList(presets, "my ChatGPT gateway")?.id, "openai");
  assert.equal(findProviderPresetByIdentityInList(presets, "Claude Provider")?.id, "anthropic");
});

test("registry exposes the built-in DoitX preset and matches its hosted endpoints", () => {
  assert.equal(providerPresets.find((preset) => preset.id === "doitx"), doitxProviderPreset);
  assert.equal(doitxProviderPreset.name, "DoitX");
  assert.equal(doitxProviderPreset.websiteUrl, "https://router.doitx.ai/");
  assert.deepEqual(doitxProviderPreset.endpoints, [
    {
      baseUrl: "https://router.doitx.ai",
      protocols: [
        "anthropic_messages",
        "openai_chat_completions",
        "openai_responses"
      ]
    }
  ]);
  assert.equal(providerPresetMatchesBaseUrl(doitxProviderPreset, "https://router.doitx.ai"), true);
  assert.equal(providerPresetMatchesBaseUrl(doitxProviderPreset, "https://router.doitx.ai/v1/chat/completions"), true);
  assert.equal(providerPresetMatchesBaseUrl(doitxProviderPreset, "https://proxy.example.com/v1"), false);
});

test("DoitX config normalization synthesizes the preset capability for a legacy Chat-only provider", () => {
  const provider = normalizeProviderPresetCapabilitiesForTest({
    api_base_url: "https://router.doitx.ai",
    capabilities: [
      {
        baseUrl: "https://router.doitx.ai",
        source: "detected",
        type: "openai_chat_completions"
      }
    ],
    models: ["claude-sonnet-4"],
    name: "DoitX"
  });

  assert.equal(provider.capabilities.length, 1);
  assert.equal(provider.capabilities[0].type, "openai_chat_completions");
  assert.equal(provider.capabilities[0].baseUrl, "https://router.doitx.ai");
  assert.equal(
    providerCapabilityForClientProtocol(provider, "anthropic_messages")?.type,
    "anthropic_messages"
  );
});

test("provider identity safety does not block branded third-party endpoints", () => {
  assert.equal(
    providerIdentitySafetyIssueInList(presets, {
      baseUrl: "http://127.0.0.1:3456/v1",
      name: "OpenAI local test"
    }),
    undefined
  );
  assert.equal(
    providerIdentitySafetyIssueInList(presets, {
      baseUrl: "https://proxy.example.com/v1",
      name: "OpenAI proxy"
    }),
    undefined
  );
});

test("provider API key safety does not block official-looking keys on third-party endpoints", () => {
  assert.equal(
    providerApiKeySafetyIssueInList(presets, {
      apiKey: "sk-openai-test",
      baseUrl: "https://proxy.example.com/v1",
      name: "neutral proxy"
    }),
    undefined
  );
  assert.equal(
    providerApiKeySafetyIssueInList(presets, {
      apiKey: "sk-openai-test",
      baseUrl: "https://api.openai.com/v1"
    }),
    undefined
  );
  assert.equal(
    providerEndpointCanReceiveProviderApiKeyInList(presets, {
      apiKey: "sk-ant-test",
      endpoint: "https://proxy.example.com/anthropic",
      providerName: "Anthropic"
    }),
    undefined
  );
});
