use std::sync::Arc;

use hyper_util::rt::TokioExecutor;
use reqwest::Certificate;
use reqwest::Proxy;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_rustls::TlsAcceptor;

use crate::ProxyServer;
use crate::{AppConfig, CertificateAuthority};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    Http1,
    Http2,
}

pub struct ServerHandle {
    shutdown_tx: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

impl ServerHandle {
    pub async fn shutdown(self) {
        let _ = self.shutdown_tx.send(());
        let _ = self.task.await;
    }
}

pub async fn create_proxy_server() -> (ProxyServer, CertificateAuthority, AppConfig) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (ca, config) = setup_ca_and_config().await;
    let mut proxy = ProxyServer::new(ca.clone(), None, config.clone()).unwrap();
    (proxy, ca, config)
}

pub async fn setup_ca_and_config() -> (CertificateAuthority, AppConfig) {
    let cert_dir = tempfile::tempdir().unwrap();
    let ca = CertificateAuthority::new(cert_dir).await.unwrap();
    let config = AppConfig::default();
    (ca, config)
}

pub async fn start_target_server(
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
                            eprintln!("accept error: {e}");
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
                                            eprintln!("http1 error: {e}");
                                        }
                                    }
                                    Protocol::Http2 => {
                                        if let Err(e) = hyper::server::conn::http2::Builder::new(
                                            TokioExecutor::new(),
                                        )
                                        .serve_connection(io, svc)
                                        .await
                                        {
                                            eprintln!("http2 error: {e}");
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                eprintln!("tls accept error: {e}");
                            }
                        }
                    });
                }
            }
        }
    });

    ServerHandle { shutdown_tx, task }
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

    builder
        .add_root_certificate(
            Certificate::from_der(&ca.get_root_certificate_der().unwrap().clone()).unwrap(),
        )
        .proxy(Proxy::all(proxy).unwrap())
        .build()
        .unwrap()
}
