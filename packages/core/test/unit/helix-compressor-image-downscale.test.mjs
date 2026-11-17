/**
 * V1.16:大图降采样。
 *
 * 事故:1.2MB JPEG 的 1.64MB base64 被上游按文本计 token(≈110 万),撑爆 1M 上下文。
 * 历史图可以折成召回占位符,但**当前轮用户上传的图必须让模型看见**,只能缩小。
 *
 * 验收点:
 *   - 大图 → 最长边 ≤ maxEdge、base64 显著变小、仍可解码;
 *   - 小图 / 非图片 / 解码失败 → 原样保留(绝不因降采样让请求失败);
 *   - 重复出现 → 命中缓存;
 *   - 生产路径 transform:当前轮图被缩小且**不被折成占位符**;baseline header 仍是原值。
 */

import assert from "node:assert/strict";
import test from "node:test";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import {
  downscaleImageData,
  downscaleImageDataAsync,
  downscaleMessagesMedia,
  IMAGE_DOWNSCALE_DEFAULTS,
  _clearDownscaleCacheForTest
} from "@ccr/core/plugins/built-ins/helix-compressor/image-downscale.ts";
import { helixCompressorTransform } from "@ccr/core/plugins/built-ins/helix-compressor.ts";
import { configureCacheDir, get as getRecallEntry } from "@ccr/core/observability/helix-recall-local-store";

const TEST_MODEL = "MiniMax-M2.7";
const TEST_SETTINGS = { ...IMAGE_DOWNSCALE_DEFAULTS, minDataChars: 1024 };

function makeJpegBase64(width, height, quality = 88) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      rgba[o] = (x * 7 + y * 3) & 255;
      rgba[o + 1] = (x * 3 + y * 11) & 255;
      rgba[o + 2] = (x * 13 + y * 5) & 255;
      rgba[o + 3] = 255;
    }
  }
  return jpeg.encode({ data: rgba, width, height }, quality).data.toString("base64");
}

function makePngBase64(width, height) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      png.data[o] = (x * 5 + y) & 255;
      png.data[o + 1] = (x + y * 7) & 255;
      png.data[o + 2] = (x * y) & 255;
      png.data[o + 3] = x < width / 2 ? 0 : 255; // 左半透明 → 必须保持 PNG
    }
  }
  return PNG.sync.write(png).toString("base64");
}

function mockContext(overrides = {}) {
  return {
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    paths: { configDir: "", dataDir: "", pluginDataDir: "" },
    permissions: [],
    pluginConfig: {},
    pluginId: "helix-compressor",
    openSqliteStore: async () => { throw new Error("not implemented"); },
    ...overrides
  };
}

test("JPEG 大图降采样:显著变小、最长边 ≤ maxEdge、仍可解码", () => {
  _clearDownscaleCacheForTest();
  const source = makeJpegBase64(1600, 1200);
  assert.ok(source.length > TEST_SETTINGS.minDataChars, "测试图应超过降采样门槛");

  const result = downscaleImageData(source, "image/jpeg", TEST_SETTINGS);
  assert.ok(result, "大图应被降采样");
  assert.equal(result.mime, "image/jpeg");
  assert.ok(result.data.length < source.length, "base64 必须变小");
  assert.equal(result.savedChars, source.length - result.data.length);

  const decoded = jpeg.decode(Buffer.from(result.data, "base64"));
  assert.ok(Math.max(decoded.width, decoded.height) <= IMAGE_DOWNSCALE_DEFAULTS.maxEdge);
});

test("PNG 带 alpha:保持 PNG,不被转成 JPEG(避免透明底变黑)", () => {
  _clearDownscaleCacheForTest();
  const source = makePngBase64(1200, 900);
  assert.ok(source.length > TEST_SETTINGS.minDataChars);

  const result = downscaleImageData(source, "image/png", TEST_SETTINGS);
  assert.ok(result, "大 PNG 应被降采样");
  assert.equal(result.mime, "image/png");

  const decoded = PNG.sync.read(Buffer.from(result.data, "base64"));
  assert.ok(Math.max(decoded.width, decoded.height) <= IMAGE_DOWNSCALE_DEFAULTS.maxEdge);
  // 左侧 1/4 处取点:源图左半完全透明,降采样后仍应为 0
  const probeX = Math.max(0, Math.floor(decoded.width / 4));
  const probeY = Math.floor(decoded.height / 2);
  assert.equal(decoded.data[(probeY * decoded.width + probeX) * 4 + 3], 0, "透明区域必须保留");
});

test("小图 / 解码失败 / 关闭开关:原样返回 undefined", () => {
  _clearDownscaleCacheForTest();
  const tiny = makeJpegBase64(200, 150);
  assert.equal(downscaleImageData(tiny, "image/jpeg", IMAGE_DOWNSCALE_DEFAULTS), undefined);
  assert.equal(downscaleImageData("!!!not-base64!!!", "image/jpeg", IMAGE_DOWNSCALE_DEFAULTS), undefined);
  const source = makeJpegBase64(1600, 1200);
  assert.equal(
    downscaleImageData(source, "image/jpeg", { ...IMAGE_DOWNSCALE_DEFAULTS, enabled: false }),
    undefined
  );
});

test("同一张图重复调用命中缓存,结果逐字节一致", () => {
  _clearDownscaleCacheForTest();
  const source = makeJpegBase64(1600, 1200);
  const first = downscaleImageData(source, "image/jpeg", TEST_SETTINGS);
  const second = downscaleImageData(source, "image/jpeg", TEST_SETTINGS);
  assert.ok(first && second);
  assert.equal(second.data, first.data);
});

test("downscaleMessagesMedia:copy-on-write,不改原消息;tool_result 内嵌图也处理", async () => {
  _clearDownscaleCacheForTest();
  const imageData = makeJpegBase64(1600, 1200);
  const original = [
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageData } }
      ]
    },
    { role: "user", content: [{ type: "tree", nodes: [] }] },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageData } }]
      }]
    }
  ];
  const snapshot = JSON.stringify(original);

  const { messages, stats } = await downscaleMessagesMedia(original, TEST_SETTINGS);

  assert.equal(stats.count, 2, "顶层图 + tool_result 内嵌图都应被处理");
  assert.ok(stats.savedChars > 0);
  assert.equal(JSON.stringify(original), snapshot, "原始 messages 不允许被修改");
  assert.notEqual(messages[0].content[1].source.data, imageData);
  assert.equal(messages[1].content[0].type, "tree", "非媒体块原样保留");
  assert.equal(messages[2].content[0].content[0].type, "image");
  assert.notEqual(messages[2].content[0].content[0].source.data, imageData);
});

test("生产路径:当前轮大图被缩小且不折成占位符;baseline header 仍是原值", async () => {
  _clearDownscaleCacheForTest();
  const imageData = makeJpegBase64(1600, 1200);
  const result = await helixCompressorTransform(
    {
      body: {
        model: TEST_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "看看这张图" },
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageData } }
            ]
          }
        ]
      },
      headers: {},
      method: "POST",
      path: "/v1/messages",
      requestId: "test-downscale-1",
      routedModel: TEST_MODEL,
      url: "/v1/messages"
    },
    mockContext({ pluginConfig: { imageDownscaleMinChars: 1024 } })
  );

  assert.ok(result);
  const blocks = result.body.messages.at(-1).content;
  const image = blocks.find((b) => b.type === "image");
  assert.ok(image, "当前轮图片必须保留给模型看,不能被折成占位符");
  assert.ok(image.source.data.length < imageData.length, "图片必须被缩小");
  const decoded = jpeg.decode(Buffer.from(image.source.data, "base64"));
  assert.ok(Math.max(decoded.width, decoded.height) <= IMAGE_DOWNSCALE_DEFAULTS.maxEdge);

  const baseline = Number(result.headers["x-helix-compressor-baseline-tokens"]);
  const compressed = Number(result.headers["x-helix-compressor-compressed-tokens"]);
  assert.ok(baseline > compressed, `baseline(${baseline}) 应大于压缩后(${compressed})`);
});

test("单请求媒体总量预算:多张中等图累加超限时继续压到预算内", async () => {
  _clearDownscaleCacheForTest();
  const one = makeJpegBase64(900, 700);
  const images = [one, one, one];
  const totalBefore = images.reduce((sum, data) => sum + data.length, 0);
  assert.ok(totalBefore > 80 * 1024, `需要构造超预算输入,实际 ${totalBefore}`);

  const settings = { ...IMAGE_DOWNSCALE_DEFAULTS, totalMaxChars: 80 * 1024 };
  const messages = [{
    role: "user",
    content: images.map((data) => ({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data }
    }))
  }];

  const { messages: out, stats } = await downscaleMessagesMedia(messages, settings);
  const totalAfter = out[0].content.reduce((sum, block) => sum + block.source.data.length, 0);
  assert.ok(stats.count >= 1);
  assert.ok(totalAfter < totalBefore, "总量必须下降");
  assert.ok(totalAfter <= settings.totalMaxChars, `${totalAfter} 应 ≤ ${settings.totalMaxChars}`);
  for (const block of out[0].content) {
    const decoded = jpeg.decode(Buffer.from(block.source.data, "base64"));
    assert.ok(decoded.width > 0);
  }
});

test("生产路径:最近 Read 返回的大图被降采样而不是折成占位符", async () => {
  _clearDownscaleCacheForTest();
  const imageData = makeJpegBase64(1600, 1200);
  const result = await helixCompressorTransform(
    {
      body: {
        model: TEST_MODEL,
        messages: [
          { role: "user", content: [{ type: "text", text: "看看这张图" }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "x.jpeg" } }]
          },
          {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "toolu_read",
              content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageData } }]
            }]
          }
        ]
      },
      headers: {},
      method: "POST",
      path: "/v1/messages",
      requestId: "test-downscale-read-1",
      routedModel: TEST_MODEL,
      url: "/v1/messages"
    },
    mockContext({ pluginConfig: { imageDownscaleMinChars: 1024 } })
  );

  assert.ok(result);
  const last = result.body.messages.at(-1);
  const block = last.content.find((b) => b.type === "tool_result");
  assert.ok(block, "tool_result 结构必须保留");
  assert.equal(block.content[0].type, "image", "最近 Read 的图应保留给模型看,不应折成占位符");
  assert.ok(block.content[0].source.data.length < imageData.length, "图片必须被缩小");
  const decoded = jpeg.decode(Buffer.from(block.content[0].source.data, "base64"));
  assert.ok(Math.max(decoded.width, decoded.height) <= IMAGE_DOWNSCALE_DEFAULTS.maxEdge);
});

test("缓存按参数区分:更严格的 targetMaxChars 必须重新计算并产出更小结果", async () => {
  _clearDownscaleCacheForTest();
  const data = makeJpegBase64(1200, 900);

  const loose = await downscaleImageDataAsync(data, "image/jpeg", TEST_SETTINGS);
  assert.ok(loose, "首轮应产出降采样结果");

  const strictSettings = {
    ...TEST_SETTINGS,
    minDataChars: 1,
    targetMaxChars: 16 * 1024
  };
  const strict = await downscaleImageDataAsync(data, "image/jpeg", strictSettings);
  assert.ok(strict, "严格档应产出结果");
  assert.ok(
    strict.data.length < loose.data.length,
    `严格档(${strict.data.length}) 必须小于默认档(${loose.data.length}),否则说明缓存忽略了参数`
  );
});

test("召回条目里的媒体先压缩再入缓存:1.6MB 级图片被降到 ≤128KB", async () => {
  _clearDownscaleCacheForTest();
  const imageData = makeJpegBase64(1600, 1200);
  const result = await helixCompressorTransform(
    {
      body: {
        model: TEST_MODEL,
        messages: [
          { role: "user", content: [{ type: "text", text: "读图" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_recall", name: "Read", input: {} }] },
          {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "toolu_recall",
              content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageData } }]
            }]
          }
        ]
      },
      headers: {},
      method: "POST",
      path: "/v1/messages",
      requestId: "test-recall-media-1",
      routedModel: TEST_MODEL,
      url: "/v1/messages"
    },
    mockContext()
  );

  assert.ok(result);
  const toolResult = result.body.messages.at(-1).content.find((b) => b.type === "tool_result");
  const placeholderText = toolResult?.content?.[0]?.text ?? "";
  const placeholder = placeholderText.match(/^⟦QA:([0-9a-f]{16})⟧$/);
  assert.ok(placeholder, "图片应被折成占位符");
  const stored = getRecallEntry(placeholder[1]);
  assert.ok(stored && Array.isArray(stored.qMedia), "召回条目应保留可渲染媒体");
  const storedData = stored.qMedia[0].source.data;
  assert.ok(storedData.length < imageData.length, "召回媒体必须被压缩");
  assert.ok(storedData.length <= 128 * 1024, `召回媒体应 ≤128KB,实际 ${storedData.length}`);
  const decoded = jpeg.decode(Buffer.from(storedData, "base64"));
  assert.ok(decoded.width > 0);
});

test("压不动的召回媒体不存原文:只留小标记,recall 不会重新注入大 base64", async () => {
  _clearDownscaleCacheForTest();
  const fake = "A".repeat(300 * 1024); // 非合法 JPEG/PNG,无法降采样
  const result = await helixCompressorTransform(
    {
      body: {
        model: TEST_MODEL,
        messages: [
          { role: "user", content: [{ type: "text", text: "读图" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_fake", name: "Read", input: {} }] },
          {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "toolu_fake",
              content: [{ type: "image", source: { type: "base64", media_type: "image/webp", data: fake } }]
            }]
          }
        ]
      },
      headers: {},
      method: "POST",
      path: "/v1/messages",
      requestId: "test-recall-media-2",
      routedModel: TEST_MODEL,
      url: "/v1/messages"
    },
    mockContext()
  );

  assert.ok(result);
  const toolResult = result.body.messages.at(-1).content.find((b) => b.type === "tool_result");
  const placeholderText = toolResult?.content?.[0]?.text ?? "";
  const placeholder = placeholderText.match(/^⟦QA:([0-9a-f]{16})⟧$/);
  assert.ok(placeholder);
  const stored = getRecallEntry(placeholder[1]);
  assert.ok(stored, "占位符必须仍可召回(返回标记)");
  assert.equal(stored.qMedia, undefined, "压不动的媒体不能存原文");
  assert.ok(stored.q.length < 200, "召回文本必须是小标记");
  assert.ok(!JSON.stringify(stored).includes(fake.slice(0, 100)), "缓存里不能出现原始 base64");
});
