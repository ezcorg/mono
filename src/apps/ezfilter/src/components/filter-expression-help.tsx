import { HelpCircle } from "lucide-solid";
import { Tooltip } from "@kobalte/core/tooltip";
import { t } from "../lib/i18n";

export function FilterExpressionHelp() {
  return (
    <Tooltip openDelay={150} closeDelay={50} placement="top">
      <Tooltip.Trigger
        as="button"
        type="button"
        class="inline-flex h-4 w-4 items-center justify-center rounded-full text-[rgb(var(--color-text-muted))] hover:text-[rgb(var(--color-text))] transition-colors"
        aria-label={t("plugin_config_scope_help_title")}
      >
        <HelpCircle class="h-3.5 w-3.5" />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content class="z-50 max-w-xs rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-3 shadow-xl animate-fade-in">
          <p class="text-xs font-display font-semibold text-[rgb(var(--color-text))] mb-1">
            {t("plugin_config_scope_help_title")}
          </p>
          <p class="text-[11px] text-[rgb(var(--color-text-muted))] leading-relaxed mb-2">
            {t("plugin_config_scope_help_body")}
          </p>
          <div class="space-y-0.5">
            <p class="text-[10px] font-display font-semibold uppercase tracking-wider text-[rgb(var(--color-text-muted))]">
              {t("plugin_config_scope_help_examples")}
            </p>
            <code class="block text-[10px] font-mono text-[rgb(var(--color-text))]">true</code>
            <code class="block text-[10px] font-mono text-[rgb(var(--color-text))]">host == "example.com"</code>
            <code class="block text-[10px] font-mono text-[rgb(var(--color-text))]">method == "POST" &amp;&amp; path.starts_with("/api")</code>
          </div>
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip>
  );
}
