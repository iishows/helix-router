import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { encode as gptEncode } from "gpt-tokenizer";
import type { ApiKeyConfig, AppConfig, GatewayProviderConfig, GatewayProviderProtocol, ProfileConfig, RouterRule } from "@ccr/core/contracts/app";
import { HELIX_RECALL_MODEL_PREFIX } from "@ccr/core/contracts/app";
import {
  getCompressionStat,
  setCompressionStat,
  compressionStatsStore,
  type ProactiveCompactStat
} from "@ccr/core/observability/compression-stats-store";
import {
  claudeCodeWifTokenPath,
  exchangeClaudeCodeWifToken,
  resolveApiKeyFromHeaders
} from "@ccr/core/gateway/auth/api-key-authorizer";
import { ccrRemoteControlPathPrefix, ccrRemoteControlService } from "@ccr/core/gateway/remote-control-service";
import {
  ClaudeCodeRouterPlugin,
  type ClaudeCodeRouteDecision
} from "@ccr/core/gateway/claude-code-router-plugin";
import {
  ccrAnthropicReasoningResponseHookKey,
  ccrCodexApplyPatchBridgeHeader,
  ccrCodexBridgeRequestTransformKey,
  ccrCodexBridgeResponseHookKey,
  ccrCodexBridgeStreamHookKey,
  ccrCodexMultiAgentBridgeHeader,
  ccrLiveTokenRateConfigMessageType,
  ccrLiveTokenRateSnapshotMessageType,
  ccrLiveTokenRateStreamHookKey,
  ccrOpenRouterDiscountFinalizeResponseHookKey,
  ccrOpenRouterDiscountFinalizeStreamHookKey,
  ccrOpenRouterDiscountRequestIdHeader,
  ccrRouteDiagnosticsHeader,
  ccrRouteFallbackHeader,
  ccrRouteHeaderNames,
  ccrRouteReasonHeader,
  ccrRouteSessionIdHeader,
  ccrRouteSourceHeader,
  ccrRouteStageHeader,
  ccrRouteTokenCountHeader,
  ccrRawTraceSyncAckRouteKey,
  ccrRuntimeConfigReloadMessageType,
  ccrRoutedModelHeader,
  ccrRouterHttpRouteKey,
  ccrRouterHttpRoutePath,
  ccrRouterRouteResolverKey,
  ccrRouterRequestTransformKey,
  encodeCcrRouteFallbackHeader,
  type CcrRouterPluginRouteRequest
} from "@ccr/core/gateway/core-runtime/router-plugin-contract";
import { coalesceAnthropicReasoningResponse } from "@ccr/core/gateway/features/anthropic-reasoning-response";
import { coreGatewayAuthHeader, rawTraceSyncHeader, rawTraceSyncPath, sdkCompatibleTokenHeaderNames } from "@ccr/core/gateway/internal/shared";
import { gatewayRuntimeConfigControlPath, gatewayRuntimeConfigRevision } from "@ccr/core/gateway/runtime-config-control";
import {
  createClaudeCliBootstrapResponse,
  createGatewayModelsResponse,
  resolveGatewayPublicModelId
} from "@ccr/core/gateway/features/model-discovery";
import {
  codexApplyPatchBridgeResponseStream,
  prepareCodexApplyPatchBridgeRequest,
  transformCodexApplyPatchBridgeResponseValue
} from "@ccr/core/gateway/features/codex-patch-bridge";
import {
  codexMultiAgentBridgeResponseStream,
  prepareCodexMultiAgentBridgeRequest,
  transformCodexMultiAgentBridgeResponseValue
} from "@ccr/core/gateway/features/codex-multi-agent-bridge";
import { requestLogRequestedModel } from "@ccr/core/observability/request-log-model";
import { createStreamExperienceMeter, LiveTokenRateTracker } from "@ccr/core/observability/stream-experience";
import {
  finalizeOpenRouterDiscountProviderRouterSelection,
  openRouterDiscountProviderRouterTransform
} from "@ccr/core/plugins/built-ins/openrouter-discount-provider-router";
import {
  helixCompressorTransform,
  helixCompressorRequestTransformKey
} from "@ccr/core/plugins/built-ins/helix-compressor";
import {
  applyHelixProactiveCompact,
  readProactiveCompactSettingsFromConfig
} from "@ccr/core/gateway/features/helix-proactive-compact";
import type {
  GatewayPluginRequestTransformContext,
  GatewayPluginRequestTransformInput as CcrGatewayPluginRequestTransformInput
} from "@ccr/core/plugins/service";
import { isModelAllowedForProfile, profileForApiKey } from "@ccr/core/profiles/model-allowlist";
import { profileApiKeyId } from "@ccr/core/profiles/api-key";
import { adaptRouteRequestBody, restoreRouteRequestBody } from "@ccr/core/routing/protocol-adapter";
import { requestProtocolForPath, shouldApplyGatewayRouting } from "@ccr/core/routing/protocol-endpoints";
import { RouteScriptRuntime } from "@ccr/core/routing/route-script-runtime";
import { modelRegistryForConfig, normalizeRouteSelector, parseProviderModelSelector, providerRuntimeId } from "@ccr/core/routing/model-registry";
import {
  activeProviderCredentials,
  normalizedProviderCapabilities,
  normalizeProviderProtocol,
  providerCapabilityForClientProtocol,
  providerCapabilityInternalName,
  providerCredentialInternalName,
  providerProtocolForClientProtocol,
  sanitizeHeaderValue,
  sortProviderCredentialsForConfig
} from "@ccr/core/providers/runtime-topology";

type GatewayPluginFactoryInput = {
  plugin?: {
    config?: unknown;
  };
};

type HeaderValue = string | string[] | undefined;
type GatewayPluginHttpRequest = {
  body?: unknown;
  headers?: Record<string, HeaderValue>;
  method?: string;
  raw?: IncomingMessage;
  url?: string;
};
type GatewayPluginHttpReply = {
  code(statusCode: number): {
    send(payload: unknown): unknown;
  };
  hijack?(): void;
  raw?: ServerResponse;
  send(payload: unknown): unknown;
};

type GatewayRequestHookInput = {
  request?: {
    headers?: Record<string, HeaderValue>;
    id?: string;
    method?: string;
    url?: string;
  };
};

type PublicGatewayAuthResult =
  | { ok: true; apiKey?: ApiKeyConfig }
  | { ok: false; error: string; status: number };

type GatewayRequestTransformInput = {
  model?: string;
  request?: {
    headers?: Record<string, HeaderValue>;
    id?: string;
    method?: string;
    url?: string;
  };
  requestBody?: unknown;
  route?: {
    method?: string;
    url?: string;
  };
  source?: {
    adapterKey?: string;
  };
  sourceAdapterKey?: string;
  stage?: string;
  targetProviderConfig?: Pick<GatewayProviderConfig, "provider" | "type">;
};

type UpstreamRequest = {
  body?: unknown;
  headers?: Record<string, string>;
  method?: string;
  url?: string;
};

type GatewayResponseHookInput = {
  model?: string;
  request?: {
    headers?: Record<string, HeaderValue>;
    id?: string;
    method?: string;
    url?: string;
  };
  responseHeaders?: Record<string, string>;
  responsePayload?: unknown;
  statusCode?: number;
  upstreamRequest?: UpstreamRequest;
  upstreamResponse?: Response;
};

type GatewayStreamHookInput = {
  model?: string;
  request?: {
    headers?: Record<string, HeaderValue>;
    id?: string;
    method?: string;
    url?: string;
  };
  targetProvider?: string;
  targetProviderConfig?: Pick<GatewayProviderConfig, "provider" | "type">;
  upstreamRequest?: UpstreamRequest;
  upstreamResponse: Response;
};

type GatewayRouteResolution = {
  headers?: Record<string, string>;
  model?: string;
  reason?: string;
  requestBody?: Record<string, unknown>;
  targetProviderName?: string;
};

// V3.2:request transform 写压缩 stat,response hook 读 + 推 x-helix-compressor-* header 到客户端
// helix V1.2 / 2026-10-13:CompressionStat + compressionStatsStore 已提取到独立模块
// `packages/core/src/observability/compression-stats-store.ts`,让 request-log worker
// 也能用同一份类型定义。import 路径见下。

export async function createGatewayPlugin(input: GatewayPluginFactoryInput = {}) {
  const config = readAppConfig(input.plugin?.config);
  if (!config) {
    throw new Error("CCR router plugin requires plugin.config.appConfig.");
  }
  const publicGatewayMode = readPublicGatewayMode(input.plugin?.config);
  const coreAuthToken = readCoreAuthToken(input.plugin?.config);
  const publicAuthKeys = readPublicAuthKeys(input.plugin?.config);

  const scriptRuntime = hasScriptRules(config.Router.rules)
    ? new RouteScriptRuntime()
    : undefined;
  const scriptValidationErrors = scriptRuntime
    ? await scriptRuntime.prepare(config.Router.rules)
    : undefined;
  const router = new ClaudeCodeRouterPlugin(config, {
    scriptRuntime,
    scriptValidationErrors
  });
  const openRouterDiscountContext = openRouterDiscountTransformContext(config);
  const liveTokenRatePublisher = coreGatewayLiveTokenRatePublisherFor(config.trayShowTokenRate);

  return {
    httpRoutes: [{
      auth: "none",
      key: ccrRouterHttpRouteKey,
      method: "POST",
      path: ccrRouterHttpRoutePath,
      handler: async ({ request, reply }: { request: GatewayPluginHttpRequest; reply: GatewayPluginHttpReply }) => {
        if (!isCoreGatewayRequest(request.headers, coreAuthToken)) {
          return reply.code(401).send({ error: { message: "Unauthorized CCR router route." } });
        }
        const payload = readRouteRequestPayload(request.body);
        if (!payload) {
          return reply.code(400).send({
            error: {
              message: "CCR router plugin route requires a JSON body with body, method, and url."
            }
          });
        }

        return routeWithRouter(router, payload);
      }
    }, {
      auth: "none",
      key: "ccr-runtime-config-control",
      method: "ALL",
      path: gatewayRuntimeConfigControlPath,
      priority: "pre",
      handler: async ({ request, reply }: { request: GatewayPluginHttpRequest; reply: GatewayPluginHttpReply }) =>
        handleRuntimeConfigControlRoute(config, request, reply, coreAuthToken, publicAuthKeys)
    }, {
      auth: "none",
      key: ccrRawTraceSyncAckRouteKey,
      method: "POST",
      path: rawTraceSyncPath,
      priority: "pre",
      handler: ({ request, reply, config: gatewayConfig }: {
        request: GatewayPluginHttpRequest;
        reply: GatewayPluginHttpReply;
        config: unknown;
      }) => {
        const expectedToken = readRawTraceSyncToken(gatewayConfig);
        if (!expectedToken || readHeader(request.headers, rawTraceSyncHeader) !== expectedToken) {
          return reply.code(401).send({
            error: {
              message: "Unauthorized raw trace sync."
            }
          });
        }
        return reply.code(202).send({
          accepted: true,
          durable: false,
          localSpool: true,
          ok: true
        });
      }
    }, {
      auth: "none",
      key: "ccr-public-root",
      method: "GET",
      path: "/",
      priority: "pre",
      handler: () => ({
        core: "next-ai-gateway",
        endpoints: [
          "POST /v1/oauth/token",
          "GET /api/claude_cli/bootstrap",
          "POST /v1/messages",
          "POST /v1/messages/count_tokens",
          "GET /models",
          "GET /v1/models"
        ],
        name: "claude-code-router",
        plugin: "claude-code-router",
        wrapperPlugins: config.plugins.filter((plugin) => plugin.enabled !== false).map((plugin) => plugin.id)
      })
    }, {
      auth: "none",
      key: "ccr-public-remote-control-root",
      method: "ALL",
      path: ccrRemoteControlPathPrefix,
      priority: "pre",
      handler: async ({ request, reply }: { request: GatewayPluginHttpRequest; reply: GatewayPluginHttpReply }) =>
        handleRemoteControlRoute(config, request, reply, coreAuthToken, publicAuthKeys)
    }, {
      auth: "none",
      key: "ccr-public-remote-control",
      method: "ALL",
      path: `${ccrRemoteControlPathPrefix}/*`,
      priority: "pre",
      handler: async ({ request, reply }: { request: GatewayPluginHttpRequest; reply: GatewayPluginHttpReply }) =>
        handleRemoteControlRoute(config, request, reply, coreAuthToken, publicAuthKeys)
    }, {
      auth: "none",
      key: "ccr-public-wif-token",
      method: "POST",
      path: claudeCodeWifTokenPath,
      priority: "pre",
      handler: async ({ request, reply }: { request: GatewayPluginHttpRequest; reply: GatewayPluginHttpReply }) => {
        const result = await exchangeClaudeCodeWifToken(config, httpRequestBodyBuffer(request.body), { includePersisted: false });
        return reply.code(result.statusCode).send(result.payload);
      }
    }, {
      auth: "gateway",
      key: "ccr-public-models-v1",
      method: "GET",
      path: "/v1/models",
      priority: "pre",
      handler: async ({ request }: { request: GatewayPluginHttpRequest }) =>
        createGatewayModelsResponse(config, request.headers ?? {}, await resolveApiKey(config, request.headers))
    }, {
      auth: "gateway",
      key: "ccr-public-models",
      method: "GET",
      path: "/models",
      priority: "pre",
      handler: async ({ request }: { request: GatewayPluginHttpRequest }) =>
        createGatewayModelsResponse(config, request.headers ?? {}, await resolveApiKey(config, request.headers))
    }, {
      auth: "gateway",
      key: "ccr-public-claude-cli-bootstrap",
      method: "GET",
      path: "/api/claude_cli/bootstrap",
      priority: "pre",
      handler: async ({ request }: { request: GatewayPluginHttpRequest }) =>
        createClaudeCliBootstrapResponse(config, await resolveApiKey(config, request.headers))
    }, {
      auth: "gateway",
      key: "ccr-public-count-tokens",
      method: "POST",
      path: "/v1/messages/count_tokens",
      priority: "pre",
      handler: async ({ request, reply }: { request: GatewayPluginHttpRequest; reply: GatewayPluginHttpReply }) => {
        const body = isRecord(request.body) ? request.body : {};
        const apiKey = await resolveApiKey(config, request.headers);
        const requestedModel = requestLogRequestedModel(httpRequestBodyBuffer(body), requestPath(request.url ?? "/v1/messages/count_tokens"));
        const profile = profileForApiKey(config, apiKey);
        if (requestedModel && !isModelAllowedForProfile(config, profile, requestedModel)) {
          return reply.code(403).send(profileModelNotAllowedError(requestedModel));
        }
        return router.countTokens(body);
      }
    }],
    requestHooks: [{
      key: "ccr-public-auth-context",
      beforeAuth: async (requestInput: GatewayRequestHookInput) => {
        if (publicGatewayMode) {
          stripUntrustedCcrRouteHeaders(requestInput.request?.headers);
          const authorization = await resolvePublicGatewayAuth(config, requestInput.request?.headers, {
            coreAuthToken,
            publicAuthKeys,
            rejectMissing: false
          });
          if (!authorization.ok) {
            return {
              ok: false,
              status: authorization.status,
              error: authorization.error
            };
          }
          setApiKeyAuthContextHeaders(requestInput.request?.headers, authorization.apiKey);
          return undefined;
        }
        const apiKey = await resolveApiKey(config, requestInput.request?.headers);
        setApiKeyAuthContextHeaders(requestInput.request?.headers, apiKey);
        return undefined;
      }
    }],
    requestTransforms: [{
      key: ccrRouterRequestTransformKey,
      stage: "beforeRouting",
      transform: async (requestInput: GatewayRequestTransformInput) => {
        if (readHeader(requestInput.request?.headers, ccrRoutedModelHeader)) {
          return undefined;
        }

        const method = requestInput.route?.method ?? requestInput.request?.method ?? "GET";
        const url = requestInput.route?.url ?? requestInput.request?.url ?? "/";
        const path = requestPath(url);
        if (!shouldApplyGatewayRouting(method, path) || !isRecord(requestInput.requestBody)) {
          return undefined;
        }

        const apiKey = await resolveApiKey(config, requestInput.request?.headers);
        const profile = profileForApiKey(config, apiKey);
        const modelBeforeRouting = requestedModelFromBody(requestInput.requestBody, path, requestInput.model);
        const routeResponse = await routeWithRouter(router, {
          body: requestInput.requestBody,
          headers: requestInput.request?.headers,
          method,
          path,
          url
        });
        const deniedModel = profileDeniedModel(
          config,
          profile,
          modelBeforeRouting,
          routeResponse.decision.model ?? requestedModelFromBody(routeResponse.body, path, requestInput.model)
        );
        if (deniedModel) {
          return {
            ok: false,
            status: 403,
            error: `Model "${deniedModel}" is not allowed for this profile.`,
            details: {
              code: "profile_model_not_allowed"
            }
          };
        }
        const discountTransform = await applyOpenRouterDiscountTransform(
          routeResponse,
          requestInput,
          method,
          path,
          url,
          openRouterDiscountContext
        );
        const headers = decisionHeaders(routeResponse.decision);
        return {
          headers: {
            ...headers,
            ...(discountTransform?.headers ?? {})
          },
          model: discountTransform?.routedModel ?? routeResponse.decision.model ?? requestInput.model,
          requestBody: discountTransform?.body ?? routeResponse.body,
          ...(discountTransform?.responseHeaders ? { responseHeaders: discountTransform.responseHeaders } : {})
        };
      }
    }, {
      key: ccrCodexBridgeRequestTransformKey,
      stage: "beforeUpstream",
      transform: (requestInput: GatewayRequestTransformInput) =>
        applyCodexBridgeRequestTransform(config, requestInput)
    }, {
      // helix V1.4 / 2026-10-15: stage 必须是 "beforeRouting"(不是 "beforeUpstream")。
      //   外部网关的非流式转换路径(anthropic source → openai_chat target)在上游 body 构建时
      //   只读 transform 返回的 standardRequest: `buildRequestFromStandard({standardRequest: xe})`,
      //   而 helix transform 只返回 requestBody(不返回 standardRequest)→ 压缩结果被静默丢弃。
      //   beforeRouting 阶段改 requestBody 会写回 e.body,之后网关从 e.body 重建 standardRequest
      //   (`if(!Q){Q=s.toStandardRequest(l)}`, l.body=u)→ 压缩真正生效。
      //   该 transform 排在 router transform 之后(requestTransforms 数组顺序),拿到的是已路由的 body。
      key: helixCompressorRequestTransformKey,
      stage: "beforeRouting",
      transform: (requestInput: GatewayRequestTransformInput) =>
        applyHelixCompressorTransform(requestInput, config)
    }],
    responseHooks: [{
      key: ccrAnthropicReasoningResponseHookKey,
      transformResponse: (responseInput: GatewayResponseHookInput) => {
        const transformed = coalesceAnthropicReasoningResponse(responseInput.responsePayload);
        return transformed.changed ? { responsePayload: transformed.value } : undefined;
      }
    }, {
      key: ccrCodexBridgeResponseHookKey,
      transformResponse: (responseInput: GatewayResponseHookInput) =>
        applyCodexBridgeResponseTransform(responseInput)
    }, {
      // V3.2: helix-compressor 压缩 stat 推到客户端响应头
      key: "helix-compressor-response-headers",
      transformResponse: helixCompressorResponseHeadersHook
    }, {
      key: ccrOpenRouterDiscountFinalizeResponseHookKey,
      transformResponse: (responseInput: GatewayResponseHookInput) => {
        finalizeOpenRouterDiscountSelection(responseInput);
        return undefined;
      }
    }],
    streamHooks: [{
      key: ccrCodexBridgeStreamHookKey,
      transformResponse: (streamInput: GatewayStreamHookInput) =>
        applyCodexBridgeStreamTransform(streamInput)
    }, {
      key: ccrOpenRouterDiscountFinalizeStreamHookKey,
      transformResponse: (streamInput: GatewayStreamHookInput) => {
        finalizeOpenRouterDiscountSelection(streamInput);
        return undefined;
      }
    }, {
      key: ccrLiveTokenRateStreamHookKey,
      transformResponse: (streamInput: GatewayStreamHookInput) =>
        applyLiveTokenRateStreamTransform(streamInput, liveTokenRatePublisher)
    }],
    routeResolvers: [{
      key: ccrRouterRouteResolverKey,
      resolve: (requestInput: GatewayRequestTransformInput): GatewayRouteResolution | undefined =>
        resolveCcrGatewayRoute(config, requestInput)
    }]
  };
}

const liveTokenRatePublishIntervalMs = 250;
let sharedCoreGatewayLiveTokenRatePublisher: CoreGatewayLiveTokenRatePublisher | undefined;

class CoreGatewayLiveTokenRatePublisher {
  readonly tracker = new LiveTokenRateTracker();
  private enabled = false;
  private lastPublishedAt = 0;
  private publishTimer?: NodeJS.Timeout;

  constructor(enabled: boolean) {
    process.on("message", this.handleMessage);
    this.configure(enabled);
  }

  configure(enabled: boolean): void {
    const nextEnabled = enabled && typeof process.send === "function";
    if (this.enabled === nextEnabled) {
      return;
    }
    this.enabled = nextEnabled;
    if (!nextEnabled) {
      this.tracker.clear();
    }
    this.publishNow();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  notifyActivity(urgent: boolean): void {
    if (!this.enabled) {
      return;
    }
    const delayMs = liveTokenRatePublishIntervalMs - (Date.now() - this.lastPublishedAt);
    if (urgent || delayMs <= 0) {
      this.publishNow();
      return;
    }
    if (this.publishTimer) {
      return;
    }
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      this.publishNow();
    }, delayMs);
    this.publishTimer.unref?.();
  }

  private readonly handleMessage = (message: unknown): void => {
    if (!isRecord(message) || message.type !== ccrLiveTokenRateConfigMessageType || message.protocolVersion !== 1) {
      return;
    }
    this.configure(message.enabled === true);
  };

  private publishNow(): void {
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = undefined;
    }
    this.lastPublishedAt = Date.now();
    const snapshot = this.enabled
      ? this.tracker.snapshot()
      : { activeRequests: 0, tokensPerSecond: 0 };
    try {
      process.send?.({
        ...snapshot,
        protocolVersion: 1,
        type: ccrLiveTokenRateSnapshotMessageType
      });
    } catch {
      this.enabled = false;
      this.tracker.clear();
      return;
    }
    if (this.enabled && snapshot.activeRequests > 0) {
      this.publishTimer = setTimeout(() => {
        this.publishTimer = undefined;
        this.publishNow();
      }, liveTokenRatePublishIntervalMs);
      this.publishTimer.unref?.();
    }
  }
}

function coreGatewayLiveTokenRatePublisherFor(enabled: boolean): CoreGatewayLiveTokenRatePublisher {
  sharedCoreGatewayLiveTokenRatePublisher ??= new CoreGatewayLiveTokenRatePublisher(enabled);
  sharedCoreGatewayLiveTokenRatePublisher.configure(enabled);
  return sharedCoreGatewayLiveTokenRatePublisher;
}

function applyLiveTokenRateStreamTransform(
  streamInput: GatewayStreamHookInput,
  publisher: CoreGatewayLiveTokenRatePublisher
): Response | undefined {
  if (!publisher.isEnabled() || !streamInput.upstreamResponse.body) {
    return undefined;
  }
  const protocol = normalizeProviderProtocol(streamInput.targetProviderConfig?.type) ??
    normalizeProviderProtocol(streamInput.targetProviderConfig?.provider) ??
    normalizeProviderProtocol(streamInput.targetProvider);
  const meter = createStreamExperienceMeter({
    contentType: streamInput.upstreamResponse.headers.get("content-type") ?? undefined,
    liveRateTracker: publisher.tracker,
    onLiveRateActivity: (urgent) => publisher.notifyActivity(urgent),
    protocol,
    publishLiveRate: true,
    requestId: readGatewayRequestId(streamInput) ?? randomUUID()
  });
  const source = Readable.fromWeb(
    streamInput.upstreamResponse.body as unknown as Parameters<typeof Readable.fromWeb>[0]
  );
  const metered = source.pipe(meter.stream);
  return new Response(Readable.toWeb(metered) as ReadableStream<Uint8Array>, {
    headers: new Headers(streamInput.upstreamResponse.headers),
    status: streamInput.upstreamResponse.status,
    statusText: streamInput.upstreamResponse.statusText
  });
}

async function handleRuntimeConfigControlRoute(
  config: AppConfig,
  request: GatewayPluginHttpRequest,
  reply: GatewayPluginHttpReply,
  coreAuthToken: string | undefined,
  publicAuthKeys: readonly string[]
): Promise<unknown> {
  const authorization = await resolvePublicGatewayAuth(config, request.headers, {
    coreAuthToken,
    publicAuthKeys,
    rejectMissing: true,
    url: request.url
  });
  if (!authorization.ok) {
    return reply.code(authorization.status).send({ error: { message: authorization.error } });
  }
  if (!config.APIKEY || authorization.apiKey?.key !== config.APIKEY) {
    return reply.code(403).send({ error: { message: "The primary CCR API key is required for runtime configuration control." } });
  }

  const method = (request.method ?? "GET").toUpperCase();
  if (method === "GET") {
    return reply.code(200).send({
      revision: gatewayRuntimeConfigRevision(config),
      state: "running"
    });
  }
  if (method !== "POST") {
    return reply.code(405).send({ error: { message: "Method not allowed." } });
  }

  const body = readJsonObjectBody(request.body);
  const expectedRevision = typeof body.configRevision === "string"
    ? body.configRevision.trim()
    : "";
  if (!/^[a-f0-9]{64}$/i.test(expectedRevision)) {
    return reply.code(400).send({ error: { message: "A valid configRevision is required." } });
  }
  const requested = await requestParentRuntimeConfigReload(expectedRevision, body.forceRestart === true);
  if (!requested.ok) {
    return reply.code(503).send({ error: { message: requested.error } });
  }
  return reply.code(202).send({
    accepted: true,
    configRevision: expectedRevision,
    restarting: body.forceRestart === true
  });
}

async function handleRemoteControlRoute(
  config: AppConfig,
  request: GatewayPluginHttpRequest,
  reply: GatewayPluginHttpReply,
  coreAuthToken: string | undefined,
  publicAuthKeys: readonly string[]
): Promise<unknown> {
  const authorization = await resolvePublicGatewayAuth(config, request.headers, {
    coreAuthToken,
    publicAuthKeys,
    rejectMissing: true,
    url: request.url
  });
  if (!authorization.ok) {
    return reply.code(authorization.status).send({ error: { message: authorization.error } });
  }
  if (!request.raw || !reply.raw || typeof reply.hijack !== "function") {
    return reply.code(500).send({ error: { message: "CCR remote control route requires raw HTTP access." } });
  }

  reply.hijack();
  await ccrRemoteControlService.handleRequest({
    endpoint: pluginPublicEndpoint(config),
    path: requestPath(request.url ?? ccrRemoteControlPathPrefix),
    readBody: async () => httpRequestBodyBuffer(request.body),
    request: request.raw,
    response: reply.raw,
    sendJson: sendRawJson
  });
  return reply;
}

function applyCodexBridgeRequestTransform(
  config: AppConfig,
  requestInput: GatewayRequestTransformInput
): {
  headers: Record<string, string | null>;
  requestBody: Record<string, unknown>;
} | undefined {
  if (!isRecord(requestInput.requestBody)) {
    return undefined;
  }

  const method = requestInput.route?.method ?? requestInput.request?.method ?? "GET";
  const url = requestInput.route?.url ?? requestInput.request?.url ?? "/";
  const path = requestPath(url);
  const headers = requestInput.request?.headers ?? {};
  if (shouldBypassCodexBridgeForNativeResponsesPassthrough(requestInput, path)) {
    return undefined;
  }
  const routedModel = requestInput.model ??
    readHeader(headers, ccrRoutedModelHeader) ??
    requestedModelFromBody(requestInput.requestBody, path, undefined);
  let bodyBuffer = httpRequestBodyBuffer(requestInput.requestBody);
  let requestBody = requestInput.requestBody;
  const nextHeaders: Record<string, string | null> = {};

  const applyPatchBridge = prepareCodexApplyPatchBridgeRequest({
    body: bodyBuffer,
    config,
    headers,
    method,
    path,
    ...(routedModel ? { routedModel } : {})
  });
  if (applyPatchBridge) {
    bodyBuffer = applyPatchBridge.body;
    requestBody = readJsonObjectBody(bodyBuffer);
    nextHeaders[ccrCodexApplyPatchBridgeHeader] = sanitizeHeaderValue(applyPatchBridge.diagnostic) || "1";
  }

  const multiAgentBridge = prepareCodexMultiAgentBridgeRequest({
    body: bodyBuffer,
    config,
    headers,
    method,
    path,
    ...(routedModel ? { routedModel } : {})
  });
  if (multiAgentBridge) {
    bodyBuffer = multiAgentBridge.body;
    requestBody = readJsonObjectBody(bodyBuffer);
    nextHeaders[ccrCodexMultiAgentBridgeHeader] = sanitizeHeaderValue(multiAgentBridge.diagnostic) || "1";
  }

  if (Object.keys(nextHeaders).length === 0) {
    return undefined;
  }

  return {
    headers: {
      ...nextHeaders,
      "content-length": null,
      "content-type": "application/json"
    },
    requestBody
  };
}

function shouldBypassCodexBridgeForNativeResponsesPassthrough(
  requestInput: GatewayRequestTransformInput,
  path: string
): boolean {
  if (requestProtocolForPath(path) !== "openai_responses") {
    return false;
  }

  const sourceAdapterKey = requestInput.sourceAdapterKey ?? requestInput.source?.adapterKey;
  if (sourceAdapterKey !== "openai_responses") {
    return false;
  }

  const targetProtocol = normalizeProviderProtocol(requestInput.targetProviderConfig?.type) ??
    normalizeProviderProtocol(requestInput.targetProviderConfig?.provider);
  return targetProtocol === "openai_responses";
}

function applyCodexBridgeResponseTransform(
  responseInput: GatewayResponseHookInput
): { responsePayload: unknown } | undefined {
  const bridge = codexBridgeState(responseInput);
  if (!bridge.applyPatch && !bridge.multiAgent) {
    return undefined;
  }

  let value = responseInput.responsePayload;
  let changed = false;
  if (bridge.applyPatch) {
    const transformed = transformCodexApplyPatchBridgeResponseValue(value);
    value = transformed.value;
    changed = changed || transformed.changed;
  }
  if (bridge.multiAgent) {
    const transformed = transformCodexMultiAgentBridgeResponseValue(value);
    value = transformed.value;
    changed = changed || transformed.changed;
  }

  return changed ? { responsePayload: value } : undefined;
}

function applyCodexBridgeStreamTransform(streamInput: GatewayStreamHookInput): Response | undefined {
  const bridge = codexBridgeState(streamInput);
  if (!bridge.applyPatch && !bridge.multiAgent) {
    return undefined;
  }
  if (!streamInput.upstreamResponse.body) {
    return streamInput.upstreamResponse;
  }

  const headers = new Headers(streamInput.upstreamResponse.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  let stream = Readable.fromWeb(streamInput.upstreamResponse.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  if (bridge.applyPatch) {
    stream = codexApplyPatchBridgeResponseStream(stream, headers);
  }
  if (bridge.multiAgent) {
    stream = codexMultiAgentBridgeResponseStream(stream, headers);
  }

  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    headers,
    status: streamInput.upstreamResponse.status,
    statusText: streamInput.upstreamResponse.statusText
  });
}

function codexBridgeState(input: {
  request?: { headers?: Record<string, HeaderValue> };
  upstreamRequest?: { headers?: Record<string, string> };
}): { applyPatch: boolean; multiAgent: boolean } {
  return {
    applyPatch: hasTruthyHeader(input.request?.headers, ccrCodexApplyPatchBridgeHeader) ||
      hasTruthyHeader(input.upstreamRequest?.headers, ccrCodexApplyPatchBridgeHeader),
    multiAgent: hasTruthyHeader(input.request?.headers, ccrCodexMultiAgentBridgeHeader) ||
      hasTruthyHeader(input.upstreamRequest?.headers, ccrCodexMultiAgentBridgeHeader)
  };
}

function finalizeOpenRouterDiscountSelection(input: GatewayResponseHookInput | GatewayStreamHookInput): void {
  const requestId = readGatewayRequestId(input);
  if (!requestId) {
    return;
  }
  finalizeOpenRouterDiscountProviderRouterSelection(requestId, {
    ok: upstreamResponseSuccessful(input.upstreamResponse, "statusCode" in input ? input.statusCode : undefined),
    routedModel: readHeader(input.request?.headers, ccrRoutedModelHeader) ?? input.model,
    usedCcrFallback: false
  });
}

function readGatewayRequestId(input: {
  request?: { headers?: Record<string, HeaderValue>; id?: string };
  upstreamRequest?: { headers?: Record<string, string> };
}): string | undefined {
  return stringValue(input.request?.id) ??
    readHeader(input.request?.headers, ccrOpenRouterDiscountRequestIdHeader) ??
    readHeader(input.request?.headers, "x-request-id") ??
    readHeader(input.request?.headers, "x-client-request-id") ??
    readHeader(input.upstreamRequest?.headers, ccrOpenRouterDiscountRequestIdHeader) ??
    readHeader(input.upstreamRequest?.headers, "x-request-id") ??
    readHeader(input.upstreamRequest?.headers, "x-client-request-id");
}

function upstreamResponseSuccessful(response: Response | undefined, statusCode: number | undefined): boolean {
  const status = response?.status ?? statusCode;
  return typeof status === "number" && status >= 200 && status < 400;
}

async function applyOpenRouterDiscountTransform(
  routeResponse: { body: Record<string, unknown>; decision: ClaudeCodeRouteDecision },
  requestInput: GatewayRequestTransformInput,
  method: string,
  path: string,
  url: string,
  context: GatewayPluginRequestTransformContext
): Promise<{
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  routedModel?: string;
} | undefined> {
  const requestId = readGatewayRequestId(requestInput) ?? "";
  const result = await openRouterDiscountProviderRouterTransform({
    body: routeResponse.body,
    headers: stringHeaders(requestInput.request?.headers),
    method,
    path,
    requestId,
    ...(routeResponse.decision.model ? { routedModel: routeResponse.decision.model } : {}),
    ...(routeResponse.decision.sessionId ? { sessionId: routeResponse.decision.sessionId } : {}),
    tokenCount: routeResponse.decision.tokenCount,
    url
  } satisfies CcrGatewayPluginRequestTransformInput, context);
  if (!result) {
    return undefined;
  }
  return {
    ...(result.body ? { body: result.body } : {}),
    headers: {
      ...(requestId ? { [ccrOpenRouterDiscountRequestIdHeader]: requestId } : {}),
      ...(cleanStringHeaders(result.headers) ?? {})
    },
    responseHeaders: cleanStringHeaders(result.responseHeaders),
    ...(result.routedModel ? { routedModel: result.routedModel } : {})
  };
}

function openRouterDiscountTransformContext(config: AppConfig): GatewayPluginRequestTransformContext {
  return {
    config,
    logger: console,
    openSqliteStore: async () => {
      throw new Error("OpenRouter discount routing does not use plugin SQLite storage in the core gateway plugin.");
    },
    paths: {
      configDir: "",
      dataDir: "",
      pluginDataDir: ""
    },
    permissions: [],
    pluginConfig: undefined,
    pluginId: "openrouter"
  };
}

function helixCompressorTransformContext(config: AppConfig): GatewayPluginRequestTransformContext {
  const plugins = (config.plugins ?? []).filter((plugin) => plugin.id === "helix-compressor");
  const pluginConfig = plugins[0]?.config;
  return {
    config,
    logger: console,
    openSqliteStore: async () => {
      throw new Error("Helix Compressor does not use plugin SQLite storage in the core gateway plugin.");
    },
    paths: {
      configDir: "",
      dataDir: "",
      pluginDataDir: ""
    },
    permissions: [],
    pluginConfig,
    pluginId: "helix-compressor"
  };
}

async function applyHelixCompressorTransform(
  requestInput: GatewayRequestTransformInput,
  config: AppConfig
): Promise<{
  headers?: Record<string, string | number | boolean | null | undefined>;
  model?: string;
  responseHeaders?: Record<string, string | number | boolean | null | undefined>;
  requestBody?: Record<string, unknown>;
} | undefined> {
  if (!isRecord(requestInput.requestBody)) {
    return undefined;
  }
  const method = requestInput.route?.method ?? requestInput.request?.method ?? "POST";
  const url = requestInput.route?.url ?? requestInput.request?.url ?? "/";
  const path = requestPath(url);
  const headers = requestInput.request?.headers ?? {};
  const requestId = requestInput.request?.id ?? "";
  const routedModel = requestInput.model;

  // 查找 helix-compressor plugin config（v1.1 评估边界由插件配置）
  // 判据与 `helixLocalRecallEnabled` 保持一致：只看 `enabled !== false`。
  // 之前额外要求 `isRecord(helixPlugin.config)`，导致 `{id, enabled:true}` 这种
  // 「按 README 启用」的写法出现最坏组合：召回开启(注入 recall MCP + 改写虚拟模型)
  // 但压缩静默关闭。`parseConfig` 对缺失 config 已回退 HELIX_COMPRESSOR_DEFAULTS，
  // 因此该字段不是启用前提。
  const helixPlugin = (config.plugins ?? []).find((plugin) => plugin.id === "helix-compressor");
  if (!helixPlugin || helixPlugin.enabled === false) {
    return undefined;
  }

  const realInput: {
    body?: Record<string, unknown>;
    headers: Record<string, string>;
    method: string;
    path: string;
    requestId: string;
    routedModel?: string;
    url: string;
  } = {
    body: requestInput.requestBody as Record<string, unknown>,
    headers: stringHeaders(headers),
    method,
    path,
    requestId,
    url,
    ...(routedModel ? { routedModel } : {})
  };

  const context = helixCompressorTransformContext(config);
  const result = await helixCompressorTransform(realInput, context);
  if (!result) {
    return undefined;
  }

  // V3.2:把压缩 stat 存到模块级 store,response hook 推 x-helix-compressor-* 到客户端响应
  const statKey = requestId || `auto-${Date.now()}`;
  // helixCompressorTransform 真实回包 shape:
  //   { body: ..., headers: { 'x-helix-compressor-*': value, ... }, responseHeaders: {...} }
  // 所以 stat 都在 result.headers 里(由 built-ins 内的 fetch + 拼接而成)
  type HeadersLike = Record<string, string | number | boolean | null | undefined>;
  const h: HeadersLike = (result.headers ?? {}) as HeadersLike;
  const numOf = (key: string): number => {
    const v = h[key];
    const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : 0;
  };
  const strOf = (key: string): string => (typeof h[key] === "string" ? (h[key] as string) : "");
  const resolveModel = () => strOf("x-helix-compressor-model") || (routedModel ?? requestInput.model ?? "");

  // V3.2:用 gpt-tokenizer(cl100k_base)真实 token 化原始 request body
  // 这是 "raw full submission" 的精确 token 数,包含 image/document b64 在内
  const reqBody = requestInput.requestBody as Record<string, unknown> | undefined;
  let preCompressionTokens = 0;
  if (reqBody && Array.isArray(reqBody.messages)) {
    try {
      // 拿全部 messages 序列化为 JSON,tokenize — 与 plugin 现有的 tokenizeMessages 走同一路径
      preCompressionTokens = gptEncode(JSON.stringify(reqBody.messages)).length;
    } catch {
      preCompressionTokens = 0;
    }
  }
  // post_tokens:压缩后给 LLM 实际看到的 token 数(helix-compressor 内部用 gpt-tokenizer 算过)
  // x-helix-compressor-compressed-tokens = 压缩后 messages 的 token 数
  // x-helix-compressor-baseline-tokens = 原始 messages 的 token 数(== preCompressionTokens,用于双径校验)
  //   注意:主动 compact 可能进一步折叠(见下方),命中后此值会被修正为 compact 后的真实提交量。
  let postCompressionTokens = numOf("x-helix-compressor-compressed-tokens");

  // helix V1.11 / 2026-10-15: 若 transform 决定把 model 改写成 `ccr-helix-recall/<真 model>`
  //   (即 body 真的含可召回占位符时),透传给网关 beforeRouting 的 `model` 字段。网关在
  //   handler.ts:383 用它覆盖 requestedModelSelector → 命中 virtualModelProfile 的 internal
  //   tool 循环(支持流式)→ 兑现 history_recall。无占位符时不返回 model → 不命中 → 保持
  //   live 直通(零 TTFB 回归)。
  let finalBody = result.body;
  const responseHeadersOut: Record<string, string> = {
    ...(result.responseHeaders ? cleanStringHeaders(result.responseHeaders) ?? {} : {})
  };
  // helix V1.4 / 2026-10-15: request headers 也是压缩统计的跨进程通道 ——
  //   DB trigger(request_logs_compression_extract)从 request_headers 反解
  //   x-helix-compressor-* 写进 compression_* 列。所以 compact 明细 + 修正后的
  //   token 头必须同时落 request headers,否则 worker 侧 DB 列拿不到。
  const requestHeadersOut: Record<string, string> = {
    ...(result.headers ? cleanStringHeaders(result.headers) ?? {} : {})
  };

  // 主动 compact:压缩后仍超 token 预算时,折叠更早历史成一个摘要再转发。
  //   只做「丢前缀 + 改 system」,不动 role 序列 → 不会触发 role 交替 400。
  //   任何失败都静默降级(不返回 compacted,原 body 照常转发)。
  let proactiveCompact: ProactiveCompactStat | undefined;
  if (isRecord(finalBody)) {
    try {
      const compacted = await applyHelixProactiveCompact({
        body: finalBody as Record<string, unknown>,
        config,
        headers: stringHeaders(headers),
        model: stripRecallModelPrefix(resolveModel()),
        postCompressionTokens,
        settings: readProactiveCompactSettingsFromConfig(helixPlugin.config)
      });
      if (compacted) {
        const preCompactTokens = postCompressionTokens;
        finalBody = compacted.requestBody;
        // 修正 post 为 compact 后的真实提交量(kept 区),并落 structured 统计。
        postCompressionTokens = compacted.tokensAfter > 0 ? compacted.tokensAfter : postCompressionTokens;
        proactiveCompact = {
          coveredCount: compacted.coveredCount,
          foldedCount: compacted.foldedCount,
          preCompactTokens,
          source: compacted.source,
          ...(compacted.summaryTokens !== undefined ? { summaryTokens: compacted.summaryTokens } : {}),
          ...(compacted.budgetTokens !== undefined ? { budgetTokens: compacted.budgetTokens } : {}),
          tokensAfter: compacted.tokensAfter
        };
        const compactJson = JSON.stringify({
          coveredCount: compacted.coveredCount,
          foldedCount: compacted.foldedCount,
          preCompactTokens,
          source: compacted.source,
          ...(compacted.summaryTokens !== undefined ? { summaryTokens: compacted.summaryTokens } : {}),
          ...(compacted.budgetTokens !== undefined ? { budgetTokens: compacted.budgetTokens } : {}),
          tokensAfter: compacted.tokensAfter
        });
        // 跨进程通道必须是 `x-helix-compressor-*` 命名空间 —— 落到上游 provider 边界的
        //   header 会被 sanitizeUpstreamProviderHeaders 剥掉所有 `x-ccr-*`(见
        //   upstream-header-sanitizer.ts),而落进 request_headers 列(=worker/DB trigger 读的
        //   那份)的正是这层 sanitize 之后的 header。所以 compact 明细若只挂 `x-ccr-*`,DB
        //   永远拿不到(request_headers 实测 0 条含 x-ccr)。故同时用 `x-helix-compressor-*` 落一份,
        //   并把 `x-ccr-*` 留给 response headers(客户端/同进程 UI 即时可见,不被 sanitize)。
        const diagnostic = compacted.diagnostic;
        for (const out of [requestHeadersOut, responseHeadersOut]) {
          out["x-ccr-helix-proactive-compact"] = diagnostic;
          out["x-ccr-helix-compact-json"] = compactJson;
          // 修正后的 compressed/submitted-tokens 覆盖 helix 原值,让 DB/UI 的
          //   「压缩后」「提交给 LLM」口径 = compact 后的真实提交量。
          out["x-helix-compressor-compressed-tokens"] = String(postCompressionTokens);
          out["x-helix-compressor-submitted-tokens"] = String(postCompressionTokens);
        }
        // 只在 request headers 侧额外落 `x-helix-compressor-*` 别名(生产 sanitize 通道)。
        requestHeadersOut["x-helix-compressor-proactive-compact"] = diagnostic;
        requestHeadersOut["x-helix-compressor-compact-json"] = compactJson;
      }
    } catch {
      // best-effort:主动 compact 失败不影响转发
    }
  }

  // V3.2:把压缩 stat 存到模块级 store,response hook 推 x-helix-compressor-* 到客户端响应。
  //   移到 compact 之后:postCompressionTokens / proactiveCompact 均已定稿(含 compact 修正)。
  const savedPct = preCompressionTokens > 0 && postCompressionTokens > 0
    ? Math.round((1 - postCompressionTokens / preCompressionTokens) * 10000) / 100
    : 0;
  setCompressionStat(statKey, {
    model: resolveModel(),
    scenario: strOf("x-helix-compressor-scenario"),
    inputChars: numOf("x-helix-compressor-input-chars"),
    compressedChars: numOf("x-helix-compressor-output-chars"),
    ratio: numOf("x-helix-compressor-ratio"),
    compressedCount: numOf("x-helix-compressor-qa-compressed"),
    hashMapSize: numOf("x-helix-compressor-hash-count"),
    qMediaStored: false,
    // helix V1.2 / 2026-10-13: pre/post tokens 之前没存到 store(只有 chars),现在存了,
    //   让 request-log worker 能读到并写进 request_logs.compression_baseline_tokens/post_tokens 列
    preCompressionTokens: preCompressionTokens > 0 ? preCompressionTokens : undefined,
    postCompressionTokens: postCompressionTokens > 0 ? postCompressionTokens : undefined,
    ...(proactiveCompact ? { proactiveCompact } : {})
  });

  // V3.2:sidecar log 持久化压缩前/后 tokens + 节省百分百(用户 UI 看不到 x-helix-* 头时也能看)
  // Helix Router 的 request_logs.response_headers 字段是空,这条 sidecar 补上缺失
  // 2026-10-15:移到 compact 之后,post_tokens/saved_pct 反映最终提交量;命中 compact 时带 compact 对象。
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const pathMod = require("node:path") as typeof import("node:path");
    const os = require("node:os") as typeof import("node:os");
    // 用 user data 目录而不是 cwd(Electron 应用 cwd 可能不可写)
    const logDir = pathMod.join(os.homedir(), ".helix-router", "logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      requestId,
      model: resolveModel(),
      scenario: strOf("x-helix-compressor-scenario"),
      pre_tokens: preCompressionTokens,
      post_tokens: postCompressionTokens,
      saved_pct: savedPct,
      qa_compressed: numOf("x-helix-compressor-qa-compressed"),
      ratio: numOf("x-helix-compressor-ratio"),
      ...(proactiveCompact ? { compact: proactiveCompact } : {})
    });
    fs.appendFileSync(pathMod.join(logDir, "compression-stats.jsonl"), line + "\n", "utf8");
  } catch {
    // sidecar 写失败不影响主流程
  }

  // helix recall 虚拟 model 改写必须**同步写回路由 header**（2026-10-16 修 clobber）:
  //   CCR 路由解析器（resolveCcrGatewayRoute）在 beforeRouting transform **之后**运行,
  //   它优先读 `x-ccr-routed-model` header、否则从 body.model 反解,再经注册表解析出**普通**
  //   model 返回。handler 用该返回值**无条件覆盖** requestedModelSelector
  //   （tools/_gwsrc handler.ts:473 `if ('model' in routeResolution)`）→ 把 transform 写下的
  //   `ccr-helix-recall/<真 model>` 抹回普通 model → resolveVirtualModelRequest 命中不到
  //   recall profile → 内部 tool 循环永不启动（真实流量 route_hop_count 恒 0、recall 恒 0）。
  //   修法:把改写后的 model 也写进 `x-ccr-routed-model`。解析器读到该 header 后用它反解,
  //   前缀 `ccr-helix-recall/` 不在 provider 注册表里 → resolve 返回 undefined → 解析器整体
  //   返回 undefined → handler 不再覆盖 → transform 的 model 生效。与 router transform
  //   （line 407 `if (readHeader(...ccrRoutedModelHeader)) return undefined`，避免二次改写）
  //   对称:两者都以该 header 作为"路由已决定"的信号。
  if (result.routedModel) {
    requestHeadersOut[ccrRoutedModelHeader] = result.routedModel;
  }

  // helix V1.3 / 2026-10-13: 字段名必须是 requestBody(跟 router transform line 453 /
  //   codex bridge line 719 一致)。之前写 body,ai-gateway 运行时只读 requestBody,
  //   导致压缩结果被静默丢弃,LLM 收到的是未压缩的原始 body。
  return {
    ...(result.routedModel ? { model: result.routedModel } : {}),
    ...(finalBody ? { requestBody: finalBody } : {}),
    ...(Object.keys(requestHeadersOut).length > 0 ? { headers: requestHeadersOut } : {}),
    ...(Object.keys(responseHeadersOut).length > 0 ? { responseHeaders: responseHeadersOut } : {})
  };
}

/** 剥掉 helix recall 虚拟 model 前缀(摘要请求不得命中 recall virtual-profile)。 */
function stripRecallModelPrefix(model: string): string {
  return model.startsWith(HELIX_RECALL_MODEL_PREFIX) ? model.slice(HELIX_RECALL_MODEL_PREFIX.length) : model;
}

/**
 * V3.2 response hook: 从模块级 store 查压缩 stat,推 x-helix-compressor-* 头到客户端响应
 * helix V1.2 / 2026-10-13: 改成用 consumeCompressionStat 一次性消费;同时推 baseline-tokens
 *   和 compressed-tokens 头(之前漏推,导致 UI 走 responseHeaders 永远拿不到)。
 */
const helixCompressorResponseHeadersHook: (responseInput: any) => { headers?: Record<string, string | number | boolean> } | undefined =
  (responseInput: any) => {
    // 多种 ID 策略兜底,适应不同网关层的 request id 字段
    const upstreamReq = (responseInput.upstreamRequest as any) ?? null;
    const requestLike = (responseInput.request as any) ?? null;
    const upstreamReqId =
      upstreamReq?.headers?.["x-helix-request-id"] ??
      upstreamReq?.requestId ??
      upstreamReq?.id ??
      requestLike?.id ??
      "";
    let key: string | undefined = upstreamReqId ? upstreamReqId : undefined;
    if (!key) {
      // fallback:对仅剩 1 个 key 的情况,极可能是它;否则放弃
      const keys = Array.from(compressionStatsStore.keys());
      key = keys.length === 1 ? keys[0] : undefined;
    }
    if (!key) return undefined;
    // helix V1.4 / 2026-10-13: 只读不删。之前这里 consume(读完即删),但 response hook 比
    //   pipeline 的 writeRequestLog 先执行,删掉后 pipeline 的 getCompressionStat(requestId)
    //   拿到 undefined,DB 4 个 compression_* 列全写 0。改成 get,删除交给 pipeline 在读完
    //   并传给 request-log worker 之后做(consumeCompressionStat)。
    const stat = getCompressionStat(key);
    if (!stat) return undefined;

    return {
      headers: {
        "x-helix-compressor-input-chars": String(stat.inputChars),
        "x-helix-compressor-output-chars": String(stat.compressedChars),
        "x-helix-compressor-ratio": String(stat.ratio ?? 0),
        "x-helix-compressor-qa-compressed": String(stat.compressedCount ?? 0),
        "x-helix-compressor-hash-count": String(stat.hashMapSize ?? 0),
        "x-helix-compressor-model": stat.model ?? "",
        "x-helix-compressor-scenario": stat.scenario ?? "",
        "x-helix-compressor-stored-media": stat.qMediaStored ? "1" : "0",
        // helix V1.2 / 2026-10-13: 新增 — UI 显示"原始 msgs / 压缩后 msgs"需要的真 token 数
        "x-helix-compressor-baseline-tokens": String(stat.preCompressionTokens ?? 0),
        "x-helix-compressor-compressed-tokens": String(stat.postCompressionTokens ?? 0)
      }
    };
  };

async function resolvePublicGatewayAuth(
  config: AppConfig,
  headers: Record<string, HeaderValue> | undefined,
  options: {
    coreAuthToken?: string;
    publicAuthKeys?: readonly string[];
    rejectMissing: boolean;
    url?: string;
  }
): Promise<PublicGatewayAuthResult> {
  const token = readAuthToken(headers) ?? readRemoteControlQueryAuthToken(options.url);
  if (!token) {
    return options.rejectMissing
      ? { ok: false, status: 401, error: "API key is missing." }
      : { ok: true };
  }
  if (isStaticBypassToken(token, options.coreAuthToken, options.publicAuthKeys ?? [])) {
    return { ok: true };
  }

  const apiKey = await resolveApiKey(config, authHeadersForToken(headers, token));
  return apiKey
    ? { ok: true, apiKey }
    : { ok: false, status: 401, error: "Invalid or expired API key." };
}

function setApiKeyAuthContextHeaders(headers: Record<string, HeaderValue> | undefined, apiKey: ApiKeyConfig | undefined): void {
  if (!apiKey || !headers) {
    return;
  }
  headers["x-auth-api-key-id"] = apiKey.id;
  headers["x-auth-sub"] = apiKey.id;
}

async function resolveApiKey(
  config: AppConfig,
  headers: Record<string, HeaderValue> | undefined
): Promise<ApiKeyConfig | undefined> {
  return resolveApiKeyFromHeaders(headers ?? {}, config, { includePersisted: false });
}

async function routeWithRouter(
  router: ClaudeCodeRouterPlugin,
  payload: CcrRouterPluginRouteRequest
): Promise<{ body: Record<string, unknown>; decision: ClaudeCodeRouteDecision }> {
  const path = payload.path ?? requestPath(payload.url ?? "/");
  const adaptation = adaptRouteRequestBody(path, { ...payload.body });
  const routed = await router.routeRequest({
    body: adaptation.body,
    bodyOwnership: "owned",
    headers: payload.headers ?? {},
    method: payload.method ?? "POST",
    url: payload.url ?? path
  });
  return {
    body: restoreRouteRequestBody(routed.body, adaptation),
    decision: routed.decision
  };
}

function decisionHeaders(decision: ClaudeCodeRouteDecision): Record<string, string> {
  return {
    [ccrRouteStageHeader]: "core-gateway-plugin",
    [ccrRouteReasonHeader]: sanitizeHeaderValue(decision.reason),
    [ccrRouteSourceHeader]: decision.source,
    ...(decision.diagnostics.length > 0 ? { [ccrRouteDiagnosticsHeader]: String(decision.diagnostics.length) } : {}),
    ...(decision.model ? { [ccrRoutedModelHeader]: sanitizeHeaderValue(decision.model) } : {}),
    [ccrRouteFallbackHeader]: encodeCcrRouteFallbackHeader(decision.fallback),
    ...(decision.sessionId ? { [ccrRouteSessionIdHeader]: sanitizeHeaderValue(decision.sessionId) } : {}),
    [ccrRouteTokenCountHeader]: String(decision.tokenCount)
  };
}

function readRouteRequestPayload(value: unknown): CcrRouterPluginRouteRequest | undefined {
  if (!isRecord(value) || !isRecord(value.body)) {
    return undefined;
  }
  return {
    body: value.body,
    ...(isHeaderRecord(value.headers) ? { headers: value.headers } : {}),
    ...(typeof value.method === "string" ? { method: value.method } : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {})
  };
}

function requestedModelFromBody(
  body: Record<string, unknown>,
  path: string,
  fallback: string | undefined
): string | undefined {
  return requestLogRequestedModel(httpRequestBodyBuffer(body), path) ?? fallback;
}

function profileDeniedModel(
  config: AppConfig,
  profile: ProfileConfig | undefined,
  modelBeforeRouting: string | undefined,
  effectiveModel: string | undefined
): string | undefined {
  const modelToAuthorize = effectiveModel ?? modelBeforeRouting;
  return modelToAuthorize && !isModelAllowedForProfile(config, profile, modelToAuthorize)
    ? modelToAuthorize
    : undefined;
}

function profileModelNotAllowedError(model: string): Record<string, unknown> {
  return {
    error: {
      code: "profile_model_not_allowed",
      message: `Model "${model}" is not allowed for this profile.`
    }
  };
}

function resolveCcrGatewayRoute(
  config: AppConfig,
  requestInput: GatewayRequestTransformInput
): GatewayRouteResolution | undefined {
  const method = requestInput.route?.method ?? requestInput.request?.method ?? "GET";
  const url = requestInput.route?.url ?? requestInput.request?.url ?? "/";
  const path = requestPath(url);
  const protocol = requestProtocolForPath(path);
  if (!protocol || !shouldApplyGatewayRouting(method, path) || !isRecord(requestInput.requestBody)) {
    return undefined;
  }

  const routedModel = normalizeRouteSelector(
    readHeader(requestInput.request?.headers, ccrRoutedModelHeader) ??
      requestedModelFromBody(requestInput.requestBody, path, requestInput.model)
  );
  if (!routedModel) {
    return undefined;
  }

  const publicModel = resolveGatewayPublicModelId(routedModel, config) ?? routedModel;
  const modelRegistry = modelRegistryForConfig(config);
  const resolved = modelRegistry.resolve(publicModel) ??
    resolveProfileProviderModel(config, requestInput.request?.headers, publicModel, modelRegistry);
  if (!resolved) {
    return undefined;
  }

  const requestBody = requestBodyWithModel(requestInput.requestBody, resolved.model);
  if (resolved.kind === "gateway") {
    return {
      model: resolved.model,
      requestBody
    };
  }

  const parsedSelector = parseProviderModelSelector(publicModel);
  const targetProviderName = coreGatewayProviderSelectorName(resolved.provider, protocol, parsedSelector?.provider);
  if (!targetProviderName) {
    return undefined;
  }

  return {
    model: resolved.model,
    reason: readHeader(requestInput.request?.headers, ccrRouteReasonHeader),
    requestBody,
    targetProviderName
  };
}

function resolveProfileProviderModel(
  config: AppConfig,
  headers: Record<string, HeaderValue> | undefined,
  model: string,
  modelRegistry: ReturnType<typeof modelRegistryForConfig>
) {
  if (parseProviderModelSelector(model)) {
    return undefined;
  }
  const profileProviderName = authenticatedProfileProviderName(config, headers, modelRegistry);
  return profileProviderName
    ? modelRegistry.resolve(model, { providerName: profileProviderName })
    : undefined;
}

function authenticatedProfileProviderName(
  config: AppConfig,
  headers: Record<string, HeaderValue> | undefined,
  modelRegistry: ReturnType<typeof modelRegistryForConfig>
): string | undefined {
  if (config.profile.enabled === false) {
    return undefined;
  }
  const apiKeyId = readHeader(headers, "x-auth-api-key-id")?.trim() || readHeader(headers, "x-auth-sub")?.trim();
  if (!apiKeyId) {
    return undefined;
  }
  const profile = config.profile.profiles.find((item) =>
    item.enabled && profileApiKeyId(item) === apiKeyId
  );
  const profileModel = normalizeRouteSelector(profile?.model);
  const explicitProvider = parseProviderModelSelector(profileModel)?.provider;
  if (explicitProvider) {
    return explicitProvider;
  }
  const resolvedProfileModel = modelRegistry.resolve(profileModel);
  return resolvedProfileModel?.kind === "provider"
    ? resolvedProfileModel.provider.name
    : undefined;
}

function requestBodyWithModel(body: Record<string, unknown>, model: string): Record<string, unknown> {
  return body.model === model ? body : { ...body, model };
}

function coreGatewayProviderSelectorName(
  provider: GatewayProviderConfig,
  clientProtocol: GatewayProviderProtocol,
  requestedProviderName?: string
): string | undefined {
  const capability = providerCapabilityForClientProtocol(provider, clientProtocol);
  const explicitCapabilities = normalizedProviderCapabilities(provider);
  const protocol = capability?.type ?? (
    explicitCapabilities.length === 0
      ? providerProtocolForClientProtocol(provider, clientProtocol)
      : undefined
  );
  if (!protocol) {
    return undefined;
  }

  if (requestedProviderName && isCoreGatewayRuntimeProviderName(provider, protocol, requestedProviderName)) {
    return requestedProviderName.trim();
  }

  const credentials = sortProviderCredentialsForConfig(activeProviderCredentials(provider));
  if (credentials.length > 0) {
    return providerCredentialInternalName(provider, protocol, credentials[0]);
  }

  return capability ? providerCapabilityInternalName(provider, capability.type) : providerRuntimeId(provider);
}

function isCoreGatewayRuntimeProviderName(
  provider: GatewayProviderConfig,
  protocol: GatewayProviderProtocol,
  value: string
): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const runtimeId = providerRuntimeId(provider).toLowerCase();
  if (normalized === runtimeId) {
    return true;
  }
  const capabilityName = providerCapabilityInternalName(provider, protocol).toLowerCase();
  return normalized === capabilityName || normalized.startsWith(`${capabilityName}::cred:`);
}

function stripUntrustedCcrRouteHeaders(headers: Record<string, HeaderValue> | undefined): void {
  if (!headers) {
    return;
  }
  for (const header of ccrRouteHeaderNames) {
    delete headers[header];
  }
}

function httpRequestBodyBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body);
  }
  if (body === undefined || body === null) {
    return Buffer.alloc(0);
  }
  return Buffer.from(JSON.stringify(body));
}

function readJsonObjectBody(body: unknown): Record<string, unknown> {
  const text = Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === "string"
    ? httpRequestBodyBuffer(body).toString("utf8").trim()
    : "";
  if (!text && isRecord(body)) {
    return body;
  }
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readAppConfig(value: unknown): AppConfig | undefined {
  return isRecord(value) && isRecord(value.appConfig)
    ? value.appConfig as AppConfig
    : undefined;
}

function readPublicGatewayMode(value: unknown): boolean {
  return isRecord(value) && value.publicGatewayMode === true;
}

function readCoreAuthToken(value: unknown): string | undefined {
  return isRecord(value) ? stringValue(value.coreAuthToken) : undefined;
}

function readPublicAuthKeys(value: unknown): string[] {
  return isRecord(value) && Array.isArray(value.publicAuthKeys)
    ? value.publicAuthKeys.map((key) => stringValue(key)).filter((key): key is string => Boolean(key))
    : [];
}

function readRawTraceSyncToken(config: unknown): string | undefined {
  if (!isRecord(config) || !isRecord(config.rawTrace)) {
    return undefined;
  }
  const sync = isRecord(config.rawTrace.sync) ? config.rawTrace.sync : undefined;
  const headers = isRecord(sync?.headers) ? sync.headers : undefined;
  return typeof headers?.[rawTraceSyncHeader] === "string"
    ? headers[rawTraceSyncHeader].trim()
    : undefined;
}

function hasScriptRules(rules: readonly RouterRule[] | undefined): boolean {
  return Boolean(rules?.some((rule) => rule.enabled && rule.type === "script" && rule.script));
}

function requestPath(url: string): string {
  try {
    return new URL(url, "http://ccr.local").pathname;
  } catch {
    return url.split("?")[0] || "/";
  }
}

function readHeader(headers: Record<string, HeaderValue> | undefined, name: string): string | undefined {
  const normalized = name.toLowerCase();
  const value = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === normalized)?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function hasTruthyHeader(headers: Record<string, HeaderValue> | undefined, name: string): boolean {
  const value = readHeader(headers, name)?.trim().toLowerCase();
  return Boolean(value && value !== "0" && value !== "false");
}

function readAuthToken(headers: Record<string, HeaderValue> | undefined): string | undefined {
  for (const headerName of sdkCompatibleTokenHeaderNames) {
    const raw = readHeader(headers, headerName);
    if (raw) {
      return raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : raw.trim();
    }
  }
  return undefined;
}

function readRemoteControlQueryAuthToken(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url, "http://ccr.local");
    if (parsed.pathname !== ccrRemoteControlPathPrefix && !parsed.pathname.startsWith(`${ccrRemoteControlPathPrefix}/`)) {
      return undefined;
    }
    return parsed.searchParams.get("api_key")?.trim() || parsed.searchParams.get("key")?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function authHeadersForToken(
  headers: Record<string, HeaderValue> | undefined,
  token: string
): Record<string, HeaderValue> {
  return {
    ...(headers ?? {}),
    authorization: `Bearer ${token}`
  };
}

function isStaticBypassToken(token: string, coreAuthToken: string | undefined, publicAuthKeys: readonly string[]): boolean {
  return [coreAuthToken, ...publicAuthKeys]
    .map((value) => value?.trim())
    .some((value) => value === token);
}

function isCoreGatewayRequest(headers: Record<string, HeaderValue> | undefined, coreAuthToken: string | undefined): boolean {
  const token = readHeader(headers, coreGatewayAuthHeader)?.trim();
  return Boolean(token && coreAuthToken && constantTimeEqual(token, coreAuthToken));
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function stringHeaders(headers: Record<string, HeaderValue> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(",") : value;
  }
  return result;
}

function cleanStringHeaders(
  headers: Record<string, string | number | boolean | null | undefined> | undefined
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!name.trim() || value === undefined || value === null) {
      continue;
    }
    result[name] = String(value);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

async function requestParentRuntimeConfigReload(
  configRevision: string,
  forceRestart: boolean
): Promise<{ ok: true } | { error: string; ok: false }> {
  const send = (process as NodeJS.Process & {
    send?: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  }).send;
  if (typeof send !== "function") {
    return {
      ok: false,
      error: "CCR runtime configuration reload requires the managed CCR parent process."
    };
  }
  return new Promise((resolve) => {
    send.call(process, {
      configRevision,
      forceRestart,
      protocolVersion: 1,
      type: ccrRuntimeConfigReloadMessageType
    }, (error: Error | null) => {
      if (error) {
        resolve({ ok: false, error: `Failed to notify the CCR parent process: ${error.message}` });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

function pluginPublicEndpoint(config: AppConfig): string {
  return `http://${formatHost(clientGatewayHost(config.gateway.host))}:${config.gateway.port}`;
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function clientGatewayHost(host: string): string {
  const value = stringValue(host) ?? "127.0.0.1";
  if (value === "0.0.0.0") return "127.0.0.1";
  if (value === "::" || value === "[::]") return "::1";
  return value;
}

function sendRawJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function isHeaderRecord(value: unknown): value is Record<string, HeaderValue> {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((item) =>
    item === undefined ||
    typeof item === "string" ||
    (Array.isArray(item) && item.every((entry) => typeof entry === "string"))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
