import { createSignal } from "solid-js";

const STORAGE_KEY = "ezfilter:devmode";

const storedValue = localStorage.getItem(STORAGE_KEY);
const defaultEnabled = storedValue !== null ? storedValue === "true" : import.meta.env.DEV;

const [enabled, setEnabledInternal] = createSignal<boolean>(defaultEnabled);

export function isDevMode() {
  return enabled();
}

export function setDevMode(on: boolean) {
  setEnabledInternal(on);
  if (on) {
    localStorage.setItem(STORAGE_KEY, "true");
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

export function clearAllAppState() {
  localStorage.clear();
  // Navigate to root so the app re-enters the onboarding flow
  window.location.href = "/";
}
