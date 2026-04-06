// Types matching the witmproxy WIT world and REST API

// ── Input configuration types (from wit/world.wit) ──

export type InputType =
  | { kind: "str" }
  | { kind: "boolean" }
  | { kind: "number" }
  | { kind: "select"; options: string[] }
  | { kind: "datetime" }
  | { kind: "daterange" }
  | { kind: "file" }
  | { kind: "binary" };

export type ActualInput =
  | { kind: "str"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; value: number }
  | { kind: "select"; value: string }
  | { kind: "datetime"; value: string }
  | { kind: "daterange"; value: [string, string] }
  | { kind: "file"; value: FileInput }
  | { kind: "binary"; value: Uint8Array };

export interface FileInput {
  name: string;
  contentType?: string;
  data: Uint8Array;
}

export interface InputSchema {
  name: string;
  inputType: InputType;
  optional: boolean;
  default?: ActualInput;
  description?: string;
}

export interface UserInput {
  name: string;
  value: ActualInput;
}

// ── Plugin types ──

export type EventKind =
  | "connect"
  | "request"
  | "response"
  | "inbound-content"
  | "timer";

export type CapabilityKind =
  | { kind: "handle-event"; eventKind: EventKind }
  | { kind: "logger" }
  | { kind: "annotator" }
  | { kind: "local-storage" }
  | { kind: "clock" };

export interface CapabilityScope {
  expression: string;
}

export interface Capability {
  kind: CapabilityKind;
  scope: CapabilityScope;
}

export interface Tag {
  key: string;
  value: string;
}

export interface PluginManifest {
  name: string;
  namespace: string;
  author: string;
  version: string;
  description: string;
  license: string;
  url: string;
  capabilities: Capability[];
  metadata: Tag[];
  configuration: InputSchema[];
}

// ── API response types ──

export interface Tenant {
  id: string;
  email: string;
  displayName?: string;
  enabled: boolean;
}

export interface Group {
  id: string;
  name: string;
  description?: string;
}

export interface Permission {
  id: string;
  effect: "grant" | "deny";
  resource: string;
}

export interface IpMapping {
  ip: string;
  tenantId: string;
}

export interface AuthTokens {
  token: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
}
