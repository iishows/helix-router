/**
 * probeModelRecallSupport 单测(2026-10-16)
 *
 * 覆盖:五种上游协议(openai_chat_completions / openai_responses / anthropic_messages /
 * gemini_generate_content / gemini_interactions)的 tools 握手正/负信号、offline 文本回退、
 * 401/403 未知(skipped)、显式 400「不支持工具」直接落 none、请求体形状,以及无 baseUrl/空 model
 * 的早退。上游用 mock fetch 捕获。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { probeModelRecallSupport } from "@ccr/core/providers/probe.ts";

const OPENAI_PROVIDER = { api_key: "sk-test", baseurl: "https://api.example.com/v1", name: "Demo", type: "openai_chat_completions" };
const ANTHROPIC_PROVIDER = { api_key: "sk-test", baseurl: "https://api.example.com", name: "Demo", type: "anthropic_messages" };
const RESPONSES_PROVIDER = { api_key: "sk-test", baseurl: "https://api.example.com/v1", name: "Demo", type: "openai_responses" };
const GEMINI_PROVIDER = { api_key: "AIzaSyTestKey1234567890", baseurl: "https://generativelanguage.googleapis.com", name: "Demo", type: "gemini_generate_content" };

function withMockFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ body, headers: init?.headers, url: String(input) });
    return handler({ body, calls, init, url: String(input) });
  };
  return Promise.resolve()
    .then(() => run(calls))
    .finally(() => {
      globalThis.fetch = original;
    });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" }, status });
}

test("openai: 模型调用 recall_probe 工具 → depth=tools", async () => {
  const result = await withMockFetch(
    () => jsonResponse({ choices: [{ message: { role: "assistant", tool_calls: [{ function: { arguments: "{\"value\":1}", name: "recall_probe" }, id: "c1", type: "function" }] } }] }),
    async (calls) => {
      const probe = await probeModelRecallSupport(OPENAI_PROVIDER, "demo-model", "openai_chat_completions");
      assert.equal(probe.depth, "tools");
      assert.equal(probe.recallCapable, true);
      assert.equal(probe.skipped, undefined);
      return probe;
    }
  );
  assert.equal(result.model, "demo-model");
});

test("anthropic: content 含 tool_use(recall_probe) → depth=tools", async () => {
  const result = await withMockFetch(
    () => jsonResponse({ content: [{ input: { value: 1 }, name: "recall_probe", type: "tool_use" }], role: "assistant", stop_reason: "tool_use" }),
    () => probeModelRecallSupport(ANTHROPIC_PROVIDER, "demo-model", "anthropic_messages")
  );
  assert.equal(result.depth, "tools");
  assert.equal(result.recallCapable, true);
});

test("openai: 工具握手无 tool_call,但有文本 → 回退 offline", async () => {
  const result = await withMockFetch(
    () => jsonResponse({ choices: [{ message: { content: "ok", role: "assistant" } }] }),
    (calls) => probeModelRecallSupport(OPENAI_PROVIDER, "demo-model", "openai_chat_completions").then((probe) => {
      // 两次调用:tools 段 + offline 段;第二段 body 不带 tools。
      assert.equal(calls.length >= 2, true);
      assert.equal(calls[1].body.tools, undefined);
      return probe;
    })
  );
  assert.equal(result.depth, "offline");
  assert.equal(result.recallCapable, true);
});

test("anthropic: tool_use 名字不符(其它工具) → 不算 tools,回退 offline", async () => {
  const result = await withMockFetch(
    (ctx) => jsonResponse(
      ctx.body?.tools
        ? { content: [{ input: { value: 1 }, name: "other_tool", type: "tool_use" }] }
        : { content: [{ text: "ok", type: "text" }] }
    ),
    () => probeModelRecallSupport(ANTHROPIC_PROVIDER, "demo-model", "anthropic_messages")
  );
  assert.equal(result.depth, "offline");
  assert.equal(result.recallCapable, true);
});

test("401 → depth=none 且标记 skipped(未知,不落白名单)", async () => {
  const result = await withMockFetch(
    () => jsonResponse({ error: { message: "Unauthorized" } }, 401),
    () => probeModelRecallSupport(OPENAI_PROVIDER, "demo-model", "openai_chat_completions")
  );
  assert.equal(result.depth, "none");
  assert.equal(result.recallCapable, false);
  assert.equal(result.skipped, true);
  assert.equal(result.status, 401);
});

test("403 → depth=none 且标记 skipped", async () => {
  const result = await withMockFetch(
    () => jsonResponse({ error: { message: "Forbidden" } }, 403),
    () => probeModelRecallSupport(ANTHROPIC_PROVIDER, "demo-model", "anthropic_messages")
  );
  assert.equal(result.skipped, true);
  assert.equal(result.status, 403);
});

test("400「不支持工具」,且离线也无法作答 → depth=none", async () => {
  const result = await withMockFetch(
    (ctx) => (ctx.body?.tools
      ? jsonResponse({ error: { message: "tools unsupported" } }, 400)
      : jsonResponse({ error: { message: "bad request" } }, 400)),
    () => probeModelRecallSupport(OPENAI_PROVIDER, "demo-model", "openai_chat_completions")
  );
  assert.equal(result.depth, "none");
  assert.equal(result.recallCapable, false);
  assert.equal(result.skipped, undefined);
});

test("openai_responses: output 含 function_call(recall_probe) → depth=tools", async () => {
  const result = await withMockFetch(
    () => jsonResponse({ output: [{ arguments: "{\"value\":1}", call_id: "c1", name: "recall_probe", type: "function_call" }], output_text: "" }),
    () => probeModelRecallSupport(RESPONSES_PROVIDER, "demo-model", "openai_responses")
  );
  assert.equal(result.depth, "tools");
  assert.equal(result.recallCapable, true);
});

test("openai_responses: tools 段无 function_call,offline 段有 output_text → depth=offline", async () => {
  const result = await withMockFetch(
    (ctx) => (ctx.body?.tools
      ? jsonResponse({ output: [{ content: [{ text: "ok", type: "output_text" }], type: "message" }], output_text: "ok" })
      : jsonResponse({ output: [{ content: [{ text: "ok", type: "output_text" }], type: "message" }], output_text: "ok" })),
    (calls) => probeModelRecallSupport(RESPONSES_PROVIDER, "demo-model", "openai_responses").then((probe) => {
      assert.equal(calls[1].body.tools, undefined, "offline 段不带 tools");
      return probe;
    })
  );
  assert.equal(result.depth, "offline");
  assert.equal(result.recallCapable, true);
});

test("openai_responses: 401 → skipped(未知,不落缓存)", async () => {
  const result = await withMockFetch(
    () => jsonResponse({ error: { message: "Unauthorized" } }, 401),
    () => probeModelRecallSupport(RESPONSES_PROVIDER, "demo-model", "openai_responses")
  );
  assert.equal(result.skipped, true);
  assert.equal(result.status, 401);
});

test("openai_responses tools 请求体: input + max_output_tokens + function 工具声明 + tool_choice", async () => {
  const requestBody = await withMockFetch(
    () => jsonResponse({ output_text: "ok" }),
    async (calls) => {
      await probeModelRecallSupport(RESPONSES_PROVIDER, "demo-model", "openai_responses");
      return calls[0].body;
    }
  );
  assert.equal(requestBody.stream, false);
  assert.equal(typeof requestBody.input, "string");
  assert.equal(requestBody.messages, undefined, "Responses API 用 input 而非 messages");
  assert.equal(requestBody.max_output_tokens, 64);
  assert.equal(requestBody.tools[0].type, "function");
  assert.equal(requestBody.tools[0].name, "recall_probe");
  assert.equal(requestBody.tool_choice.name, "recall_probe");
  assert.equal(requestBody.tool_choice.type, "function");
});

test("gemini_generate_content: candidates parts 含 functionCall(recall_probe) → depth=tools", async () => {
  const result = await withMockFetch(
    () => jsonResponse({ candidates: [{ content: { parts: [{ functionCall: { args: { value: 1 }, name: "recall_probe" } }], role: "model" } }] }),
    () => probeModelRecallSupport(GEMINI_PROVIDER, "gemini-demo", "gemini_generate_content")
  );
  assert.equal(result.depth, "tools");
  assert.equal(result.recallCapable, true);
});

test("gemini_generate_content: tools 段无 functionCall,offline 段有 text → depth=offline", async () => {
  const result = await withMockFetch(
    (ctx) => jsonResponse(
      ctx.body?.tools
        ? { candidates: [{ content: { parts: [{ text: "ok" }], role: "model" } }] }
        : { candidates: [{ content: { parts: [{ text: "ok" }], role: "model" } }] }
    ),
    (calls) => probeModelRecallSupport(GEMINI_PROVIDER, "gemini-demo", "gemini_generate_content").then((probe) => {
      assert.equal(calls[1].body.tools, undefined, "offline 段不带 tools");
      return probe;
    })
  );
  assert.equal(result.depth, "offline");
  assert.equal(result.recallCapable, true);
});

test("gemini_generate_content: 403 → skipped", async () => {
  const result = await withMockFetch(
    () => jsonResponse({ error: { message: "Forbidden" } }, 403),
    () => probeModelRecallSupport(GEMINI_PROVIDER, "gemini-demo", "gemini_generate_content")
  );
  assert.equal(result.skipped, true);
  assert.equal(result.status, 403);
});

test("gemini_generate_content tools 请求体: contents + functionDeclarations + toolConfig ANY", async () => {
  const requestBody = await withMockFetch(
    () => jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
    async (calls) => {
      await probeModelRecallSupport(GEMINI_PROVIDER, "gemini-demo", "gemini_generate_content");
      return calls[0].body;
    }
  );
  assert.equal(requestBody.contents[0].parts[0].text.length > 0, true);
  assert.equal(requestBody.tools[0].functionDeclarations[0].name, "recall_probe");
  assert.equal(requestBody.tools[0].functionDeclarations[0].parameters.type, "OBJECT");
  assert.equal(requestBody.toolConfig.functionCallingConfig.mode, "ANY");
  assert.deepEqual(requestBody.toolConfig.functionCallingConfig.allowedFunctionNames, ["recall_probe"]);
});

test("gemini_interactions: steps 含 function_call(recall_probe) → depth=tools", async () => {
  const result = await withMockFetch(
    () => jsonResponse({ object: "interaction", steps: [{ arguments: { value: 1 }, name: "recall_probe", type: "function_call" }] }),
    () => probeModelRecallSupport(GEMINI_PROVIDER, "gemini-demo", "gemini_interactions")
  );
  assert.equal(result.depth, "tools");
  assert.equal(result.recallCapable, true);
});

test("gemini_interactions: tools 段无 function_call,offline 段有 model_output 文本 → depth=offline", async () => {
  const result = await withMockFetch(
    () => jsonResponse({ object: "interaction", steps: [{ content: [{ text: "ok", type: "text" }], type: "model_output" }] }),
    (calls) => probeModelRecallSupport(GEMINI_PROVIDER, "gemini-demo", "gemini_interactions").then((probe) => {
      // interactions 有两个候选端点 → tools 段连试两个(都带 tools),offline 段从第 3 个开始不带 tools。
      const offlineCall = calls.find((call) => call.body?.tools === undefined);
      assert.ok(offlineCall, "应存在不带 tools 的 offline 请求");
      assert.equal(offlineCall.body.input.length > 0, true);
      return probe;
    })
  );
  assert.equal(result.depth, "offline");
  assert.equal(result.recallCapable, true);
});

test("gemini_interactions: 401 → skipped", async () => {
  const result = await withMockFetch(
    () => jsonResponse({ error: { message: "Unauthorized" } }, 401),
    () => probeModelRecallSupport(GEMINI_PROVIDER, "gemini-demo", "gemini_interactions")
  );
  assert.equal(result.skipped, true);
  assert.equal(result.status, 401);
});

test("gemini_interactions 请求体: generation_config.max_output_tokens + function 工具 + allowed_tools", async () => {
  const requestBody = await withMockFetch(
    () => jsonResponse({ object: "interaction", steps: [{ content: [{ text: "ok" }], type: "model_output" }] }),
    async (calls) => {
      await probeModelRecallSupport(GEMINI_PROVIDER, "gemini-demo", "gemini_interactions");
      return calls[0].body;
    }
  );
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.generation_config.max_output_tokens, 64);
  assert.equal(requestBody.tools[0].type, "function");
  assert.equal(requestBody.tools[0].name, "recall_probe");
  assert.deepEqual(requestBody.tool_choice.allowed_tools.tools, ["recall_probe"]);
  assert.equal(requestBody.tool_choice.allowed_tools.mode, "any");
});

test("全端点网络失败(无 HTTP 状态)→ skipped(未知,不落缓存)", async () => {
  const result = await withMockFetch(
    () => { throw new Error("ECONNREFUSED"); },
    () => probeModelRecallSupport(OPENAI_PROVIDER, "demo-model", "openai_chat_completions")
  );
  assert.equal(result.depth, "none");
  assert.equal(result.recallCapable, false);
  assert.equal(result.skipped, true, "链路不可达属未知,不得谎报 none 被缓存");
  assert.equal(result.status, undefined);
});

test("无 baseUrl / 空 model → 直接 none(不发请求)", async () => {
  const result = await withMockFetch(
    () => { throw new Error("fetch must not be called"); },
    async () => {
      const noBase = await probeModelRecallSupport({ api_key: "k" }, "demo-model", "openai_chat_completions");
      const noModel = await probeModelRecallSupport(OPENAI_PROVIDER, "", "openai_chat_completions");
      return { noBase, noModel };
    }
  );
  assert.equal(result.noBase.depth, "none");
  assert.equal(result.noModel.depth, "none");
});

test("openai tools 请求体携带 recall_probe 声明 + 强制 tool_choice", async () => {
  const requestBody = await withMockFetch(
    () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    async (calls) => {
      await probeModelRecallSupport(OPENAI_PROVIDER, "demo-model", "openai_chat_completions");
      return calls[0].body;
    }
  );
  assert.equal(requestBody.stream, false);
  assert.equal(requestBody.tool_choice.function.name, "recall_probe");
  assert.equal(requestBody.tools[0].function.name, "recall_probe");
});

test("anthropic tools 请求体携带 recall_probe 声明 + 强制 tool_choice", async () => {
  const requestBody = await withMockFetch(
    () => jsonResponse({ content: [{ text: "ok", type: "text" }] }),
    async (calls) => {
      await probeModelRecallSupport(ANTHROPIC_PROVIDER, "demo-model", "anthropic_messages");
      return calls[0].body;
    }
  );
  assert.equal(requestBody.tool_choice.name, "recall_probe");
  assert.equal(requestBody.tools[0].name, "recall_probe");
  assert.ok(requestBody.tools[0].input_schema);
});
