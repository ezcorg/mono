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

pub(crate) mod bindings {
    wit_bindgen_wrpc::generate!({
        world: "broker-wrpc",
        path: "../wit",
        // `types` references `wasi:clocks` (caveat::expires(datetime)); generate
        // those bindings inline rather than expecting them already in scope.
        with: {
            "wasi:clocks/wall-clock@0.2.0": generate,
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
pub use bindings::icanhaz::nocap::types::{
    CapabilityKind, FsRequest, FsRights, PathGrant, ProcessRequest, TerminalRequest,
};
use bindings::icanhaz::nocap::types::{Denied, GrantInfo, Principal, PrincipalKind};

/// The outcome of asking a human (or a stand-in) for consent.
pub enum Decision {
    /// Grant `grant` — the possibly-**attenuated** capability the human approved (a
    /// subset of what was requested; the auto/CLI paths approve as-requested) — valid
    /// for `ttl`. `remember` ⇒ pair the origin (durable consent — skip the prompt next
    /// time); else a one-time grant.
    Approve { grant: CapabilityKind, ttl: Duration, remember: bool },
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

    pub async fn decide(&self, want: &CapabilityKind, reason: &str, requester: &str) -> Decision {
        match self {
            Consent::AutoApprove => {
                Decision::Approve { grant: want.clone(), ttl: GRANT_TTL, remember: true }
            }
            Consent::AutoDeny => Decision::Deny(Denied::UserRejected),
            Consent::CliPrompt(lock) => cli_decide(lock, want, reason, requester).await,
            Consent::Surface(pending) => surface_decide(pending, want, reason, requester).await,
        }
    }
}

/// Map a human's typed reply to a decision — **fail-closed**: only an explicit
/// `y`/`yes` approves; everything else (incl. empty / EOF) denies.
fn decision_from_reply(reply: &str, want: &CapabilityKind) -> Decision {
    match reply.trim().to_ascii_lowercase().as_str() {
        "y" | "yes" => Decision::Approve { grant: want.clone(), ttl: GRANT_TTL, remember: true },
        _ => Decision::Deny(Denied::UserRejected),
    }
}

/// Prompt the human at the daemon's console and await their decision. Serialized
/// on `lock` so concurrent requests queue rather than interleave on the tty.
async fn cli_decide(
    lock: &Arc<tokio::sync::Mutex<()>>,
    want: &CapabilityKind,
    reason: &str,
    requester: &str,
) -> Decision {
    use std::io::Write as _;
    use tokio::io::AsyncBufReadExt as _;

    let _guard = lock.lock().await;
    eprint!(
        "\n┌─ icanhaz consent ──────────────────────────────\n\
         │ requester : {}\n\
         │ wants     : {}\n\
         │ reason    : {}\n\
         └ approve? [y/N] ",
        requester,
        summarize(want),
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
            Decision::Approve { grant, ttl: Duration::from_secs(approval.ttl_secs), remember: approval.remember }
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

/// The live set of issued grants, keyed by their (secret) token. Shared between
/// the broker (which mints into it) and the capabilities (which `validate`
/// against it).
#[derive(Default)]
pub struct GrantStore {
    grants: HashMap<String, Grant>,
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
        let token = mint_token();
        self.grants.insert(
            token.clone(),
            Grant { kind, summary, expires: Instant::now() + ttl, principal, cancel: CancellationToken::new() },
        );
        token
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
        if grant.expires <= Instant::now() {
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
        if grant.expires <= Instant::now() {
            return Err(Denied::Revoked);
        }
        match &grant.kind {
            CapabilityKind::Filesystem(req) => Ok(req.roots.iter().map(|r| r.path.clone()).collect()),
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
        if grant.expires <= Instant::now() {
            return Err(Denied::Revoked);
        }
        match &grant.kind {
            CapabilityKind::Process(req) => Ok(req.clone()),
            _ => Err(Denied::NotAuthorized),
        }
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
                true
            }
            None => false,
        }
    }

    /// The revocation signal for a live grant — a streaming capability awaits it at
    /// session start to end its stream + release its resource on revoke/expiry.
    pub fn revocation(&self, token: &str) -> Option<Revocation> {
        self.grants.get(token).map(|g| Revocation { cancel: g.cancel.clone(), expires: g.expires })
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

/// Durable, per-origin trust: presenting a pairing secret for an origin skips the
/// consent prompt for the kinds that origin was approved for. The secret is
/// stored by the browser in **origin-partitioned** storage (only the paired
/// origin's JS can read it) and bound here to that origin + the kinds it covers —
/// so a secret used from another origin (or with no origin) doesn't match.
/// (In-memory: a daemon restart forgets pairings and the human re-approves once.)
pub struct Pairings {
    by_secret: HashMap<String, Pairing>,
    /// Where pairings persist across restarts (None = in-memory only, e.g. tests).
    path: Option<PathBuf>,
}

#[derive(Serialize, Deserialize)]
struct Pairing {
    origin: String,
    kinds: HashSet<String>,
}

impl Pairings {
    /// In-memory only (tests, or a daemon told not to persist).
    pub fn shared() -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self { by_secret: HashMap::new(), path: None }))
    }

    /// Load pairings from `path` (empty if absent/unreadable) and persist every later
    /// change back to it — durable, origin-bound trust across daemon restarts.
    pub fn load(path: PathBuf) -> Arc<Mutex<Self>> {
        let by_secret = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Arc::new(Mutex::new(Self { by_secret, path: Some(path) }))
    }

    /// Best-effort persist to `path` (if any). Called after every mutation.
    fn save(&self) {
        let Some(path) = &self.path else { return };
        match serde_json::to_string_pretty(&self.by_secret) {
            Ok(json) => {
                if let Err(err) = std::fs::write(path, json) {
                    tracing::warn!(?err, path = %path.display(), "failed to persist pairings");
                }
            }
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
    fn remember(&mut self, presented: Option<&str>, origin: &str, kind: &'static str) -> Option<String> {
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
            Pairing { origin: origin.to_string(), kinds: HashSet::from([kind.to_string()]) },
        );
        self.save();
        Some(secret)
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
        by_origin.into_iter().map(|(o, ks)| (o, ks.into_iter().collect())).collect()
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
    path: Option<PathBuf>,
}

impl Hosts {
    pub fn shared() -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self { allowed: HashSet::new(), seen: HashMap::new(), strict: false, path: None }))
    }

    /// Load the allowlist. `strict` ⇒ only approved origins may prompt (the app);
    /// otherwise an empty allowlist is permissive (headless default).
    pub fn load(path: PathBuf, strict: bool) -> Arc<Mutex<Self>> {
        let allowed = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Arc::new(Mutex::new(Self { allowed, seen: HashMap::new(), strict, path: Some(path) }))
    }

    fn save(&self) {
        if let Some(path) = &self.path {
            if let Ok(s) = serde_json::to_string_pretty(&self.allowed) {
                let _ = std::fs::write(path, s);
            }
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
        self.seen.entry(origin.to_string()).or_default().insert(kind.to_string());
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
}

/// The capability *kind* a pairing covers (the variant tag, not its parameters).
fn kind_tag(want: &CapabilityKind) -> &'static str {
    match want {
        CapabilityKind::Filesystem(_) => "filesystem",
        CapabilityKind::Sockets(_) => "sockets",
        CapabilityKind::Process(_) => "process",
        CapabilityKind::Terminal(_) => "terminal",
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
        Self { store, consent, pairings, hosts: Hosts::shared() }
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
    }
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
                        .map(|o| PathGrant { path: r.path.clone(), rights: r.rights & o.rights })
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
        // Sockets aren't served yet (no provider); pass through unchanged. Any
        // kind mismatch ⇒ the original — the category can't be changed here.
        _ => original.clone(),
    }
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
        // The requesting principal comes from the transport, not the request body:
        // the browser-attested `Origin` (which page JS can't forge), never a value
        // the caller hands us. `None` ⇒ a non-browser / loopback peer.
        let origin = cx.origin();
        let kind = kind_tag(&want);
        let principal = principal_from_origin(origin);
        let summary = summarize(&want);

        // Host allowlist: an unapproved origin is refused *before* the consent surface,
        // so no prompt or OS notification fires — it's only recorded for the app's
        // review list, where the user can approve the host (see `Hosts`).
        if let Some(o) = origin {
            let mut hosts = self.hosts.lock().unwrap();
            if !hosts.is_allowed(o) {
                hosts.record_seen(o, kind);
                tracing::info!(origin = %o, kind, "request from an unapproved host — recorded, not prompted");
                return Ok(Err(Denied::NotAuthorized));
            }
        }

        // Fast path: an origin presenting a valid pairing for this kind skips the
        // consent prompt entirely — that is the durable, origin-bound trust.
        if let (Some(o), Some(s)) = (origin, pairing.as_deref()) {
            if self.pairings.lock().unwrap().check(s, o, kind) {
                tracing::info!(origin = %o, kind, "paired — consent skipped");
                let token = self.store.lock().unwrap().issue(want, summary, GRANT_TTL, principal);
                return Ok(Ok(GrantReply { token, pairing: None }));
            }
        }

        let requester = principal_label(&principal);
        match self.consent.decide(&want, &reason, &requester).await {
            Decision::Deny(denied) => {
                tracing::info!(%requester, %summary, %reason, "consent denied");
                Ok(Err(denied))
            }
            Decision::Approve { grant, ttl, remember } => {
                // Pair the origin (if it has one AND the human chose to remember)
                // so future requests of this kind skip consent; hand back a fresh
                // secret only on the first pairing.
                let new_secret = if remember {
                    origin.and_then(|o| self.pairings.lock().unwrap().remember(pairing.as_deref(), o, kind))
                } else {
                    None
                };
                // Issue the (possibly attenuated) grant the human actually approved —
                // its summary, not the original request's, is what the audit view shows.
                let granted_summary = summarize(&grant);
                tracing::info!(%requester, summary = %granted_summary, %reason, remember, paired = new_secret.is_some(), "consent granted");
                let token = self.store.lock().unwrap().issue(grant, granted_summary, ttl, principal);
                Ok(Ok(GrantReply { token, pairing: new_secret }))
            }
        }
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

    async fn revoke(&self, _cx: C, grant: String) -> anyhow::Result<()> {
        self.store.lock().unwrap().grants.remove(&grant);
        Ok(())
    }
}

/// Serve the broker over wRPC/TCP on `listener` until cancelled — the minimal
/// serve used by the roundtrip test. (The daemon serves it over WebSocket +
/// WebTransport beside the capabilities; see [`crate::serve`].)
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

    let invocations = bindings::serve(srv.as_ref(), provider)
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
    accept.abort();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terminal_want() -> CapabilityKind {
        CapabilityKind::Terminal(TerminalRequest { shell: None, jailed: false })
    }

    #[tokio::test]
    async fn grant_binds_to_browser_origin() {
        use super::bindings::exports::icanhaz::nocap::broker::Handler as _;
        let store = GrantStore::shared();
        let provider = BrokerProvider::new(store, Consent::AutoApprove, Pairings::shared());

        // A request arriving with a browser-attested origin → a web-origin grant.
        let ctx = crate::ReqCtx { origin: Some("https://notes.example.com".to_string()) };
        provider
            .request(ctx, terminal_want(), "open a shell".to_string(), None)
            .await
            .unwrap()
            .expect("granted");
        // A request with no origin (loopback / non-browser) → an anonymous peer.
        provider
            .request(crate::ReqCtx::default(), terminal_want(), "open a shell".to_string(), None)
            .await
            .unwrap()
            .expect("granted");

        let granted = provider.granted(crate::ReqCtx::default()).await.unwrap();
        assert_eq!(granted.len(), 2);
        assert!(granted.iter().any(|g| matches!(g.holder.kind, PrincipalKind::WebOrigin)
            && g.holder.id == "https://notes.example.com"));
        assert!(granted.iter().any(|g| matches!(g.holder.kind, PrincipalKind::Peer)));
    }

    #[tokio::test]
    async fn pairing_skips_consent_for_the_origin() {
        use super::bindings::exports::icanhaz::nocap::broker::Handler as _;
        let store = GrantStore::shared();
        let pairings = Pairings::shared();
        let origin = crate::ReqCtx { origin: Some("https://notes.example.com".to_string()) };

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
            .request(origin.clone(), terminal_want(), "second".to_string(), Some(secret.clone()))
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
        let other = crate::ReqCtx { origin: Some("https://evil.example.com".to_string()) };
        assert!(denier
            .request(other, terminal_want(), "n".to_string(), Some(secret))
            .await
            .unwrap()
            .is_err());
    }

    #[test]
    fn pairings_persist_across_reload() {
        // Persist to a throwaway file, then confirm a fresh Pairings loads the trust.
        let path = std::env::temp_dir().join(format!("icanhaz-pairings-{}.json", uuid::Uuid::new_v4()));
        let secret = {
            let pairings = Pairings::load(path.clone());
            let mut p = pairings.lock().unwrap();
            p.remember(None, "https://notes.example.com", "filesystem").expect("a fresh secret")
        };

        // A brand-new Pairings reading the same file sees the origin-bound, kind-scoped trust.
        let reloaded = Pairings::load(path.clone());
        let p = reloaded.lock().unwrap();
        assert!(p.check(&secret, "https://notes.example.com", "filesystem"), "reloaded pairing lost");
        assert!(!p.check(&secret, "https://evil.example.com", "filesystem"), "pairing must stay origin-bound");
        assert!(!p.check(&secret, "https://notes.example.com", "terminal"), "pairing must stay kind-scoped");
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
        let secret = pairings.lock().unwrap().remember(None, origin, "filesystem").expect("a fresh secret");

        let principal = Principal { kind: PrincipalKind::WebOrigin, id: origin.to_string(), display_name: None };
        let fs = CapabilityKind::Filesystem(FsRequest { roots: vec![] });
        let token = grants.lock().unwrap().issue(fs, "filesystem".to_string(), Duration::from_secs(60), principal);

        assert!(pairings.lock().unwrap().check(&secret, origin, "filesystem"), "pairing should be live pre-revoke");
        assert!(revoke_and_unpair(&grants, &pairings, &token), "grant should have been live");
        assert!(
            !pairings.lock().unwrap().check(&secret, origin, "filesystem"),
            "revoke must forget the pairing so the site re-consents"
        );
    }

    #[tokio::test]
    async fn strict_hosts_record_unapproved_and_gate_them() {
        use super::bindings::exports::icanhaz::nocap::broker::Handler as _;
        let path = std::env::temp_dir().join(format!("ic-hosts-{}.json", uuid::Uuid::new_v4()));
        let hosts = Hosts::load(path.clone(), true); // strict + empty ⇒ everything unapproved
        let store = GrantStore::shared();
        let provider = BrokerProvider::new(store, Consent::AutoApprove, Pairings::shared()).with_hosts(hosts.clone());
        let ctx = crate::ReqCtx { origin: Some("https://site.example".to_string()) };

        // Unapproved: refused *before* consent (even AutoApprove can't grant), and recorded.
        let denied = provider.request(ctx.clone(), terminal_want(), "hi".to_string(), None).await.unwrap();
        assert!(denied.is_err(), "an unapproved host must be refused before consent runs");
        assert!(
            hosts.lock().unwrap().list_unknown().iter().any(|(o, _)| o == "https://site.example"),
            "the unapproved host must be recorded for review"
        );

        // Approve it → the request now proceeds (AutoApprove grants), and it's no longer unknown.
        hosts.lock().unwrap().add("https://site.example");
        let granted = provider.request(ctx, terminal_want(), "hi".to_string(), None).await.unwrap();
        assert!(granted.is_ok(), "an approved host may request");
        assert!(hosts.lock().unwrap().list_unknown().is_empty(), "approving clears the unknown entry");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn cli_reply_is_fail_closed() {
        let want = terminal_want();
        for yes in ["y", "yes", "  Y \n", "YES"] {
            assert!(matches!(decision_from_reply(yes, &want), Decision::Approve { .. }), "{yes:?} should approve");
        }
        for no in ["n", "no", "", "\n", "nope", "yeah", "1", "sure"] {
            assert!(matches!(decision_from_reply(no, &want), Decision::Deny(_)), "{no:?} must deny");
        }
    }

    fn fs_want(path: &str, rights: FsRights) -> CapabilityKind {
        CapabilityKind::Filesystem(FsRequest { roots: vec![PathGrant { path: path.to_string(), rights }] })
    }

    #[test]
    fn narrow_clamps_fs_rights_to_a_subset() {
        let original = fs_want("/proj", FsRights::READ | FsRights::WRITE);
        // The surface tries to *widen* to include delete — clamped back to read+write.
        let widened = fs_want("/proj", FsRights::READ | FsRights::WRITE | FsRights::DELETE);
        let CapabilityKind::Filesystem(got) = narrow(&original, &widened) else { panic!("kind changed") };
        assert_eq!(got.roots.len(), 1);
        assert_eq!(got.roots[0].rights, FsRights::READ | FsRights::WRITE);

        // Narrowing to read-only is honoured.
        let readonly = fs_want("/proj", FsRights::READ);
        let CapabilityKind::Filesystem(got) = narrow(&original, &readonly) else { panic!() };
        assert_eq!(got.roots[0].rights, FsRights::READ);
    }

    #[test]
    fn narrow_drops_unoffered_paths_and_empty_roots() {
        let original = fs_want("/proj", FsRights::READ | FsRights::WRITE);
        // A path never offered can't be smuggled in.
        let smuggled = fs_want("/etc", FsRights::READ);
        let CapabilityKind::Filesystem(got) = narrow(&original, &smuggled) else { panic!() };
        assert!(got.roots.is_empty(), "unoffered path must be dropped");

        // A root the human cleared of all rights is dropped.
        let empty = fs_want("/proj", FsRights::empty());
        let CapabilityKind::Filesystem(got) = narrow(&original, &empty) else { panic!() };
        assert!(got.roots.is_empty(), "a root with no rights must be dropped");
    }

    #[test]
    fn narrow_cannot_widen_process_or_change_image() {
        let original = CapabilityKind::Process(ProcessRequest { image: "rust-analyzer".into(), args: vec!["--stdio".into()], guest_chooses_argv: false });
        // Try to swap the image and enable argv — both refused.
        let hostile = CapabilityKind::Process(ProcessRequest { image: "rm".into(), args: vec!["-rf".into()], guest_chooses_argv: true });
        let CapabilityKind::Process(got) = narrow(&original, &hostile) else { panic!() };
        assert_eq!(got.image, "rust-analyzer", "image is pinned, never swapped");
        assert_eq!(got.args, vec!["--stdio".to_string()], "args are pinned from the request, not the hostile edit");
        assert!(!got.guest_chooses_argv, "argv can't be widened on");
    }

    #[test]
    fn narrow_only_strengthens_terminal_sandbox_and_rejects_kind_change() {
        let original = CapabilityKind::Terminal(TerminalRequest { shell: None, jailed: false });
        // The human forces the sandbox on.
        let jailed = CapabilityKind::Terminal(TerminalRequest { shell: None, jailed: true });
        let CapabilityKind::Terminal(got) = narrow(&original, &jailed) else { panic!() };
        assert!(got.jailed, "jailed can be turned on");

        // A jailed original can't be un-jailed.
        let unjail = CapabilityKind::Terminal(TerminalRequest { shell: None, jailed: false });
        let orig_jailed = CapabilityKind::Terminal(TerminalRequest { shell: None, jailed: true });
        let CapabilityKind::Terminal(got) = narrow(&orig_jailed, &unjail) else { panic!() };
        assert!(got.jailed, "jailed can't be relaxed");

        // Trying to change the category is ignored (original kind kept).
        let cross = fs_want("/proj", FsRights::READ);
        assert!(matches!(narrow(&original, &cross), CapabilityKind::Terminal(_)));
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
            assert!(store.validate(&token, |k| matches!(k, CapabilityKind::Terminal(_))).is_ok());
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
        client::revoke(&wrpc, (), &token).await.expect("invoke revoke");
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
}
