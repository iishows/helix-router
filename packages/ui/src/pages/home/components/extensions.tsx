import {
  AnimatedDisclosure, AnimatedListItem, AnimatePresence, AppConfig, Braces, buildExtensionList, Button,
  Card, CardContent, CardHeader, Check, ChevronDown, CircleAlert, ClaudeDesignRouteRuleType,
  claudeDesignRouteRuleTypeLabel, claudeDesignRouteRuleTypeOptions, ClaudeDesignRoutingDraft, ClaudeDesignRoutingRuleDraft, createRouteModelOptions, Dialog,
  DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, ExtensionListItem,
  cn, extensionMatchesQuery, ExtensionSource, Field, Gauge, GatewayProviderConfig, HELIX_COMPRESSOR_PLUGIN_ID,
  helixCompactBudgetRangeLabel, Input, isClaudeDesignStaticRuleType, Label, LoaderCircle, motion, normalizeClaudeDesignRuleTypeChange,
  Play, PluginSettingsDraft, Plus, readHelixCompactBudgetPercent, readHelixRecallPatterns, RefreshCw, RouteTargetControl,
  Search, SelectControl, Settings, TextAreaControl, Toggle, translateOptions,
  Trash2, useAppText, useMemo, useState, writeHelixCompactBudgetPercent, writeHelixRecallPatterns, X
} from "../shared/index";
import type { RecallModelDetectionResult, RecallModelProbeEntry } from "@ccr/core/contracts/app";
export function ExtensionsView({
  configureExtension,
  config,
  installExtension,
  openExtensionApp,
  removeExtension,
  setExtensionEnabled
}: {
  configureExtension: (source: ExtensionSource, index: number) => void;
  config: AppConfig;
  installExtension: () => void;
  openExtensionApp: (index: number, appId?: string) => void;
  removeExtension: (source: ExtensionSource, index: number, groupIndexes: number[]) => void;
  setExtensionEnabled: (source: ExtensionSource, index: number, enabled: boolean, groupIndexes: number[]) => void;
}) {
  const t = useAppText();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const extensions = useMemo(() => buildExtensionList(config), [config.plugins, config.providerPlugins]);
  const visibleExtensions = useMemo(
    () => extensions.filter((extension) => extensionMatchesQuery(extension, normalizedQuery)),
    [extensions, normalizedQuery]
  );

  return (
    <motion.div
      animate={{ opacity: 1 }}
      className="flex h-full min-h-0 min-w-0 flex-col"
      initial={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      <Card className="flex h-full min-h-0 min-w-0 flex-col">
        <CardHeader className="flex-row items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 z-[1] h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label={t("Search extensions")}
              className="pl-8"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("Search extensions")}
              value={query}
            />
          </div>
          <Button aria-label={t("Install extension")} onClick={installExtension} title={t("Install extension")} type="button">
            <Plus className="h-4 w-4" />
            {t("Install")}
          </Button>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-auto p-0">
          {extensions.length === 0 ? (
            <div className="m-4 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-10 text-center">
              <Braces className="mx-auto mb-2 h-7 w-7 text-muted-foreground/40" />
              <div className="text-[12px] text-muted-foreground">{t("No extensions installed")}</div>
              <div className="mt-1 text-[11px] text-muted-foreground/60">{t("Click Install to add one")}</div>
            </div>
          ) : null}
          {extensions.length > 0 && visibleExtensions.length === 0 ? (
            <div className="m-4 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-10 text-center text-[12px] text-muted-foreground">{t("No matching extensions")}</div>
          ) : null}
          {visibleExtensions.length > 0 ? (
            <div className="min-w-0">
              <div className="min-w-[720px]">
                <div className="sticky top-0 z-10 grid h-10 grid-cols-[minmax(180px,0.95fr)_minmax(220px,1.15fr)_minmax(240px,1.2fr)_116px_116px] items-center gap-3 border-b border-border/60 bg-muted/95 px-4 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  <div className="truncate">{t("Name")}</div>
                  <div className="truncate">{t("Path")}</div>
                  <div className="truncate">{t("Capability")}</div>
                  <div className="truncate">{t("Status")}</div>
                  <div aria-hidden="true" />
                </div>
                <div className="divide-y divide-border/60">
                  <AnimatePresence initial={false}>
                  {visibleExtensions.map((extension) => {
                    const appId = extension.source === "plugins" ? openablePluginAppId(config, extension.index) : undefined;
                    return (
                    <AnimatedListItem
                      className="grid min-h-[58px] grid-cols-[minmax(180px,0.95fr)_minmax(220px,1.15fr)_minmax(240px,1.2fr)_116px_116px] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/35"
                      key={`${extension.source}-${extension.index}`}
                    >
                      <div className="min-w-0">
                        <div className="truncate text-[12px] font-semibold">{extension.name}</div>
                      </div>
                      <div className="min-w-0 truncate text-[11px] text-muted-foreground" title={extension.target}>
                        {extension.target}
                      </div>
                      <div className="min-w-0 truncate text-[11px] text-muted-foreground" title={extension.capability}>
                        {extension.capability}
                      </div>
                      <div className="flex min-w-0 items-center gap-2">
                        {extension.canToggle ? (
                          <Toggle checked={extension.enabled} onChange={(enabled) => setExtensionEnabled(extension.source, extension.index, enabled, extension.groupIndexes)} />
                        ) : null}
                      </div>
                      <div className="flex items-center justify-end gap-1">
                        {appId ? (
                          <Button
                            aria-label={`${t("Open")} ${extension.name}`}
                            onClick={() => openExtensionApp(extension.index, appId)}
                            size="iconSm"
                            title={t("Open plugin app")}
                            type="button"
                            variant="ghost"
                          >
                            <Play className="h-3.5 w-3.5" />
                          </Button>
                        ) : null}
                        <Button
                          aria-label={`${t("Configure")} ${extension.name}`}
                          disabled={!extension.canConfigure}
                          onClick={() => configureExtension(extension.source, extension.index)}
                          size="iconSm"
                          title={t("Configure plugin")}
                          type="button"
                          variant="ghost"
                        >
                          <Settings className="h-3.5 w-3.5" />
                        </Button>
                        <Button aria-label={`${t("Remove")} ${extension.name}`} onClick={() => removeExtension(extension.source, extension.index, extension.groupIndexes)} size="iconSm" title={t("Remove extension")} type="button" variant="ghost">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </AnimatedListItem>
                    );
                  })}
                  </AnimatePresence>
                </div>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </motion.div>
  );
}

function openablePluginAppId(config: AppConfig, index: number): string | undefined {
  const plugin = config.plugins[index];
  if (!plugin || plugin.enabled === false || plugin.surfaces?.apps === false) {
    return undefined;
  }
  const configuredApp = plugin.apps?.find((app) => app.name?.trim() && app.url?.trim());
  if (configuredApp) {
    return configuredApp.id?.trim() || configuredApp.name.trim();
  }
  if (plugin.id === "claude-design") {
    return "claude-design";
  }
  if (plugin.id === "claude-ship") {
    return "claude-ship";
  }
  return undefined;
}

export function DeleteExtensionDialog({
  extension,
  onClose,
  onConfirm
}: {
  extension: ExtensionListItem;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useAppText();

  return (
    <Dialog onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle>{t("Delete Extension")}</DialogTitle>
          </div>
          <Button aria-label={t("Close dialog")} onClick={onClose} size="iconSm" title={t("Close")} type="button" variant="ghost">
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>

        <DialogBody>
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5">
            <div className="flex items-start gap-2 text-[12px] font-medium text-destructive">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t("Delete this extension from the configuration?")}</span>
            </div>
            <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
              <div className="truncate" title={extension.name}>
                <span className="font-medium text-foreground">{t("Name")}:</span> {extension.name}
              </div>
              <div className="truncate" title={extension.target}>
                <span className="font-medium text-foreground">{t("Path")}:</span> {extension.target}
              </div>
              <div className="truncate" title={extension.capability}>
                <span className="font-medium text-foreground">{t("Capability")}:</span> {extension.capability}
              </div>
              <div>{t("This action is applied immediately to the draft config and will auto-save with other changes.")}</div>
            </div>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button autoFocus onClick={onClose} type="button" variant="outline">
            {t("Cancel")}
          </Button>
          <Button onClick={onConfirm} type="button" variant="destructive">
            <Trash2 className="h-4 w-4" />
            {t("Delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PluginSettingsDialog({
  draft,
  error,
  extension,
  onChange,
  onClose,
  onSubmit
}: {
  draft: PluginSettingsDraft;
  error: string;
  extension: ExtensionListItem;
  onChange: (patch: Partial<PluginSettingsDraft>) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const t = useAppText();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <Dialog onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[720px]">
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle>{t("Plugin Settings")}</DialogTitle>
          </div>
          <Button aria-label={t("Close dialog")} onClick={onClose} size="iconSm" title={t("Close")} type="button" variant="ghost">
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>

        <DialogBody>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_1fr]">
              <Field label={t("Enabled")}>
                <Toggle checked={draft.enabled} onChange={(enabled) => onChange({ enabled })} />
              </Field>
              <Field label={t("Name")}>
                <Input readOnly value={extension.name} />
              </Field>
              <Field className="sm:col-span-2" label={t("Module path")}>
                <Input value={draft.modulePath} onChange={(event) => onChange({ modulePath: event.target.value })} />
              </Field>
            </div>

            {extension.name === HELIX_COMPRESSOR_PLUGIN_ID ? (
              <HelixCompressorPanel draft={draft} onChange={onChange} />
            ) : null}

            <div className="overflow-hidden rounded-md border border-border bg-background">
              <Button
                aria-expanded={advancedOpen}
                className="flex h-10 w-full items-center justify-between gap-3 px-3 text-left text-[12px] font-medium transition-colors hover:bg-muted/40"
                onClick={() => setAdvancedOpen((value) => !value)}
                type="button"
                unstyled
              >
                <span className="min-w-0 truncate">{t("Advanced settings")}</span>
                <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", advancedOpen && "rotate-180")} />
              </Button>
              <AnimatePresence initial={false}>
                {advancedOpen ? (
                  <AnimatedDisclosure key="plugin-settings-advanced">
                    <div className="space-y-4 border-t border-border p-3">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <Field label={t("App surface")}>
                          <Toggle checked={draft.appsSurfaceEnabled} onChange={(appsSurfaceEnabled) => onChange({ appsSurfaceEnabled })} />
                        </Field>
                        <Field label={t("Gateway surface")}>
                          <Toggle checked={draft.gatewaySurfaceEnabled} onChange={(gatewaySurfaceEnabled) => onChange({ gatewaySurfaceEnabled })} />
                        </Field>
                        <Field label={t("Provider surface")}>
                          <Toggle checked={draft.providerSurfaceEnabled} onChange={(providerSurfaceEnabled) => onChange({ providerSurfaceEnabled })} />
                        </Field>
                      </div>

                      <Field label={t("Browser apps JSON")}>
                        <TextAreaControl minHeight={132} value={draft.appsText} onChange={(appsText) => onChange({ appsText })} />
                      </Field>

                      <Field label={t("Plugin permissions JSON")}>
                        <TextAreaControl minHeight={120} value={draft.permissionsText} onChange={(permissionsText) => onChange({ permissionsText })} />
                      </Field>

                      <Field label={t("Plugin proxy JSON")}>
                        <TextAreaControl minHeight={120} value={draft.proxyText} onChange={(proxyText) => onChange({ proxyText })} />
                      </Field>

                      <Field label={t("Plugin core gateway JSON")}>
                        <TextAreaControl minHeight={132} value={draft.coreGatewayText} onChange={(coreGatewayText) => onChange({ coreGatewayText })} />
                      </Field>

                      <Field label={t("Plugin config JSON")}>
                        <TextAreaControl minHeight={160} value={draft.configText} onChange={(configText) => onChange({ configText })} />
                      </Field>
                    </div>
                  </AnimatedDisclosure>
                ) : null}
              </AnimatePresence>
            </div>

            {error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">{t(error)}</div>
            ) : null}
          </div>
        </DialogBody>

        <DialogFooter>
          <Button onClick={onClose} type="button" variant="outline">
            {t("Cancel")}
          </Button>
          <Button onClick={onSubmit} type="button">
            <Check className="h-4 w-4" />
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HelixCompressorPanel({
  draft,
  onChange
}: {
  draft: PluginSettingsDraft;
  onChange: (patch: Partial<PluginSettingsDraft>) => void;
}) {
  const t = useAppText();
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState("");
  const [detectResult, setDetectResult] = useState<RecallModelDetectionResult | undefined>(undefined);
  const percent = readHelixCompactBudgetPercent(draft.configText);

  function updatePercent(next: number | undefined) {
    onChange({ configText: writeHelixCompactBudgetPercent(draft.configText, next) });
  }

  async function detectRecallModels() {
    if (!window.ccr?.detectRecallModels) {
      setDetectError(t("Model detection is unavailable."));
      return;
    }
    setDetecting(true);
    setDetectError("");
    try {
      const result = await window.ccr.detectRecallModels({});
      setDetectResult(result);
    } catch (error) {
      setDetectError(error instanceof Error ? error.message : String(error));
    } finally {
      setDetecting(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-md border border-border bg-background">
      <div className="flex h-10 items-center gap-2 border-b border-border px-3 text-[12px] font-medium">
        <Gauge className="h-4 w-4 text-muted-foreground" />
        <span className="min-w-0 truncate">{t("Helix compression")}</span>
      </div>

      <div className="space-y-4 p-3">
        <Field label={t("Compact budget percent")}>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                aria-label={t("Compact budget percent")}
                className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                max={100}
                min={1}
                onChange={(event) => updatePercent(Number(event.target.value))}
                step={1}
                type="range"
                value={percent ?? 50}
              />
              <Input
                className="w-20 shrink-0"
                inputMode="numeric"
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  if (!raw) {
                    updatePercent(undefined);
                    return;
                  }
                  const parsed = Number(raw);
                  if (Number.isFinite(parsed) && parsed >= 1) {
                    updatePercent(Math.min(100, Math.floor(parsed)));
                  }
                }}
                value={percent === undefined ? "" : String(percent)}
              />
              <span className="shrink-0 text-[12px] text-muted-foreground">%</span>
            </div>
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span className="min-w-0 truncate">{t(helixCompactBudgetRangeLabel(percent))}</span>
              {percent === undefined ? (
                <Button onClick={() => updatePercent(50)} size="sm" type="button" variant="outline">{t("Enable")}</Button>
              ) : (
                <Button onClick={() => updatePercent(undefined)} size="sm" type="button" variant="ghost">{t("Disable")}</Button>
              )}
            </div>
          </div>
        </Field>

        <Field label={t("Recall model whitelist")}>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Button disabled={detecting} onClick={() => void detectRecallModels()} type="button" variant="outline">
                {detecting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {detecting ? t("Detecting...") : t("Auto-detect recall models")}
              </Button>
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                {t("Probes configured models for tool-calling and writes the supported ones to the whitelist.")}
              </span>
            </div>
            {detectError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">{detectError}</div>
            ) : null}
            {detectResult ? <RecallDetectionSummary result={detectResult} /> : null}
            <RecallPatternEditor configText={draft.configText} onChange={(configText) => onChange({ configText })} />
          </div>
        </Field>
      </div>
    </div>
  );
}

/** 手动编辑 recall 白名单 + 排除表(空白名单 = 全部模型,已检测时 = 真的没有)。 */
function RecallPatternEditor({
  configText,
  onChange
}: {
  configText: string;
  onChange: (configText: string) => void;
}) {
  const t = useAppText();
  const { detected, excludePatterns, patterns } = readHelixRecallPatterns(configText);
  const [patternDraft, setPatternDraft] = useState("");
  const [excludeDraft, setExcludeDraft] = useState("");

  function commit(nextPatterns: string[], nextExclude: string[], nextDetected = detected) {
    onChange(writeHelixRecallPatterns(configText, nextPatterns, nextExclude, nextDetected));
  }

  function addPattern(list: string[], raw: string): string[] | undefined {
    const value = raw.trim();
    if (!value || list.includes(value)) return undefined;
    return [...list, value];
  }

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <PatternList
        emptyHint={detected
          ? t("No model supports recall - nothing is compressed.")
          : t("Empty = all models are compressed.")}
        label={t("Whitelist (empty = all)")}
        onAdd={() => {
          const next = addPattern(patterns, patternDraft);
          if (!next) return;
          commit(next, excludePatterns);
          setPatternDraft("");
        }}
        onRemove={(index) => commit(patterns.filter((_, i) => i !== index), excludePatterns)}
        onDraft={setPatternDraft}
        patterns={patterns}
        placeholder={t("e.g. MiniMax-*")}
        value={patternDraft}
      />
      <PatternList
        emptyHint={t("Empty = nothing excluded.")}
        label={t("Exclude list")}
        onAdd={() => {
          const next = addPattern(excludePatterns, excludeDraft);
          if (!next) return;
          commit(patterns, next);
          setExcludeDraft("");
        }}
        onRemove={(index) => commit(patterns, excludePatterns.filter((_, i) => i !== index))}
        onDraft={setExcludeDraft}
        patterns={excludePatterns}
        placeholder={t("e.g. gpt-4o-*")}
        value={excludeDraft}
      />
    </div>
  );
}

function PatternList({
  emptyHint,
  label,
  onAdd,
  onDraft,
  onRemove,
  patterns,
  placeholder,
  value
}: {
  emptyHint: string;
  label: string;
  onAdd: () => void;
  onDraft: (value: string) => void;
  onRemove: (index: number) => void;
  patterns: string[];
  placeholder: string;
  value: string;
}) {
  const t = useAppText();
  return (
    <div className="space-y-1.5">
      <span className="text-[12px] font-medium">{label}</span>
      <div className="flex items-center gap-2">
        <Input
          className="min-w-0 flex-1"
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onAdd();
            }
          }}
          placeholder={placeholder}
          value={value}
        />
        <Button disabled={!value.trim()} onClick={onAdd} size="sm" type="button" variant="outline">
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {patterns.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {patterns.map((pattern, index) => (
            <span className="flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px]" key={pattern}>
              {pattern}
              <button
                aria-label={t("Remove")}
                className="text-muted-foreground hover:text-destructive"
                onClick={() => onRemove(index)}
                type="button"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground">{emptyHint}</div>
      )}
    </div>
  );
}

function RecallDetectionSummary({ result }: { result: RecallModelDetectionResult }) {
  const t = useAppText();
  const [listOpen, setListOpen] = useState(false);

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/25 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        <span className="font-medium">
          {t("Supported models")}: {result.patterns.length}
        </span>
        <span className="text-muted-foreground">
          {result.detected ? t("Ran live probe") : t("All results cached")}
        </span>
        <span className={cn("text-muted-foreground", result.changed && "text-emerald-600")}>
          {result.changed ? t("Whitelist updated") : t("Whitelist unchanged")}
        </span>
        {result.results.length > 0 ? (
          <Button onClick={() => setListOpen((value) => !value)} size="sm" type="button" variant="ghost">
            {listOpen ? t("Hide details") : t("Show details")}
          </Button>
        ) : null}
      </div>

      {result.patterns.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {result.patterns.map((pattern) => (
            <span className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px]" key={pattern}>{pattern}</span>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground">{t("No models currently support recall.")}</div>
      )}

      {listOpen ? (
        <div className="max-h-52 overflow-auto rounded border border-border bg-background">
          <table className="w-full border-collapse text-[11px]">
            <thead className="sticky top-0 bg-muted/95 text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left font-medium">{t("Model")}</th>
                <th className="px-2 py-1 text-left font-medium">{t("Protocol")}</th>
                <th className="px-2 py-1 text-left font-medium">{t("Depth")}</th>
              </tr>
            </thead>
            <tbody>
              {result.results.map((entry) => (
                <tr className="border-t border-border/60" key={`${entry.protocol}-${entry.model}`}>
                  <td className="px-2 py-1 font-mono">{entry.model}</td>
                  <td className="px-2 py-1 text-muted-foreground">{entry.protocol}</td>
                  <td className={cn("px-2 py-1", recallDepthTone(entry))}>{recallDepthLabel(entry, t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function recallDepthLabel(entry: RecallModelProbeEntry, t: (value: string) => string): string {
  if (entry.skipped) {
    return t("Unknown (auth)");
  }
  if (entry.depth === "tools") {
    return t("Tools");
  }
  if (entry.depth === "offline") {
    return t("Offline");
  }
  return t("Unsupported");
}

function recallDepthTone(entry: RecallModelProbeEntry): string {
  if (entry.skipped) return "text-amber-600";
  if (entry.depth === "tools") return "text-emerald-600";
  if (entry.depth === "offline") return "text-sky-600";
  return "text-muted-foreground";
}

export function ConfigureClaudeDesignDialog({
  canSubmit,
  draft,
  routesLabel = "Claude Design routes",
  sourceModelLabel = "Claude Design model",
  sourceModelDefaults = { model: "claude-opus-4-8", pattern: "claude-" },
  onAddRule,
  onChange,
  onChangeRule,
  onClose,
  onRemoveRule,
  onSubmit,
  providers
}: {
  canSubmit: boolean;
  draft: ClaudeDesignRoutingDraft;
  routesLabel?: string;
  sourceModelLabel?: string;
  sourceModelDefaults?: { model: string; pattern: string };
  onAddRule: () => void;
  onChange: (patch: Partial<ClaudeDesignRoutingDraft>) => void;
  onChangeRule: (index: number, patch: Partial<ClaudeDesignRoutingRuleDraft>) => void;
  onClose: () => void;
  onRemoveRule: (index: number) => void;
  onSubmit: () => void;
  providers: GatewayProviderConfig[];
}) {
  const t = useAppText();
  const modelOptions = useMemo(() => createRouteModelOptions(providers), [providers]);
  const ruleTypeOptions = translateOptions(claudeDesignRouteRuleTypeOptions, t);

  return (
    <Dialog onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[760px]">
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle>{t("Configure Routing")}</DialogTitle>
          </div>
          <Button aria-label={t("Close dialog")} onClick={onClose} size="iconSm" title={t("Close")} type="button" variant="ghost">
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>

        <DialogBody>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_1fr]">
              <Field label={t("Model routing")}>
                <Toggle checked={draft.enabled} onChange={(enabled) => onChange({ enabled })} />
              </Field>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t(routesLabel)}</div>
                <Button onClick={onAddRule} size="sm" type="button" variant="outline">
                  <Plus className="h-3.5 w-3.5" />
                  {t("Add")}
                </Button>
              </div>

              {draft.rules.length === 0 ? (
                <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-8 text-center text-[12px] text-muted-foreground">{t("No plugin routes configured")}</div>
              ) : null}

              <div className="space-y-2">
                <AnimatePresence initial={false}>
                {draft.rules.map((rule, index) => (
                  <AnimatedListItem className="rounded-md border border-border bg-card p-3" key={rule.id || index}>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field label={t("Name")}>
                        <Input value={rule.name} onChange={(event) => onChangeRule(index, { name: event.target.value })} />
                      </Field>
                      <Field label={t("Condition")}>
                        <SelectControl
                          value={rule.type}
                          onChange={(type) => onChangeRule(index, normalizeClaudeDesignRuleTypeChange(rule, type as ClaudeDesignRouteRuleType, sourceModelDefaults))}
                          options={ruleTypeOptions}
                        />
                      </Field>
                      {rule.type === "model" ? (
                        <Field label={t(sourceModelLabel)}>
                          <Input value={rule.model} onChange={(event) => onChangeRule(index, { model: event.target.value })} />
                        </Field>
                      ) : null}
                      {rule.type === "model-prefix" ? (
                        <Field label={t("Model prefix")}>
                          <Input value={rule.pattern} onChange={(event) => onChangeRule(index, { pattern: event.target.value })} />
                        </Field>
                      ) : null}
                      {isClaudeDesignStaticRuleType(rule.type) ? (
                        <div className="flex min-h-[58px] items-end rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-[12px] text-muted-foreground">{t(claudeDesignRouteRuleTypeLabel(rule.type))}</div>
                      ) : null}
                      <Field label={t("Target model")}>
                        <RouteTargetControl
                          modelOptions={modelOptions}
                          onChange={(target) => onChangeRule(index, { target })}
                          value={rule.target}
                        />
                      </Field>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-3">
                      <Label className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground">
                        <Toggle checked={rule.enabled} onChange={(enabled) => onChangeRule(index, { enabled })} />
                        <span>{t("Enabled")}</span>
                      </Label>
                      <Button aria-label={`${t("Remove")} ${rule.name || t("Plugin route")}`} onClick={() => onRemoveRule(index)} size="iconSm" title={t("Remove rule")} type="button" variant="ghost">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </AnimatedListItem>
                ))}
                </AnimatePresence>
              </div>
            </div>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button onClick={onClose} type="button" variant="outline">
            {t("Cancel")}
          </Button>
          <Button disabled={!canSubmit} onClick={onSubmit} type="button">
            <Check className="h-4 w-4" />
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
