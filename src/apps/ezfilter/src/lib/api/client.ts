// HTTP client for the witmproxy management API.
// Keeps all server communication logic separate from UI concerns.

import type {
  AuthTokens,
  LoginRequest,
  RegisterRequest,
  Tenant,
  Group,
  Permission,
  IpMapping,
  UserInput,
} from "./types";

export class WitmproxyClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  setToken(token: string | null) {
    this.token = token;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async request<T>(
    path: string,
    init?: RequestInit
  ): Promise<T> {
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string>),
    };

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    if (
      init?.body &&
      typeof init.body === "string" &&
      !headers["Content-Type"]
    ) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new ApiError(res.status, text);
    }

    const contentType = res.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      return res.json() as Promise<T>;
    }
    return res.text() as unknown as T;
  }

  // ── Health ──

  async health(): Promise<boolean> {
    try {
      await this.request<string>("/api/health");
      return true;
    } catch {
      return false;
    }
  }

  // ── Auth ──

  async register(data: RegisterRequest): Promise<AuthTokens> {
    return this.request<AuthTokens>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async login(data: LoginRequest): Promise<AuthTokens> {
    return this.request<AuthTokens>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // ── Plugins ──

  async listPlugins(): Promise<string[]> {
    return this.request<string[]>("/api/plugins");
  }

  async uploadPlugin(
    wasmBytes: Uint8Array,
    expectedPublicKey?: string
  ): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([wasmBytes]), "plugin.wasm");

    const headers: Record<string, string> = {};
    if (expectedPublicKey) {
      headers["X-Expected-Public-Key"] = expectedPublicKey;
    }

    return this.request<string>("/api/plugins", {
      method: "POST",
      body: form,
      headers,
    });
  }

  async deletePlugin(namespace: string, name: string): Promise<string> {
    return this.request<string>(
      `/api/plugins/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
      { method: "DELETE" }
    );
  }

  // ── Tenants ──

  async listTenants(): Promise<Tenant[]> {
    return this.request<Tenant[]>("/api/manage/tenants");
  }

  async getTenant(id: string): Promise<Tenant> {
    return this.request<Tenant>(`/api/manage/tenants/${encodeURIComponent(id)}`);
  }

  async updateTenant(
    id: string,
    data: { displayName?: string; enabled?: boolean }
  ): Promise<string> {
    return this.request<string>(
      `/api/manage/tenants/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(data) }
    );
  }

  async deleteTenant(id: string): Promise<string> {
    return this.request<string>(
      `/api/manage/tenants/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
  }

  // ── Tenant plugin config ──

  async setPluginEnabled(
    tenantId: string,
    ns: string,
    name: string,
    enabled: boolean
  ): Promise<string> {
    return this.request<string>(
      `/api/manage/tenants/${encodeURIComponent(tenantId)}/plugins/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/enabled`,
      { method: "PUT", body: JSON.stringify({ enabled }) }
    );
  }

  async setPluginConfig(
    tenantId: string,
    ns: string,
    name: string,
    config: UserInput[]
  ): Promise<string> {
    return this.request<string>(
      `/api/manage/tenants/${encodeURIComponent(tenantId)}/plugins/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/config`,
      { method: "PUT", body: JSON.stringify(config) }
    );
  }

  // ── Tenant IP mappings ──

  async listIpMappings(tenantId: string): Promise<IpMapping[]> {
    return this.request<IpMapping[]>(
      `/api/manage/tenants/${encodeURIComponent(tenantId)}/ip-mappings`
    );
  }

  async addIpMapping(tenantId: string, ip: string): Promise<string> {
    return this.request<string>(
      `/api/manage/tenants/${encodeURIComponent(tenantId)}/ip-mappings`,
      { method: "POST", body: JSON.stringify({ ip }) }
    );
  }

  async removeIpMapping(tenantId: string, ip: string): Promise<string> {
    return this.request<string>(
      `/api/manage/tenants/${encodeURIComponent(tenantId)}/ip-mappings`,
      { method: "DELETE", body: JSON.stringify({ ip }) }
    );
  }

  // ── Groups ──

  async listGroups(): Promise<Group[]> {
    return this.request<Group[]>("/api/manage/groups");
  }

  async createGroup(name: string, description?: string): Promise<string> {
    return this.request<string>("/api/manage/groups", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    });
  }

  async deleteGroup(id: string): Promise<string> {
    return this.request<string>(
      `/api/manage/groups/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
  }

  // ── Group members ──

  async addGroupMember(groupId: string, tenantId: string): Promise<string> {
    return this.request<string>(
      `/api/manage/groups/${encodeURIComponent(groupId)}/members`,
      { method: "POST", body: JSON.stringify({ tenant_id: tenantId }) }
    );
  }

  async removeGroupMember(groupId: string, tenantId: string): Promise<string> {
    return this.request<string>(
      `/api/manage/groups/${encodeURIComponent(groupId)}/members`,
      { method: "DELETE", body: JSON.stringify({ tenant_id: tenantId }) }
    );
  }

  // ── Group permissions ──

  async addGroupPermission(
    groupId: string,
    effect: "grant" | "deny",
    resource: string
  ): Promise<string> {
    return this.request<string>(
      `/api/manage/groups/${encodeURIComponent(groupId)}/permissions`,
      { method: "POST", body: JSON.stringify({ effect, resource }) }
    );
  }

  async removeGroupPermission(
    groupId: string,
    permissionId: string
  ): Promise<string> {
    return this.request<string>(
      `/api/manage/groups/${encodeURIComponent(groupId)}/permissions/${encodeURIComponent(permissionId)}`,
      { method: "DELETE" }
    );
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string
  ) {
    super(`API ${status}: ${body}`);
    this.name = "ApiError";
  }
}
