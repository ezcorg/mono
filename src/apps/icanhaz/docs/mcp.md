# An MCP front for icanhaz (design, not yet built)

Status: a draft, 2026-09-22. Decided in discussion: no automatic draining of
streams, no convenience tools beside the generated ones, and long-running
work must be something an agent can poll or watch. Not decided: when to
build it. Nothing here is implemented.

## What it is

`icanhaz mcp` is a stdio MCP server that is a thin client of a daemon over
the multiplexed WebSocket (`host/src/ws_client.rs`). Nothing runs in it.
Every tool call is a wRPC invocation, and the daemon's router, gates and
consent apply unchanged. It registers as a local host with a name the MCP
client gives it, so the tray says "claude-code wants …", the hosts
allowlist gates it, and pairing can remember it. The agent is a requester
like a page, never a privileged one.

Wassette (microsoft/wassette) is the nearest prior art: an MCP server that
runs components as tools. Its `component2json` crate defines the WIT to
JSON Schema mapping agents already meet; we follow it where it is sound
and depart where its runtime, which has no sessions and no grants, forced
a shortcut. See "Schemas" below.

## Two things the agent never sees

Bearer tokens stay in the MCP server process. The agent handles grant ids
(`g1`) and object ids (`o1`); a transcript never contains a token.

`request` is the only path to authority. There is no tool an agent can call
to grant itself anything (wassette's `grant-*` built-ins are exactly that).
A human decides in the tray, with the scope shown as sentences.

## The tool surface

Built-in tools, the control plane:

| Tool | Does |
|---|---|
| `capabilities` | Kinds, the interfaces each is used through, and the store's components with exports and origin. |
| `request` | Ask for a grant: a native kind with its request record, or a component interface with `provider`, `source` and `delegated` grant ids, plus a reason and an optional scope (`when`, `allow`). Returns a **pending id** at once; see "Waiting". |
| `grants`, `release` | What this session holds; revoke one. |
| `open` | Open a grant's capability: returns an object id and announces the object's method tools with `tools/list_changed`. |
| `close` | Release an object on the daemon (`resources.drop`). |
| `wait` | Poll a pending thing (a consent decision, a stream, a session) with a timeout; see "Waiting". |

Method tools, one per method of every resource the session holds,
generated from WIT at `open`. `example_links_links_index_backlinks` takes
`{"self": "o1", "note": "plan.md"}` and returns `{"result": {"ok": [...]}}`.
This is what makes the daemon's whole capability set, native and novel,
reachable by an agent with no per-capability code, and it is why there are
no hand-written convenience tools: a second, friendlier surface would drift
from the interfaces, would be one more thing to keep honest, and would hide
the grant model the generated one makes visible. If the generated
descriptor tools are verbose for an agent, the answer is a component that
exports a smaller interface over the filesystem, added to the store like
any other, not code in the MCP server.

## Waiting: consent, streams and sessions

Agents process long-running work badly when a call blocks, and well when
they can poll. So nothing here blocks past a short bound, and everything
that can take time is a pollable handle:

- `request` returns `{"pending": "p1"}` immediately. `wait(p1, timeout)`
  returns the decision when the human has made it (a grant id, or the
  denial with its sentence), else `{"pending": true}`. A client that
  supports MCP progress notifications gets one when the tray decides.
- A method returning `stream<u8>` returns `{"result": {"ok": {"stream":
  "s1"}}}`. `wait(s1, timeout, max_bytes)` returns the next chunk as text
  (or base64 when not UTF-8) with `ended` set when the stream closed.
  Nothing is drained on the agent's behalf; it reads what it asks for and
  the daemon's backpressure applies.
- A method taking `stream<u8>` takes a `{"stream": {...}}` argument:
  either `{"bytes": "..."}` for a whole input closed after, or an input
  stream id the agent writes to with `send(s, bytes)` and ends with
  `end(s)`. A PTY session (`terminal.attach`) then works: output is a
  stream the agent polls, input a stream it writes.
- A pending id, stream id or object id belongs to the session and is
  released with the session.

MCP resources: `icanhaz://grants` and `icanhaz://capabilities`, and
`icanhaz://streams/<id>` for clients that subscribe to resource updates,
which turns polling into a push for those that can.

## Schemas

Taken from component2json, because agents already know its shapes:
variant as `{"tag", "val"}`, option as `null` or the value, result as
`{"ok"}` or `{"err"}`, tuple as a fixed array, enum as a string enum, map
as `[{"key", "value"}]`, record as an object, the `{"result": ...}`
wrapper, `val0…` for multiple results, and tool names as package,
interface and function joined by underscores, validated against
`^[a-zA-Z0-9_-]{1,128}$`.

Departures:

- **Resources are inputs.** component2json makes `own<R>` and `borrow<R>`
  output-only and refuses to parse them, because its runtime instantiates
  per call. Ours has sessions: a handle is an object id, valid as `self` or
  an argument for the session's life. Every icanhaz interface is
  resource-shaped, so this is not optional.
- **Integers are `integer`**, with bounds for the narrow types; `number`
  for everything throws away information an agent uses.
- **Flags are an array of names** in both directions (component2json emits
  an object of booleans and parses an array).
- **Streams and futures** are the pollable handles above, not "an array"
  and "an object".
- **Docs come from the WIT** the component carries; the `package-docs`
  custom section is honoured when present.

## Errors

A refusal at the gate, a revoked grant, or a scope clause that does not
hold comes back as an MCP error carrying the daemon's sentence, the text
the tray shows. A `result` err is data, in the `{"err"}` arm.

## Implementation, when it happens

- `host/src/schema.rs`: WIT to JSON Schema over the `Resolve` the daemon
  already builds; a sibling of `web/tools/wit-gen.mjs`, not shared with it.
- `host/src/mcp.rs` on the official Rust MCP SDK, stdio first, streamable
  HTTP later; `icanhaz mcp --daemon ws://… --name <client>`.
- Tests: the schema emitter against the links, inference and filesystem
  interfaces; an MCP client test under auto consent that requests a
  filesystem grant, opens it, reads a file through the descriptor tools,
  polls a `watch` stream for a change, opens the links example, and is
  refused by a scope clause.
