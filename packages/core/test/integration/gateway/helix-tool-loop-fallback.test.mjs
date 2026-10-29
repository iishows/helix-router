/**
 * Helix recall budget fallback (2026-10-29)
 *
 * When the built-in "Helix Recall" virtual model profile exhausts its internal
 * tool loop budget, the core gateway answers with a synthetic 400
 * `All target providers failed.` (attempt stage `tool_loop_limit`). The request
 * pipeline must retry that request exactly once with compression disabled so
 * the client gets a correct answer instead of a 400.
 *
 * This harness stands in for the core gateway process and drives the real CCR
 * pipeline end to end.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { gatewayService } from "@ccr/core/gateway/service.ts";
import { ccrHelixFallbackHeader, ccrHelixSkipCompressionHeader } from "@ccr/core/gateway/core-runtime/router-plugin-contract.ts";
import { waitForTcpListener } from "../../support/loopback-listener.mjs";

const MODEL = "MiniMax-M3";

test("recall tool loop limit 400 falls back to one uncompressed retry", { timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccr-helix-fallback-test-"));
  const upstreamRequests = [];

  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    if (!request.url?.includes("/messages")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    upstreamRequests.push({ body, headers: request.headers, path: request.url });
    if (upstreamRequests.length === 1) {
      const payload = JSON.stringify({
        error: {
          attempts: [{ message: "Virtual model tool loop exceeded maxTurns (4)", stage: "tool_loop_limit", status: 400 }],
          message: "All target providers failed."
        }
      });
      response.writeHead(400, {
        "content-length": String(Buffer.byteLength(payload)),
        "content-type": "application/json"
      });
      response.end(payload);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      content: [{ text: "fallback ok", type: "text" }],
      id: "msg_fallback",
      model: MODEL,
      role: "assistant",
      stop_reason: "end_turn",
      type: "message",
      usage: { input_tokens: 10, output_tokens: 5 }
    }));
  });
  const gateway = createServer((request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    void gatewayService.proxyRequest(request, response, requestPath).catch((error) => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
      }
      if (!response.writableEnded) {
        response.end(`${JSON.stringify({ error: { message: String(error?.message ?? error) } })}\n`);
      }
    });
  });

  try {
    try {
      await listen(upstream);
    } catch (error) {
      if (isLocalListenUnavailable(error)) {
        t.skip(`Local HTTP listen is unavailable: ${formatError(error)}`);
        return;
      }
      throw error;
    }
    await waitForTcpListener(upstream);
    const upstreamPort = serverPort(upstream);

    const config = createDefaultAppConfig();
    config.APIKEY = "test-api-key";
    config.Providers = [{ id: "mock", models: [MODEL], name: "Mock", type: "openai_chat_completions" }];
    config.plugins = [{ config: {}, enabled: true, id: "helix-compressor" }];
    config.gateway.coreHost = "127.0.0.1";
    config.gateway.corePort = upstreamPort;
    config.gateway.host = "127.0.0.1";
    config.gateway.port = 0;
    await gatewayService.updateConfig(config);
    gatewayService.coreAuthToken = "test-core-auth-token";

    await listen(gateway);
    await waitForTcpListener(gateway);
    const gatewayUrl = `http://127.0.0.1:${serverPort(gateway)}/v1/messages`;
    const response = await fetch(gatewayUrl, {
      body: JSON.stringify({
        max_tokens: 32,
        messages: [{ content: "hello", role: "user" }],
        model: `mock/${MODEL}`,
        stream: false
      }),
      headers: {
        authorization: "Bearer test-api-key",
        "content-type": "application/json"
      },
      method: "POST"
    });

    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    assert.match(responseText, /fallback ok/);
    assert.equal(
      response.headers.get(ccrHelixFallbackHeader),
      "tool_loop_limit:maxTurns",
      `headers=${JSON.stringify([...response.headers])} upstream=${upstreamRequests.map((item) => item.headers[ccrHelixSkipCompressionHeader])}`
    );

    assert.equal(upstreamRequests.length, 2, "expected exactly one fallback retry");
    const [first, second] = upstreamRequests;
    assert.equal(first.headers[ccrHelixSkipCompressionHeader], undefined);
    assert.equal(second.headers[ccrHelixSkipCompressionHeader], "1");
    assert.ok(second.body.equals(first.body), "retry must resend the same request body");
  } finally {
    await closeServer(gateway);
    await closeServer(upstream);
    await gatewayService.stop();
    rmSync(dir, { force: true, recursive: true });
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function serverPort(server) {
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  return address.port;
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => server.closeAllConnections?.(), 1000);
    server.close((error) => {
      clearTimeout(timeout);
      error ? reject(error) : resolve();
    });
  });
}

function isLocalListenUnavailable(error) {
  return error && typeof error === "object" && (error.code === "EPERM" || error.code === "EACCES");
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
