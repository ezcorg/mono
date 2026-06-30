//! Serve the **mediated** capability over wRPC — the remote edge of the policy
//! engine.
//!
//! A `wit-bindgen-wrpc` server exposes the `fs-lite` interface; each call is
//! routed into the wasmtime [`Composed`](crate::Composed) policy composition, so
//! a remote peer invoking `fs-lite.read` over wRPC actually travels:
//!
//! ```text
//! client ──wRPC──▶ this server ──▶ policy component (wasmtime) ──▶ raw host fs
//! ```
//!
//! Transport is TCP here (the wRPC layer is transport-agnostic); swapping in
//! `wrpc-websockets` for the browser is a drop-in change of the accept loop.

use core::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context as _;
use futures::stream::select_all;
use futures::StreamExt as _;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use wit_bindgen_wrpc::bytes::Bytes;

use crate::broker::GrantStore;
use crate::Composed;

pub(crate) mod bindings {
    wit_bindgen_wrpc::generate!({
        world: "fs-wrpc",
        path: "../wit",
    });
}

/// The generated wRPC **client** functions for the consented `fs`
/// (`read` / `write` / `read_dir`, each taking a grant).
pub use bindings::icanhaz::nocap::fs as client;

/// wRPC handler backed by a single wasmtime policy composition. The composition
/// holds a non-`Sync` wasmtime `Store`, so calls serialize through a mutex. It
/// also holds the shared grant store, so it enforces the consent gate (a live
/// `filesystem` grant) before delegating to the membrane.
#[derive(Clone)]
pub struct FsLiteProvider {
    composed: Arc<Mutex<Composed>>,
    grants: Arc<std::sync::Mutex<GrantStore>>,
}

impl FsLiteProvider {
    pub fn new(composed: Composed, grants: Arc<std::sync::Mutex<GrantStore>>) -> Self {
        Self { composed: Arc::new(Mutex::new(composed)), grants }
    }

    /// The consent gate: require a live `filesystem` grant, returning the path
    /// prefixes it negotiated (for the membrane). The denial message goes into the
    /// `result` error when the token isn't a filesystem grant.
    fn check(&self, grant: &str) -> Result<Vec<String>, String> {
        self.grants
            .lock()
            .unwrap()
            .validate_filesystem(grant)
            .map_err(|d| format!("fs denied: {d:?}"))
    }
}

// Context is `()` so the one handler serves over every transport (WebSocket's and
// WebTransport's wRPC `Server` both use a `()` context); the policy is what
// matters, not the peer address.
impl<C: Send + Sync + 'static> bindings::exports::icanhaz::nocap::fs::Handler<C>
    for FsLiteProvider
{
    async fn read(&self, _cx: C, grant: String, path: String) -> anyhow::Result<Result<Bytes, String>> {
        let paths = match self.check(&grant) {
            Ok(p) => p,
            Err(e) => return Ok(Err(e)),
        };
        let mut c = self.composed.lock().await;
        c.set_only_paths(paths);
        let r = c.read(&path).await.map_err(|e| anyhow::anyhow!("policy host error: {e:?}"))?;
        Ok(r.map(Bytes::from))
    }

    async fn write(
        &self,
        _cx: C,
        grant: String,
        path: String,
        data: Bytes,
    ) -> anyhow::Result<Result<(), String>> {
        let paths = match self.check(&grant) {
            Ok(p) => p,
            Err(e) => return Ok(Err(e)),
        };
        let mut c = self.composed.lock().await;
        c.set_only_paths(paths);
        c.write(&path, data.as_ref()).await.map_err(|e| anyhow::anyhow!("policy host error: {e:?}"))
    }

    async fn read_dir(
        &self,
        _cx: C,
        grant: String,
        dir: String,
    ) -> anyhow::Result<Result<Vec<String>, String>> {
        let paths = match self.check(&grant) {
            Ok(p) => p,
            Err(e) => return Ok(Err(e)),
        };
        let mut c = self.composed.lock().await;
        c.set_only_paths(paths);
        c.read_dir(&dir).await.map_err(|e| anyhow::anyhow!("policy host error: {e:?}"))
    }
}

/// Serve the mediated `fs-lite` over wRPC/TCP on `listener` until cancelled.
pub async fn serve_tcp(listener: TcpListener, provider: FsLiteProvider) -> anyhow::Result<()> {
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
        .context("failed to serve fs-lite")?;
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

/// Serve the mediated `fs-lite` over wRPC/**WebSocket** on `listener` until
/// cancelled. Same wRPC layer as [`serve_tcp`] — only the per-connection upgrade
/// differs. This is the browser-facing transport (WebSocket works on iOS Safari;
/// WebTransport does not). wRPC opens one connection per invocation.
pub async fn serve_websocket(listener: TcpListener, provider: FsLiteProvider) -> anyhow::Result<()> {
    let srv = Arc::new(wrpc_transport::Server::default());
    let accept = tokio::spawn({
        let srv = Arc::clone(&srv);
        async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _addr)) => {
                        // Handshake per connection off the accept path.
                        let srv = Arc::clone(&srv);
                        tokio::spawn(async move {
                            match wrpc_websockets::ServerBuilder::new().accept(stream).await {
                                Ok((_req, ws)) => {
                                    let (tx, rx) = wrpc_websockets::split(ws);
                                    if let Err(err) = srv.accept((), tx, rx).await {
                                        tracing::error!(?err, "failed to accept WS invocation");
                                    }
                                }
                                Err(err) => tracing::error!(?err, "WebSocket handshake failed"),
                            }
                        });
                    }
                    Err(err) => tracing::error!(?err, "failed to accept TCP connection"),
                }
            }
        }
    });

    let invocations = bindings::serve(srv.as_ref(), provider)
        .await
        .context("failed to serve fs-lite")?;
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

/// Serve the mediated `fs-lite` over wRPC/**WebTransport** (HTTP/3 over QUIC) —
/// the primary browser transport (Safari 26.4+, Chrome, Firefox). Requires TLS,
/// so the caller supplies a `wtransport::Identity` (a user cert or a self-signed
/// one). Same wRPC frame codec + handler as [`serve_websocket`]; only the stream
/// source differs — a QUIC **bidi stream** per invocation instead of a WS
/// connection. `ready`, if given, receives the bound address once the endpoint
/// is listening (handy for tests binding an ephemeral port).
pub async fn serve_webtransport(
    bind: SocketAddr,
    identity: wtransport::Identity,
    provider: FsLiteProvider,
    ready: Option<tokio::sync::oneshot::Sender<SocketAddr>>,
) -> anyhow::Result<()> {
    use core::time::Duration;
    use wtransport::{Endpoint, ServerConfig};

    let ep = Endpoint::server(
        ServerConfig::builder()
            .with_bind_address(bind)
            .with_identity(identity)
            .keep_alive_interval(Some(Duration::from_secs(3)))
            .build(),
    )
    .context("failed to create WebTransport endpoint")?;
    if let Some(tx) = ready {
        let _ = tx.send(ep.local_addr().context("WebTransport local addr")?);
    }

    let srv = Arc::new(wrpc_webtransport::Server::new());
    let accept = tokio::spawn({
        let srv = Arc::clone(&srv);
        async move {
            loop {
                let incoming = ep.accept().await;
                let srv = Arc::clone(&srv);
                // One QUIC connection carries many invocations (one bidi stream each).
                tokio::spawn(async move {
                    let res = async {
                        let conn = incoming.await.context("accept WT session")?;
                        let conn = conn.accept().await.context("establish WT session")?;
                        loop {
                            let (tx, rx) = conn.accept_bi().await.context("accept bidi stream")?;
                            srv.accept((), tx, rx).await.context("serve wRPC stream")?;
                        }
                        #[allow(unreachable_code)]
                        anyhow::Ok(())
                    }
                    .await;
                    if let Err(err) = res {
                        tracing::debug!(?err, "WebTransport connection ended");
                    }
                });
            }
        }
    });

    let invocations = bindings::serve(srv.as_ref(), provider)
        .await
        .context("failed to serve fs-lite (WebTransport)")?;
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
    use crate::broker::{CapabilityKind, FsRequest, FsRights, PathGrant};
    use std::path::PathBuf;
    use std::time::Duration;

    fn component_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../policies/fs-lite-pathjail/target/wasm32-wasip2/debug/fs_lite_pathjail.wasm")
    }

    /// Stand in for a prior consented request: mint a live `filesystem` grant
    /// scoped to `/jail/` (the `only-paths` caveat the membrane jails to).
    fn fs_grant(grants: &Arc<std::sync::Mutex<GrantStore>>) -> String {
        grants.lock().unwrap().issue(
            CapabilityKind::Filesystem(FsRequest {
                roots: vec![PathGrant {
                    path: "/jail/".to_string(),
                    rights: FsRights::READ | FsRights::WRITE | FsRights::CREATE,
                }],
            }),
            "filesystem (/jail/)".to_string(),
            Duration::from_secs(60),
            crate::broker::anonymous_principal(),
        )
    }

    #[tokio::test]
    async fn mediated_capability_over_wrpc() {
        let wasm = component_path();
        assert!(wasm.exists(), "build the fs-lite-pathjail component first ({})", wasm.display());

        let root = tempfile::tempdir().unwrap();
        let composed = Composed::load(&wasm, root.path()).await.unwrap();
        let grants = GrantStore::shared();
        let grant = fs_grant(&grants);
        let provider = FsLiteProvider::new(composed, grants);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(serve_tcp(listener, provider));
        // Let the accept loop + serve registration come up before invoking.
        tokio::time::sleep(Duration::from_millis(150)).await;

        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        // Inside the jail: write + read round-trip across the wire, through the
        // policy component, to a real file under the temp root.
        assert!(client::write(&wrpc, (), &grant, "/jail/a.txt", &Bytes::from_static(b"hi")).await.unwrap().is_ok());
        let got = client::read(&wrpc, (), &grant, "/jail/a.txt").await.unwrap().unwrap();
        assert_eq!(got.as_ref(), b"hi");

        // Outside the jail: the policy denies it — over wRPC, same as in-process.
        assert!(client::read(&wrpc, (), &grant, "/etc/passwd").await.unwrap().is_err());

        server.abort();
    }

    #[tokio::test]
    async fn mediated_capability_over_websocket() {
        let wasm = component_path();
        assert!(wasm.exists(), "build the fs-lite-pathjail component first ({})", wasm.display());

        let root = tempfile::tempdir().unwrap();
        let composed = Composed::load(&wasm, root.path()).await.unwrap();
        let grants = GrantStore::shared();
        let grant = fs_grant(&grants);
        let provider = FsLiteProvider::new(composed, grants);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(serve_websocket(listener, provider));
        tokio::time::sleep(Duration::from_millis(150)).await;

        // Same wRPC calls, now over a WebSocket — the browser's transport.
        let wrpc = wrpc_websockets::Client::from(
            wrpc_websockets::ClientBuilder::new().uri(&format!("ws://{addr}")).unwrap(),
        );

        assert!(client::write(&wrpc, (), &grant, "/jail/a.txt", &Bytes::from_static(b"ws")).await.unwrap().is_ok());
        let got = client::read(&wrpc, (), &grant, "/jail/a.txt").await.unwrap().unwrap();
        assert_eq!(got.as_ref(), b"ws");
        assert!(client::read(&wrpc, (), &grant, "/etc/passwd").await.unwrap().is_err());

        server.abort();
    }

    #[tokio::test]
    async fn mediated_capability_over_webtransport() {
        use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
        use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
        use rustls::{DigitallySignedStruct, SignatureScheme};

        // Self-signed dev cert → skip verification on the client (the browser
        // pins the cert hash instead; here we only need to prove the transport).
        #[derive(Debug)]
        struct Insecure;
        impl ServerCertVerifier for Insecure {
            fn verify_server_cert(&self, _: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
                Ok(ServerCertVerified::assertion())
            }
            fn verify_tls12_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
                Ok(HandshakeSignatureValid::assertion())
            }
            fn verify_tls13_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
                Ok(HandshakeSignatureValid::assertion())
            }
            fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
                vec![SignatureScheme::ECDSA_NISTP256_SHA256]
            }
        }

        let _ = rustls::crypto::ring::default_provider().install_default();

        let wasm = component_path();
        assert!(wasm.exists(), "build the fs-lite-pathjail component first ({})", wasm.display());
        let root = tempfile::tempdir().unwrap();
        let composed = Composed::load(&wasm, root.path()).await.unwrap();
        let grants = GrantStore::shared();
        let grant = fs_grant(&grants);
        let provider = FsLiteProvider::new(composed, grants);

        let identity = wtransport::Identity::self_signed(["localhost", "127.0.0.1", "::1"]).unwrap();
        let bind: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(serve_webtransport(bind, identity, provider, Some(ready_tx)));
        let addr = ready_rx.await.unwrap();

        let mut tls = rustls::ClientConfig::builder_with_protocol_versions(&[&rustls::version::TLS13])
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(Insecure))
            .with_no_client_auth();
        tls.alpn_protocols.push(wtransport::tls::WEBTRANSPORT_ALPN.to_vec());
        let ep = wtransport::Endpoint::client(
            wtransport::ClientConfig::builder().with_bind_default().with_custom_tls(tls).build(),
        )
        .unwrap();
        let conn = ep.connect(format!("https://{addr}")).await.unwrap();
        let wrpc = wrpc_webtransport::Client::from(conn);

        // Same wRPC calls, now over WebTransport/QUIC — the browser's primary transport.
        assert!(client::write(&wrpc, (), &grant, "/jail/a.txt", &Bytes::from_static(b"wt")).await.unwrap().is_ok());
        let got = client::read(&wrpc, (), &grant, "/jail/a.txt").await.unwrap().unwrap();
        assert_eq!(got.as_ref(), b"wt");
        assert!(client::read(&wrpc, (), &grant, "/etc/passwd").await.unwrap().is_err());

        server.abort();
    }

    #[tokio::test]
    async fn fs_refused_without_grant() {
        let wasm = component_path();
        assert!(wasm.exists(), "build the fs-lite-pathjail component first ({})", wasm.display());
        let root = tempfile::tempdir().unwrap();
        let composed = Composed::load(&wasm, root.path()).await.unwrap();
        let grants = GrantStore::shared(); // empty — no grant ever issued
        let provider = FsLiteProvider::new(composed, grants);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(serve_tcp(listener, provider));
        tokio::time::sleep(Duration::from_millis(150)).await;

        let wrpc = wrpc_transport::tcp::Client::from(&addr);
        // A bogus token on an in-jail path: refused at the gate, before the membrane.
        match client::read(&wrpc, (), "bogus-token", "/jail/hello.txt").await.unwrap() {
            Err(msg) => assert!(msg.contains("denied"), "unexpected refusal: {msg}"),
            Ok(_) => panic!("an ungranted fs read must be refused"),
        }

        server.abort();
    }

    #[tokio::test]
    async fn fs_grant_caveats_narrow_the_jail() {
        let wasm = component_path();
        assert!(wasm.exists(), "build the fs-lite-pathjail component first ({})", wasm.display());
        let root = tempfile::tempdir().unwrap();
        let composed = Composed::load(&wasm, root.path()).await.unwrap();
        let grants = GrantStore::shared();
        // A grant scoped to /jail/notes/ — strictly narrower than the /jail/ tree.
        let grant = grants.lock().unwrap().issue(
            CapabilityKind::Filesystem(FsRequest {
                roots: vec![PathGrant {
                    path: "/jail/notes/".to_string(),
                    rights: FsRights::READ | FsRights::WRITE | FsRights::CREATE,
                }],
            }),
            "filesystem (/jail/notes/)".to_string(),
            Duration::from_secs(60),
            crate::broker::anonymous_principal(),
        );
        let provider = FsLiteProvider::new(composed, grants);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(serve_tcp(listener, provider));
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        // Inside the granted subtree: allowed.
        assert!(client::write(&wrpc, (), &grant, "/jail/notes/a.txt", &Bytes::from_static(b"ok")).await.unwrap().is_ok());
        // Under /jail/ but OUTSIDE the grant's paths: the grant's caveat denies it,
        // even though the daemon's jail would otherwise allow all of /jail/.
        match client::read(&wrpc, (), &grant, "/jail/other.txt").await.unwrap() {
            Err(msg) => assert!(msg.contains("denied"), "unexpected: {msg}"),
            Ok(_) => panic!("/jail/other.txt is outside the grant's /jail/notes/ — must be denied"),
        }

        server.abort();
    }
}
