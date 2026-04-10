import { createSignal } from "solid-js";
import { getApiBaseUrl } from "./config";

export type ConnectionStatus = "unknown" | "checking" | "connected" | "disconnected";

const [status, setStatusInternal] = createSignal<ConnectionStatus>("unknown");
const [statusMessage, setStatusMessageInternal] = createSignal("");

export function getConnectionStatus() {
  return status();
}

export function getConnectionMessage() {
  return statusMessage();
}

/** Derive the proxy URL from the configured server URL.
 *  The proxy typically runs on the same host as the web server. */
function getProxyUrl(): string {
  const base = getApiBaseUrl();
  if (!base) return "";
  try {
    const url = new URL(base);
    // Default witmproxy proxy port — the web server is HTTPS,
    // the proxy itself is plain HTTP on the same host.
    return `http://${url.hostname}:${url.port || "8080"}`;
  } catch {
    return base;
  }
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
      { proxyUrl },
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
