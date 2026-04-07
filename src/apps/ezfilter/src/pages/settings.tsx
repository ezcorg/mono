import {
  createSignal,
  createResource,
  Show,
  onMount,
} from "solid-js";
import {
  Sun,
  Moon,
  Monitor,
  Save,
  Trash2,
  Bug,
  RotateCcw,
  Server,
  Shield,
  Zap,
} from "lucide-solid";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input, Label } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Badge } from "../components/ui/badge";
import { api, type RuntimeConfig } from "../lib/api/client";
import { getApiBaseUrl, getConfig } from "../lib/stores/config";
import { getToken } from "../lib/stores/auth";
import { getTheme, setTheme, getResolvedTheme, type Theme } from "../lib/stores/theme";
import { isDevMode, setDevMode, clearAllAppState } from "../lib/stores/devmode";
import { cn } from "../lib/cn";

export default function SettingsPage() {
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [localConfig, setLocalConfig] = createSignal<RuntimeConfig | null>(null);

  const [remoteConfig, { refetch }] = createResource(async () => {
    const token = getToken();
    if (!token) return null;
    try {
      return await api.getConfig(getApiBaseUrl(), token);
    } catch {
      return null;
    }
  });

  // Sync remote config into local editable state
  createResource(
    () => remoteConfig(),
    (data) => {
      if (data) setLocalConfig({ ...data });
      return data;
    }
  );

  function updateField<K extends keyof RuntimeConfig>(key: K, value: RuntimeConfig[K]) {
    setLocalConfig((prev) => (prev ? { ...prev, [key]: value } : null));
  }

  async function handleSave() {
    const cfg = localConfig();
    const token = getToken();
    if (!cfg || !token) return;
    setSaving(true);
    setSaved(false);
    try {
      const updated = await api.updateConfig(getApiBaseUrl(), token, cfg);
      setLocalConfig({ ...updated });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error("Failed to save config:", e);
    } finally {
      setSaving(false);
    }
  }

  const themes: { value: Theme; icon: typeof Sun }[] = [
    { value: "light", icon: Sun },
    { value: "dark", icon: Moon },
    { value: "auto", icon: Monitor },
  ];

  const appConfig = () => getConfig();

  return (
    <div class="px-4 sm:px-6 py-6 pb-24 sm:pb-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h2 class="text-2xl font-extrabold font-display">Settings</h2>
        <p class="text-sm text-[rgb(var(--color-text-muted))] font-display">
          Manage your app and proxy preferences
        </p>
      </div>

      {/* ── Appearance ── */}
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="space-y-2">
            <Label>Theme</Label>
            <div class="flex items-center gap-1 rounded-full bg-[rgb(var(--color-surface))] p-1 border border-[rgb(var(--color-border))] shadow-sm w-fit">
              {themes.map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    onClick={() => setTheme(t.value)}
                    class={cn(
                      "flex items-center justify-center rounded-full p-2 transition-all duration-200",
                      getTheme() === t.value
                        ? "bg-[rgb(var(--color-primary))] text-white shadow-sm"
                        : "text-[rgb(var(--color-text-muted))] hover:text-[rgb(var(--color-text))]"
                    )}
                    title={t.value}
                  >
                    <Icon class="h-4 w-4" />
                  </button>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Connection ── */}
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Server class="h-4 w-4" />
            Connection
          </CardTitle>
        </CardHeader>
        <CardContent class="space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-sm font-display">Mode</span>
            <Badge variant="secondary">{appConfig()?.hostingMode ?? "unknown"}</Badge>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-sm font-display">Server URL</span>
            <span class="text-xs text-[rgb(var(--color-text-muted))] font-mono truncate max-w-[200px]">
              {getApiBaseUrl() || "not configured"}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ── Proxy Configuration ── */}
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Shield class="h-4 w-4" />
            Proxy Configuration
          </CardTitle>
          <CardDescription>
            Runtime settings for the witmproxy server
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-5">
          <Show
            when={localConfig()}
            fallback={
              <p class="text-sm text-[rgb(var(--color-text-muted))]">
                {remoteConfig.loading
                  ? "Loading configuration..."
                  : "Could not load server configuration. Make sure you're connected."}
              </p>
            }
          >
            {(cfg) => (
              <>
                <div class="flex items-center justify-between">
                  <div>
                    <p class="text-sm font-display font-semibold">Plugins</p>
                    <p class="text-xs text-[rgb(var(--color-text-muted))]">
                      Enable or disable the plugin system
                    </p>
                  </div>
                  <Switch
                    checked={cfg().plugins_enabled}
                    onChange={(v) => updateField("plugins_enabled", v)}
                  />
                </div>

                <div class="space-y-2">
                  <Label>Plugin timeout (ms)</Label>
                  <Input
                    type="number"
                    value={cfg().plugins_timeout_ms}
                    onInput={(e) =>
                      updateField("plugins_timeout_ms", parseInt(e.currentTarget.value) || 0)
                    }
                  />
                </div>

                <div class="space-y-2">
                  <Label>Max plugin memory (MB)</Label>
                  <Input
                    type="number"
                    value={cfg().plugins_max_memory_mb}
                    onInput={(e) =>
                      updateField("plugins_max_memory_mb", parseInt(e.currentTarget.value) || 0)
                    }
                  />
                </div>

                <div class="space-y-2">
                  <Label>WASM fuel limit</Label>
                  <Input
                    type="number"
                    value={cfg().plugins_max_fuel}
                    onInput={(e) =>
                      updateField("plugins_max_fuel", parseInt(e.currentTarget.value) || 0)
                    }
                  />
                </div>

                <div class="flex items-center justify-between">
                  <div>
                    <p class="text-sm font-display font-semibold">Auto-update</p>
                    <p class="text-xs text-[rgb(var(--color-text-muted))]">
                      Automatically update the proxy in daemon mode
                    </p>
                  </div>
                  <Switch
                    checked={cfg().auto_update}
                    onChange={(v) => updateField("auto_update", v)}
                  />
                </div>

                <div class="flex items-center justify-between">
                  <div>
                    <p class="text-sm font-display font-semibold">Transparent proxy</p>
                    <p class="text-xs text-[rgb(var(--color-text-muted))]">
                      Intercept traffic via iptables/nftables
                    </p>
                  </div>
                  <Switch
                    checked={cfg().transparent_enabled}
                    onChange={(v) => updateField("transparent_enabled", v)}
                  />
                </div>

                <div class="flex items-center gap-3 pt-2 border-t border-[rgb(var(--color-border))]">
                  <Button onClick={handleSave} disabled={saving()}>
                    <Save class="h-4 w-4" />
                    <Show when={saving()} fallback="Save">
                      Saving...
                    </Show>
                  </Button>
                  <Show when={saved()}>
                    <span class="text-sm text-[rgb(var(--color-success))] font-display font-semibold animate-fade-in">
                      Saved!
                    </span>
                  </Show>
                </div>
              </>
            )}
          </Show>
        </CardContent>
      </Card>

      {/* ── Developer Mode ── */}
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Bug class="h-4 w-4" />
            Developer
          </CardTitle>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-display font-semibold">Developer mode</p>
              <p class="text-xs text-[rgb(var(--color-text-muted))]">
                Show developer tools and debug information
              </p>
            </div>
            <Switch checked={isDevMode()} onChange={setDevMode} />
          </div>

          <Show when={isDevMode()}>
            <div class="space-y-3 pt-3 border-t border-[rgb(var(--color-border))]">
              <p class="text-xs text-[rgb(var(--color-text-muted))] uppercase font-bold tracking-wider">
                Debug actions
              </p>
              <div class="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    if (confirm("Clear all app storage and reload? You'll need to go through setup again.")) {
                      clearAllAppState();
                    }
                  }}
                >
                  <Trash2 class="h-3.5 w-3.5" />
                  Clear storage & reset
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => window.location.reload()}
                >
                  <RotateCcw class="h-3.5 w-3.5" />
                  Force reload
                </Button>
              </div>
              <div class="text-xs text-[rgb(var(--color-text-muted))] space-y-1 font-mono">
                <p>Server: {getApiBaseUrl() || "none"}</p>
                <p>Token: {getToken() ? `${getToken()!.slice(0, 20)}...` : "none"}</p>
                <p>Theme: {getTheme()} (resolved: {getResolvedTheme()})</p>
                <p>Setup complete: {String(getConfig()?.setupComplete)}</p>
              </div>
            </div>
          </Show>
        </CardContent>
      </Card>
    </div>
  );
}
