#!/usr/bin/env node
// WIT → TypeScript wRPC binding generator.
//
//   wit-gen.mjs <wit-dir> <interface> <out.ts>
//
// Grounded in the two authoritative, open-source specs (so it doesn't drift from
// what real wRPC clients do — see wit-gen.md for the reasoning):
//
//   • IR schema  — wit-parser's `TypeDefKind` / `Type` (the exact shape of
//     `wasm-tools component wit --json`). The full kind set is enumerated below;
//     anything unhandled is a *named* error, never silent.
//   • Wire codec — wrpc-transport's `value.rs`, cross-checked against the
//     maintainer's JS codec (bytecodealliance/wrpc#1345). bool/u8/s8 = one raw
//     byte; u16..u64 = unsigned LEB128 (64-bit decodes to a JS bigint); s16..s64 =
//     signed LEB128; f32/f64 = fixed little-endian; strings/lists = LEB128-len +
//     bytes; flags = ceil(n/8) little-endian bytes; char = raw UTF-8; resource
//     handles = opaque LEB128-len bytes; option/result/variant/enum discriminant =
//     LEB128. `result` maps to the jco-compatible `{ tag: "ok"|"err", val }`.
//
// Emits typed codecs + client stubs for an interface's functions, riding the
// runtime in ../wrpc: simple (request/response) calls, streaming calls
// (stream/future params/results → a session object over Conn-frame sub-channels),
// and resource methods / constructors / statics (dispatched by the prefix-stripped
// wire name over opaque handles — see `fnNames`).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [witDir, ifaceName, outPath] = process.argv.slice(2);
if (!witDir || !ifaceName || !outPath) {
    console.error("usage: wit-gen.mjs <wit-dir> <interface> <out.ts>");
    process.exit(1);
}

const ir = JSON.parse(execFileSync("wasm-tools", ["component", "wit", witDir, "--json"], { encoding: "utf8" }));
const TYPES = ir.types;
const iface = ir.interfaces.find((i) => i.name === ifaceName);
if (!iface) {
    console.error(`interface '${ifaceName}' not found`);
    process.exit(1);
}

const isPrim = (ref) => typeof ref === "string";
const def = (id) => TYPES[id];
const kindTag = (id) => Object.keys(def(id).kind)[0];
const camel = (s) => s.replace(/[-_]([a-z0-9])/g, (_, c) => c.toUpperCase());
const pascal = (s) => {
    const c = camel(s);
    return c.charAt(0).toUpperCase() + c.slice(1);
};

// A `stream`/`future` value isn't a plain codec — it's an async sub-channel.
// A wasi:io INPUT-stream resource handle is mapped by wRPC to a native wRPC
// stream (a readable byte sub-channel: the server streams bytes → onData), so for
// codegen it's a "stream" like a wit `stream<u8>`. OUTPUT-streams are NOT
// streamable over wRPC: wrpc-wasmtime's codec bridges only `DynInputStream`
// (`crates/wasmtime/src/codec.rs`), so a *returned* output-stream fails server-side
// ("channel closed") — it stays an opaque handle (write via the non-streaming
// `descriptor.write`, which also returns a commit ack). `emitStreamFn` keeps a
// writable branch, ready behind `ioStreamDir==="output"` if wRPC ever bridges them.
function ioStreamDir(ref) {
    if (isPrim(ref) || kindTag(ref) !== "handle") return null;
    const h = def(ref).kind.handle;
    const target = h.own ?? h.borrow;
    if (target == null || isPrim(target)) return null;
    const name = def(target).name;
    return name === "input-stream" ? "input" : name === "output-stream" ? "output" : null;
}
const isStream = (ref) => !isPrim(ref) && (/^(stream|future)$/.test(kindTag(ref)) || ioStreamDir(ref) === "input");

// ---- reachable closure, split by direction (param ⇒ encode, result ⇒ decode) -
const encReach = new Set();
const decReach = new Set();
function visit(ref, set) {
    if (isPrim(ref) || set.has(ref)) return;
    set.add(ref);
    const k = def(ref).kind;
    if (k.record) k.record.fields.forEach((f) => visit(f.type, set));
    else if (k.variant) k.variant.cases.forEach((c) => c.type != null && visit(c.type, set));
    else if (k.tuple) k.tuple.types.forEach((t) => visit(t, set));
    else if (k.option != null) visit(k.option, set);
    else if (k.list != null) visit(k.list, set);
    else if (k["fixed-length-list"]) visit(k["fixed-length-list"][0], set);
    else if (k.map) { visit(k.map[0], set); visit(k.map[1], set); }
    else if (k.result) {
        if (k.result.ok != null) visit(k.result.ok, set);
        if (k.result.err != null) visit(k.result.err, set);
    } else if (k.type != null) visit(k.type, set);
    // enum / flags / handle / resource / future / stream: leaf for value codecs
}
function resultHasStream(ref) {
    if (ref == null || isPrim(ref)) return false;
    if (isStream(ref)) return true;
    const k = def(ref).kind;
    if (k.result) return resultHasStream(k.result.ok) || resultHasStream(k.result.err);
    if (k.tuple) return k.tuple.types.some(resultHasStream);
    if (k.option != null) return resultHasStream(k.option);
    return false;
}
// Visit the *non-stream* parts of a result (the stream arms have no value codec).
function visitNonStream(ref, set) {
    if (ref == null || isPrim(ref) || isStream(ref)) return;
    const k = def(ref).kind;
    if (k.result) {
        visitNonStream(k.result.ok, set);
        visitNonStream(k.result.err, set);
        return;
    }
    visit(ref, set);
}
const streamingFns = [];
const simpleFns = [];
for (const [name, sig] of Object.entries(iface.functions)) {
    const streaming = sig.params.some((p) => isStream(p.type)) || resultHasStream(sig.result);
    if (streaming) {
        streamingFns.push([name, sig]);
        sig.params.forEach((p) => {
            if (!isStream(p.type)) visit(p.type, encReach);
        });
        if (sig.result != null) visitNonStream(sig.result, decReach);
    } else {
        simpleFns.push([name, sig]);
        sig.params.forEach((p) => visit(p.type, encReach));
        if (sig.result != null) visit(sig.result, decReach);
    }
}

// ---- codec names ------------------------------------------------------------
// Transparent (`type X = Y`) aliases carry no codec of their own — resolve them
// to the underlying id. Codecs are named by type name where available
// (`encGrant` / `decPrincipal`); anonymous types (handles, inline
// lists/options/results) fall back to the id (`enc_103`), with a `_<id>` tiebreak
// if a name isn't unique in the closure.
function resolveAlias(ref) {
    while (!isPrim(ref) && kindTag(ref) === "type") ref = def(ref).kind.type;
    return ref;
}
const codecIds = [...new Set([...encReach, ...decReach].map(resolveAlias))].filter((r) => !isPrim(r));
const nameFreq = {};
for (const id of codecIds) {
    const nm = def(id).name && pascal(def(id).name);
    if (nm) nameFreq[nm] = (nameFreq[nm] ?? 0) + 1;
}
const baseOf = new Map(
    codecIds.map((id) => {
        const nm = def(id).name && pascal(def(id).name);
        return [id, nm && nameFreq[nm] === 1 ? nm : `_${id}`];
    }),
);
const codecBase = (ref) => baseOf.get(resolveAlias(ref));

// ---- TS type expressions ----------------------------------------------------
function tsType(ref) {
    if (isPrim(ref)) return tsPrim(ref);
    const t = def(ref);
    return t.name ? pascal(t.name) : tsKind(t.kind);
}
function tsPrim(p) {
    if (p === "string" || p === "char") return "string";
    if (p === "bool") return "boolean";
    if (p === "u64" || p === "s64") return "bigint"; // 64-bit ints exceed JS number's safe range
    if (/^[us]\d+$/.test(p) || p === "f32" || p === "f64") return "number";
    throw new Error(`unsupported primitive: ${p}`);
}
function tsKind(k) {
    if (k.record) return `{ ${k.record.fields.map((f) => `${camel(f.name)}: ${tsType(f.type)}`).join("; ")} }`;
    if (k.variant) return k.variant.cases.map((c) => (c.type != null ? `{ tag: "${c.name}"; val: ${tsType(c.type)} }` : `{ tag: "${c.name}" }`)).join(" | ");
    if (k.enum) return k.enum.cases.map((c) => `"${c.name}"`).join(" | ");
    if (k.flags) return `{ ${k.flags.flags.map((f) => `${camel(f.name)}?: boolean`).join("; ")} }`;
    if (k.tuple) return `[${k.tuple.types.map(tsType).join(", ")}]`;
    if (k.option != null) return `${tsType(k.option)} | undefined`;
    if (k.list != null) return k.list === "u8" ? "Uint8Array" : `${tsType(k.list)}[]`;
    if (k.handle) return "Uint8Array"; // resource handle = opaque byte blob
    if (k.result) return `{ tag: "ok"; val: ${k.result.ok != null ? tsType(k.result.ok) : "void"} } | { tag: "err"; val: ${k.result.err != null ? tsType(k.result.err) : "void"} }`;
    if (k.type != null) return tsType(k.type);
    throw new Error(unsupportedKind(Object.keys(k)[0]));
}

function unsupportedKind(tag) {
    const why = {
        resource: "a resource definition — served as method-functions over opaque handles, not a value",
        future: "an async future — needs the Conn-frame sub-channel path",
        stream: "an async stream — needs the Conn-frame sub-channel path",
        map: "wasm-tokio encodes it as a LEB128-len list of (key,value) pairs; add when first needed",
        "fixed-length-list": "a fixed-length list — like list<T> without the length prefix; add when first needed",
        "error-context": "wasi:io error-context handle; add when first needed",
    };
    return `unsupported WIT kind '${tag}': ${why[tag] ?? "not yet emitted"}`;
}

// ---- encoders (expression ⇒ number[]) ---------------------------------------
function encRef(ref, v) {
    ref = resolveAlias(ref);
    if (!isPrim(ref)) return `enc${codecBase(ref)}(${v})`;
    switch (ref) {
        case "string": return `encodeString(${v})`;
        case "bool": return `[${v} ? 1 : 0]`;
        case "char": return `encChar(${v})`;
        case "f32": return `encF32(${v})`;
        case "f64": return `encF64(${v})`;
        case "u8": case "s8": return `[Number(${v}) & 0xff]`; // one raw byte, not LEB128
        case "u16": case "u32": case "u64": return `leb128(${v})`;
        case "s16": case "s32": case "s64": return `sleb128(${v})`;
        default: throw new Error(`unsupported primitive encode: ${ref}`);
    }
}
function emitEnc(id) {
    const k = def(id).kind;
    let body;
    if (k.record) {
        body = `return [${k.record.fields.map((f) => `...${encRef(f.type, `v.${camel(f.name)}`)}`).join(", ")}];`;
    } else if (k.variant) {
        const arms = k.variant.cases.map((c, i) =>
            c.type != null
                ? `if (v.tag === "${c.name}") return [...leb128(${i}), ...${encRef(c.type, "v.val")}];`
                : `if (v.tag === "${c.name}") return leb128(${i});`,
        );
        body = `${arms.join("\n    ")}\n    throw new Error("bad variant: " + (v as { tag: string }).tag);`;
    } else if (k.enum) {
        body = `return leb128([${k.enum.cases.map((c) => `"${c.name}"`).join(", ")}].indexOf(v));`;
    } else if (k.flags) {
        const nb = Math.ceil(Math.max(k.flags.flags.length, 1) / 8);
        const sets = k.flags.flags.map((f, i) => `if (v.${camel(f.name)}) bytes[${i >> 3}] |= ${1 << (i & 7)};`).join("\n    ");
        body = `const bytes = new Array(${nb}).fill(0);\n    ${sets}\n    return bytes;`;
    } else if (k.tuple) {
        body = `return [${k.tuple.types.map((t, i) => `...${encRef(t, `v[${i}]`)}`).join(", ")}];`;
    } else if (k.option != null) {
        body = `return v === undefined ? [0] : [1, ...${encRef(k.option, "v")}];`;
    } else if (k.list != null) {
        body = k.list === "u8" ? `return encodeBytes(v);` : `return [...leb128(v.length), ...v.flatMap((x) => ${encRef(k.list, "x")})];`;
    } else if (k.handle) {
        body = `return encodeBytes(v);`;
    } else if (k.result) {
        const ok = k.result.ok != null ? `...${encRef(k.result.ok, "v.val")}` : "";
        const err = k.result.err != null ? `...${encRef(k.result.err, "v.val")}` : "";
        body = `return v.tag === "ok" ? [0${ok ? ", " + ok : ""}] : [1${err ? ", " + err : ""}];`;
    } else if (k.type != null) {
        body = `return ${encRef(k.type, "v")};`;
    } else {
        throw new Error(unsupportedKind(Object.keys(k)[0]));
    }
    return `function enc${codecBase(id)}(v: ${tsType(id)}): number[] {\n    ${body}\n}`;
}

// ---- decoders (expression ⇒ [value, offset]) --------------------------------
function decoder(ref) {
    ref = resolveAlias(ref);
    if (!isPrim(ref)) return `dec${codecBase(ref)}`;
    switch (ref) {
        case "string": return "readString";
        case "bool": return "readBool";
        case "char": return "readChar";
        case "f32": return "readF32";
        case "f64": return "readF64";
        case "u8": return "readU8";
        case "s8": return "readS8";
        case "u16": case "u32": return "readLeb128";
        case "u64": return "readLeb128Big";
        case "s16": case "s32": return "readSleb128";
        case "s64": return "readSleb128Big";
        default: throw new Error(`unsupported primitive decode: ${ref}`);
    }
}
const decCall = (ref, b, o) => `${decoder(ref)}(${b}, ${o})`;
function emitDec(id) {
    const k = def(id).kind;
    let body;
    if (k.record) {
        const lines = [];
        let prev = "o0";
        const fields = [];
        k.record.fields.forEach((f, i) => {
            const o = `o${i + 1}`;
            lines.push(`const [_${i}, ${o}] = ${decCall(f.type, "b", prev)};`);
            fields.push(`${camel(f.name)}: _${i}`);
            prev = o;
        });
        body = `${lines.join("\n    ")}\n    return [{ ${fields.join(", ")} }, ${prev}];`;
    } else if (k.variant) {
        const arms = k.variant.cases.map((c, i) =>
            c.type != null
                ? `if (d === ${i}) { const [val, o2] = ${decCall(c.type, "b", "o1")}; return [{ tag: "${c.name}", val }, o2]; }`
                : `if (d === ${i}) return [{ tag: "${c.name}" }, o1];`,
        );
        body = `const [d, o1] = readLeb128(b, o0);\n    ${arms.join("\n    ")}\n    throw new Error("bad disc: " + d);`;
    } else if (k.enum) {
        body = `const [d, o1] = readLeb128(b, o0);\n    return [([${k.enum.cases.map((c) => `"${c.name}"`).join(", ")}] as const)[d]!, o1];`;
    } else if (k.flags) {
        const nb = Math.ceil(Math.max(k.flags.flags.length, 1) / 8);
        const tests = k.flags.flags.map((f, i) => `${camel(f.name)}: !!(b[o0 + ${i >> 3}]! & ${1 << (i & 7)})`).join(", ");
        body = `return [{ ${tests} }, o0 + ${nb}];`;
    } else if (k.tuple) {
        const lines = [];
        let prev = "o0";
        const els = [];
        k.tuple.types.forEach((t, i) => {
            const o = `o${i + 1}`;
            lines.push(`const [_${i}, ${o}] = ${decCall(t, "b", prev)};`);
            els.push(`_${i}`);
            prev = o;
        });
        body = `${lines.join("\n    ")}\n    return [[${els.join(", ")}], ${prev}];`;
    } else if (k.option != null) {
        body = `const [d, o1] = readLeb128(b, o0);\n    if (d === 0) return [undefined, o1];\n    return ${decCall(k.option, "b", "o1")};`;
    } else if (k.list != null) {
        body = k.list === "u8" ? `return readBytes(b, o0);` : `return readList(b, o0, ${decoder(k.list)});`;
    } else if (k.handle) {
        body = `return readBytes(b, o0);`;
    } else if (k.result) {
        const ok = k.result.ok != null ? `const [val, o2] = ${decCall(k.result.ok, "b", "o1")}; return [{ tag: "ok", val }, o2];` : `return [{ tag: "ok", val: undefined }, o1];`;
        const err = k.result.err != null ? `const [val, o2] = ${decCall(k.result.err, "b", "o1")}; return [{ tag: "err", val }, o2];` : `return [{ tag: "err", val: undefined }, o1];`;
        body = `const [d, o1] = readLeb128(b, o0);\n    if (d === 0) { ${ok} }\n    ${err}`;
    } else if (k.type != null) {
        body = `return ${decCall(k.type, "b", "o0")};`;
    } else {
        throw new Error(unsupportedKind(Object.keys(k)[0]));
    }
    return `function dec${codecBase(id)}(b: Uint8Array, o0: number): [${tsType(id)}, number] {\n    ${body}\n}`;
}

// ---- function stubs ---------------------------------------------------------
// A function's wire name + exported TS name. Resource methods/constructors/statics
// arrive name-mangled (`[method]res.fn`); wRPC's `rpc_func_name` strips the prefix
// for the wire (verified in wrpc's `introspect` + `wasmtime` crates), and we
// expose them resource-prefixed (`resFn`). `self` is an ordinary leading
// borrow-handle param (opaque bytes — `ResourceBorrow` = `Bytes`), so methods need
// no special framing: they encode `params` in order like any call. There is no
// `[resource-drop]` on the wire — handles are opaque Uuids the server tracks.
function fnNames(name, sig) {
    const k = sig.kind;
    if (typeof k === "string") return { wireName: name, tsName: camel(name) }; // "freestanding"
    const tag = Object.keys(k)[0]; // "method" | "static" | "constructor"
    const resName = def(k[tag]).name;
    const stripped = name.replace(/^\[[^\]]+\]/, ""); // "res.member" | "res"
    const member = tag === "constructor" ? "new" : stripped.slice(stripped.indexOf(".") + 1);
    return { wireName: stripped, tsName: camel(resName) + pascal(member) };
}
function emitFn(name, sig) {
    const { wireName, tsName } = fnNames(name, sig);
    const params = sig.params.map((p) => `${camel(p.name)}: ${tsType(p.type)}`);
    const enc = sig.params.map((p) => `...${encRef(p.type, camel(p.name))}`);
    const sigParams = ["t: WrpcTransport", ...params].join(", ");
    if (sig.result == null) {
        return `export async function ${tsName}(${sigParams}): Promise<void> {\n    await invoke(t, INSTANCE, "${wireName}", [${enc.join(", ")}]);\n}`;
    }
    return `export async function ${tsName}(${sigParams}): Promise<${tsType(sig.result)}> {\n    const resp = await invoke(t, INSTANCE, "${wireName}", [${enc.join(", ")}]);\n    return ${decCall(sig.result, "resultValue(resp)", "0")}[0];\n}`;
}

// ---- streaming function stubs (session objects) -----------------------------
// An input `stream` param rides path [its param index]; an output stream in the
// result rides [0]; the main channel carries the result frame. Riding the
// runtime's `streamingCall` (which does the duplex + Conn-frame routing).
function emitStreamFn(name, sig) {
    const { wireName, tsName } = fnNames(name, sig);
    const P = pascal(tsName);
    const inputs = [];
    const mainParts = [];
    sig.params.forEach((p, i) => {
        if (isStream(p.type)) {
            inputs.push({ name: camel(p.name), path: i });
            mainParts.push("0"); // stream param = a pending-value marker byte
        } else {
            mainParts.push(`...${encRef(p.type, camel(p.name))}`);
        }
    });
    const nonStreamParams = sig.params.filter((p) => !isStream(p.type)).map((p) => `${camel(p.name)}: ${tsType(p.type)}`);

    const members = [];
    const impls = [];
    const setup = [];
    for (const inp of inputs) {
        members.push(`${inp.name}(bytes: Uint8Array): void`);
        members.push(`close${pascal(inp.name)}(): void`);
        impls.push(`${inp.name}(bytes) { call.send(${inp.path}, bytes); }`);
        impls.push(`close${pascal(inp.name)}() { call.closeStream(${inp.path}); }`);
    }

    const res = sig.result;
    let writable = false; // a writable result stream (output-stream) → the client writes
    if (res != null && !isPrim(res) && kindTag(res) === "result") {
        const rk = def(res).kind.result;
        if (!(rk.ok != null && isStream(rk.ok))) throw new Error(`unsupported streaming result for '${name}' (ok arm isn't a stream)`);
        const errTs = rk.err != null ? tsType(rk.err) : "void";
        // The error arm rides the main result frame (disc 1), shared by both directions.
        members.push(`onError(cb: (err: ${errTs}) => void): void`);
        impls.push(`onError(cb) { errCb = cb; }`);
        setup.push(`let errCb: ((e: ${errTs}) => void) | undefined;`);
        const errDec = rk.err != null ? `const [e] = ${decCall(rk.err, "v", "1")}; errCb?.(e);` : `errCb?.(undefined as never);`;
        setup.push(`call.onResult((v) => { if (v[0] === 1) { ${errDec} } });`);
        if (ioStreamDir(rk.ok) === "output") {
            writable = true; // client streams bytes to the returned output-stream (path 0)
            members.push(`write(bytes: Uint8Array): void`);
            impls.push(`write(bytes) { call.send(0, bytes); }`);
        } else {
            members.push(`onData(cb: (chunk: Uint8Array | null) => void): void`);
            impls.push(`onData(cb) { dataCb = cb; }`);
            setup.push(`let dataCb: ((c: Uint8Array | null) => void) | undefined;`);
            setup.push(`call.onStream(0, (c) => dataCb?.(c));`);
        }
    } else if (res != null && !isPrim(res) && kindTag(res) === "stream") {
        members.push(`onData(cb: (chunk: Uint8Array | null) => void): void`);
        impls.push(`onData(cb) { dataCb = cb; }`);
        setup.push(`let dataCb: ((c: Uint8Array | null) => void) | undefined;`);
        setup.push(`call.onStream(0, (c) => dataCb?.(c));`);
    } else if (res != null) {
        throw new Error(`unsupported streaming result for '${name}'`);
    }

    members.push(`close(): void`);
    // A writable result stream signals EOF on its sub-channel (→ the server reads
    // end-of-input, commits the write, and closes the duplex itself). Tearing down
    // the duplex here instead would race that commit ("channel closed").
    impls.push(writable ? `close() { call.closeStream(0); }` : `close() { call.close(); }`);

    const sigParams = ["t: WrpcTransport", ...nonStreamParams].join(", ");
    return `export interface ${P}Session {\n    ${members.join(";\n    ")};\n}
export async function ${tsName}(${sigParams}): Promise<${P}Session> {
    const call = await streamingCall(t, INSTANCE, "${wireName}", [${mainParts.join(", ")}]);
    ${setup.join("\n    ")}
    return {
        ${impls.join(",\n        ")},
    };
}`;
}

// ---- assemble ---------------------------------------------------------------
const instance = ir.packages[iface.package].name.replace("@", `/${ifaceName}@`);
const named = (id) => def(id).name;

const emittedNames = new Set();
const aliases = [];
for (const id of [...new Set([...encReach, ...decReach])].filter(named)) {
    const nm = pascal(named(id));
    if (emittedNames.has(nm)) continue;
    const ts = tsKind(def(id).kind);
    if (ts === nm) continue; // skip self-referential `use` re-exports (alias keeps the name)
    emittedNames.add(nm);
    aliases.push(`export type ${nm} = ${ts};`);
}
const encoders = [...new Set([...encReach].map(resolveAlias))].filter((r) => !isPrim(r)).map(emitEnc);
const decoders = [...new Set([...decReach].map(resolveAlias))].filter((r) => !isPrim(r)).map(emitDec);
const fns = [...simpleFns.map(([n, s]) => emitFn(n, s)), ...streamingFns.map(([n, s]) => emitStreamFn(n, s))];

const body = `${aliases.join("\n")}\n\n${encoders.join("\n")}\n\n${decoders.join("\n")}\n\n${fns.join("\n\n")}\n`;

const RUNTIME = ["leb128", "sleb128", "readLeb128", "readLeb128Big", "readSleb128", "readSleb128Big", "readU8", "readS8", "encChar", "encodeString", "readString", "encodeBytes", "readBytes", "readBool", "readChar", "encF32", "readF32", "encF64", "readF64", "readList", "invoke", "resultValue", "streamingCall"];
const used = RUNTIME.filter((h) => new RegExp(`\\b${h}\\b`).test(body));
const header = `// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for \`${instance}\`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, ${used.join(", ")} } from "../wrpc";

const INSTANCE = "${instance}";
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, header + "\n" + body);
console.log(`wrote ${outPath}: ${aliases.length} types, ${encoders.length} enc + ${decoders.length} dec, ${simpleFns.length} simple + ${streamingFns.length} streaming fns`);
