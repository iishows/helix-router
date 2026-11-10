import assert from "node:assert/strict";
import test from "node:test";
import { encode as gptEncode } from "gpt-tokenizer";
import { countTokensCapped, EXACT_TOKENIZE_MAX_CHARS } from "@ccr/core/token-count.ts";

test("countTokensCapped: 短文本与 gpt-tokenizer 完全一致", () => {
  for (const text of ["", "hello world", "中文测试 123", JSON.stringify({ role: "user", content: "hi" })]) {
    assert.equal(countTokensCapped(text), text ? gptEncode(text).length : 0);
  }
});

test("countTokensCapped: 超过精确上限的普通文本,估算误差 < 20%", () => {
  const unit = '{"role":"user","content":"lorem ipsum dolor sit amet 12345 "}';
  const text = "[" + Array.from({ length: 9000 }, () => unit).join(",") + "]";
  assert.ok(text.length > EXACT_TOKENIZE_MAX_CHARS, `用例必须超过上限,实际 ${text.length}`);
  const exact = gptEncode(text).length;
  const estimated = countTokensCapped(text);
  const error = Math.abs(estimated - exact) / exact;
  assert.ok(error < 0.2, `估算误差过大: estimated=${estimated} exact=${exact} (${(error * 100).toFixed(1)}%)`);
});

test("countTokensCapped: 病态长重复串(4MB 'a')必须快速返回,不得阻塞事件循环", () => {
  // 事故回归:gpt-tokenizer 对 4MB 重复串 20 秒仍未完成;同步调用会卡死整个网关。
  const text = "a".repeat(4 * 1024 * 1024);
  const started = Date.now();
  const tokens = countTokensCapped(text);
  const elapsed = Date.now() - started;
  assert.ok(tokens > 0);
  assert.ok(elapsed < 600, `4MB 病态串耗时 ${elapsed}ms,应 <600ms(不得走全量 BPE)`);
});

test("countTokensCapped: 超长 base64(8MB)快速返回", () => {
  const text = "QUJD".repeat(2 * 1024 * 1024);
  const started = Date.now();
  const tokens = countTokensCapped(text);
  const elapsed = Date.now() - started;
  assert.ok(tokens > 0);
  assert.ok(elapsed < 600, `8MB base64 耗时 ${elapsed}ms,应 <600ms`);
});
