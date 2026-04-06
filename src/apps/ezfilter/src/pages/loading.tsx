import { onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { isSetupComplete } from "../lib/stores/config";
import { DayNightScene } from "../components/day-night-scene";
import { ThemeToggle } from "../components/theme-toggle";

export default function LoadingPage() {
  const navigate = useNavigate();

  onMount(() => {
    // After the splash animation, redirect based on setup state
    const timer = setTimeout(() => {
      if (isSetupComplete()) {
        navigate("/plugins", { replace: true });
      } else {
        navigate("/setup", { replace: true });
      }
    }, 2200);
    return () => clearTimeout(timer);
  });

  return (
    <div class="relative min-h-screen flex flex-col items-center justify-center overflow-hidden">
      <DayNightScene />

      {/* Theme toggle in corner */}
      <div class="absolute top-4 right-4 z-20">
        <ThemeToggle />
      </div>

      <div class="relative z-10 flex flex-col items-center gap-6 animate-fade-in">
        {/* Cloud character - inspired by the hand-drawn ezfilter SVG */}
        <div class="relative animate-float">
          {/* Main cloud body */}
          <div
            class="relative w-36 h-24 rounded-full"
            style={{
              background:
                "radial-gradient(ellipse at 50% 60%, white 0%, #e0f2fe 100%)",
              "box-shadow":
                "0 8px 32px rgba(14, 165, 233, 0.15), inset 0 -4px 12px rgba(186, 230, 253, 0.5)",
            }}
          >
            {/* Cloud bumps */}
            <div
              class="absolute -top-6 left-6 w-16 h-16 rounded-full"
              style={{
                background: "radial-gradient(ellipse, white 0%, #e0f2fe 100%)",
              }}
            />
            <div
              class="absolute -top-10 left-14 w-20 h-20 rounded-full"
              style={{
                background: "radial-gradient(ellipse, white 0%, #e0f2fe 100%)",
              }}
            />
            <div
              class="absolute -top-4 right-4 w-14 h-14 rounded-full"
              style={{
                background: "radial-gradient(ellipse, white 0%, #e0f2fe 100%)",
              }}
            />

            {/* Face */}
            <div class="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-5">
              {/* Left eye */}
              <div class="w-2.5 h-3 rounded-full bg-slate-700" />
              {/* Right eye */}
              <div class="w-2.5 h-3 rounded-full bg-slate-700" />
            </div>
            {/* Smile */}
            <div
              class="absolute bottom-2 left-1/2 -translate-x-1/2 w-6 h-3 rounded-b-full"
              style={{ "border-bottom": "2px solid #334155" }}
            />
          </div>

          {/* Musical notes floating around */}
          <div
            class="absolute -right-6 -top-8 text-2xl animate-float opacity-60"
            style={{ "animation-delay": "0.5s" }}
          >
            &#9835;
          </div>
          <div
            class="absolute -left-4 -top-4 text-lg animate-float opacity-40"
            style={{ "animation-delay": "1.5s" }}
          >
            &#9833;
          </div>
        </div>

        {/* App name */}
        <div class="text-center">
          <h1 class="text-5xl font-extrabold font-display tracking-tight">
            <span class="text-[rgb(var(--color-primary))]">ez</span>
            <span>filter</span>
          </h1>
          <p class="mt-2 text-sm text-[rgb(var(--color-text-muted))] font-display font-medium">
            your friendly content filter
          </p>
        </div>

        {/* Loading dots */}
        <div class="flex gap-1.5 mt-4">
          <div
            class="w-2.5 h-2.5 rounded-full bg-[rgb(var(--color-primary))] animate-pulse-soft"
            style={{ "animation-delay": "0s" }}
          />
          <div
            class="w-2.5 h-2.5 rounded-full bg-[rgb(var(--color-primary))] animate-pulse-soft"
            style={{ "animation-delay": "0.3s" }}
          />
          <div
            class="w-2.5 h-2.5 rounded-full bg-[rgb(var(--color-primary))] animate-pulse-soft"
            style={{ "animation-delay": "0.6s" }}
          />
        </div>
      </div>
    </div>
  );
}
