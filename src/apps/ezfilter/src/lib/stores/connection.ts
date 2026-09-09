import { createSignal } from "solid-js";
import { getApiBaseUrl, getConfig } from "./config";

export type ConnectionStatus = "unknown" | "checking" | "connected" | "disconnected";

const [status, setStatusInternal] = createSignal<ConnectionStatus>("unknown");
const [statusMessage, setStatusMessageInternal] = createSignal("");

export function getConnectionStatus() {
  return status();
}

export function getConnectionMessage() {
  return statusMessage();
}

/** Derive the proxy URL. Prefer the discovered URL persisted in config —
 *  it points at the real ephemeral port the proxy bound to. Fall back to
 *  the host:8080 heuristic only when nothing was discovered (e.g. the user
 *  is connecting to a remote server they set up themselves). */
function getProxyUrl(): string {
  const discovered = getConfig()?.proxyUrl;
  if (discovered) return discovered;

  const base = getApiBaseUrl();
  if (!base) return "";
  try {
    const url = new URL(base);
    return `http://${url.hostname}:8080`;
  } catch {
    return base;
  }
}

/** Hosts that should bypass the system proxy when it is enabled. The list
 *  always includes loopback and ".local"; the configured server URL's host
 *  is added so the management UI can be reached without going through the
 *  proxy (which would otherwise loop or hit a closed port). */
function getBypassHosts(): string[] {
  const hosts = new Set<string>(["localhost", "127.0.0.1", "::1", "*.local"]);
  const base = getApiBaseUrl();
  if (base) {
    try {
      const u = new URL(base);
      if (u.hostname) hosts.add(u.hostname);
    } catch {
      // ignore
    }
  }
  return Array.from(hosts);
}

/** Check the current proxy status via Tauri command. */
export async function checkProxyStatus() {
  setStatusInternal("checking");
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<{ success: boolean; already_done: boolean; message: string }>(
      "check_proxy_status",
    );
    setStatusInternal(result.success ? "connected" : "disconnected");
    setStatusMessageInternal(result.message);
  } catch {
    // Not running in Tauri (browser) — can't manage system proxy
    setStatusInternal("unknown");
    setStatusMessageInternal("");
  }
}

/** Enable the system proxy (connect traffic through witmproxy). */
export async function connectProxy(): Promise<boolean> {
  setStatusInternal("checking");
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const proxyUrl = getProxyUrl();
    if (!proxyUrl) {
      setStatusInternal("disconnected");
      setStatusMessageInternal("No server URL configured");
      return false;
    }
    const result = await invoke<{ success: boolean; already_done: boolean; message: string }>(
      "enable_proxy",
      { proxyUrl, bypassHosts: getBypassHosts() },
    );
    setStatusInternal(result.success || result.already_done ? "connected" : "disconnected");
    setStatusMessageInternal(result.message);
    return result.success || result.already_done;
  } catch (e: any) {
    setStatusInternal("disconnected");
    setStatusMessageInternal(e?.message ?? "Failed to connect");
    return false;
  }
}

/** Disable the system proxy (restore normal networking). */
export async function disconnectProxy(): Promise<boolean> {
  setStatusInternal("checking");
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<{ success: boolean; already_done: boolean; message: string }>(
      "disable_proxy",
    );
    setStatusInternal(result.success || result.already_done ? "disconnected" : "connected");
    setStatusMessageInternal(result.message);
    return result.success || result.already_done;
  } catch (e: any) {
    setStatusInternal("connected");
    setStatusMessageInternal(e?.message ?? "Failed to disconnect");
    return false;
  }
}
