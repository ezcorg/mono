use anyhow::Result;
use clap::Parser;
use confique::Config;
use witmproxy::{
    config::confique_partial_app_config::PartialAppConfig, db::Db,
    plugins::registry::PluginRegistry, wasm::Runtime, AppConfig, CertificateAuthority, WitmProxy,
};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::RwLock;
use tracing::info;

#[derive(Parser)]
#[command(name = "witmproxy")]
#[command(about = "A Rust MITM proxy connected to a WASM plugin system")]
struct Cli {
    /// Configuration file path
    #[arg(short, long, default_value = "$HOME/.witmproxy/config.toml")]
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
        // Resolve home and app directory
        let home_dir = dirs::home_dir().unwrap_or(".".into());
        let app_dir = home_dir.join(".witmproxy");
        std::fs::create_dir_all(&app_dir)?;

        let config_path = self
            .config_path
            .to_str()
            .unwrap_or("")
            .replace("$HOME", home_dir.to_str().unwrap_or("."));
        let config_path = PathBuf::from(config_path);

        let config = AppConfig::builder()
            .preloaded(self.config.clone())
            .env()
            .file(&config_path)
            .load()?;

        info!("Loaded proxy configuration");

        // Create certificate authority
        let cert_dir: PathBuf = config
            .tls
            .cert_dir
            .clone()
            .to_str()
            .unwrap_or("")
            .replace("$HOME", home_dir.to_str().unwrap_or("."))
            .parse()?;
        std::fs::create_dir_all(&cert_dir)?;

        let ca = CertificateAuthority::new(cert_dir).await?;
        info!("Certificate Authority initialized");

        // Initialize the database and perform any necessary migrations
        let db_file_path = config
            .db
            .db_path
            .to_str()
            .unwrap_or("")
            .replace("$HOME", home_dir.to_str().unwrap_or("."));

        // Create the parent directory of the database file
        if let Some(parent) = PathBuf::from(&db_file_path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        let db_path = format!("sqlite://{}", db_file_path);

        let db = Db::from_path(&db_path, &config.db.db_password).await?;
        db.migrate().await?;
        info!("Database initialized and migrated at: {}", db_path);

        // Plugin registry which will be shared across the proxy and web server
        let plugin_registry = if config.plugins.enabled {
            let runtime = Runtime::default()?;
            let mut registry = PluginRegistry::new(db, runtime);
            registry.load_plugins().await?;
            info!("Loaded {} plugins", registry.plugins.len());
            Some(Arc::new(RwLock::new(registry)))
        } else {
            None
        };

        let mut proxy = WitmProxy::new(ca, plugin_registry, config, if self.verbose { "debug" } else { "info" }.to_string());
        proxy.run().await?;

        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    cli.run().await
}
