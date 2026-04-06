import { createSignal } from "solid-js";

const TOKEN_KEY = "ezfilter:token";

function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

const [token, setTokenInternal] = createSignal<string | null>(loadToken());

export function getToken() {
  return token();
}

export function setToken(t: string | null) {
  setTokenInternal(t);
  if (t) {
    localStorage.setItem(TOKEN_KEY, t);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export function isAuthenticated(): boolean {
  return token() !== null;
}

export function logout() {
  setToken(null);
}
