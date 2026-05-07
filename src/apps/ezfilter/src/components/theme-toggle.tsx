import { Sun, Moon, Monitor } from "lucide-solid";
import { getTheme, setTheme, type Theme } from "../lib/stores/theme";
import { cn } from "../lib/cn";

export function ThemeToggle() {
  const themes: { value: Theme; icon: typeof Sun; label: string }[] = [
    { value: "light", icon: Sun, label: "Day" },
    { value: "dark", icon: Moon, label: "Night" },
    { value: "auto", icon: Monitor, label: "Auto" },
  ];

  return (
    <div class="flex items-center gap-1 rounded-full bg-[rgb(var(--color-surface))] p-1 border border-[rgb(var(--color-border))] shadow-sm">
      {themes.map((t) => {
        const Icon = t.icon;
        return (
          <button
            onClick={() => setTheme(t.value)}
            class={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-display font-semibold transition-all duration-200",
              getTheme() === t.value
                ? "bg-[rgb(var(--color-primary))] text-white shadow-sm"
                : "text-[rgb(var(--color-text-muted))] hover:text-[rgb(var(--color-text))]"
            )}
            title={t.label}
          >
            <Icon class="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}
