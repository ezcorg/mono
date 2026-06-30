/**
 * Minimal wRPC client for *simple* functions (string / list<u8> / result; no
 * resources or streams), over either transport the browser offers:
 *
 *   - **WebTransport** (HTTP/3 / QUIC) — primary; one QUIC bidi stream per
 *     invocation, EOF = stream FIN.
 *   - **WebSocket** — fallback (older iOS, etc.); one connection per invocation,
 *     EOF = an empty-text frame.
 *
 * Both speak the *identical* wRPC frame codec (`wrpc_transport::frame`, the same
 * one `wrpc-websockets` and `wrpc-webtransport` use) — they differ only in how a
 * duplex stream is obtained and how EOF is signalled. So all the encoding below
 * is shared; only the `Transport.exchange` adapters differ. The same code runs
 * in the browser and in Node ≥22 (which has `WebSocket` but not `WebTransport`,
 * so `connect()` falls back there automatically).
 *
 *   request frame : [0x00 PROTOCOL][instance: name][func: name][0x00 paths][len][params]
 *   response frame: [0x00 paths][len][disc][payload]
 *   name/string = LEB128+UTF-8 · list<u8> = LEB128+raw · result = 0x00 ok / 0x01 err
 */

const PROTOCOL = 0x00;

// ---- codec (shared by both transports) -------------------------------------

// Unsigned LEB128. BigInt internally so it's correct for the full u64 range (the
// old number-based version capped at 32 bits and silently corrupted larger
// values). `readLeb128` narrows to a JS number — fine for lengths/discriminants
// and ≤32-bit ints — while `readLeb128Big` keeps the bigint for u64.
export function leb128(n: number | bigint): number[] {
    let v = BigInt(n);
    if (v < 0n) throw new RangeError(`leb128 expects a non-negative integer, got ${v}`);
    const out: number[] = [];
    do {
        let byte = Number(v & 0x7fn);
        v >>= 7n;
        if (v !== 0n) byte |= 0x80;
        out.push(byte);
    } while (v !== 0n);
    return out;
}
export function readLeb128Big(b: Uint8Array, o: number): [bigint, number] {
    let result = 0n;
    let shift = 0n;
    let p = o;
    let byte: number;
    do {
        byte = b[p++]!;
        result |= BigInt(byte & 0x7f) << shift;
        shift += 7n;
    } while (byte & 0x80);
    return [result, p];
}
export function readLeb128(b: Uint8Array, o: number): [number, number] {
    const [v, p] = readLeb128Big(b, o);
    return [Number(v), p];
}

const TE = new TextEncoder();
const TD = new TextDecoder();

export function encodeString(s: string): number[] {
    const u = TE.encode(s);
    return [...leb128(u.length), ...u];
}
export function encodeBytes(b: Uint8Array): number[] {
    return [...leb128(b.length), ...b];
}
export function readString(b: Uint8Array, o: number): [string, number] {
    const [len, p] = readLeb128(b, o);
    return [TD.decode(b.subarray(p, p + len)), p + len];
}
export function readBytes(b: Uint8Array, o: number): [Uint8Array, number] {
    const [len, p] = readLeb128(b, o);
    return [b.subarray(p, p + len), p + len];
}

// ---- additional primitive codecs (for generated bindings) ------------------
// Wire format per wrpc-transport `value.rs`: bool/u8/s8 = one raw byte; u16..u64
// = unsigned LEB128; s16..s64 = signed LEB128; char = raw UTF-8 (NOT a LEB128
// code point); f32/f64 = fixed little-endian; flags = ceil(n/8) little-endian
// bytes (emitted inline by the generator).

export function readBool(b: Uint8Array, o: number): [boolean, number] {
    return [b[o] !== 0, o + 1];
}
export function readU8(b: Uint8Array, o: number): [number, number] {
    return [b[o]!, o + 1];
}
export function readS8(b: Uint8Array, o: number): [number, number] {
    const v = b[o]!;
    return [v >= 0x80 ? v - 0x100 : v, o + 1];
}
// `char` is one UTF-8 scalar value, unprefixed; the lead byte gives its length.
export function encChar(s: string): number[] {
    return [...TE.encode(s)];
}
export function readChar(b: Uint8Array, o: number): [string, number] {
    const lead = b[o]!;
    const len = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    return [TD.decode(b.subarray(o, o + len)), o + len];
}
export function sleb128(n: number | bigint): number[] {
    let v = BigInt(n);
    const out: number[] = [];
    for (;;) {
        const byte = Number(v & 0x7fn);
        v >>= 7n; // BigInt `>>` is arithmetic (sign-extending)
        const signBit = byte & 0x40;
        if ((v === 0n && !signBit) || (v === -1n && signBit)) {
            out.push(byte);
            return out;
        }
        out.push(byte | 0x80);
    }
}
export function readSleb128Big(b: Uint8Array, o: number): [bigint, number] {
    let result = 0n;
    let shift = 0n;
    let p = o;
    let byte: number;
    do {
        byte = b[p++]!;
        result |= BigInt(byte & 0x7f) << shift;
        shift += 7n;
    } while (byte & 0x80);
    if (byte & 0x40) result |= -1n << shift; // sign-extend
    return [result, p];
}
export function readSleb128(b: Uint8Array, o: number): [number, number] {
    const [v, p] = readSleb128Big(b, o);
    return [Number(v), p];
}
export function encF32(v: number): number[] {
    const a = new Uint8Array(4);
    new DataView(a.buffer).setFloat32(0, v, true);
    return [...a];
}
export function readF32(b: Uint8Array, o: number): [number, number] {
    return [new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, true), o + 4];
}
export function encF64(v: number): number[] {
    const a = new Uint8Array(8);
    new DataView(a.buffer).setFloat64(0, v, true);
    return [...a];
}
export function readF64(b: Uint8Array, o: number): [number, number] {
    return [new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0, true), o + 8];
}

export type Result<T> = { ok: T } | { err: string };

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}

/** Build the wRPC request frame for `instance.func(params)`. */
function requestFrame(instance: string, func: string, params: number[]): Uint8Array {
    return new Uint8Array([
        PROTOCOL,
        ...encodeString(instance),
        ...encodeString(func),
        0x00, // no async-subscription paths
        ...encodeBytes(new Uint8Array(params)),
    ]);
}

/** Unwrap a response frame `[0x00 paths][len][result-value]` → the result value. */
export function resultValue(resp: Uint8Array): Uint8Array {
    const [rv] = readBytes(resp, 1); // skip the paths byte; read the length-prefixed value
    return rv;
}
function decodeResult<T>(resp: Uint8Array, decodeOk: (b: Uint8Array, o: number) => [T, number]): Result<T> {
    const rv = resultValue(resp); // [disc][payload]
    if (rv[0] === 0) {
        const [ok] = decodeOk(rv, 1);
        return { ok };
    }
    const [err] = readString(rv, 1);
    return { err };
}
export function readList<T>(b: Uint8Array, o: number, readItem: (b: Uint8Array, o: number) => [T, number]): [T[], number] {
    const [len, p0] = readLeb128(b, o);
    let p = p0;
    const out: T[] = [];
    for (let i = 0; i < len; i++) {
        const [v, np] = readItem(b, p);
        out.push(v);
        p = np;
    }
    return [out, p];
}

// ---- transports ------------------------------------------------------------

/** One invocation: send the request `frame` (+EOF), resolve the full response bytes. */
export interface Transport {
    readonly kind: "webtransport" | "websocket";
    exchange(frame: Uint8Array): Promise<Uint8Array>;
    /** Open a persistent duplex byte channel for a streaming invocation. */
    openDuplex(): Promise<Duplex>;
    close(): void;
}

/** A persistent bidirectional byte channel for one streaming invocation — a
 *  WebSocket connection or a WebTransport bidi stream. */
export interface Duplex {
    write(bytes: Uint8Array): void;
    onBytes(cb: (bytes: Uint8Array) => void): void;
    onClose(cb: () => void): void;
    /** Half-close our write side (the wRPC end-of-input signal). */
    closeWrite(): void;
    close(): void;
}

/** WebSocket fallback — a fresh connection per invocation; EOF = empty text frame. */
export class WebSocketTransport implements Transport {
    readonly kind = "websocket";
    private readonly url: string;

    constructor(url: string) {
        this.url = url;
    }

    exchange(frame: Uint8Array): Promise<Uint8Array> {
        const url = this.url;
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            ws.binaryType = "arraybuffer";
            let resp = new Uint8Array(0);
            let done = false;
            const finish = (fn: () => void) => {
                if (done) return;
                done = true;
                fn();
                try { ws.close(); } catch { /* ignore */ }
            };
            ws.addEventListener("open", () => {
                ws.send(frame);
                ws.send(""); // EOF sentinel (empty text frame)
            });
            ws.addEventListener("message", (e: MessageEvent) => {
                if (typeof e.data === "string") {
                    if (e.data === "") finish(() => resolve(resp));
                    else finish(() => reject(new Error("unexpected non-empty text frame")));
                    return;
                }
                resp = concat(resp, new Uint8Array(e.data as ArrayBuffer));
            });
            ws.addEventListener("error", () => finish(() => reject(new Error("WebSocket error"))));
            ws.addEventListener("close", () =>
                finish(() => (resp.length ? resolve(resp) : reject(new Error("closed before response")))),
            );
        });
    }

    async openDuplex(): Promise<Duplex> {
        return WsDuplex.connect(this.url);
    }

    close(): void {
        /* per-invocation connections; nothing is held open */
    }
}

/** WebTransport (QUIC) — one session, a bidi stream per invocation; EOF = stream FIN. */
export class WebTransportTransport implements Transport {
    readonly kind = "webtransport";
    private readonly wt: WebTransport;

    private constructor(wt: WebTransport) {
        this.wt = wt;
    }

    /** Open a session. `certHashes` pins a self-signed dev cert (sha-256 of the DER). */
    static async connect(url: string, certHashes?: Uint8Array[]): Promise<WebTransportTransport> {
        const opts =
            certHashes && certHashes.length
                ? { serverCertificateHashes: certHashes.map((h) => ({ algorithm: "sha-256", value: new Uint8Array(h) })) }
                : undefined;
        const wt = new WebTransport(url, opts);
        await wt.ready;
        return new WebTransportTransport(wt);
    }

    async exchange(frame: Uint8Array): Promise<Uint8Array> {
        const stream = await this.wt.createBidirectionalStream();
        const writer = stream.writable.getWriter();
        await writer.write(frame);
        await writer.close(); // FIN = end of request
        const reader = stream.readable.getReader();
        let resp = new Uint8Array(0);
        for (;;) {
            const { value, done } = await reader.read();
            // Copy: the WebTransport reader yields `Uint8Array<ArrayBufferLike>`.
            if (value) resp = concat(resp, new Uint8Array(value));
            if (done) break;
        }
        return resp;
    }

    async openDuplex(): Promise<Duplex> {
        const stream = await this.wt.createBidirectionalStream();
        return new WtDuplex(stream);
    }

    close(): void {
        try { this.wt.close(); } catch { /* ignore */ }
    }
}

export interface ConnectOptions {
    /** WebSocket URL (fallback), e.g. `ws://host:7777`. */
    ws: string;
    /** WebTransport URL (primary), e.g. `https://host:7778`. */
    wt?: string;
    /** sha-256 hashes of the server cert (for pinning a self-signed WebTransport cert). */
    certHashes?: Uint8Array[];
    /** Force a transport, skipping feature detection (useful for testing). */
    prefer?: "webtransport" | "websocket";
}

/** Pick a transport: WebTransport when available + configured, else WebSocket. */
export async function connect(opts: ConnectOptions): Promise<Transport> {
    const hasWt = typeof (globalThis as { WebTransport?: unknown }).WebTransport !== "undefined";
    const wantWt = opts.prefer !== "websocket" && !!opts.wt && hasWt;
    if (wantWt) {
        try {
            return await WebTransportTransport.connect(opts.wt!, opts.certHashes);
        } catch (e) {
            if (opts.prefer === "webtransport") throw e;
            // otherwise fall through to the WebSocket fallback
        }
    }
    return new WebSocketTransport(opts.ws);
}

// ---- typed capability client ----------------------------------------------

export function invoke(t: Transport, instance: string, func: string, params: number[]): Promise<Uint8Array> {
    return t.exchange(requestFrame(instance, func, params));
}

/** Typed client for the consented `icanhaz:nocap/fs` capability over any
 *  [`Transport`]. Lazily acquires one filesystem grant from the broker and
 *  presents it on every call (the daemon refuses calls without it). */
export class FsLite {
    private readonly t: Transport;
    private grant?: string;

    constructor(transport: Transport) {
        this.t = transport;
    }

    /** Acquire (once) a filesystem grant from the broker, reused for every call. */
    private async ensureGrant(): Promise<string> {
        if (this.grant === undefined) this.grant = await requestFilesystemGrant(this.t);
        return this.grant;
    }

    async read(path: string): Promise<Result<Uint8Array>> {
        const g = await this.ensureGrant();
        const resp = await invoke(this.t, FsLite.INSTANCE, "read", [...encodeString(g), ...encodeString(path)]);
        return decodeResult(resp, (b, o) => readBytes(b, o));
    }
    async write(path: string, data: Uint8Array): Promise<Result<void>> {
        const g = await this.ensureGrant();
        const resp = await invoke(this.t, FsLite.INSTANCE, "write", [...encodeString(g), ...encodeString(path), ...encodeBytes(data)]);
        return decodeResult(resp, () => [undefined as void, 1]);
    }
    async readDir(dir: string): Promise<Result<string[]>> {
        const g = await this.ensureGrant();
        const resp = await invoke(this.t, FsLite.INSTANCE, "read-dir", [...encodeString(g), ...encodeString(dir)]);
        return decodeResult(resp, (b, o) => readList(b, o, readString));
    }

    static readonly INSTANCE = "icanhaz:nocap/fs@0.1.0";
}

// ---- consent broker --------------------------------------------------------
//
// Before using a capability you must hold a grant for it. `broker.request(want,
// reason)` raises a consent decision on the host and returns an unforgeable
// bearer token (or a denial); the capability calls then present that token.

const BROKER_INSTANCE = "icanhaz:nocap/broker@0.1.0";

/** Encode `capability-kind::terminal(terminal-request{ shell: none, jailed })`. */
function encodeTerminalWant(jailed: boolean): number[] {
    // variant disc 3 = terminal; payload = { shell: option<string> (none=0), jailed: bool }.
    return [...leb128(3), 0x00, jailed ? 1 : 0];
}

/** Decode `result<string, denied>` — the grant token, or a denial reason. */
/** Encode `capability-kind::filesystem(fs-request{ roots:[{path:"/jail/", rights}] })`. */
function encodeFilesystemWant(): number[] {
    const READ = 1, WRITE = 2, CREATE = 4; // fs-rights flags (bitset)
    return [
        ...leb128(0),                     // variant disc 0 = filesystem
        ...leb128(1),                     // roots: 1 entry
        ...encodeString("/jail/"),        //   path-grant.path
        ...leb128(READ | WRITE | CREATE), //   path-grant.rights
    ];
}

/** Encode `capability-kind::process(process-request{ image, guest-chooses-argv })`. */
function encodeProcessWant(image: string, guestChoosesArgv: boolean): number[] {
    // variant disc 2 = process; payload = { image: string, guest-chooses-argv: bool }.
    return [...leb128(2), ...encodeString(image), guestChoosesArgv ? 1 : 0];
}

/** Encode an `option<string>`: 0 = none, 1 = some + the string. */
function encodeOption(s: string | undefined): number[] {
    return s === undefined ? [0] : [1, ...encodeString(s)];
}

// ---- pairing: durable, origin-partitioned consent --------------------------
//
// On first approval the daemon returns a `pairing` secret; we stash it in
// IndexedDB — which the browser partitions by origin, so only this origin's JS
// can read it. Presenting it on later requests skips the consent prompt. With no
// IndexedDB (a Node client) the helpers no-op, so a non-browser never pairs.

const PAIR_DB = "icanhaz";
const PAIR_STORE = "pairings";
const PAIR_KEY = "secret";

function idbOpen(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(PAIR_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(PAIR_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** The stored pairing secret for this origin, or undefined (incl. non-browser). */
export async function getPairing(): Promise<string | undefined> {
    if (typeof indexedDB === "undefined") return undefined;
    try {
        const db = await idbOpen();
        return await new Promise((resolve) => {
            const r = db.transaction(PAIR_STORE).objectStore(PAIR_STORE).get(PAIR_KEY);
            r.onsuccess = () => resolve((r.result as string | undefined) ?? undefined);
            r.onerror = () => resolve(undefined);
        });
    } catch {
        return undefined;
    }
}

async function setPairing(secret: string): Promise<void> {
    if (typeof indexedDB === "undefined") return;
    try {
        const db = await idbOpen();
        await new Promise<void>((resolve) => {
            const tx = db.transaction(PAIR_STORE, "readwrite");
            tx.objectStore(PAIR_STORE).put(secret, PAIR_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch {
        /* best-effort */
    }
}

/** Forget the pairing secret for this origin (testing / "unpair this site"). */
export async function clearPairing(): Promise<void> {
    if (typeof indexedDB === "undefined") return;
    try {
        const db = await idbOpen();
        await new Promise<void>((resolve) => {
            const tx = db.transaction(PAIR_STORE, "readwrite");
            tx.objectStore(PAIR_STORE).delete(PAIR_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch {
        /* ignore */
    }
}

interface GrantReply { token: string; pairing?: string }

/** Decode `result<grant, denied>` where `grant = { token, pairing: option<string> }`. */
function decodeGrantRecord(resp: Uint8Array): Result<GrantReply> {
    const rv = resultValue(resp); // [disc][payload]
    if (rv[0] === 0) {
        const [token, o1] = readString(rv, 1);
        let pairing: string | undefined;
        if (rv[o1] === 1) pairing = readString(rv, o1 + 1)[0]; // option<string> = some
        return { ok: { token, pairing } };
    }
    const disc = rv[1] ?? 0;
    if (disc === 3) {
        const [s] = readString(rv, 2); // unsupported(string)
        return { err: `unsupported: ${s}` };
    }
    const names = ["user-rejected", "not-authorized", "no-provider", "unsupported", "quota", "revoked"];
    return { err: names[disc] ?? `denied(${disc})` };
}

/** Request a grant, presenting any stored pairing secret + storing a new one. */
async function requestGrant(t: Transport, want: number[], reason: string, label: string): Promise<string> {
    const params = [...want, ...encodeString(reason), ...encodeOption(await getPairing())];
    const r = decodeGrantRecord(await invoke(t, BROKER_INSTANCE, "request", params));
    if ("err" in r) throw new Error(`${label} grant denied: ${r.err}`);
    if (r.ok.pairing) await setPairing(r.ok.pairing);
    return r.ok.token;
}

/** Request a consented `terminal` grant from the broker; throws if denied. */
export async function requestTerminalGrant(t: Transport, reason = "open a terminal"): Promise<string> {
    return requestGrant(t, encodeTerminalWant(false), reason, "terminal");
}

/** Request a consented `filesystem` grant from the broker; throws if denied. */
export async function requestFilesystemGrant(t: Transport, reason = "access files"): Promise<string> {
    return requestGrant(t, encodeFilesystemWant(), reason, "filesystem");
}

/**
 * Request a consented `process` grant pinning `image` (the program the host will
 * spawn). `guestChoosesArgv` asks for the right to pass argv at spawn time (an LSP
 * needs e.g. `--stdio`); without it the host runs the image as configured. Throws
 * if denied.
 */
export async function requestProcessGrant(
    t: Transport,
    image: string,
    guestChoosesArgv = false,
    reason = `run ${image}`,
): Promise<string> {
    return requestGrant(t, encodeProcessWant(image, guestChoosesArgv), reason, "process");
}

// ---- broker: audit view (who holds what) -----------------------------------

export interface Principal { kind: string; id: string; displayName?: string }
export interface GrantInfo { id: string; holder: Principal; summary: string }

function readPrincipal(b: Uint8Array, o: number): [Principal, number] {
    const [kindDisc, o1] = readLeb128(b, o); // principal-kind enum
    const [id, o2] = readString(b, o1);
    const [optDisc, o3] = readLeb128(b, o2); // option<string> display-name
    let displayName: string | undefined;
    let off = o3;
    if (optDisc === 1) {
        const [d, no] = readString(b, o3);
        displayName = d;
        off = no;
    }
    const kinds = ["web-origin", "installed-app", "peer"];
    return [{ kind: kinds[kindDisc] ?? `kind(${kindDisc})`, id, displayName }, off];
}

function readGrantInfo(b: Uint8Array, o: number): [GrantInfo, number] {
    const [id, o1] = readString(b, o);
    const [holder, o2] = readPrincipal(b, o1);
    const [summary, o3] = readString(b, o2);
    return [{ id, holder, summary }, o3];
}

/** `broker.granted()` — what the caller currently holds (the audit view). */
export async function brokerGranted(t: Transport): Promise<GrantInfo[]> {
    const rv = resultValue(await invoke(t, BROKER_INSTANCE, "granted", []));
    return readList(rv, 0, readGrantInfo)[0];
}

// ---- streaming (the terminal) ----------------------------------------------
//
// Streaming invocations multiplex sub-channels over one persistent duplex via
// the wRPC "Conn frame": [path_len][path…][data_len][data] (all LEB128). The
// main channel is path [] (params out, result back); each stream<u8> is a
// sub-channel at path [0] whose chunks are frames, with a zero-length chunk =
// end-of-stream. Same codec over WebSocket and WebTransport — only the duplex
// differs. (A simple call is the degenerate case: one main-channel frame.)

function tryLeb(b: Uint8Array, o: number): [number, number] | null {
    let res = 0;
    let shift = 0;
    let p = o;
    for (;;) {
        if (p >= b.length) return null; // incomplete
        const byte = b[p++]!;
        res |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }
    return [res >>> 0, p];
}

/** Encode a Conn frame: `[path_len][path…][data_len][data]`. */
function encodeFrame(path: number[], data: Uint8Array): Uint8Array {
    const head = [...leb128(path.length), ...path.flatMap(leb128), ...leb128(data.length)];
    const out = new Uint8Array(head.length + data.length);
    out.set(head);
    out.set(data, head.length);
    return out;
}

interface Frame {
    path: number[];
    data: Uint8Array;
}

/** Reassembles Conn frames from a byte stream (WS/WT messages aren't frame-aligned). */
class FrameParser {
    private buf = new Uint8Array(0);

    push(bytes: Uint8Array): void {
        const next = new Uint8Array(this.buf.length + bytes.length);
        next.set(this.buf);
        next.set(bytes, this.buf.length);
        this.buf = next;
    }

    *frames(): Generator<Frame> {
        for (;;) {
            const frame = this.tryOne();
            if (!frame) return;
            yield frame;
        }
    }

    private tryOne(): Frame | null {
        let o = 0;
        const pl = tryLeb(this.buf, o);
        if (!pl) return null;
        o = pl[1];
        const path: number[] = [];
        for (let i = 0; i < pl[0]; i++) {
            const p = tryLeb(this.buf, o);
            if (!p) return null;
            path.push(p[0]);
            o = p[1];
        }
        const dl = tryLeb(this.buf, o);
        if (!dl) return null;
        o = dl[1];
        if (o + dl[0] > this.buf.length) return null; // data incomplete
        const data = this.buf.slice(o, o + dl[0]);
        this.buf = this.buf.slice(o + dl[0]);
        return { path, data };
    }
}

/** Parses a `stream<u8>` sub-channel: a sequence of `[chunk_len][chunk_bytes]`;
 *  a zero-length chunk marks end-of-stream (yielded as `null`). */
class StreamChunkParser {
    private buf = new Uint8Array(0);

    push(bytes: Uint8Array): void {
        const next = new Uint8Array(this.buf.length + bytes.length);
        next.set(this.buf);
        next.set(bytes, this.buf.length);
        this.buf = next;
    }

    *chunks(): Generator<Uint8Array | null> {
        for (;;) {
            const cl = tryLeb(this.buf, 0);
            if (!cl) return; // incomplete length
            const [n, off] = cl;
            if (n === 0) {
                this.buf = this.buf.slice(off);
                yield null; // end-of-stream
                continue;
            }
            if (off + n > this.buf.length) return; // chunk data incomplete
            yield this.buf.slice(off, off + n);
            this.buf = this.buf.slice(off + n);
        }
    }
}

/** Encode a `stream<u8>` chunk: `[chunk_len LEB][bytes]` (zero-length = end). */
function encodeChunk(bytes: Uint8Array): Uint8Array {
    return new Uint8Array([...leb128(bytes.length), ...bytes]);
}

/** WebSocket-backed duplex (the connection stays open for the whole session). */
class WsDuplex implements Duplex {
    private ws: WebSocket;
    private bytesCb?: (b: Uint8Array) => void;
    private closeCb?: () => void;
    private backlog: Uint8Array[] = [];
    private closed = false;

    private constructor(ws: WebSocket) {
        this.ws = ws;
        ws.binaryType = "arraybuffer";
        ws.addEventListener("message", (e: MessageEvent) => {
            if (typeof e.data === "string") {
                if (e.data === "") this.fireClose(); // server end-of-output sentinel
                return;
            }
            const bytes = new Uint8Array(e.data as ArrayBuffer);
            if (this.bytesCb) this.bytesCb(bytes);
            else this.backlog.push(bytes);
        });
        ws.addEventListener("close", () => this.fireClose());
        ws.addEventListener("error", () => this.fireClose());
    }

    static connect(url: string): Promise<WsDuplex> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            ws.binaryType = "arraybuffer";
            ws.addEventListener("open", () => resolve(new WsDuplex(ws)));
            ws.addEventListener("error", () => reject(new Error("WebSocket error")));
        });
    }

    private fireClose(): void {
        if (this.closed) return;
        this.closed = true;
        this.closeCb?.();
    }

    write(bytes: Uint8Array): void {
        this.ws.send(bytes);
    }
    onBytes(cb: (b: Uint8Array) => void): void {
        this.bytesCb = cb;
        for (const b of this.backlog) cb(b);
        this.backlog = [];
    }
    onClose(cb: () => void): void {
        this.closeCb = cb;
        if (this.closed) cb();
    }
    closeWrite(): void {
        try { this.ws.send(""); } catch { /* ignore */ }
    }
    close(): void {
        try { this.ws.close(); } catch { /* ignore */ }
    }
}

/** WebTransport-backed duplex (one bidi stream for the whole session). */
class WtDuplex implements Duplex {
    private writer: WritableStreamDefaultWriter<Uint8Array>;
    private reader: ReadableStreamDefaultReader<Uint8Array>;
    private closeCb?: () => void;
    private closed = false;

    constructor(stream: WebTransportBidirectionalStream) {
        this.writer = stream.writable.getWriter();
        this.reader = stream.readable.getReader();
    }

    private fireClose(): void {
        if (this.closed) return;
        this.closed = true;
        this.closeCb?.();
    }

    write(bytes: Uint8Array): void {
        void this.writer.write(bytes);
    }
    onBytes(cb: (b: Uint8Array) => void): void {
        const pump = async () => {
            try {
                for (;;) {
                    const { value, done } = await this.reader.read();
                    if (value) cb(new Uint8Array(value));
                    if (done) break;
                }
            } catch {
                /* ignore */
            }
            this.fireClose();
        };
        void pump();
    }
    onClose(cb: () => void): void {
        this.closeCb = cb;
        if (this.closed) cb();
    }
    closeWrite(): void {
        void this.writer.close();
    }
    close(): void {
        try { void this.writer.close(); } catch { /* ignore */ }
        try { void this.reader.cancel(); } catch { /* ignore */ }
    }
}

/** A live terminal session (matches what the xterm renderer expects). */
export interface TerminalHandle {
    onOutput(cb: (bytes: Uint8Array) => void): void;
    write(data: string): void;
    /** No-op for now: the PTY is fixed at its open-time size (the WIT has no
     *  mid-session resize yet). */
    resize(cols: number, rows: number): void;
    onExit(cb: (code: number) => void): void;
    close(): void;
}

const TERMINAL_INSTANCE = "icanhaz:nocap/terminal@0.1.0";

/** Open an interactive terminal (your login shell) over a [`Transport`]. */
export async function openTerminal(
    transport: Transport,
    opts: { cols: number; rows: number; reason?: string; grant?: string },
): Promise<TerminalHandle> {
    // Consent gate: acquire a terminal grant from the broker first (unless the
    // caller already holds one). The daemon's terminal refuses an open without it.
    const grant = opts.grant ?? (await requestTerminalGrant(transport, opts.reason));
    const duplex = await transport.openDuplex();
    const parser = new FrameParser();
    const stdout = new StreamChunkParser();

    let onOutputCb: ((b: Uint8Array) => void) | undefined;
    let onExitCb: ((code: number) => void) | undefined;
    const outBacklog: Uint8Array[] = [];
    let exited = false;
    let pendingExit: number | null = null;

    const emitOutput = (b: Uint8Array) => {
        if (onOutputCb) onOutputCb(b);
        else outBacklog.push(b);
    };
    const emitExit = (code: number) => {
        if (exited) return;
        exited = true;
        if (onExitCb) onExitCb(code);
        else pendingExit = code;
    };

    duplex.onBytes((bytes) => {
        parser.push(bytes);
        for (const { path, data } of parser.frames()) {
            if (path.length === 0) {
                // main result frame: [disc][…]. 0 = ok (stdout follows), 1 = err.
                if (data[0] === 1) emitExit(1);
            } else if (path.length === 1 && path[0] === 0) {
                // stdout = the result stream, sub-channel [0]; [chunk_len][bytes] chunks.
                stdout.push(data);
                for (const chunk of stdout.chunks()) {
                    if (chunk === null) emitExit(0); // zero-length chunk = stream end
                    else emitOutput(chunk);
                }
            }
        }
    });
    duplex.onClose(() => emitExit(0));

    // Preamble + main params frame: [0x00 PROTOCOL][instance][func] + frame([], params).
    // params (WIT order) = [grant][stdin marker 0x00][control marker 0x00][cols][rows].
    const preamble = [0x00, ...encodeString(TERMINAL_INSTANCE), ...encodeString("open")];
    const params = new Uint8Array([...encodeString(grant), 0x00, 0x00, ...leb128(opts.cols), ...leb128(opts.rows)]);
    duplex.write(new Uint8Array([...preamble, ...encodeFrame([], params)]));

    const enc = new TextEncoder();
    return {
        onOutput(cb) {
            onOutputCb = cb;
            for (const b of outBacklog) cb(b);
            outBacklog.length = 0;
        },
        onExit(cb) {
            onExitCb = cb;
            if (pendingExit !== null) cb(pendingExit);
        },
        write(data) {
            // stdin is a stream<u8> on sub-channel [1] — its structural index in the
            // params (param #1, after `grant`). Each chunk is length-prefixed.
            duplex.write(encodeFrame([1], encodeChunk(enc.encode(data))));
        },
        resize(cols, rows) {
            // control sub-channel [2]: a 4-byte frame [cols u16 BE][rows u16 BE].
            const ev = new Uint8Array([(cols >> 8) & 0xff, cols & 0xff, (rows >> 8) & 0xff, rows & 0xff]);
            duplex.write(encodeFrame([2], encodeChunk(ev)));
        },
        close() {
            // End the stdin [1] + control [2] streams (zero-length chunks), then close.
            try {
                duplex.write(encodeFrame([1], encodeChunk(new Uint8Array(0))));
                duplex.write(encodeFrame([2], encodeChunk(new Uint8Array(0))));
            } catch { /* ignore */ }
            duplex.closeWrite();
            duplex.close();
        },
    };
}

// ---- generic streaming call (for generated bindings) -----------------------
//
// Generalises `openTerminal`'s duplex + frame routing. Sub-channel paths follow
// the value's *structural index* (verified against the wRPC server): an input
// `stream` param rides path [its param index]; an output stream in the result
// rides [0]; the main channel (path []) carries the result frame's non-stream
// parts (e.g. the `result<…>` discriminant + an error payload).

export interface StreamCall {
    /** Send a chunk to the input stream at `path`. */
    send(path: number, bytes: Uint8Array): void;
    /** End the input stream at `path` (zero-length chunk). */
    closeStream(path: number): void;
    /** Subscribe to the output stream at `path` (`null` chunk = end-of-stream). */
    onStream(path: number, cb: (chunk: Uint8Array | null) => void): void;
    /** The main-channel result frame value (`[disc][payload]`). */
    onResult(cb: (value: Uint8Array) => void): void;
    onClose(cb: () => void): void;
    close(): void;
}

export async function streamingCall(t: Transport, instance: string, func: string, mainParams: number[]): Promise<StreamCall> {
    const duplex = await t.openDuplex();
    const parser = new FrameParser();
    const subParsers = new Map<number, StreamChunkParser>();
    const subCbs = new Map<number, (c: Uint8Array | null) => void>();
    let resultCb: ((v: Uint8Array) => void) | undefined;
    let closeCb: (() => void) | undefined;

    duplex.onBytes((bytes) => {
        parser.push(bytes);
        for (const { path, data } of parser.frames()) {
            if (path.length === 0) {
                resultCb?.(data);
            } else if (path.length === 1) {
                const p = path[0]!;
                let sp = subParsers.get(p);
                if (!sp) {
                    sp = new StreamChunkParser();
                    subParsers.set(p, sp);
                }
                sp.push(data);
                for (const chunk of sp.chunks()) subCbs.get(p)?.(chunk);
            }
        }
    });
    duplex.onClose(() => closeCb?.());

    const preamble = [0x00, ...encodeString(instance), ...encodeString(func)];
    duplex.write(new Uint8Array([...preamble, ...encodeFrame([], new Uint8Array(mainParams))]));

    return {
        send(path, bytes) {
            duplex.write(encodeFrame([path], encodeChunk(bytes)));
        },
        closeStream(path) {
            duplex.write(encodeFrame([path], encodeChunk(new Uint8Array(0))));
        },
        onStream(path, cb) {
            subCbs.set(path, cb);
        },
        onResult(cb) {
            resultCb = cb;
        },
        onClose(cb) {
            closeCb = cb;
        },
        close() {
            duplex.closeWrite();
            duplex.close();
        },
    };
}
