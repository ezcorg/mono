use anyhow::Result;
use clap::Parser;
use confique::Config;
use mitmproxy_rs::{
    config::confique_partial_app_config::PartialAppConfig, AppConfig, CertificateAuthority,
    ProxyServer, WebServer,
};
use std::path::PathBuf;
use tracing::{info, warn};

#[derive(Parser)]
#[command(name = "mitm-proxy")]
#[command(about = "A Rust MITM proxy connected to a WASM plugin system")]
struct Cli {
    /// Configuration file path
    #[arg(short, long, default_value = "./config.toml")]
    config_path: PathBuf,

    /// Configuration object
    #[command(flatten)]
    config: PartialAppConfig,

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
        .with_max_level(tracing::Level::DEBUG)
        .with_env_filter(format!(
            "mitmproxy_rs={},mitm_proxy={},{}",
            log_level, log_level, log_level
        ))
        .init();

    info!("Starting MITM Proxy Server");

    let config = AppConfig::builder()
        .preloaded(cli.config)
        .env()
        .file(&cli.config_path)
        .load()?;

    // Create certificate authority
    let ca: CertificateAuthority = CertificateAuthority::new(&config.tls.cert_dir).await?;
    info!("Certificate Authority initialized");

    // Initialize WASM plugin manager
    // let plugin_manager = wasm::PluginManager::new(&cli.plugin_dir).await?;
    // let plugin_count = plugin_manager.plugin_count().await;
    // info!(
    //     "WASM Plugin Manager initialized with {} plugins",
    //     plugin_count
    // );

    // Start web server for certificate distribution
    let web_server = WebServer::new(config.web.web_bind_addr.parse()?, ca.clone());
    let web_handle = tokio::spawn(async move {
        if let Err(e) = web_server.start().await {
            tracing::error!("Web server error: {}", e);
        }
    });

    // Start proxy server
    let mut proxy_server =
        ProxyServer::new(config.proxy.proxy_bind_addr.parse()?, ca, config.clone())?;
    proxy_server.start().await?;
    let proxy_handle = tokio::spawn(async move { proxy_server.join().await });

    info!("Proxy listening on {}", config.proxy.proxy_bind_addr);
    info!(
        "Web interface available at http://{}",
        config.web.web_bind_addr
    );
    info!(
        "Visit http://{}/ca.crt to download the root certificate",
        config.web.web_bind_addr
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
