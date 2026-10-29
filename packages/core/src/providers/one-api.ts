import type { ProviderAccountConfig, ProviderAccountConnectorSource, ProviderAccountMeter } from "@ccr/core/contracts/app";
import { newApiRootBaseUrl } from "@ccr/core/providers/new-api";

export function oneApiBillingSubscriptionEndpoint(baseUrl: string): string {
  const root = newApiRootBaseUrl(baseUrl);
  return `${root}/v1/dashboard/billing/subscription`;
}

export function oneApiBillingUsageEndpoint(baseUrl: string, start: Date, end: Date): string {
  const root = newApiRootBaseUrl(baseUrl);
  const params = new URLSearchParams({
    end_date: oneApiBillingDateString(end),
    start_date: oneApiBillingDateString(start)
  });
  return `${root}/v1/dashboard/billing/usage?${params.toString()}`;
}

export function oneApiBillingDateWindow(now: Date = new Date()): { end: Date; start: Date } {
  const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return { end, start };
}

function oneApiBillingDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function oneApiBillingMeters(
  subscription: unknown,
  usage: unknown,
  source: ProviderAccountConnectorSource = "http-json"
): ProviderAccountMeter[] {
  const subscriptionRecord = oneApiBillingDataRecord(subscription);
  if (!subscriptionRecord) {
    return [];
  }
  const limit = oneApiBillingLimitUsd(subscriptionRecord);
  if (limit === undefined) {
    return [];
  }
  const used = oneApiBillingUsedUsd(usage);
  const remaining = used !== undefined ? limit - used : undefined;
  return [
    {
      id: "one_api_billing_balance",
      kind: "balance",
      label: "Balance",
      ...(limit !== undefined ? { limit } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      source,
      unit: "USD",
      ...(used !== undefined ? { used } : {}),
      window: "monthly"
    }
  ];
}

function oneApiBillingLimitUsd(record: Record<string, unknown>): number | undefined {
  return normalizePositiveNumber(record.hard_limit_usd) ?? normalizePositiveNumber(record.system_hard_limit_usd);
}

function oneApiBillingUsedUsd(usage: unknown): number | undefined {
  const record = oneApiBillingDataRecord(usage);
  const value = record ? normalizePositiveNumber(record.total_usage) : undefined;
  if (value === undefined) {
    return undefined;
  }
  // one-api family returns total_usage in 0.01-cent units: USD = value / 100 / 100.
  return value / 10_000;
}

function oneApiBillingDataRecord(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const data = payload.data;
  if (isRecord(data)) {
    return data;
  }
  return payload;
}

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function oneApiBillingAccountConfig(baseUrl: string): ProviderAccountConfig {
  return {
    connectors: [
      {
        auth: "provider-api-key",
        endpoint: oneApiBillingSubscriptionEndpoint(baseUrl),
        mapping: { meters: [] },
        method: "GET",
        parser: "one-api-billing",
        type: "http-json"
      }
    ],
    enabled: true
  };
}
