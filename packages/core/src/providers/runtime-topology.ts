/**
 * Extracted from gateway/service.ts. Keep this module focused on its named gateway boundary.
 */
import { isGatewayProviderEnabled } from "@ccr/core/contracts/app";
import type { AppConfig, GatewayProviderCapability, GatewayProviderCapabilityProtocol, GatewayProviderConfig, GatewayProviderProtocol, ProviderCredentialConfig } from "@ccr/core/contracts/app";
import { assertProviderEndpointAllowed } from "@ccr/core/providers/endpoint-lock";
import { findProviderPresetByBaseUrl, providerApiKeySafetyIssue } from "@ccr/core/providers/presets/index";
import { normalizeProviderBaseUrl as normalizeProviderBaseUrlInput } from "@ccr/core/providers/url";
import { modelRegistryForConfig, parseProviderModelSelector, providerRuntimeId } from "@ccr/core/routing/model-registry";
import { gatewayProviderProtocolFallbackOrder, type CoreGatewayProvider } from "@ccr/core/gateway/internal/shared";

export function providerCapabilityForClientProtocol(
  provider: GatewayProviderConfig,
  clientProtocol: GatewayProviderProtocol
): (GatewayProviderCapability & { type: GatewayProviderProtocol }) | undefined {
  const capabilities = normalizedProviderCapabilities(provider);
  if (clientProtocol === "anthropic_messages") {
    const openRouterChat = capabilities.find((item) => item.type === "openai_chat_completions" &&
      /^https:\/\/openrouter\.ai\/api\/v1(?:\/|$)/i.test(item.baseUrl || readBaseUrl(provider) || ""));
    if (openRouterChat) {
      return { ...openRouterChat, type: "openai_chat_completions" };
    }
    const doitxChat = capabilities.find((item) => item.type === "openai_chat_completions" &&
      findProviderPresetByBaseUrl(item.baseUrl || readBaseUrl(provider) || "")?.id === "doitx");
    if (doitxChat) {
      // 2026-11-03: Doitx 的 Anthropic 端点(/v1/messages)不返回任何缓存用量字段
      //   (同一 prompt 连发两次,input_tokens 相同、无 cache_read/cache_creation),
      //   实测 0% 命中;而同一 provider 的 /v1/chat/completions 命中 99%+。
      //   成本差额约 8×,默认让 Anthropic 客户端走 OpenAI chat 端点。
      //   可通过 provider.anthropicEndpointPreference 切换(chat / messages / auto)。
      const anthropicCapability = capabilities.find(
        (item): item is GatewayProviderCapability & { type: "anthropic_messages" } =>
          item.type === "anthropic_messages"
      );
      const useMessages = shouldUseAnthropicMessagesEndpoint(provider, anthropicCapability);
      return { ...doitxChat, type: useMessages ? "anthropic_messages" : "openai_chat_completions" };
    }
  }
  for (const protocol of providerProtocolPreferenceForClient(clientProtocol)) {
    const capability = capabilities.find(
      (item): item is GatewayProviderCapability & { type: GatewayProviderProtocol } => item.type === protocol
    );
    if (capability) {
      return capability;
    }
  }
  return undefined;
}

// ============= Anthropic 端点偏好(chat / messages / auto) =============

type AnthropicEndpointProbeResult = { expiresAt: number; useMessages: boolean };

const anthropicEndpointProbeTtlMs = 24 * 60 * 60 * 1000;
const anthropicEndpointProbeResults = new Map<string, AnthropicEndpointProbeResult>();
const anthropicEndpointProbesInFlight = new Set<string>();

function shouldUseAnthropicMessagesEndpoint(
  provider: GatewayProviderConfig,
  anthropicCapability: GatewayProviderCapability | undefined
): boolean {
  const preference = provider.anthropicEndpointPreference;
  if (preference === "messages") {
    return true;
  }
  if (preference !== "auto") {
    return false;
  }
  const key = anthropicEndpointProbeKey(provider);
  const cached = anthropicEndpointProbeResults.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.useMessages;
  }
  // 首次(auto 且无缓存):先按 "chat" 处理,后台探测;结果写入缓存供后续请求使用。
  void scheduleAnthropicEndpointProbe(provider, anthropicCapability, key);
  return false;
}

function anthropicEndpointProbeKey(provider: GatewayProviderConfig): string {
  return `${readBaseUrl(provider) ?? ""}|${provider.id || provider.name || ""}`;
}

function scheduleAnthropicEndpointProbe(
  provider: GatewayProviderConfig,
  anthropicCapability: GatewayProviderCapability | undefined,
  key: string
): Promise<void> {
  if (anthropicEndpointProbesInFlight.has(key)) {
    return Promise.resolve();
  }
  if (!anthropicCapability && !readBaseUrl(provider)) {
    return Promise.resolve();
  }
  anthropicEndpointProbesInFlight.add(key);
  return probeAnthropicEndpoint(provider, anthropicCapability)
    .then((useMessages) => {
      anthropicEndpointProbeResults.set(key, {
        expiresAt: Date.now() + anthropicEndpointProbeTtlMs,
        useMessages
      });
    })
    .catch(() => {
      anthropicEndpointProbeResults.set(key, {
        expiresAt: Date.now() + anthropicEndpointProbeTtlMs,
        useMessages: false
      });
    })
    .finally(() => {
      anthropicEndpointProbesInFlight.delete(key);
    });
}

/**
 * 探测 provider 的 Anthropic 端点是否值得使用:
 *   1. prompt cache:同一段 ~15k token 的 prompt 连发两次,第二次需返回
 *      `cache_read_input_tokens > 0`(或 `cache_creation_input_tokens > 0`);
 *   2. 长上下文:发送 ~260k token,上游 `input_tokens + cache_read >= 200k`,
 *      以排除会静默截断的端点(实测 Doitx `/v1/messages` 只处理 ~139k)。
 * 两项都通过才返回 true。任何错误都返回 false(安全回退 chat)。
 */
export async function probeAnthropicEndpoint(
  provider: GatewayProviderConfig,
  anthropicCapability?: GatewayProviderCapability,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const endpoint = anthropicProbeEndpoint(provider, anthropicCapability);
  const apiKey = providerApiKey(provider);
  const model = provider.models?.find((item) => typeof item === "string" && item.trim());
  if (!endpoint || !apiKey || !model) {
    return false;
  }

  const headers = {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "x-api-key": apiKey
  };
  const post = async (text: string, maxTokens: number): Promise<Record<string, unknown> | undefined> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await fetchImpl(endpoint, {
        body: JSON.stringify({
          max_tokens: maxTokens,
          messages: [{ content: [{ cache_control: { type: "ephemeral" }, text, type: "text" }], role: "user" }],
          model,
          stream: false,
          system: [{ cache_control: { type: "ephemeral" }, text: "You are a probe.", type: "text" }]
        }),
        headers,
        method: "POST",
        signal: controller.signal
      });
      if (!response.ok) {
        return undefined;
      }
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  const cacheProbeText = probeText(1_200);
  const first = await post(cacheProbeText, 4);
  if (!first) {
    return false;
  }
  const second = await post(cacheProbeText, 4);
  if (!second) {
    return false;
  }
  const secondUsage = usageNumbers(second);
  if (!(secondUsage.cacheRead > 0 || secondUsage.cacheWrite > 0)) {
    return false;
  }

  const longProbe = await post(probeText(20_000), 1);
  if (!longProbe) {
    return false;
  }
  const longUsage = usageNumbers(longProbe);
  return longUsage.input + longUsage.cacheRead >= 200_000;
}

function probeText(lines: number): string {
  const out: string[] = [];
  for (let index = 0; index < lines; index += 1) {
    out.push(`record ${index}: alpha-${(index * 7919) % 100003} beta-${(index * 104729) % 99991} gamma-${(index * 1299709) % 1000003}`);
  }
  return out.join("\n");
}

function usageNumbers(payload: Record<string, unknown>): { cacheRead: number; cacheWrite: number; input: number } {
  const usage = isPlainRecord(payload.usage) ? payload.usage : {};
  return {
    cacheRead: readFiniteNumber(usage.cache_read_input_tokens) ?? 0,
    cacheWrite: readFiniteNumber(usage.cache_creation_input_tokens) ?? 0,
    input: readFiniteNumber(usage.input_tokens) ?? 0
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function providerApiKey(provider: GatewayProviderConfig): string {
  return provider.api_key || provider.apiKey || provider.apikey || "";
}

function anthropicProbeEndpoint(
  provider: GatewayProviderConfig,
  anthropicCapability: GatewayProviderCapability | undefined
): string | undefined {
  const capabilityEndpoint = anthropicCapability?.endpoint?.trim();
  if (capabilityEndpoint) {
    return /\/messages$/i.test(capabilityEndpoint) && !/\/v1\/messages$/i.test(capabilityEndpoint)
      ? capabilityEndpoint.replace(/\/+$/, "").replace(/\/messages$/i, "/v1/messages")
      : capabilityEndpoint;
  }
  const base = readBaseUrl(provider);
  if (!base) {
    return undefined;
  }
  const normalized = normalizeProviderBaseUrlInput(base, "anthropic_messages") || base.replace(/\/+$/, "");
  return `${normalized.replace(/\/+$/, "")}/v1/messages`;
}

/** 仅供测试:清空探测结果与在途标记。 */
export function _resetAnthropicEndpointProbeForTest(): void {
  anthropicEndpointProbeResults.clear();
  anthropicEndpointProbesInFlight.clear();
}

/** 仅供测试:直接写入探测结果。 */
export function _setAnthropicEndpointProbeResultForTest(
  provider: GatewayProviderConfig,
  useMessages: boolean,
  ttlMs = anthropicEndpointProbeTtlMs
): void {
  anthropicEndpointProbeResults.set(anthropicEndpointProbeKey(provider), {
    expiresAt: Date.now() + ttlMs,
    useMessages
  });
}

export function providerProtocolForClientProtocol(
  provider: GatewayProviderConfig,
  clientProtocol: GatewayProviderProtocol
): GatewayProviderProtocol | undefined {
  const capability = providerCapabilityForClientProtocol(provider, clientProtocol);
  if (capability) {
    return capability.type;
  }
  const directProtocol =
    normalizeProviderProtocol(provider.type) ??
    normalizeProviderProtocol(provider.provider) ??
    inferProtocol(provider);
  return providerProtocolPreferenceForClient(clientProtocol).includes(directProtocol)
    ? directProtocol
    : undefined;
}

function providerProtocolPreferenceForClient(clientProtocol: GatewayProviderProtocol): GatewayProviderProtocol[] {
  if (clientProtocol === "openai_responses") {
    return ["openai_responses", "openai_chat_completions", "anthropic_messages", "gemini_interactions"];
  }
  if (clientProtocol === "openai_chat_completions") {
    return ["openai_chat_completions", "openai_responses"];
  }
  if (clientProtocol === "anthropic_messages") {
    return uniqueProviderProtocols([clientProtocol, ...gatewayProviderProtocolFallbackOrder]);
  }
  return [clientProtocol];
}

function uniqueProviderProtocols(protocols: GatewayProviderProtocol[]): GatewayProviderProtocol[] {
  const seen = new Set<GatewayProviderProtocol>();
  const output: GatewayProviderProtocol[] = [];
  for (const protocol of protocols) {
    if (seen.has(protocol)) {
      continue;
    }
    seen.add(protocol);
    output.push(protocol);
  }
  return output;
}

export function findProviderByPublicOrInternalName(config: AppConfig, name: string): GatewayProviderConfig | undefined {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const credentialInternalName = parseProviderCredentialInternalName(name);
  if (credentialInternalName) {
    const internalProviderId = credentialInternalName.providerId.toLowerCase();
    return config.Providers.find((provider) => {
      if (!isGatewayProviderEnabled(provider)) {
        return false;
      }
      return provider.name.trim().toLowerCase() === internalProviderId ||
        providerRuntimeId(provider).toLowerCase() === internalProviderId;
    });
  }
  return modelRegistryForConfig(config).findProvider(normalized);
}

export function activeProviderCredentials(provider: GatewayProviderConfig): ProviderCredentialConfig[] {
  if (!isGatewayProviderEnabled(provider)) {
    return [];
  }
  return (provider.credentials ?? []).filter((credential) =>
    credential.enabled !== false &&
    Boolean(providerCredentialApiKey(credential))
  );
}

export function providerCredentialPriority(credential: ProviderCredentialConfig, index: number): number {
  return Number.isFinite(credential.priority) ? Number(credential.priority) : index + 1;
}

export function toCoreGatewayProviders(provider: GatewayProviderConfig): CoreGatewayProvider[] {
  if (!isGatewayProviderEnabled(provider)) {
    return [];
  }
  const capabilities = normalizedProviderCapabilities(provider);
  if (capabilities.length === 0) {
    return toCoreGatewayProvidersForCapability(provider);
  }

  return capabilities
    .flatMap((capability) => toCoreGatewayProvidersForCapability(provider, capability))
    .filter((item): item is CoreGatewayProvider => Boolean(item));
}

function toCoreGatewayProvidersForCapability(
  provider: GatewayProviderConfig,
  capability?: GatewayProviderCapability
): CoreGatewayProvider[] {
  const credentials = activeProviderCredentials(provider);
  if (credentials.length === 0) {
    const coreProvider = toCoreGatewayProvider(provider, capability);
    return coreProvider ? [coreProvider] : [];
  }

  return sortProviderCredentialsForConfig(credentials)
    .map((credential) => toCoreGatewayProvider(provider, capability, credential))
    .filter((item): item is CoreGatewayProvider => Boolean(item));
}

function toCoreGatewayProvider(
  provider: GatewayProviderConfig,
  capability?: GatewayProviderCapability,
  credential?: ProviderCredentialConfig
): CoreGatewayProvider | undefined {
  const type =
    capability?.type ??
    normalizeProviderProtocol(provider.type) ??
    normalizeProviderProtocol(provider.provider) ??
    inferProtocol(provider);
  const baseurl = normalizeProviderRuntimeBaseUrl(capability?.baseUrl ?? readBaseUrl(provider), type);
  const apikey = credential ? providerCredentialApiKey(credential) : provider.apikey || provider.apiKey || provider.api_key;

  if (!provider.name || provider.models.length === 0) {
    return undefined;
  }
  const safetyIssue = providerApiKeySafetyIssue({
    apiKey: apikey,
    baseUrl: baseurl ?? "",
    name: provider.name
  });
  if (safetyIssue) {
    throw new Error(safetyIssue.message);
  }

  // 端点硬锁定：这是本仓库能控制的最后一站（核心网关是外部包）。
  // 即使有人直接改 config.json 绕过 UI 校验，这里仍会拒绝编译。
  assertProviderEndpointAllowed(baseurl);

  return {
    apikey,
    baseurl,
    billing: provider.billing,
    extraBody: provider.extraBody,
    extraHeaders: provider.extraHeaders,
    models: provider.models,
    name: credential
      ? providerCredentialInternalName(provider, type, credential)
      : capability
        ? providerCapabilityInternalName(provider, type)
        : providerRuntimeId(provider),
    type
  };
}

export function sortProviderCredentialsForConfig(credentials: ProviderCredentialConfig[]): ProviderCredentialConfig[] {
  return [...credentials].sort((left, right) =>
    providerCredentialPriority(left, 0) - providerCredentialPriority(right, 0) ||
    providerCredentialSortKey(left).localeCompare(providerCredentialSortKey(right))
  );
}

export function normalizedProviderCapabilities(provider: GatewayProviderConfig): GatewayProviderCapability[] {
  const capabilities = Array.isArray(provider.capabilities) ? provider.capabilities : [];
  const normalized: GatewayProviderCapability[] = [];
  const byProtocol = new Map<GatewayProviderCapabilityProtocol, GatewayProviderCapability>();
  for (const capability of capabilities) {
    const type = normalizeProviderCapabilityProtocol(capability.type);
    const baseUrl = capability.baseUrl?.trim();
    if (!type || !baseUrl) {
      continue;
    }
    const item = {
      ...capability,
      baseUrl,
      type
    };
    const existing = byProtocol.get(type);
    if (!existing || providerCapabilityPriority(item) < providerCapabilityPriority(existing)) {
      byProtocol.set(type, item);
    }
  }
  for (const capability of capabilities) {
    const type = normalizeProviderCapabilityProtocol(capability.type);
    const selected = type ? byProtocol.get(type) : undefined;
    if (selected && !normalized.includes(selected)) {
      normalized.push(selected);
    }
  }
  return normalized;
}

function providerCapabilityPriority(capability: GatewayProviderCapability): number {
  if (capability.source === "preset") {
    return 2;
  }
  if (capability.source === "detected") {
    return 1;
  }
  return 0;
}

export function providerCapabilityInternalName(provider: GatewayProviderConfig, protocol: GatewayProviderCapabilityProtocol): string {
  return `${providerRuntimeId(provider)}::${protocol}`;
}

function providerCapabilityLegacyInternalName(providerName: string, protocol: GatewayProviderCapabilityProtocol): string {
  return `${providerName}::${protocol}`;
}

export function providerCapabilityNameMatches(provider: GatewayProviderConfig, protocol: GatewayProviderCapabilityProtocol, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return providerCapabilityInternalName(provider, protocol).toLowerCase() === normalized ||
    providerCapabilityLegacyInternalName(provider.name, protocol).toLowerCase() === normalized;
}

export function sanitizeHeaderValue(value: unknown): string {
  // HTTP header values must be ByteString (code point <= 255). Values derived
  // from user-facing names — model selectors like "小米mimo/...", provider
  // names, route reasons — can contain non-ASCII characters that crash Node's
  // fetch/undici with "Cannot convert argument to a ByteString" (surfaced as
  // 502). Normalize to ASCII while preserving case and printable punctuation.
  const text = typeof value === "string" && value.trim() ? value : "unknown";
  const sanitized = text
    .replace(/[^\x20-\x7E]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

export function providerCredentialInternalName(
  provider: GatewayProviderConfig,
  protocol: GatewayProviderCapabilityProtocol,
  credential: ProviderCredentialConfig
): string {
  return `${providerCapabilityInternalName(provider, protocol)}::cred:${providerCredentialSlug(providerCredentialRuntimeId(provider, credential))}`;
}

export function parseProviderCredentialInternalName(value: string | undefined): {
  credentialSlug: string;
  providerId: string;
  protocol: GatewayProviderCapabilityProtocol;
} | undefined {
  const marker = "::cred:";
  const markerIndex = value?.lastIndexOf(marker) ?? -1;
  if (!value || markerIndex <= 0) {
    return undefined;
  }
  const baseName = value.slice(0, markerIndex);
  const credentialSlug = value.slice(markerIndex + marker.length).trim();
  const protocolSeparator = baseName.lastIndexOf("::");
  if (!credentialSlug || protocolSeparator <= 0) {
    return undefined;
  }
  const protocol = normalizeProviderCapabilityProtocol(baseName.slice(protocolSeparator + 2));
  const providerId = baseName.slice(0, protocolSeparator).trim();
  return protocol && providerId ? { credentialSlug, providerId, protocol } : undefined;
}

export function providerCredentialSlug(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "key";
}

export function providerCredentialRuntimeId(
  provider: GatewayProviderConfig,
  credential: ProviderCredentialConfig,
  index = provider.credentials?.indexOf(credential) ?? -1
): string {
  const explicitId = credential.id?.trim();
  if (explicitId) {
    return explicitId;
  }
  const oneBasedIndex = index >= 0 ? index + 1 : 1;
  const label = credential.name?.trim() || credential.label?.trim();
  return label ? `${providerCredentialSlug(label)}-${oneBasedIndex}` : `key-${oneBasedIndex}`;
}

function providerCredentialSortKey(credential: ProviderCredentialConfig): string {
  return providerCredentialSlug(credential.id || credential.name || credential.label);
}

export function providerCredentialApiKey(credential: ProviderCredentialConfig): string {
  return credential.api_key || credential.apiKey || credential.apikey || "";
}

export function findProviderCredentialByRuntimeId(
  provider: GatewayProviderConfig,
  credentialId: string
): ProviderCredentialConfig | undefined {
  const normalizedId = credentialId.trim();
  const normalizedSlug = providerCredentialSlug(normalizedId);
  return (provider.credentials ?? []).find((credential, index) => {
    const runtimeId = providerCredentialRuntimeId(provider, credential, index);
    return runtimeId === normalizedId || providerCredentialSlug(runtimeId) === normalizedSlug || credential.id?.trim() === normalizedId;
  });
}

export function findProviderCredentialBySlug(
  provider: GatewayProviderConfig,
  credentialSlug: string
): ProviderCredentialConfig | undefined {
  const normalizedSlug = providerCredentialSlug(credentialSlug);
  return (provider.credentials ?? []).find((credential, index) => providerCredentialSlug(providerCredentialRuntimeId(provider, credential, index)) === normalizedSlug);
}

export function normalizeProviderProtocol(value: unknown): GatewayProviderProtocol | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "openai" || normalized === "openai_responses") {
    return "openai_responses";
  }
  if (normalized === "openai_chat" || normalized === "openai_chat_completions") {
    return "openai_chat_completions";
  }
  if (normalized === "anthropic" || normalized === "anthropic_messages") {
    return "anthropic_messages";
  }
  if (normalized === "gemini" || normalized === "gemini_generate_content") {
    return "gemini_generate_content";
  }
  if (
    normalized === "gemini_interactions" ||
    normalized === "gemini-interactions" ||
    normalized === "google_interactions" ||
    normalized === "google-interactions" ||
    normalized === "interactions" ||
    normalized === "interaction"
  ) {
    return "gemini_interactions";
  }
  return undefined;
}

export function normalizeProviderCapabilityProtocol(value: unknown): GatewayProviderCapabilityProtocol | undefined {
  const chatProtocol = normalizeProviderProtocol(value);
  if (chatProtocol) {
    return chatProtocol;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "openai_image_generations" || normalized === "openai_images") {
    return "openai_image_generations";
  }
  if (normalized === "openai_video_generations" || normalized === "openai_videos") {
    return "openai_video_generations";
  }
  if (normalized === "xai_video_generations" || normalized === "xai_videos") {
    return "xai_video_generations";
  }
  return undefined;
}

export function inferProtocol(provider: GatewayProviderConfig): GatewayProviderProtocol {
  const url = readBaseUrl(provider)?.toLowerCase() ?? "";
  const transformerNames = JSON.stringify(provider.transformer ?? "").toLowerCase();
  if (/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/openai(?:\/|$)/.test(url)) {
    return "openai_chat_completions";
  }
  if (url.includes("/interactions") || transformerNames.includes("gemini_interactions")) {
    return "gemini_interactions";
  }
  if (url.includes("generativelanguage.googleapis.com") || transformerNames.includes("gemini")) {
    return "gemini_generate_content";
  }
  if (url.includes("anthropic") || transformerNames.includes("anthropic")) {
    return "anthropic_messages";
  }
  return "openai_chat_completions";
}

export function resolveResponseProviderProtocol(headers: Headers, config: AppConfig | undefined): GatewayProviderProtocol | undefined {
  const ccrProtocol = normalizeProviderProtocol(headers.get("x-ccr-provider-protocol"));
  if (ccrProtocol) {
    return ccrProtocol;
  }
  const providerName =
    headers.get("x-gateway-target-provider-name")?.trim() ||
    headers.get("x-gateway-target-provider")?.trim();
  if (!providerName) {
    return undefined;
  }
  const credentialInternalName = parseProviderCredentialInternalName(providerName);
  if (credentialInternalName) {
    return normalizeProviderProtocol(credentialInternalName.protocol);
  }
  const provider = config ? findProviderByPublicOrInternalName(config, providerName) : undefined;
  if (!provider) {
    return normalizeProviderProtocol(providerName);
  }
  const capability = normalizedProviderCapabilities(provider).find((item) =>
    providerCapabilityNameMatches(provider, item.type, providerName)
  );
  if (capability && normalizeProviderProtocol(capability.type)) {
    return normalizeProviderProtocol(capability.type);
  }
  return normalizeProviderProtocol(provider.type) ?? normalizeProviderProtocol(provider.provider) ?? inferProtocol(provider);
}

export function resolveProviderLogName(headers: Headers, config: AppConfig | undefined, fallbackModel?: string): string | undefined {
  const providerSelector =
    headers.get("x-gateway-target-provider-name")?.trim() ||
    headers.get("x-gateway-target-provider")?.trim();
  const headerProvider = providerSelector && config
    ? findProviderByPublicOrInternalName(config, providerSelector)
    : undefined;
  if (headerProvider) {
    return headerProvider.name;
  }

  const routeProvider = parseProviderModelSelector(fallbackModel)?.provider;
  const modelProvider = routeProvider && config
    ? findProviderByPublicOrInternalName(config, routeProvider)
    : undefined;
  return modelProvider?.name;
}

function normalizeProviderRuntimeBaseUrl(value: string | undefined, type: GatewayProviderCapabilityProtocol): string | undefined {
  if (!value) {
    return undefined;
  }
  return normalizeProviderProtocol(type)
    ? normalizeProviderBaseUrlInput(value, normalizeProviderProtocol(type)) || undefined
    : normalizeProviderBaseUrlInput(value) || undefined;
}

function readBaseUrl(provider: GatewayProviderConfig): string | undefined {
  return provider.baseurl || provider.baseUrl || provider.api_base_url;
}
