// v1 wire protocol — mirror of daemon/src/protocol.rs.
//
// Control messages are JSON text frames; byte-streams are binary frames
// prefixed with a 4-byte big-endian channel id.

export interface TerminalRequest {
  jailed: boolean;
  shell?: string;
  cols: number;
  rows: number;
}

/** `icanhaz:nocap/types.capability-kind` (internally tagged, flattened). */
export type CapabilityKind = { kind: "terminal" } & TerminalRequest;

export type ClientMsg =
  | { t: "hello"; pin: string }
  | { t: "request"; id: number; want: CapabilityKind; reason: string }
  | { t: "claim"; id: number; grant: number }
  | { t: "resize"; terminal: number; cols: number; rows: number }
  | { t: "signal"; terminal: number; signal: string }
  | { t: "close"; terminal: number };

export type ServerMsg =
  | { t: "hello-ok" }
  | { t: "granted"; id: number; grant: number; summary: string }
  | { t: "claimed"; id: number; terminal: number; in_channel: number; out_channel: number }
  | { t: "denied"; id?: number; reason: string }
  | { t: "exit"; terminal: number; code: number }
  | { t: "error"; id?: number; message: string };
