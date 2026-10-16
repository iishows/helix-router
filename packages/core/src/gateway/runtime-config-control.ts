import { createHash } from "node:crypto";
import type { AppConfig } from "@ccr/core/contracts/app";

export const gatewayRuntimeConfigControlPath = "/__ccr/runtime/config";

/**
 * helix V1.2 / 2026-10-13: 算 running revision 跟 saved revision 对齐
 *   之前 saved 用 appConfigRevision(排除 APIKEY/APIKEYS 4 字段,用 JSON.stringify)算
 *   running 用本函数(stableJson 算整个 config)算,两个函数永远算不同 hash,
 *   导致 "Failed to update the externally managed CCR gateway: Timed out" 错误。
 *
 *   修法:用与 appConfigRevision 完全相同的 stableJson 算法,且排除相同的 4 字段
 *   (theme/configRevision/APIKEY/APIKEYS),保证 saved/running hash 一致。
 *
 *   V1.2 / 2026-10-13 二次修:除 4 字段排除外,还需 sanitize profile。
 *     - in-memory config 上 profile.profiles[*] 有 remoteFrontendMode="app"
 *       (parseProfiles 从 frontendMode/coreMode 恢复 + 默认 "app"),
 *     - 但 saved disk 上的 profile 没这个字段
 *       (sanitizeProfileConfigForDisk 删了 codex.remoteFrontendMode 和
 *        profiles[*] 的 coreMode/frontendMode/remoteFrontendMode)。
 *     不 sanitize 就永远 saved != running,导致外部 gateway 重载 timeout。
 *     此 sanitize 必须跟 packages/core/src/config/config-repository.ts 中
 *     appConfigRevision 的 sanitizeProfileForRevision 完全一致。
 */
export function gatewayRuntimeConfigRevision(config: AppConfig | undefined): string | undefined {
  if (!config) {
    return undefined;
  }
  // 排除 4 字段: theme, configRevision, APIKEY, APIKEYS(跟 appConfigRevision 一致)
  const { theme: _theme, configRevision: _revision, APIKEY: _key, APIKEYS: _keys, ...settings } =
    config as unknown as Record<string, unknown>;
  const sanitized = sanitizeProfileForRevision(settings);
  return createHash("sha256")
    .update(stableJson(sanitized))
    .digest("hex");
}

function sanitizeProfileForRevision(value: Record<string, unknown>): Record<string, unknown> {
  const result = { ...value };
  // V1.2 helix follow-up / 2026-10-13: 排除 gateway.coreHost/corePort。
  //   loadAppConfig 用 DEFAULT_CONFIG.gateway merge 写入 coreHost/corePort,
  //   saved disk 上从未保存这俩字段。in-memory 带这俩,saved 没有,sanitize 后
  //   仍然不同 → "Failed to update the externally managed CCR gateway: Timed out"。
  if (result.gateway && typeof result.gateway === "object" && !Array.isArray(result.gateway)) {
    const gw = { ...(result.gateway as Record<string, unknown>) };
    delete gw.coreHost;
    delete gw.corePort;
    result.gateway = gw;
  }
  if (result.profile && typeof result.profile === "object" && !Array.isArray(result.profile)) {
    result.profile = sanitizeProfile(result.profile as Record<string, unknown>);
  }
  return result;
}

function sanitizeProfile(profile: Record<string, unknown>): Record<string, unknown> {
  const result = { ...profile };
  if (result.codex && typeof result.codex === "object" && !Array.isArray(result.codex)) {
    const codex = { ...(result.codex as Record<string, unknown>) };
    delete codex.remoteFrontendMode;
    result.codex = codex;
  }
  if (Array.isArray(result.profiles)) {
    result.profiles = (result.profiles as unknown[]).map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const profileItem = { ...(item as Record<string, unknown>) };
      const agent = profileItem.agent;
      if (agent !== "codex" && agent !== "opencode" && agent !== "kilo" && agent !== "workbuddy" && agent !== "zcode") {
        return profileItem;
      }
      delete profileItem.coreMode;
      delete profileItem.frontendMode;
      delete profileItem.remoteFrontendMode;
      return profileItem;
    });
  }
  return result;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
