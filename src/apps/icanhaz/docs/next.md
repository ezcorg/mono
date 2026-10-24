# What is next in icanhaz

The design of record is the platform RFC
(`src/typescript/markdown-editor/docs/gap-analysis-and-platform-rfc.md`,
§13 to §16). This is the list of what remains, as of 2026-09-22, with why
each is deferred where it is. Landed work is described in the README and
the RFC's milestone statuses, not here.

## Decided, not started

- **The MCP front.** `docs/mcp.md`. Deferred on purpose: the waiting model
  (consent, streams, sessions as pollable handles) wants more thought
  before code.
- **An `http` capability.** Deferred deliberately: outbound HTTP is the
  exfiltration channel, and a grant over it needs a scope model (hosts,
  methods, bodies, budgets) that is designed rather than allow-listed.
  wassette's example catalogue (weather, GitHub, arXiv) is the corpus to
  test it against once it exists.
- **Scaffolds in other languages** (JavaScript, Python, MoonBit). The Rust
  scaffold handles resources; the others are `icanhaz capability new
  --lang`.
- **Reproducible-build attestation.** The store carries `provenance` and a
  `reproducible` flag nobody sets. The design: a daemon identity rebuilds
  from the provenance and signs a statement over the hash; the consent card
  shows who attested. The store never builds.
- **A share-bundle entry for a component reference.** A bundle today
  carries certificates ("use mine, where it lives"). The other kind of
  sharing, "here is the component, ask your own daemon for it", is a
  bundle entry with the interface, provider hash and source, opened by a
  page as a component request. The request side exists; the bundle format
  and `openBundle` do not. Waits on the editor consuming novel
  capabilities (see the editor brief).
- **A peer's novel capability used where it lives.** Certificates and
  `redeem-at` forward inference and process calls to another daemon; a
  novel interface (`example:links/links`) is not forwarded yet. Needs the
  generic forwarding the shipped kinds have, plus the peer's consent to
  what a remote may ask of its vault.

## Small and known

- The tray's capability descriptors (`broker/src/capabilities.rs`: id,
  icon, descriptions) are presentation metadata kept in the source. Their
  identity is derived from the store; only the words are not.
- The tray has no page for what the registry publishes; `icanhaz
  capability published` is the only view.
- Registry pulls are anonymous-or-basic. Bearer tokens from `docker login`
  are honoured for pulling; the served registry issues none.
- The served registry speaks plain HTTP, so its Basic credential crosses
  the wire in the clear beyond loopback. On a tailnet that is the tailnet's
  encryption; anywhere else put it behind a TLS proxy, or give it a
  certificate the way the WebTransport listener has one. A consumer reaches
  a registry on its own machine over HTTP without being told; a plain-HTTP
  registry elsewhere needs `http` set on its `registries` entry.
- The browser runtime reports a call the daemon refused as `NoReply`
  without the reason, since wRPC carries no error frame for a refused
  route. The reason is in the daemon's log. A diagnostic side channel is
  worth designing if this bites.
- The `icanhaz` CI workflow has not run on a pull request yet; its first
  macOS run exercises the terminal test against the runner's shell.
- The editor has no wikilink syntax; the links example treats `[[name]]`
  as text and markdown links as primary.

## Known good, worth keeping in mind

- No store has WASI preopens; file authority enters only through
  `jail.open(grant)`. Keep it that way when adding a capability.
- A novel interface's methods are admitted under their bare name, the way
  the environment generated from the WIT declares them.
- Fixture and example crates vendor the daemon's WIT; `scripts/build-wasm.sh`
  refreshes and rebuilds all of them, and CI runs it.
