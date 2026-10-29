import { doitxProviderPreset } from "@ccr/core/providers/presets/doitx/index";
import {
  findProviderPresetByBaseUrlInList,
  findProviderPresetInList,
  primaryProviderPresetEndpoint,
  providerApiKeySafetyIssueInList,
  providerEndpointCanReceiveProviderApiKeyInList,
  providerIdentitySafetyIssueInList,
  providerPresetMatchesBaseUrl
} from "@ccr/core/providers/presets/utils";
import type { ProviderIdentitySafetyIssue, ProviderPreset } from "@ccr/core/providers/presets/types";

export const providerPresets: ProviderPreset[] = [doitxProviderPreset];

export function getProviderPresets(): ProviderPreset[] {
  return JSON.parse(JSON.stringify(providerPresets)) as ProviderPreset[];
}

export function findProviderPreset(id: string | undefined): ProviderPreset | undefined {
  return findProviderPresetInList(providerPresets, id);
}

export function findProviderPresetByBaseUrl(baseUrl: string): ProviderPreset | undefined {
  return findProviderPresetByBaseUrlInList(providerPresets, baseUrl);
}

export { primaryProviderPresetEndpoint, providerPresetMatchesBaseUrl };

export function providerIdentitySafetyIssue(input: {
  baseUrl: string;
  name?: string;
  presetId?: string;
}): ProviderIdentitySafetyIssue | undefined {
  return providerIdentitySafetyIssueInList(providerPresets, input);
}

export function providerApiKeySafetyIssue(input: {
  apiKey?: string;
  baseUrl: string;
  name?: string;
  presetId?: string;
}): ProviderIdentitySafetyIssue | undefined {
  return providerApiKeySafetyIssueInList(providerPresets, input);
}

export function providerEndpointCanReceiveProviderApiKey(input: {
  apiKey?: string;
  endpoint: string;
  providerName?: string;
  providerPresetId?: string;
}): ProviderIdentitySafetyIssue | undefined {
  return providerEndpointCanReceiveProviderApiKeyInList(providerPresets, input);
}
