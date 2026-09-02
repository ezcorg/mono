//! icanhazd — serve the NoCap surface (the consent **broker** plus the real
//! `wasi:filesystem`, **terminal**, **process**, **workspace**, and **watch**
//! capabilities) over BOTH WebTransport (QUIC, the primary browser transport) and
//! WebSocket (the fallback), so any browser can request a grant and exercise a
//! consented capability over a real socket.
//!
//! ```text
//! browser ──WebTransport/QUIC─┐                 ┌─ broker   (consent → grant token)
//!                             ├─▶ icanhazd ──▶──┤─ wasi:filesystem · terminal · process
//! browser ──WebSocket─────────┘                 └─ workspace · watch  (all grant-gated)
//! ```
//!
//! Consent defaults to a **console prompt** (`[y/N]` per request, fail-closed);
//! `ICANHAZ_CONSENT=surface` instead serves a loopback **approval page**
//! (`ICANHAZ_APPROVE_BIND`, default `127.0.0.1:7779`) + a notification — the path
//! for a backgrounded daemon. `=auto` / `=deny` skip the human (dev/tests).
//!
//! Env: `ICANHAZ_WS_BIND` (default `127.0.0.1:7777`), `ICANHAZ_WT_BIND` (default
//! `127.0.0.1:7778`), `ICANHAZ_ROOT` (the fs root the jail lives under),
//! `ICANHAZ_FS_COMPONENT` (the wasi:filesystem passthrough `.wasm`), `ICANHAZ_CERT` +
//! `ICANHAZ_KEY` (PEM paths; a self-signed cert is generated if either is
//! absent), `ICANHAZ_CONSENT` (`prompt` default · `surface` · `auto` · `deny`),
//! and `ICANHAZ_APPROVE_BIND` (the approval page, default `127.0.0.1:7779`).

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::Context as _;
use icanhaz_host::approve::{open_approval_page, serve_approval, PendingConsent};
use icanhaz_host::broker::{Consent, GrantStore, Hosts, Pairings};
use icanhaz_host::daemon::{run, DaemonConfig};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Tracing off unless RUST_LOG is set (e.g. `wrpc_transport::frame::conn=trace`).
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("off")),
        )
        .with_writer(std::io::stderr)
        .init();

    let ws_bind = std::env::var("ICANHAZ_WS_BIND").unwrap_or_else(|_| "127.0.0.1:7777".to_string());
    let wt_bind: SocketAddr = std::env::var("ICANHAZ_WT_BIND")
        .unwrap_or_else(|_| "127.0.0.1:7778".to_string())
        .parse()
        .context("invalid ICANHAZ_WT_BIND")?;
    let root = std::env::var("ICANHAZ_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("icanhaz-demo-root"));

    // The grant store the broker mints into and every gated capability checks.
    let grants = GrantStore::shared();
    // Durable, origin-bound trust: pairings persist across restarts (override the
    // location with ICANHAZ_PAIRINGS; default a dotfile in $HOME).
    let pairings_path = std::env::var("ICANHAZ_PAIRINGS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string()))
                .join(".icanhaz-pairings.json")
        });
    let pairings = Pairings::load(pairings_path);
    // Approved-hosts allowlist (who may initiate requests). Empty ⇒ allow all.
    let hosts_path = std::env::var("ICANHAZ_HOSTS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string()))
                .join(".icanhaz-hosts.json")
        });
    let hosts = Hosts::load(hosts_path, false); // headless: permissive (empty ⇒ allow all)
    let (consent, consent_label) = match std::env::var("ICANHAZ_CONSENT").as_deref() {
        Ok("auto") => (
            Consent::AutoApprove,
            "auto-approve (ICANHAZ_CONSENT=auto)".to_string(),
        ),
        Ok("deny") => (
            Consent::AutoDeny,
            "auto-deny (ICANHAZ_CONSENT=deny)".to_string(),
        ),
        Ok("surface") => {
            let approve_bind = std::env::var("ICANHAZ_APPROVE_BIND")
                .unwrap_or_else(|_| "127.0.0.1:7779".to_string());
            let approve_url = format!("http://{approve_bind}");
            let pending = PendingConsent::new(approve_url.clone());
            let approve_listener = TcpListener::bind(&approve_bind)
                .await
                .with_context(|| format!("failed to bind approval surface on {approve_bind}"))?;
            tokio::spawn(serve_approval(
                approve_listener,
                pending.clone(),
                uuid::Uuid::new_v4().to_string(),
            ));
            // Bring the approval page up now, so it's already polling `/pending` when
            // a request (and its notification) arrives on this backgrounded daemon.
            open_approval_page(&approve_url);
            (
                Consent::Surface(pending),
                format!("approve at {approve_url} (loopback page)"),
            )
        }
        _ => (
            Consent::cli_prompt(),
            "prompt — approve each request at this console [y/N]".to_string(),
        ),
    };

    // Real wasi:filesystem@0.2 (the gated passthrough). Path overridable via
    // ICANHAZ_FS_COMPONENT; default relative to this crate.
    let fs_component = std::env::var("ICANHAZ_FS_COMPONENT").unwrap_or_else(|_| {
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../policies/fs-passthrough/target/wasm32-wasip2/debug/fs_passthrough.wasm"
        )
        .to_string()
    });

    let config = DaemonConfig {
        ws_bind,
        wt_bind,
        root,
        fs_component: PathBuf::from(fs_component),
        cert: std::env::var("ICANHAZ_CERT").ok(),
        key: std::env::var("ICANHAZ_KEY").ok(),
        consent_label,
    };
    run(config, grants, pairings, hosts, consent).await
}
