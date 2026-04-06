import { createSignal, createEffect, For, Show, Switch as SolidSwitch, Match } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { ArrowLeft, Save, Upload, FileText, Binary } from "lucide-solid";
import { Button } from "../components/ui/button";
import { Input, Label } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import type { InputSchema, ActualInput, UserInput } from "../lib/api/types";
import { cn } from "../lib/cn";

// Demo input schemas to showcase the UI when real data isn't available
const DEMO_SCHEMAS: InputSchema[] = [
  {
    name: "enabled_platforms",
    inputType: { kind: "select", options: ["all", "youtube", "tiktok", "instagram", "facebook"] },
    optional: false,
    default: { kind: "select", value: "all" },
    description: "Which platforms to apply this plugin to",
  },
  {
    name: "aggressiveness",
    inputType: { kind: "number" },
    optional: false,
    default: { kind: "number", value: 5 },
    description: "How aggressively to filter (1-10)",
  },
  {
    name: "custom_keywords",
    inputType: { kind: "str" },
    optional: true,
    description: "Comma-separated keywords to additionally filter",
  },
  {
    name: "strict_mode",
    inputType: { kind: "boolean" },
    optional: false,
    default: { kind: "boolean", value: false },
    description: "Enable strict filtering mode (may cause false positives)",
  },
  {
    name: "schedule_start",
    inputType: { kind: "datetime" },
    optional: true,
    description: "When to start applying this filter",
  },
  {
    name: "active_period",
    inputType: { kind: "daterange" },
    optional: true,
    description: "Date range during which the plugin is active",
  },
  {
    name: "blocklist",
    inputType: { kind: "file" },
    optional: true,
    description: "Upload a custom blocklist file (one entry per line)",
  },
  {
    name: "model_weights",
    inputType: { kind: "binary" },
    optional: true,
    description: "Custom ML model weights for content classification",
  },
];

export default function PluginConfigPage() {
  const params = useParams<{ ns: string; name: string }>();
  const navigate = useNavigate();

  const [schemas] = createSignal<InputSchema[]>(DEMO_SCHEMAS);
  const [values, setValues] = createSignal<Record<string, ActualInput>>({});
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);

  // Initialize defaults
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
    // Build the user-input list
    const inputs: UserInput[] = Object.entries(values()).map(
      ([name, value]) => ({ name, value })
    );
    // In a real app, this would call:
    // client.setPluginConfig(tenantId, params.ns, params.name, inputs)
    await new Promise((r) => setTimeout(r, 500)); // Simulate save
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div class="px-4 sm:px-6 py-6 pb-24 sm:pb-6 max-w-2xl mx-auto">
      {/* Header */}
      <div class="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate("/plugins")}>
          <ArrowLeft class="h-4 w-4" />
        </Button>
        <div>
          <h2 class="text-xl font-extrabold font-display">
            {decodeURIComponent(params.name)}
          </h2>
          <p class="text-xs text-[rgb(var(--color-text-muted))] font-display">
            {decodeURIComponent(params.ns)} &middot; Configuration
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Plugin Settings</CardTitle>
          <CardDescription>
            Configure how this plugin behaves
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-6">
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
              <Show when={saving()} fallback="Save Configuration">
                Saving...
              </Show>
            </Button>
            <Show when={saved()}>
              <span class="text-sm text-[rgb(var(--color-success))] font-display font-semibold animate-fade-in">
                Saved!
              </span>
            </Show>
          </div>
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
            optional
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
            placeholder="Select an option"
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
              <span class="text-xs text-[rgb(var(--color-text-muted))]">From</span>
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
              <span class="text-xs text-[rgb(var(--color-text-muted))]">To</span>
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
              Click to upload a file
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
              Click to upload binary data
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
