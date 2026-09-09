// Lightweight i18n module inspired by chrome.i18n.
//
// Usage:
//   import { t } from "../lib/i18n";
//   t("app_tagline")             // "your friendly content filter"
//   t("error_status", 404, "Not Found")  // "Server responded with 404 Not Found"
//
// Message format follows chrome.i18n conventions:
//   { "key": { "message": "Hello, $1!", "description": "A greeting" } }
//
// Substitutions use $1, $2, ... positional placeholders.
//
// Platform notes:
//   Locale files are statically imported (not fetched) so they work
//   in Tauri webviews on all platforms including Android and iOS.
//   To add a new locale: create src/lib/i18n/locales/<code>.ts,
//   export a Messages object, and register it in LOCALES below.

import { createSignal } from "solid-js";
import en from "./locales/en";

export interface MessageEntry {
  message: string;
  description?: string;
}

export type Messages = Record<string, MessageEntry>;

const LOCALES: Record<string, Messages> = { en };

const STORAGE_KEY = "ezfilter:locale";

function detectLocale(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && LOCALES[stored]) return stored;
  } catch {
    // ignore
  }
  const browser = navigator.language?.split("-")[0] ?? "en";
  return LOCALES[browser] ? browser : "en";
}

const [locale, setLocaleInternal] = createSignal(detectLocale());

export function getLocale(): string {
  return locale();
}

export function setLocale(loc: string) {
  const resolved = LOCALES[loc] ? loc : "en";
  setLocaleInternal(resolved);
  try {
    localStorage.setItem(STORAGE_KEY, resolved);
  } catch {
    // ignore
  }
}

export function getAvailableLocales(): string[] {
  return Object.keys(LOCALES);
}

/**
 * Translate a message key, substituting $1, $2, ... with positional args.
 * Returns the key itself if no translation is found (makes missing keys visible).
 */
export function t(key: string, ...substitutions: (string | number)[]): string {
  const msgs = LOCALES[locale()] ?? LOCALES.en;
  const entry = msgs[key];
  if (!entry) return key;
  let msg = entry.message;
  for (let i = 0; i < substitutions.length; i++) {
    msg = msg.replaceAll(`$${i + 1}`, String(substitutions[i]));
  }
  return msg;
}
