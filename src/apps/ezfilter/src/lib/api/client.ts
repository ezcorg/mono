// Witmproxy API client.
//
// Uses the generated client instance from the OpenAPI SDK for configuration,
// and provides typed wrappers for the endpoints used by the UI.
//
// To regenerate after updating the witmproxy server:
//   1. Start witmproxy:  witm run --auth-enabled --auth-jwt-secret dev
//   2. Extract spec:     witm openapi --output api/generated/openapi.json
//   3. Generate client:  pnpm generate:api

import { client as generatedClient } from "./generated/client.gen";

export { generatedClient };

/** Configure the generated client with a base URL and optional auth token. */
export function configureClient(baseUrl: string, token?: string | null) {
  generatedClient.setConfig({ baseUrl: baseUrl.replace(/\/+$/, "") });

  if (token) {
    generatedClient.interceptors.request.use((req) => {
      req.headers.set("Authorization", `Bearer ${token}`);
      return req;
    });
  }
}

// ── Typed API helpers ──
// These wrap direct fetch calls with proper return types.
// Once the OpenAPI spec includes response schemas, these can be replaced
// by the generated SDK functions (re-exported from ./generated).

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string
  ) {
    super(`API ${status}: ${body}`);
    this.name = "ApiError";
  }
}

async function request<T>(
  baseUrl: string,
  path: string,
  token?: string | null,
  init?: RequestInit
): Promise<T> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string>),
  };

  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (init?.body && typeof init.body === "string" && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    ...init,
    headers,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new ApiError(res.status, text);
  }

  const ct = res.headers.get("Content-Type") ?? "";
  if (ct.includes("application/json")) return res.json() as Promise<T>;
  return res.text() as unknown as T;
}

export const api = {
  health: (baseUrl: string) =>
    request<string>(baseUrl, "/api/health")
      .then(() => true)
      .catch(() => false),

  login: (baseUrl: string, body: { email: string; password: string }) =>
    request<{ token: string; tenant_id: string }>(
      baseUrl,
      "/api/auth/login",
      null,
      { method: "POST", body: JSON.stringify(body) }
    ),

  register: (
    baseUrl: string,
    body: { email: string; password: string; display_name: string }
  ) =>
    request<{ token: string; tenant_id: string }>(
      baseUrl,
      "/api/auth/register",
      null,
      { method: "POST", body: JSON.stringify(body) }
    ),

  listPlugins: (baseUrl: string, token: string) =>
    request<PluginSummary[]>(baseUrl, "/api/plugins", token),

  deletePlugin: (
    baseUrl: string,
    token: string,
    ns: string,
    name: string
  ) =>
    request<string>(
      baseUrl,
      `/api/plugins/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`,
      token,
      { method: "DELETE" }
    ),

  setPluginEnabled: (baseUrl: string, token: string, tenantId: string, ns: string, name: string, enabled: boolean) =>
    request<string>(
      baseUrl,
      `/api/manage/tenants/${encodeURIComponent(tenantId)}/plugins/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/enabled`,
      token,
      { method: "PUT", body: JSON.stringify({ enabled }) }
    ),

  setPluginConfig: (baseUrl: string, token: string, tenantId: string, ns: string, name: string, config: Record<string, string>) =>
    request<string>(
      baseUrl,
      `/api/manage/tenants/${encodeURIComponent(tenantId)}/plugins/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/config`,
      token,
      { method: "PUT", body: JSON.stringify({ config }) }
    ),

  uploadPlugin: (baseUrl: string, token: string, wasmBytes: Uint8Array, fileName: string) => {
    const form = new FormData();
    form.append("file", new Blob([wasmBytes]), fileName);
    return request<string>(baseUrl, "/api/plugins", token, {
      method: "POST",
      body: form,
    });
  },

  getConfig: (baseUrl: string, token: string) =>
    request<RuntimeConfig>(baseUrl, "/api/manage/config", token),

  updateConfig: (baseUrl: string, token: string, config: RuntimeConfig) =>
    request<RuntimeConfig>(baseUrl, "/api/manage/config", token, {
      method: "PUT",
      body: JSON.stringify(config),
    }),
};

export interface PluginSummary {
  namespace: string;
  name: string;
  version: string;
  author: string;
  description: string;
  license: string;
  url: string;
  enabled: boolean;
  capabilities: { kind: string; scope: string; granted: boolean }[];
}

export interface RuntimeConfig {
  plugins_enabled: boolean;
  plugins_timeout_ms: number;
  plugins_max_memory_mb: number;
  plugins_max_fuel: number;
  auto_update: boolean;
  transparent_enabled: boolean;
}
