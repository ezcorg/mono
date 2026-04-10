import { type JSX, Show, onMount } from "solid-js";
import { A, useLocation, useNavigate } from "@solidjs/router";
import { Puzzle, Settings, LogOut, Power, Loader2 } from "lucide-solid";
import { DayNightScene } from "./day-night-scene";
import { cn } from "../lib/cn";
import { t } from "../lib/i18n";
import { logout } from "../lib/stores/auth";
import { clearConfig } from "../lib/stores/config";
import {
  getConnectionStatus,
  checkProxyStatus,
  connectProxy,
  disconnectProxy,
} from "../lib/stores/connection";

interface LayoutProps {
  children: JSX.Element;
}

export function Layout(props: LayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();

  const navItems = [
    { href: "/plugins", icon: Puzzle, label: () => t("nav_plugins") },
    { href: "/settings", icon: Settings, label: () => t("nav_settings") },
  ];

  const isSetup = () =>
    location.pathname === "/" || location.pathname.startsWith("/setup");

  // Check proxy connection status on mount
  onMount(() => {
    checkProxyStatus();
  });

  async function handleToggleConnection() {
    const status = getConnectionStatus();
    if (status === "connected") {
      await disconnectProxy();
    } else {
      await connectProxy();
    }
  }

  function handleLogout() {
    logout();
    clearConfig();
    navigate("/", { replace: true });
  }

  return (
    <div class="relative h-screen overflow-hidden">
      <DayNightScene />

      <div class="relative z-10 h-full w-full">
        <Show
          when={!isSetup()}
          fallback={
            <main class="h-full overflow-y-auto scrollbar-float">{props.children}</main>
          }
        >
          {/* Desktop: nav + scrollable content */}
          <div class="hidden sm:flex h-full w-full overflow-hidden">
            {/* Nav column -- sticky pill aligned with first content below page header */}
            <div class="flex justify-end pt-[6.5rem] pl-4 pr-4 sm:pl-6 sm:pr-6 sticky top-0 self-start">
              <div class="flex flex-col gap-1 p-1.5 rounded-2xl backdrop-blur-md bg-[rgb(var(--color-surface))]/80 border border-[rgb(var(--color-border))] shadow-[var(--shadow-card)] h-fit">
                {/* Start/Stop at the top */}
                <Show when={getConnectionStatus() !== "unknown"}>
                  <button
                    onClick={handleToggleConnection}
                    disabled={getConnectionStatus() === "checking"}
                    class={cn(
                      "flex flex-col items-center gap-0.5 px-2.5 py-2 rounded-xl text-[10px] font-display font-semibold transition-all duration-200",
                      getConnectionStatus() === "connected"
                        ? "text-[rgb(var(--color-success))] hover:text-red-500 hover:bg-red-500/10"
                        : getConnectionStatus() === "checking"
                          ? "text-[rgb(var(--color-text-muted))] opacity-70"
                          : "text-[rgb(var(--color-text-muted))] hover:text-[rgb(var(--color-success))] hover:bg-[rgb(var(--color-success))]/10"
                    )}
                  >
                    <Show
                      when={getConnectionStatus() !== "checking"}
                      fallback={<Loader2 class="h-5 w-5 animate-spin" />}
                    >
                      <Power class="h-5 w-5" />
                    </Show>
                    <span>
                      {getConnectionStatus() === "connected"
                        ? t("nav_stop")
                        : t("nav_start")}
                    </span>
                  </button>
                  <div class="h-px bg-[rgb(var(--color-border))] my-1" />
                </Show>
                {navItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <A
                      href={item.href}
                      class={cn(
                        "flex flex-col items-center gap-0.5 px-2.5 py-2 rounded-xl text-[10px] font-display font-semibold transition-all duration-200",
                        location.pathname.startsWith(item.href)
                          ? "bg-[rgb(var(--color-primary))]/15 text-[rgb(var(--color-primary))]"
                          : "text-[rgb(var(--color-text-muted))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-hover))]"
                      )}
                    >
                      <Icon class="h-5 w-5" />
                      <span>{item.label()}</span>
                    </A>
                  );
                })}
                <div class="h-px bg-[rgb(var(--color-border))] my-1" />
                <button
                  onClick={handleLogout}
                  class="flex flex-col items-center gap-0.5 px-2.5 py-2 rounded-xl text-[10px] font-display font-semibold text-[rgb(var(--color-text-muted))] hover:text-red-500 hover:bg-red-500/10 transition-all duration-200"
                >
                  <LogOut class="h-5 w-5" />
                  <span>{t("nav_logout")}</span>
                </button>
              </div>
            </div>

            {/* Scrollable area -- fills remaining width, overlay scrollbar */}
            <main class="flex-1 min-w-0 overflow-x-hidden overflow-y-auto scrollbar-float">
              <div class="max-w-4xl w-full px-4 sm:px-6">
                {props.children}
              </div>
            </main>
          </div>

          {/* Mobile: full-width scrollable */}
          <main class="sm:hidden h-full w-full overflow-y-auto scrollbar-float px-4">
            {props.children}
          </main>
        </Show>

        {/* Mobile bottom nav */}
        <Show when={!isSetup()}>
          <nav class="sm:hidden fixed bottom-0 inset-x-0 z-50 flex items-center justify-around backdrop-blur-md bg-[rgb(var(--color-surface))]/90 border-t border-[rgb(var(--color-border))] py-2 px-4">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <A
                  href={item.href}
                  class={cn(
                    "flex flex-col items-center gap-0.5 px-3 py-1 rounded-xl text-xs font-display font-semibold transition-all",
                    location.pathname.startsWith(item.href)
                      ? "text-[rgb(var(--color-primary))]"
                      : "text-[rgb(var(--color-text-muted))]"
                  )}
                >
                  <Icon class="h-5 w-5" />
                  {item.label()}
                </A>
              );
            })}
            <Show when={getConnectionStatus() !== "unknown"}>
              <button
                onClick={handleToggleConnection}
                disabled={getConnectionStatus() === "checking"}
                class={cn(
                  "flex flex-col items-center gap-0.5 px-3 py-1 rounded-xl text-xs font-display font-semibold transition-all",
                  getConnectionStatus() === "connected"
                    ? "text-[rgb(var(--color-success))]"
                    : "text-[rgb(var(--color-text-muted))]"
                )}
              >
                <Show
                  when={getConnectionStatus() !== "checking"}
                  fallback={<Loader2 class="h-5 w-5 animate-spin" />}
                >
                  <Power class="h-5 w-5" />
                </Show>
                {getConnectionStatus() === "connected"
                  ? t("nav_stop")
                  : t("nav_start")}
              </button>
            </Show>
            <button
              onClick={handleLogout}
              class="flex flex-col items-center gap-0.5 px-3 py-1 rounded-xl text-xs font-display font-semibold text-[rgb(var(--color-text-muted))]"
            >
              <LogOut class="h-5 w-5" />
              {t("nav_logout")}
            </button>
          </nav>
        </Show>
      </div>
    </div>
  );
}
