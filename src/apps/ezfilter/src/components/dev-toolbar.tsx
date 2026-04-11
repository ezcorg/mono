import { Show, createSignal } from "solid-js";
import { Bug, Trash2, RotateCcw, Info, X, AlertTriangle } from "lucide-solid";
import { isDevMode, clearAllAppState } from "../lib/stores/devmode";
import { getApiBaseUrl, getConfig } from "../lib/stores/config";
import { getToken } from "../lib/stores/auth";
import { getResolvedTheme } from "../lib/stores/theme";
import { t } from "../lib/i18n";

export function DevToolbar() {
  const [open, setOpen] = createSignal(false);
  const [confirmingClear, setConfirmingClear] = createSignal(false);

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
                  onClick={() => { setOpen(false); setConfirmingClear(false); }}
                  class="flex h-6 w-6 items-center justify-center rounded-lg text-[rgb(var(--color-text-muted))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-hover))] transition-colors"
                >
                  <X class="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Actions */}
              <div class="p-2 space-y-1">
                <Show
                  when={!confirmingClear()}
                  fallback={
                    <div class="px-3 py-2 space-y-2">
                      <p class="text-xs text-[rgb(var(--color-text-muted))] flex items-start gap-1.5">
                        <AlertTriangle class="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
                        {t("settings_dev_clear_confirm")}
                      </p>
                      <div class="flex gap-2">
                        <button
                          onClick={() => clearAllAppState()}
                          class="flex-1 px-3 py-1.5 rounded-lg text-xs font-display font-semibold bg-red-500 text-white hover:bg-red-600 transition-colors"
                        >
                          {t("settings_dev_clear")}
                        </button>
                        <button
                          onClick={() => setConfirmingClear(false)}
                          class="flex-1 px-3 py-1.5 rounded-lg text-xs font-display font-medium text-[rgb(var(--color-text-muted))] hover:bg-[rgb(var(--color-surface-hover))] transition-colors"
                        >
                          {t("plugins_cancel")}
                        </button>
                      </div>
                    </div>
                  }
                >
                  <button
                    onClick={() => setConfirmingClear(true)}
                    class="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-xs font-display font-medium text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-hover))] transition-colors"
                  >
                    <Trash2 class="h-3.5 w-3.5 text-red-500" />
                    {t("settings_dev_clear")}
                  </button>
                </Show>
                <button
                  onClick={() => window.location.reload()}
                  class="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-xs font-display font-medium text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-hover))] transition-colors"
                >
                  <RotateCcw class="h-3.5 w-3.5" />
                  {t("settings_dev_reload")}
                </button>
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
    </Show>
  );
}
