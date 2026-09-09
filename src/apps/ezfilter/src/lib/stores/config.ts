import { createSignal } from "solid-js";

const STORAGE_KEY = "ezfilter:config";
const API_VERSION = "v1";
const MANAGED_BASE = "https://ezfilter.joinez.co";

export type HostingMode = "managed" | "self-host";

export interface AppConfig {
  hostingMode: HostingMode;
  serverUrl: string;
  /** Discovered proxy URL (e.g. http://127.0.0.1:54321). Set during local
   *  setup so the system-proxy install can target the real ephemeral port
   *  instead of guessing :8080. */
  proxyUrl?: string;
  setupComplete: boolean;
}

function loadConfig(): AppConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as AppConfig;
  } catch {
    // ignore
  }
  return null;
}

function saveConfig(config: AppConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

const stored = loadConfig();

const [config, setConfigInternal] = createSignal<AppConfig | null>(stored);

export function getConfig() {
  return config();
}

export function isSetupComplete(): boolean {
  return config()?.setupComplete === true;
}

export function getApiBaseUrl(): string {
  const c = config();
  if (!c) return "";
  if (c.hostingMode === "managed") {
    return `${MANAGED_BASE}/api/${API_VERSION}`;
  }
  return c.serverUrl.replace(/\/+$/, "");
}

export function setConfig(update: Partial<AppConfig>) {
  const current = config() ?? {
    hostingMode: "managed" as HostingMode,
    serverUrl: "",
    setupComplete: false,
  };
  const next = { ...current, ...update };
  setConfigInternal(next);
  saveConfig(next);
}

export function clearConfig() {
  localStorage.removeItem(STORAGE_KEY);
  setConfigInternal(null);
}
