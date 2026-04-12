import {
  createSignal,
  createEffect,
  createResource,
  Show,
} from "solid-js";
import { Dialog } from "@kobalte/core/dialog";
import {
  Sun,
  Moon,
  Monitor,
  Save,
  Trash2,
  Bug,
  RotateCcw,
  Server,
  User,
  Check,
  X,
  Loader2,
  Pencil,
} from "lucide-solid";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input, Label } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Badge } from "../components/ui/badge";
import { api, type RuntimeConfig } from "../lib/api/client";
import { getApiBaseUrl, getConfig, setConfig } from "../lib/stores/config";
import { getToken, getEmail } from "../lib/stores/auth";
import { getTheme, setTheme, getResolvedTheme, type Theme } from "../lib/stores/theme";
import { isDevMode, setDevMode, clearAllAppState } from "../lib/stores/devmode";
import { cn } from "../lib/cn";
import { t } from "../lib/i18n";

export default function SettingsPage() {
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [confirmClear, setConfirmClear] = createSignal(false);

  // Profile state
  const PROFILE_EMOJIS = ["😀", "😎", "🤓", "🦊", "🐕", "🐱", "🌸", "🌊", "🔥", "⚡", "🎯", "🚀", "💎", "🛡️", "🎨", "🌿", "🧩", "🦉", "🐧", "🤖"];
  const PROFILE_KEY = "ezfilter:profile_emoji";
  const [profileEmoji, setProfileEmojiInternal] = createSignal(
    localStorage.getItem(PROFILE_KEY) || "😀"
  );
  function setProfileEmoji(emoji: string) {
    setProfileEmojiInternal(emoji);
    localStorage.setItem(PROFILE_KEY, emoji);
  }
  const [emojiPickerOpen, setEmojiPickerOpen] = createSignal(false);
  const [localConfig, setLocalConfig] = createSignal<RuntimeConfig | null>(null);

  // Server URL editing state
  const [editingUrl, setEditingUrl] = createSignal(false);
  const [editUrl, setEditUrl] = createSignal("");
  type UrlHealth = "idle" | "checking" | "ok" | "error";
  const [urlHealth, setUrlHealth] = createSignal<UrlHealth>("idle");
  const [urlError, setUrlError] = createSignal("");

  function startEditingUrl() {
    setEditUrl(appConfig()?.serverUrl ?? "");
    setUrlHealth("idle");
    setUrlError("");
    setEditingUrl(true);
  }

  function cancelEditingUrl() {
    setEditingUrl(false);
    setUrlHealth("idle");
    setUrlError("");
  }

  // Debounced health check for edited URL
  let urlCheckTimer: ReturnType<typeof setTimeout>;
  createEffect(() => {
    const url = editUrl();
    if (!editingUrl()) return;
    clearTimeout(urlCheckTimer);
    if (!url.trim()) {
      setUrlHealth("idle");
      setUrlError("");
      return;
    }
    setUrlHealth("checking");
    urlCheckTimer = setTimeout(async () => {
      try {
        const parsed = new URL(url.trim());
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          setUrlHealth("error");
          setUrlError("URL must start with http:// or https://");
          return;
        }
      } catch {
        setUrlHealth("error");
        setUrlError("Please enter a valid URL");
        return;
      }
      try {
        const healthUrl = `${url.trim().replace(/\/+$/, "")}/api/health`;
        const res = await fetch(healthUrl);
        if (res.ok) {
          setUrlHealth("ok");
          setUrlError("");
        } else {
          setUrlHealth("error");
          setUrlError(`Server responded with ${res.status}`);
        }
      } catch {
        setUrlHealth("error");
        setUrlError("Could not reach the server");
      }
    }, 500);
  });

  function applyNewUrl() {
    if (urlHealth() !== "ok") return;
    const newUrl = editUrl().trim().replace(/\/+$/, "");
    setConfig({ serverUrl: newUrl });
    setEditingUrl(false);
    // Reload runtime config from new server
    refetch();
  }

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
    <div class="py-6 pb-24 sm:pb-6 space-y-6">
      <div>
        <h2 class="text-2xl font-extrabold font-display">{t("settings_title")}</h2>
        <p class="text-sm text-[rgb(var(--color-text-muted))] font-display">
          {t("settings_subtitle")}
        </p>
      </div>

      {/* ── Profile & Appearance (side-by-side when space allows) ── */}
      <div class="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-6">
        {/* Profile (appears first, takes majority width) */}
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <User class="h-4 w-4" />
              {t("settings_profile_title")}
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-4">
            {/* Profile icon */}
            <div class="flex items-center gap-4">
              <button
                onClick={() => setEmojiPickerOpen(!emojiPickerOpen())}
                class="flex h-14 w-14 items-center justify-center rounded-2xl bg-[rgb(var(--color-primary))]/10 text-3xl hover:scale-105 transition-transform cursor-pointer"
              >
                {profileEmoji()}
              </button>
              <div>
                <p class="text-sm font-display font-semibold">{t("settings_profile_icon")}</p>
                <p class="text-xs text-[rgb(var(--color-text-muted))]">{t("settings_profile_icon_desc")}</p>
              </div>
            </div>
            <Show when={emojiPickerOpen()}>
              <div class="flex flex-wrap gap-1.5 p-2 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]">
                {PROFILE_EMOJIS.map((emoji) => (
                  <button
                    onClick={() => {
                      setProfileEmoji(emoji);
                      setEmojiPickerOpen(false);
                    }}
                    class={cn(
                      "flex h-9 w-9 items-center justify-center rounded-lg text-xl hover:bg-[rgb(var(--color-surface-hover))] transition-colors",
                      profileEmoji() === emoji && "bg-[rgb(var(--color-primary))]/15 ring-2 ring-[rgb(var(--color-primary))]"
                    )}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </Show>

            {/* Email (read-only from auth) */}
            <div class="space-y-2">
              <Label>{t("settings_profile_email")}</Label>
              <Input
                type="email"
                value={getEmail() ?? ""}
                disabled
                class="opacity-70"
              />
            </div>

            {/* Password change (stub) */}
            <div class="space-y-2">
              <Label>{t("settings_profile_new_password")}</Label>
              <Input
                type="password"
                placeholder="••••••••"
              />
            </div>
          </CardContent>
        </Card>

        {/* Appearance */}
        <Card class="h-fit lg:min-w-[200px]">
          <CardHeader>
            <CardTitle>{t("settings_appearance")}</CardTitle>
          </CardHeader>
          <CardContent class="space-y-4">
            <div class="space-y-2">
              <Label>{t("settings_theme")}</Label>
              <div class="flex items-center gap-1 rounded-full bg-[rgb(var(--color-surface))] p-1 border border-[rgb(var(--color-border))] shadow-sm w-fit">
                {themes.map((th) => {
                  const Icon = th.icon;
                  return (
                    <button
                      onClick={() => setTheme(th.value)}
                      class={cn(
                        "flex items-center justify-center rounded-full p-2 transition-all duration-200",
                        getTheme() === th.value
                          ? "bg-[rgb(var(--color-primary))] text-white shadow-sm"
                          : "text-[rgb(var(--color-text-muted))] hover:text-[rgb(var(--color-text))]"
                      )}
                      title={th.value}
                    >
                      <Icon class="h-4 w-4" />
                    </button>
                  );
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Proxy Configuration (includes connection info) ── */}
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Server class="h-4 w-4" />
            {t("settings_proxy_title")}
          </CardTitle>
          <CardDescription>
            {t("settings_proxy_desc")}
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-5">
          {/* Connection info */}
          <div class="flex items-center justify-between">
            <span class="text-sm font-display">{t("settings_mode")}</span>
            <Badge variant="secondary">{appConfig()?.hostingMode ?? "unknown"}</Badge>
          </div>
          <Show
            when={editingUrl()}
            fallback={
              <div class="flex items-center justify-between">
                <span class="text-sm font-display">{t("settings_server_url")}</span>
                <div class="flex items-center gap-2">
                  <span class="text-xs text-[rgb(var(--color-text-muted))] font-mono truncate max-w-[200px]">
                    {getApiBaseUrl() || t("settings_not_configured")}
                  </span>
                  <button
                    onClick={startEditingUrl}
                    class="flex h-6 w-6 items-center justify-center rounded-lg text-[rgb(var(--color-text-muted))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-hover))] transition-colors"
                    title={t("settings_change_url")}
                  >
                    <Pencil class="h-3 w-3" />
                  </button>
                </div>
              </div>
            }
          >
            <div class="space-y-2">
              <Label>{t("settings_server_url")}</Label>
              <div class="relative">
                <Input
                  type="url"
                  placeholder="https://my-proxy.example.com"
                  value={editUrl()}
                  onInput={(e) => setEditUrl(e.currentTarget.value)}
                  class="pr-10 font-mono text-xs"
                />
                <div class="absolute right-3 top-1/2 -translate-y-1/2">
                  <Show when={urlHealth() === "checking"}>
                    <Loader2 class="h-4 w-4 animate-spin text-[rgb(var(--color-text-muted))]" />
                  </Show>
                  <Show when={urlHealth() === "ok"}>
                    <Check class="h-4 w-4 text-green-500" />
                  </Show>
                  <Show when={urlHealth() === "error"}>
                    <X class="h-4 w-4 text-red-500" />
                  </Show>
                </div>
              </div>
              <Show when={urlError()}>
                <p class="text-xs text-red-500">{urlError()}</p>
              </Show>
              <div class="flex items-center gap-2 pt-1">
                <Button
                  size="sm"
                  onClick={applyNewUrl}
                  disabled={urlHealth() !== "ok"}
                >
                  <Check class="h-3.5 w-3.5" />
                  {t("settings_apply")}
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelEditingUrl}>
                  {t("plugins_cancel")}
                </Button>
              </div>
            </div>
          </Show>
          <div class="h-px bg-[rgb(var(--color-border))]" />
          <Show
            when={localConfig()}
            fallback={
              <p class="text-sm text-[rgb(var(--color-text-muted))]">
                {remoteConfig.loading
                  ? t("settings_proxy_loading")
                  : t("settings_proxy_unavailable")}
              </p>
            }
          >
            {(cfg) => (
              <>
                <div class="flex items-center justify-between">
                  <div>
                    <p class="text-sm font-display font-semibold">{t("settings_plugins_label")}</p>
                    <p class="text-xs text-[rgb(var(--color-text-muted))]">
                      {t("settings_plugins_desc")}
                    </p>
                  </div>
                  <Switch
                    checked={cfg().plugins_enabled}
                    onChange={(v) => updateField("plugins_enabled", v)}
                  />
                </div>

                <div class="space-y-2">
                  <Label>{t("settings_timeout")}</Label>
                  <Input
                    type="number"
                    value={cfg().plugins_timeout_ms}
                    onInput={(e) =>
                      updateField("plugins_timeout_ms", parseInt(e.currentTarget.value) || 0)
                    }
                  />
                </div>

                <div class="space-y-2">
                  <Label>{t("settings_memory")}</Label>
                  <Input
                    type="number"
                    value={cfg().plugins_max_memory_mb}
                    onInput={(e) =>
                      updateField("plugins_max_memory_mb", parseInt(e.currentTarget.value) || 0)
                    }
                  />
                </div>

                <div class="space-y-2">
                  <Label>{t("settings_fuel")}</Label>
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
                    <p class="text-sm font-display font-semibold">{t("settings_autoupdate")}</p>
                    <p class="text-xs text-[rgb(var(--color-text-muted))]">
                      {t("settings_autoupdate_desc")}
                    </p>
                  </div>
                  <Switch
                    checked={cfg().auto_update}
                    onChange={(v) => updateField("auto_update", v)}
                  />
                </div>

                <div class="flex items-center justify-between">
                  <div>
                    <p class="text-sm font-display font-semibold">{t("settings_transparent")}</p>
                    <p class="text-xs text-[rgb(var(--color-text-muted))]">
                      {t("settings_transparent_desc")}
                    </p>
                  </div>
                  <Switch
                    checked={cfg().transparent_enabled}
                    onChange={(v) => updateField("transparent_enabled", v)}
                  />
                </div>

                <div class="flex items-center gap-3 pt-4 mt-2 border-t border-[rgb(var(--color-border))]">
                  <Button onClick={handleSave} disabled={saving()}>
                    <Save class="h-4 w-4" />
                    <Show when={saving()} fallback={t("common_save")}>
                      {t("common_saving")}
                    </Show>
                  </Button>
                  <Show when={saved()}>
                    <span class="text-sm text-[rgb(var(--color-success))] font-display font-semibold animate-fade-in">
                      {t("common_saved")}
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
            {t("settings_dev_title")}
          </CardTitle>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-display font-semibold">{t("settings_dev_mode")}</p>
              <p class="text-xs text-[rgb(var(--color-text-muted))]">
                {t("settings_dev_mode_desc")}
              </p>
            </div>
            <Switch checked={isDevMode()} onChange={setDevMode} />
          </div>

          <Show when={isDevMode()}>
            <div class="space-y-3 pt-3 border-t border-[rgb(var(--color-border))]">
              <p class="text-xs text-[rgb(var(--color-text-muted))] uppercase font-bold tracking-wider">
                {t("settings_dev_actions")}
              </p>
              <div class="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setConfirmClear(true);
                  }}
                >
                  <Trash2 class="h-3.5 w-3.5" />
                  {t("settings_dev_clear")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => window.location.reload()}
                >
                  <RotateCcw class="h-3.5 w-3.5" />
                  {t("settings_dev_reload")}
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

      {/* Clear storage confirmation dialog */}
      <Dialog open={confirmClear()} onOpenChange={setConfirmClear}>
        <Dialog.Portal>
          <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50 animate-fade-in" />
          <Dialog.Content class="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-6 shadow-xl animate-fade-in">
            <Dialog.Title class="text-lg font-bold font-display mb-2">
              {t("settings_dev_clear")}
            </Dialog.Title>
            <Dialog.Description class="text-sm text-[rgb(var(--color-text-muted))] mb-6">
              {t("settings_dev_clear_confirm")}
            </Dialog.Description>
            <div class="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setConfirmClear(false)}>
                {t("plugins_cancel")}
              </Button>
              <Button
                size="sm"
                class="bg-red-500 hover:bg-red-600 text-white"
                onClick={() => {
                  setConfirmClear(false);
                  clearAllAppState();
                }}
              >
                <Trash2 class="h-3.5 w-3.5" />
                {t("settings_dev_clear")}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </div>
  );
}
