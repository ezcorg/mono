import { type JSX, Show } from "solid-js";
import { A, useLocation } from "@solidjs/router";
import { Puzzle, Settings } from "lucide-solid";
import { DayNightScene } from "./day-night-scene";
import { cn } from "../lib/cn";

interface LayoutProps {
  children: JSX.Element;
}

export function Layout(props: LayoutProps) {
  const location = useLocation();

  const navItems = [
    { href: "/plugins", icon: Puzzle, label: "Plugins" },
    { href: "/settings", icon: Settings, label: "Settings" },
  ];

  const isSetup = () =>
    location.pathname === "/" || location.pathname.startsWith("/setup");

  return (
    <div class="relative min-h-screen">
      <DayNightScene />

      <div class="relative z-10 flex flex-col min-h-screen">
        {/* Header */}
        <Show when={!isSetup()}>
          <header class="flex items-center justify-between px-4 sm:px-6 py-3 backdrop-blur-md bg-[rgb(var(--color-surface))]/80 border-b border-[rgb(var(--color-border))]">
            <div class="flex items-center gap-3">
              <h1 class="text-lg font-extrabold font-display tracking-tight">
                <span class="text-[rgb(var(--color-primary))]">ez</span>filter
              </h1>
            </div>

            {/* Desktop nav */}
            <nav class="hidden sm:flex items-center gap-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                return (
                  <A
                    href={item.href}
                    class={cn(
                      "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-display font-semibold transition-all duration-200",
                      location.pathname.startsWith(item.href)
                        ? "bg-[rgb(var(--color-primary))]/10 text-[rgb(var(--color-primary))]"
                        : "text-[rgb(var(--color-text-muted))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-hover))]"
                    )}
                  >
                    <Icon class="h-4 w-4" />
                    {item.label}
                  </A>
                );
              })}
            </nav>

            {/* Theme toggle moved to Settings page */}
          </header>
        </Show>

        {/* Main content */}
        <main class="flex-1">{props.children}</main>

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
                  {item.label}
                </A>
              );
            })}
          </nav>
        </Show>
      </div>
    </div>
  );
}
