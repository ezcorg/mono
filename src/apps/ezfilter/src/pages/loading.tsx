import { createSignal, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { isSetupComplete } from "../lib/stores/config";
import { DayNightScene } from "../components/day-night-scene";
import { EzfilterLogo } from "../components/ezfilter-logo";
import { t } from "../lib/i18n";
import { Button } from "../components/ui/button";
import { ArrowRight } from "lucide-solid";

export default function LoadingPage() {
  const navigate = useNavigate();
  const [showActions, setShowActions] = createSignal(false);

  onMount(() => {
    if (isSetupComplete()) {
      navigate("/plugins", { replace: true });
      return;
    }
    const timer = setTimeout(() => setShowActions(true), 800);
    return () => clearTimeout(timer);
  });

  return (
    <div class="relative min-h-screen flex flex-col items-center justify-center overflow-hidden">
      <DayNightScene />

      <div class="relative z-10 flex flex-col items-center gap-8">
        {/* Logo */}
        <div>
          <EzfilterLogo
            size="text-7xl sm:text-8xl"
            class="text-[rgb(var(--color-text))]"
          />
        </div>

        {/* Action area — fixed height to prevent layout shift */}
        <div class="h-12 flex items-center justify-center">
          <Show
            when={showActions()}
            fallback={
              <div class="flex gap-1.5">
                <div
                  class="w-2 h-2 rounded-full bg-[rgb(var(--color-text-muted))] animate-pulse-soft"
                  style={{ "animation-delay": "0s" }}
                />
                <div
                  class="w-2 h-2 rounded-full bg-[rgb(var(--color-text-muted))] animate-pulse-soft"
                  style={{ "animation-delay": "0.3s" }}
                />
                <div
                  class="w-2 h-2 rounded-full bg-[rgb(var(--color-text-muted))] animate-pulse-soft"
                  style={{ "animation-delay": "0.6s" }}
                />
              </div>
            }
          >
            <div class="animate-slide-up">
              <Button
                onClick={() => navigate("/setup", { replace: true })}
                class="px-8 py-3 text-base"
              >
                {t("app_get_started")}
                <ArrowRight class="h-4 w-4" />
              </Button>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
