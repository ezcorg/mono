//! One-call daemon bring-up, shared by the headless `icanhazd` binary and the
//! native (Tauri) app. Seeds the demo jail, builds every capability provider against
//! a shared grant store + consent, generates (or loads) the WebTransport identity,
//! and serves the whole NoCap surface over WebSocket + WebTransport until a transport
//! errors.
//!
//! The shared stores + [`Consent`] are passed in (not built here) so a caller — the
//! native app in particular — can also hold them: the tray/audit view lists the same
//! `grants`, and the app injects its own native consent surface.

use core::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::Context as _;
use tokio::net::TcpListener;

use crate::broker::{BrokerProvider, Consent, GrantStore, Hosts, Pairings};
use crate::configuration::{self, Declared, Instance, UserInput};
use crate::providers::Providers;
use crate::store::Store;
use crate::process::ProcessProvider;
use crate::serve::{serve_websocket_all, serve_webtransport_all, FsServe};
use crate::terminal::TerminalProvider;
use crate::watch::WatchProvider;
use crate::workspace::WorkspaceProvider;

/// Where the daemon binds and finds its bits.
pub struct DaemonConfig {
    /// WebSocket bind, e.g. `127.0.0.1:7777`.
    pub ws_bind: String,
    /// WebTransport bind, e.g. `127.0.0.1:7778`.
    pub wt_bind: SocketAddr,
    /// The fs root the demo jail lives under (also the preopen for `wasi:filesystem`).
    pub root: std::path::PathBuf,
    /// The `wasi:filesystem` passthrough component (`.wasm`).
    pub fs_component: std::path::PathBuf,
    /// WebTransport TLS: PEM cert/key paths; a self-signed cert is generated if either
    /// is absent.
    pub cert: Option<String>,
    pub key: Option<String>,
    /// Human-legible consent mode, for the startup banner.
    pub consent_label: String,
}

/// Seed the demo tree under `root`: one file inside the jail, one outside, plus a
/// minimal Cargo crate so a native LSP (rust-analyzer) has a real workspace when the
/// browser edits Rust under the grant.
fn seed_jail(root: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(root.join("jail")).context("create demo root")?;
    std::fs::write(root.join("jail/hello.txt"), b"hello from inside the jail\n")?;
    std::fs::create_dir_all(root.join("jail/src")).context("create jail crate")?;
    std::fs::write(
        root.join("jail/Cargo.toml"),
        b"[package]\nname = \"jail-demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[workspace]\n",
    )?;
    std::fs::write(
        root.join("jail/src/main.rs"),
        "fn main() {\n    println!(\"edit me over wRPC — rust-analyzer runs on the host\");\n}\n"
            .as_bytes(),
    )?;
    std::fs::write(root.join("secret.txt"), b"this file is OUTSIDE the jail\n")?;
    Ok(())
}

/// The daemon's durable services: the store (declared configuration + per-owner
/// state) and everything configured through it. Built by the caller with
/// [`Services::open`] so the native app can hold it too: its settings surface
/// lists and edits the same configuration the capabilities read.
#[derive(Clone)]
pub struct Services {
    /// `None` when the store could not be opened: the daemon still runs, with
    /// providers from the environment only and no persisted budgets.
    pub store: Option<Store>,
    pub providers: Arc<Providers>,
    /// The broker's signing key: persisted in the store (`broker/identity`)
    /// so certificates outlive a restart; ephemeral without one.
    pub identity: ezcap::Keypair,
}

impl Services {
    /// Open the default store (warning, not failing, when it cannot be) and
    /// load everything configured through it.
    pub async fn open() -> Self {
        let store = match Store::open(Store::default_path()).await {
            Ok(store) => Some(store),
            Err(e) => {
                tracing::warn!(error = %e, "store unavailable; running without persistence");
                None
            }
        };
        Self::with_store(store).await
    }

    pub async fn with_store(store: Option<Store>) -> Self {
        let providers = Arc::new(Providers::load(store.clone()).await);
        let identity = match &store {
            Some(store) => load_identity(store).await,
            None => None,
        };
        let identity = identity.unwrap_or_else(|| {
            tracing::warn!("broker identity is ephemeral: certificates will not survive a restart");
            ezcap::Keypair::generate().unwrap_or_else(|e| panic!("no randomness: {e}"))
        });
        Self {
            store,
            providers,
            identity,
        }
    }

    /// Every declared configuration with its configured instances (secrets
    /// masked). Without a store, each schema lists no instances.
    pub async fn configuration(&self) -> anyhow::Result<Vec<(Declared, Vec<Instance>)>> {
        let mut out = Vec::new();
        for declared in configuration::declared() {
            let instances = match &self.store {
                Some(store) => declared.instances(store).await?,
                None => Vec::new(),
            };
            out.push((declared, instances));
        }
        Ok(out)
    }

    /// Create or update one configured instance of `capability`'s schema, then
    /// let that capability pick the change up.
    pub async fn configure(
        &self,
        capability: &str,
        instance: &str,
        inputs: &[UserInput],
    ) -> anyhow::Result<()> {
        let (declared, store) = self.target(capability)?;
        declared.set(store, instance, inputs).await?;
        self.reload(capability).await;
        Ok(())
    }

    /// Remove one configured instance. `Ok(false)` if there was none.
    pub async fn unconfigure(&self, capability: &str, instance: &str) -> anyhow::Result<bool> {
        let (declared, store) = self.target(capability)?;
        let removed = declared.remove(store, instance).await?;
        self.reload(capability).await;
        Ok(removed)
    }

    fn target(&self, capability: &str) -> anyhow::Result<(Declared, &Store)> {
        let Some(declared) = configuration::declared()
            .into_iter()
            .find(|d| d.capability == capability)
        else {
            anyhow::bail!("`{capability}` declares no configuration");
        };
        let Some(store) = &self.store else {
            anyhow::bail!("the store is unavailable, so configuration cannot be saved");
        };
        Ok((declared, store))
    }

    /// The capabilities that cache their configuration re-read it here.
    async fn reload(&self, capability: &str) {
        if capability == "inference" {
            self.providers.reload().await;
        }
    }
}

/// The broker's persisted signing key, generated on first run. Lives in the
/// generic state table under the `broker` owner, like any other capability's
/// durable state.
async fn load_identity(store: &Store) -> Option<ezcap::Keypair> {
    match store.state_get("broker", "identity").await {
        Ok(Some(bytes)) => {
            let seed: Option<[u8; 32]> = bytes.try_into().ok();
            match seed {
                Some(seed) => return Some(ezcap::Keypair::from_bytes(&seed)),
                None => tracing::warn!("stored broker identity is malformed; regenerating"),
            }
        }
        Ok(None) => {}
        Err(e) => {
            tracing::warn!(error = %e, "could not read the broker identity");
            return None;
        }
    }
    let key = ezcap::Keypair::generate().ok()?;
    if let Err(e) = store.state_set("broker", "identity", &key.to_bytes()).await {
        tracing::warn!(error = %e, "could not persist the broker identity");
        return None;
    }
    Some(key)
}

/// Bring the whole NoCap surface up and serve it until a transport errors. `grants`,
/// `pairings`, `consent` and `services` are supplied by the caller (see the module docs).
pub async fn run(
    config: DaemonConfig,
    grants: Arc<Mutex<GrantStore>>,
    pairings: Arc<Mutex<Pairings>>,
    hosts: Arc<Mutex<Hosts>>,
    consent: Consent,
    services: Services,
) -> anyhow::Result<()> {
    seed_jail(&config.root)?;

    // Every capability shares one grant store: a token from `broker.request` is the
    // same one fs + terminal validate. `hosts` gates which origins may even prompt.
    let broker = BrokerProvider::new(grants.clone(), consent, pairings).with_hosts(hosts);
    let terminal = TerminalProvider::new(grants.clone());
    let process = ProcessProvider::new(grants.clone());
    let workspace = WorkspaceProvider::new(config.root.clone(), grants.clone());
    let watch = WatchProvider::new(config.root.clone(), grants.clone());
    let Services {
        providers, identity, ..
    } = services;
    grants.lock().unwrap().set_identity(identity);
    let inference = crate::inference::InferenceProvider::new(grants.clone(), providers.clone());
    let fs_serve = FsServe {
        component_path: config.fs_component.clone(),
        root: config.root.clone(),
        grants: grants.clone(),
    };

    // TLS identity for WebTransport: user-supplied cert/key, else self-signed.
    let identity = match (&config.cert, &config.key) {
        (Some(cert), Some(key)) => wtransport::Identity::load_pemfiles(cert, key)
            .await
            .with_context(|| format!("failed to load cert `{cert}` / key `{key}`"))?,
        _ => wtransport::Identity::self_signed(["localhost", "127.0.0.1", "::1"])
            .context("failed to generate self-signed certificate")?,
    };
    let cert_hashes = identity.certificate_chain().as_slice()[0]
        .hash()
        .fmt(wtransport::tls::Sha256DigestFmt::BytesArray);

    let ws_listener = TcpListener::bind(&config.ws_bind)
        .await
        .with_context(|| format!("failed to bind WebSocket on {}", config.ws_bind))?;

    eprintln!("icanhaz — broker (consent gate) + terminal + process + real wasi:filesystem + workspace + watch + inference:");
    eprintln!(
        "  inference    : {} model(s) configured",
        providers.models().len()
    );
    eprintln!("  WebSocket    : ws://{}", config.ws_bind);
    eprintln!("  WebTransport : https://{}", config.wt_bind);
    eprintln!("  cert hashes  : {cert_hashes}");
    eprintln!("                 ^ paste into the browser demo (serverCertificateHashes)");
    eprintln!("  consent      : {}", config.consent_label);
    eprintln!("  root (jail)  : {}", config.root.display());

    // One wRPC server per transport, all capabilities on it (wRPC routes by instance
    // name); broker + terminal + process + workspace + watch share `grants`.
    tokio::try_join!(
        serve_websocket_all(
            ws_listener,
            broker.clone(),
            terminal.clone(),
            process.clone(),
            workspace.clone(),
            watch.clone(),
            inference.clone(),
            fs_serve.clone()
        ),
        serve_webtransport_all(
            config.wt_bind,
            identity,
            broker,
            terminal,
            process,
            workspace,
            watch,
            inference,
            fs_serve
        ),
    )?;
    Ok(())
}
