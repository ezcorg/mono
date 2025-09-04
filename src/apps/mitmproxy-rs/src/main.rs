use anyhow::Result;
use clap::Parser;
use confique::Config;
use mitmproxy_rs::{
    config::confique_partial_app_config::PartialAppConfig, db::Db,
    plugins::registry::PluginRegistry, AppConfig, CertificateAuthority, ProxyServer, WebServer,
};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::RwLock;
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
        let home_dir = dirs::home_dir().unwrap_or(".".into());
        let app_dir = home_dir.join(".mitmproxy-rs");
        std::fs::create_dir_all(&app_dir)?;

        let cert_dir: PathBuf = config
            .tls
            .cert_dir
            .clone()
            .to_str()
            .unwrap_or("")
            .replace("$HOME", home_dir.to_str().unwrap_or("."))
            .parse()?;
        std::fs::create_dir_all(&cert_dir)?;

        // Create certificate authority
        let ca = CertificateAuthority::new(cert_dir).await?;
        info!("Certificate Authority initialized");

        // Initialize the database and perform any necessary migrations
        let db_path = "sqlite://".to_owned()
            + config
                .db
                .db_path
                .to_str()
                .unwrap_or("")
                .replace("$HOME", home_dir.to_str().unwrap_or("."))
                .as_str();
        std::fs::create_dir_all(&db_path)?;
        // TODO: configure pool
        let pool = sqlx::SqlitePool::connect(&db_path).await?;
        let db = Db::new(pool).await;
        sqlx::migrate!("src/db/migrations")
            .run(&db.pool)
            .await
            .map_err(|e| anyhow::anyhow!("Database migration failed: {}", e))?;

        // Plugin registry which will be shared across the proxy and web server
        let plugin_registry = if config.plugins.enabled {
            Some(Arc::new(RwLock::new(PluginRegistry::new(
                config.plugins.clone(),
                db,
            ))))
        } else {
            None
        };

        // Start web server for certificate distribution
        let mut web_server = WebServer::new(ca.clone(), plugin_registry.clone(), config.clone());
        web_server.start().await?;
        let web_addr = web_server.listen_addr().unwrap();
        let web_handle = tokio::spawn(async move { web_server.join().await });
        info!("Web listening on {}", web_addr);
        info!("Visit the web interface to download the root certificate");

        // Start proxy server
        let mut proxy_server = ProxyServer::new(ca, plugin_registry.clone(), config.clone())?;
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
