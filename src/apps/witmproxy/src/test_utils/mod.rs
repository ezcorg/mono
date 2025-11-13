use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Result;
use http_body_util::BodyExt;
use hyper_util::rt::TokioExecutor;
use reqwest::Certificate;
use reqwest::Proxy;
use serde::Deserialize;
use serde::Serialize;
use serde_json;
use tokio::net::TcpListener;
use tokio::sync::RwLock;
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

#[derive(Serialize, Deserialize)]
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
    let runtime = Runtime::default().unwrap();
    Ok((PluginRegistry::new(db, runtime)?, temp_dir))
}

/// Register the `wasm-test-component` WASM plugin for testing.
/// The component adds a `"witmproxy":"req"` header to requests
/// and a `"witmproxy":"res"` header to responses.
///
/// In conjunction with our echo server, we can verify that the target server
/// received the modified request, and that the client received the modified response.
pub async fn register_test_component(registry: &mut PluginRegistry) -> Result<(), anyhow::Error> {
    let wasm_path = test_component_path();
    let component_bytes = std::fs::read(&wasm_path).unwrap();

    // Use the actual plugin_from_component method to test the real code path
    let plugin = registry.plugin_from_component(component_bytes).await?;
    registry.register_plugin(plugin).await
}

pub async fn register_noop_plugin(registry: &mut PluginRegistry) -> Result<(), anyhow::Error> {
    let wasm_path = noop_plugin_path();
    let component_bytes = std::fs::read(&wasm_path).unwrap();

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
    Arc<RwLock<PluginRegistry>>,
    CertificateAuthority,
    AppConfig,
    tempfile::TempDir,
)> {
    let (ca, config) = create_ca_and_config().await;
    let (registry, temp_dir) = create_plugin_registry().await?;
    let registry = Arc::new(RwLock::new(registry));
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

pub async fn create_echo_server(
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

pub fn test_component_path() -> String {
    format!(
        "{}/../../../target/wasm32-wasip2/release/wasm_test_component.signed.wasm",
        env!("CARGO_MANIFEST_DIR")
    )
}

pub fn noop_plugin_path() -> String {
    format!(
        "{}/../../../target/wasm32-wasip2/release/witmproxy_plugin_noop.signed.wasm",
        env!("CARGO_MANIFEST_DIR")
    )
}
