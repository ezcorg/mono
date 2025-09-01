use anyhow::Result;
use clap::Parser;
use confique::Config;
use mitmproxy_rs::{
    config::confique_partial_app_config::PartialAppConfig, AppConfig, CertificateAuthority,
    ProxyServer, WebServer,
};
use std::path::PathBuf;
use tracing::info;

#[derive(Parser)]
#[command(name = "mitm")]
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

impl Cli {
    async fn run(&self) -> Result<()> {
        // Install default crypto provider for rustls
        rustls::crypto::ring::default_provider()
            .install_default()
            .map_err(|_| anyhow::anyhow!("Failed to install default crypto provider"))?;

        // Initialize logging
        let log_level = if self.verbose { "debug" } else { "info" };
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .with_env_filter(format!(
                "mitmproxy_rs={},mitm_proxy={},{}",
                log_level, log_level, log_level
            ))
            .init();

        info!("Starting MITM Proxy Server");

        let config = AppConfig::builder()
            .preloaded(self.config.clone())
            .env()
            .file(&self.config_path)
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
        let mut web_server = WebServer::new(ca.clone(), config.clone());
        web_server.start().await?;
        let web_addr = web_server.listen_addr().unwrap();
        let web_handle = tokio::spawn(async move { web_server.join().await });
        info!("Web listening on {}", web_addr);
        info!("Visit the web interface to download the root certificate");

        // Start proxy server
        let mut proxy_server = ProxyServer::new(ca, config.clone())?;
        proxy_server.start().await?;
        let proxy_addr = proxy_server.listen_addr().unwrap();
        let proxy_handle = tokio::spawn(async move { proxy_server.join().await });
        info!("Proxy listening on {}", proxy_addr);

        // Wait for both servers
        tokio::select! {
            _ = web_handle => {},
            _ = proxy_handle => {},
            _ = tokio::signal::ctrl_c() => {
                info!("Received shutdown signal");
            }
        };
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    cli.run().await
}
