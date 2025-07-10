use super::{Connection, DnsResolver, ProxyError, ProxyResult};
use crate::cert::CertificateAuthority;
use crate::config::Config;
use crate::wasm::PluginManager;
use anyhow::Result;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
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
                    info!("New connection from {}", client_addr);
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
        let mut buffer = vec![0u8; config.proxy.buffer_size];

        // Handle multiple requests on the same connection (HTTP/1.1 keep-alive)
        let mut request_count = 0;
        loop {
            request_count += 1;
            // Read request with timeout to avoid hanging on keep-alive connections
            info!("Reading request #{} from client...", request_count);
            let read_result =
                tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buffer)).await;

            let n = match read_result {
                Ok(Ok(n)) => {
                    info!("Read operation completed with {} bytes", n);
                    n
                }
                Ok(Err(e)) => {
                    if Self::is_connection_closed_error(&e) {
                        info!("Client connection closed during read: {}", e);
                        break;
                    }
                    error!("IO error during read: {}", e);
                    return Err(ProxyError::Io(e));
                }
                Err(_) => {
                    // Timeout - this is normal for keep-alive connections
                    info!(
                        "Connection timeout after 10 seconds waiting for request #{}, closing",
                        request_count
                    );
                    break;
                }
            };

            if n == 0 {
                info!(
                    "Client closed connection (EOF) on request #{}",
                    request_count
                );
                break;
            }

            info!("Read {} bytes from client", n);
            let request_data = &buffer[..n];

            // Try to parse the HTTP request
            let (method, url, headers) = match super::parse_http_request(request_data) {
                Ok(parsed) => parsed,
                Err(e) => {
                    warn!("Failed to parse HTTP request: {}", e);
                    break;
                }
            };

            info!("Received {} request for {}", method, url);
            info!("Request headers: {:?}", headers);
            info!(
                "Raw request data: {}",
                String::from_utf8_lossy(request_data)
            );

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
            let mut should_continue = true;
            for action in &actions {
                match action {
                    crate::wasm::PluginAction::Block(reason) => {
                        Self::send_blocked_response(&mut stream, reason).await?;
                        should_continue = false;
                        break;
                    }
                    crate::wasm::PluginAction::Redirect(url) => {
                        Self::send_redirect_response(&mut stream, url).await?;
                        should_continue = false;
                        break;
                    }
                    _ => {}
                }
            }

            if !should_continue {
                break;
            }

            if super::is_connect_request(&method) {
                // Handle HTTPS CONNECT request - this ends the connection handling
                connection.is_https = true;
                return Self::handle_connect_request(
                    stream,
                    connection,
                    &url,
                    ca,
                    plugin_manager,
                    config,
                    dns_resolver,
                )
                .await;
            } else {
                // Handle regular HTTP request and continue the loop for keep-alive
                info!("About to call handle_http_request_keepalive...");
                match Self::handle_http_request_keepalive(
                    &mut stream,
                    &connection,
                    method,
                    url,
                    headers,
                    request_data.to_vec(),
                    &plugin_manager,
                    &config,
                    &dns_resolver,
                )
                .await
                {
                    Ok(()) => {
                        info!("handle_http_request_keepalive completed successfully");
                    }
                    Err(e) => {
                        error!("Error handling HTTP request: {}", e);
                        break;
                    }
                }

                info!("HTTP request completed, continuing to next request...");
            }
        }

        info!("Connection handling completed");
        Ok(())
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

        // Resolve target server address with proper port (443 for HTTPS)
        let target_addr = dns_resolver.resolve_with_fallback(&host, 443).await?;
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

    async fn handle_http_request_keepalive(
        client_stream: &mut TcpStream,
        connection: &Connection,
        method: String,
        url: String,
        headers: std::collections::HashMap<String, String>,
        body: Vec<u8>,
        plugin_manager: &PluginManager,
        config: &Config,
        dns_resolver: &Arc<DnsResolver>,
    ) -> ProxyResult<()> {
        // Extract host and port from headers or URL
        let (host, port) = if let Some(host_header) = super::extract_host_from_headers(&headers) {
            // Parse host:port from Host header
            if let Some(colon_pos) = host_header.find(':') {
                let host = host_header[..colon_pos].to_string();
                let port = host_header[colon_pos + 1..].parse::<u16>().unwrap_or(80);
                (host, port)
            } else {
                (host_header, 80)
            }
        } else if url.starts_with("http://") {
            // Extract from URL
            if let Ok(parsed_url) = url::Url::parse(&url) {
                let host = parsed_url.host_str().unwrap_or("").to_string();
                let port = parsed_url.port().unwrap_or(80);
                (host, port)
            } else {
                return Err(ProxyError::InvalidRequest("Invalid URL".to_string()));
            }
        } else {
            return Err(ProxyError::InvalidRequest("No host specified".to_string()));
        };

        // Validate extracted host
        if host.trim().is_empty() {
            return Err(ProxyError::InvalidRequest(
                "Empty host extracted from request".to_string(),
            ));
        }

        info!("Extracted host for HTTP request: '{}:{}'", host, port);

        // Resolve target server with extracted port
        let target_addr = dns_resolver.resolve_with_fallback(&host, port).await?;
        info!("Resolved target address: {}", target_addr);

        // Connect to target server
        let mut upstream_stream = super::establish_upstream_connection(target_addr).await?;
        info!("Connected to upstream server");

        // Execute plugin events
        let mut context =
            super::create_request_context(connection, &method, &url, &headers, body).await;

        let _actions = super::execute_plugin_event(
            plugin_manager,
            crate::wasm::EventType::RequestHeaders,
            &mut context,
        )
        .await?;

        // Reconstruct and forward the HTTP request to upstream
        // Convert absolute URL to relative path for upstream server
        let path = if url.starts_with("http://") || url.starts_with("https://") {
            if let Ok(parsed_url) = url::Url::parse(&url) {
                let mut path = parsed_url.path().to_string();
                if let Some(query) = parsed_url.query() {
                    path.push('?');
                    path.push_str(query);
                }
                path
            } else {
                url.clone()
            }
        } else {
            url.clone()
        };

        let request_line = format!("{} {} HTTP/1.1\r\n", method, path);
        info!("Sending request line: {}", request_line.trim());
        upstream_stream.write_all(request_line.as_bytes()).await?;

        // Forward headers
        for (key, value) in &headers {
            let header_line = format!("{}: {}\r\n", key, value);
            upstream_stream.write_all(header_line.as_bytes()).await?;
        }

        // End headers
        upstream_stream.write_all(b"\r\n").await?;
        info!("Finished sending request to upstream");

        // Forward body if present (extract from original request)
        if let Some(body_start) = context
            .request
            .body
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
        {
            let body = &context.request.body[body_start + 4..];
            if !body.is_empty() {
                upstream_stream.write_all(body).await?;
            }
        }

        // Forward response back to client with timeout
        let mut buffer = vec![0u8; config.proxy.buffer_size];
        let mut response_data = Vec::new();
        let mut headers_complete = false;
        let mut content_length: Option<usize> = None;
        let mut connection_close = false;
        let mut bytes_read_after_headers = 0;

        info!("Starting to read response from upstream");
        loop {
            // Add timeout to prevent hanging
            let read_result =
                tokio::time::timeout(Duration::from_secs(30), upstream_stream.read(&mut buffer))
                    .await;

            match read_result {
                Ok(Ok(0)) => {
                    // Upstream closed connection
                    info!("Upstream closed connection");
                    break;
                }
                Ok(Ok(n)) => {
                    // Successfully read data, forward to client
                    info!("Read {} bytes from upstream, forwarding to client", n);

                    // Add to response data for header parsing
                    response_data.extend_from_slice(&buffer[..n]);

                    // Parse headers if not done yet
                    if !headers_complete {
                        if let Some(header_end) =
                            response_data.windows(4).position(|w| w == b"\r\n\r\n")
                        {
                            headers_complete = true;
                            let headers_str = String::from_utf8_lossy(&response_data[..header_end]);
                            info!("Response headers: {}", headers_str);

                            // Parse Content-Length and Connection headers
                            for line in headers_str.lines() {
                                if let Some(colon_pos) = line.find(':') {
                                    let key = line[..colon_pos].trim().to_lowercase();
                                    let value = line[colon_pos + 1..].trim();

                                    if key == "content-length" {
                                        content_length = value.parse().ok();
                                        info!("Found Content-Length: {:?}", content_length);
                                    } else if key == "connection" && value.to_lowercase() == "close"
                                    {
                                        connection_close = true;
                                        info!("Found Connection: close");
                                    }
                                }
                            }

                            bytes_read_after_headers = response_data.len() - header_end - 4;
                            info!(
                                "Headers complete, {} bytes of body already read",
                                bytes_read_after_headers
                            );
                        }
                    } else {
                        bytes_read_after_headers += n;
                    }

                    // Forward to client
                    if let Err(e) = client_stream.write_all(&buffer[..n]).await {
                        if Self::is_connection_closed_error(&e) {
                            info!("Client connection closed during write");
                            break;
                        }
                        return Err(ProxyError::Io(e));
                    }
                    info!("Successfully forwarded {} bytes to client", n);

                    // Check if we've read the complete response
                    if headers_complete {
                        if let Some(expected_length) = content_length {
                            if bytes_read_after_headers >= expected_length {
                                info!(
                                    "Read complete response based on Content-Length ({})",
                                    expected_length
                                );
                                break;
                            }
                        } else if connection_close {
                            // Continue reading until connection closes
                            info!("Waiting for connection close...");
                        } else {
                            // No Content-Length and no Connection: close, assume chunked or connection will close
                            // For HTTP/1.1 keep-alive, we need to be more careful here
                            // For now, let's add a small timeout to avoid hanging
                            info!("No Content-Length header, checking for more data...");
                        }
                    }
                }
                Ok(Err(e)) => {
                    if Self::is_connection_closed_error(&e) {
                        info!("Upstream connection closed during read: {}", e);
                        break;
                    }
                    error!("Error reading from upstream: {}", e);
                    return Err(ProxyError::Io(e));
                }
                Err(_) => {
                    // Timeout occurred
                    if headers_complete && content_length.is_some() {
                        error!("Timeout reading from upstream server");
                        return Err(ProxyError::Timeout);
                    } else {
                        info!("Timeout waiting for more data, assuming response complete");
                        break;
                    }
                }
            }
        }

        info!("HTTP request forwarding completed successfully");
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
        // Extract host and port from headers or URL
        let (host, port) = if let Some(host_header) = super::extract_host_from_headers(&headers) {
            // Parse host:port from Host header
            if let Some(colon_pos) = host_header.find(':') {
                let host = host_header[..colon_pos].to_string();
                let port = host_header[colon_pos + 1..].parse::<u16>().unwrap_or(80);
                (host, port)
            } else {
                (host_header, 80)
            }
        } else if url.starts_with("http://") {
            // Extract from URL
            if let Ok(parsed_url) = url::Url::parse(&url) {
                let host = parsed_url.host_str().unwrap_or("").to_string();
                let port = parsed_url.port().unwrap_or(80);
                (host, port)
            } else {
                return Err(ProxyError::InvalidRequest("Invalid URL".to_string()));
            }
        } else {
            return Err(ProxyError::InvalidRequest("No host specified".to_string()));
        };

        // Validate extracted host
        if host.trim().is_empty() {
            return Err(ProxyError::InvalidRequest(
                "Empty host extracted from request".to_string(),
            ));
        }

        info!("Extracted host for HTTP request: '{}:{}'", host, port);

        // Resolve target server with extracted port
        let target_addr = dns_resolver.resolve_with_fallback(&host, port).await?;
        info!("Resolved target address: {}", target_addr);

        // Connect to target server
        let mut upstream_stream = super::establish_upstream_connection(target_addr).await?;
        info!("Connected to upstream server");

        // Execute plugin events
        let mut context =
            super::create_request_context(&connection, &method, &url, &headers, body).await;

        let _actions = super::execute_plugin_event(
            &plugin_manager,
            crate::wasm::EventType::RequestHeaders,
            &mut context,
        )
        .await?;

        // Reconstruct and forward the HTTP request to upstream
        // Convert absolute URL to relative path for upstream server
        let path = if url.starts_with("http://") || url.starts_with("https://") {
            if let Ok(parsed_url) = url::Url::parse(&url) {
                let mut path = parsed_url.path().to_string();
                if let Some(query) = parsed_url.query() {
                    path.push('?');
                    path.push_str(query);
                }
                path
            } else {
                url.clone()
            }
        } else {
            url.clone()
        };

        let request_line = format!("{} {} HTTP/1.1\r\n", method, path);
        info!("Sending request line: {}", request_line.trim());
        upstream_stream.write_all(request_line.as_bytes()).await?;

        // Forward headers
        for (key, value) in &headers {
            let header_line = format!("{}: {}\r\n", key, value);
            upstream_stream.write_all(header_line.as_bytes()).await?;
        }

        // End headers
        upstream_stream.write_all(b"\r\n").await?;
        info!("Finished sending request to upstream");

        // Forward body if present (extract from original request)
        if let Some(body_start) = context
            .request
            .body
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
        {
            let body = &context.request.body[body_start + 4..];
            if !body.is_empty() {
                upstream_stream.write_all(body).await?;
            }
        }

        // Forward response back to client with timeout
        let mut buffer = vec![0u8; config.proxy.buffer_size];
        info!("Starting to read response from upstream");
        loop {
            // Add timeout to prevent hanging
            let read_result =
                tokio::time::timeout(Duration::from_secs(30), upstream_stream.read(&mut buffer))
                    .await;

            match read_result {
                Ok(Ok(0)) => {
                    // Upstream closed connection
                    info!("Upstream closed connection");
                    break;
                }
                Ok(Ok(n)) => {
                    // Successfully read data, forward to client
                    info!("Read {} bytes from upstream, forwarding to client", n);
                    if let Err(e) = client_stream.write_all(&buffer[..n]).await {
                        if Self::is_connection_closed_error(&e) {
                            info!("Client connection closed during write");
                            break;
                        }
                        return Err(ProxyError::Io(e));
                    }
                    info!("Successfully forwarded {} bytes to client", n);
                }
                Ok(Err(e)) => {
                    if Self::is_connection_closed_error(&e) {
                        info!("Upstream connection closed during read: {}", e);
                        break;
                    }
                    error!("Error reading from upstream: {}", e);
                    return Err(ProxyError::Io(e));
                }
                Err(_) => {
                    // Timeout occurred
                    error!("Timeout reading from upstream server");
                    return Err(ProxyError::Timeout);
                }
            }
        }

        debug!("HTTP request forwarding completed");
        Ok(())
    }

    async fn forward_tcp_connection(
        client_stream: TcpStream,
        host: &str,
        port: u16,
        dns_resolver: Arc<DnsResolver>,
    ) -> ProxyResult<()> {
        // Resolve target address with proper port
        let target_addr = dns_resolver.resolve_with_fallback(host, port).await?;

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
