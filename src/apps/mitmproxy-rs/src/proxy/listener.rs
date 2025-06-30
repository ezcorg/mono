use super::{Connection, DnsResolver, ProxyError, ProxyResult};
use crate::cert::CertificateAuthority;
use crate::config::Config;
use crate::wasm::PluginManager;
use anyhow::Result;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tracing::{debug, error, info, warn};

#[derive(Debug)]
pub struct ProxyServer {
    listen_addr: SocketAddr,
    ca: CertificateAuthority,
    plugin_manager: PluginManager,
    config: Config,
}

impl ProxyServer {
    pub fn new(
        listen_addr: SocketAddr,
        ca: CertificateAuthority,
        plugin_manager: PluginManager,
        config: Config,
    ) -> Self {
        Self {
            listen_addr,
            ca,
            plugin_manager,
            config,
        }
    }

    pub async fn start(&self) -> Result<()> {
        let listener = TcpListener::bind(self.listen_addr).await?;
        info!("Proxy server listening on {}", self.listen_addr);

        // Create DNS resolver
        let dns_resolver = Arc::new(DnsResolver::new().await?);

        loop {
            match listener.accept().await {
                Ok((stream, client_addr)) => {
                    debug!("New connection from {}", client_addr);

                    let connection = Connection::new(client_addr);
                    let ca = self.ca.clone();
                    let plugin_manager = self.plugin_manager.clone();
                    let config = self.config.clone();
                    let dns_resolver = dns_resolver.clone();

                    // Spawn a task to handle the connection
                    tokio::spawn(async move {
                        if let Err(e) = Self::handle_connection(
                            stream,
                            connection,
                            ca,
                            plugin_manager,
                            config,
                            dns_resolver,
                        )
                        .await
                        {
                            // Log connection errors more appropriately
                            match &e {
                                ProxyError::Io(io_err)
                                    if Self::is_connection_closed_error(io_err) =>
                                {
                                    debug!("Connection closed: {}", e);
                                }
                                ProxyError::Tls(tls_err) => {
                                    let tls_msg = tls_err.to_string();
                                    if tls_msg.contains("close_notify")
                                        || tls_msg.contains("peer closed connection")
                                    {
                                        debug!("TLS connection closed: {}", e);
                                    } else {
                                        warn!("TLS error: {}", e);
                                    }
                                }
                                _ => {
                                    error!("Connection handling failed: {}", e);
                                }
                            }
                        }
                    });
                }
                Err(e) => {
                    error!("Failed to accept connection: {}", e);
                }
            }
        }
    }

    async fn handle_connection(
        mut stream: TcpStream,
        mut connection: Connection,
        ca: CertificateAuthority,
        plugin_manager: PluginManager,
        config: Config,
        dns_resolver: Arc<DnsResolver>,
    ) -> ProxyResult<()> {
        // Read initial request
        let mut buffer = vec![0u8; config.proxy.buffer_size];
        let n = stream.read(&mut buffer).await?;

        if n == 0 {
            return Err(ProxyError::InvalidRequest("Empty request".to_string()));
        }

        let request_data = &buffer[..n];
        let (method, url, headers) = super::parse_http_request(request_data)?;

        debug!("Received {} request for {}", method, url);

        // Execute plugin event: request_start
        let mut context = super::create_request_context(
            &connection,
            &method,
            &url,
            &headers,
            request_data.to_vec(),
        )
        .await;

        let actions = super::execute_plugin_event(
            &plugin_manager,
            crate::wasm::EventType::RequestStart,
            &mut context,
        )
        .await?;

        // Check if any plugin wants to block or redirect
        for action in &actions {
            match action {
                crate::wasm::PluginAction::Block(reason) => {
                    Self::send_blocked_response(&mut stream, reason).await?;
                    return Ok(());
                }
                crate::wasm::PluginAction::Redirect(url) => {
                    Self::send_redirect_response(&mut stream, url).await?;
                    return Ok(());
                }
                _ => {}
            }
        }

        if super::is_connect_request(&method) {
            // Handle HTTPS CONNECT request
            connection.is_https = true;
            Self::handle_connect_request(
                stream,
                connection,
                &url,
                ca,
                plugin_manager,
                config,
                dns_resolver,
            )
            .await
        } else {
            // Handle regular HTTP request
            Self::handle_http_request(
                stream,
                connection,
                method,
                url,
                headers,
                request_data.to_vec(),
                plugin_manager,
                config,
                dns_resolver,
            )
            .await
        }
    }

    async fn handle_connect_request(
        mut client_stream: TcpStream,
        mut connection: Connection,
        target: &str,
        ca: CertificateAuthority,
        plugin_manager: PluginManager,
        config: Config,
        dns_resolver: Arc<DnsResolver>,
    ) -> ProxyResult<()> {
        // Parse target host and port
        let (host, port) = if let Some(colon_pos) = target.find(':') {
            let host = &target[..colon_pos];
            let port = target[colon_pos + 1..]
                .parse::<u16>()
                .map_err(|_| ProxyError::InvalidRequest("Invalid port".to_string()))?;
            (host.to_string(), port)
        } else {
            (target.to_string(), 443)
        };

        // Validate host before proceeding
        if host.trim().is_empty() {
            return Err(ProxyError::InvalidRequest(format!(
                "Empty host in CONNECT target: '{}'",
                target
            )));
        }

        debug!("Parsed CONNECT target - host: '{}', port: {}", host, port);
        connection.target_host = Some(host.clone());

        // Send 200 Connection Established
        let response = "HTTP/1.1 200 Connection Established\r\n\r\n";
        client_stream.write_all(response.as_bytes()).await?;

        debug!("Sent CONNECT response for {}", target);

        // For HTTPS, we need to perform TLS termination and re-encryption
        if port == 443 {
            Self::handle_https_mitm(
                client_stream,
                connection,
                host,
                ca,
                plugin_manager,
                config,
                dns_resolver,
            )
            .await
        } else {
            // For non-HTTPS CONNECT, just forward the connection
            Self::forward_tcp_connection(client_stream, &host, port, dns_resolver).await
        }
    }

    async fn handle_https_mitm(
        client_stream: TcpStream,
        connection: Connection,
        host: String,
        ca: CertificateAuthority,
        plugin_manager: PluginManager,
        config: Config,
        dns_resolver: Arc<DnsResolver>,
    ) -> ProxyResult<()> {
        // Get certificate for the target domain
        let cert = ca.get_certificate_for_domain(&host).await?;

        // Set up TLS server for client connection
        let tls_config = super::tls::create_server_config(cert)?;
        let tls_acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls_config));

        // Accept TLS connection from client
        let client_tls_stream = tls_acceptor.accept(client_stream).await.map_err(|e| {
            // Handle common TLS errors more gracefully
            if e.to_string()
                .contains("peer closed connection without sending TLS close_notify")
            {
                debug!(
                    "Client closed TLS connection without close_notify for {}",
                    host
                );
                ProxyError::Io(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "Client closed connection",
                ))
            } else {
                ProxyError::Tls(rustls::Error::General(format!("TLS accept failed: {}", e)))
            }
        })?;

        debug!("Established TLS connection with client for {}", host);

        // Resolve target server address
        let target_addrs = dns_resolver.resolve(&host).await?;
        let target_addr = target_addrs[0]; // Use first address

        // TODO: handle potential failure and multiple addresses?
        // Connect to target server
        let upstream_stream = super::establish_upstream_connection(target_addr).await?;

        // Set up TLS client for upstream connection
        let upstream_tls_config = super::tls::create_client_config()?;
        let upstream_connector = tokio_rustls::TlsConnector::from(Arc::new(upstream_tls_config));

        let server_name = rustls::pki_types::ServerName::try_from(host.clone())
            .map_err(|_| ProxyError::InvalidRequest("Invalid server name".to_string()))?;

        let upstream_tls_stream = upstream_connector
            .connect(server_name, upstream_stream)
            .await
            .map_err(|e| {
                ProxyError::Tls(rustls::Error::General(format!(
                    "Upstream TLS failed: {}",
                    e
                )))
            })?;

        debug!("Established TLS connection with upstream server {}", host);

        // Now we have TLS connections to both client and server
        // We can intercept and modify the HTTP traffic
        Self::handle_tls_proxy(
            client_tls_stream,
            upstream_tls_stream,
            connection,
            plugin_manager,
            config,
        )
        .await
    }

    async fn handle_tls_proxy(
        mut client_stream: tokio_rustls::server::TlsStream<TcpStream>,
        mut upstream_stream: tokio_rustls::client::TlsStream<TcpStream>,
        connection: Connection,
        plugin_manager: PluginManager,
        config: Config,
    ) -> ProxyResult<()> {
        let mut client_buffer = vec![0u8; config.proxy.buffer_size];
        let mut upstream_buffer = vec![0u8; config.proxy.buffer_size];

        loop {
            tokio::select! {
                // Read from client, forward to upstream
                result = client_stream.read(&mut client_buffer) => {
                    match result {
                        Ok(0) => break, // Client closed connection
                        Ok(n) => {
                            let data = &client_buffer[..n];

                            // Try to parse as HTTP request
                            if let Ok((method, url, headers)) = super::parse_http_request(data) {
                                debug!("Intercepted {} request for {}", method, url);

                                // Execute plugin events
                                let mut context = super::create_request_context(
                                    &connection,
                                    &method,
                                    &url,
                                    &headers,
                                    data.to_vec(),
                                ).await;

                                let _actions = super::execute_plugin_event(
                                    &plugin_manager,
                                    crate::wasm::EventType::RequestHeaders,
                                    &mut context,
                                ).await?;

                                // TODO: Apply plugin modifications to the request
                            }

                            // Forward to upstream
                            if let Err(e) = upstream_stream.write_all(data).await {
                                if Self::is_connection_closed_error(&e) {
                                    debug!("Upstream connection closed during write");
                                    break;
                                }
                                return Err(ProxyError::Io(e));
                            }
                        }
                        Err(e) => {
                            if Self::is_connection_closed_error(&e) {
                                debug!("Client connection closed during read");
                                break;
                            }
                            return Err(ProxyError::Io(e));
                        }
                    }
                }

                // Read from upstream, forward to client
                result = upstream_stream.read(&mut upstream_buffer) => {
                    match result {
                        Ok(0) => break, // Upstream closed connection
                        Ok(n) => {
                            let data = &upstream_buffer[..n];

                            // Try to parse as HTTP response
                            if let Ok(response) = Self::parse_http_response(data) {
                                debug!("Intercepted response with status {}", response.status);

                                // Execute plugin events for response
                                let mut context = super::create_request_context(
                                    &connection,
                                    "GET", // Default method for response context
                                    "/",
                                    &std::collections::HashMap::new(),
                                    Vec::new(),
                                ).await;
                                context.response = Some(response);

                                let _actions = super::execute_plugin_event(
                                    &plugin_manager,
                                    crate::wasm::EventType::ResponseHeaders,
                                    &mut context,
                                ).await?;

                                // TODO: Apply plugin modifications to the response
                            }

                            // Forward to client
                            if let Err(e) = client_stream.write_all(data).await {
                                if Self::is_connection_closed_error(&e) {
                                    debug!("Client connection closed during write");
                                    break;
                                }
                                return Err(ProxyError::Io(e));
                            }
                        }
                        Err(e) => {
                            if Self::is_connection_closed_error(&e) {
                                debug!("Upstream connection closed during read");
                                break;
                            }
                            return Err(ProxyError::Io(e));
                        }
                    }
                }
            }
        }

        debug!(
            "TLS proxy connection closed for {}",
            connection.target_host.unwrap_or_default()
        );
        Ok(())
    }

    async fn handle_http_request(
        mut client_stream: TcpStream,
        connection: Connection,
        method: String,
        url: String,
        headers: std::collections::HashMap<String, String>,
        body: Vec<u8>,
        plugin_manager: PluginManager,
        config: Config,
        dns_resolver: Arc<DnsResolver>,
    ) -> ProxyResult<()> {
        // Extract host from headers or URL
        let host = super::extract_host_from_headers(&headers)
            .or_else(|| {
                if url.starts_with("http://") {
                    url::Url::parse(&url)
                        .ok()?
                        .host_str()
                        .map(|s| s.to_string())
                } else {
                    None
                }
            })
            .ok_or_else(|| ProxyError::InvalidRequest("No host specified".to_string()))?;

        // Validate extracted host
        if host.trim().is_empty() {
            return Err(ProxyError::InvalidRequest(
                "Empty host extracted from request".to_string(),
            ));
        }

        debug!("Extracted host for HTTP request: '{}'", host);

        // Resolve target server
        let target_addrs = dns_resolver.resolve(&host).await?;
        let target_addr = SocketAddr::new(target_addrs[0].ip(), 80); // HTTP port

        // Connect to target server
        let mut upstream_stream = super::establish_upstream_connection(target_addr).await?;

        // Execute plugin events
        let mut context =
            super::create_request_context(&connection, &method, &url, &headers, body).await;

        let _actions = super::execute_plugin_event(
            &plugin_manager,
            crate::wasm::EventType::RequestHeaders,
            &mut context,
        )
        .await?;

        // Forward the request to upstream
        upstream_stream.write_all(&context.request.body).await?;

        // Forward response back to client
        let mut buffer = vec![0u8; config.proxy.buffer_size];
        loop {
            let n = upstream_stream.read(&mut buffer).await?;
            if n == 0 {
                break;
            }

            client_stream.write_all(&buffer[..n]).await?;
        }

        Ok(())
    }

    async fn forward_tcp_connection(
        client_stream: TcpStream,
        host: &str,
        port: u16,
        dns_resolver: Arc<DnsResolver>,
    ) -> ProxyResult<()> {
        // Resolve target address
        let target_addrs = dns_resolver.resolve(host).await?;
        let target_addr = SocketAddr::new(target_addrs[0].ip(), port);

        // Connect to target
        let upstream_stream = super::establish_upstream_connection(target_addr).await?;

        // Split streams for bidirectional forwarding
        let (client_read, client_write) = client_stream.into_split();
        let (upstream_read, upstream_write) = upstream_stream.into_split();

        // Forward data in both directions
        let client_to_upstream = super::forward_data(client_read, upstream_write);
        let upstream_to_client = super::forward_data(upstream_read, client_write);

        // Wait for either direction to close
        tokio::select! {
            result = client_to_upstream => result?,
            result = upstream_to_client => result?,
        }

        debug!("TCP forwarding completed for {}:{}", host, port);
        Ok(())
    }

    async fn send_blocked_response(stream: &mut TcpStream, reason: &str) -> ProxyResult<()> {
        let response = format!(
            "HTTP/1.1 403 Forbidden\r\n\
             Content-Type: text/plain\r\n\
             Content-Length: {}\r\n\
             \r\n\
             Blocked by proxy: {}",
            reason.len() + 18,
            reason
        );

        stream.write_all(response.as_bytes()).await?;
        Ok(())
    }

    async fn send_redirect_response(stream: &mut TcpStream, location: &str) -> ProxyResult<()> {
        let response = format!(
            "HTTP/1.1 302 Found\r\n\
             Location: {}\r\n\
             Content-Length: 0\r\n\
             \r\n",
            location
        );

        stream.write_all(response.as_bytes()).await?;
        Ok(())
    }

    fn parse_http_response(data: &[u8]) -> ProxyResult<crate::wasm::HttpResponse> {
        let response_str = String::from_utf8_lossy(data);
        let lines: Vec<&str> = response_str.lines().collect();

        if lines.is_empty() {
            return Err(ProxyError::InvalidRequest("Empty response".to_string()));
        }

        // Parse status line
        let status_line_parts: Vec<&str> = lines[0].split_whitespace().collect();
        if status_line_parts.len() < 2 {
            return Err(ProxyError::InvalidRequest(
                "Invalid status line".to_string(),
            ));
        }

        let status = status_line_parts[1]
            .parse::<u16>()
            .map_err(|_| ProxyError::InvalidRequest("Invalid status code".to_string()))?;

        // Parse headers
        let mut headers = std::collections::HashMap::new();
        let mut body_start = 0;

        for (i, line) in lines[1..].iter().enumerate() {
            if line.is_empty() {
                body_start = i + 2; // +2 because we started from lines[1..]
                break;
            }

            if let Some(colon_pos) = line.find(':') {
                let key = line[..colon_pos].trim().to_lowercase();
                let value = line[colon_pos + 1..].trim().to_string();
                headers.insert(key, value);
            }
        }

        // Extract body
        let body = if body_start < lines.len() {
            lines[body_start..].join("\n").into_bytes()
        } else {
            Vec::new()
        };

        Ok(crate::wasm::HttpResponse {
            status,
            headers,
            body,
        })
    }

    /// Helper function to check if an error indicates a closed connection
    fn is_connection_closed_error(error: &std::io::Error) -> bool {
        use std::io::ErrorKind;
        match error.kind() {
            ErrorKind::UnexpectedEof
            | ErrorKind::ConnectionAborted
            | ErrorKind::ConnectionReset
            | ErrorKind::BrokenPipe => true,
            _ => {
                // Check for TLS close_notify errors in the error message
                let error_msg = error.to_string().to_lowercase();
                error_msg.contains("close_notify")
                    || error_msg.contains("peer closed connection")
                    || error_msg.contains("connection closed")
            }
        }
    }
}
