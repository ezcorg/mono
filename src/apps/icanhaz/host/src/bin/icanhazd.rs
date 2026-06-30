//! icanhazd (skeleton) — serve the NoCap surface (the consent **broker** plus the
//! `fs-lite` and **terminal** capabilities) over BOTH WebTransport (QUIC, the
//! primary browser transport) and WebSocket (the fallback), so any browser can
//! request a grant and exercise a consented capability over a real socket.
//!
//! ```text
//! browser ──WebTransport/QUIC─┐                 ┌─ broker  (consent → grant token)
//!                             ├─▶ icanhazd ──▶──┤─ fs-lite (policy membrane → raw fs)
//! browser ──WebSocket─────────┘                 └─ terminal (grant-gated PTY)
//! ```
//!
//! Consent defaults to a **console prompt** (`[y/N]` per request, fail-closed);
//! `ICANHAZ_CONSENT=surface` instead serves a loopback **approval page**
//! (`ICANHAZ_APPROVE_BIND`, default `127.0.0.1:7779`) + a notification — the path
//! for a backgrounded daemon. `=auto` / `=deny` skip the human (dev/tests).
//!
//! Env: `ICANHAZ_WS_BIND` (default `127.0.0.1:7777`), `ICANHAZ_WT_BIND` (default
//! `127.0.0.1:7778`), `ICANHAZ_COMPONENT` (the policy `.wasm`), `ICANHAZ_ROOT`
//! (the raw fs root the policy mediates), and `ICANHAZ_CERT` + `ICANHAZ_KEY`
//! (PEM paths; a self-signed cert is generated if either is absent),
//! `ICANHAZ_CONSENT` (`prompt` default · `surface` · `auto` · `deny`), and
//! `ICANHAZ_APPROVE_BIND` (the approval page, default `127.0.0.1:7779`).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::Context as _;
use icanhaz_host::approve::{serve_approval, PendingConsent};
use icanhaz_host::broker::{BrokerProvider, Consent, GrantStore, Pairings};
use icanhaz_host::process::ProcessProvider;
use icanhaz_host::provider::FsLiteProvider;
use icanhaz_host::serve::{serve_webtransport_all, serve_websocket_all, FsServe};
use icanhaz_host::terminal::TerminalProvider;
use icanhaz_host::Composed;
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
    let component = std::env::var("ICANHAZ_COMPONENT").unwrap_or_else(|_| {
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../policies/fs-lite-pathjail/target/wasm32-wasip2/debug/fs_lite_pathjail.wasm"
        )
        .to_string()
    });
    let root = std::env::var("ICANHAZ_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("icanhaz-demo-root"));

    // Seed a demo tree: one file inside the jail, one outside.
    std::fs::create_dir_all(root.join("jail")).context("create demo root")?;
    std::fs::write(root.join("jail/hello.txt"), b"hello from inside the jail\n")?;
    std::fs::write(root.join("secret.txt"), b"this file is OUTSIDE the jail\n")?;

    let composed = Composed::load(Path::new(&component), &root)
        .await
        .map_err(|e| anyhow::anyhow!("failed to load policy composition: {e:?}"))?;
    // The grant store the broker mints into and every gated capability checks:
    // one token from `broker.request` is the same one fs + terminal validate.
    let grants = GrantStore::shared();
    let pairings = Pairings::shared();
    let provider = FsLiteProvider::new(composed, grants.clone());
    let (consent, consent_label) = match std::env::var("ICANHAZ_CONSENT").as_deref() {
        Ok("auto") => (Consent::AutoApprove, "auto-approve (ICANHAZ_CONSENT=auto)".to_string()),
        Ok("deny") => (Consent::AutoDeny, "auto-deny (ICANHAZ_CONSENT=deny)".to_string()),
        Ok("surface") => {
            let approve_bind =
                std::env::var("ICANHAZ_APPROVE_BIND").unwrap_or_else(|_| "127.0.0.1:7779".to_string());
            let approve_url = format!("http://{approve_bind}");
            let pending = PendingConsent::new(approve_url.clone());
            let approve_listener = TcpListener::bind(&approve_bind)
                .await
                .with_context(|| format!("failed to bind approval surface on {approve_bind}"))?;
            tokio::spawn(serve_approval(approve_listener, pending.clone(), uuid::Uuid::new_v4().to_string()));
            (Consent::Surface(pending), format!("approve at {approve_url}"))
        }
        _ => (Consent::cli_prompt(), "prompt — approve each request at this console [y/N]".to_string()),
    };
    let broker = BrokerProvider::new(grants.clone(), consent, pairings);
    let terminal = TerminalProvider::new(grants.clone());
    let process = ProcessProvider::new(grants.clone());

    // Real wasi:filesystem@0.2 (the gated passthrough), preopen-jailed to the demo
    // jail. Component path overridable via ICANHAZ_FS_COMPONENT.
    let fs_component = std::env::var("ICANHAZ_FS_COMPONENT").unwrap_or_else(|_| {
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../policies/fs-passthrough/target/wasm32-wasip2/debug/fs_passthrough.wasm"
        )
        .to_string()
    });
    let fs_serve = FsServe {
        component_path: PathBuf::from(&fs_component),
        root: root.clone(),
        grants: grants.clone(),
    };

    // TLS identity for WebTransport: user-supplied cert/key, else self-signed.
    let identity = match (std::env::var("ICANHAZ_CERT"), std::env::var("ICANHAZ_KEY")) {
        (Ok(cert), Ok(key)) => wtransport::Identity::load_pemfiles(&cert, &key)
            .await
            .with_context(|| format!("failed to load cert `{cert}` / key `{key}`"))?,
        _ => wtransport::Identity::self_signed(["localhost", "127.0.0.1", "::1"])
            .context("failed to generate self-signed certificate")?,
    };
    let cert_hashes = identity.certificate_chain().as_slice()[0]
        .hash()
        .fmt(wtransport::tls::Sha256DigestFmt::BytesArray);

    let ws_listener = TcpListener::bind(&ws_bind)
        .await
        .with_context(|| format!("failed to bind WebSocket on {ws_bind}"))?;

    eprintln!("icanhazd — broker (consent gate) + fs (gated; path-jail to /jail/) + terminal (login shell) + process (grant-pinned programs), one endpoint:");
    eprintln!("  WebSocket    : ws://{ws_bind}");
    eprintln!("  WebTransport : https://{wt_bind}");
    eprintln!("  cert hashes  : {cert_hashes}");
    eprintln!("                 ^ paste into the browser demo (serverCertificateHashes)");
    eprintln!("  consent      : {consent_label}");
    eprintln!("  fs-lite root : {}", root.display());
    eprintln!("  wasi:fs      : real wasi:filesystem@0.2.12 (gated; mount → grant-scoped descriptor), preopen {}", root.display());
    eprintln!("  process      : spawn grant-pinned host programs (LSP / build tools), piped stdio");

    // One wRPC server per transport, all capabilities on it (wRPC routes by
    // instance name); broker + terminal + process share `grants`.
    tokio::try_join!(
        serve_websocket_all(ws_listener, broker.clone(), provider.clone(), terminal.clone(), process.clone(), fs_serve.clone()),
        serve_webtransport_all(wt_bind, identity, broker, provider, terminal, process, fs_serve),
    )?;
    Ok(())
}
