import assert from "node:assert/strict";
import test from "node:test";
import { toCoreGatewayProviders } from "@ccr/core/providers/runtime-topology.ts";

const ENV = "CCR_LOCK_PROVIDER_ENDPOINT";

function withLock(value, run) {
  const previous = process.env[ENV];
  if (value === undefined) {
    delete process.env[ENV];
  } else {
    process.env[ENV] = value;
  }
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env[ENV];
    } else {
      process.env[ENV] = previous;
    }
  }
}

function compiledBaseurls(overrides) {
  const provider = {
    name: "probe",
    models: ["m"],
    api_key: "k",
    type: "openai_chat_completions",
    ...overrides
  };
  return toCoreGatewayProviders(provider).map((entry) => entry.baseurl);
}

// Every case must be BLOCKED: a config that names a forbidden endpoint through any
// field or spelling must not compile into an upstream provider.
const BYPASS_CASES = [
  ["lower-priority alias `baseurl` smuggles evil while api_base_url looks legit",
    { baseurl: "https://evil.example.com", api_base_url: "https://router.doitx.ai" }],
  ["lower-priority alias `baseUrl` smuggles evil while api_base_url looks legit",
    { baseUrl: "https://evil.example.com", api_base_url: "https://router.doitx.ai" }],
  ["empty high-priority alias falls through to evil api_base_url",
    { baseurl: "", api_base_url: "https://evil.example.com" }],
  ["subdomain suffix disguise", { api_base_url: "https://router.doitx.ai.evil.com" }],
  ["path prefix disguise", { api_base_url: "https://evil.com/router.doitx.ai" }],
  ["scheme downgrade to http", { api_base_url: "http://router.doitx.ai" }],
  ["non-default port", { api_base_url: "https://router.doitx.ai:8443" }],
  ["userinfo @ disguise", { api_base_url: "https://router.doitx.ai@evil.com" }],
  ["protocol-relative //evil.example.com", { api_base_url: "//evil.example.com" }],
  ["unrelated host", { api_base_url: "https://api.deepseek.com" }]
];

for (const [label, overrides] of BYPASS_CASES) {
  test(`compile guard blocks: ${label}`, () => {
    withLock("https://router.doitx.ai", () => {
      assert.throws(
        () => compiledBaseurls(overrides),
        /not allowed/i,
        `expected rejection for: ${label}`
      );
    });
  });
}

// Genuine spellings of the allowed endpoint must still pass.
const ALLOWED_CASES = [
  ["exact origin", { api_base_url: "https://router.doitx.ai" }],
  ["trailing slash", { api_base_url: "https://router.doitx.ai/" }],
  ["uppercase host", { api_base_url: "HTTPS://Router.DoitX.ai" }],
  ["base path", { api_base_url: "https://router.doitx.ai/v1" }],
  ["explicit default port 443", { api_base_url: "https://router.doitx.ai:443" }],
  ["alias field carrying allowed endpoint", { baseurl: "https://router.doitx.ai" }]
];

for (const [label, overrides] of ALLOWED_CASES) {
  test(`compile guard allows: ${label}`, () => {
    withLock("https://router.doitx.ai", () => {
      const urls = compiledBaseurls(overrides);
      assert.ok(urls.length > 0, `expected a compiled provider for: ${label}`);
      for (const url of urls) {
        assert.match(String(url), /router\.doitx\.ai/i, `compiled url should target doitx: ${url}`);
      }
    });
  });
}
