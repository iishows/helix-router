import assert from "node:assert/strict";
import test from "node:test";

test("retired provider presets are dropped, leaving only DoitX", async () => {
  const { removeRetiredProviderPresetsForTest } = await import("@ccr/core/config/config.ts");

  const providers = removeRetiredProviderPresetsForTest([
    {
      baseUrl: "https://api.openai.com/v1",
      models: ["gpt-5.5"],
      name: "OpenAI"
    },
    {
      baseUrl: "https://router.doitx.ai",
      models: ["claude-sonnet-5-5"],
      name: "DoitX"
    },
    {
      baseUrl: "https://generativelanguage.googleapis.com",
      models: ["gemini-2.5-pro"],
      name: "Gemini"
    }
  ]);

  assert.deepEqual(providers.map((provider) => provider.name), ["DoitX"]);
});

test("DoitX providers are kept regardless of URL alias field", async () => {
  const { removeRetiredProviderPresetsForTest } = await import("@ccr/core/config/config.ts");

  const providers = removeRetiredProviderPresetsForTest([
    { api_base_url: "https://router.doitx.ai", models: [], name: "Snake" },
    { apiKey: "k", baseUrl: "https://router.doitx.ai/v1", models: [], name: "Camel" },
    { baseurl: "https://router.doitx.ai", models: [], name: "Lower" }
  ]);

  assert.deepEqual(providers.map((provider) => provider.name), ["Snake", "Camel", "Lower"]);
});

test("providers without a base URL are dropped", async () => {
  const { removeRetiredProviderPresetsForTest } = await import("@ccr/core/config/config.ts");

  const providers = removeRetiredProviderPresetsForTest([
    { models: ["m"], name: "No Url" },
    { baseUrl: "   ", models: ["m"], name: "Blank Url" }
  ]);

  assert.deepEqual(providers, []);
});
