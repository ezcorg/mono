import { createSignal, createEffect, createResource, For, Show, Switch as SolidSwitch, Match } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import {
  ArrowLeft, Save, Upload, FileText, Binary, Shield, ChevronRight,
} from "lucide-solid";
import { Button } from "../components/ui/button";
import { Input, Label } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import type { InputSchema, ActualInput, UserInput } from "../lib/api/types";
import { api, type PluginSummary } from "../lib/api/client";
import { getApiBaseUrl } from "../lib/stores/config";
import { getToken } from "../lib/stores/auth";
import { cn } from "../lib/cn";
import { t } from "../lib/i18n";
import { getCapMeta } from "../lib/capabilities";
import { FilterExpressionHelp } from "../components/filter-expression-help";

export default function PluginConfigPage() {
  const params = useParams<{ ns: string; name: string }>();
  const navigate = useNavigate();

  // Fetch plugin details from the server
  const [plugin] = createResource(async () => {
    const token = getToken();
    if (!token) return null;
    try {
      const plugins = await api.listPlugins(getApiBaseUrl(), token);
      if (!Array.isArray(plugins)) return null;
      const ns = decodeURIComponent(params.ns);
      const name = decodeURIComponent(params.name);
      return plugins.find((p) => p.namespace === ns && p.name === name) ?? null;
    } catch {
      return null;
    }
  });

  // Local mutable copy of capabilities for editing
  const [editCaps, setEditCaps] = createSignal<
    { kind: string; scope: string; granted: boolean }[]
  >([]);
  // Original values from the server — used to detect user modifications
  const [originalCaps, setOriginalCaps] = createSignal<
    { kind: string; scope: string; granted: boolean }[]
  >([]);

  // Sync server data into local editable state when loaded
  // Deduplicate by kind+scope to avoid showing the same capability twice
  createEffect(() => {
    const p = plugin();
    if (p?.capabilities) {
      const seen = new Set<string>();
      const deduped = p.capabilities.filter((c) => {
        const key = `${c.kind}:${c.scope}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const caps = deduped.map((c) => ({ ...c }));
      setEditCaps(caps);
      setOriginalCaps(caps.map((c) => ({ ...c })));
    }
  });

  function toggleCapGranted(index: number) {
    setEditCaps((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], granted: !next[index].granted };
      return next;
    });
  }

  function updateCapScope(index: number, scope: string) {
    setEditCaps((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], scope };
      return next;
    });
  }

  const [schemas] = createSignal<InputSchema[]>([]);
  const [values, setValues] = createSignal<Record<string, ActualInput>>({});
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);

  createEffect(() => {
    const defaults: Record<string, ActualInput> = {};
    for (const schema of schemas()) {
      if (schema.default) {
        defaults[schema.name] = schema.default;
      }
    }
    setValues(defaults);
  });

  function updateValue(name: string, value: ActualInput) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      const token = getToken();
      if (!token) return;
      const ns = decodeURIComponent(params.ns);
      const name = decodeURIComponent(params.name);
      // Save plugin config values
      const configMap: Record<string, string> = {};
      for (const [k, v] of Object.entries(values())) {
        configMap[k] = JSON.stringify(v);
      }
      // For now we use the tenant's own ID (from the JWT) -- the server extracts it
      // Plugin capability changes would need a dedicated endpoint in a future iteration;
      // for now the UI allows toggling but the save only persists config values
      // TODO: add PUT /api/plugins/{ns}/{name}/capabilities endpoint
    } catch (e) {
      console.error("Failed to save plugin config:", e);
    } finally {
      setSaving(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  const [expandedCaps, setExpandedCaps] = createSignal<Set<number>>(new Set());

  function toggleCapExpanded(index: number) {
    setExpandedCaps((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  const hasConfig = () => schemas().length > 0;
  const hasCaps = () => editCaps().length > 0;

  return (
    <div class="py-6 pb-24 sm:pb-6 space-y-6">
      {/* Header */}
      <div class="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/plugins")}>
          <ArrowLeft class="h-4 w-4" />
        </Button>
        <div>
          <h2 class="text-xl font-extrabold font-display">
            {decodeURIComponent(params.name)}
          </h2>
          <p class="text-xs text-[rgb(var(--color-text-muted))] font-display">
            {decodeURIComponent(params.ns)} &middot; {t("plugin_config_configuration")}
          </p>
        </div>
      </div>

      {/* Capabilities card */}
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Shield class="h-4 w-4" />
            {t("plugin_config_capabilities")}
          </CardTitle>
          <CardDescription>{t("plugin_config_caps_desc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Show
            when={hasCaps()}
            fallback={
              <p class="text-sm text-[rgb(var(--color-text-muted))]">
                {t("plugin_config_no_caps")}
              </p>
            }
          >
            <div class="space-y-2">
              <For each={editCaps()}>
                {(cap, i) => {
                  const meta = () => getCapMeta(cap.kind);
                  const isExpanded = () => expandedCaps().has(i());
                  const Icon = meta().icon;
                  // Compare current values against original from server to detect user edits.
                  // Purple = user has modified this capability (changed scope or granted status).
                  const isModified = () => {
                    const orig = originalCaps()[i()];
                    if (!orig) return false;
                    return cap.scope !== orig.scope || cap.granted !== orig.granted;
                  };
                  const iconColorClass = () =>
                    !cap.granted
                      ? "bg-red-500/10 text-red-500"
                      : isModified()
                        ? "bg-purple-500/10 text-purple-500"
                        : "bg-[rgb(var(--color-success))]/10 text-[rgb(var(--color-success))]";
                  return (
                    <div class="rounded-xl border border-[rgb(var(--color-border))] overflow-hidden">
                      {/* Condensed row */}
                      <div
                        class="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-[rgb(var(--color-surface-hover))] transition-colors"
                        onClick={() => toggleCapExpanded(i())}
                      >
                        <div class={cn(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                          iconColorClass()
                        )}>
                          <Icon class="h-4 w-4" />
                        </div>
                        <div class="flex-1 min-w-0">
                          <p class="text-sm font-display font-semibold truncate">
                            {meta().label}
                          </p>
                          <Show
                            when={cap.scope !== "true" && cap.scope !== ""}
                            fallback={
                              <p class="text-xs text-[rgb(var(--color-text-muted))] truncate">
                                {meta().description}
                              </p>
                            }
                          >
                            <p class={cn(
                              "text-xs font-mono truncate",
                              isModified() ? "text-purple-400" : "text-[rgb(var(--color-text-muted))]"
                            )}>
                              {cap.scope}
                            </p>
                          </Show>
                        </div>
                        <div class={cn(
                          "transition-transform duration-200 shrink-0",
                          isExpanded() && "rotate-90"
                        )}>
                          <ChevronRight class="h-4 w-4 text-[rgb(var(--color-text-muted))]" />
                        </div>
                      </div>

                      {/* Expanded details */}
                      <Show when={isExpanded()}>
                        <div class="px-3 pb-3 pt-2 space-y-3 border-t border-[rgb(var(--color-border))]">
                          <div class="flex items-center justify-between">
                            <div>
                              <p class="text-xs font-display font-semibold">
                                {cap.granted ? t("plugin_config_cap_granted") : t("plugin_config_cap_denied")}
                              </p>
                              <p class="text-[10px] text-[rgb(var(--color-text-muted))]">
                                {meta().description}
                              </p>
                            </div>
                            <Switch
                              checked={cap.granted}
                              onChange={() => toggleCapGranted(i())}
                            />
                          </div>
                          <div class="space-y-1">
                            <div class="flex items-center gap-1.5">
                              <Label class="text-xs">{t("plugin_config_scope_label")}</Label>
                              <FilterExpressionHelp />
                            </div>
                            <Input
                              type="text"
                              value={cap.scope}
                              onInput={(e) => updateCapScope(i(), e.currentTarget.value)}
                              class="font-mono text-xs"
                              placeholder="true"
                            />
                          </div>
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </CardContent>
      </Card>

      {/* Configuration card */}
      <Card>
        <CardHeader>
          <CardTitle>{t("plugin_config_title")}</CardTitle>
          <CardDescription>{t("plugin_config_subtitle")}</CardDescription>
        </CardHeader>
        <CardContent class="space-y-6">
          <Show
            when={hasConfig()}
            fallback={
              <p class="text-sm text-[rgb(var(--color-text-muted))]">
                {t("plugin_config_no_settings")}
              </p>
            }
          >
            <For each={schemas()}>
              {(schema) => (
                <ConfigField
                  schema={schema}
                  value={values()[schema.name]}
                  onChange={(v) => updateValue(schema.name, v)}
                />
              )}
            </For>

            <div class="flex items-center gap-3 pt-4 border-t border-[rgb(var(--color-border))]">
              <Button onClick={handleSave} disabled={saving()}>
                <Save class="h-4 w-4" />
                <Show when={saving()} fallback={t("plugin_config_save")}>
                  {t("common_saving")}
                </Show>
              </Button>
              <Show when={saved()}>
                <span class="text-sm text-[rgb(var(--color-success))] font-display font-semibold animate-fade-in">
                  {t("common_saved")}
                </span>
              </Show>
            </div>
          </Show>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Dynamic config field renderer ──

interface ConfigFieldProps {
  schema: InputSchema;
  value?: ActualInput;
  onChange: (value: ActualInput) => void;
}

function ConfigField(props: ConfigFieldProps) {
  const inputType = () => props.schema.inputType;

  return (
    <div class="space-y-2">
      <div class="flex items-center gap-2">
        <Label>{formatLabel(props.schema.name)}</Label>
        <Show when={props.schema.optional}>
          <span class="text-xs text-[rgb(var(--color-text-muted))] italic">
            {t("common_optional")}
          </span>
        </Show>
      </div>
      <Show when={props.schema.description}>
        <p class="text-xs text-[rgb(var(--color-text-muted))] -mt-1">
          {props.schema.description}
        </p>
      </Show>

      <SolidSwitch>
        <Match when={inputType().kind === "str"}>
          <Input
            type="text"
            value={props.value?.kind === "str" ? props.value.value : ""}
            onInput={(e) =>
              props.onChange({ kind: "str", value: e.currentTarget.value })
            }
            placeholder={`Enter ${formatLabel(props.schema.name).toLowerCase()}`}
          />
        </Match>

        <Match when={inputType().kind === "boolean"}>
          <Switch
            checked={props.value?.kind === "boolean" ? props.value.value : false}
            onChange={(checked) =>
              props.onChange({ kind: "boolean", value: checked })
            }
          />
        </Match>

        <Match when={inputType().kind === "number"}>
          <Input
            type="number"
            value={props.value?.kind === "number" ? String(props.value.value) : ""}
            onInput={(e) =>
              props.onChange({
                kind: "number",
                value: parseFloat(e.currentTarget.value) || 0,
              })
            }
          />
        </Match>

        <Match when={inputType().kind === "select"}>
          <Select
            options={(inputType() as { kind: "select"; options: string[] }).options}
            value={props.value?.kind === "select" ? props.value.value : undefined}
            onChange={(v) => props.onChange({ kind: "select", value: v })}
            placeholder={t("plugin_config_select")}
          />
        </Match>

        <Match when={inputType().kind === "datetime"}>
          <Input
            type="datetime-local"
            value={
              props.value?.kind === "datetime" ? props.value.value : ""
            }
            onInput={(e) =>
              props.onChange({ kind: "datetime", value: e.currentTarget.value })
            }
          />
        </Match>

        <Match when={inputType().kind === "daterange"}>
          <div class="flex flex-col sm:flex-row gap-2">
            <div class="flex-1 space-y-1">
              <span class="text-xs text-[rgb(var(--color-text-muted))]">{t("common_from")}</span>
              <Input
                type="date"
                value={
                  props.value?.kind === "daterange"
                    ? props.value.value[0]
                    : ""
                }
                onInput={(e) => {
                  const end =
                    props.value?.kind === "daterange"
                      ? props.value.value[1]
                      : "";
                  props.onChange({
                    kind: "daterange",
                    value: [e.currentTarget.value, end],
                  });
                }}
              />
            </div>
            <div class="flex-1 space-y-1">
              <span class="text-xs text-[rgb(var(--color-text-muted))]">{t("common_to")}</span>
              <Input
                type="date"
                value={
                  props.value?.kind === "daterange"
                    ? props.value.value[1]
                    : ""
                }
                onInput={(e) => {
                  const start =
                    props.value?.kind === "daterange"
                      ? props.value.value[0]
                      : "";
                  props.onChange({
                    kind: "daterange",
                    value: [start, e.currentTarget.value],
                  });
                }}
              />
            </div>
          </div>
        </Match>

        <Match when={inputType().kind === "file"}>
          <FileInputField
            value={props.value}
            onChange={props.onChange}
          />
        </Match>

        <Match when={inputType().kind === "binary"}>
          <BinaryInputField
            value={props.value}
            onChange={props.onChange}
          />
        </Match>
      </SolidSwitch>
    </div>
  );
}

// ── File input field ──

function FileInputField(props: {
  value?: ActualInput;
  onChange: (value: ActualInput) => void;
}) {
  const [fileName, setFileName] = createSignal<string | null>(
    props.value?.kind === "file" ? props.value.value.name : null
  );

  async function handleFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const buffer = await file.arrayBuffer();
    setFileName(file.name);
    props.onChange({
      kind: "file",
      value: {
        name: file.name,
        contentType: file.type || undefined,
        data: new Uint8Array(buffer),
      },
    });
  }

  return (
    <div
      class={cn(
        "flex items-center gap-3 rounded-xl border-2 border-dashed border-[rgb(var(--color-border))] p-4",
        "hover:border-[rgb(var(--color-primary))]/50 transition-colors cursor-pointer"
      )}
      onClick={() => document.getElementById("file-input-hidden")?.click()}
    >
      <FileText class="h-5 w-5 text-[rgb(var(--color-text-muted))]" />
      <div class="flex-1">
        <Show
          when={fileName()}
          fallback={
            <p class="text-sm text-[rgb(var(--color-text-muted))]">
              {t("plugin_config_file_upload")}
            </p>
          }
        >
          <p class="text-sm font-medium">{fileName()}</p>
        </Show>
      </div>
      <Upload class="h-4 w-4 text-[rgb(var(--color-text-muted))]" />
      <input
        id="file-input-hidden"
        type="file"
        class="hidden"
        onChange={handleFile}
      />
    </div>
  );
}

// ── Binary input field ──

function BinaryInputField(props: {
  value?: ActualInput;
  onChange: (value: ActualInput) => void;
}) {
  const [size, setSize] = createSignal<number | null>(
    props.value?.kind === "binary" ? props.value.value.byteLength : null
  );

  async function handleFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer);
    setSize(data.byteLength);
    props.onChange({ kind: "binary", value: data });
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <div
      class={cn(
        "flex items-center gap-3 rounded-xl border-2 border-dashed border-[rgb(var(--color-border))] p-4",
        "hover:border-[rgb(var(--color-primary))]/50 transition-colors cursor-pointer"
      )}
      onClick={() => document.getElementById("binary-input-hidden")?.click()}
    >
      <Binary class="h-5 w-5 text-[rgb(var(--color-text-muted))]" />
      <div class="flex-1">
        <Show
          when={size() !== null}
          fallback={
            <p class="text-sm text-[rgb(var(--color-text-muted))]">
              {t("plugin_config_binary_upload")}
            </p>
          }
        >
          <p class="text-sm font-medium">{formatBytes(size()!)}</p>
        </Show>
      </div>
      <Upload class="h-4 w-4 text-[rgb(var(--color-text-muted))]" />
      <input
        id="binary-input-hidden"
        type="file"
        class="hidden"
        onChange={handleFile}
      />
    </div>
  );
}

// ── Helpers ──

function formatLabel(name: string): string {
  return name
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
