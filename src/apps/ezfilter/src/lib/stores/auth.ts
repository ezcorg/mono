import { createSignal } from "solid-js";

const TOKEN_KEY = "ezfilter:token";
const TENANT_KEY = "ezfilter:tenant_id";
const EMAIL_KEY = "ezfilter:email";

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

const [token, setTokenInternal] = createSignal<string | null>(load(TOKEN_KEY));
const [tenantId, setTenantIdInternal] = createSignal<string | null>(load(TENANT_KEY));
const [email, setEmailInternal] = createSignal<string | null>(load(EMAIL_KEY));

export function getToken() {
  return token();
}

export function getTenantId() {
  return tenantId();
}

export function getEmail() {
  return email();
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

export function setEmail(e: string | null) {
  setEmailInternal(e);
  if (e) {
    localStorage.setItem(EMAIL_KEY, e);
  } else {
    localStorage.removeItem(EMAIL_KEY);
  }
}

export function isAuthenticated(): boolean {
  return token() !== null;
}

export function logout() {
  setToken(null);
  setTenantId(null);
  setEmail(null);
}
