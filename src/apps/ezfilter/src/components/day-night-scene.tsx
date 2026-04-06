import { For, Show } from "solid-js";
import { getResolvedTheme } from "../lib/stores/theme";

export function DayNightScene() {
  const stars = Array.from({ length: 30 }, (_, i) => ({
    id: i,
    left: `${Math.random() * 100}%`,
    top: `${Math.random() * 60}%`,
    delay: `${Math.random() * 4}s`,
    size: `${1 + Math.random() * 2}px`,
  }));

  const clouds = [
    { left: "10%", top: "8%", w: "80px", h: "28px", delay: "0s" },
    { left: "55%", top: "15%", w: "100px", h: "32px", delay: "3s" },
    { left: "80%", top: "5%", w: "60px", h: "22px", delay: "7s" },
  ];

  return (
    <div class="pointer-events-none fixed inset-0 overflow-hidden z-0 transition-opacity duration-700">
      {/* Day elements */}
      <Show when={getResolvedTheme() === "light"}>
        {/* Sun glow */}
        <div
          class="absolute -top-20 -right-20 w-64 h-64 rounded-full animate-pulse-soft"
          style={{
            background:
              "radial-gradient(circle, rgba(250,204,21,0.3) 0%, rgba(250,204,21,0.05) 50%, transparent 70%)",
          }}
        />
        {/* Clouds */}
        <For each={clouds}>
          {(cloud) => (
            <div
              class="cloud animate-float"
              style={{
                left: cloud.left,
                top: cloud.top,
                width: cloud.w,
                height: cloud.h,
                "animation-delay": cloud.delay,
              }}
            />
          )}
        </For>
        {/* Ground glow */}
        <div
          class="absolute bottom-0 left-0 right-0 h-32"
          style={{
            background:
              "linear-gradient(0deg, rgba(134,239,172,0.15) 0%, transparent 100%)",
          }}
        />
      </Show>

      {/* Night elements */}
      <Show when={getResolvedTheme() === "dark"}>
        {/* Moon glow */}
        <div
          class="absolute -top-10 -right-10 w-48 h-48 rounded-full animate-pulse-soft"
          style={{
            background:
              "radial-gradient(circle, rgba(165,180,252,0.2) 0%, rgba(165,180,252,0.05) 40%, transparent 60%)",
          }}
        />
        {/* Moon */}
        <div
          class="absolute top-8 right-12 w-12 h-12 rounded-full"
          style={{
            background:
              "radial-gradient(circle at 35% 35%, #e0e7ff 0%, #a5b4fc 50%, #818cf8 100%)",
            "box-shadow": "0 0 40px rgba(165,180,252,0.3)",
          }}
        />
        {/* Stars */}
        <For each={stars}>
          {(star) => (
            <div
              class="star"
              style={{
                left: star.left,
                top: star.top,
                width: star.size,
                height: star.size,
                "animation-delay": star.delay,
              }}
            />
          )}
        </For>
        {/* Warm ground glow (campfire/ambient) */}
        <div
          class="absolute bottom-0 left-0 right-0 h-24"
          style={{
            background:
              "linear-gradient(0deg, rgba(251,146,60,0.08) 0%, transparent 100%)",
          }}
        />
      </Show>
    </div>
  );
}
