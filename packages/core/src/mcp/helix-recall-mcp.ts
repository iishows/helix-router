/**
 * Helix 本地召回 MCP server (stdio)
 *
 * 暴露两个工具,由网关的 internal tool loop 拦截、回填、续同一轮:
 *   - hc_recall      : ⟦HC:hash⟧ 占位符 → 原 block 文本 / media
 *   - history_recall : ⟦QA:hash⟧ 占位符 → 原 Q&A pair
 *
 * 数据源:`helix-recall-local-store`(append-only JSONL,零依赖)。压缩端(gateway 进程内的
 * router-plugin transform)写入,本子进程读取,通过环境变量 HELIX_RECALL_CACHE_DIR 共享同一文件。
 *
 * 轻量约束:本 bundle 被列在 esbuild `lightweightMcpBundleNames`(≤128KB,禁止原生 SQLite /
 * storage / config 前缀),因此 store 必须零依赖(node:fs only)。见设计稿
 * docs/issue-reviews/2026-10-14-local-closed-loop-recall-design.md §6。
 */

import { get as recallGet, type RecallCacheEntry } from "@ccr/core/observability/helix-recall-local-store";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type JsonRpcRequest = {
  id?: null | number | string;
  jsonrpc?: string;
  method?: string;
  params?: unknown;
};

type JsonRpcResponse =
  | {
      id: null | number | string;
      jsonrpc: "2.0";
      result: JsonValue;
    }
  | {
      error: {
        code: number;
        data?: JsonValue;
        message: string;
      };
      id: null | number | string;
      jsonrpc: "2.0";
    };

type ToolCallResult = {
  content: Array<{ text: string; type: "text" } | { data: string; mimeType: string; type: "image" }>;
  isError?: boolean;
};

const protocolVersion = "2024-11-05";
const hcRecallToolName = "hc_recall";
const historyRecallToolName = "history_recall";

const tools = [
  {
    description:
      "Retrieve the original text behind a ⟦HC:hash⟧ placeholder. Content in this conversation was " +
      "compressed: long tool results, file reads and command output were replaced by ⟦HC:<16-hex>⟧ " +
      "markers that hold NO information on their own. Call this with the hash_id to get the exact " +
      "original content back. Recall ONLY when the fact you need is genuinely hidden behind a " +
      "placeholder and cannot be answered from the visible conversation — every recall re-injects the " +
      "original and gives back the saved tokens, so do not recall \"just in case\". Do not recall every " +
      "placeholder; never repeat the same hash_id.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        calls: {
          items: {
            additionalProperties: false,
            properties: {
              hash_id: { description: "Hex hash from the ⟦HC:hash⟧ placeholder.", pattern: "^[0-9a-f]{16}$", type: "string" },
              reason: { description: "Brief reason why you need to recall (for audit logging).", type: "string" }
            },
            required: ["hash_id"],
            type: "object"
          },
          type: "array"
        }
      },
      required: ["calls"],
      type: "object"
    },
    name: hcRecallToolName
  },
  {
    description:
      "Retrieve the original content behind a ⟦QA:hash⟧ placeholder. Earlier turns of this conversation " +
      "were compressed: past Q&A pairs and folded tool outputs were replaced by ⟦QA:<16-hex>⟧ markers " +
      "that hold NO information on their own. Call this with the hash_id to bring the exact original " +
      "question, answer or tool output back. The placeholder is NOT a summary, but recall is the " +
      "exception: call this ONLY when the specific fact you need is genuinely hidden behind a " +
      "placeholder and cannot be answered from the visible text — every recall re-injects the original " +
      "and gives back the saved tokens, so do not recall \"just in case\". Set with_media=true only " +
      "when you need the original image/video/document from the earlier question. Do not recall every " +
      "placeholder; never repeat the same hash_id.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        calls: {
          items: {
            additionalProperties: false,
            properties: {
              hash_id: { description: "Hex hash from the ⟦QA:hash⟧ placeholder.", pattern: "^[0-9a-f]{16}$", type: "string" },
              reason: { description: "Brief reason why you need to recall (for audit logging).", type: "string" },
              with_media: { default: false, description: "If true, include the original media that was in the user question.", type: "boolean" }
            },
            required: ["hash_id"],
            type: "object"
          },
          type: "array"
        }
      },
      required: ["calls"],
      type: "object"
    },
    name: historyRecallToolName
  }
] as const;

const toolNames = new Set<string>(tools.map((tool) => tool.name));

let inputBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  drainInputBuffer().catch((error) => {
    writeJsonRpc(jsonRpcError(null, -32603, formatError(error)));
  });
});

process.stdin.resume();

async function drainInputBuffer(): Promise<void> {
  while (true) {
    const headerEnd = inputBuffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }

    const headerText = inputBuffer.subarray(0, headerEnd).toString("utf8");
    const lengthMatch = headerText.match(/content-length:\s*(\d+)/i);
    if (!lengthMatch) {
      inputBuffer = inputBuffer.subarray(headerEnd + 4);
      writeJsonRpc(jsonRpcError(null, -32600, "Missing Content-Length header."));
      continue;
    }

    const contentLength = Number(lengthMatch[1]);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;
    if (inputBuffer.length < messageEnd) {
      return;
    }

    const message = inputBuffer.subarray(messageStart, messageEnd).toString("utf8");
    inputBuffer = inputBuffer.subarray(messageEnd);
    let payload: unknown;
    try {
      payload = JSON.parse(message) as unknown;
    } catch (error) {
      writeJsonRpc(jsonRpcError(null, -32700, `Invalid JSON-RPC request: ${formatError(error)}`));
      continue;
    }

    const response = await handleJsonRpcRequest(payload);
    if (response) {
      writeJsonRpc(response);
    }
  }
}

async function handleJsonRpcRequest(payload: unknown): Promise<JsonRpcResponse | undefined> {
  if (!isRecord(payload)) {
    return jsonRpcError(null, -32600, "JSON-RPC request must be an object.");
  }

  const request = payload as JsonRpcRequest;
  const id = request.id ?? null;
  if (request.id === undefined && request.method?.startsWith("notifications/")) {
    return undefined;
  }
  if (request.jsonrpc !== "2.0" || !request.method) {
    return jsonRpcError(id, -32600, "Invalid JSON-RPC 2.0 request.");
  }

  try {
    switch (request.method) {
      case "initialize":
        return jsonRpcResult(id, {
          capabilities: {
            tools: {}
          },
          protocolVersion,
          serverInfo: {
            name: "ccr-helix-recall",
            title: "CCR Helix Recall",
            version: "1.0.0"
          }
        });
      case "ping":
        return jsonRpcResult(id, {});
      case "tools/list":
        return jsonRpcResult(id, { tools: tools as unknown as JsonValue });
      case "tools/call":
        return jsonRpcResult(id, callTool(request.params) as unknown as JsonValue);
      default:
        return jsonRpcError(id, -32601, `Unsupported MCP method: ${request.method}`);
    }
  } catch (error) {
    return jsonRpcError(id, -32603, formatError(error));
  }
}

function callTool(params: unknown): ToolCallResult {
  const name = isRecord(params) && typeof params.name === "string" ? params.name.trim() : "";
  if (!toolNames.has(name)) {
    throw new Error(`Unknown helix recall tool: ${name || "unknown"}`);
  }
  const args = isRecord(params) && isRecord((params as Record<string, unknown>).arguments)
    ? (params as Record<string, unknown>).arguments as Record<string, unknown>
    : {};
  const isHistory = name === historyRecallToolName;
  // 两种调用形态都接受:
  //   ① 批量 { calls: [{ hash_id, reason, with_media? }] }  —— MCP 广告的 schema
  //   ② 单条 { hash_id, reason, with_media? }             —— helix transform 注入给 LLM 的
  //      client 工具 schema(HISTORY_RECALL_TOOL_SCHEMA_ANTHROPIC)是扁平的,LLM 实测按扁平发。
  const calls = Array.isArray(args.calls)
    ? args.calls
    : typeof args.hash_id === "string"
      ? [args]
      : [];
  const content: ToolCallResult["content"] = [];
  const results = calls.map((call) => {
    const { result, images } = recallOne(call, isHistory);
    // with_media=true 且命中图片时,追加真实 image 内容块(客户端 MCP client 会转成
    //   模型可直接查看的图片,而不是把 base64 当文本喂过去)。
    for (const img of images) {
      content.push({ data: img.data, mimeType: img.mimeType, type: "image" });
    }
    return result;
  });
  content.unshift({ text: JSON.stringify({ results }), type: "text" });
  return { content };
}

type RecallImage = { data: string; mimeType: string };

function recallOne(
  call: unknown,
  isHistory: boolean
): { images: RecallImage[]; result: Record<string, JsonValue> } {
  const record = isRecord(call) ? call : {};
  const hashId = readString(record.hash_id) ?? "";
  if (!hashId) {
    return { images: [], result: { error: "invalid_hash_id" } };
  }

  let entry: RecallCacheEntry | null = null;
  try {
    entry = recallGet(hashId);
  } catch (error) {
    // 缓存目录不可用(env 未设/文件损坏)时按 not_found 处理,不中断整轮工具调用。
    return { images: [], result: { error: "not_found", hash_id: hashId, message: formatError(error) } };
  }
  if (!entry) {
    return { images: [], result: { error: "not_found", hash_id: hashId } };
  }

  const withMedia = isHistory && (record.with_media === true || record.with_media === "true");
  const source = entry.kind === "media" || entry.blockOnly ? "block" : "pair";
  const images = withMedia && Array.isArray(entry.qMedia) ? normalizeRecallImages(entry.qMedia) : [];
  return {
    images,
    result: {
      hash_id: hashId,
      source,
      q: entry.q ?? "",
      a: entry.a ?? "",
      // q_media 文本兜底:仅当不是可渲染的 image 块时(如 document/video/audio 或 url),
      //   仍以文本承载;图片本身走上面的 image 内容块。
      ...(withMedia && images.length === 0 && Array.isArray(entry.qMedia)
        ? { q_media: entry.qMedia as JsonValue }
        : {})
    }
  };
}

/**
 * 归一化两种 qMedia 形状:
 *   ① pair 路径 `{type:"image", mime, data}`(extractMediaBlocks 归一化产物)
 *   ② 媒体候选原块 `{type:"image", source:{type:"base64", media_type, data}}`
 * 仅取出可渲染为 image 内容块的图片;其余(document/video/audio/url)忽略。
 */
function normalizeRecallImages(qMedia: unknown[]): RecallImage[] {
  const out: RecallImage[] = [];
  for (const item of qMedia) {
    if (!isRecord(item)) continue;
    const type = item.type;
    if (type !== "image" && type !== "image_url") continue;
    const src = isRecord(item.source) ? item.source : undefined;
    const data =
      typeof item.data === "string"
        ? item.data
        : src && typeof src.data === "string"
          ? src.data
          : undefined;
    const mimeType =
      (src && typeof src.media_type === "string" ? src.media_type : undefined) ??
      (typeof item.mime === "string" ? item.mime : "image/png");
    if (data) {
      out.push({ data, mimeType });
    }
  }
  return out;
}

function jsonRpcResult(id: null | number | string, result: JsonValue): JsonRpcResponse {
  return {
    id,
    jsonrpc: "2.0",
    result
  };
}

function jsonRpcError(id: null | number | string, code: number, message: string): JsonRpcResponse {
  return {
    error: {
      code,
      message
    },
    id,
    jsonrpc: "2.0"
  };
}

function writeJsonRpc(response: JsonRpcResponse): void {
  const text = JSON.stringify(response);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(text, "utf8")}\r\n\r\n${text}`);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
