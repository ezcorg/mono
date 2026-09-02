//! Test scaffolding shared by unit tests and the `e2e` integration crate.
//!
//! Exempt from the panic-adjacent lints the rest of the crate denies. These
//! run only under test, and a helper that cannot build its fixture should
//! abort the test at the point of failure rather than thread a `Result` that
//! every call site would immediately unwrap anyway. The lints stay in force
//! for the daemon and proxy paths, where a panic takes down live traffic.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::net::SocketAddr;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::sync::OnceLock;

use anyhow::Result;
use http_body_util::BodyExt;
use hyper_util::rt::TokioExecutor;
use reqwest::Certificate;
use reqwest::Proxy;
use serde::Deserialize;
use serde::Serialize;
use serde_json;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_rustls::TlsAcceptor;
use tracing::error;

use crate::Db;
use crate::PluginRegistry;
use crate::ProxyServer;
use crate::Runtime;
use crate::WitmProxy;
use crate::{AppConfig, CertificateAuthority};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    Http1,
    Http2,
}

pub struct ServerHandle {
    listen_addr: SocketAddr,
    shutdown_tx: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

impl ServerHandle {
    pub fn listen_addr(&self) -> SocketAddr {
        self.listen_addr
    }

    pub async fn shutdown(self) {
        let _ = self.shutdown_tx.send(());
        let _ = self.task.await;
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EchoResponse {
    pub method: String,
    pub path: String,
    pub query: Option<String>,
    pub headers: std::collections::HashMap<String, String>,
    pub body: Option<String>,
    pub body_error: Option<String>,
}

pub async fn create_plugin_registry() -> Result<(PluginRegistry, tempfile::TempDir)> {
    let (db, temp_dir) = create_db().await;
    let runtime = Runtime::try_default().unwrap();
    Ok((PluginRegistry::new(db, runtime)?, temp_dir))
}

/// Register the `wasm-test-component` WASM plugin for testing.
/// The component adds a `"witmproxy":"req"` header to requests
/// and a `"witmproxy":"res"` header to responses.
///
/// In conjunction with our echo server, we can verify that the target server
/// received the modified request, and that the client received the modified response.
pub async fn register_test_component(registry: &PluginRegistry) -> Result<(), anyhow::Error> {
    let wasm_path = test_component_path()?;
    let component_bytes = std::fs::read(&wasm_path)?;

    // Use the actual plugin_from_component method to test the real code path
    let plugin = registry.plugin_from_component(component_bytes).await?;
    registry.register_plugin(plugin).await
}

pub async fn register_noop_plugin(registry: &PluginRegistry) -> Result<(), anyhow::Error> {
    let wasm_path = noop_plugin_path()?;
    let component_bytes = std::fs::read(&wasm_path)?;

    // Use the actual plugin_from_component method to test the real code path
    let plugin = registry.plugin_from_component(component_bytes).await?;
    registry.register_plugin(plugin).await
}

pub async fn register_noshorts_plugin(registry: &PluginRegistry) -> Result<(), anyhow::Error> {
    let wasm_path = noshorts_plugin_path()?;
    let component_bytes = std::fs::read(&wasm_path)?;

    // Use the actual plugin_from_component method to test the real code path
    let plugin = registry.plugin_from_component(component_bytes).await?;
    registry.register_plugin(plugin).await
}

pub async fn create_db() -> (Db, tempfile::TempDir) {
    let temp_dir = tempfile::tempdir().unwrap();
    let db_path = temp_dir.path().join("test.db");
    let db = Db::from_path(db_path, "test_password").await.unwrap();
    db.migrate().await.unwrap();
    (db, temp_dir)
}

pub async fn create_witmproxy() -> Result<(
    WitmProxy,
    Arc<PluginRegistry>,
    CertificateAuthority,
    AppConfig,
    tempfile::TempDir,
)> {
    let (ca, config) = create_ca_and_config().await;
    let (registry, temp_dir) = create_plugin_registry().await?;
    let registry = Arc::new(registry);
    let proxy = WitmProxy::new(ca.clone(), Some(registry.clone()), config.clone());
    Ok((proxy, registry, ca, config, temp_dir))
}

pub async fn create_proxy_server() -> (ProxyServer, CertificateAuthority, AppConfig) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (ca, config) = create_ca_and_config().await;
    let proxy = ProxyServer::new(ca.clone(), None, config.clone()).unwrap();
    (proxy, ca, config)
}

pub async fn create_ca_and_config() -> (CertificateAuthority, AppConfig) {
    let cert_dir = tempfile::tempdir().unwrap();
    let ca = CertificateAuthority::new(cert_dir).await.unwrap();
    let config = AppConfig::default();
    (ca, config)
}

/// Creates an echo server that converts the received request into a JSON response.
pub async fn create_json_echo_server(
    host: &str,
    port: Option<u16>,
    ca: CertificateAuthority,
    proto: Protocol,
) -> ServerHandle {
    let port = port.unwrap_or(0); // Use OS-assigned port if None

    let cert = ca
        .get_certificate_for_domain(host)
        .await
        .expect("CA mint failed");

    let cert_chain = vec![
        cert.cert_der.clone(),
        ca.get_root_certificate_der().unwrap().into(),
    ];

    let mut cfg = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(cert_chain, cert.key_der)
        .expect("server cert");
    cfg.alpn_protocols = match proto {
        Protocol::Http1 => vec![b"http/1.1".to_vec()],
        Protocol::Http2 => vec![b"h2".to_vec()],
    };

    let acceptor = TlsAcceptor::from(Arc::new(cfg));
    let listener = TcpListener::bind((host, port))
        .await
        .expect("bind target listener");
    let listen_addr = listener.local_addr().unwrap();
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();

    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    break;
                }
                result = listener.accept() => {
                    let (stream, _) = match result {
                        Ok(s) => s,
                        Err(e) => {
                            error!("accept error: {e}");
                            continue;
                        }
                    };

                    let acceptor = acceptor.clone();
                    tokio::spawn(async move {
                        match acceptor.accept(stream).await {
                            Ok(tls) => {
                                let io = hyper_util::rt::TokioIo::new(tls);

                                let svc = hyper::service::service_fn(|req| async move {
                                    // Extract request details
                                    let method = req.method().to_string();
                                    let uri = req.uri();
                                    let path = uri.path().to_string();
                                    let query = uri.query().map(|q| q.to_string());

                                    // Extract headers
                                    let mut headers = std::collections::HashMap::new();
                                    for (name, value) in req.headers() {
                                        headers.insert(
                                            name.to_string(),
                                            value.to_str().unwrap_or("").to_string(),
                                        );
                                    }

                                    // Extract body
                                    let (body, body_error) = match BodyExt::collect(req.into_body()).await {
                                        Ok(collected) => {
                                            let bytes = collected.to_bytes();
                                            let body_str = String::from_utf8_lossy(&bytes).to_string();
                                            (Some(body_str), None)
                                        },
                                        Err(e) => {
                                            (None, Some(format!("Failed to read body: {}", e)))
                                        }
                                    };

                                    let response = EchoResponse {
                                        method,
                                        path,
                                        query,
                                        headers,
                                        body,
                                        body_error: body_error.clone(),
                                    };

                                    // Create response JSON
                                    let mut response_data = serde_json::to_value(&response).unwrap_or_else(|_| serde_json::json!({"error": "Failed to serialize response"}));

                                    if let Some(error) = body_error {
                                        response_data["body_error"] = serde_json::Value::String(error);
                                    }

                                    let response_body = response_data.to_string();

                                    Ok::<_, hyper::Error>(
                                        hyper::Response::builder()
                                            .header("content-type", "application/json")
                                            .body(http_body_util::Full::new(bytes::Bytes::from(response_body)))
                                            .unwrap()
                                    )
                                });

                                match proto {
                                    Protocol::Http1 => {
                                        if let Err(e) = hyper::server::conn::http1::Builder::new()
                                            .serve_connection(io, svc)
                                            .await
                                        {
                                            error!("http1 error: {e}");
                                        }
                                    }
                                    Protocol::Http2 => {
                                        if let Err(e) = hyper::server::conn::http2::Builder::new(
                                            TokioExecutor::new(),
                                        )
                                        .serve_connection(io, svc)
                                        .await
                                        {
                                            error!("http2 error: {e}");
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                error!("tls accept error: {e}");
                            }
                        }
                    });
                }
            }
        }
    });

    ServerHandle {
        listen_addr,
        shutdown_tx,
        task,
    }
}

/// Creates a static HTML server that returns a simple HTML document.
pub async fn create_html_server(
    host: &str,
    port: Option<u16>,
    ca: CertificateAuthority,
    proto: Protocol,
) -> ServerHandle {
    create_html_server_with_body(host, port, ca, proto, DEFAULT_TEST_HTML.to_string()).await
}

/// The page `create_html_server` serves by default.
pub const DEFAULT_TEST_HTML: &str = r#"<!DOCTYPE html>
<html>
<head>
    <title>Test Page</title>
</head>
<body>
    <h1>Hello from test server</h1>
</body>
</html>"#;

/// Like [`create_html_server`], but serves a caller-supplied page.
///
/// Exists so tests can serve a body large enough to span many stream chunks:
/// the default fixture fits in a single read, which hides size-dependent
/// behaviour in the content-rewriting pipeline.
pub async fn create_html_server_with_body(
    host: &str,
    port: Option<u16>,
    ca: CertificateAuthority,
    proto: Protocol,
    body: String,
) -> ServerHandle {
    let port = port.unwrap_or(0); // Use OS-assigned port if None

    let cert = ca
        .get_certificate_for_domain(host)
        .await
        .expect("CA mint failed");

    let cert_chain = vec![
        cert.cert_der.clone(),
        ca.get_root_certificate_der().unwrap().into(),
    ];

    let mut cfg = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(cert_chain, cert.key_der)
        .expect("server cert");
    cfg.alpn_protocols = match proto {
        Protocol::Http1 => vec![b"http/1.1".to_vec()],
        Protocol::Http2 => vec![b"h2".to_vec()],
    };

    let acceptor = TlsAcceptor::from(Arc::new(cfg));
    let listener = TcpListener::bind((host, port))
        .await
        .expect("bind target listener");
    let listen_addr = listener.local_addr().unwrap();
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();

    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    break;
                }
                result = listener.accept() => {
                    let (stream, _) = match result {
                        Ok(s) => s,
                        Err(e) => {
                            error!("accept error: {e}");
                            continue;
                        }
                    };

                    let acceptor = acceptor.clone();
                    let body = body.clone();
                    tokio::spawn(async move {
                        match acceptor.accept(stream).await {
                            Ok(tls) => {
                                let io = hyper_util::rt::TokioIo::new(tls);

                                let body = body.clone();
                                let svc = hyper::service::service_fn(move |_req| {
                                    let html = body.clone();
                                    async move {
                                        Ok::<_, hyper::Error>(
                                            hyper::Response::builder()
                                                .header("content-type", "text/html")
                                                .body(http_body_util::Full::new(
                                                    bytes::Bytes::from(html),
                                                ))
                                                .unwrap(),
                                        )
                                    }
                                });

                                match proto {
                                    Protocol::Http1 => {
                                        if let Err(e) = hyper::server::conn::http1::Builder::new()
                                            .serve_connection(io, svc)
                                            .await
                                        {
                                            error!("http1 error: {e}");
                                        }
                                    }
                                    Protocol::Http2 => {
                                        if let Err(e) = hyper::server::conn::http2::Builder::new(
                                            TokioExecutor::new(),
                                        )
                                        .serve_connection(io, svc)
                                        .await
                                        {
                                            error!("http2 error: {e}");
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                error!("tls accept error: {e}");
                            }
                        }
                    });
                }
            }
        }
    });

    ServerHandle {
        listen_addr,
        shutdown_tx,
        task,
    }
}

pub async fn create_hello_server(
    host: &str,
    port: u16,
    ca: CertificateAuthority,
    proto: Protocol,
) -> ServerHandle {
    let cert = ca
        .get_certificate_for_domain(host)
        .await
        .expect("CA mint failed");

    let cert_chain = vec![
        cert.cert_der.clone(),
        ca.get_root_certificate_der().unwrap().into(),
    ];

    let mut cfg = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(cert_chain, cert.key_der)
        .expect("server cert");
    cfg.alpn_protocols = match proto {
        Protocol::Http1 => vec![b"http/1.1".to_vec()],
        Protocol::Http2 => vec![b"h2".to_vec()],
    };

    let acceptor = TlsAcceptor::from(Arc::new(cfg));
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .expect("bind target listener");
    let listen_addr = listener.local_addr().unwrap();
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();

    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    break;
                }
                result = listener.accept() => {
                    let (stream, _) = match result {
                        Ok(s) => s,
                        Err(e) => {
                            error!("accept error: {e}");
                            continue;
                        }
                    };

                    let acceptor = acceptor.clone();
                    tokio::spawn(async move {
                        match acceptor.accept(stream).await {
                            Ok(tls) => {
                                let io = hyper_util::rt::TokioIo::new(tls);

                                let svc = hyper::service::service_fn(|_req| async {
                                    Ok::<_, hyper::Error>(hyper::Response::new(
                                        http_body_util::Full::new(bytes::Bytes::from("hello world")),
                                    ))
                                });

                                match proto {
                                    Protocol::Http1 => {
                                        if let Err(e) = hyper::server::conn::http1::Builder::new()
                                            .serve_connection(io, svc)
                                            .await
                                        {
                                            error!("http1 error: {e}");
                                        }
                                    }
                                    Protocol::Http2 => {
                                        if let Err(e) = hyper::server::conn::http2::Builder::new(
                                            TokioExecutor::new(),
                                        )
                                        .serve_connection(io, svc)
                                        .await
                                        {
                                            error!("http2 error: {e}");
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                error!("tls accept error: {e}");
                            }
                        }
                    });
                }
            }
        }
    });

    ServerHandle {
        listen_addr,
        shutdown_tx,
        task,
    }
}

pub async fn create_client(
    ca: CertificateAuthority,
    proxy: &str,
    proto: Protocol,
) -> reqwest::Client {
    let mut builder = reqwest::Client::builder();

    builder = match proto {
        Protocol::Http1 => builder.http1_only(),
        Protocol::Http2 => builder.http2_prior_knowledge(),
    };

    // Configure proxy to ensure Host header is properly handled
    let proxy_config = Proxy::all(proxy).unwrap();

    builder
        .add_root_certificate(
            Certificate::from_der(&ca.get_root_certificate_der().unwrap().clone()).unwrap(),
        )
        .proxy(proxy_config)
        .default_headers({
            let mut headers = reqwest::header::HeaderMap::new();
            // Ensure we always have standard headers that might be expected
            headers.insert(
                reqwest::header::USER_AGENT,
                "witmproxy-test/1.0".parse().unwrap(),
            );
            headers
        })
        .build()
        .unwrap()
}
/// Path to the deliberately hostile test component, building it on demand.
///
/// Unsigned on purpose: the fixture declares an empty public key so the host
/// skips signature verification, which keeps `wasmsign2` out of the test path.
pub fn adversarial_component_path() -> Result<String> {
    static PATH: OnceLock<Result<String, String>> = OnceLock::new();
    memoized(&PATH, || {
        let component = build_component(
            "witmproxy-plugin-adversarial",
            "witmproxy_plugin_adversarial",
        )?;
        Ok(component.to_string_lossy().into_owned())
    })
}

pub fn test_component_path() -> Result<String> {
    static PATH: OnceLock<Result<String, String>> = OnceLock::new();
    memoized(&PATH, || {
        signed_component(
            "wasm-test-component",
            "wasm_test_component",
            "src/rust/wasm-test-component",
        )
    })
}

pub fn noshorts_plugin_path() -> Result<String> {
    static PATH: OnceLock<Result<String, String>> = OnceLock::new();
    memoized(&PATH, || {
        signed_component(
            "witmproxy-plugin-noshorts",
            "witmproxy_plugin_noshorts",
            "src/rust/witmproxy-plugin-noshorts",
        )
    })
}

pub fn noop_plugin_path() -> Result<String> {
    static PATH: OnceLock<Result<String, String>> = OnceLock::new();
    memoized(&PATH, || {
        signed_component(
            "witmproxy-plugin-noop",
            "witmproxy_plugin_noop",
            "src/rust/witmproxy-plugin-noop",
        )
    })
}

/// Workspace root, reached from this crate's manifest directory.
fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// Builds `package` for `wasm32-wasip2` and returns the component cargo produced.
///
/// Cargo owns the staleness decision, so an untouched crate costs a no-op build
/// and a source edit rebuilds. These helpers used to build only when the
/// artifact was *missing*, which silently kept pre-wasmtime-48 fixtures across
/// the upgrade until every plugin test failed parsing a component the new host
/// no longer accepted.
fn build_component(package: &str, artifact: &str) -> Result<PathBuf> {
    let root = workspace_root();
    // Reuse the cargo running the tests, so the pinned toolchain carries over.
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
    let output = Command::new(cargo)
        .current_dir(&root)
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-wasip2",
            "-p",
            package,
        ])
        .output()
        .map_err(|e| anyhow::anyhow!("failed to run cargo for {package}: {e}"))?;

    if !output.status.success() {
        return Err(anyhow::anyhow!(
            "building {package} failed with status {}:\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr),
        ));
    }

    let component = root.join(format!("target/wasm32-wasip2/release/{artifact}.wasm"));
    if !component.exists() {
        return Err(anyhow::anyhow!(
            "building {package} succeeded but {} is missing",
            component.display()
        ));
    }

    Ok(component)
}

/// Builds `package` and returns the path to its signed component.
///
/// `wasmsign2` has no staleness logic of its own, so the signature is redone
/// whenever cargo produced a component newer than it. The keypair in `key_dir`
/// is generated when absent: the host checks a component against the public key
/// the plugin itself declares, never against one specific key.
fn signed_component(package: &str, artifact: &str, key_dir: &str) -> Result<String> {
    let component = build_component(package, artifact)?;
    let signed = component.with_file_name(format!("{artifact}.signed.wasm"));

    if !signature_is_current(&signed, &component)? {
        let key_dir = workspace_root().join(key_dir);
        let secret_key = key_dir.join("key.secret");
        if !secret_key.exists() {
            let keypair = wasmsign2::KeyPair::generate();
            keypair.pk.to_file(key_dir.join("key.public"))?;
            keypair.sk.to_file(&secret_key)?;
        }

        let module = wasmsign2::Module::deserialize_from_file(&component)?;
        wasmsign2::SecretKey::from_file(&secret_key)?
            .sign(module, None)?
            .serialize_to_file(&signed)?;
    }

    Ok(signed.to_string_lossy().into_owned())
}

/// Whether `signed` exists and is no older than the component it was made from.
fn signature_is_current(signed: &Path, component: &Path) -> Result<bool> {
    let Ok(signed) = std::fs::metadata(signed) else {
        return Ok(false);
    };

    Ok(signed.modified()? >= std::fs::metadata(component)?.modified()?)
}

/// Runs `build` once per process, so a fixture shared by tests running in
/// parallel costs a single cargo invocation rather than one per test.
fn memoized(
    cell: &'static OnceLock<Result<String, String>>,
    build: impl FnOnce() -> Result<String>,
) -> Result<String> {
    cell.get_or_init(|| build().map_err(|e| format!("{e:#}")))
        .clone()
        .map_err(|e| anyhow::anyhow!(e))
}
