import assert from "node:assert/strict";
import test from "node:test";
import {
  isProviderEndpointLocked,
  providerEndpointLockIssue,
  lockedProviderEndpointOrigins
} from "@ccr/core/providers/endpoint-lock.ts";
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

test("unset or blank lock env disables locking", () => {
  withLock(undefined, () => {
    assert.equal(isProviderEndpointLocked(), false);
    assert.deepEqual(lockedProviderEndpointOrigins(), []);
    assert.equal(providerEndpointLockIssue("https://api.deepseek.com"), undefined);
  });
  withLock("   ", () => {
    assert.equal(isProviderEndpointLocked(), false);
    assert.equal(providerEndpointLockIssue("https://api.deepseek.com"), undefined);
  });
});

test("lock env normalizes scheme, trailing slash, case and default port", () => {
  withLock("  HTTPS://Router.DoitX.ai:443/  ", () => {
    assert.deepEqual(lockedProviderEndpointOrigins(), ["https://router.doitx.ai"]);
    // Same endpoint expressed with a path / different case must be allowed.
    assert.equal(providerEndpointLockIssue("https://router.doitx.ai/v1"), undefined);
    assert.equal(providerEndpointLockIssue("https://ROUTER.DOITX.AI/v1/messages"), undefined);
    // A bare host (no scheme) must also resolve to the same origin.
    assert.equal(providerEndpointLockIssue("router.doitx.ai"), undefined);
  });
});

test("lock env rejects other origins and reports the allowed list", () => {
  withLock("https://router.doitx.ai", () => {
    const issue = providerEndpointLockIssue("https://api.deepseek.com");
    assert.ok(issue);
    assert.equal(issue.code, "provider_endpoint_locked");
    assert.deepEqual(issue.allowed, ["https://router.doitx.ai"]);
    assert.match(issue.message, /api\.deepseek\.com/);
  });
});

test("lock env supports multiple comma separated endpoints", () => {
  withLock("https://router.doitx.ai, https://backup.doitx.ai", () => {
    assert.deepEqual(lockedProviderEndpointOrigins(), [
      "https://router.doitx.ai",
      "https://backup.doitx.ai"
    ]);
    assert.equal(providerEndpointLockIssue("https://backup.doitx.ai/v1"), undefined);
    assert.ok(providerEndpointLockIssue("https://evil.example.com"));
  });
});

test("compilation rejects a locked-out provider endpoint", () => {
  withLock("https://router.doitx.ai", () => {
    assert.throws(
      () =>
        toCoreGatewayProviders({
          api_base_url: "https://api.deepseek.com",
          api_key: "test-key",
          id: "deepseek",
          models: ["deepseek-chat"],
          name: "DeepSeek",
          type: "openai_chat_completions"
        }),
      /provider_endpoint_locked|not allowed/i
    );
  });
});

test("compilation allows the locked endpoint across all three protocols", () => {
  withLock("https://router.doitx.ai", () => {
    for (const type of ["anthropic_messages", "openai_chat_completions", "openai_responses"]) {
      const compiled = toCoreGatewayProviders({
        api_base_url: "https://router.doitx.ai",
        api_key: "test-key",
        id: "doitx",
        models: ["claude-sonnet-5-5"],
        name: "DoitX",
        type
      });
      assert.ok(compiled.length > 0, `expected compiled providers for ${type}`);
      for (const entry of compiled) {
        assert.match(String(entry.baseurl), /^https:\/\/router\.doitx\.ai/);
      }
    }
  });
});

test("compilation is unaffected when locking is disabled", () => {
  withLock(undefined, () => {
    const compiled = toCoreGatewayProviders({
      api_base_url: "https://api.deepseek.com",
      api_key: "test-key",
      id: "deepseek",
      models: ["deepseek-chat"],
      name: "DeepSeek",
      type: "openai_chat_completions"
    });
    assert.ok(compiled.length > 0);
  });
});
