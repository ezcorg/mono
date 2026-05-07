import { createSignal } from "solid-js";

export type AnimationPref = "enabled" | "disabled" | "auto";

const STORAGE_KEY = "ezfilter:animations";

function loadPref(): AnimationPref {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "enabled" || stored === "disabled") return stored;
  } catch {
    // ignore
  }
  return "auto";
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

const [pref, setPrefInternal] = createSignal<AnimationPref>(loadPref());

export function getAnimationPref(): AnimationPref {
  return pref();
}

export function areAnimationsEnabled(): boolean {
  const p = pref();
  if (p === "auto") return !prefersReducedMotion();
  return p === "enabled";
}

export function setAnimationPref(p: AnimationPref) {
  setPrefInternal(p);
  if (p === "auto") {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, p);
  }
  applyAnimations(p);
}

function applyAnimations(p: AnimationPref) {
  const enabled = p === "auto" ? !prefersReducedMotion() : p === "enabled";
  document.documentElement.setAttribute(
    "data-animations",
    enabled ? "enabled" : "disabled"
  );
}

// Initialize on load
applyAnimations(loadPref());

// Re-evaluate when system preference changes (for "auto" mode)
if (typeof window !== "undefined") {
  window
    .matchMedia("(prefers-reduced-motion: reduce)")
    .addEventListener("change", () => {
      if (pref() === "auto") {
        applyAnimations("auto");
      }
    });
}
