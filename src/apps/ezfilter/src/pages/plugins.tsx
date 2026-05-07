import { createSignal, createResource, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { Dialog } from "@kobalte/core/dialog";
import {
  AlertTriangle,
  Puzzle,
  Settings,
  FileDown,
  RefreshCw,
  Search,
  ChevronDown,
  ExternalLink,
  Trash2,
  ShieldCheck,
  X,
  Power,
  PowerOff,
} from "lucide-solid";
import { Card, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { api } from "../lib/api/client";
import { getApiBaseUrl } from "../lib/stores/config";
import { getToken } from "../lib/stores/auth";
import { cn } from "../lib/cn";
import { t } from "../lib/i18n";
import { getCapMeta } from "../lib/capabilities";
import { FilterExpressionHelp } from "../components/filter-expression-help";

const PLUGIN_EMOJIS = ["🛡️", "🔍", "🌿", "⚡", "🎯", "🧩", "🔮", "🌊", "🔥", "🦊", "🐕", "🌸", "🎨", "🚀", "💎"];

function pluginEmoji(name: string = ""): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return PLUGIN_EMOJIS[Math.abs(hash) % PLUGIN_EMOJIS.length];
}

export default function PluginsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = createSignal("");
  const [refreshKey, setRefreshKey] = createSignal(0);
  const [lastSearched, setLastSearched] = createSignal("");
  const [importing, setImporting] = createSignal(false);
  const [importError, setImportError] = createSignal<string | null>(null);
  const [capReviewOpen, setCapReviewOpen] = createSignal(false);
  interface PendingCapability {
    kind: string;
    scope: string;
    approved: boolean;
  }
  const [pendingPlugin, setPendingPlugin] = createSignal<{
    namespace: string;
    name: string;
    capabilities: PendingCapability[];
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = createSignal<{
    ns: string;
    name: string;
  } | null>(null);
  let fileInputRef: HTMLInputElement | undefined;

  async function confirmDelete() {
    const target = deleteTarget();
    if (!target) return;
    const token = getToken();
    if (!token) return;
    try {
      await api.deletePlugin(getApiBaseUrl(), token, target.ns, target.name);
      setRefreshKey((k) => k + 1);
    } catch (err: any) {
      setImportError(err?.body ?? err?.message ?? "Failed to delete plugin");
    } finally {
      setDeleteTarget(null);
    }
  }

  async function handleImportPlugin(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setImportError(null);
    setImporting(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const token = getToken();
      if (!token) return;

      // Upload the plugin — the server parses the WASM module and registers it
      await api.uploadPlugin(getApiBaseUrl(), token, bytes, file.name);

      // Fetch the updated plugin list to get the real capabilities
      const allPlugins = await api.listPlugins(getApiBaseUrl(), token);
      if (Array.isArray(allPlugins)) {
        const added = allPlugins.find((p) =>
          file.name.toLowerCase().includes(p.name.toLowerCase()) ||
          file.name.toLowerCase().includes(p.namespace.toLowerCase())
        );
        if (added) {
          // Immediately disable the plugin — it must be explicitly approved first
          await api.setPluginEnabled(getApiBaseUrl(), token, added.namespace, added.name, false);

          // Show the review dialog with capabilities requiring approval
          setPendingPlugin({
            namespace: added.namespace,
            name: added.name,
            capabilities: added.capabilities.map((c) => ({
              kind: c.kind,
              scope: c.scope,
              approved: false,
            })),
          });
          setCapReviewOpen(true);
        }
      }

      setRefreshKey((k) => k + 1);
    } catch (err: any) {
      const msg = err?.body ?? err?.message ?? "Unknown error importing plugin";
      setImportError(msg);
    } finally {
      setImporting(false);
      input.value = "";
    }
  }

  function toggleCapApproval(index: number) {
    setPendingPlugin((prev) => {
      if (!prev) return prev;
      const caps = [...prev.capabilities];
      caps[index] = { ...caps[index], approved: !caps[index].approved };
      return { ...prev, capabilities: caps };
    });
  }

  function updatePendingScope(index: number, scope: string) {
    setPendingPlugin((prev) => {
      if (!prev) return prev;
      const caps = [...prev.capabilities];
      caps[index] = { ...caps[index], scope };
      return { ...prev, capabilities: caps };
    });
  }

  const allCapsApproved = () => {
    const pending = pendingPlugin();
    if (!pending || pending.capabilities.length === 0) return true;
    return pending.capabilities.every((c) => c.approved);
  };

  async function handleApproveAndEnable() {
    const pending = pendingPlugin();
    if (!pending) return;
    const token = getToken();
    if (!token) return;

    try {
      // Re-enable the plugin now that capabilities are approved
      await api.setPluginEnabled(getApiBaseUrl(), token, pending.namespace, pending.name, true);
      setCapReviewOpen(false);
      setPendingPlugin(null);
      setRefreshKey((k) => k + 1);
    } catch (err: any) {
      setImportError(err?.body ?? err?.message ?? "Failed to enable plugin");
    }
  }

  function cancelImport() {
    const pending = pendingPlugin();
    if (pending) {
      // Plugin stays disabled since user didn't approve
      setRefreshKey((k) => k + 1);
    }
    setCapReviewOpen(false);
    setPendingPlugin(null);
  }

  const [plugins, { refetch }] = createResource(
    () => refreshKey(),
    async () => {
      const token = getToken();
      try {
        const data = await api.listPlugins(getApiBaseUrl(), token ?? "");
        if (!Array.isArray(data)) return [];
        return data.filter((p) => p && p.name && p.namespace);
      } catch (err: any) {
        // Return empty on permission errors instead of throwing
        if (err?.status === 403 || err?.status === 401) return [];
        throw err;
      }
    }
  );

  const filteredPlugins = () => {
    const q = search().toLowerCase();
    const list = plugins() ?? [];
    if (!q) return list;
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.namespace.toLowerCase().includes(q)
    );
  };

  return (
    <div class="py-6 pb-24 sm:pb-6">
      {/* Header */}
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h2 class="text-2xl font-extrabold font-display">{t("plugins_title")}</h2>
          <p class="text-sm text-[rgb(var(--color-text-muted))] font-display">
            {t("plugins_subtitle")}
          </p>
        </div>
        <div class="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => fileInputRef?.click()}
            disabled={importing()}
          >
            <FileDown class="h-4 w-4" />
            <span>
              {importing() ? t("plugins_importing") : t("plugins_import")}
            </span>
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".wasm"
            class="hidden"
            onChange={handleImportPlugin}
          />
        </div>
      </div>

      {/* Search */}
      <div class="relative mb-6">
        <button
          class="absolute left-3 top-1/2 -translate-y-1/2 z-10 flex items-center justify-center text-[rgb(var(--color-text-muted))] hover:text-[rgb(var(--color-text))] transition-colors"
          onClick={() => {
            setRefreshKey((k) => k + 1);
            setLastSearched(search());
          }}
          title={t("plugins_refresh")}
        >
          <Show
            when={search() !== lastSearched()}
            fallback={<RefreshCw class="h-4 w-4" />}
          >
            <Search class="h-4 w-4" />
          </Show>
        </button>
        <Input
          placeholder={t("plugins_search_placeholder")}
          class="pl-10"
          value={search()}
          onInput={(e) => {
            setSearch(e.currentTarget.value);
          }}
        />
      </div>

      {/* Import error banner */}
      <Show when={importError()}>
        <div class="mb-4 flex items-start gap-2 rounded-2xl border border-red-500/30 bg-red-500/5 p-4">
          <AlertTriangle class="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
          <div class="flex-1">
            <p class="text-sm font-display font-semibold text-red-500">{t("plugins_import_failed")}</p>
            <p class="text-xs text-red-400 mt-0.5">{importError()}</p>
          </div>
          <button
            class="text-red-400 hover:text-red-500 text-xs"
            onClick={() => setImportError(null)}
          >
            {t("common_dismiss")}
          </button>
        </div>
      </Show>

      {/* Plugin grid */}
      <Show when={plugins.error}>
        <div class="mb-4 flex items-start gap-2 rounded-2xl border border-red-500/30 bg-red-500/5 p-4">
          <AlertTriangle class="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
          <div class="flex-1">
            <p class="text-sm font-display font-semibold text-red-500">{t("plugins_load_failed")}</p>
            <p class="text-xs text-red-400 mt-0.5">
              {(plugins.error as any)?.body ?? (plugins.error as any)?.message ?? "Unknown error"}
            </p>
          </div>
        </div>
      </Show>
      <div class="min-h-[320px]">
      <Show
        when={!plugins.loading}
        fallback={
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <For each={[1, 2, 3]}>
              {() => <Skeleton class="h-44 rounded-3xl" />}
            </For>
          </div>
        }
      >
        <Show
          when={(filteredPlugins()?.length ?? 0) > 0}
          fallback={
            <Card>
              <CardContent class="text-center py-16">
                <Puzzle class="h-12 w-12 mx-auto text-[rgb(var(--color-text-muted))] opacity-40 mb-4" />
                <h3 class="text-lg font-bold font-display mb-1">
                  {search() ? t("plugins_none_found") : t("plugins_none_installed")}
                </h3>
                <p class="text-sm text-[rgb(var(--color-text-muted))]">
                  {search()
                    ? t("plugins_try_search")
                    : t("plugins_get_started")}
                </p>
              </CardContent>
            </Card>
          }
        >
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <For each={filteredPlugins()}>
              {(plugin) => {
                return (
                  <Card
                    class="group hover:shadow-lg hover:scale-[1.01] transition-all duration-200 cursor-pointer"
                    on:click={() =>
                      navigate(
                        `/plugins/${encodeURIComponent(plugin.namespace)}/${encodeURIComponent(plugin.name)}/config`
                      )
                    }
                  >
                    <CardContent class="p-5">
                      <div class="flex items-start justify-between mb-3">
                        <div class="flex items-center gap-3">
                          <div
                            class={cn(
                              "flex h-10 w-10 items-center justify-center rounded-2xl",
                              "bg-[rgb(var(--color-primary))]/10"
                            )}
                          >
                            <span class="text-2xl">{pluginEmoji(plugin.name)}</span>
                          </div>
                          <div>
                            <h3 class="font-bold font-display text-sm">
                              {plugin.name}
                            </h3>
                            <p class="text-xs text-[rgb(var(--color-text-muted))]">
                              {plugin.namespace}
                              {plugin.author ? ` \u00b7 ${plugin.author}` : ""}
                            </p>
                          </div>
                        </div>

                        {/* Dropdown menu */}
                        <DropdownMenu>
                          <DropdownMenu.Trigger
                            class="flex h-8 w-8 items-center justify-center rounded-xl text-[rgb(var(--color-text-muted))] hover:bg-[rgb(var(--color-surface-hover))] hover:text-[rgb(var(--color-text))] transition-colors"
                            on:click={(e: MouseEvent) => e.stopPropagation()}
                          >
                            <ChevronDown class="h-4 w-4" />
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content class="z-50 min-w-[160px] rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-1 shadow-lg animate-fade-in">
                              <DropdownMenu.Item
                                class="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-display cursor-pointer outline-none hover:bg-[rgb(var(--color-surface-hover))]"
                                onSelect={async () => {
                                  const token = getToken();
                                  if (!token) return;
                                  try {
                                    await api.setPluginEnabled(
                                      getApiBaseUrl(),
                                      token,
                                      plugin.namespace,
                                      plugin.name,
                                      !plugin.enabled
                                    );
                                    setRefreshKey((k) => k + 1);
                                  } catch (err: any) {
                                    setImportError(err?.body ?? err?.message ?? "Failed to toggle plugin");
                                  }
                                }}
                              >
                                {plugin.enabled ? <PowerOff class="h-3.5 w-3.5" /> : <Power class="h-3.5 w-3.5" />}
                                {plugin.enabled ? t("plugins_toggle_disable") : t("plugins_toggle_enable")}
                              </DropdownMenu.Item>
                              <DropdownMenu.Item
                                class="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-display cursor-pointer outline-none hover:bg-[rgb(var(--color-surface-hover))]"
                                onSelect={() =>
                                  navigate(
                                    `/plugins/${encodeURIComponent(plugin.namespace)}/${encodeURIComponent(plugin.name)}/config`
                                  )
                                }
                              >
                                <Settings class="h-3.5 w-3.5" />
                                {t("plugins_configure")}
                              </DropdownMenu.Item>
                              <Show when={plugin.url}>
                                <DropdownMenu.Item
                                  class="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-display cursor-pointer outline-none hover:bg-[rgb(var(--color-surface-hover))]"
                                  onSelect={() => window.open(plugin.url, "_blank")}
                                >
                                  <ExternalLink class="h-3.5 w-3.5" />
                                  {t("plugins_homepage")}
                                </DropdownMenu.Item>
                              </Show>
                              <DropdownMenu.Separator class="my-1 h-px bg-[rgb(var(--color-border))]" />
                              <DropdownMenu.Item
                                class="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-display cursor-pointer outline-none hover:bg-red-500/10 text-red-500"
                                onSelect={() => {
                                  setDeleteTarget({
                                    ns: plugin.namespace,
                                    name: plugin.name,
                                  });
                                }}
                              >
                                <Trash2 class="h-3.5 w-3.5" />
                                {t("plugins_delete")}
                              </DropdownMenu.Item>
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu>
                      </div>

                      <p class="text-xs text-[rgb(var(--color-text-muted))] mb-3 line-clamp-2">
                        {plugin.description || `${plugin.namespace}/${plugin.name}`}
                      </p>

                      <div class="flex items-center justify-between">
                        <Badge variant={plugin.enabled ? "success" : "secondary"}>
                          {plugin.enabled ? t("plugins_active") : t("plugins_disabled")}
                        </Badge>
                        <span class="text-xs text-[rgb(var(--color-text-muted))]">
                          {plugin.license || t("plugins_license", "Unknown")}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>
      </div>

      {/* Capability review dialog */}
      <Dialog open={capReviewOpen()} onOpenChange={(open) => { if (!open) cancelImport(); }}>
        <Dialog.Portal>
          <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50 animate-fade-in" />
          <Dialog.Content class="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-6 shadow-xl animate-fade-in max-h-[85vh] overflow-y-auto scrollbar-float">
            <div class="flex items-center justify-between mb-4">
              <div class="flex items-center gap-2">
                <ShieldCheck class="h-5 w-5 text-[rgb(var(--color-primary))]" />
                <Dialog.Title class="text-lg font-bold font-display">
                  {t("plugins_review_capabilities")}
                </Dialog.Title>
              </div>
              <Dialog.CloseButton class="flex h-8 w-8 items-center justify-center rounded-xl text-[rgb(var(--color-text-muted))] hover:bg-[rgb(var(--color-surface-hover))] hover:text-[rgb(var(--color-text))] transition-colors">
                <X class="h-4 w-4" />
              </Dialog.CloseButton>
            </div>

            <Dialog.Description class="text-sm text-[rgb(var(--color-text-muted))] mb-4">
              {t("plugins_review_caps_desc")}
            </Dialog.Description>

            <Show when={pendingPlugin()}>
              <p class="text-sm font-display font-semibold mb-3">
                {pendingPlugin()!.namespace}/{pendingPlugin()!.name}
              </p>
              <div class="space-y-2 mb-5">
                <For each={pendingPlugin()!.capabilities}>
                  {(cap, i) => {
                    const meta = getCapMeta(cap.kind);
                    const Icon = meta.icon;
                    return (
                      <div class={cn(
                        "rounded-xl border p-3 transition-colors",
                        cap.approved
                          ? "border-[rgb(var(--color-success))]/50 bg-[rgb(var(--color-success))]/5"
                          : "border-[rgb(var(--color-border))]"
                      )}>
                        <div class="flex items-start gap-3">
                          {/* Approval checkbox */}
                          <button
                            onClick={() => toggleCapApproval(i())}
                            class={cn(
                              "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border-2 transition-all mt-0.5",
                              cap.approved
                                ? "border-[rgb(var(--color-success))] bg-[rgb(var(--color-success))] text-white"
                                : "border-[rgb(var(--color-border))] hover:border-[rgb(var(--color-primary))]"
                            )}
                          >
                            <Show when={cap.approved}>
                              <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none">
                                <path d="M3 8l3.5 3.5L13 5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
                              </svg>
                            </Show>
                          </button>

                          <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2">
                              <Icon class={cn(
                                "h-4 w-4 shrink-0",
                                cap.approved ? "text-[rgb(var(--color-success))]" : "text-[rgb(var(--color-text-muted))]"
                              )} />
                              <p class="text-sm font-display font-semibold">{meta.label}</p>
                            </div>
                            <p class="text-xs text-[rgb(var(--color-text-muted))] mt-0.5">
                              {meta.description}
                            </p>
                            {/* Editable scope/filter expression */}
                            <div class="mt-2">
                              <div class="flex items-center gap-1.5">
                                <label class="text-[10px] font-display font-semibold text-[rgb(var(--color-text-muted))] uppercase tracking-wider">
                                  {t("plugin_config_scope_label")}
                                </label>
                                <FilterExpressionHelp />
                              </div>
                              <input
                                type="text"
                                value={cap.scope}
                                onInput={(e) => updatePendingScope(i(), e.currentTarget.value)}
                                class="mt-0.5 w-full rounded-lg border border-[rgb(var(--color-border))] bg-transparent px-2.5 py-1.5 font-mono text-xs text-[rgb(var(--color-text))] focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-primary))]"
                                placeholder="true"
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>

            <div class="flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={cancelImport}>
                {t("plugins_cancel")}
              </Button>
              <div class="flex items-center gap-2">
                <Show when={!allCapsApproved()}>
                  <span class="text-xs text-[rgb(var(--color-text-muted))]">
                    {t("plugins_approve_pending")}
                  </span>
                </Show>
                <Button
                  size="sm"
                  onClick={handleApproveAndEnable}
                  disabled={!allCapsApproved()}
                >
                  <ShieldCheck class="h-4 w-4" />
                  {t("plugins_approve_install")}
                </Button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget()} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50 animate-fade-in" />
          <Dialog.Content class="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-6 shadow-xl animate-fade-in">
            <Dialog.Title class="text-lg font-bold font-display mb-2">
              {t("plugins_delete")}
            </Dialog.Title>
            <Dialog.Description class="text-sm text-[rgb(var(--color-text-muted))] mb-6">
              {t("plugins_delete_confirm")}
            </Dialog.Description>
            <div class="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)}>
                {t("plugins_cancel")}
              </Button>
              <Button
                size="sm"
                class="bg-red-500 hover:bg-red-600 text-white"
                onClick={confirmDelete}
              >
                <Trash2 class="h-3.5 w-3.5" />
                {t("plugins_delete")}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </div>
  );
}
