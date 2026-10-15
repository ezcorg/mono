# Transports: QUIC first, then any protocol

A plan for an agent to take up. Written 2026-10-13 against witmproxy 0.0.8
as of commit `bfd5d63` (instances, the user scope, policy as data). Nothing
in it is built. It replaces the September survey that sat at the repository
root as `witm-quic.md`. Line numbers below are from that commit and will
drift; the names will not.

## 1. What this is for

witmproxy intercepts TLS over TCP and nothing else. HTTP/3 runs over QUIC
over UDP, and the transparent mode's answer to it today is to drop UDP 443
so the client falls back to TCP, where the proxy can see it. That depends on
the client: Chrome races and remembers, other clients wait out a timeout,
and `Alt-Svc` headers and DNS `HTTPS` records keep advertising QUIC. The
explicit mode never sees QUIC at all, since HTTP/3 through a forward proxy
is MASQUE, which clients do not speak.

The goal, in order:

1. **See HTTP/3** in transparent mode instead of forcing a fallback, with
   plugins and policy applying to it exactly as to h1 and h2.
2. **Judge every flow**, whatever it carries. UDP and non-TLS TCP are
   invisible today; policy (`src/policy/mod.rs`) already reserves `proto`
   for this and refuses anything but `tcp`.
3. **Let an ingress be something other than a socket the proxy accepted**:
   a flow steered to the proxy by a trusted party that says where it was
   going, which is what rig's guests need, and vsock later.
4. **Make the content pipeline testable without a socket.** The per-request
   logic lives in a closure typed on hyper's incoming body; the refactor
   that frees it is the prerequisite for everything above and is worth
   doing alone.

Not goals: HTTP/3 upstream (h3 is translated to h2 upstream), MASQUE
(RFC 9298), WebTransport, HTTP/3 datagrams, extended CONNECT. Refuse them.

## 2. Decisions already taken

These were settled in discussion; do not reopen them without a reason.

- Upstream stays reqwest over h1/h2. reqwest's `http3` is unstable (needs
  `--cfg reqwest_unstable`) and nothing needs it.
- QUIC interception uses nat REDIRECT on UDP 443, not TPROXY. The upstream
  is chosen from the SNI, so the proxy never needs the original destination
  for QUIC, and conntrack reverses the NAT on replies. Cost: connection
  migration breaks the mapping and that connection dies; accepted.
- 0-RTT stays off. Early data is replayable and would be forwarded upstream
  as ordinary h1/h2.
- No SNI (an IP literal, ECH) means refuse, as the TCP path passes through
  rather than guesses.
- Plugins see h3 as requests. They need not know the transport changed. All
  plugin ABI changes land in one version bump.
- A rule with no `proto` applies to every protocol, as in Tailscale. An
  existing policy that permits `api.example.com:443` therefore permits
  QUIC to it, and one that forbids a range forbids UDP to it too. That is
  the intended reading; do not make `proto` default to `tcp`.
- The transparent mode keeps its drop of UDP 443 as a mode, not a relic:
  `transparent.quic = "block"` (today's behaviour, the default),
  `"intercept"` (this plan), `"pass"` (nothing installed).
- For rig, steering happens inside the guest, which rig owns and where the
  agent is root anyway, so the host needs no root and instances stay in the
  operator's user scope. Whether rig makes the proxy a guest's only way out
  is rig's decision, taken in rig's `docs/DESIGN.md`, not here.

## 3. Where things are today

**Ingress, explicit.** `ProxyServer::start` (`src/proxy/mod.rs:181`)
accepts TCP, resolves the tenant by peer address, and dispatches: a CONNECT
goes to `handle_connect` (292), which asks the egress policy and the plugin
registry whether to intercept, then `run_tls_mitm` (699) or
`forward_connection_transparently` (329); plain HTTP goes to
`handle_plain_http` (374). Egress checks happen before the 200 to a CONNECT,
so a forbidden dial is a 403 before any tunnel.

**Ingress, transparent.** `handle_transparent_connection`
(`src/proxy/transparent.rs:371`) peeks the ClientHello,
`extract_sni_from_client_hello` (195) wants the 5-byte TLS record header,
`original_dst` (267) reads `SO_ORIGINAL_DST` (Linux, `libc`),
`should_intercept` (350) asks policy and plugins, `passthrough_target` (337)
picks the upstream from the SNI, falling back to the original destination.
`src/proxy/netfilter.rs` installs the rules: nat REDIRECT for TCP 80 and
443 on `transparent.interface` (default `tailscale0`), and DROP for UDP 443
in OUTPUT (owner not uid 0) and FORWARD; `cleanup_commands()` and the
generated `ExecStopPost` lines in `src/cli/service.rs` remove them, and the
tests there (`1515` onwards) count them. `TransparentProxyConfig`
(`src/config.rs:614`): `enabled`, `listen_addr`, `interface`,
`auto_iptables`.

**The content pipeline.** Inside `run_tls_mitm`, a `service_fn` (729) typed
on `Request<hyper::body::Incoming>` does everything per request:
`fix_origin_form_request` (645), the misdirected-host check (`misdirected`,
636), plugins, `perform_upstream` (604) through
`convert_hyper_incoming_to_reqwest_request` (`src/proxy/utils.rs:246`),
response plugins. The plain-HTTP path has a second `service_fn` (245) of the
same shape. hyper's auto server (h1/h2) drives both.

**Certificates.** `build_server_tls_for_host` (`src/proxy/utils.rs:350`,
async) builds one rustls `ServerConfig` per connection after the SNI is
known, from `CertificateAuthority::get_certificate_for_domain`
(`src/cert/ca.rs:146`, async, cache behind an async lock).

**Egress.** `src/proxy/egress.rs`: `Client {tenant, ip}`, `Egress` with
`decide` (169), `check_literal` (206), `resolve` (224), `connect` (262),
`connect_any` (277); `FilteringResolver` (292) for reqwest;
`UpstreamClients::client_for(tenant, port)` (346), one reqwest client per
(client, port). Everything is TCP.

**Policy.** `src/policy/mod.rs`: `RuleDoc.proto: Option<Vec<String>>` (97);
compile refuses anything but `tcp` (about 492, "only tcp exists") and sets
`tcp = true` when `proto` is absent; `Dial {tenant, src_ip, name, addr,
port}` (788) has no protocol; `decide(stack, dial)`.

**Plugins.** `wit/world.wit`, `package witmproxy:plugin@0.0.8`. Event kinds
(84): `connect`, `request`, `response`, `inbound-content`, `timer`; the
`event` variant (152) carries all but connect. `Connect {host, port}`
(`src/events/connect.rs`) becomes `CelConnect` for the capability's `when`
clause and gates interception; it is never handed to the guest. Plugins'
WASI context denies TCP, UDP and name lookup (`src/wasm/mod.rs`, about 876).

**Dependencies.** `quinn 0.11.9`, `h3 0.0.8`, `h3-quinn 0.0.10` are already
resolved in the workspace lockfile through `salvo 0.89.3`. reqwest `0.13.2`
with `http2`, no `http3`. `h3` is pre-1.0 and its API moves; pin it.

**rig** (`~/dev/rig`). One witmproxy instance per guest in the operator's
user scope, reached explicitly: bridge `rigproxy0`, the guest's second NIC
`proxy0` (udev names it by MAC, dhcpcd leaves it alone; `base/base.nix`),
ACL allowing TCP to the host's bridge address at that guest's port only
(`internal/policy/proxy.go`, `DesiredProxyACL`), a ufw rule for the TCP
range (`internal/proxy/firewall.go`), `GuestEnv` (`internal/proxy/proxy.go`)
setting `HTTPS_PROXY` and the bundle variables for curl, Python, nix and
git. `internal/verify` proves the NIC has its pinned address, no default
route, and cannot reach the host otherwise. `internal/vsock` exists from an
earlier design and works in both directions. The guest's first NIC carries
its egress; the proxy is not an egress boundary today.

## 4. The design

### 4.1 One flow, many ingresses

Every listener produces the same value and hands it to the same place:

```rust
pub struct Flow {
    pub client: egress::Client,        // tenant + peer address, as today
    pub proto: Proto,                  // Tcp | Udp
    pub transport: Transport,          // how it arrived, for logs and plugins
    pub dst: Dst,                      // where the client was going
}
pub enum Transport { Explicit, Transparent, Quic, Steered, Vsock }
pub enum Dst {
    Known { host: String, port: u16 },   // CONNECT, steering header, original dst
    Inferred { sni: String, port: u16 }, // from a ClientHello or a QUIC Initial
    Unknown,                             // policy decides whether that is allowed
}
```

Policy judges a `Flow` once (`Dial` gains `proto`). What follows depends on
what the flow carries:

- TLS or QUIC: open it, hand the decrypted stream to the HTTP pipeline.
- Plain HTTP: the pipeline directly, as today.
- Anything else: relay or refuse by policy, with a `flow` event for plugins
  that want to watch or refuse it. Bytes are not exposed to plugins at first.

The ingress kinds, each a module under `src/proxy/ingress/`:

| Ingress | Produces | Notes |
|---|---|---|
| explicit TCP | `Known` from CONNECT or the request line | today's `start` loop, moved |
| transparent TCP | `Inferred` from SNI, else `Known` from `SO_ORIGINAL_DST` | today's `transparent.rs`, moved |
| QUIC | `Inferred` from the ClientHello in the Initial | new, section 4.3 |
| steered | `Known` from a PROXY protocol v2 header | new, section 4.4 |
| vsock | `Known` from the header, as steered | later; rig has the client side |

### 4.2 Policy and egress with a protocol

- `RuleDoc.proto` accepts `"udp"`. Absent means every protocol (section 2).
  `checks` may name a `proto`, default both.
- `Dial.proto: Proto`; `Rule::matches` honours it; `Decision` and its
  `Display` name the protocol when the rule did.
- `Egress::connect(proto, …)`: TCP as today; UDP returns a bound socket
  connected to the chosen address. `resolve` is shared. `check_literal` and
  `decide` take the protocol.
- `--upstream-deny` is unchanged: one forbid, all protocols.
- The README's "Policy" section gains `proto` with one example per effect.

### 4.3 QUIC termination (transparent mode, `quic = "intercept"`)

1. **Redirect.** `-t nat PREROUTING -i <iface> -p udp --dport 443 -j
   REDIRECT --to-port <quic port>`, with `cleanup_commands()` and the
   `ExecStopPost` lines updated and their tests recounted. `block` keeps the
   DROP; `pass` installs nothing.
2. **One endpoint, many names.** A quinn `Endpoint` has one `ServerConfig`
   for every connection, so the certificate must come from a rustls
   `ResolvesServerCert` that mints from the SNI in the ClientHello.
   `resolve()` is synchronous and `get_certificate_for_domain` is async.
   Put a synchronous cache in front (a `std::sync::Mutex` map or
   `moka::sync`) and mint synchronously on a miss with rcgen, which is CPU
   only; share the cache with the TCP path so a name is minted once. ALPN:
   `h3` only. No SNI: refuse the handshake.
3. **Early data off.** Assert `max_early_data_size == 0` in a test; do not
   rely on the default.
4. **HTTP/3.** `h3::server::Connection` over `h3_quinn`, yielding
   `(Request<()>, RequestStream)` per request. An adapter turns
   `RequestStream::recv_data` into an `http_body::Body<Data = Bytes>`; the
   response goes back as `send_response`, then `send_data`, then trailers.
   Both feed the generic handler of 4.5.
5. **Refuse** extended CONNECT, WebTransport and datagrams with the h3 error
   code for "not supported"; log once per connection.
6. **SNI from an Initial** (needed only for the `pass` mode and for logging
   before the handshake; not for `intercept`, where rustls parses the hello):
   derive the Initial keys from the Destination Connection ID with the
   version's salt (RFC 9001 §5.2 for v1, RFC 9369 for v2; drop unknown
   versions), remove header protection, decrypt AES-128-GCM, and reassemble
   CRYPTO frames across packets, because a post-quantum key share pushes the
   ClientHello past one datagram. Split `extract_sni_from_client_hello` so
   it can take a bare Handshake message without the record header. Defer
   this item unless `pass` is wanted; `intercept` does not need it.
7. **`Alt-Svc`.** With `block`, strip `Alt-Svc` from intercepted responses
   beside `strip_proxy_headers` (`src/proxy/utils.rs`), so clients stop
   learning about HTTP/3 from the proxy. With `intercept`, leave it.

### 4.4 Steered ingress (PROXY protocol v2)

A listener that accepts a PROXY protocol v2 header from a configured set of
trusted sources (`steer.trusted = ["10.207.0.0/24"]`), reads the original
source and destination from it, and continues as the transparent path would
with `Dst::Known`. v2 carries the transport (`STREAM` or `DGRAM`), so one
listener describes TCP and UDP flows. The header is a claim by the steerer;
policy judges the destination anyway, so a false claim only changes what
the client is judged as asking for. Refuse a header from an untrusted
source, and a connection from a trusted source without one.

This is what lets a user-scope instance be transparent without root on the
host: whoever owns the client side (rig, in the guest) does the netfilter
work and tells the proxy where the flow was going.

### 4.5 The generic handler

Lift the body of the `service_fn` in `run_tls_mitm` into

```rust
pub(crate) async fn handle_decrypted_request<B>(
    req: Request<B>, flow: &Flow, ctx: &RequestContext,
) -> Response<UnsyncBoxBody<Bytes, ErrorCode>>
where B: http_body::Body<Data = Bytes> + Send + 'static
```

and make `fix_origin_form_request` and
`convert_hyper_incoming_to_reqwest_request` generic over `B`. Check whether
`WasiRequest::from_http` takes an arbitrary body; its call site suggests it
does. The plain-HTTP `service_fn` calls the same function. This is the
first phase and stands alone: it makes the pipeline testable with an
in-memory body and no TLS socket.

### 4.6 Relay and refuse

For a flow policy permits that carries nothing the proxy understands:

- TCP: bidirectional copy, as `forward_connection_transparently` does.
- UDP: a flow table keyed by the four-tuple, one upstream socket per entry,
  an idle timeout (default 30s, configurable), and a cap on entries per
  client. Datagrams are copied both ways with no reassembly.

Both log open and close with the decision that permitted them, in the same
shape as a refused flow, so `witm proxy log` and rig's `proxy log` read the
same for every protocol.

### 4.7 Plugin ABI (one bump, to `witmproxy:plugin@0.1.0`)

- `connect` gains `proto` (`tcp` | `udp`) and `transport`; `CelConnect`
  exposes them (`connect.proto()`, `connect.transport()`).
- A new event kind `flow` with a record `{client, dst, proto, transport}`
  and a capability that may refuse it. No bytes.
- `request` records nothing new: h3 is indistinguishable, by decision.
- Every plugin in the workspace rebuilds; rig's plugin (`plugin/` in the rig
  repository, `make plugin`) rebuilds and its signed build is recommitted.

### 4.8 rig, if rig chooses to

Sketch only; the decision and its record belong to rig.

- Steering in the image (`base/base.nix`): an nftables table that sends
  outbound TCP and UDP to the ports policy will allow, 443 at least, out of
  `proxy0` to the host's bridge address at the guest's port, wrapped in a
  PROXY protocol v2 header by a small relay unit, or by nftables alone for
  QUIC where the SNI suffices. The agent is root in the guest and can undo
  this, so it is enforcement only together with a closed egress ACL on the
  first NIC.
- The bridge ACL and the ufw rule each gain a UDP twin on the same port
  range; `countBlocked` reads `PROTO=UDP` too.
- Trust: `GuestEnv`'s variables cover curl, Python, nix and git but not
  every tool, and NixOS's system bundle is in the store, read-only. The
  open question is how a per-instance CA becomes system trust at start; one
  answer is a rig root CA made once per host, baked into the image's trust
  at `rig image build`, with each guest's witmproxy CA issued under it,
  which needs witmproxy to accept an imported CA and key.
- `rig verify` gains: steering rules present, egress on the first NIC
  closed, QUIC to a permitted host succeeds through the proxy, QUIC to a
  forbidden host is refused. `rig doctor` probes with an HTTP/3 client in
  the guest (nixpkgs' curl with HTTP/3) and reads `rig proxy log`.

## 5. Phases

Each phase is useful on its own and lands with tests.

| Phase | Delivers | Done when |
|---|---|---|
| P0 foundation | `Flow`, the generic handler (4.5), `proto` in policy and egress (4.2), ingress modules moved not changed | every existing test passes; a new test drives a request through the handler with an in-memory body; a policy test permits `udp` and reads an absent `proto` as both; no ABI change |
| P1 QUIC | `transparent.quic`, the resolver, the REDIRECT, h3 server, refusals, `Alt-Svc` strip in `block` (4.3) | an e2e case in `e2e/` runs an HTTP/3 request through a network namespace with the rules applied and a plugin sees it as a request; the same URL over TCP still works; with `block` a QUIC-only request fails and TCP succeeds; 0-RTT asserted off |
| P2 steered | PROXY v2 listener with trusted sources (4.4) | e2e: a header from a trusted source is honoured, from an untrusted one refused, a UDP flow judged by policy |
| P3 ABI | 4.7, plugins rebuilt | all workspace plugins build; rig's plugin rebuilt and resigned |
| P4 rig | rig's own decision and design entry (4.8) | out of this repository's hands |
| P5 DNS | a DNS module: name-level policy at resolution, pinned answers; DoH and DoQ later | a guest resolving a forbidden name gets a refusal; a permitted one gets the address the proxy will dial |
| P6 relay | 4.6 with TPROXY for root-mode transparent on arbitrary ports | e2e: a permitted non-TLS TCP flow and a UDP flow relayed and logged; a forbidden one refused |

Rough size: P0 two to three days; P1 one to two weeks, most of it the
resolver, the h3 adapter and the e2e harness; P2 two days; P3 one day plus
every plugin; P5 and P6 a week each.

## 6. Testing

- Unit: the policy `proto` matrix; the synchronous certificate cache; the
  h3 body adapter with trailers; `countBlocked`-style parsers for UDP; if
  4.3 item 6 is built, the Initial parser against captured hellos including
  a post-quantum one that spans two datagrams.
- e2e (`e2e/`): a network namespace with the transparent rules; clients
  are curl built with HTTP/3 (`curl --http3-only`) or a small quinn/h3
  client in the test crate. The negative cases are the point: `block` still
  blocks, `intercept` refuses no-SNI and 0-RTT, a forbidden destination is
  refused over QUIC as over TCP.
- The workspace lints treat a panic in a connection task as a
  denial-of-service vector (root `Cargo.toml`). Every parser here faces an
  untrusted client; keep `indexing_slicing` and friends at deny and test
  truncated input.

## 7. Risks and open questions

- `h3 0.0.8` is pre-1.0; expect API churn on upgrade. Pin, and keep the
  adapter small.
- The synchronous resolver cache and the async cache must not diverge; the
  cleanest end state is one synchronous cache used by both paths.
- QUIC in userspace costs more CPU than kernel TCP with TLS; rig runs an
  instance per guest, so measure before making `intercept` a default
  anywhere.
- Connection migration under REDIRECT kills the connection; a VM rarely
  changes address, a laptop on `tailscale0` might.
- Judgment happens after the handshake for QUIC, as for TLS in transparent
  mode, rather than before any bytes as CONNECT allows. The 403 before a
  tunnel has no QUIC equivalent; a refusal is a closed connection with an
  error code.
- For rig, system-wide trust distribution on NixOS at runtime is the real
  unknown (4.8).
- Whether `flow` events should ever carry bytes. Not until a plugin needs
  them.

## 8. References

- RFC 9000 (QUIC), 9001 (TLS for QUIC), 9114 (HTTP/3), 9369 (QUIC v2),
  9298 (MASQUE connect-udp, skipped).
- The PROXY protocol, version 2 (HAProxy), including `DGRAM` transports.
- This repository: `README.md` "Policy: who may dial what" and the
  transparent mode section; `src/policy/mod.rs` module docs.
- rig: `docs/DESIGN.md` entries of 2026-10-08 and 2026-10-09 for how the
  per-guest proxy came to be; `docs/DEV_NOTES.md` for the bridge, the ACL
  and the firewall facts.
