import assert from "node:assert/strict";
import test from "node:test";
import { compactBase64ImagePayloads } from "@ccr/core/observability/request-log-body.ts";

const largeBase64 = "A".repeat(64 * 1024);

test("request log body compaction replaces data URL images without parsing the JSON tree", () => {
  const input = Buffer.from(JSON.stringify({
    image_url: { url: `data:image/png;base64,${largeBase64}` },
    model: "vision-model"
  }));
  const compacted = compactBase64ImagePayloads(input);
  const parsed = JSON.parse(compacted.buffer.toString("utf8"));

  assert.equal(compacted.compacted, true);
  assert.equal(compacted.imageCount, 1);
  assert.equal(compacted.omittedBytes, largeBase64.length);
  assert.equal(parsed.model, "vision-model");
  assert.match(parsed.image_url.url, /^data:image\/png;base64,\[base64 image omitted from log;/);
  assert.ok(compacted.buffer.byteLength < 512);
});

test("request log body compaction recognizes Anthropic, Gemini, and OpenAI image payloads", () => {
  const input = Buffer.from(JSON.stringify({
    anthropic: {
      source: { data: largeBase64, media_type: "image/jpeg", type: "base64" }
    },
    gemini: {
      inline_data: { data: largeBase64, mime_type: "image/webp" }
    },
    openai: {
      b64_json: largeBase64
    }
  }));
  const compacted = compactBase64ImagePayloads(input);
  const parsed = JSON.parse(compacted.buffer.toString("utf8"));

  assert.equal(compacted.imageCount, 3);
  assert.match(parsed.anthropic.source.data, /^\[base64 image omitted from log;/);
  assert.match(parsed.gemini.inline_data.data, /^\[base64 image omitted from log;/);
  assert.match(parsed.openai.b64_json, /^\[base64 image omitted from log;/);
});

test("request log body compaction leaves small and non-image Base64 values untouched", () => {
  const input = Buffer.from(JSON.stringify({
    audio: { data: largeBase64, media_type: "audio/wav", type: "base64" },
    image: `data:image/png;base64,${"A".repeat(1024)}`
  }));
  const compacted = compactBase64ImagePayloads(input);

  assert.equal(compacted.compacted, false);
  assert.strictEqual(compacted.buffer, input);
});

test("request log body compaction does not borrow image context from an adjacent object", () => {
  const audioBase64 = "A".repeat(64 * 1024);
  const input = Buffer.from(JSON.stringify([
    { mime_type: "image/png", type: "base64" },
    { data: audioBase64, media_type: "audio/wav", type: "base64" }
  ]));
  const compacted = compactBase64ImagePayloads(input);

  assert.equal(compacted.compacted, false);
  assert.equal(JSON.parse(compacted.buffer.toString("utf8"))[1].data, audioBase64);
});

test("request log body compaction handles the escaped JSON-string shape real proxies store", () => {
  // 真实流量:OpenAI 形状的 `role:"tool"` 消息 content 是"块数组的 JSON 字符串",
  //   所以媒体块被**双层转义**:`…{\"type\":\"base64\",\"data\":\"iVBOR…`。
  //   旧实现只认裸 `"data"`,这类 body 从没被压过 → 请求日志涨到几百 MB。
  const big = `${"iVBORw0KGgo".padEnd(32, "A")}${"A".repeat(64 * 1024)}`;
  const innerBlocks = JSON.stringify([{ type: "image", source: { type: "base64", media_type: "image/png", data: big } }]);
  const input = Buffer.from(JSON.stringify({
    messages: [{ role: "tool", tool_call_id: "c1", content: innerBlocks }]
  }));
  const compacted = compactBase64ImagePayloads(input);

  assert.equal(compacted.compacted, true);
  assert.equal(compacted.imageCount, 1);
  assert.ok(compacted.buffer.byteLength < 1024, "压缩后应远小于原 body");
  // 占位符必须落在内层 data 的位置,且外层 JSON 仍可解析。
  const outer = JSON.parse(compacted.buffer.toString("utf8"));
  const restoredInner = JSON.parse(outer.messages[0].content);
  assert.match(restoredInner[0].source.data, /^\[base64 image omitted from log;/);
});

test("request log body compaction handles escaped b64_json too", () => {
  const big = "A".repeat(64 * 1024);
  const inner = JSON.stringify({ b64_json: big, model: "gpt-image-1" });
  const input = Buffer.from(JSON.stringify({ choices: [{ message: { content: inner } }] }));
  const compacted = compactBase64ImagePayloads(input);

  assert.equal(compacted.compacted, true);
  assert.equal(compacted.imageCount, 1);
  const outer = JSON.parse(compacted.buffer.toString("utf8"));
  const restoredInner = JSON.parse(outer.choices[0].message.content);
  assert.match(restoredInner.b64_json, /^\[base64 image omitted from log;/);
});

test("request log body compaction still ignores escaped non-image (audio) base64", () => {
  const big = "A".repeat(64 * 1024);
  const inner = JSON.stringify({ audio: { data: big, media_type: "audio/wav", type: "base64" } });
  const input = Buffer.from(JSON.stringify({ messages: [{ role: "tool", content: inner }] }));
  const compacted = compactBase64ImagePayloads(input);

  assert.equal(compacted.compacted, false);
});
