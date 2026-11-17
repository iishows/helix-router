/**
 * V1.17:base64 图片 → COS URL。
 *
 * 实测 tool 消息里的 base64 按文本计费(同一张图 53k tokens),http 图片 URL 只花 ~220。
 * 这里用本地假 MCP 服务验证:替换形状、去重缓存、失败回退、生产 transform 接线。
 */

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { PNG } from "pngjs";
import {
  uploadMessagesMedia,
  uploadLargeToolOutputs,
  _clearUploadCacheForTest,
  COS_UPLOAD_DEFAULTS
} from "@ccr/core/plugins/built-ins/helix-compressor/cos-upload.ts";
import { helixCompressorTransform } from "@ccr/core/plugins/built-ins/helix-compressor.ts";

const TEST_MODEL = "MiniMax-M2.7";

function startFakeMcp({ fail = false, maxBodyBytes = Infinity } = {}) {
  let calls = 0;
  let initCalls = 0;
  let maxBodySeen = 0;
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      if (payload.method === "initialize") {
        initCalls += 1;
      }
      maxBodySeen = Math.max(maxBodySeen, Buffer.byteLength(body, "utf-8"));
      if (Buffer.byteLength(body, "utf-8") > maxBodyBytes) {
        res.statusCode = 413;
        res.end("request body exceeds 4194304 bytes");
        return;
      }
      if (fail) {
        res.statusCode = 500;
        res.end("boom");
        return;
      }
      if (payload.method === "initialize") {
        res.setHeader("mcp-session-id", "test-session");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} }));
        return;
      }
      if (payload.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (payload.method === "tools/call") {
        calls += 1;
        seen.push(payload.params?.arguments ?? {});
        const name = payload.params?.arguments?.filename ?? "image";
        const text = `✅ 已上传到 COS\nurl: https://cos.example.test/${calls}-${name}`;
        res.setHeader("content-type", "text/event-stream");
        res.end(`event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { content: [{ type: "text", text }] }
        })}\n\n`);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/mcp`, calls: () => calls, initCalls: () => initCalls, seen: () => seen, maxBodySeen: () => maxBodySeen, close: () => server.close() });
    });
  });
}

function settingsFor(url, overrides = {}) {
  return {
    ...COS_UPLOAD_DEFAULTS,
    enabled: true,
    mcpUrl: url,
    mcpToken: "test-token",
    minDataChars: 10,
    timeoutMs: 5000,
    scope: "all",
    ...overrides
  };
}

const IMAGE_DATA = "A".repeat(4096);

function messages() {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: "看看这张图" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: IMAGE_DATA } }
      ]
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }]
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: IMAGE_DATA } }]
      }]
    }
  ];
}

test("scope=all:用户图换成 URL,工具图换成短文本 URL,消息里不再有 base64", async () => {
  _clearUploadCacheForTest();
  const mcp = await startFakeMcp();
  try {
    const result = await uploadMessagesMedia(messages(), settingsFor(mcp.url));
    assert.equal(result.uploaded, 2);

    const top = result.messages[0].content[1];
    assert.equal(top.type, "image");
    assert.equal(top.source.type, "url");
    assert.match(top.source.url, /^https:\/\/cos\.example\.test\//);

    const nested = result.messages[2].content[0].content[0];
    assert.equal(nested.type, "text");
    assert.match(nested.text, /^\[image uploaded: https:\/\/cos\.example\.test\//);

    assert.ok(!JSON.stringify(result.messages).includes(IMAGE_DATA));
  } finally {
    mcp.close();
  }
});

test("scope=tool:只替换工具图,用户图保持原样", async () => {
  _clearUploadCacheForTest();
  const mcp = await startFakeMcp();
  try {
    const result = await uploadMessagesMedia(messages(), settingsFor(mcp.url, { scope: "tool" }));
    assert.equal(result.uploaded, 1);
    assert.equal(result.messages[0].content[1].source.type, "base64");
    assert.equal(result.messages[2].content[0].content[0].type, "text");
  } finally {
    mcp.close();
  }
});

test("同一张图只上传一次(sha256 缓存)", async () => {
  _clearUploadCacheForTest();
  const mcp = await startFakeMcp();
  try {
    const first = await uploadMessagesMedia(messages(), settingsFor(mcp.url));
    const second = await uploadMessagesMedia(messages(), settingsFor(mcp.url));
    assert.equal(first.uploaded, 2);
    // 第二轮的图片已是 URL,不会再被收集;再构造一份原始消息验证缓存命中
    const third = await uploadMessagesMedia(messages(), settingsFor(mcp.url));
    assert.equal(third.uploaded, 2);
    assert.equal(mcp.calls(), 1, "同一张 base64 只应调用一次上传");
  } finally {
    mcp.close();
  }
});

test("上传失败:消息保持原样,返回 failed 计数", async () => {
  _clearUploadCacheForTest();
  const mcp = await startFakeMcp({ fail: true });
  try {
    const before = messages();
    const result = await uploadMessagesMedia(before, settingsFor(mcp.url));
    assert.equal(result.uploaded, 0);
    assert.equal(result.failed, 2, "两个媒体块都应计失败,但只尝试一次上传");
    assert.equal(mcp.calls(), 0, "会话初始化失败时不应尝试 tools/call");
    assert.equal(JSON.stringify(result.messages), JSON.stringify(before));
  } finally {
    mcp.close();
  }
});

test("生产路径:transform 先把工具图上传成 URL,不再折占位符", async () => {
  _clearUploadCacheForTest();
  const mcp = await startFakeMcp();
  try {
    const result = await helixCompressorTransform(
      {
        body: {
          model: TEST_MODEL,
          messages: messages()
        },
        headers: {},
        method: "POST",
        path: "/v1/messages",
        requestId: "test-cos-upload-1",
        routedModel: TEST_MODEL,
        url: "/v1/messages"
      },
      {
        config: {},
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        paths: { configDir: "", dataDir: "", pluginDataDir: "" },
        permissions: [],
        pluginId: "helix-compressor",
        pluginConfig: {
          imageUploadEnabled: true,
          imageUploadMcpUrl: mcp.url,
          imageUploadMcpToken: "test-token",
          imageUploadMinChars: 10,
          imageUploadScope: "all"
        },
        openSqliteStore: async () => { throw new Error("not implemented"); }
      }
    );

    assert.ok(result);
    const serialized = JSON.stringify(result.body.messages);
    assert.ok(serialized.includes("https://cos.example.test/"), "应包含 COS URL");
    assert.ok(!serialized.includes(IMAGE_DATA), "不应再包含 base64");
    assert.ok(!serialized.includes("⟦QA:"), "图片已上传,不应再折占位符");
  } finally {
    mcp.close();
  }
});

test("OpenAI 形状 role:tool 的字符串化块数组也会被替换", async () => {
  _clearUploadCacheForTest();
  const mcp = await startFakeMcp();
  try {
    const input = [
      {
        role: "tool",
        tool_call_id: "c1",
        content: JSON.stringify([{ type: "image", source: { type: "base64", media_type: "image/png", data: IMAGE_DATA } }])
      }
    ];
    const result = await uploadMessagesMedia(input, settingsFor(mcp.url, { scope: "tool" }));
    assert.equal(result.uploaded, 1);
    const content = result.messages[0].content;
    assert.equal(typeof content, "string");
    const parsed = JSON.parse(content);
    assert.equal(parsed[0].type, "text");
    assert.match(parsed[0].text, /^\[image uploaded: https:\/\/cos\.example\.test\//);
  } finally {
    mcp.close();
  }
});

test("MCP 故障后退避:60s 内不重复初始化", async () => {
  _clearUploadCacheForTest();
  const mcp = await startFakeMcp({ fail: true });
  try {
    const s = settingsFor(mcp.url);
    await uploadMessagesMedia(messages(), s);
    await uploadMessagesMedia(messages(), s);
    assert.equal(mcp.initCalls(), 1, "退避窗口内不应再次尝试 initialize");
  } finally {
    mcp.close();
  }
});

test("强制上传:上传失败时消息里绝不保留 base64,改为文本标记", async () => {
  _clearUploadCacheForTest();
  const imageData = "A".repeat(8192);
  const input = [
    {
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: imageData } }
      ]
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "t1",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: imageData } }]
      }]
    }
  ];

  const result = await helixCompressorTransform(
    {
      body: { model: TEST_MODEL, messages: input },
      headers: {},
      method: "POST",
      path: "/v1/messages",
      requestId: "test-cos-no-base64",
      routedModel: TEST_MODEL,
      url: "/v1/messages"
    },
    {
      config: {},
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      paths: { configDir: "", dataDir: "", pluginDataDir: "" },
      permissions: [],
      pluginId: "helix-compressor",
      pluginConfig: {
        imageUploadEnabled: true,
        imageUploadMcpUrl: "http://127.0.0.1:1/mcp",
        imageUploadMcpToken: "test-token",
        imageUploadMinChars: 1,
        imageUploadTimeoutMs: 1000
      },
      openSqliteStore: async () => { throw new Error("not implemented"); }
    }
  );

  assert.ok(result);
  const serialized = JSON.stringify(result.body.messages);
  assert.ok(!serialized.includes(imageData), "绝不能把 base64 发给上游");
  assert.ok(serialized.includes("[image omitted:"), "应替换成明确的文本标记");
  assert.ok(!serialized.includes("⟦QA:"), "不回传原文,也不留下会召回大图的占位符");
});

test("大文本工具输出:超过阈值上传并替换为 URL+预览,小文本不动", async () => {
  _clearUploadCacheForTest();
  const mcp = await startFakeMcp();
  try {
    const big = "L".repeat(40 * 1024);
    const small = "short output";
    const input = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: big }]
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t2", content: small }]
      }
    ];
    const result = await uploadLargeToolOutputs(input, settingsFor(mcp.url));
    assert.equal(result.uploaded, 1);
    const replaced = result.messages[0].content[0].content;
    assert.match(replaced, /^\[tool output uploaded: \d+ chars; url: https:\/\/cos\.example\.test\//);
    assert.ok(!replaced.includes(big));
    assert.equal(result.messages[1].content[0].content, small);
    assert.equal(mcp.seen()[0].content_type, "text/plain");
  } finally {
    mcp.close();
  }
});

test("大文本:块数组里的多个 text 块合并成一个 URL 标记,图片块保留", async () => {
  _clearUploadCacheForTest();
  const mcp = await startFakeMcp();
  try {
    const input = [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "t1",
        content: [
          { type: "text", text: "A".repeat(20 * 1024) },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "text", text: "B".repeat(20 * 1024) }
        ]
      }]
    }];
    const result = await uploadLargeToolOutputs(input, settingsFor(mcp.url));
    assert.equal(result.uploaded, 1);
    const inner = result.messages[0].content[0].content;
    assert.equal(inner.length, 2, "两个 text 块应收敛为一个标记,图片块保留");
    assert.equal(inner[0].type, "text");
    assert.match(inner[0].text, /^\[tool output uploaded: /);
    assert.equal(inner[1].type, "image");
  } finally {
    mcp.close();
  }
});

test("大文本:OpenAI role:tool 字符串整体替换;重复内容只上传一次", async () => {
  _clearUploadCacheForTest();
  const mcp = await startFakeMcp();
  try {
    const big = JSON.stringify({ rows: Array.from({ length: 3000 }, (_, i) => ({ i, v: "x".repeat(20) })) });
    const input = [{ role: "tool", tool_call_id: "c1", content: big }];
    const first = await uploadLargeToolOutputs(input, settingsFor(mcp.url));
    assert.equal(first.uploaded, 1);
    assert.match(first.messages[0].content, /^\[tool output uploaded: /);
    assert.equal(mcp.seen()[0].content_type, "application/json", "JSON 内容应按 application/json 上传");

    const second = await uploadLargeToolOutputs(input, settingsFor(mcp.url));
    assert.equal(second.uploaded, 1);
    assert.equal(mcp.calls(), 1, "同一内容只上传一次");
  } finally {
    mcp.close();
  }
});

test("大文本上传失败:内容保持原样,不产生 URL 标记", async () => {
  _clearUploadCacheForTest();
  const mcp = await startFakeMcp({ fail: true });
  try {
    const big = "Z".repeat(40 * 1024);
    const input = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] }];
    const result = await uploadLargeToolOutputs(input, settingsFor(mcp.url));
    assert.equal(result.uploaded, 0);
    assert.equal(result.messages[0].content[0].content, big);
  } finally {
    mcp.close();
  }
});

test("生产路径:大文本工具输出在 transform 中被换成 COS URL", async () => {
  _clearUploadCacheForTest();
  const mcp = await startFakeMcp();
  try {
    const big = "Q".repeat(40 * 1024);
    const result = await helixCompressorTransform(
      {
        body: {
          model: TEST_MODEL,
          messages: [
            { role: "user", content: "run it" },
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] }
          ]
        },
        headers: {},
        method: "POST",
        path: "/v1/messages",
        requestId: "test-cos-text-1",
        routedModel: TEST_MODEL,
        url: "/v1/messages"
      },
      {
        config: {},
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        paths: { configDir: "", dataDir: "", pluginDataDir: "" },
        permissions: [],
        pluginId: "helix-compressor",
        pluginConfig: {
          imageUploadEnabled: true,
          imageUploadMcpUrl: mcp.url,
          imageUploadMcpToken: "test-token",
          imageUploadMinChars: 1,
          textUploadMinChars: 1024
        },
        openSqliteStore: async () => { throw new Error("not implemented"); }
      }
    );

    assert.ok(result);
    const serialized = JSON.stringify(result.body.messages);
    assert.ok(serialized.includes("[tool output uploaded:"), "应包含上传标记");
    assert.ok(serialized.includes("https://cos.example.test/"), "应包含 COS URL");
    assert.ok(!serialized.includes(big), "原始大文本不应再发给上游");
  } finally {
    mcp.close();
  }
});

// ============= 超过 MCP 请求体上限:先压缩再上传 =============

/** 生成不可压缩(噪声)PNG:用来逼出「原图超过请求体预算」的场景。 */
function noisyPng(width, height) {
  const png = new PNG({ width, height });
  let seed = 0x12345678;
  for (let i = 0; i < png.data.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    png.data[i] = seed & 0xff;
    png.data[i + 1] = (seed >>> 8) & 0xff;
    png.data[i + 2] = (seed >>> 16) & 0xff;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

test("超过请求体上限的图片先压缩再上传,不再 413", async () => {
  _clearUploadCacheForTest();
  const limit = 256 * 1024;
  const mcp = await startFakeMcp({ maxBodyBytes: limit });
  try {
    const data = noisyPng(700, 700).toString("base64");
    assert.ok(data.length > limit, "测试前置:原图 base64 必须超过上限");

    const input = [{
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }]
    }];
    const result = await uploadMessagesMedia(input, settingsFor(mcp.url, { maxBodyBytes: limit }));

    assert.equal(result.uploaded, 1, "压缩后应上传成功");
    assert.equal(mcp.calls(), 1);
    assert.ok(mcp.maxBodySeen() <= limit, `请求体必须在 ${limit} 字节内,实测 ${mcp.maxBodySeen()}`);
    assert.equal(mcp.seen()[0].content_type, "image/jpeg", "不透明 PNG 压缩后按 JPEG 上传");
    assert.match(result.messages[0].content[0].source.url, /^https:\/\/cos\.example\.test\//);
    assert.ok(!JSON.stringify(result.messages).includes(data), "消息里不应留下原 base64");
  } finally {
    mcp.close();
  }
});

test("上限以内的小图不做压缩,原样上传", async () => {
  _clearUploadCacheForTest();
  const limit = 1024 * 1024;
  const mcp = await startFakeMcp({ maxBodyBytes: limit });
  try {
    const result = await uploadMessagesMedia(messages(), settingsFor(mcp.url, { maxBodyBytes: limit }));
    assert.equal(result.uploaded, 2);
    assert.equal(mcp.seen()[0].content_type, "image/png", "小图保持原格式");
    assert.ok(mcp.maxBodySeen() <= limit);
  } finally {
    mcp.close();
  }
});

test("超大且无法解码的媒体:放弃上传,不触发 413", async () => {
  _clearUploadCacheForTest();
  const limit = 128 * 1024;
  const mcp = await startFakeMcp({ maxBodyBytes: limit });
  try {
    const junk = "A".repeat(200 * 1024); // 不是合法图片,压缩无从下手
    const input = [{
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: junk } }]
    }];
    const result = await uploadMessagesMedia(input, settingsFor(mcp.url, { maxBodyBytes: limit }));
    assert.equal(result.uploaded, 0);
    assert.equal(result.failed, 1);
    assert.equal(mcp.calls(), 0, "不应发出必被 413 拒绝的请求");
    assert.ok(mcp.maxBodySeen() <= limit, "不得把超限请求打到 /mcp");
  } finally {
    mcp.close();
  }
});

test("超过请求体上限的文本:跳过上传,不触发 413", async () => {
  _clearUploadCacheForTest();
  const limit = 128 * 1024;
  const mcp = await startFakeMcp({ maxBodyBytes: limit });
  try {
    const big = "T".repeat(150 * 1024); // base64 后 ~200KB > 预算
    const input = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] }];
    const result = await uploadLargeToolOutputs(input, settingsFor(mcp.url, { maxBodyBytes: limit, textMinChars: 10 }));
    assert.equal(result.uploaded, 0);
    assert.equal(result.failed, 1);
    assert.equal(mcp.calls(), 0);
    assert.ok(mcp.maxBodySeen() <= limit, "不得把超限请求打到 /mcp");
    assert.equal(result.messages[0].content[0].content, big, "原文保持不动,交给占位符兜底");
  } finally {
    mcp.close();
  }
});
