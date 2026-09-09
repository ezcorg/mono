import { createSignal, createEffect } from "solid-js";

export type Theme = "light" | "dark" | "auto";

const STORAGE_KEY = "ezfilter:theme";

function loadTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "auto") {
      return stored;
    }
  } catch {
    // ignore
  }
  return "auto";
}

function getSystemPreference(): "light" | "dark" {
  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

const [theme, setThemeInternal] = createSignal<Theme>(loadTheme());

export function getTheme() {
  return theme();
}

export function getResolvedTheme(): "light" | "dark" {
  const t = theme();
  return t === "auto" ? getSystemPreference() : t;
}

export function setTheme(t: Theme) {
  setThemeInternal(t);
  localStorage.setItem(STORAGE_KEY, t);
  applyTheme(t);
}

function applyTheme(t: Theme) {
  const resolved = t === "auto" ? getSystemPreference() : t;
  document.documentElement.setAttribute("data-theme", resolved);
  if (resolved === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

// Initialize theme on load
applyTheme(loadTheme());

// Listen for system preference changes when in auto mode
if (typeof window !== "undefined") {
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (theme() === "auto") {
        applyTheme("auto");
      }
    });
}
