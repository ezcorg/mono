import { createSignal } from "solid-js";

const TOKEN_KEY = "ezfilter:token";
const TENANT_KEY = "ezfilter:tenant_id";

function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function loadTenantId(): string | null {
  try {
    return localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
}

const [token, setTokenInternal] = createSignal<string | null>(loadToken());
const [tenantId, setTenantIdInternal] = createSignal<string | null>(loadTenantId());

export function getToken() {
  return token();
}

export function getTenantId() {
  return tenantId();
}

export function setToken(t: string | null) {
  setTokenInternal(t);
  if (t) {
    localStorage.setItem(TOKEN_KEY, t);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export function setTenantId(id: string | null) {
  setTenantIdInternal(id);
  if (id) {
    localStorage.setItem(TENANT_KEY, id);
  } else {
    localStorage.removeItem(TENANT_KEY);
  }
}

export function isAuthenticated(): boolean {
  return token() !== null;
}

export function logout() {
  setToken(null);
  setTenantId(null);
}
