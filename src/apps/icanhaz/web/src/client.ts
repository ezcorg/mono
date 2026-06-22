import type { CapabilityKind, ClientMsg, ServerMsg, TerminalRequest } from "./protocol";

export interface TerminalHandle {
  /** Raw PTY output (daemon→browser). Early output is buffered until you subscribe. */
  onOutput(cb: (bytes: Uint8Array) => void): void;
  /** Send keystrokes (browser→daemon). */
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  signal(sig: string): void;
  onExit(cb: (code: number) => void): void;
  close(): void;
}

export interface ConnectOptions {
  /** ws(s) URL of an icanhazd — e.g. `wss://mac.<tailnet>.ts.net/` or `ws://127.0.0.1:7777`. */
  url: string;
  /** The PIN icanhazd printed on start (your consent). */
  pin: string;
  request?: Partial<TerminalRequest>;
}

type Pending = { resolve: (m: ServerMsg) => void; reject: (e: Error) => void };

/**
 * A live NoCap session over the multiplexed RPC (one WebSocket): invocations are
 * correlated by id, byte-streams ride indexed binary channels, multiple
 * terminals can run over a single connection. This is the `Runtime` backend the
 * markdown-editor codeblock consumes — see `openTerminal()` for the one-call entry.
 *
 * The wire is modelled on wRPC (invocation + indexed sub-streams + resource
 * handles); a wire-compatible wRPC transport would replace the codec here, not
 * this surface.
 */
export class Session {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly channels = new Map<number, (b: Uint8Array) => void>();
  private readonly exits = new Map<number, (code: number) => void>();

  private constructor(private readonly ws: WebSocket) {}

  static connect(url: string, pin: string): Promise<Session> {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const session = new Session(ws);
    return new Promise<Session>((resolve, reject) => {
      let ready = false;
      ws.onopen = () => session.sendMsg({ t: "hello", pin });
      ws.onerror = () => {
        if (!ready) reject(new Error("websocket error"));
      };
      ws.onclose = () => session.handleClose();
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") {
          if (ready) session.handleBinary(new Uint8Array(ev.data as ArrayBuffer));
          return;
        }
        const msg = JSON.parse(ev.data) as ServerMsg;
        if (!ready) {
          if (msg.t === "hello-ok") {
            ready = true;
            resolve(session);
          } else if (msg.t === "denied") {
            reject(new Error(`denied: ${msg.reason}`));
            ws.close();
          } else {
            reject(new Error("unexpected handshake"));
            ws.close();
          }
          return;
        }
        session.handleServer(msg);
      };
    });
  }

  close(): void {
    this.ws.close();
  }

  /** NoCap `session.request` for a terminal, then `claim` it into a live PTY. */
  async requestTerminal(
    req: Partial<TerminalRequest> = {},
    reason = "open a terminal",
  ): Promise<TerminalHandle> {
    const want: CapabilityKind = {
      kind: "terminal",
      jailed: req.jailed ?? false,
      shell: req.shell,
      cols: req.cols ?? 80,
      rows: req.rows ?? 24,
    };
    const granted = await this.invoke((id) => ({ t: "request", id, want, reason }));
    if (granted.t !== "granted") {
      throw new Error(granted.t === "denied" ? `denied: ${granted.reason}` : "unexpected reply to request");
    }
    const claimed = await this.invoke((id) => ({ t: "claim", id, grant: granted.grant }));
    if (claimed.t !== "claimed") {
      throw new Error(
        claimed.t === "denied"
          ? `denied: ${claimed.reason}`
          : claimed.t === "error"
            ? claimed.message
            : "unexpected reply to claim",
      );
    }
    return this.makeTerminal(claimed.terminal, claimed.in_channel, claimed.out_channel);
  }

  // ── internals ──────────────────────────────────────────────
  private sendMsg(m: ClientMsg): void {
    this.ws.send(JSON.stringify(m));
  }

  private sendBinary(channel: number, data: Uint8Array): void {
    const buf = new Uint8Array(4 + data.length);
    new DataView(buf.buffer).setUint32(0, channel, false);
    buf.set(data, 4);
    this.ws.send(buf);
  }

  private invoke(build: (id: number) => ClientMsg): Promise<ServerMsg> {
    const id = this.nextId++;
    return new Promise<ServerMsg>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendMsg(build(id));
    });
  }

  private settle(id: number, msg: ServerMsg): void {
    const p = this.pending.get(id);
    if (p) {
      this.pending.delete(id);
      p.resolve(msg);
    }
  }

  private handleServer(msg: ServerMsg): void {
    switch (msg.t) {
      case "granted":
      case "claimed":
        this.settle(msg.id, msg);
        break;
      case "denied":
      case "error":
        if (msg.id !== undefined) this.settle(msg.id, msg);
        else console.error("icanhaz:", msg.t === "error" ? msg.message : msg.reason);
        break;
      case "exit":
        this.exits.get(msg.terminal)?.(msg.code);
        break;
    }
  }

  private handleBinary(data: Uint8Array): void {
    if (data.length < 4) return;
    const channel = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, false);
    this.channels.get(channel)?.(data.subarray(4));
  }

  private handleClose(): void {
    for (const p of this.pending.values()) p.reject(new Error("connection closed"));
    this.pending.clear();
    for (const cb of this.exits.values()) cb(-1);
  }

  private makeTerminal(id: number, inChannel: number, outChannel: number): TerminalHandle {
    let outputCb: ((b: Uint8Array) => void) | null = null;
    const buffered: Uint8Array[] = [];
    this.channels.set(outChannel, (b) => {
      if (outputCb) outputCb(b);
      else buffered.push(b);
    });
    return {
      onOutput: (cb) => {
        outputCb = cb;
        for (const chunk of buffered.splice(0)) cb(chunk);
      },
      write: (data) =>
        this.sendBinary(inChannel, typeof data === "string" ? new TextEncoder().encode(data) : data),
      resize: (cols, rows) => this.sendMsg({ t: "resize", terminal: id, cols, rows }),
      signal: (sig) => this.sendMsg({ t: "signal", terminal: id, signal: sig }),
      onExit: (cb) => {
        this.exits.set(id, cb);
      },
      close: () => {
        this.sendMsg({ t: "close", terminal: id });
        this.channels.delete(outChannel);
      },
    };
  }
}

/** Convenience: connect, then request + claim a terminal in one call. */
export async function openTerminal(opts: ConnectOptions): Promise<TerminalHandle> {
  const session = await Session.connect(opts.url, opts.pin);
  return session.requestTerminal(opts.request);
}
