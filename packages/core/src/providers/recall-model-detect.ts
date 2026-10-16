/**
 * 自动检测哪些模型支持 recall(tool-calling 往返),产出 recall 白名单(2026-10-16)
 *
 * 背景(见 docs 计划 `fizzy-meandering-russell`):
 *   helix 的 recall 占位符压缩依赖模型会按教学 prompt 调用 hc_recall 工具。
 *   手配 `recallModelPatterns` 白名单繁琐,这里自动探测每个已配置模型的 tool-calling
 *   能力,把支持者写成白名单(精确 model 名),并落 24h 缓存避免重复打上游。
 *
 * 触发:显式 RPC(`detectRecallModels`)/ 可选启动一次性钩子。**绝不监听 config 保存**,
 *   且仅在结果变化时才写回,避免 config 保存 → 网关重启的回环(见 runtime-change.ts)。
 */

import type { AppConfig, GatewayProviderConfig, GatewayProviderProtocol } from "@ccr/core/contracts/app";
import { availableGatewayModelIds, isGatewayProviderEnabled } from "@ccr/core/contracts/app";
import { modelRegistryForConfig } from "@ccr/core/routing/model-registry";
import { normalizeProviderProtocol } from "@ccr/core/providers/runtime-topology";
import { probeModelRecallSupport, type ModelRecallSupportProbe } from "@ccr/core/providers/probe";
import {
  readRecallProbeCache,
  putRecallProbeCacheEntry,
  recallProbeCacheKey,
  type RecallProbeCacheEntry
} from "@ccr/core/observability/helix-recall-probe-cache";

export const HELIX_COMPRESSOR_PLUGIN_ID = "helix-compressor";

export type RecallDetectionResult = {
  /** 待写入 recallModelPatterns 的真实 model 名(精确匹配)。 */
  patterns: string[];
  /** 是否真正跑过网络探测(true)/ 全部命中缓存(false)。 */
  detected: boolean;
  /** 逐模型明细(供 UI 展示)。 */
  results: ModelRecallSupportProbe[];
  /** 与现有 config 相比白名单是否变化。 */
  changed: boolean;
};

export type RecallDetectOptions = {
  /** 注入探测函数(测试用)。默认 probeModelRecallSupport。 */
  probe?: typeof probeModelRecallSupport;
  /** 现在时间(ms,测试用)。 */
  now?: number;
  /** 强制忽略缓存重探。 */
  forceRefresh?: boolean;
};

function providerKey(provider: GatewayProviderConfig): string {
  return provider.name?.trim() || provider.baseurl || provider.baseUrl || provider.api_base_url || "";
}

function protocolFor(provider: GatewayProviderConfig): GatewayProviderProtocol | undefined {
  return normalizeProviderProtocol(provider.type) ?? normalizeProviderProtocol(provider.provider);
}

/** 读 helix 插件配置里的现有白名单 + 检测标志。 */
export function readConfiguredRecallPatterns(config: AppConfig): { patterns: string[]; detected: boolean } {
  const plugin = (config.plugins ?? []).find((item) => item?.id === HELIX_COMPRESSOR_PLUGIN_ID);
  const pluginConfig = plugin?.config;
  const record = pluginConfig && typeof pluginConfig === "object" ? (pluginConfig as Record<string, unknown>) : {};
  const patterns = Array.isArray(record.recallModelPatterns)
    ? record.recallModelPatterns.filter((p): p is string => typeof p === "string")
    : [];
  return { detected: record.recallModelDetected === true, patterns };
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((item) => setB.has(item));
}

/**
 * 枚举已配置 provider 的模型(不含 virtual profile 派生串),逐个探测 recall 支持。
 * 结果:支持的模型精确名去重 + 排序;命中缓存则跳过网络。
 */
export async function detectRecallModelsForConfig(
  config: AppConfig,
  options: RecallDetectOptions = {}
): Promise<RecallDetectionResult> {
  const now = options.now ?? Date.now();
  const probe = options.probe ?? probeModelRecallSupport;
  const cache = options.forceRefresh ? new Map<string, RecallProbeCacheEntry>() : readRecallProbeCache(now);

  // 只取「已启用 provider 的真实模型」,虚拟 profile 派生串(含前缀/后缀)不发探测。
  const targets: Array<{ model: string; provider: GatewayProviderConfig; protocol: GatewayProviderProtocol; providerKey: string }> = [];
  for (const id of availableGatewayModelIds(config)) {
    const resolved = modelRegistryForConfig(config).resolveProviderModel(id);
    if (!resolved || !isGatewayProviderEnabled(resolved.provider)) continue;
    const protocol = protocolFor(resolved.provider);
    if (!protocol) continue;
    targets.push({
      model: resolved.model.trim(),
      protocol,
      provider: resolved.provider,
      providerKey: providerKey(resolved.provider)
    });
  }
  // 同一真实 model 可能被多个 provider 提供 → 按 model+providerKey 去重。
  const seen = new Set<string>();
  const uniqueTargets = targets.filter((target) => {
    const key = recallProbeCacheKey(target.providerKey, target.model);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const { patterns: existingPatterns } = readConfiguredRecallPatterns(config);
  let detected = false;
  const results: ModelRecallSupportProbe[] = [];

  await Promise.all(
    uniqueTargets.map(async (target) => {
      const cacheKey = recallProbeCacheKey(target.providerKey, target.model);
      const cached = cache.get(cacheKey);
      if (cached) {
        results.push({
          depth: cached.depth,
          message: "cached",
          model: target.model,
          protocol: target.protocol,
          recallCapable: cached.depth !== "none"
        });
        return;
      }
      detected = true;
      let probeResult: ModelRecallSupportProbe;
      try {
        probeResult = await probe(target.provider, target.model, target.protocol, config.providerPlugins ?? []);
      } catch (error) {
        // 探测抛错 = 无法判定(未知),标 skipped 以免被当成「确定的 none」写入缓存。
        probeResult = {
          depth: "none",
          message: (error as Error)?.message ?? "probe failed",
          model: target.model,
          protocol: target.protocol,
          recallCapable: false,
          skipped: true
        };
      }
      results.push(probeResult);
      // 仅「已判定」(非 401/403 未知)的结果落缓存。
      if (!probeResult.skipped) {
        putRecallProbeCacheEntry(
          {
            depth: probeResult.depth,
            model: target.model,
            protocol: target.protocol,
            providerKey: target.providerKey
          },
          now
        );
      }
    })
  );

  const patterns = [...new Set(results.filter((r) => r.recallCapable).map((r) => r.model))].sort();
  results.sort((a, b) => a.model.localeCompare(b.model));
  return {
    changed: !sameStringSet(patterns, existingPatterns),
    detected,
    patterns,
    results
  };
}

/**
 * 把检测结果写回 helix 插件 config(recallModelPatterns + recallModelDetected)。
 * 纯函数:返回新 config(浅拷贝 plugins 数组与目标插件对象),不改原对象。
 */
export function applyRecallDetection(config: AppConfig, result: RecallDetectionResult): AppConfig {
  const plugins = (config.plugins ?? []).map((plugin) => {
    if (plugin?.id !== HELIX_COMPRESSOR_PLUGIN_ID) {
      return plugin;
    }
    const pluginConfig = plugin.config && typeof plugin.config === "object" ? (plugin.config as Record<string, unknown>) : {};
    return {
      ...plugin,
      config: {
        ...pluginConfig,
        recallModelDetected: true,
        recallModelPatterns: result.patterns
      }
    };
  });
  return { ...config, plugins };
}
