import { createSignal, createResource, For, Show, onMount } from "solid-js";
import { A } from "@solidjs/router";
import {
  Puzzle,
  Settings,
  Power,
  PowerOff,
  Upload,
  RefreshCw,
  Search,
  Shield,
  Zap,
  Eye,
  Clock,
  Globe,
} from "lucide-solid";
import { Card, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Skeleton } from "../components/ui/skeleton";
import { WitmproxyClient } from "../lib/api/client";
import { getApiBaseUrl } from "../lib/stores/config";
import { getToken } from "../lib/stores/auth";
import { cn } from "../lib/cn";

interface PluginInfo {
  /** "namespace/name" format from the API */
  fullName: string;
  namespace: string;
  name: string;
  enabled: boolean;
}

function parsePluginName(fullName: string): { namespace: string; name: string } {
  const parts = fullName.split("/");
  if (parts.length >= 2) {
    return { namespace: parts[0], name: parts.slice(1).join("/") };
  }
  return { namespace: "unknown", name: fullName };
}

// Map plugin names to icons and descriptions for known ezfilter plugins
const KNOWN_PLUGINS: Record<
  string,
  { icon: typeof Puzzle; description: string; color: string }
> = {
  noshorts: {
    icon: Eye,
    description: "Block short-form video content (Reels, Shorts, TikTok)",
    color: "text-red-400",
  },
  noslop: {
    icon: Shield,
    description: "Filter low-quality, manipulative, and addictive content",
    color: "text-amber-400",
  },
  nofeeds: {
    icon: Zap,
    description: "Hide algorithmic feeds from popular apps",
    color: "text-purple-400",
  },
  nocomments: {
    icon: Eye,
    description: "Hide comment sections from webpages",
    color: "text-blue-400",
  },
  notrump: {
    icon: Shield,
    description: "Filter Trump-related content",
    color: "text-orange-400",
  },
  moredogs: {
    icon: Globe,
    description: "Inject additional dogs into your browsing experience",
    color: "text-green-400",
  },
  focus: {
    icon: Clock,
    description: "Restrict internet use to your set goals",
    color: "text-indigo-400",
  },
};

export default function PluginsPage() {
  const [search, setSearch] = createSignal("");
  const [refreshKey, setRefreshKey] = createSignal(0);

  const [plugins, { refetch }] = createResource(
    () => refreshKey(),
    async () => {
      const client = new WitmproxyClient(getApiBaseUrl());
      const token = getToken();
      if (token) client.setToken(token);

      const names = await client.listPlugins();
      return names.map(
        (fullName): PluginInfo => ({
          fullName,
          ...parsePluginName(fullName),
          enabled: true, // default to enabled; real state comes from tenant config
        })
      );
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
    <div class="px-4 sm:px-6 py-6 pb-24 sm:pb-6 max-w-5xl mx-auto">
      {/* Header */}
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h2 class="text-2xl font-extrabold font-display">Plugins</h2>
          <p class="text-sm text-[rgb(var(--color-text-muted))] font-display">
            Manage your content filtering plugins
          </p>
        </div>
        <div class="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              setRefreshKey((k) => k + 1);
            }}
            title="Refresh"
          >
            <RefreshCw class="h-4 w-4" />
          </Button>
          <Button variant="secondary" size="sm">
            <Upload class="h-4 w-4" />
            <span class="hidden sm:inline">Upload Plugin</span>
          </Button>
        </div>
      </div>

      {/* Search */}
      <div class="relative mb-6">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[rgb(var(--color-text-muted))]" />
        <Input
          placeholder="Search plugins..."
          class="pl-10"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
      </div>

      {/* Plugin grid */}
      <Show
        when={!plugins.loading}
        fallback={
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <For each={[1, 2, 3, 4, 5, 6]}>
              {() => <Skeleton class="h-44 rounded-3xl" />}
            </For>
          </div>
        }
      >
        <Show
          when={(filteredPlugins()?.length ?? 0) > 0}
          fallback={
            <div class="text-center py-16">
              <Puzzle class="h-12 w-12 mx-auto text-[rgb(var(--color-text-muted))] opacity-40 mb-4" />
              <h3 class="text-lg font-bold font-display mb-1">
                {search() ? "No plugins found" : "No plugins installed"}
              </h3>
              <p class="text-sm text-[rgb(var(--color-text-muted))]">
                {search()
                  ? "Try a different search term"
                  : "Upload a plugin to get started"}
              </p>
            </div>
          }
        >
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <For each={filteredPlugins()}>
              {(plugin) => {
                const known = KNOWN_PLUGINS[plugin.name];
                const Icon = known?.icon ?? Puzzle;
                return (
                  <Card class="group hover:shadow-lg hover:scale-[1.01] transition-all duration-200">
                    <CardContent class="p-5">
                      <div class="flex items-start justify-between mb-3">
                        <div class="flex items-center gap-3">
                          <div
                            class={cn(
                              "flex h-10 w-10 items-center justify-center rounded-2xl",
                              "bg-[rgb(var(--color-primary))]/10"
                            )}
                          >
                            <Icon
                              class={cn(
                                "h-5 w-5",
                                known?.color ?? "text-[rgb(var(--color-primary))]"
                              )}
                            />
                          </div>
                          <div>
                            <h3 class="font-bold font-display text-sm">
                              {plugin.name}
                            </h3>
                            <p class="text-xs text-[rgb(var(--color-text-muted))]">
                              {plugin.namespace}
                            </p>
                          </div>
                        </div>
                        <Switch
                          checked={plugin.enabled}
                          onChange={() => {
                            // toggle logic would go here
                          }}
                        />
                      </div>

                      <p class="text-xs text-[rgb(var(--color-text-muted))] mb-4 line-clamp-2">
                        {known?.description ?? `Plugin: ${plugin.fullName}`}
                      </p>

                      <div class="flex items-center justify-between">
                        <Badge variant={plugin.enabled ? "success" : "secondary"}>
                          {plugin.enabled ? "Active" : "Disabled"}
                        </Badge>
                        <A
                          href={`/plugins/${encodeURIComponent(plugin.namespace)}/${encodeURIComponent(plugin.name)}/config`}
                          class="flex items-center gap-1 text-xs font-display font-semibold text-[rgb(var(--color-text-muted))] hover:text-[rgb(var(--color-primary))] transition-colors"
                        >
                          <Settings class="h-3.5 w-3.5" />
                          Configure
                        </A>
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
  );
}
