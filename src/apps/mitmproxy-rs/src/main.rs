use anyhow::Result;
use clap::Parser;
use mitmproxy_rs::{CertificateAuthority, Config, ProxyServer, WebServer};
use std::net::SocketAddr;
use std::path::PathBuf;
use tracing::{info, warn};

#[derive(Parser)]
#[command(name = "mitm-proxy")]
#[command(about = "A Rust MITM proxy connected to a WASM plugin system")]
struct Cli {
    /// Configuration file path
    #[arg(short, long, default_value = "config.toml")]
    config: PathBuf,

    /// Proxy listen address
    #[arg(short, long, default_value = "127.0.0.1:8082")]
    proxy_addr: SocketAddr,

    /// Web interface listen address
    #[arg(short, long, default_value = "127.0.0.1:8083")]
    web_addr: SocketAddr,

    /// Certificate directory
    #[arg(long, default_value = "./certs")]
    cert_dir: PathBuf,

    /// Plugin directory
    #[arg(long, default_value = "./plugins")]
    plugin_dir: PathBuf,

    /// Enable verbose logging
    #[arg(short, long)]
    verbose: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Install default crypto provider for rustls
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("Failed to install default crypto provider"))?;

    let cli = Cli::parse();

    // Initialize logging
    let log_level = if cli.verbose { "debug" } else { "info" };
    tracing_subscriber::fmt()
        .with_env_filter(format!(
            "mitmproxy_rs={},mitm_proxy={},{}",
            log_level, log_level, log_level
        ))
        .init();

    info!("Starting MITM Proxy Server");

    // Load configuration
    let config = Config::load(&cli.config).unwrap_or_else(|e| {
        warn!("Failed to load config: {}, using defaults", e);
        Config::default()
    });

    // Create certificate authority
    let ca: CertificateAuthority = CertificateAuthority::new(&cli.cert_dir).await?;
    info!("Certificate Authority initialized");

    // Initialize WASM plugin manager
    // let plugin_manager = wasm::PluginManager::new(&cli.plugin_dir).await?;
    // let plugin_count = plugin_manager.plugin_count().await;
    // info!(
    //     "WASM Plugin Manager initialized with {} plugins",
    //     plugin_count
    // );

    // Start web server for certificate distribution
    let web_server = WebServer::new(cli.web_addr, ca.clone());
    let web_handle = tokio::spawn(async move {
        if let Err(e) = web_server.start().await {
            tracing::error!("Web server error: {}", e);
        }
    });

    // Start proxy server
    let proxy_server = ProxyServer::new(cli.proxy_addr, ca, config);
    let proxy_handle = tokio::spawn(async move {
        if let Err(e) = proxy_server.start().await {
            tracing::error!("Proxy server error: {}", e);
        }
    });

    info!("Proxy listening on {}", cli.proxy_addr);
    info!("Web interface available at http://{}", cli.web_addr);
    info!(
        "Visit http://{}/ca.crt to download the root certificate",
        cli.web_addr
    );

    // Wait for both servers
    tokio::select! {
        _ = web_handle => {},
        _ = proxy_handle => {},
        _ = tokio::signal::ctrl_c() => {
            info!("Received shutdown signal");
        }
    }

    info!("Shutting down");
    Ok(())
}
