import assert from "node:assert/strict";
import test from "node:test";
import { readHelixRecallPatterns, writeHelixRecallPatterns } from "@ccr/ui/pages/home/shared/extensions.ts";

test("readHelixRecallPatterns: 读白名单 + 排除表 + detected", () => {
  const text = JSON.stringify({
    helixApiUrl: "http://127.0.0.1:7788",
    recallModelDetected: true,
    recallModelExcludePatterns: ["gpt-4o-*"],
    recallModelPatterns: ["MiniMax-*", "DeepSeek-Flash"]
  });
  const result = readHelixRecallPatterns(text);
  assert.deepEqual(result.patterns, ["MiniMax-*", "DeepSeek-Flash"]);
  assert.deepEqual(result.excludePatterns, ["gpt-4o-*"]);
  assert.equal(result.detected, true);
});

test("readHelixRecallPatterns: 空 / 非法 JSON / 缺字段 → 空数组 + detected=false", () => {
  for (const text of ["", "   ", "not-json", "{}"]) {
    const result = readHelixRecallPatterns(text);
    assert.deepEqual(result.patterns, []);
    assert.deepEqual(result.excludePatterns, []);
    assert.equal(result.detected, false);
  }
});

test("readHelixRecallPatterns: 忽略非字符串元素", () => {
  const result = readHelixRecallPatterns(JSON.stringify({ recallModelPatterns: ["ok", 42, null, "also"] }));
  assert.deepEqual(result.patterns, ["ok", "also"]);
});

test("writeHelixRecallPatterns: 写入白名单 + 排除表,保留其它键", () => {
  const text = JSON.stringify({ helixApiUrl: "http://x", tokenBudget: 100000 });
  const next = JSON.parse(writeHelixRecallPatterns(text, ["MiniMax-*"], ["gpt-4o-*"]));
  assert.deepEqual(next.recallModelPatterns, ["MiniMax-*"]);
  assert.deepEqual(next.recallModelExcludePatterns, ["gpt-4o-*"]);
  assert.equal(next.helixApiUrl, "http://x");
  assert.equal(next.tokenBudget, 100000);
});

test("writeHelixRecallPatterns: 空数组删除键;detected=true 时写 recallModelDetected", () => {
  const text = JSON.stringify({ recallModelPatterns: ["old"], recallModelExcludePatterns: ["old-ex"] });
  const next = JSON.parse(writeHelixRecallPatterns(text, [], [], true));
  assert.equal("recallModelPatterns" in next, false);
  assert.equal("recallModelExcludePatterns" in next, false);
  assert.equal(next.recallModelDetected, true);
});

test("writeHelixRecallPatterns: detected=false 时删除 recallModelDetected", () => {
  const text = JSON.stringify({ recallModelDetected: true, recallModelPatterns: ["a"] });
  const next = JSON.parse(writeHelixRecallPatterns(text, ["a"], [], false));
  assert.equal("recallModelDetected" in next, false);
  assert.deepEqual(next.recallModelPatterns, ["a"]);
});

test("writeHelixRecallPatterns: 去除空白项与首尾空格", () => {
  const next = JSON.parse(writeHelixRecallPatterns("{}", ["  MiniMax-*  ", "", "  "], [" x "]));
  assert.deepEqual(next.recallModelPatterns, ["MiniMax-*"]);
  assert.deepEqual(next.recallModelExcludePatterns, ["x"]);
});

test("writeHelixRecallPatterns: 非法 JSON 输入 → 从空对象重建", () => {
  const next = JSON.parse(writeHelixRecallPatterns("not-json", ["a"], []));
  assert.deepEqual(next.recallModelPatterns, ["a"]);
});
