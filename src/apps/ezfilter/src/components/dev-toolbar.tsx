import { Show, createSignal, onCleanup, createEffect } from "solid-js";
import { Dialog } from "@kobalte/core/dialog";
import { Bug, Trash2, RotateCcw, Info, X, AlertTriangle, Activity } from "lucide-solid";
import { isDevMode, clearAllAppState } from "../lib/stores/devmode";
import { getApiBaseUrl, getConfig } from "../lib/stores/config";
import { getToken } from "../lib/stores/auth";
import { getResolvedTheme } from "../lib/stores/theme";
import { Button } from "./ui/button";
import { t } from "../lib/i18n";

interface ProcessMetrics {
  cpu_percent: number;
  mem_bytes: number;
}

export function DevToolbar() {
  const [open, setOpen] = createSignal(false);
  const [confirmingClear, setConfirmingClear] = createSignal(false);

  // Metrics signals — only updated while the panel is open.
  const [cpu, setCpu] = createSignal<number | null>(null);
  const [memMb, setMemMb] = createSignal<number | null>(null);
  const [fps, setFps] = createSignal<number | null>(null);
  const [metricsAvailable, setMetricsAvailable] = createSignal(true);

  createEffect(() => {
    if (!open()) return;

    let cancelled = false;
    let rafId = 0;
    let frameCount = 0;
    let lastFpsTime = performance.now();

    // CPU + memory poll (Tauri only)
    const sample = async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const m = await invoke<ProcessMetrics>("get_process_metrics");
        if (cancelled) return;
        setCpu(m.cpu_percent);
        setMemMb(m.mem_bytes / (1024 * 1024));
        setMetricsAvailable(true);
      } catch {
        if (cancelled) return;
        setMetricsAvailable(false);
      }
    };
    sample();
    const interval = setInterval(sample, 1000);

    // FPS via rAF over a rolling 1s window
    const tick = () => {
      if (cancelled) return;
      frameCount++;
      const now = performance.now();
      const elapsed = now - lastFpsTime;
      if (elapsed >= 1000) {
        setFps(Math.round((frameCount * 1000) / elapsed));
        frameCount = 0;
        lastFpsTime = now;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    onCleanup(() => {
      cancelled = true;
      clearInterval(interval);
      cancelAnimationFrame(rafId);
    });
  });

  function handleConfirmClear() {
    setConfirmingClear(false);
    clearAllAppState();
  }

  return (
    <Show when={isDevMode()}>
      <div class="fixed bottom-4 right-4 z-[100]">
        <Show
          when={!open()}
          fallback={
            <div class="w-72 rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]/95 backdrop-blur-md shadow-lg animate-fade-in">
              {/* Header */}
              <div class="flex items-center justify-between px-4 py-2.5 border-b border-[rgb(var(--color-border))]">
                <span class="text-xs font-bold font-display uppercase tracking-wider text-[rgb(var(--color-text-muted))]">
                  {t("settings_dev_title")}
                </span>
                <button
                  onClick={() => setOpen(false)}
                  class="flex h-6 w-6 items-center justify-center rounded-lg text-[rgb(var(--color-text-muted))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-hover))] transition-colors"
                >
                  <X class="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Actions */}
              <div class="p-2 space-y-1">
                <button
                  onClick={() => setConfirmingClear(true)}
                  class="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-xs font-display font-medium text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-hover))] transition-colors"
                >
                  <Trash2 class="h-3.5 w-3.5 text-red-500" />
                  {t("settings_dev_clear")}
                </button>
                <button
                  onClick={() => window.location.reload()}
                  class="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-xs font-display font-medium text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-hover))] transition-colors"
                >
                  <RotateCcw class="h-3.5 w-3.5" />
                  {t("settings_dev_reload")}
                </button>
              </div>

              {/* Live metrics */}
              <div class="px-4 py-2 border-t border-[rgb(var(--color-border))]">
                <div class="flex items-center gap-1.5 text-[10px] font-mono text-[rgb(var(--color-text-muted))]">
                  <Activity class="h-3 w-3 shrink-0" />
                  <span class="truncate">
                    <Show when={metricsAvailable() && cpu() !== null} fallback={<>FPS {fps() ?? "—"}</>}>
                      CPU {cpu()!.toFixed(1)}% &middot; MEM {memMb()!.toFixed(0)} MB &middot; FPS {fps() ?? "—"}
                    </Show>
                  </span>
                </div>
              </div>

              {/* Build info */}
              <div class="px-4 py-2.5 border-t border-[rgb(var(--color-border))] space-y-0.5">
                <div class="flex items-center gap-1.5 text-[10px] text-[rgb(var(--color-text-muted))] font-mono">
                  <Info class="h-3 w-3 shrink-0" />
                  <span class="truncate">
                    {import.meta.env.DEV ? "dev" : "prod"} &middot; {getResolvedTheme()}
                  </span>
                </div>
                <p class="text-[10px] text-[rgb(var(--color-text-muted))] font-mono truncate">
                  {getApiBaseUrl() || "no server"}
                </p>
                <p class="text-[10px] text-[rgb(var(--color-text-muted))] font-mono truncate">
                  token: {getToken() ? `${getToken()!.slice(0, 12)}…` : "none"}
                </p>
                <p class="text-[10px] text-[rgb(var(--color-text-muted))] font-mono truncate">
                  setup: {String(getConfig()?.setupComplete ?? false)}
                </p>
              </div>
            </div>
          }
        >
          <button
            onClick={() => setOpen(true)}
            class="flex h-10 w-10 items-center justify-center rounded-full bg-[rgb(var(--color-surface))]/90 backdrop-blur-md border border-[rgb(var(--color-border))] shadow-lg text-[rgb(var(--color-text-muted))] hover:text-[rgb(var(--color-text))] hover:scale-105 transition-all"
            title={t("settings_dev_title")}
          >
            <Bug class="h-4 w-4" />
          </button>
        </Show>
      </div>

      {/* Clear-storage confirmation modal */}
      <Dialog open={confirmingClear()} onOpenChange={(o) => setConfirmingClear(o)}>
        <Dialog.Portal>
          <Dialog.Overlay class="fixed inset-0 z-[110] bg-black/50 animate-fade-in" />
          <Dialog.Content class="fixed left-1/2 top-1/2 z-[110] w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-6 shadow-xl animate-fade-in">
            <div class="flex items-start gap-3 mb-4">
              <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-500/10">
                <AlertTriangle class="h-5 w-5 text-red-500" />
              </div>
              <div class="flex-1">
                <Dialog.Title class="text-base font-bold font-display text-[rgb(var(--color-text))]">
                  {t("settings_dev_clear")}
                </Dialog.Title>
                <Dialog.Description class="text-sm text-[rgb(var(--color-text-muted))] mt-1">
                  {t("settings_dev_clear_confirm")}
                </Dialog.Description>
              </div>
            </div>
            <div class="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setConfirmingClear(false)}>
                {t("plugins_cancel")}
              </Button>
              <Button
                size="sm"
                class="bg-red-500 hover:bg-red-600 text-white"
                onClick={handleConfirmClear}
              >
                <Trash2 class="h-3.5 w-3.5" />
                {t("settings_dev_clear")}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </Show>
  );
}
