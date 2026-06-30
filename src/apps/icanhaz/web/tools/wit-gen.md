# wit-gen — a TypeScript wRPC binding generator

Generates TS codecs + client stubs from WIT, so we stop hand-porting a codec per
interface. It's the TS counterpart to `wit-bindgen-wrpc` (which does this for
Rust). Run:

    node tools/wit-gen.mjs ../wit broker src/generated/broker.ts

## How it works

- **Input** — `wasm-tools component wit <dir> --json`, the fully-resolved WIT IR
  (`wit-parser`'s serde output: `types[]`, `interfaces[]`, functions, all
  id-referenced). No hand-written WIT parser.
- **Output** — `src/generated/<iface>.ts`: `export type` aliases, codecs named by
  type (`encGrant` / `decPrincipal`, falling back to `enc_<id>` for anonymous
  types; transparent `type X = Y` aliases collapse to the underlying codec), and
  `export async function <fn>(t, …)` client stubs. Only the param types get
  encoders and the result types get decoders.
- **Runtime** — the generated code imports the frame codec + `invoke` from
  `../wrpc` (the hand-written runtime). The generator emits only the typed layer.

## Grounded in two authoritative, open-source specs

Rather than reverse-engineer the wire format from the types we happened to use
(which silently misses kinds and gets edge cases wrong):

- **IR schema** — `wit-parser`'s `TypeDefKind` / `Type`. The complete kind set is
  enumerated in the generator; any unhandled kind is a *named error at generation
  time*, never silent output.
- **Wire codec** — `wrpc-transport`'s `value.rs`, cross-checked byte-for-byte
  against the maintainer's JS codec ([wrpc#1345](https://github.com/bytecodealliance/wrpc/pull/1345)).
  That comparison caught four bugs our reverse-engineered codec shipped (`u8`/`s8`
  ≥128, `u64`, `flags`, `char`):
  | type | encoding |
  |---|---|
  | `bool`, `u8`, `s8` | one raw byte |
  | `u16`..`u64` | unsigned LEB128 (`u64` ⇒ a JS `bigint`) |
  | `s16`..`s64` | signed LEB128 (`s64` ⇒ a JS `bigint`) |
  | `string`, `list<T>` | LEB128 length + items (`list<u8>` = raw bytes) |
  | `f32`, `f64` | **fixed little-endian** (not LEB128) |
  | `flags` | `ceil(n/8)` little-endian bytes (a bitset, **not** a LEB128 int) |
  | `char` | raw UTF-8 (**not** a LEB128 code point) |
  | `option` / `result` / `variant` / `enum` | LEB128 discriminant + payload |
  | resource `handle` (own/borrow) | opaque LEB128-length bytes |

  `result` is exposed as the jco-compatible `{ tag: "ok" | "err", val }` (not
  `{ ok } | { err }`), so values interop with the official codec + `jco`.

## Scope

- **Done + verified** — records, variants, enums, flags, tuples, option, result,
  list, handles, all primitives; simple (non-streaming) function stubs *and*
  streaming functions. A `stream` param rides path `[its param index]`; an output
  stream in the result rides `[0]`; the main channel carries the result frame.
  Streaming fns are emitted as a **session object** (`<Fn>Session`: one
  `name(bytes)` / `closeName()` pair per input stream, `onData(cb)` for the output
  stream, `onError(cb)` for the result's error arm, `close()`), built on the
  runtime's `streamingCall`. Both kinds are proven against the live daemon
  (`src/wrpc.browser.test.ts`): the generated `broker` client round-trips
  ("GENERATED broker bindings round-trip"), and the generated `terminal` session
  opens a PTY + echoes ("GENERATED streaming terminal session opens + echoes").
  A `wasi:io` **input-stream** returned in a result is mapped by wRPC to a native
  stream too, so it's emitted as the same readable session (`ioStreamDir` detects
  the handle) — proven by the `wasi:filesystem` test streaming a file via
  `descriptorReadViaStream`. **Output-streams** (`write-via-stream`) are *not*
  streamable over wRPC — `wrpc-wasmtime`'s codec bridges only `DynInputStream`, so
  a returned output-stream traps server-side — they stay handles; write via the
  non-streaming `descriptor.write` (which returns a `filesize` commit ack). The
  generator keeps a writable-session branch ready behind `ioStreamDir==="output"`.)
  Also **resource** methods / constructors / statics. A resource function arrives
  name-mangled (`[method]res.fn`, `[constructor]res`, `[static]res.fn`); the wire
  name is the **prefix-stripped** form (`res.fn` / `res` / `res.fn`) — verified
  against wRPC's `rpc_func_name` in the `introspect` *and* `wasmtime` crates — and
  `self` is an ordinary leading **borrow-handle** param (opaque bytes, since
  `ResourceBorrow` = `Bytes`), so a method encodes its params in order like any
  call. There is **no `[resource-drop]`** on the wire: handles are opaque Uuids the
  server tracks in a `SharedResourceTable`. Exposed resource-prefixed (`resFn`,
  `resNew`). Generated `policy` (4 methods + an own-handle result) and a `counter`
  fixture (all four function kinds — `tools/fixtures/resource-demo.wit`) both
  typecheck; the live round-trip lands with the first *served* resource interface.
- **Next** — `future` params/results (the single-value sibling of `stream`, same
  sub-channel path — currently a named gen-time error). `map` /
  `fixed-length-list` / `error-context` are one-liners when first needed. With
  resources done, the generator covers everything `wasi:filesystem@0.2` needs — so
  the remaining blocker for browser `wasi:filesystem` is host-side: *serving* a
  resource interface, not generating its bindings.

## Gotchas (encoded in the generator)

- `use other.{ty}` re-exports create a same-named alias type → skip the
  self-referential `export type X = X`.
- A WIT `transport` enum collides with the runtime's `Transport` interface →
  import the latter `as WrpcTransport`.
- Generated `.ts` imports omit the extension (vitest/vite resolve it; `tsc`
  rejects an explicit `.ts` for files inside `src/`).
- Resource function wire names are the mangled name with the
  `[method]`/`[constructor]`/`[static]` prefix **stripped** — not the mangled name
  itself. Reverse-engineering from one interface we'd have shipped the prefix; the
  authoritative `rpc_func_name` strips it. (And there is no `[resource-drop]` call —
  don't emit one.)
