//! The **consent broker** — the NoCap gate. Authority is never ambient: a caller
//! must `request` a capability, which raises a **consent decision** on the host;
//! on approval it is issued an unforgeable bearer **grant token** (a secret +
//! its caveats, recorded host-side). The capability interfaces then require that
//! token — [`GrantStore::validate`] is the gate every one of them calls before
//! acting. Grants are scoped (kind · expiry) and revocable.
//!
//! Consent is **pluggable** ([`Consent`]): the gate calls `decide`, so the
//! protocol + grant machinery are identical whether approval comes from a test
//! stub, a CLI prompt, or (later) a permission-dialog UI. This module proves the
//! request → consent → scoped-grant flow; wiring the capabilities to *demand* a
//! grant is the next layer.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use anyhow::Context as _;
use futures::stream::select_all;
use futures::StreamExt as _;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::AsOrigin;

pub mod bindings {
    wit_bindgen_wrpc::generate!({
        world: "broker-wrpc",
        path: "../wit",
        // `types` references `wasi:clocks` (caveat::expires(datetime)); generate
        // those bindings inline rather than expecting them already in scope.
        with: {
            "wasi:clocks/wall-clock@0.2.0": generate,
            // The shared scope record (`ezco:ezcap/types.scope`) the scoped
            // request and `narrow` take.
            "ezco:ezcap/types@0.1.0": generate,
        },
    });
}

/// The generated wRPC **client** stub for the broker (`request`/`granted`/`revoke`).
pub use bindings::icanhaz::nocap::broker as client;

/// The `grant` record the handler returns (`{ token, pairing }`) — aliased so it
/// doesn't collide with the internal [`Grant`] (a stored grant's authority).
use bindings::exports::icanhaz::nocap::broker::Grant as GrantReply;

// Re-exported for the capability gate: a provider names `CapabilityKind` to say
// which kind a presented grant must authorise. `TerminalRequest` is re-exported
// for constructing terminal wants (tests, the daemon).
use bindings::exports::icanhaz::nocap::broker::Audience as AudienceWire;
/// The wire form of `ezco:ezcap/types.scope` (the generated record), distinct
/// from [`ezcap::Scope`], which the store works with.
use bindings::ezco::ezcap::types::Scope as ScopeWire;
pub use bindings::icanhaz::nocap::types::{
    CapabilityKind, FsRequest, FsRights, InferenceRequest, PathGrant, ProcessRequest,
    TerminalRequest,
};
use bindings::icanhaz::nocap::types::{Denied, GrantInfo, Principal, PrincipalKind};
use bindings::icanhaz::nocap::types::{Endpoint, SocketRequest, Transport};
/// The call a native handler submits for admission (`ezcap::Call`).
pub use ezcap::Call as AdmitCall;
use ezcap::{Audience, Certificate, Keypair, Membranes, Narrowing, Presented, Scope as EzScope};

/// The outcome of asking a human (or a stand-in) for consent.
pub enum Decision {
    /// Grant `grant` — the possibly-**attenuated** capability the human approved (a
    /// subset of what was requested; the auto/CLI paths approve as-requested) — valid
    /// for `ttl`. `remember` ⇒ pair the origin (durable consent — skip the prompt next
    /// time); else a one-time grant.
    Approve {
        grant: CapabilityKind,
        /// Clauses the human added. Applied as `requested && extra`, so a
        /// surface can only ever tighten a scope, never rewrite it.
        narrowing: Option<Narrowing>,
        ttl: Duration,
        remember: bool,
    },
    /// Refuse it, with the reason the requestor sees.
    Deny(Denied),
}

/// Default grant lifetime. (A richer consent UI would let the human choose.)
const GRANT_TTL: Duration = Duration::from_secs(600);

/// How long the approval surface waits for a human before giving up (⇒ deny).
const CONSENT_TIMEOUT: Duration = Duration::from_secs(120);

/// How the host decides on a request. `decide` is `async` so a real prompt can
/// await a human; the auto variants resolve immediately (tests / headless runs).
/// New mechanisms (a permission-dialog UI, a paired device) slot in as variants
/// without touching the protocol or the grant store.
#[derive(Clone)]
pub enum Consent {
    /// Approve everything (dev / tests / headless).
    AutoApprove,
    /// Refuse everything (tests).
    AutoDeny,
    /// Ask a human at the daemon's console — a real per-request decision. The
    /// `Mutex` serializes prompts so concurrent requests don't interleave on the
    /// shared tty; a closed/absent stdin (a detached daemon) reads EOF ⇒ deny.
    CliPrompt(Arc<tokio::sync::Mutex<()>>),
    /// Ask a human via the **approval surface** (notification + the daemon's own
    /// loopback page) — the path for a backgrounded daemon. See [`crate::approve`].
    Surface(crate::approve::PendingConsent),
}

impl Consent {
    /// A console consent prompt — the default for an interactively-run daemon.
    pub fn cli_prompt() -> Self {
        Consent::CliPrompt(Arc::new(tokio::sync::Mutex::new(())))
    }

    pub async fn decide(
        &self,
        want: &CapabilityKind,
        scope: &EzScope,
        reason: &str,
        requester: &str,
    ) -> Decision {
        match self {
            Consent::AutoApprove => Decision::Approve {
                grant: want.clone(),
                narrowing: None,
                ttl: GRANT_TTL,
                remember: true,
            },
            Consent::AutoDeny => Decision::Deny(Denied::UserRejected),
            Consent::CliPrompt(lock) => cli_decide(lock, want, scope, reason, requester).await,
            Consent::Surface(pending) => {
                surface_decide(pending, want, scope, reason, requester).await
            }
        }
    }
}

/// Map a human's typed reply to a decision — **fail-closed**: only an explicit
/// `y`/`yes` approves; everything else (incl. empty / EOF) denies.
fn decision_from_reply(reply: &str, want: &CapabilityKind) -> Decision {
    match reply.trim().to_ascii_lowercase().as_str() {
        "y" | "yes" => Decision::Approve {
            grant: want.clone(),
            narrowing: None,
            ttl: GRANT_TTL,
            remember: true,
        },
        _ => Decision::Deny(Denied::UserRejected),
    }
}

/// Prompt the human at the daemon's console and await their decision. Serialized
/// on `lock` so concurrent requests queue rather than interleave on the tty.
async fn cli_decide(
    lock: &Arc<tokio::sync::Mutex<()>>,
    want: &CapabilityKind,
    scope: &EzScope,
    reason: &str,
    requester: &str,
) -> Decision {
    use std::io::Write as _;
    use tokio::io::AsyncBufReadExt as _;

    let _guard = lock.lock().await;
    let text = ScopeText::of(scope);
    let mut lines = String::new();
    for w in &text.when {
        lines.push_str(&format!("│ when      : {w}\n"));
    }
    for a in &text.allow {
        lines.push_str(&format!("│ only if   : {a}\n"));
    }
    eprint!(
        "\n┌─ icanhaz consent ──────────────────────────────\n\
         │ requester : {}\n\
         │ wants     : {}\n\
         {}\
         │ reason    : {}\n\
         └ approve? [y/N] ",
        requester,
        summarize(want),
        lines,
        reason,
    );
    let _ = std::io::stderr().flush();

    // One line from the console. (Interactive use only — a fresh reader per
    // prompt may drop type-ahead, which a human at a prompt won't produce.)
    let mut line = String::new();
    let mut stdin = tokio::io::BufReader::new(tokio::io::stdin());
    match stdin.read_line(&mut line).await {
        Ok(0) | Err(_) => Decision::Deny(Denied::UserRejected), // EOF / no tty ⇒ deny
        Ok(_) => decision_from_reply(&line, want),
    }
}

/// Ask via the approval surface: notify, park the request, and await the human's
/// decision (deny on timeout). The decision is delivered by [`crate::approve`]
/// when the human clicks Approve/Deny on the daemon's own loopback page.
async fn surface_decide(
    pending: &crate::approve::PendingConsent,
    want: &CapabilityKind,
    scope: &EzScope,
    reason: &str,
    requester: &str,
) -> Decision {
    let id = mint_token();
    let req = crate::approve::PendingRequest {
        id: id.clone(),
        requester: requester.to_string(),
        summary: summarize(want),
        reason: reason.to_string(),
        want: want.clone(),
        scope: scope.clone(),
    };
    pending.alert(&req);
    let rx = pending.park(req);
    match tokio::time::timeout(CONSENT_TIMEOUT, rx).await {
        Ok(Ok(Some(approval))) => {
            // The surface may return an attenuated grant; `narrow` clamps it to a
            // subset of `want` regardless (a surface can only ever *narrow*). `None`
            // ⇒ approve as-requested (the loopback page does no attenuation).
            let grant = match approval.grant {
                Some(g) => narrow(want, &g),
                None => want.clone(),
            };
            Decision::Approve {
                grant,
                narrowing: approval.narrowing,
                ttl: Duration::from_secs(approval.ttl_secs),
                remember: approval.remember,
            }
        }
        // Timed out, denied, or the surface dropped the sender ⇒ fail closed.
        _ => {
            pending.remove(&id);
            Decision::Deny(Denied::UserRejected)
        }
    }
}

/// The authority behind a token: what was granted, to whom, and when it lapses.
struct Grant {
    kind: CapabilityKind,
    /// How calls on this grant may be used (`ezco:ezcap/types.scope`). The
    /// provider parameters in `kind` say what was instantiated; this says how
    /// it may be called. Narrowing only ever conjoins clauses.
    scope: EzScope,
    /// The membrane instance evaluating `scope` (see [`Membranes`]); `None`
    /// for a kind with no admission environment, which only an unrestricted
    /// scope may have.
    instance: Option<ezcap::InstanceId>,
    /// The grant this one was narrowed from, if any.
    parent: Option<String>,
    summary: String,
    expires: Instant,
    /// Who holds it — the requesting principal at consent time.
    principal: Principal,
    /// Fired when the grant is revoked. Streaming capabilities (terminal / process /
    /// watch) await this (via [`Revocation`]) to tear their live session down; the
    /// filesystem re-validates per op. Both observe the same grant lifetime.
    cancel: CancellationToken,
}

/// A signal that fires when a grant becomes invalid — explicitly **revoked**, or
/// **expired**. A streaming capability awaits [`Revocation::cancelled`] to end its
/// output stream + release its resource (kill the child / PTY shell, stop the fs
/// watcher). Obtained from [`GrantStore::revocation`] at session start.
pub struct Revocation {
    cancel: CancellationToken,
    expires: Instant,
}

impl Revocation {
    /// Resolves the instant the grant is no longer valid (revoked or expired).
    pub async fn cancelled(self) {
        tokio::select! {
            _ = self.cancel.cancelled() => {}
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(self.expires)) => {}
        }
    }
}

/// The per-kind admission membranes (`ezcap::Membranes`), over the CEL
/// environments `build.rs` generated from `../wit`: a scope is type-checked
/// against the real interface when a grant is issued, and its `allow` clause
/// is evaluated before every native operation on that grant. A kind with no
/// environment (`sockets`, until it has an interface) admits only
/// unrestricted scopes.
fn builtin_membranes() -> Membranes {
    static ENVS_JSON: &str = include_str!(concat!(env!("OUT_DIR"), "/ezcap-envs.json"));
    // `tokens` / `day_tokens`: the inference capability's spend counters
    // (this grant's, and today's through the provider). Declared on every
    // kind, since a scope names only what its holder uses.
    Membranes::from_json(ENVS_JSON, &["tokens", "day_tokens"])
        .unwrap_or_else(|e| panic!("ezcap environments generated by build.rs: {e}"))
}

fn is_unrestricted(scope: &EzScope) -> bool {
    scope.when.trim() == "true" && scope.allow.trim() == "true"
}

/// `ezco:ezcap/types.scope` off the wire.
pub fn scope_from_wire(s: &ScopeWire) -> EzScope {
    EzScope {
        when: s.when.clone(),
        allow: s.allow.clone(),
    }
}

/// A `narrow` argument off the wire: a field of `"true"` (or empty) leaves
/// that field of the parent's scope unchanged.
fn narrowing_from_wire(s: &ScopeWire) -> Narrowing {
    let opt = |v: &str| match v.trim() {
        "" | "true" => None,
        other => Some(other.to_string()),
    };
    Narrowing {
        when: opt(&s.when),
        allow: opt(&s.allow),
    }
}

/// The caller a native handler binds for `caller.*` clauses: today only the
/// transport-attested origin; the peer key joins when the iroh transport does.
pub fn caller_of(cx: &impl AsOrigin) -> ezcap::Caller {
    ezcap::Caller {
        origin: cx.origin().map(str::to_string),
        ..Default::default()
    }
}

/// A denial as the string the capability interfaces return. An out-of-scope
/// denial carries the scope as sentences, which is what the guest should show.
pub fn denied_text(denied: &Denied) -> String {
    match denied {
        Denied::OutOfScope(sentences) => format!("out of scope: {sentences}"),
        Denied::InvalidScope(msg) => format!("invalid scope: {msg}"),
        other => format!("{other:?}"),
    }
}

/// The live set of issued grants, keyed by their (secret) token. Shared between
/// the broker (which mints into it) and the capabilities (which `validate`
/// against it, and `admit` each call through the grant's membrane instance).
pub struct GrantStore {
    grants: HashMap<String, Grant>,
    membranes: Membranes,
    /// Sturdy references: the unguessable id a certificate names → the grant
    /// it was issued on. A certificate never carries the bearer token.
    sturdy: HashMap<String, String>,
    /// This broker's signing key: certificates are issued under it and only
    /// ones it issued are redeemed here. Ephemeral until the daemon installs
    /// the persisted one ([`GrantStore::set_identity`]).
    identity: Keypair,
    /// Where certified grants persist (`broker/grant:<token>` rows), so the
    /// certificates on them survive a daemon restart. `None` = in memory.
    persist: Option<crate::store::Store>,
}

/// A certified grant's durable form. Bearer tokens are the row key; the
/// store is encrypted, and these rows are what pairings already were.
#[derive(Serialize, Deserialize)]
struct DurableGrant {
    kind: serde_json::Value,
    scope: EzScope,
    parent: Option<String>,
    summary: String,
    expires_unix: u64,
    principal: (String, String, Option<String>),
    /// The sturdy ids certificates on this grant name.
    sturdy: Vec<String>,
}

fn kind_to_json(k: &CapabilityKind) -> serde_json::Value {
    use serde_json::json;
    match k {
        CapabilityKind::Filesystem(fs) => {
            json!({"filesystem": {"roots": fs.roots.iter().map(|r| json!({"path": r.path, "rights": r.rights.bits()})).collect::<Vec<_>>()}})
        }
        CapabilityKind::Sockets(s) => {
            json!({"sockets": {"may_listen": s.may_listen, "allow": s.allow.iter().map(|e| json!({"host": e.host, "lo": e.lo_port, "hi": e.hi_port, "udp": matches!(e.proto, Transport::Udp)})).collect::<Vec<_>>()}})
        }
        CapabilityKind::Process(p) => {
            json!({"process": {"image": p.image, "args": p.args, "guest_chooses_argv": p.guest_chooses_argv}})
        }
        CapabilityKind::Terminal(t) => json!({"terminal": {"shell": t.shell, "jailed": t.jailed}}),
        CapabilityKind::Inference(i) => json!({"inference": {"models": i.models}}),
    }
}

fn kind_from_json(v: &serde_json::Value) -> Option<CapabilityKind> {
    let str_of =
        |v: &serde_json::Value, k: &str| v.get(k).and_then(|s| s.as_str()).map(str::to_string);
    let strings = |v: &serde_json::Value, k: &str| -> Vec<String> {
        v.get(k)
            .and_then(|a| a.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    if let Some(fs) = v.get("filesystem") {
        let roots = fs
            .get("roots")
            .and_then(|a| a.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|r| {
                        Some(PathGrant {
                            path: str_of(r, "path")?,
                            rights: FsRights::from_bits_truncate(
                                r.get("rights").and_then(|b| b.as_u64()).unwrap_or(0) as u8,
                            ),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        return Some(CapabilityKind::Filesystem(FsRequest { roots }));
    }
    if let Some(s) = v.get("sockets") {
        let allow = s
            .get("allow")
            .and_then(|a| a.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|e| {
                        Some(Endpoint {
                            host: str_of(e, "host")?,
                            lo_port: e.get("lo")?.as_u64()? as u16,
                            hi_port: e.get("hi")?.as_u64()? as u16,
                            proto: if e.get("udp").and_then(|b| b.as_bool()).unwrap_or(false) {
                                Transport::Udp
                            } else {
                                Transport::Tcp
                            },
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        return Some(CapabilityKind::Sockets(SocketRequest {
            allow,
            may_listen: s
                .get("may_listen")
                .and_then(|b| b.as_bool())
                .unwrap_or(false),
        }));
    }
    if let Some(p) = v.get("process") {
        return Some(CapabilityKind::Process(ProcessRequest {
            image: str_of(p, "image")?,
            args: strings(p, "args"),
            guest_chooses_argv: p
                .get("guest_chooses_argv")
                .and_then(|b| b.as_bool())
                .unwrap_or(false),
        }));
    }
    if let Some(t) = v.get("terminal") {
        return Some(CapabilityKind::Terminal(TerminalRequest {
            shell: str_of(t, "shell"),
            jailed: t.get("jailed").and_then(|b| b.as_bool()).unwrap_or(true),
        }));
    }
    if let Some(i) = v.get("inference") {
        return Some(CapabilityKind::Inference(InferenceRequest {
            models: strings(i, "models"),
        }));
    }
    None
}

fn principal_kind_str(k: PrincipalKind) -> &'static str {
    match k {
        PrincipalKind::WebOrigin => "web-origin",
        PrincipalKind::InstalledApp => "installed-app",
        PrincipalKind::Peer => "peer",
    }
}

fn principal_kind_parse(s: &str) -> PrincipalKind {
    match s {
        "web-origin" => PrincipalKind::WebOrigin,
        "installed-app" => PrincipalKind::InstalledApp,
        _ => PrincipalKind::Peer,
    }
}

impl Default for GrantStore {
    fn default() -> Self {
        Self {
            grants: HashMap::new(),
            membranes: builtin_membranes(),
            sturdy: HashMap::new(),
            identity: Keypair::generate().unwrap_or_else(|e| panic!("no randomness: {e}")),
            persist: None,
        }
    }
}

/// A live grant projected for the app's audit/management view — serde-friendly
/// (unlike the wRPC `grant-info`), with a countdown to expiry.
#[derive(Clone, Serialize)]
pub struct GrantView {
    pub id: String,
    pub holder: String,
    pub summary: String,
    /// The capability's emoji (from the registry), for the audit view.
    pub icon: String,
    pub expires_in_secs: u64,
}

impl GrantStore {
    pub fn shared() -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self::default()))
    }

    /// Mint a fresh grant for `principal` over `kind` (valid for `ttl`) and return
    /// its bearer token. The broker calls this once consent is given; tests call
    /// it to stand in for a prior consented request.
    pub fn issue(
        &mut self,
        kind: CapabilityKind,
        summary: String,
        ttl: Duration,
        principal: Principal,
    ) -> String {
        // An unrestricted scope always compiles, so this cannot fail.
        self.issue_scoped(kind, EzScope::unrestricted(), summary, ttl, principal)
            .unwrap_or_else(|d| panic!("unrestricted scope refused: {d:?}"))
    }

    /// [`GrantStore::issue`] with an admission scope. The scope is compiled
    /// against the kind's generated environment now, so a clause that names an
    /// argument the interface does not have is refused at grant time
    /// (`denied::invalid-scope`), never discovered at the first call.
    /// Would `scope` be accepted for a `kind` grant? Compiles it against the
    /// kind's interface (a clause naming an argument it lacks, or a type
    /// error, is refused) without minting anything. For consent surfaces to
    /// validate a human's narrowing before it is applied.
    pub fn check_scope(&self, kind: &CapabilityKind, scope: &EzScope) -> Result<(), String> {
        let tag = kind_tag(kind);
        if self.membranes.has(tag) {
            self.membranes.check(tag, scope).map_err(|e| e.to_string())
        } else if is_unrestricted(scope) {
            Ok(())
        } else {
            Err(format!("no admission environment for `{tag}` capabilities"))
        }
    }

    pub fn issue_scoped(
        &mut self,
        kind: CapabilityKind,
        scope: EzScope,
        summary: String,
        ttl: Duration,
        principal: Principal,
    ) -> Result<String, Denied> {
        let tag = kind_tag(&kind);
        let instance = if self.membranes.has(tag) {
            Some(
                self.membranes
                    .mint(tag, &scope)
                    .map_err(|e| Denied::InvalidScope(e.to_string()))?,
            )
        } else if is_unrestricted(&scope) {
            None
        } else {
            return Err(Denied::InvalidScope(format!(
                "no admission environment for `{tag}` capabilities"
            )));
        };
        let token = mint_token();
        self.grants.insert(
            token.clone(),
            Grant {
                kind,
                scope,
                instance,
                parent: None,
                summary,
                expires: Instant::now() + ttl,
                principal,
                cancel: CancellationToken::new(),
            },
        );
        Ok(token)
    }

    /// Persist certified grants in `store` from now on, and bring back the
    /// ones a previous run persisted (expired rows are dropped), with their
    /// sturdy references, so certificates issued before a restart still
    /// redeem. Membrane instances are re-minted from the stored scopes.
    pub async fn restore(this: &Arc<Mutex<Self>>, store: &crate::store::Store) {
        let rows = match store.state_list("broker", "grant:").await {
            Ok(rows) => rows,
            Err(err) => {
                tracing::warn!(?err, "could not read persisted grants");
                Vec::new()
            }
        };
        let now_unix = unix_now();
        let mut stale = Vec::new();
        {
            let mut me = this.lock().unwrap();
            for (key, bytes) in rows {
                let token = key.trim_start_matches("grant:").to_string();
                let Ok(row) = serde_json::from_slice::<DurableGrant>(&bytes) else {
                    stale.push(key);
                    continue;
                };
                if row.expires_unix <= now_unix {
                    stale.push(key);
                    continue;
                }
                let Some(kind) = kind_from_json(&row.kind) else {
                    stale.push(key);
                    continue;
                };
                let tag = kind_tag(&kind);
                let instance = if me.membranes.has(tag) {
                    match me.membranes.mint(tag, &row.scope) {
                        Ok(id) => Some(id),
                        Err(err) => {
                            tracing::warn!(
                                ?err,
                                token,
                                "persisted grant's scope no longer compiles; dropped"
                            );
                            stale.push(key);
                            continue;
                        }
                    }
                } else {
                    None
                };
                let (kind_s, id, display_name) = row.principal;
                me.grants.insert(
                    token.clone(),
                    Grant {
                        kind,
                        scope: row.scope,
                        instance,
                        parent: row.parent,
                        summary: row.summary,
                        expires: Instant::now() + Duration::from_secs(row.expires_unix - now_unix),
                        principal: Principal {
                            kind: principal_kind_parse(&kind_s),
                            id,
                            display_name,
                        },
                        cancel: CancellationToken::new(),
                    },
                );
                for sturdy in row.sturdy {
                    me.sturdy.insert(sturdy, token.clone());
                }
            }
            me.persist = Some(store.clone());
        }
        for key in stale {
            let _ = store.state_delete("broker", &key).await;
        }
    }

    /// Write (or rewrite) a certified grant's durable row.
    fn persist_grant(&self, token: &str) {
        let Some(store) = &self.persist else { return };
        let Some(grant) = self.grants.get(token) else {
            return;
        };
        let remaining = grant.expires.saturating_duration_since(Instant::now());
        let row = DurableGrant {
            kind: kind_to_json(&grant.kind),
            scope: grant.scope.clone(),
            parent: grant.parent.clone(),
            summary: grant.summary.clone(),
            expires_unix: unix_now().saturating_add(remaining.as_secs()),
            principal: (
                principal_kind_str(grant.principal.kind).to_string(),
                grant.principal.id.clone(),
                grant.principal.display_name.clone(),
            ),
            sturdy: self
                .sturdy
                .iter()
                .filter(|(_, t)| t.as_str() == token)
                .map(|(s, _)| s.clone())
                .collect(),
        };
        let Ok(json) = serde_json::to_vec(&row) else {
            return;
        };
        let store = store.clone();
        let key = format!("grant:{token}");
        spawn_persist(async move {
            if let Err(err) = store.state_set("broker", &key, &json).await {
                tracing::warn!(?err, "could not persist a certified grant");
            }
        });
    }

    /// Drop the durable rows of revoked grants.
    fn unpersist(&self, tokens: Vec<String>) {
        let Some(store) = &self.persist else { return };
        let store = store.clone();
        spawn_persist(async move {
            for token in tokens {
                let _ = store
                    .state_delete("broker", &format!("grant:{token}"))
                    .await;
            }
        });
    }

    /// Admit one call on a grant: the grant must be live, and its `allow`
    /// clause must hold for `call` (with `call.method`, `call.args.*`,
    /// `caller.*` and `state.*` bound). On admission the instance's counters
    /// advance. A denial carries the scope rendered as sentences.
    pub fn admit(&mut self, token: &str, call: AdmitCall) -> Result<(), Denied> {
        let (tag, instance) = {
            let grant = self.grants.get(token).ok_or(Denied::NotAuthorized)?;
            if grant.expires <= Instant::now() || grant.cancel.is_cancelled() {
                return Err(Denied::Revoked);
            }
            (kind_tag(&grant.kind), grant.instance.clone())
        };
        // No environment for this kind ⇒ the scope was unrestricted by construction.
        let Some(id) = instance else { return Ok(()) };
        match self.membranes.admit(tag, &id, &call) {
            Ok(()) => Ok(()),
            Err(ezcap::CapabilityError::Denied(sentences)) => Err(Denied::OutOfScope(sentences)),
            Err(ezcap::CapabilityError::Unavailable) => Err(Denied::Revoked),
        }
    }

    /// The grant-level check (`when`) for a capability whose per-call gate does
    /// not yet carry the call's arguments (the filesystem passthrough's
    /// `gate.authorize(grant)`): live, and `when` holds with nothing bound.
    pub fn admit_grant(&self, token: &str) -> Result<(), Denied> {
        let grant = self.grants.get(token).ok_or(Denied::NotAuthorized)?;
        if grant.expires <= Instant::now() || grant.cancel.is_cancelled() {
            return Err(Denied::Revoked);
        }
        let Some(id) = &grant.instance else {
            return Ok(());
        };
        if self.membranes.admit_event(kind_tag(&grant.kind), id) {
            Ok(())
        } else {
            Err(Denied::OutOfScope(ezcap::profile::render_line(
                &grant.scope.when,
            )))
        }
    }

    /// Pledge-style self-narrowing: a child grant over the same provider
    /// parameters, principal and expiry, whose scope is the parent's conjoined
    /// with `extra`. Revoking the parent revokes the child (its cancellation is
    /// a child token of the parent's), and the membrane cascades likewise.
    pub fn narrow_grant(&mut self, token: &str, extra: Narrowing) -> Result<String, Denied> {
        self.narrow_grant_as(token, extra, None, None)
    }

    /// [`GrantStore::narrow_grant`] for a different holder and a shorter life:
    /// what redeeming a certificate does. `None` keeps the parent's.
    fn narrow_grant_as(
        &mut self,
        token: &str,
        extra: Narrowing,
        holder: Option<Principal>,
        until: Option<Instant>,
    ) -> Result<String, Denied> {
        let (kind, scope, instance, principal, expires, cancel) = {
            let parent = self.grants.get(token).ok_or(Denied::NotAuthorized)?;
            if parent.expires <= Instant::now() || parent.cancel.is_cancelled() {
                return Err(Denied::Revoked);
            }
            (
                parent.kind.clone(),
                parent.scope.narrowed(&extra),
                parent.instance.clone(),
                holder.unwrap_or_else(|| parent.principal.clone()),
                until.map_or(parent.expires, |u| u.min(parent.expires)),
                parent.cancel.child_token(),
            )
        };
        let tag = kind_tag(&kind);
        let instance = match instance {
            Some(parent_id) => Some(
                self.membranes
                    .narrow(tag, &parent_id, &extra)
                    .map_err(|e| Denied::InvalidScope(e.to_string()))?,
            ),
            None if is_unrestricted(&scope) => None,
            None => {
                return Err(Denied::InvalidScope(format!(
                    "no admission environment for `{tag}` capabilities"
                )));
            }
        };
        let summary = summarize_scoped(&kind, &scope);
        let child = mint_token();
        self.grants.insert(
            child.clone(),
            Grant {
                kind,
                scope,
                instance,
                parent: Some(token.to_string()),
                summary,
                expires,
                principal,
                cancel,
            },
        );
        Ok(child)
    }

    /// This broker's public key.
    pub fn identity(&self) -> ezcap::PublicKey {
        self.identity.public()
    }

    /// Install the daemon's persisted signing key (certificates issued before
    /// this call were signed by the ephemeral one and will not redeem).
    pub fn set_identity(&mut self, identity: Keypair) {
        self.identity = identity;
    }

    /// Issue a certificate on `token`: a sturdy reference bound to `audience`,
    /// good for `ttl` (capped at the grant's remaining life), narrowed by
    /// `extra`, signed by this broker. See `broker.wit`.
    pub fn certify(
        &mut self,
        token: &str,
        audience: Audience,
        ttl: Duration,
        extra: Narrowing,
    ) -> Result<String, Denied> {
        let (kind, scope, remaining) = {
            let grant = self.grants.get(token).ok_or(Denied::NotAuthorized)?;
            let now = Instant::now();
            if grant.expires <= now || grant.cancel.is_cancelled() {
                return Err(Denied::Revoked);
            }
            (grant.kind.clone(), grant.scope.clone(), grant.expires - now)
        };
        // The chain's clauses must compile against the kind now, so a holder
        // learns of a bad clause when sharing rather than the recipient when
        // redeeming.
        self.check_scope(&kind, &scope.narrowed(&extra))
            .map_err(Denied::InvalidScope)?;
        let ttl = ttl.min(remaining);
        let expires = unix_now().saturating_add(ttl.as_secs().max(1));
        let sturdy = mint_token();
        self.sturdy.insert(sturdy.clone(), token.to_string());
        // A certified grant outlives the daemon: its certificates may be
        // redeemed after a restart.
        self.persist_grant(token);
        Ok(Certificate::issue(&self.identity, sturdy, audience, expires, extra).encode())
    }

    /// Redeem a certificate presented by `presented` (what the transport
    /// proved) for `holder`: a grant narrowed by the chain, living no longer
    /// than the certificate or its source grant.
    pub fn redeem(
        &mut self,
        cert: &str,
        presented: &Presented,
        holder: Principal,
    ) -> Result<String, Denied> {
        let cert = Certificate::decode(cert).map_err(|e| {
            tracing::info!(error = %e, "certificate refused");
            Denied::NotAuthorized
        })?;
        let verified = cert.verify(unix_now()).map_err(|e| {
            tracing::info!(error = %e, "certificate refused");
            match e {
                ezcap::CertError::Expired => Denied::Revoked,
                _ => Denied::NotAuthorized,
            }
        })?;
        verified
            .admits(&self.identity.public(), presented)
            .map_err(|e| {
                tracing::info!(error = %e, "certificate refused");
                Denied::NotAuthorized
            })?;
        let token = self
            .sturdy
            .get(&verified.instance)
            .cloned()
            .ok_or(Denied::Revoked)?;
        let until =
            Instant::now() + Duration::from_secs(verified.expires.saturating_sub(unix_now()));
        self.narrow_grant_as(&token, verified.narrowing, Some(holder), Some(until))
    }

    /// The capability gate: confirm a presented `token` is live and authorises
    /// `kind_ok`. Unknown ⇒ `not-authorized`; lapsed ⇒ `revoked`; wrong kind ⇒
    /// `not-authorized`. A capability calls this before doing anything.
    pub fn validate(
        &self,
        token: &str,
        kind_ok: impl Fn(&CapabilityKind) -> bool,
    ) -> Result<(), Denied> {
        let grant = self.grants.get(token).ok_or(Denied::NotAuthorized)?;
        if grant.expires <= Instant::now() || grant.cancel.is_cancelled() {
            return Err(Denied::Revoked);
        }
        if !kind_ok(&grant.kind) {
            return Err(Denied::NotAuthorized);
        }
        Ok(())
    }

    /// Validate a token is a live **filesystem** grant and return the path
    /// prefixes it negotiated (its `fs-request` roots) — the caveats the membrane
    /// jails to. Unknown/expired ⇒ the matching denial; wrong kind ⇒ not-authorized.
    pub fn validate_filesystem(&self, token: &str) -> Result<Vec<String>, Denied> {
        let grant = self.grants.get(token).ok_or(Denied::NotAuthorized)?;
        if grant.expires <= Instant::now() || grant.cancel.is_cancelled() {
            return Err(Denied::Revoked);
        }
        match &grant.kind {
            CapabilityKind::Filesystem(req) => {
                Ok(req.roots.iter().map(|r| r.path.clone()).collect())
            }
            _ => Err(Denied::NotAuthorized),
        }
    }

    /// Validate a token is a live **process** grant and return its `process-request`
    /// — the `image` the grant pinned at consent time plus whether the caller may
    /// choose argv. The provider spawns *that* image (never a caller-named one), so
    /// a grant for `rust-analyzer` can't be turned into `rm`. Unknown/expired ⇒ the
    /// matching denial; wrong kind ⇒ not-authorized.
    pub fn validate_process(&self, token: &str) -> Result<ProcessRequest, Denied> {
        let grant = self.grants.get(token).ok_or(Denied::NotAuthorized)?;
        if grant.expires <= Instant::now() || grant.cancel.is_cancelled() {
            return Err(Denied::Revoked);
        }
        match &grant.kind {
            CapabilityKind::Process(req) => Ok(req.clone()),
            _ => Err(Denied::NotAuthorized),
        }
    }

    /// Validate a token is a live **inference** grant and return its
    /// `inference-request` (the models it may use; empty = any configured).
    pub fn validate_inference(&self, token: &str) -> Result<InferenceRequest, Denied> {
        let grant = self.grants.get(token).ok_or(Denied::NotAuthorized)?;
        if grant.expires <= Instant::now() || grant.cancel.is_cancelled() {
            return Err(Denied::Revoked);
        }
        match &grant.kind {
            CapabilityKind::Inference(req) => Ok(req.clone()),
            _ => Err(Denied::NotAuthorized),
        }
    }

    /// Advance a host-defined counter (`tokens`, `day_tokens`) on a grant's
    /// membrane instance after a call, so later `allow` evaluations see it.
    pub fn charge(&mut self, token: &str, counter: &str, amount: i64) {
        if let Some(grant) = self.grants.get(token) {
            if let Some(id) = &grant.instance {
                self.membranes
                    .charge(kind_tag(&grant.kind), id, counter, amount);
            }
        }
    }

    /// A counter's current value on a grant's instance.
    pub fn counter(&self, token: &str, counter: &str) -> Option<i64> {
        let grant = self.grants.get(token)?;
        let id = grant.instance.as_ref()?;
        self.membranes.counter(kind_tag(&grant.kind), id, counter)
    }

    /// Every live grant, projected for the app's audit view (the native tray/window).
    pub fn active_grants(&self) -> Vec<GrantView> {
        let now = Instant::now();
        self.grants
            .iter()
            .filter(|(_, g)| g.expires > now)
            .map(|(id, g)| GrantView {
                id: id.clone(),
                holder: principal_label(&g.principal),
                summary: g.summary.clone(),
                icon: crate::capabilities::icon_for(kind_tag(&g.kind)).to_string(),
                expires_in_secs: g.expires.saturating_duration_since(now).as_secs(),
            })
            .collect()
    }

    /// Revoke a grant by id (the app's "Revoke" button). Fires the grant's signal so
    /// any live streaming session tears down, then drops it. Returns whether one was live.
    pub fn revoke(&mut self, id: &str) -> bool {
        match self.grants.remove(id) {
            Some(grant) => {
                grant.cancel.cancel();
                if let Some(instance) = &grant.instance {
                    self.membranes.revoke(kind_tag(&grant.kind), instance);
                }
                // Everything narrowed from it goes too (their cancel tokens are
                // children of this one and have already fired).
                let mut removed = vec![id.to_string()];
                let mut gone = vec![id.to_string()];
                while let Some(parent) = gone.pop() {
                    let children: Vec<String> = self
                        .grants
                        .iter()
                        .filter(|(_, g)| g.parent.as_deref() == Some(parent.as_str()))
                        .map(|(t, _)| t.clone())
                        .collect();
                    for child in children {
                        self.grants.remove(&child);
                        removed.push(child.clone());
                        gone.push(child);
                    }
                }
                // Certificates on a revoked grant are void: forget their references.
                let grants = &self.grants;
                self.sturdy.retain(|_, token| grants.contains_key(token));
                self.unpersist(removed);
                true
            }
            None => false,
        }
    }

    /// The revocation signal for a live grant — a streaming capability awaits it at
    /// session start to end its stream + release its resource on revoke/expiry.
    pub fn revocation(&self, token: &str) -> Option<Revocation> {
        self.grants.get(token).map(|g| Revocation {
            cancel: g.cancel.clone(),
            expires: g.expires,
        })
    }

    /// The `(origin, kind)` a live grant is bound to — so revoking it can also forget
    /// the site's durable pairing for that capability. `origin` is `None` for a
    /// non-browser peer (no pairing to forget).
    pub fn grant_target(&self, id: &str) -> Option<(Option<String>, &'static str)> {
        self.grants.get(id).map(|g| {
            let origin = match g.principal.kind {
                PrincipalKind::WebOrigin => Some(g.principal.id.clone()),
                _ => None,
            };
            (origin, kind_tag(&g.kind))
        })
    }
}

/// Revoke a grant AND forget the site's durable pairing for that capability, so the
/// origin must re-consent instead of silently re-pairing on its next request. This is
/// what the consent app's "Revoke" button should do — otherwise revocation only drops
/// the live token and a remembered site re-acquires the grant on the next page load.
/// Returns whether a grant was live.
pub fn revoke_and_unpair(
    grants: &Arc<Mutex<GrantStore>>,
    pairings: &Arc<Mutex<Pairings>>,
    id: &str,
) -> bool {
    let target = grants.lock().unwrap().grant_target(id);
    let revoked = grants.lock().unwrap().revoke(id);
    if let Some((Some(origin), kind)) = target {
        pairings.lock().unwrap().revoke_kind(&origin, kind);
    }
    revoked
}

/// Where broker state (pairings, hosts) persists. The store is the durable
/// home: one JSON blob per key under the `broker` owner of the generic state
/// table, like any capability's state. A JSON file is the legacy form, read
/// once and imported when a store is attached ([`Pairings::restore`]).
#[derive(Clone)]
enum Persist {
    /// In memory only (tests).
    None,
    /// The legacy dotfile, written with owner-only permissions.
    File(PathBuf),
    /// The daemon's store, key under the `broker` owner.
    Store {
        store: crate::store::Store,
        key: &'static str,
    },
}

impl Persist {
    fn save(&self, json: String, what: &'static str) {
        match self {
            Persist::None => {}
            Persist::File(path) => write_private(path, &json, what),
            Persist::Store { store, key } => {
                let store = store.clone();
                let key = *key;
                spawn_persist(async move {
                    if let Err(err) = store.state_set("broker", key, json.as_bytes()).await {
                        tracing::warn!(?err, what, "failed to persist to the store");
                    }
                });
            }
        }
    }

    /// The legacy file this backend reads from, if it is one.
    fn legacy_file(&self) -> Option<&PathBuf> {
        match self {
            Persist::File(p) => Some(p),
            _ => None,
        }
    }
}

/// Run a persistence future on the current tokio runtime, or on a throwaway
/// one when called from outside (a Tauri command thread).
fn spawn_persist(fut: impl std::future::Future<Output = ()> + Send + 'static) {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(fut);
        }
        Err(_) => {
            std::thread::spawn(move || {
                match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt.block_on(fut),
                    Err(err) => tracing::warn!(?err, "no runtime to persist on"),
                }
            });
        }
    }
}

/// Load `key` from the store's `broker` owner as JSON, else import the legacy
/// file (deleting it once the import is stored: it held bearer secrets in
/// plain text), else `T::default()`.
async fn restore_json<T: serde::de::DeserializeOwned + Serialize + Default>(
    store: &crate::store::Store,
    key: &'static str,
    legacy: Option<&PathBuf>,
) -> T {
    match store.state_get("broker", key).await {
        Ok(Some(bytes)) => match serde_json::from_slice(&bytes) {
            Ok(v) => return v,
            Err(err) => tracing::warn!(?err, key, "stored broker state is malformed; ignoring"),
        },
        Ok(None) => {}
        Err(err) => tracing::warn!(?err, key, "could not read broker state"),
    }
    if let Some(path) = legacy {
        if let Some(v) = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<T>(&s).ok())
        {
            match serde_json::to_vec(&v) {
                Ok(json) => match store.state_set("broker", key, &json).await {
                    Ok(()) => {
                        if let Err(err) = std::fs::remove_file(path) {
                            tracing::warn!(?err, path = %path.display(), "imported into the store, but could not remove the legacy file");
                        } else {
                            tracing::info!(path = %path.display(), key, "imported into the store; legacy file removed");
                        }
                        return v;
                    }
                    Err(err) => tracing::warn!(?err, key, "could not import into the store"),
                },
                Err(err) => tracing::warn!(?err, key, "could not serialise for import"),
            }
            return v;
        }
    }
    T::default()
}

/// Durable, per-origin trust: presenting a pairing secret for an origin skips the
/// consent prompt for the kinds that origin was approved for. The secret is
/// stored by the browser in **origin-partitioned** storage (only the paired
/// origin's JS can read it) and bound here to that origin + the kinds it covers —
/// so a secret used from another origin (or with no origin) doesn't match.
/// (In-memory: a daemon restart forgets pairings and the human re-approves once.)
pub struct Pairings {
    by_secret: HashMap<String, Pairing>,
    /// Where pairings persist across restarts.
    persist: Persist,
}

#[derive(Serialize, Deserialize)]
struct Pairing {
    origin: String,
    kinds: HashSet<String>,
}

impl Pairings {
    /// In-memory only (tests, or a daemon told not to persist).
    pub fn shared() -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self {
            by_secret: HashMap::new(),
            persist: Persist::None,
        }))
    }

    /// Load pairings from the legacy JSON `path` (empty if absent/unreadable)
    /// and persist every later change back to it, until [`Pairings::restore`]
    /// attaches the store.
    pub fn load(path: PathBuf) -> Arc<Mutex<Self>> {
        let by_secret = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Arc::new(Mutex::new(Self {
            by_secret,
            persist: Persist::File(path),
        }))
    }

    /// Attach the daemon's store: pairings come from its `broker/pairings`
    /// row from now on (importing the legacy file once, then deleting it),
    /// and every change persists there.
    pub async fn restore(this: &Arc<Mutex<Self>>, store: &crate::store::Store) {
        let legacy = this.lock().unwrap().persist.legacy_file().cloned();
        let by_secret: HashMap<String, Pairing> =
            restore_json(store, "pairings", legacy.as_ref()).await;
        let mut me = this.lock().unwrap();
        me.by_secret = by_secret;
        me.persist = Persist::Store {
            store: store.clone(),
            key: "pairings",
        };
    }

    /// Best-effort persist. Called after every mutation.
    fn save(&self) {
        match serde_json::to_string_pretty(&self.by_secret) {
            Ok(json) => self.persist.save(json, "pairings"),
            Err(err) => tracing::warn!(?err, "failed to serialize pairings"),
        }
    }

    /// Does `secret` pair `origin` for `kind`?
    fn check(&self, secret: &str, origin: &str, kind: &'static str) -> bool {
        self.by_secret
            .get(secret)
            .is_some_and(|p| p.origin == origin && p.kinds.contains(kind))
    }

    /// Record that `origin` is trusted for `kind`. If they presented a secret we
    /// already issued for this origin, extend it (return `None`); otherwise mint a
    /// fresh secret for the client to store. Persists the change.
    fn remember(
        &mut self,
        presented: Option<&str>,
        origin: &str,
        kind: &'static str,
    ) -> Option<String> {
        if let Some(s) = presented {
            let extended = self.by_secret.get_mut(s).is_some_and(|p| {
                if p.origin == origin {
                    p.kinds.insert(kind.to_string());
                    true
                } else {
                    false
                }
            });
            if extended {
                self.save();
                return None;
            }
        }
        let secret = mint_token();
        self.by_secret.insert(
            secret.clone(),
            Pairing {
                origin: origin.to_string(),
                kinds: HashSet::from([kind.to_string()]),
            },
        );
        self.save();
        Some(secret)
    }

    /// Forget ALL remembered sites (the Settings "forget all sites" action).
    pub fn clear(&mut self) {
        self.by_secret.clear();
        self.save();
    }

    /// Revoke every pairing for an origin. Persists the change.
    pub fn revoke_origin(&mut self, origin: &str) {
        self.by_secret.retain(|_, p| p.origin != origin);
        self.save();
    }

    /// Forget durable trust for one `(origin, kind)`: drop `kind` from every pairing of
    /// `origin`, and drop any pairing left covering nothing. So revoking a grant makes
    /// the site re-consent for *that* capability without disturbing its other kinds.
    pub fn revoke_kind(&mut self, origin: &str, kind: &str) {
        self.by_secret.retain(|_, p| {
            if p.origin == origin {
                p.kinds.remove(kind);
                !p.kinds.is_empty()
            } else {
                true
            }
        });
        self.save();
    }

    /// The sites with durable trust, each with the capability kinds it covers
    /// (aggregated across secrets) — for the app's "Sites" view.
    pub fn list(&self) -> Vec<(String, Vec<String>)> {
        let mut by_origin: std::collections::BTreeMap<String, std::collections::BTreeSet<String>> =
            std::collections::BTreeMap::new();
        for p in self.by_secret.values() {
            let kinds = by_origin.entry(p.origin.clone()).or_default();
            for k in &p.kinds {
                kinds.insert(k.clone());
            }
        }
        by_origin
            .into_iter()
            .map(|(o, ks)| (o, ks.into_iter().collect()))
            .collect()
    }
}

/// The set of origins allowed to initiate consent requests, plus the origins seen
/// requesting while **unapproved**. In `strict` mode (the native app) an unapproved
/// origin is refused with **no prompt or notification** and merely recorded in `seen`,
/// so the user can review + approve it in the UI. In non-strict mode (the headless
/// default) an empty allowlist is permissive — any origin may prompt — which keeps the
/// existing tests/demo working. Only `allowed` is persisted (JSON, like [`Pairings`]).
pub struct Hosts {
    allowed: HashSet<String>,
    /// origin → kinds it requested while unapproved (in-memory; re-collected on demand).
    seen: HashMap<String, std::collections::BTreeSet<String>>,
    strict: bool,
    persist: Persist,
}

/// Persist `data` to `path` with **owner-only** perms (0600) — these files can hold
/// bearer secrets (pairing tokens), so they must never be group/world readable.
fn write_private(path: &std::path::Path, data: &str, what: &str) {
    if let Err(err) = std::fs::write(path, data) {
        tracing::warn!(?err, path = %path.display(), what, "failed to persist");
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
}

/// Resolve a program name to an **absolute** executable path (searching `PATH`), so a
/// `process` grant pins the exact binary at consent time — a later `PATH` change can't
/// swap it between consent and spawn. A name containing a slash is treated as a path.
fn resolve_program(image: &str) -> Option<std::path::PathBuf> {
    let candidate = std::path::Path::new(image);
    if candidate.is_absolute() || image.contains('/') {
        return is_executable(candidate).then(|| candidate.to_path_buf());
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let full = dir.join(image);
        is_executable(&full).then_some(full)
    })
}

fn is_executable(p: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

impl Hosts {
    pub fn shared() -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self {
            allowed: HashSet::new(),
            seen: HashMap::new(),
            strict: false,
            persist: Persist::None,
        }))
    }

    /// Load the allowlist from the legacy JSON `path`. `strict` ⇒ only approved
    /// requesters may prompt (the app); otherwise an empty allowlist is
    /// permissive (headless default). [`Hosts::restore`] attaches the store.
    pub fn load(path: PathBuf, strict: bool) -> Arc<Mutex<Self>> {
        let allowed = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Arc::new(Mutex::new(Self {
            allowed,
            seen: HashMap::new(),
            strict,
            persist: Persist::File(path),
        }))
    }

    /// Attach the daemon's store (`broker/hosts`), importing the legacy file once.
    pub async fn restore(this: &Arc<Mutex<Self>>, store: &crate::store::Store) {
        let legacy = this.lock().unwrap().persist.legacy_file().cloned();
        let allowed: HashSet<String> = restore_json(store, "hosts", legacy.as_ref()).await;
        let mut me = this.lock().unwrap();
        me.allowed = allowed;
        me.persist = Persist::Store {
            store: store.clone(),
            key: "hosts",
        };
    }

    fn save(&self) {
        match serde_json::to_string_pretty(&self.allowed) {
            Ok(json) => self.persist.save(json, "hosts"),
            Err(err) => tracing::warn!(?err, "failed to serialize hosts"),
        }
    }

    /// May `origin` initiate requests? Strict ⇒ must be approved; else empty allowlist
    /// is permissive.
    pub fn is_allowed(&self, origin: &str) -> bool {
        if self.strict {
            self.allowed.contains(origin)
        } else {
            self.allowed.is_empty() || self.allowed.contains(origin)
        }
    }

    /// Record an origin that requested while unapproved — for the app's review list. No
    /// notification is posted (the broker refuses it before reaching the consent surface).
    pub fn record_seen(&mut self, origin: &str, kind: &str) {
        self.seen
            .entry(origin.to_string())
            .or_default()
            .insert(kind.to_string());
    }

    /// Origins seen requesting but not (yet) approved, with the kinds they asked for.
    pub fn list_unknown(&self) -> Vec<(String, Vec<String>)> {
        self.seen
            .iter()
            .filter(|(o, _)| !self.allowed.contains(*o))
            .map(|(o, ks)| (o.clone(), ks.iter().cloned().collect()))
            .collect()
    }

    pub fn list(&self) -> Vec<String> {
        let mut v: Vec<String> = self.allowed.iter().cloned().collect();
        v.sort();
        v
    }

    pub fn add(&mut self, origin: &str) {
        self.allowed.insert(origin.to_string());
        self.seen.remove(origin); // approved ⇒ no longer "unknown"
        self.save();
    }

    pub fn remove(&mut self, origin: &str) {
        self.allowed.remove(origin);
        self.save();
    }

    /// Remove ALL approved hosts + the seen list (the Settings "clear hosts" action).
    pub fn clear(&mut self) {
        self.allowed.clear();
        self.seen.clear();
        self.save();
    }
}

/// The capability *kind* a pairing covers (the variant tag, not its parameters).
fn kind_tag(want: &CapabilityKind) -> &'static str {
    match want {
        CapabilityKind::Filesystem(_) => "filesystem",
        CapabilityKind::Sockets(_) => "sockets",
        CapabilityKind::Process(_) => "process",
        CapabilityKind::Terminal(_) => "terminal",
        CapabilityKind::Inference(_) => "inference",
    }
}

/// The broker handler — issues grants under consent, against a shared store, and
/// records per-origin pairings so trusted origins skip re-consent.
#[derive(Clone)]
pub struct BrokerProvider {
    store: Arc<Mutex<GrantStore>>,
    consent: Consent,
    pairings: Arc<Mutex<Pairings>>,
    hosts: Arc<Mutex<Hosts>>,
}

impl BrokerProvider {
    pub fn new(
        store: Arc<Mutex<GrantStore>>,
        consent: Consent,
        pairings: Arc<Mutex<Pairings>>,
    ) -> Self {
        // Empty host allowlist ⇒ permissive (any origin may prompt) until `with_hosts`.
        Self {
            store,
            consent,
            pairings,
            hosts: Hosts::shared(),
        }
    }

    /// Gate which origins may initiate requests at all (see [`Hosts`]).
    pub fn with_hosts(mut self, hosts: Arc<Mutex<Hosts>>) -> Self {
        self.hosts = hosts;
        self
    }
}

/// A human-legible one-liner for the consent UI + audit view.
fn summarize(want: &CapabilityKind) -> String {
    match want {
        CapabilityKind::Terminal(t) => {
            if t.jailed {
                "terminal (sandboxed shell)".to_string()
            } else {
                "terminal (your login shell)".to_string()
            }
        }
        CapabilityKind::Filesystem(fs) => format!("filesystem ({} path(s))", fs.roots.len()),
        CapabilityKind::Sockets(s) => format!("sockets ({} endpoint(s))", s.allow.len()),
        CapabilityKind::Process(p) => format!("process ({})", p.image),
        CapabilityKind::Inference(i) => {
            if i.models.is_empty() {
                "inference (any configured model)".to_string()
            } else {
                format!("inference ({})", i.models.join(", "))
            }
        }
    }
}

/// A scope rendered for a human: one sentence per clause, empty when the
/// field is unrestricted. What every consent surface shows.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct ScopeText {
    pub when: Vec<String>,
    pub allow: Vec<String>,
}

impl ScopeText {
    pub fn of(scope: &EzScope) -> Self {
        let render = |expr: &str| -> Vec<String> {
            if expr.trim() == "true" {
                Vec::new()
            } else {
                ezcap::profile::render(expr)
                    .iter()
                    .map(ToString::to_string)
                    .collect()
            }
        };
        ScopeText {
            when: render(&scope.when),
            allow: render(&scope.allow),
        }
    }
}

/// [`summarize`] plus the scope as sentences, when it restricts anything.
fn summarize_scoped(want: &CapabilityKind, scope: &EzScope) -> String {
    let mut s = summarize(want);
    if scope.when.trim() != "true" {
        s.push_str(" · when: ");
        s.push_str(&ezcap::profile::render_line(&scope.when));
    }
    if scope.allow.trim() != "true" {
        s.push_str(" · allow: ");
        s.push_str(&ezcap::profile::render_line(&scope.allow));
    }
    s
}

/// Clamp `requested` to be a **subset** of `original` — the monotonic property the
/// whole model rests on: the consent surface (even a compromised one) can only ever
/// *narrow* a grant, never widen it. Anything in `requested` beyond what `original`
/// offered is dropped or clamped; the capability *category* is never negotiable, so a
/// kind mismatch falls back to `original` unchanged.
fn narrow(original: &CapabilityKind, requested: &CapabilityKind) -> CapabilityKind {
    use CapabilityKind::*;
    match (original, requested) {
        (Filesystem(orig), Filesystem(req)) => {
            let roots = req
                .roots
                .iter()
                // Keep only paths the original offered; intersect their rights. A
                // root the human left with no rights is dropped entirely.
                .filter_map(|r| {
                    orig.roots
                        .iter()
                        .find(|o| o.path == r.path)
                        .map(|o| PathGrant {
                            path: r.path.clone(),
                            rights: r.rights & o.rights,
                        })
                })
                .filter(|r| !r.rights.is_empty())
                .collect();
            Filesystem(FsRequest { roots })
        }
        (Process(orig), Process(req)) => Process(ProcessRequest {
            // The image + pinned args come from the request — never swapped, only kept.
            image: orig.image.clone(),
            args: orig.args.clone(),
            // Letting the guest choose argv can only be turned OFF, never on.
            guest_chooses_argv: req.guest_chooses_argv && orig.guest_chooses_argv,
        }),
        (Terminal(orig), Terminal(req)) => Terminal(TerminalRequest {
            // The shell isn't a subset relation; keep what was requested. The only
            // terminal attenuation is forcing the sandbox on (never off).
            shell: orig.shell.clone(),
            jailed: req.jailed || orig.jailed,
        }),
        (Inference(orig), Inference(req)) => Inference(InferenceRequest {
            // An empty original means any model, so the human's list stands;
            // otherwise keep only models the original offered. An empty
            // request keeps the original (it cannot widen to "any").
            models: if req.models.is_empty() {
                orig.models.clone()
            } else if orig.models.is_empty() {
                req.models.clone()
            } else {
                req.models
                    .iter()
                    .filter(|m| orig.models.contains(m))
                    .cloned()
                    .collect()
            },
        }),
        // Sockets aren't served yet (no provider); pass through unchanged. Any
        // kind mismatch ⇒ the original — the category can't be changed here.
        _ => original.clone(),
    }
}

/// Wall-clock seconds, for certificate expiries (which travel).
fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// An unforgeable bearer token. 122 bits of randomness — you can't guess one,
/// only be issued it; presenting it *is* the authority.
fn mint_token() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Map the transport-supplied origin to a principal. A browser-attested origin →
/// a `web-origin` principal; its absence (loopback, a non-browser peer, or
/// WebTransport for now) → an anonymous local `peer`.
fn principal_from_origin(origin: Option<&str>) -> Principal {
    match origin {
        Some(o) => Principal {
            kind: PrincipalKind::WebOrigin,
            id: o.to_string(),
            display_name: None,
        },
        None => anonymous_principal(),
    }
}

/// The principal a transport context proves: a browser-attested origin, a
/// QUIC-authenticated peer key, or — with neither — the anonymous local peer.
fn principal_of(cx: &impl AsOrigin) -> Principal {
    match (cx.origin(), cx.peer()) {
        (Some(o), _) => principal_from_origin(Some(o)),
        (None, Some(peer)) => Principal {
            kind: PrincipalKind::Peer,
            id: peer.to_string(),
            display_name: Some(format!("peer {}", &peer.to_string()[..8])),
        },
        (None, None) => anonymous_principal(),
    }
}

/// The stand-in principal for a peer the transport didn't (yet) identify.
pub fn anonymous_principal() -> Principal {
    Principal {
        kind: PrincipalKind::Peer,
        id: "local".to_string(),
        display_name: Some("an unidentified local peer".to_string()),
    }
}

/// A human-legible label for the consent prompt + audit log.
fn principal_label(p: &Principal) -> String {
    match p.kind {
        PrincipalKind::WebOrigin => p.id.clone(),
        _ => p.display_name.clone().unwrap_or_else(|| p.id.clone()),
    }
}

impl<C: AsOrigin + Send + Sync + 'static> bindings::exports::icanhaz::nocap::broker::Handler<C>
    for BrokerProvider
{
    async fn request(
        &self,
        cx: C,
        want: CapabilityKind,
        reason: String,
        pairing: Option<String>,
    ) -> anyhow::Result<Result<GrantReply, Denied>> {
        let unrestricted = ScopeWire {
            when: "true".to_string(),
            allow: "true".to_string(),
        };
        self.request_scoped(cx, want, unrestricted, reason, pairing)
            .await
    }

    async fn request_scoped(
        &self,
        cx: C,
        mut want: CapabilityKind,
        scope: ScopeWire,
        reason: String,
        pairing: Option<String>,
    ) -> anyhow::Result<Result<GrantReply, Denied>> {
        let scope = scope_from_wire(&scope);
        // Pin `process` to an absolute program path at grant time, so a later `PATH`
        // change can't swap the binary between consent and spawn. A program not found on
        // `PATH` now is refused outright.
        if let CapabilityKind::Process(p) = &mut want {
            match resolve_program(&p.image) {
                Some(abs) => p.image = abs.to_string_lossy().into_owned(),
                None => {
                    tracing::info!(image = %p.image, "process request refused — program not on PATH");
                    return Ok(Err(Denied::Unsupported(format!(
                        "program not found: {}",
                        p.image
                    ))));
                }
            }
        }

        // The requesting principal comes from the transport, not the request body:
        // the browser-attested `Origin` (which page JS can't forge), never a value
        // the caller hands us. `None` ⇒ a non-browser / loopback peer.
        let origin = cx.origin();
        let kind = kind_tag(&want);
        let principal = principal_of(&cx);
        let summary = summarize_scoped(&want, &scope);

        // Host allowlist: an unapproved requester — a web origin, or a peer the
        // transport identified by key — is refused *before* the consent surface,
        // so no prompt or OS notification fires; it's only recorded for the app's
        // review list, where the user can approve it (see `Hosts`). The
        // anonymous local peer (loopback, no identity) is not gated here.
        if matches!(
            principal.kind,
            PrincipalKind::WebOrigin | PrincipalKind::Peer
        ) && principal.id != "local"
        {
            let mut hosts = self.hosts.lock().unwrap();
            if !hosts.is_allowed(&principal.id) {
                hosts.record_seen(&principal.id, kind);
                tracing::info!(requester = %principal.id, kind, "request from an unapproved host — recorded, not prompted");
                return Ok(Err(Denied::NotAuthorized));
            }
        }

        // Fast path: an origin presenting a valid pairing for this kind skips the
        // consent prompt entirely — that is the durable, origin-bound trust.
        if let (Some(o), Some(s)) = (origin, pairing.as_deref()) {
            if self.pairings.lock().unwrap().check(s, o, kind) {
                tracing::info!(origin = %o, kind, "paired — consent skipped");
                let issued = self
                    .store
                    .lock()
                    .unwrap()
                    .issue_scoped(want, scope, summary, GRANT_TTL, principal);
                return Ok(issued.map(|token| GrantReply {
                    token,
                    pairing: None,
                }));
            }
        }

        let requester = principal_label(&principal);
        match self
            .consent
            .decide(&want, &scope, &reason, &requester)
            .await
        {
            Decision::Deny(denied) => {
                tracing::info!(%requester, %summary, %reason, "consent denied");
                Ok(Err(denied))
            }
            Decision::Approve {
                grant,
                narrowing,
                ttl,
                remember,
            } => {
                // The human's added clauses conjoin onto the request's scope:
                // append-only, so the surface can tighten but never widen.
                let scope = match narrowing {
                    Some(extra) => scope.narrowed(&extra),
                    None => scope,
                };
                // Pair the origin (if it has one AND the human chose to remember)
                // so future requests of this kind skip consent; hand back a fresh
                // secret only on the first pairing.
                let new_secret = if remember {
                    origin.and_then(|o| {
                        self.pairings
                            .lock()
                            .unwrap()
                            .remember(pairing.as_deref(), o, kind)
                    })
                } else {
                    None
                };
                // Issue the (possibly attenuated) grant the human actually approved —
                // its summary, not the original request's, is what the audit view shows.
                let granted_summary = summarize_scoped(&grant, &scope);
                tracing::info!(%requester, summary = %granted_summary, %reason, remember, paired = new_secret.is_some(), "consent granted");
                let issued = self.store.lock().unwrap().issue_scoped(
                    grant,
                    scope,
                    granted_summary,
                    ttl,
                    principal,
                );
                Ok(issued.map(|token| GrantReply {
                    token,
                    pairing: new_secret,
                }))
            }
        }
    }

    async fn certify(
        &self,
        _cx: C,
        token: String,
        audience: AudienceWire,
        ttl_secs: u64,
        extra: ScopeWire,
    ) -> anyhow::Result<Result<String, Denied>> {
        let audience = match audience {
            AudienceWire::Any => Audience::Any,
            AudienceWire::Origin(o) => Audience::Origin(o),
            AudienceWire::Peer(key) => match key.parse() {
                Ok(key) => Audience::Peer(key),
                Err(e) => return Ok(Err(Denied::Unsupported(format!("peer audience: {e}")))),
            },
        };
        let extra = narrowing_from_wire(&extra);
        Ok(self.store.lock().unwrap().certify(
            &token,
            audience,
            Duration::from_secs(ttl_secs),
            extra,
        ))
    }

    async fn redeem(&self, cx: C, cert: String) -> anyhow::Result<Result<GrantReply, Denied>> {
        // The redeemer is whoever the transport proved: the certificate's
        // audience is checked against exactly that, and the grant binds to it.
        let presented = cx.presented();
        let holder = principal_of(&cx);
        let issued = self.store.lock().unwrap().redeem(&cert, &presented, holder);
        Ok(issued.map(|token| GrantReply {
            token,
            pairing: None,
        }))
    }

    async fn identity(&self, _cx: C) -> anyhow::Result<String> {
        Ok(self.store.lock().unwrap().identity().to_string())
    }

    async fn granted(&self, _cx: C) -> anyhow::Result<Vec<GrantInfo>> {
        let store = self.store.lock().unwrap();
        let now = Instant::now();
        Ok(store
            .grants
            .iter()
            .filter(|(_, g)| g.expires > now)
            .map(|(id, g)| GrantInfo {
                id: id.clone(),
                holder: g.principal.clone(),
                summary: g.summary.clone(),
            })
            .collect())
    }

    async fn narrow(
        &self,
        _cx: C,
        token: String,
        extra: ScopeWire,
    ) -> anyhow::Result<Result<GrantReply, Denied>> {
        let extra = narrowing_from_wire(&extra);
        let child = self.store.lock().unwrap().narrow_grant(&token, extra);
        Ok(child.map(|token| GrantReply {
            token,
            pairing: None,
        }))
    }

    async fn revoke(&self, _cx: C, grant: String) -> anyhow::Result<()> {
        // Fires the grant's cancellation (tearing down live sessions) and drops
        // everything narrowed from it, like the app's "Revoke" button.
        self.store.lock().unwrap().revoke(&grant);
        Ok(())
    }
}

/// Drive every broker invocation arriving at `srv` until the stream ends.
pub async fn drive_broker<C, S>(srv: &S, provider: BrokerProvider) -> anyhow::Result<()>
where
    C: AsOrigin + Send + Sync + 'static,
    S: wrpc_transport::Serve<Context = C>,
{
    let invocations = bindings::serve(srv, provider)
        .await
        .context("failed to serve broker")?;
    let mut invocations = select_all(
        invocations
            .into_iter()
            .map(|(instance, name, invocations)| invocations.map(move |res| (instance, name, res))),
    );
    while let Some((instance, name, res)) = invocations.next().await {
        match res {
            Ok(fut) => {
                tokio::spawn(async move {
                    if let Err(err) = fut.await {
                        tracing::warn!(?err, instance, name, "invocation failed");
                    }
                });
            }
            Err(err) => tracing::warn!(?err, instance, name, "failed to accept invocation"),
        }
    }
    Ok(())
}

/// Serve the broker over wRPC/TCP on `listener` until cancelled — the minimal
/// serve used by the roundtrip test. (The daemon serves it over WebSocket +
/// WebTransport + iroh beside the capabilities; see [`crate::serve`].)
pub async fn serve_tcp(listener: TcpListener, provider: BrokerProvider) -> anyhow::Result<()> {
    let srv = Arc::new(wrpc_transport::Server::default());
    let accept = tokio::spawn({
        let srv = Arc::clone(&srv);
        async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _addr)) => {
                        let (rx, tx) = stream.into_split();
                        if let Err(err) = srv.accept((), tx, rx).await {
                            tracing::error!(?err, "failed to serve TCP connection");
                        }
                    }
                    Err(err) => tracing::error!(?err, "failed to accept TCP connection"),
                }
            }
        }
    });
    let res = drive_broker(srv.as_ref(), provider).await;
    accept.abort();
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terminal_want() -> CapabilityKind {
        CapabilityKind::Terminal(TerminalRequest {
            shell: None,
            jailed: false,
        })
    }

    #[tokio::test]
    async fn grant_binds_to_browser_origin() {
        use super::bindings::exports::icanhaz::nocap::broker::Handler as _;
        let store = GrantStore::shared();
        let provider = BrokerProvider::new(store, Consent::AutoApprove, Pairings::shared());

        // A request arriving with a browser-attested origin → a web-origin grant.
        let ctx = crate::ReqCtx {
            origin: Some("https://notes.example.com".to_string()),
            peer: None,
        };
        provider
            .request(ctx, terminal_want(), "open a shell".to_string(), None)
            .await
            .unwrap()
            .expect("granted");
        // A request with no origin (loopback / non-browser) → an anonymous peer.
        provider
            .request(
                crate::ReqCtx::default(),
                terminal_want(),
                "open a shell".to_string(),
                None,
            )
            .await
            .unwrap()
            .expect("granted");

        let granted = provider.granted(crate::ReqCtx::default()).await.unwrap();
        assert_eq!(granted.len(), 2);
        assert!(granted
            .iter()
            .any(|g| matches!(g.holder.kind, PrincipalKind::WebOrigin)
                && g.holder.id == "https://notes.example.com"));
        assert!(granted
            .iter()
            .any(|g| matches!(g.holder.kind, PrincipalKind::Peer)));
    }

    #[tokio::test]
    async fn pairing_skips_consent_for_the_origin() {
        use super::bindings::exports::icanhaz::nocap::broker::Handler as _;
        let store = GrantStore::shared();
        let pairings = Pairings::shared();
        let origin = crate::ReqCtx {
            origin: Some("https://notes.example.com".to_string()),
            peer: None,
        };

        // Approve once to pair the origin for `terminal`; a fresh secret comes back.
        let approver = BrokerProvider::new(store.clone(), Consent::AutoApprove, pairings.clone());
        let secret = approver
            .request(origin.clone(), terminal_want(), "first".to_string(), None)
            .await
            .unwrap()
            .expect("granted")
            .pairing
            .expect("a new pairing secret on first approval");

        // A deny-everything broker sharing the same pairings: the paired origin
        // still gets a grant (consent skipped), proving the secret carries trust.
        let denier = BrokerProvider::new(store, Consent::AutoDeny, pairings);
        let g = denier
            .request(
                origin.clone(),
                terminal_want(),
                "second".to_string(),
                Some(secret.clone()),
            )
            .await
            .unwrap()
            .expect("a paired request must skip the (denying) consent");
        assert!(g.pairing.is_none(), "already paired ⇒ no new secret");

        // Without the secret, the denier denies (consent runs).
        assert!(denier
            .request(origin.clone(), terminal_want(), "n".to_string(), None)
            .await
            .unwrap()
            .is_err());
        // Wrong kind with the secret: pairing is kind-scoped ⇒ consent ⇒ denied.
        let fs = CapabilityKind::Filesystem(FsRequest { roots: vec![] });
        assert!(denier
            .request(origin.clone(), fs, "n".to_string(), Some(secret.clone()))
            .await
            .unwrap()
            .is_err());
        // Wrong origin with the secret: pairing is origin-bound ⇒ denied.
        let other = crate::ReqCtx {
            origin: Some("https://evil.example.com".to_string()),
            peer: None,
        };
        assert!(denier
            .request(other, terminal_want(), "n".to_string(), Some(secret))
            .await
            .unwrap()
            .is_err());
    }

    #[test]
    fn pairings_persist_across_reload() {
        // Persist to a throwaway file, then confirm a fresh Pairings loads the trust.
        let path =
            std::env::temp_dir().join(format!("icanhaz-pairings-{}.json", uuid::Uuid::new_v4()));
        let secret = {
            let pairings = Pairings::load(path.clone());
            let mut p = pairings.lock().unwrap();
            p.remember(None, "https://notes.example.com", "filesystem")
                .expect("a fresh secret")
        };

        // A brand-new Pairings reading the same file sees the origin-bound, kind-scoped trust.
        let reloaded = Pairings::load(path.clone());
        let p = reloaded.lock().unwrap();
        assert!(
            p.check(&secret, "https://notes.example.com", "filesystem"),
            "reloaded pairing lost"
        );
        assert!(
            !p.check(&secret, "https://evil.example.com", "filesystem"),
            "pairing must stay origin-bound"
        );
        assert!(
            !p.check(&secret, "https://notes.example.com", "terminal"),
            "pairing must stay kind-scoped"
        );
        drop(p);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn revoking_a_grant_forgets_its_pairing() {
        // Pair an origin for filesystem (as approve-with-remember does) + issue a grant
        // bound to it; `revoke_and_unpair` must drop BOTH, so the origin's stored secret
        // no longer skips consent (a page refresh re-prompts instead of re-granting).
        let grants = GrantStore::shared();
        let pairings = Pairings::shared();
        let origin = "https://site.example";
        let secret = pairings
            .lock()
            .unwrap()
            .remember(None, origin, "filesystem")
            .expect("a fresh secret");

        let principal = Principal {
            kind: PrincipalKind::WebOrigin,
            id: origin.to_string(),
            display_name: None,
        };
        let fs = CapabilityKind::Filesystem(FsRequest { roots: vec![] });
        let token = grants.lock().unwrap().issue(
            fs,
            "filesystem".to_string(),
            Duration::from_secs(60),
            principal,
        );

        assert!(
            pairings
                .lock()
                .unwrap()
                .check(&secret, origin, "filesystem"),
            "pairing should be live pre-revoke"
        );
        assert!(
            revoke_and_unpair(&grants, &pairings, &token),
            "grant should have been live"
        );
        assert!(
            !pairings
                .lock()
                .unwrap()
                .check(&secret, origin, "filesystem"),
            "revoke must forget the pairing so the site re-consents"
        );
    }

    #[tokio::test]
    async fn strict_hosts_record_unapproved_and_gate_them() {
        use super::bindings::exports::icanhaz::nocap::broker::Handler as _;
        let path = std::env::temp_dir().join(format!("ic-hosts-{}.json", uuid::Uuid::new_v4()));
        let hosts = Hosts::load(path.clone(), true); // strict + empty ⇒ everything unapproved
        let store = GrantStore::shared();
        let provider = BrokerProvider::new(store, Consent::AutoApprove, Pairings::shared())
            .with_hosts(hosts.clone());
        let ctx = crate::ReqCtx {
            origin: Some("https://site.example".to_string()),
            peer: None,
        };

        // Unapproved: refused *before* consent (even AutoApprove can't grant), and recorded.
        let denied = provider
            .request(ctx.clone(), terminal_want(), "hi".to_string(), None)
            .await
            .unwrap();
        assert!(
            denied.is_err(),
            "an unapproved host must be refused before consent runs"
        );
        assert!(
            hosts
                .lock()
                .unwrap()
                .list_unknown()
                .iter()
                .any(|(o, _)| o == "https://site.example"),
            "the unapproved host must be recorded for review"
        );

        // Approve it → the request now proceeds (AutoApprove grants), and it's no longer unknown.
        hosts.lock().unwrap().add("https://site.example");
        let granted = provider
            .request(ctx, terminal_want(), "hi".to_string(), None)
            .await
            .unwrap();
        assert!(granted.is_ok(), "an approved host may request");
        assert!(
            hosts.lock().unwrap().list_unknown().is_empty(),
            "approving clears the unknown entry"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn resolve_program_pins_an_absolute_executable() {
        // `sh` is on PATH on every unix → resolves to an absolute executable.
        let sh = resolve_program("sh").expect("sh should resolve");
        assert!(
            sh.is_absolute(),
            "resolved program must be absolute: {sh:?}"
        );
        assert!(sh.ends_with("sh"));
        // A non-existent program resolves to nothing (the request will be refused).
        assert!(resolve_program("definitely-not-a-real-program-xyz").is_none());
        // A real file that isn't executable is not a valid program either.
        assert!(resolve_program("/etc/hosts").is_none());
    }

    #[test]
    fn cli_reply_is_fail_closed() {
        let want = terminal_want();
        for yes in ["y", "yes", "  Y \n", "YES"] {
            assert!(
                matches!(decision_from_reply(yes, &want), Decision::Approve { .. }),
                "{yes:?} should approve"
            );
        }
        for no in ["n", "no", "", "\n", "nope", "yeah", "1", "sure"] {
            assert!(
                matches!(decision_from_reply(no, &want), Decision::Deny(_)),
                "{no:?} must deny"
            );
        }
    }

    fn fs_want(path: &str, rights: FsRights) -> CapabilityKind {
        CapabilityKind::Filesystem(FsRequest {
            roots: vec![PathGrant {
                path: path.to_string(),
                rights,
            }],
        })
    }

    #[test]
    fn narrow_clamps_fs_rights_to_a_subset() {
        let original = fs_want("/proj", FsRights::READ | FsRights::WRITE);
        // The surface tries to *widen* to include delete — clamped back to read+write.
        let widened = fs_want("/proj", FsRights::READ | FsRights::WRITE | FsRights::DELETE);
        let CapabilityKind::Filesystem(got) = narrow(&original, &widened) else {
            panic!("kind changed")
        };
        assert_eq!(got.roots.len(), 1);
        assert_eq!(got.roots[0].rights, FsRights::READ | FsRights::WRITE);

        // Narrowing to read-only is honoured.
        let readonly = fs_want("/proj", FsRights::READ);
        let CapabilityKind::Filesystem(got) = narrow(&original, &readonly) else {
            panic!()
        };
        assert_eq!(got.roots[0].rights, FsRights::READ);
    }

    #[test]
    fn narrow_drops_unoffered_paths_and_empty_roots() {
        let original = fs_want("/proj", FsRights::READ | FsRights::WRITE);
        // A path never offered can't be smuggled in.
        let smuggled = fs_want("/etc", FsRights::READ);
        let CapabilityKind::Filesystem(got) = narrow(&original, &smuggled) else {
            panic!()
        };
        assert!(got.roots.is_empty(), "unoffered path must be dropped");

        // A root the human cleared of all rights is dropped.
        let empty = fs_want("/proj", FsRights::empty());
        let CapabilityKind::Filesystem(got) = narrow(&original, &empty) else {
            panic!()
        };
        assert!(
            got.roots.is_empty(),
            "a root with no rights must be dropped"
        );
    }

    #[test]
    fn narrow_cannot_widen_process_or_change_image() {
        let original = CapabilityKind::Process(ProcessRequest {
            image: "rust-analyzer".into(),
            args: vec!["--stdio".into()],
            guest_chooses_argv: false,
        });
        // Try to swap the image and enable argv — both refused.
        let hostile = CapabilityKind::Process(ProcessRequest {
            image: "rm".into(),
            args: vec!["-rf".into()],
            guest_chooses_argv: true,
        });
        let CapabilityKind::Process(got) = narrow(&original, &hostile) else {
            panic!()
        };
        assert_eq!(got.image, "rust-analyzer", "image is pinned, never swapped");
        assert_eq!(
            got.args,
            vec!["--stdio".to_string()],
            "args are pinned from the request, not the hostile edit"
        );
        assert!(!got.guest_chooses_argv, "argv can't be widened on");
    }

    #[test]
    fn narrow_only_strengthens_terminal_sandbox_and_rejects_kind_change() {
        let original = CapabilityKind::Terminal(TerminalRequest {
            shell: None,
            jailed: false,
        });
        // The human forces the sandbox on.
        let jailed = CapabilityKind::Terminal(TerminalRequest {
            shell: None,
            jailed: true,
        });
        let CapabilityKind::Terminal(got) = narrow(&original, &jailed) else {
            panic!()
        };
        assert!(got.jailed, "jailed can be turned on");

        // A jailed original can't be un-jailed.
        let unjail = CapabilityKind::Terminal(TerminalRequest {
            shell: None,
            jailed: false,
        });
        let orig_jailed = CapabilityKind::Terminal(TerminalRequest {
            shell: None,
            jailed: true,
        });
        let CapabilityKind::Terminal(got) = narrow(&orig_jailed, &unjail) else {
            panic!()
        };
        assert!(got.jailed, "jailed can't be relaxed");

        // Trying to change the category is ignored (original kind kept).
        let cross = fs_want("/proj", FsRights::READ);
        assert!(matches!(
            narrow(&original, &cross),
            CapabilityKind::Terminal(_)
        ));
    }

    #[tokio::test]
    async fn consent_gate_issues_validates_and_revokes() {
        let store = GrantStore::shared();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(serve_tcp(
            listener,
            BrokerProvider::new(store.clone(), Consent::AutoApprove, Pairings::shared()),
        ));
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        let want = terminal_want();

        // Approve → a token; `granted()` lists it.
        let token = client::request(&wrpc, (), &want, "open a shell", None)
            .await
            .expect("invoke request")
            .expect("granted")
            .token;
        assert!(!token.is_empty());
        let granted = client::granted(&wrpc, ()).await.expect("invoke granted");
        assert_eq!(granted.len(), 1);
        assert!(granted[0].summary.contains("terminal"));

        // The grant gates by kind, and an unknown token is refused.
        {
            let store = store.lock().unwrap();
            assert!(store
                .validate(&token, |k| matches!(k, CapabilityKind::Terminal(_)))
                .is_ok());
            assert!(matches!(
                store.validate(&token, |k| matches!(k, CapabilityKind::Filesystem(_))),
                Err(Denied::NotAuthorized)
            ));
            assert!(matches!(
                store.validate("not-a-real-token", |_| true),
                Err(Denied::NotAuthorized)
            ));
        }

        // Revoke → gone from both the audit view and the gate.
        client::revoke(&wrpc, (), &token)
            .await
            .expect("invoke revoke");
        assert_eq!(client::granted(&wrpc, ()).await.unwrap().len(), 0);
        assert!(store.lock().unwrap().validate(&token, |_| true).is_err());

        server.abort();
    }

    #[tokio::test]
    async fn consent_denied_yields_no_grant() {
        let store = GrantStore::shared();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(serve_tcp(
            listener,
            BrokerProvider::new(store.clone(), Consent::AutoDeny, Pairings::shared()),
        ));
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        let denied = client::request(&wrpc, (), &terminal_want(), "open a shell", None)
            .await
            .expect("invoke request");
        assert!(matches!(denied, Err(Denied::UserRejected)));
        assert_eq!(store.lock().unwrap().grants.len(), 0);

        server.abort();
    }

    /// A certified grant persists; after a "restart" (a fresh store with the
    /// same identity) its certificate still redeems, and revoking it removes
    /// the row.
    #[tokio::test]
    async fn certified_grants_survive_a_restart() {
        use crate::broker::bindings::exports::icanhaz::nocap::broker::Handler as _;
        let dir = tempfile::tempdir().unwrap();
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let db = crate::store::Store::open_with(dir.path().join("icanhaz.db"), &source)
            .await
            .unwrap();
        let key = Keypair::generate().unwrap();

        let before = GrantStore::shared();
        before.lock().unwrap().set_identity(key.clone());
        GrantStore::restore(&before, &db).await;
        let token = before.lock().unwrap().issue(
            CapabilityKind::Process(ProcessRequest {
                image: "echo".into(),
                args: vec![],
                guest_chooses_argv: true,
            }),
            "process (echo)".into(),
            Duration::from_secs(600),
            anonymous_principal(),
        );
        let cert = before
            .lock()
            .unwrap()
            .certify(
                &token,
                Audience::Any,
                Duration::from_secs(300),
                Narrowing::allow("size(call.args.args) < 2"),
            )
            .unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;

        // The daemon restarts: a new store with the same identity and database.
        let after = GrantStore::shared();
        after.lock().unwrap().set_identity(key);
        GrantStore::restore(&after, &db).await;
        let provider = BrokerProvider::new(after.clone(), Consent::AutoApprove, Pairings::shared());
        let redeemed = provider
            .redeem(crate::ReqCtx::default(), cert.clone())
            .await
            .unwrap()
            .expect("redeems after restart");
        let one = AdmitCall::new("spawn").arg("args", vec!["x".to_string()]);
        assert!(after.lock().unwrap().admit(&redeemed.token, one).is_ok());
        let two = AdmitCall::new("spawn").arg("args", vec!["x".to_string(), "y".to_string()]);
        let outcome = after.lock().unwrap().admit(&redeemed.token, two);
        assert!(matches!(outcome, Err(Denied::OutOfScope(_))), "{outcome:?}");
        // The restored source token itself still works and lists as before.
        assert!(after.lock().unwrap().validate_process(&token).is_ok());

        // Revoking removes the row: a third restart knows nothing of it.
        assert!(after.lock().unwrap().revoke(&token));
        tokio::time::sleep(Duration::from_millis(200)).await;
        let third = GrantStore::shared();
        GrantStore::restore(&third, &db).await;
        assert!(third.lock().unwrap().validate_process(&token).is_err());
        assert!(db.state_list("broker", "grant:").await.unwrap().is_empty());
    }

    /// Pairings and hosts persist in the store; a legacy JSON file is imported
    /// once and then removed, since it held bearer secrets in plain text.
    #[tokio::test]
    async fn pairings_and_hosts_persist_in_the_store_and_import_legacy_files() {
        let dir = tempfile::tempdir().unwrap();
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let store = crate::store::Store::open_with(dir.path().join("icanhaz.db"), &source)
            .await
            .unwrap();

        let legacy = dir.path().join("pairings.json");
        std::fs::write(
            &legacy,
            r#"{"s1":{"origin":"https://a.example","kinds":["terminal"]}}"#,
        )
        .unwrap();
        let pairings = Pairings::load(legacy.clone());
        Pairings::restore(&pairings, &store).await;
        assert!(!legacy.exists(), "legacy file removed after import");
        assert!(pairings
            .lock()
            .unwrap()
            .check("s1", "https://a.example", "terminal"));

        // A change persists to the store and a fresh instance restores it.
        let secret = pairings
            .lock()
            .unwrap()
            .remember(None, "https://b.example", "process")
            .expect("fresh secret");
        tokio::time::sleep(Duration::from_millis(200)).await;
        let fresh = Pairings::shared();
        Pairings::restore(&fresh, &store).await;
        {
            let fresh = fresh.lock().unwrap();
            assert!(fresh.check(&secret, "https://b.example", "process"));
            assert!(fresh.check("s1", "https://a.example", "terminal"));
        }

        let hosts = Hosts::shared();
        Hosts::restore(&hosts, &store).await;
        hosts.lock().unwrap().add("https://c.example");
        tokio::time::sleep(Duration::from_millis(200)).await;
        let again = Hosts::shared();
        Hosts::restore(&again, &store).await;
        assert_eq!(again.lock().unwrap().list(), vec!["https://c.example"]);
    }
}
