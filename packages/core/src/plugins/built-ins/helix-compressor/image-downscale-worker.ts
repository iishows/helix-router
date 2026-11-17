/**
 * V1.16:图片降采样 worker。
 *
 * 纯 JS 解码(尤其 12MP JPEG)会占用数百毫秒到秒级 CPU;放在 worker 里执行,
 * 避免阻塞网关事件循环(2026-11-10 tokenizer 卡死的同类风险)。
 *
 * 由 `image-downscale.ts` 在 `__dirname/image-downscale-worker.js` 存在时懒加载;
 * 测试环境 / 未打包 worker 时自动回退到主线程同步执行。
 */

import { parentPort } from "node:worker_threads";
import {
  downscaleImageData,
  type DownscaledImage,
  type ImageDownscaleSettings
} from "./image-downscale";

type DownscaleRequest = {
  id: number;
  data: string;
  mime: string;
  settings: ImageDownscaleSettings;
};

type DownscaleResponse = {
  id: number;
  result?: DownscaledImage | null;
  error?: string;
};

if (parentPort) {
  if (process.env.CCR_IMAGE_DOWNSCALE_DEBUG === "1") {
    console.log("[image-downscale-worker] started");
  }
  parentPort.on("message", (message: DownscaleRequest) => {
    let response: DownscaleResponse;
    try {
      response = { id: message.id, result: downscaleImageData(message.data, message.mime, message.settings) ?? null };
    } catch (error) {
      response = { id: message.id, result: null, error: error instanceof Error ? error.message : String(error) };
    }
    parentPort!.postMessage(response);
  });
}
