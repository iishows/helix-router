import { providerUrlWithDefaultScheme } from "@ccr/core/providers/url";

/**
 * 端点硬锁定：让实例只服务白名单内的 provider 端点。
 *
 * 由 `CCR_LOCK_PROVIDER_ENDPOINT` 控制（逗号分隔可多个），未设置或全空白时视为不启用，
 * 行为与通用 CCR 完全一致。比对按 origin（scheme + host + port）进行，
 * 因此 `https://router.doitx.ai`、`https://router.doitx.ai/v1` 视为同一端点。
 */
export const providerEndpointLockEnv = "CCR_LOCK_PROVIDER_ENDPOINT";

export const providerEndpointLockedCode = "provider_endpoint_locked";

export type ProviderEndpointLockState = {
  /** 归一化后的白名单 origin，逗号分隔；未启用时为 undefined。 */
  endpoint?: string;
  locked: boolean;
};

export type ProviderEndpointLockIssue = {
  allowed: string[];
  code: typeof providerEndpointLockedCode;
  message: string;
  rejected: string;
};

export function isProviderEndpointLocked(): boolean {
  return lockedProviderEndpointOrigins().length > 0;
}

/** 读取并归一化白名单 origin；未配置时返回空数组。 */
export function lockedProviderEndpointOrigins(): string[] {
  const raw = process.env[providerEndpointLockEnv];
  if (!raw) {
    return [];
  }

  return uniqueOrigins(raw.split(","));
}

export function lockedProviderEndpointOriginsText(): string | undefined {
  const origins = lockedProviderEndpointOrigins();
  return origins.length > 0 ? origins.join(", ") : undefined;
}

/**
 * 校验单个 provider base URL 是否在白名单内。
 * 返回 `undefined` 表示放行；返回 issue 表示需拒绝。
 */
export function providerEndpointLockIssue(rawUrl: string | undefined): ProviderEndpointLockIssue | undefined {
  const allowed = lockedProviderEndpointOrigins();
  if (allowed.length === 0) {
    return undefined;
  }

  const value = (rawUrl ?? "").trim();
  if (!value) {
    return undefined;
  }

  const origin = providerOrigin(value);
  if (!origin) {
    return undefined;
  }

  if (allowed.includes(origin)) {
    return undefined;
  }

  return {
    allowed,
    code: providerEndpointLockedCode,
    message:
      `Provider endpoint "${value}" is not allowed: this instance is locked to ${allowed.join(", ")}. ` +
      `Remove it from ${providerEndpointLockEnv} to allow other endpoints.`,
    rejected: value
  };
}

export function assertProviderEndpointAllowed(rawUrl: string | undefined): void {
  const issue = providerEndpointLockIssue(rawUrl);
  if (issue) {
    const error = new Error(issue.message);
    error.name = providerEndpointLockedCode;
    throw error;
  }
}

function uniqueOrigins(values: readonly string[]): string[] {
  const origins: string[] = [];
  for (const value of values) {
    const origin = providerOrigin(value);
    if (origin && !origins.includes(origin)) {
      origins.push(origin);
    }
  }

  return origins;
}

/** 归一化为 origin（scheme + host + port），默认端口由 URL 自动去除。 */
function providerOrigin(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return new URL(providerUrlWithDefaultScheme(trimmed)).origin.toLowerCase();
  } catch {
    return undefined;
  }
}
