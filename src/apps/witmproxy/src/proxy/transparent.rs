use std::net::SocketAddr;
use std::sync::Arc;

use hyper::service::service_fn;
use hyper::Request;
use hyper::body::Incoming;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, RwLock};
use tokio_rustls::TlsAcceptor;
use tracing::{debug, error, info, warn};

use hyper_util::server::conn::auto::Builder as AutoServer;
use hyper_util::rt::{TokioExecutor, TokioIo};

use crate::cert::CertificateAuthority;
use crate::config::TransparentProxyConfig;
use crate::plugins::registry::PluginRegistry;
use crate::proxy::tenant_resolver::TenantResolver;
use crate::proxy::{
    build_server_tls_for_host, is_closed, perform_upstream, strip_proxy_headers,
    convert_hyper_incoming_to_reqwest_request,
    UpstreamClient,
};
use crate::tenant::TenantContext;

use super::netfilter::NetfilterManager;

/// Transparent proxy server that accepts raw TCP connections redirected by iptables.
pub struct TransparentProxy {
    listen_addr: Option<SocketAddr>,
    ca: Arc<CertificateAuthority>,
    plugin_registry: Option<Arc<RwLock<PluginRegistry>>>,
    tenant_resolver: Arc<dyn TenantResolver>,
    upstream: UpstreamClient,
    config: TransparentProxyConfig,
    shutdown_notify: Arc<Notify>,
    netfilter: Option<NetfilterManager>,
}

impl TransparentProxy {
    pub fn new(
        ca: Arc<CertificateAuthority>,
        plugin_registry: Option<Arc<RwLock<PluginRegistry>>>,
        tenant_resolver: Arc<dyn TenantResolver>,
        upstream: UpstreamClient,
        config: TransparentProxyConfig,
        shutdown_notify: Arc<Notify>,
    ) -> Self {
        Self {
            listen_addr: None,
            ca,
            plugin_registry,
            tenant_resolver,
            upstream,
            config,
            shutdown_notify,
            netfilter: None,
        }
    }

    pub fn listen_addr(&self) -> Option<SocketAddr> {
        self.listen_addr
    }

    pub async fn start(&mut self) -> anyhow::Result<()> {
        let bind_addr: SocketAddr = self
            .config
            .listen_addr
            .as_deref()
            .unwrap_or("0.0.0.0:8080")
            .parse()
            .map_err(|e| anyhow::anyhow!("Invalid transparent proxy bind address: {}", e))?;

        let listener = TcpListener::bind(bind_addr).await?;
        self.listen_addr = Some(listener.local_addr()?);
        info!(
            "Transparent proxy listening on {}",
            self.listen_addr.unwrap()
        );

        // Set up iptables rules if configured
        if self.config.auto_iptables {
            let interface = self
                .config
                .interface
                .clone()
                .unwrap_or_else(|| "tailscale0".to_string());
            let port = self.listen_addr.unwrap().port();
            let mut nf = NetfilterManager::new(interface, port);
            if let Err(e) = nf.setup() {
                warn!("Failed to set up iptables rules: {}", e);
            }
            self.netfilter = Some(nf);
        }

        let shutdown = self.shutdown_notify.clone();
        let ca = self.ca.clone();
        let plugin_registry = self.plugin_registry.clone();
        let tenant_resolver = self.tenant_resolver.clone();
        let upstream = self.upstream.clone();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = shutdown.notified() => break,
                    accept_result = listener.accept() => {
                        match accept_result {
                            Ok((stream, peer)) => {
                                debug!("Transparent: accepted connection from {}", peer);
                                let ca = ca.clone();
                                let plugin_registry = plugin_registry.clone();
                                let tenant_resolver = tenant_resolver.clone();
                                let upstream = upstream.clone();

                                tokio::spawn(async move {
                                    let tenant_ctx = tenant_resolver.resolve(&peer).await;
                                    if let Err(e) = handle_transparent_connection(
                                        stream,
                                        peer,
                                        ca,
                                        plugin_registry,
                                        upstream,
                                        tenant_ctx,
                                    ).await {
                                        if !is_closed(&e) {
                                            debug!("Transparent connection error from {}: {}", peer, e);
                                        }
                                    }
                                });
                            }
                            Err(e) => error!("Transparent accept error: {}", e),
                        }
                    }
                }
            }
        });

        Ok(())
    }
}

/// Extract SNI (Server Name Indication) from a TLS ClientHello by peeking at the stream.
/// Returns the hostname if found, or None if SNI cannot be determined.
pub fn extract_sni_from_client_hello(buf: &[u8]) -> Option<String> {
    // TLS record: type (1) + version (2) + length (2) + data
    if buf.len() < 5 {
        return None;
    }
    // Record type 22 = Handshake
    if buf[0] != 22 {
        return None;
    }

    let record_len = ((buf[3] as usize) << 8) | (buf[4] as usize);
    let handshake = &buf[5..];
    if handshake.len() < record_len.min(handshake.len()) {
        // Partial read is OK, we just need the SNI extension
    }

    // Handshake: type (1) + length (3) + ...
    if handshake.is_empty() || handshake[0] != 1 {
        // Type 1 = ClientHello
        return None;
    }
    if handshake.len() < 4 {
        return None;
    }
    let hs_len = ((handshake[1] as usize) << 16)
        | ((handshake[2] as usize) << 8)
        | (handshake[3] as usize);

    let ch = &handshake[4..];
    if ch.len() < hs_len.min(ch.len()) {}

    // ClientHello: version (2) + random (32) + session_id (1+N) + cipher_suites (2+N) + compression (1+N) + extensions
    if ch.len() < 34 {
        return None;
    }
    let mut pos = 34; // skip version + random

    // Session ID
    if pos >= ch.len() {
        return None;
    }
    let sid_len = ch[pos] as usize;
    pos += 1 + sid_len;

    // Cipher suites
    if pos + 2 > ch.len() {
        return None;
    }
    let cs_len = ((ch[pos] as usize) << 8) | (ch[pos + 1] as usize);
    pos += 2 + cs_len;

    // Compression methods
    if pos >= ch.len() {
        return None;
    }
    let cm_len = ch[pos] as usize;
    pos += 1 + cm_len;

    // Extensions
    if pos + 2 > ch.len() {
        return None;
    }
    let ext_len = ((ch[pos] as usize) << 8) | (ch[pos + 1] as usize);
    pos += 2;

    let ext_end = pos + ext_len.min(ch.len() - pos);
    while pos + 4 <= ext_end {
        let ext_type = ((ch[pos] as u16) << 8) | (ch[pos + 1] as u16);
        let ext_data_len = ((ch[pos + 2] as usize) << 8) | (ch[pos + 3] as usize);
        pos += 4;

        if ext_type == 0 {
            // SNI extension
            if pos + ext_data_len > ext_end {
                return None;
            }
            let sni_data = &ch[pos..pos + ext_data_len];
            // SNI list: total_len (2) + entries
            if sni_data.len() < 2 {
                return None;
            }
            let mut sni_pos = 2; // skip total length
            while sni_pos + 3 <= sni_data.len() {
                let name_type = sni_data[sni_pos];
                let name_len =
                    ((sni_data[sni_pos + 1] as usize) << 8) | (sni_data[sni_pos + 2] as usize);
                sni_pos += 3;
                if name_type == 0 && sni_pos + name_len <= sni_data.len() {
                    // Host name
                    return String::from_utf8(sni_data[sni_pos..sni_pos + name_len].to_vec()).ok();
                }
                sni_pos += name_len;
            }
            return None;
        }

        pos += ext_data_len;
    }

    None
}

/// Handle a single transparent connection. Peeks to determine if it's TLS or plain HTTP.
async fn handle_transparent_connection(
    stream: TcpStream,
    peer: SocketAddr,
    ca: Arc<CertificateAuthority>,
    _plugin_registry: Option<Arc<RwLock<PluginRegistry>>>,
    upstream: UpstreamClient,
    _tenant_ctx: TenantContext,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Peek at the first bytes to determine protocol
    let mut peek_buf = [0u8; 5];
    let n = stream.peek(&mut peek_buf).await?;
    if n == 0 {
        return Ok(());
    }

    if peek_buf[0] == 22 {
        // TLS ClientHello -- read enough to extract SNI
        let mut hello_buf = vec![0u8; 4096];
        let n = stream.peek(&mut hello_buf).await?;
        let hello_data = &hello_buf[..n];

        let hostname = extract_sni_from_client_hello(hello_data)
            .unwrap_or_else(|| {
                warn!("Could not extract SNI from ClientHello from {}", peer);
                "unknown".to_string()
            });

        debug!("Transparent TLS: SNI={} from {}", hostname, peer);

        // Generate cert for the SNI hostname
        let server_tls = build_server_tls_for_host(&ca, &hostname).await?;
        let acceptor = TlsAcceptor::from(Arc::new(server_tls));

        let tls = acceptor.accept(stream).await?;
        debug!("Transparent: TLS established for {}", hostname);

        let hostname_for_svc = hostname.clone();
        let svc = service_fn(move |mut req: Request<Incoming>| {
            let upstream = upstream.clone();
            let hostname = hostname_for_svc.clone();
            async move {
                // Ensure the request has the correct authority
                if req.uri().authority().is_none() {
                    let mut parts = req.uri().clone().into_parts();
                    parts.scheme = Some("https".parse().unwrap());
                    parts.authority = Some(hostname.parse().unwrap());
                    if parts.path_and_query.is_none() {
                        parts.path_and_query = Some("/".parse().unwrap());
                    }
                    if let Ok(new_uri) = hyper::Uri::from_parts(parts) {
                        *req.uri_mut() = new_uri;
                    }
                }

                strip_proxy_headers(req.headers_mut());
                let reqwest_req = convert_hyper_incoming_to_reqwest_request(req, &upstream)
                    .map_err(|e| std::io::Error::other(e.to_string()))?;
                Ok::<_, std::io::Error>(perform_upstream(&upstream, reqwest_req).await)
            }
        });

        let executor = TokioExecutor::new();
        let auto: AutoServer<TokioExecutor> = AutoServer::new(executor);
        if let Err(e) = auto.serve_connection(TokioIo::new(tls), svc).await {
            if !is_closed(&e) {
                debug!("Transparent TLS connection error: {}", e);
            }
        }
    } else {
        // Plain HTTP -- extract Host header
        debug!("Transparent HTTP connection from {}", peer);

        let svc = service_fn(move |mut req: Request<Incoming>| {
            let upstream = upstream.clone();
            async move {
                strip_proxy_headers(req.headers_mut());
                let reqwest_req = convert_hyper_incoming_to_reqwest_request(req, &upstream)
                    .map_err(|e| std::io::Error::other(e.to_string()))?;
                Ok::<_, std::io::Error>(perform_upstream(&upstream, reqwest_req).await)
            }
        });

        if let Err(e) = hyper::server::conn::http1::Builder::new()
            .preserve_header_case(true)
            .serve_connection(TokioIo::new(stream), svc)
            .await
        {
            if !is_closed(&e) {
                debug!("Transparent HTTP connection error: {}", e);
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_sni_from_real_client_hello() {
        // A minimal TLS 1.2 ClientHello with SNI "example.com"
        let hello = build_test_client_hello("example.com");
        let sni = extract_sni_from_client_hello(&hello);
        assert_eq!(sni.as_deref(), Some("example.com"));
    }

    #[test]
    fn test_extract_sni_no_sni_extension() {
        // Minimal ClientHello without any extensions
        let hello = build_test_client_hello_no_sni();
        let sni = extract_sni_from_client_hello(&hello);
        assert!(sni.is_none());
    }

    #[test]
    fn test_extract_sni_not_tls() {
        let buf = b"GET / HTTP/1.1\r\nHost: example.com\r\n\r\n";
        let sni = extract_sni_from_client_hello(buf);
        assert!(sni.is_none());
    }

    #[test]
    fn test_extract_sni_empty() {
        let sni = extract_sni_from_client_hello(&[]);
        assert!(sni.is_none());
    }

    /// Build a minimal TLS ClientHello with SNI extension for testing.
    fn build_test_client_hello(hostname: &str) -> Vec<u8> {
        let hostname_bytes = hostname.as_bytes();
        let sni_name_len = hostname_bytes.len();

        // SNI extension data: list_len(2) + type(1) + name_len(2) + name
        let sni_entry_len = 1 + 2 + sni_name_len; // type + len + name
        let sni_list_len = sni_entry_len;
        let sni_ext_data_len = 2 + sni_list_len; // list_len field + entries

        // Extension: type(2) + len(2) + data
        let ext_total = 4 + sni_ext_data_len;

        // ClientHello body: version(2) + random(32) + session_id_len(1) + cipher_suites_len(2) + cipher(2) + compression_len(1) + compression(1) + extensions_len(2) + extensions
        let ch_body_len = 2 + 32 + 1 + 2 + 2 + 1 + 1 + 2 + ext_total;

        // Handshake: type(1) + len(3) + body
        let hs_len = 1 + 3 + ch_body_len;

        // TLS record: type(1) + version(2) + len(2) + handshake
        let mut buf = Vec::with_capacity(5 + hs_len);

        // TLS record header
        buf.push(22); // handshake
        buf.push(3);
        buf.push(1); // TLS 1.0
        buf.push((hs_len >> 8) as u8);
        buf.push((hs_len & 0xff) as u8);

        // Handshake header
        buf.push(1); // ClientHello
        buf.push(0);
        buf.push((ch_body_len >> 8) as u8);
        buf.push((ch_body_len & 0xff) as u8);

        // ClientHello body
        buf.push(3);
        buf.push(3); // TLS 1.2
        buf.extend_from_slice(&[0u8; 32]); // random

        buf.push(0); // session_id length

        buf.push(0);
        buf.push(2); // cipher suites length
        buf.push(0x00);
        buf.push(0xff); // one cipher suite

        buf.push(1); // compression methods length
        buf.push(0); // null compression

        // Extensions length
        buf.push((ext_total >> 8) as u8);
        buf.push((ext_total & 0xff) as u8);

        // SNI extension
        buf.push(0);
        buf.push(0); // extension type = SNI
        buf.push((sni_ext_data_len >> 8) as u8);
        buf.push((sni_ext_data_len & 0xff) as u8);

        // SNI list
        buf.push((sni_list_len >> 8) as u8);
        buf.push((sni_list_len & 0xff) as u8);

        buf.push(0); // host_name type
        buf.push((sni_name_len >> 8) as u8);
        buf.push((sni_name_len & 0xff) as u8);
        buf.extend_from_slice(hostname_bytes);

        buf
    }

    fn build_test_client_hello_no_sni() -> Vec<u8> {
        // ClientHello body without extensions
        let ch_body_len = 2 + 32 + 1 + 2 + 2 + 1 + 1;
        let hs_len = 1 + 3 + ch_body_len;

        let mut buf = Vec::with_capacity(5 + hs_len);

        buf.push(22);
        buf.push(3);
        buf.push(1);
        buf.push((hs_len >> 8) as u8);
        buf.push((hs_len & 0xff) as u8);

        buf.push(1);
        buf.push(0);
        buf.push((ch_body_len >> 8) as u8);
        buf.push((ch_body_len & 0xff) as u8);

        buf.push(3);
        buf.push(3);
        buf.extend_from_slice(&[0u8; 32]);
        buf.push(0);
        buf.push(0);
        buf.push(2);
        buf.push(0x00);
        buf.push(0xff);
        buf.push(1);
        buf.push(0);

        buf
    }
}
