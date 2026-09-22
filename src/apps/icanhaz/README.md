# `icanhaz`

> a system-wide capability daemon: web apps, editors and agents reach the
> **real** capabilities a machine has (its files, processes, shell, models,
> change notifications), each one consented, scoped, revocable and shareable.

Built on **NoCap** (Negotiated Object-Capability Protocol): a requester asks
for a capability by kind, a human grants it with a scope, and what comes back
is an object that *is* the capability. `icanhazd` is the daemon; the tray app
in `app/` embeds it and is the consent surface; `web/` is the browser client
the markdown editor uses.

What remains, and the designs not yet built (an MCP front), are in
`docs/next.md` and `docs/mcp.md`. The design of record is the platform RFC (`src/typescript/markdown-editor/docs/gap-analysis-and-platform-rfc.md`,
§13 scoping, §14 authoring, §15 import resolution, §16 work plan). This file
is the map of what is built.

## Everything is a component

Every capability the daemon serves is a **WebAssembly component** served over
**wRPC**, and every capability interface is **resource-shaped**: the grant
token is presented once, at `open(grant)`, and the object returned carries no
token in its methods. The daemon keeps that object for the connection that
acquired it and admits each method under the grant it was opened with.

```
browser / editor / agent ──wRPC──▶ router ──▶ [wrapper …] ──▶ shipped capability ──▶ raw host layer
                                     │                                                 (icanhaz:nocap/gate-*,
                                     └─ handle registry, one per daemon                 process-raw, pty, notify,
                                        (icanhaz:nocap/resources.drop)                  providers, jail)
```

- **Shipped capabilities** live in `capabilities/<name>/`, one crate each:
  `filesystem` (real `wasi:filesystem@0.2` over wRPC, jailed to the daemon's
  root), `process`, `terminal`, `watch`, `workspace`, `inference`. Each imports
  only WASI and the raw host layer declared in `wit/host.wit`, which the daemon
  implements in `host/src/raw.rs` from its native providers.
- **Wrappers and chains.** A grant can be *provided through* components chosen
  at consent (`via`). The daemon composes them with `wac` in front of the
  shipped capability and instantiates the composition in its own store; the
  chain lives while a grant names it. A wrapper refuses, rewrites or audits
  without the capability knowing.
- **Novel capabilities** are components added to the store (`icanhaz
  capability add`) exporting an interface nothing native provides. They are
  served through the same router, and their imports of native capabilities
  are satisfied by composing the shipped components in, running under grants
  the requester **delegates** to them.
- **Getting components.** The store is content-addressed. A component can be
  added from a file, pulled from an OCI registry (`oci://ghcr.io/org/name:tag`,
  the tag resolved to a digest once and recorded as provenance), or fetched
  from another daemon by hash over iroh. A request may name its provider by
  hash together with a source; a daemon that lacks it fetches it, checks the
  bytes against the hash, and only then shows the consent card, where the
  component's origin is visible. Fetching grants nothing: installing is for
  the local user and approved hosts, and authority comes only from consent.
  Pulls sign in with the credential configured for the registry host
  (`registries` in the tray's settings), else the one the Docker client keeps
  for it, else anonymously.
- **Serving components.** With `ICANHAZ_REGISTRY_BIND` set, the daemon serves
  its store as an OCI registry: `icanhaz capability publish <hash> name:tag`
  makes a held component pullable as `oci://<bind>/name:tag` by `wkg`, `oras`,
  wassette or another icanhaz, and a push lands in the store like `add`. It
  holds capability components and nothing else: a pushed layer must validate
  under the same rule as `add`. Every request, pull or push, needs the
  `registry` credential from the tray's settings, since a component's bytes
  are their author's; the registry serves nothing until it is set.
- **Scopes** are CEL clauses (`ezco:ezcap`) over an environment generated from
  the interface's WIT: `call.method`, `call.args.*`, `state.*`, `time`. They
  narrow only, render as sentences in the consent window, and are checked at
  the gate on every operation.
- **Sharing.** A grant travels as a signed certificate bound to an audience;
  redeemed at the issuing broker (locally, or over **iroh** from another
  machine) it becomes a grant of the recipient's own, and calls on it are
  forwarded to the broker that holds the source.

## Repository layout

```
src/apps/icanhaz/
  wit/            the daemon's WIT: broker, components, configuration, the
                  capability interfaces, host.wit (raw layer), nocap.wit (types,
                  resources.drop); deps/ fetched by `wkg wit fetch` (git-ignored)
  broker/         icanhaz-broker: grant store, scopes, certificates, consent,
                  pairings, durable state (also embedded by witmproxy)
  host/           icanhaz-host: the daemon (serving layer, router, raw layer,
                  providers, component store, scaffold) and the binaries
    src/bin/icanhazd.rs   the headless daemon
    src/bin/icanhaz.rs    the CLI (capability inspect|add|list|get|compose|new|wrap)
    fixtures/             test fixtures and the crates they are built from
    templates/            what `icanhaz capability new|wrap` scaffolds
  capabilities/   the shipped capability components (wasm32-wasip2 crates)
  examples/       capabilities authored the way a user would (links: backlinks
                  for a vault of notes, over a delegated filesystem grant)
  app/            the tray app (Tauri): embeds the daemon, consent window,
                  grants, configuration, the component store
  web/            @joinezco/icanhaz-web: the browser client (wRPC over one
                  multiplexed WebSocket or WebTransport), generated stubs,
                  the VFS over the filesystem capability, the terminal block,
                  the remote LSP provider, share bundles; browser tests
```

## Running it

Build the wasm guests once (the shipped capabilities and the test fixtures,
from the daemon's WIT; needs `wkg` and the `wasm32-wasip2` target):

```sh
src/apps/icanhaz/scripts/build-wasm.sh
```

Then either the tray app (`cd src/apps/icanhaz/app && pnpm tauri dev`) or the
headless daemon:

```sh
ICANHAZ_CONSENT=auto cargo run --bin icanhazd
```

`icanhazd` reads `ICANHAZ_WS_BIND`, `ICANHAZ_WT_BIND`, `ICANHAZ_ROOT` (the
filesystem jail), `ICANHAZ_CAPABILITIES_DIR`, `ICANHAZ_CONSENT`
(`auto` | `deny` | `approve` over `ICANHAZ_APPROVE_BIND`), `ICANHAZ_PAIRINGS`,
`ICANHAZ_HOSTS`, `ICANHAZ_DB` and `ICANHAZ_DB_KEY`, `ICANHAZ_IROH` (`0` to skip
the peer endpoint), `ICANHAZ_REGISTRY_BIND` to serve the daemon's own OCI
registry (off unless set), `ICANHAZ_CERT` and `ICANHAZ_KEY` for WebTransport
TLS, and `ICANHAZ_ECHO=1` for a loopback inference model.

## Tests

```sh
src/scripts/check-icanhaz.sh                      # what CI runs: lint, the wasm guests, host + broker tests
cargo test -p icanhaz-host -p icanhaz-broker     # host: each capability, routing, chains, handles, iroh, scaffold
cd src/apps/icanhaz/web && pnpm test:browser      # browser: starts its own daemon on free ports
```

The browser suite builds `icanhazd`, launches it with auto consent, a
throwaway jail and the echo model, and exercises every capability end to end
from a real page. Fixture components under `host/fixtures/` are committed;
see the README there.

## Authoring a capability

```sh
icanhaz capability wrap icanhaz:nocap/process@0.1.0   # a wrapper: forwards every method, ready to refuse or rewrite
icanhaz capability new mine --export example:mine/mine@0.1.0 --wit ./wit   # a novel capability
cargo build --release --target wasm32-wasip2 --target-dir target
icanhaz capability inspect target/wasm32-wasip2/release/<crate>.wasm
icanhaz capability add     target/wasm32-wasip2/release/<crate>.wasm
icanhaz capability add     oci://ghcr.io/org/name:tag        # pulled by the daemon; the tag resolves to a digest once
icanhaz capability add     'iroh:<key>?addr=…#sha256:<hex>'  # a component another daemon holds
icanhaz capability publish <hash> acme/name:v1          # served by this daemon's registry (ICANHAZ_REGISTRY_BIND)
icanhaz capability published                            # the tags it serves
```

A scaffold vendors the daemon's WIT, generates the `Guest` impls (resource
wrappers included) and an `AGENTS.md` with the rules: imports are capabilities
only, authority comes from the grant, keep the WIT's asyncness. Once added,
the component is offered in the consent window for every grant kind it gates.
`examples/links` is a complete one: a backlinks index the editor's demo
drives, tested from a page through the real daemon.

The realistic path, with a second daemon as the publisher: it serves its
registry with the component published, the daemon behind the demo has a
credential for that registry, and the page names the component by hash and
source. Nothing of the publisher's is used remotely; the index runs on the
consumer over its own vault.

```sh
src/apps/icanhaz/scripts/demo-publisher.sh      # starts the publisher, publishes links, configures the consumer, prints the demo URL
```

The URL it prints carries `links-provider` (the hash) and `links-source`
(the `oci://` reference); the consumer fetches the component, checks the
hash, and shows the consent card with where it came from. The browser suite
runs the same flow: its harness starts a publisher beside the test daemon.

Configuration from the command line, for scripts and headless daemons:

```sh
icanhaz capability configure registry default username=me password:secret=pw   # the served registry's credential
icanhaz capability configure registries ghcr.io username=me password:secret=tok # a credential for another registry
icanhaz capability unconfigure registries ghcr.io
```

The `icanhaz` command talks to a daemon over its multiplexed WebSocket, the
same framing a page uses.

## The tray

Capabilities are a list; opening one shows the interfaces a grant of that
kind is used through (derived from the store), the components that can
provide it, and its settings. A store component's page shows its hash,
origin, what it provides, and its exports and imports. The daemon's own
registry credential and the credentials for other registries live under
Settings.
