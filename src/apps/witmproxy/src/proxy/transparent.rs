use std::net::SocketAddr;
use std::sync::Arc;

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tracing::{debug, error, info, warn};

use crate::cert::CertificateAuthority;
use crate::config::TransparentProxyConfig;
use crate::events::Event;
use crate::events::connect::Connect;
use crate::plugins::registry::PluginRegistry;
use crate::proxy::egress::{Client, Egress, UpstreamClients};
use crate::proxy::tenant::TenantContext;
use crate::proxy::tenant_resolver::TenantResolver;
use crate::proxy::{is_closed, parse_authority_host_port, run_tls_mitm};

use super::netfilter::NetfilterManager;

/// Transparent proxy server that accepts raw TCP connections redirected by iptables.
pub struct TransparentProxy {
    listen_addr: Option<SocketAddr>,
    ca: Arc<CertificateAuthority>,
    plugin_registry: Option<Arc<PluginRegistry>>,
    tenant_resolver: Arc<dyn TenantResolver>,
    upstream: Arc<UpstreamClients>,
    egress: Arc<Egress>,
    config: TransparentProxyConfig,
    shutdown_notify: Arc<Notify>,
    netfilter: Option<NetfilterManager>,
}

impl TransparentProxy {
    pub fn new(
        ca: Arc<CertificateAuthority>,
        plugin_registry: Option<Arc<PluginRegistry>>,
        tenant_resolver: Arc<dyn TenantResolver>,
        upstream: Arc<UpstreamClients>,
        egress: Arc<Egress>,
        config: TransparentProxyConfig,
        shutdown_notify: Arc<Notify>,
    ) -> Self {
        Self {
            listen_addr: None,
            ca,
            plugin_registry,
            tenant_resolver,
            upstream,
            egress,
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
        let local_addr = listener.local_addr()?;
        self.listen_addr = Some(local_addr);
        info!("Transparent proxy listening on {}", local_addr);

        // Set up iptables rules if configured
        if self.config.auto_iptables {
            let interface = self
                .config
                .interface
                .clone()
                .unwrap_or_else(|| "tailscale0".to_string());
            let port = local_addr.port();
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
        let egress = self.egress.clone();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = shutdown.notified() => break,
                    accept_result = listener.accept() => {
                        match accept_result {
                            Ok((stream, peer)) => {
                                info!("Transparent: accepted connection from {}", peer);
                                let ca = ca.clone();
                                let plugin_registry = plugin_registry.clone();
                                let tenant_resolver = tenant_resolver.clone();
                                let upstream = upstream.clone();
                                let egress = egress.clone();

                                tokio::spawn(async move {
                                    let tenant_ctx =
                                        tenant_resolver.resolve(&peer).await.with_peer(peer.ip());
                                    if let Err(e) = handle_transparent_connection(
                                        stream,
                                        peer,
                                        ca,
                                        plugin_registry,
                                        upstream,
                                        egress,
                                        tenant_ctx,
                                    ).await
                                        && !is_closed(&e) {
                                            debug!("Transparent connection error from {}: {}", peer, e);
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

/// A bounds-checked cursor over a byte slice.
///
/// The SNI parser below reads attacker-controlled bytes off the wire, where an
/// out-of-range index is a remote crash. Every read returns `Option`, so
/// safety is structural rather than argued: there is no way to express an
/// unchecked access, and adding a field to the parser cannot silently
/// invalidate a bounds check made twenty lines earlier.
struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        let out = self.buf.get(self.pos..end)?;
        self.pos = end;
        Some(out)
    }

    fn skip(&mut self, n: usize) -> Option<()> {
        self.take(n).map(|_| ())
    }

    fn u8(&mut self) -> Option<u8> {
        match self.take(1) {
            Some([b]) => Some(*b),
            _ => None,
        }
    }

    fn u16(&mut self) -> Option<u16> {
        match self.take(2) {
            Some([hi, lo]) => Some(u16::from_be_bytes([*hi, *lo])),
            _ => None,
        }
    }

    /// A sub-reader over the next `n` bytes, advancing this one past them.
    fn sub(&mut self, n: usize) -> Option<Reader<'a>> {
        self.take(n).map(Reader::new)
    }
}

/// Extract SNI (Server Name Indication) from a TLS ClientHello by peeking at the stream.
/// Returns the hostname if found, or None if SNI cannot be determined.
///
/// A truncated or malformed hello yields `None`; it never panics, and the
/// caller treats `None` as "pass through rather than guess a destination".
pub fn extract_sni_from_client_hello(buf: &[u8]) -> Option<String> {
    let mut r = Reader::new(buf);

    // TLS record: type(1) + version(2) + length(2)
    if r.u8()? != 22 {
        // 22 = Handshake
        return None;
    }
    r.skip(2)?; // legacy record version
    let record_len = r.u16()? as usize;

    // A short read is fine: the SNI extension sits near the front of the
    // hello, so parse whatever arrived rather than waiting for the whole
    // record.
    let mut handshake = r.sub(record_len.min(r.remaining()))?;

    // Handshake: type(1) + length(3)
    if handshake.u8()? != 1 {
        // 1 = ClientHello
        return None;
    }
    handshake.skip(3)?;

    // ClientHello: version(2) + random(32) + session_id(1+N)
    //              + cipher_suites(2+N) + compression(1+N) + extensions(2+N)
    let ch = &mut handshake;
    ch.skip(2 + 32)?;
    let sid_len = ch.u8()? as usize;
    ch.skip(sid_len)?;
    let cs_len = ch.u16()? as usize;
    ch.skip(cs_len)?;
    let cm_len = ch.u8()? as usize;
    ch.skip(cm_len)?;

    let ext_total = ch.u16()? as usize;
    let mut exts = ch.sub(ext_total.min(ch.remaining()))?;

    while let (Some(ext_type), Some(ext_len)) = (exts.u16(), exts.u16()) {
        let mut ext = exts.sub(ext_len as usize)?;
        if ext_type != 0 {
            continue;
        }

        // server_name extension: list_length(2) then entries of
        // name_type(1) + name_length(2) + name.
        let list_len = ext.u16()? as usize;
        let mut list = ext.sub(list_len.min(ext.remaining()))?;
        while let Some(name_type) = list.u8() {
            let name_len = list.u16()? as usize;
            let name = list.take(name_len)?;
            if name_type == 0 {
                // host_name
                return String::from_utf8(name.to_vec()).ok();
            }
        }
        return None;
    }

    None
}

/// Where a redirected connection was going before netfilter sent it here.
///
/// A transparent proxy that trusts the bytes it reads for the destination is
/// an open relay: the SNI and the Host header are the client's to write, and
/// a client that may only reach this proxy could name a host it may not
/// reach and have the proxy, which may, connect there on its behalf. The
/// kernel remembers the real destination of a REDIRECTed or DNATed
/// connection; that is the only destination a passthrough may use.
///
/// `None` when the socket was not redirected (the client dialed this port
/// itself) or the platform cannot say.
pub fn original_dst(stream: &TcpStream) -> Option<SocketAddr> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let fd = stream.as_raw_fd();
        let v4 = || {
            // SAFETY: sockaddr_in is plain data for which all-zero is a
            // valid value.
            let mut addr: libc::sockaddr_in = unsafe { std::mem::zeroed() };
            let mut len: libc::socklen_t =
                libc::socklen_t::try_from(std::mem::size_of::<libc::sockaddr_in>()).ok()?;
            // SAFETY: a valid fd, a correctly sized out-buffer, and a length
            // the kernel may shrink but never grow past what it was given.
            let rc = unsafe {
                libc::getsockopt(
                    fd,
                    libc::SOL_IP,
                    libc::SO_ORIGINAL_DST,
                    (&mut addr as *mut libc::sockaddr_in).cast(),
                    &mut len,
                )
            };
            if rc != 0 || addr.sin_family as i32 != libc::AF_INET {
                return None;
            }
            let ip = std::net::Ipv4Addr::from(u32::from_be(addr.sin_addr.s_addr));
            Some(SocketAddr::from((ip, u16::from_be(addr.sin_port))))
        };
        let v6 = || {
            // IP6T_SO_ORIGINAL_DST, the IPv6 twin; libc has no constant for it.
            const IP6T_SO_ORIGINAL_DST: libc::c_int = 80;
            // SAFETY: sockaddr_in6 is plain data for which all-zero is a
            // valid value.
            let mut addr: libc::sockaddr_in6 = unsafe { std::mem::zeroed() };
            let mut len: libc::socklen_t =
                libc::socklen_t::try_from(std::mem::size_of::<libc::sockaddr_in6>()).ok()?;
            // SAFETY: as above.
            let rc = unsafe {
                libc::getsockopt(
                    fd,
                    libc::SOL_IPV6,
                    IP6T_SO_ORIGINAL_DST,
                    (&mut addr as *mut libc::sockaddr_in6).cast(),
                    &mut len,
                )
            };
            if rc != 0 || addr.sin6_family as i32 != libc::AF_INET6 {
                return None;
            }
            let ip = std::net::Ipv6Addr::from(addr.sin6_addr.s6_addr);
            Some(SocketAddr::from((ip, u16::from_be(addr.sin6_port))))
        };
        match stream.local_addr().ok()? {
            SocketAddr::V4(_) => v4(),
            SocketAddr::V6(_) => v6().or_else(v4),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = stream;
        None
    }
}

/// The address a passthrough connects to: the original destination, when the
/// connection was redirected here. A connection that was not (`original` is
/// missing, or is this listener itself, which is what a direct dial reports)
/// has no destination this proxy can vouch for, and gets none: dialing the
/// name the client supplied would make this proxy reach, on the client's
/// behalf, whatever the client itself may not.
pub fn passthrough_target(
    original: Option<SocketAddr>,
    local: Option<SocketAddr>,
) -> Option<SocketAddr> {
    let original = original?;
    if Some(original) == local {
        return None;
    }
    Some(original)
}

/// Check if any plugin wants to handle a connection to the given host, for
/// the tenant the connection belongs to.
async fn should_intercept(
    plugin_registry: &Option<Arc<PluginRegistry>>,
    hostname: &str,
    tenant: &TenantContext,
) -> bool {
    let Some(registry) = plugin_registry else {
        return false;
    };

    let (host, port) = match parse_authority_host_port(hostname, 443) {
        Ok(hp) => hp,
        Err(_) => (hostname.to_string(), 443),
    };

    let connect_event: Box<dyn Event> = Box::new(Connect::new(host, port));
    registry.can_handle_for(&*connect_event, tenant).await
}

/// Handle a single transparent connection. Peeks to determine if it's TLS or plain HTTP.
/// For TLS connections where plugins match (via Connect event on SNI hostname),
/// delegates to the shared `run_tls_mitm` pipeline. Otherwise forwards raw TCP.
async fn handle_transparent_connection(
    mut stream: TcpStream,
    peer: SocketAddr,
    ca: Arc<CertificateAuthority>,
    plugin_registry: Option<Arc<PluginRegistry>>,
    upstream: Arc<UpstreamClients>,
    egress: Arc<Egress>,
    tenant_ctx: TenantContext,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let client = Client::from(&tenant_ctx);
    // Peek at the first bytes to determine protocol
    let mut peek_buf = [0u8; 5];
    let n = stream.peek(&mut peek_buf).await?;
    if n == 0 {
        return Ok(());
    }

    // Where the client was really going, from the kernel rather than from
    // anything the client wrote. Every passthrough below dials this and only
    // this; see `original_dst`.
    let original = original_dst(&stream);
    let target = passthrough_target(original, stream.local_addr().ok());
    // A destination the policy forbids is not forwarded to, whoever
    // addressed it; the name, once known, is judged again below. The MITM
    // path judges its upstream at the dial.
    let target = match target {
        Some(t)
            if !egress
                .decide(&client, None, Some(t.ip()), t.port())
                .is_permit() =>
        {
            warn!(
                "Transparent: refusing {} from {}: {}",
                t,
                peer,
                egress.decide(&client, None, Some(t.ip()), t.port())
            );
            return Ok(());
        }
        other => other,
    };

    if peek_buf[0] == 22 {
        // TLS ClientHello -- peek enough to extract SNI. We use a single 16KB
        // peek (up from 4KB), which covers essentially all ClientHellos already
        // buffered by the kernel. NOTE: this is still a single peek, so a
        // ClientHello fragmented across TCP segments that hasn't fully arrived
        // yet may not yield SNI. Looping the peek safely is awkward here because
        // peeked (unconsumed) data keeps the socket perpetually readable, which
        // would busy-spin; if SNI can't be determined we pass through rather than
        // guessing a destination.
        let mut hello_buf = vec![0u8; 16 * 1024];
        let n = stream.peek(&mut hello_buf).await?;
        hello_buf.truncate(n);
        let hello_data = hello_buf.as_slice();

        let Some(hostname) = extract_sni_from_client_hello(hello_data) else {
            // Without SNI we have no reliable destination: this transparent proxy
            // derives the upstream host from SNI and there is no SO_ORIGINAL_DST
            // lookup available here. Never dial a bogus "unknown:443"; drop the
            // connection instead of connecting somewhere wrong.
            warn!(
                "Could not extract SNI from ClientHello from {}; passing through (dropping) rather than guessing a destination",
                peer
            );
            return Ok(());
        };

        info!(
            "Transparent TLS: SNI={} from {} (to {})",
            hostname,
            peer,
            original
                .map(|a| a.to_string())
                .unwrap_or_else(|| "?".into())
        );

        if should_intercept(&plugin_registry, &hostname, &tenant_ctx).await {
            // Plugin(s) want this connection — run the full MITM pipeline.
            // The upstream is dialed by name, so its certificate is checked
            // against the name the client asked for; a client that pointed
            // that name at some other address gets the real host anyway.
            info!("Transparent: intercepting {} (plugins matched)", hostname);
            let port = original.map(|a| a.port()).unwrap_or(443);
            let authority = format!("{}:{}", hostname, port);
            let upstream = upstream.client_for(&tenant_ctx, port)?;
            if let Err(e) =
                run_tls_mitm(upstream, stream, authority, ca, plugin_registry, tenant_ctx).await
                && !is_closed(&e)
            {
                debug!("Transparent MITM error for {}: {}", hostname, e);
            }
        } else {
            // No plugins care — raw TCP forward to where it was going.
            let Some(target) = target else {
                warn!(
                    "Transparent: {} from {} was not redirected here; refusing to pick a destination for it",
                    hostname, peer
                );
                return Ok(());
            };
            let decision =
                egress.decide(&client, Some(&hostname), Some(target.ip()), target.port());
            if !decision.is_permit() {
                warn!(
                    "Transparent: refusing {} ({}) from {}: {}",
                    hostname, target, peer, decision
                );
                return Ok(());
            }
            info!(
                "Transparent: forwarding {} to {} directly (no plugins matched)",
                hostname, target
            );
            let mut upstream_stream = TcpStream::connect(target).await?;
            match tokio::io::copy_bidirectional(&mut stream, &mut upstream_stream).await {
                Ok(_) => {}
                Err(e) if is_closed(&e) => {}
                Err(e) => debug!("Transparent forward error for {}: {}", hostname, e),
            }
        }
    } else {
        // Plain HTTP — raw TCP forward (port 80 traffic, no MITM needed).
        // The Host header is read for the log; the destination is the
        // kernel's.
        let Some(target) = target else {
            warn!(
                "Transparent HTTP from {} was not redirected here; refusing to pick a destination for it",
                peer
            );
            return Ok(());
        };
        let mut buf = vec![0u8; 8192];
        let n = stream.peek(&mut buf).await?;
        buf.truncate(n);
        let request_data = std::str::from_utf8(&buf).unwrap_or("");
        let host_header = request_data
            .lines()
            .find(|l| l.to_lowercase().starts_with("host:"))
            .and_then(|l| l.split_once(':').map(|(_, v)| v.trim().to_string()))
            .unwrap_or_default();
        let host_name = host_header
            .rsplit_once(':')
            .map(|(h, _)| h)
            .unwrap_or(&host_header)
            .to_string();
        let name = (!host_name.is_empty()).then_some(host_name.as_str());
        let decision = egress.decide(&client, name, Some(target.ip()), target.port());
        if !decision.is_permit() {
            warn!(
                "Transparent HTTP: refusing {} (Host: {}) from {}: {}",
                target, host_header, peer, decision
            );
            return Ok(());
        }
        info!(
            "Transparent HTTP: forwarding from {} to {} (Host: {})",
            peer, target, host_header
        );

        let mut upstream_stream = TcpStream::connect(target).await?;
        match tokio::io::copy_bidirectional(&mut stream, &mut upstream_stream).await {
            Ok(_) => {}
            Err(e) if is_closed(&e) => {}
            Err(e) => debug!("Transparent HTTP forward error to {}: {}", target, e),
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A passthrough dials the kernel's record of the destination, and only
    /// that: no record, or a record that is this listener itself (a direct
    /// dial), is no destination.
    #[test]
    fn passthrough_dials_only_the_original_destination() {
        let listener: SocketAddr = "10.0.0.1:3128".parse().unwrap();
        let real: SocketAddr = "93.184.216.34:443".parse().unwrap();
        assert_eq!(passthrough_target(Some(real), Some(listener)), Some(real));
        assert_eq!(passthrough_target(None, Some(listener)), None);
        assert_eq!(passthrough_target(Some(listener), Some(listener)), None);
        // With no local address to compare against the record still wins:
        // an unreadable local address is not a reason to dial by name.
        assert_eq!(passthrough_target(Some(real), None), Some(real));
    }

    /// A socket nobody redirected reports no original destination, so a
    /// direct dial of the transparent port is refused rather than relayed.
    #[tokio::test]
    async fn a_direct_connection_has_no_original_destination() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client = TcpStream::connect(addr).await.unwrap();
        let (accepted, _) = listener.accept().await.unwrap();
        // Linux answers ENOENT for a connection conntrack did not NAT; other
        // platforms have no answer at all. Either way: nothing to dial.
        let original = original_dst(&accepted);
        assert!(
            original.is_none() || original == accepted.local_addr().ok(),
            "{original:?}"
        );
        assert_eq!(
            passthrough_target(original, accepted.local_addr().ok()),
            None
        );
        drop(client);
    }

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

    /// Every prefix of a valid hello must parse or decline -- never panic.
    ///
    /// A transparent proxy peeks at whatever bytes have arrived, so truncation
    /// at an arbitrary offset is the normal case, not an edge case.
    #[test]
    fn sni_parser_survives_every_truncation() {
        let hello = build_test_client_hello("example.com");
        for len in 0..=hello.len() {
            let prefix = &hello[..len];
            // The assertion is that this returns at all.
            let got = extract_sni_from_client_hello(prefix);
            if len == hello.len() {
                assert_eq!(got.as_deref(), Some("example.com"));
            }
        }
    }

    /// Bytes off the wire are attacker-controlled. Walk a deterministic
    /// pseudo-random corpus, including inputs shaped like a handshake, and
    /// assert only that nothing panics.
    #[test]
    fn sni_parser_survives_arbitrary_bytes() {
        // xorshift: deterministic, no dev-dependency needed.
        let mut state: u64 = 0x9E3779B97F4A7C15;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };

        for case in 0..2_000 {
            let len = (next() % 512) as usize;
            let mut buf: Vec<u8> = (0..len).map(|_| (next() & 0xff) as u8).collect();
            // Half the corpus is shaped like a handshake record so the parser
            // gets past its first check and into the length arithmetic.
            if case % 2 == 0 && buf.len() >= 6 {
                buf[0] = 22;
                buf[5] = 1;
            }
            let _ = extract_sni_from_client_hello(&buf);
        }
    }

    /// A length field claiming more than the buffer holds must decline rather
    /// than read past the end -- the classic parser bug this rewrite removes.
    #[test]
    fn sni_parser_rejects_oversized_length_fields() {
        let mut hello = build_test_client_hello("example.com");
        // Record length -> 0xFFFF, far past the actual buffer.
        hello[3] = 0xff;
        hello[4] = 0xff;
        let _ = extract_sni_from_client_hello(&hello);

        // Session-id length -> 0xFF, past the remaining ClientHello body.
        let mut hello = build_test_client_hello("example.com");
        if hello.len() > 43 {
            hello[43] = 0xff;
        }
        let _ = extract_sni_from_client_hello(&hello);
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
        buf.extend_from_slice(
            &u16::try_from(hs_len)
                .expect("test ClientHello lengths fit in u16")
                .to_be_bytes(),
        );

        // Handshake header
        buf.push(1); // ClientHello
        buf.push(0);
        buf.extend_from_slice(
            &u16::try_from(ch_body_len)
                .expect("test ClientHello lengths fit in u16")
                .to_be_bytes(),
        );

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
        buf.extend_from_slice(
            &u16::try_from(ext_total)
                .expect("test ClientHello lengths fit in u16")
                .to_be_bytes(),
        );

        // SNI extension
        buf.push(0);
        buf.push(0); // extension type = SNI
        buf.extend_from_slice(
            &u16::try_from(sni_ext_data_len)
                .expect("test ClientHello lengths fit in u16")
                .to_be_bytes(),
        );

        // SNI list
        buf.extend_from_slice(
            &u16::try_from(sni_list_len)
                .expect("test ClientHello lengths fit in u16")
                .to_be_bytes(),
        );

        buf.push(0); // host_name type
        buf.extend_from_slice(
            &u16::try_from(sni_name_len)
                .expect("test ClientHello lengths fit in u16")
                .to_be_bytes(),
        );
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
        buf.extend_from_slice(
            &u16::try_from(hs_len)
                .expect("test ClientHello lengths fit in u16")
                .to_be_bytes(),
        );

        buf.push(1);
        buf.push(0);
        buf.extend_from_slice(
            &u16::try_from(ch_body_len)
                .expect("test ClientHello lengths fit in u16")
                .to_be_bytes(),
        );

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
