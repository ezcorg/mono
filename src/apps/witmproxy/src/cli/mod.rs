use crate::{
    AppConfig, CertificateAuthority, WitmProxy, config::expand_home_in_path, db::Db,
    plugins::registry::PluginRegistry, wasm::Runtime,
};
use plugin::PluginCommands;
use proxy::ProxyCommands;
use trust::TrustCommands;

use anyhow::Result;
use clap::{Parser, Subcommand};
use confique::Config;
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::RwLock;
use tracing::info;

// Re-export PartialAppConfig for public usage
pub use crate::config::confique_partial_app_config::PartialAppConfig;

mod plugin;
mod proxy;
mod trust;

#[cfg(test)]
mod tests;

#[derive(Parser)]
#[command(name = "witmproxy")]
#[command(about = "A WASM-in-the-middle proxy")]
pub struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

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

/// Internal helper struct that holds the resolved configuration
pub struct ResolvedCli {
    command: Option<Commands>,
    config: AppConfig,
    verbose: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Plugin management commands
    Plugin {
        #[command(subcommand)]
        command: PluginCommands,
    },
    /// Certificate trust management commands
    Trust {
        #[command(subcommand)]
        command: TrustCommands,
    },
    /// System proxy management commands
    Proxy {
        #[command(subcommand)]
        command: ProxyCommands,
    },
}

#[derive(Serialize, Deserialize)]
struct Services {
    proxy: String,
    web: String,
}

impl Cli {
    pub async fn run(self) -> Result<()> {
        let log_level = if self.verbose { "debug" } else { "info" };
        tracing_subscriber::fmt()
            .with_env_filter(format!("witmproxy={},{}", log_level, log_level))
            .init();

        // Load and resolve configuration once at the beginning
        let resolved_cli = self.resolve_config().await?;

        // Handle subcommands first
        if let Some(ref command) = resolved_cli.command {
            return resolved_cli.handle_command(command).await;
        }

        // Default behavior - run the proxy
        resolved_cli.run_proxy().await
    }

    /// Load the configuration and resolve all $HOME placeholders
    async fn resolve_config(self) -> Result<ResolvedCli> {
        // Resolve home directory and config path
        let config_path = expand_home_in_path(&self.config_path)?;

        // Load configuration using confique
        let config = AppConfig::builder()
            .preloaded(self.config)
            .env()
            .file(&config_path)
            .load()?
            .with_resolved_paths()?;

        Ok(ResolvedCli {
            command: self.command,
            config,
            verbose: self.verbose,
        })
    }
}

impl ResolvedCli {
    async fn handle_command(&self, command: &Commands) -> Result<()> {
        // TODO: change CLI such that the same code can be used for local and remote proxy management
        match command {
            Commands::Plugin { command } => {
                let plugin_handler = plugin::PluginHandler::new(self.config.clone(), self.verbose);
                plugin_handler.handle(command).await
            }
            Commands::Trust { command } => {
                let trust_handler = trust::TrustHandler::new(self.config.clone());
                trust_handler.handle(command).await
            }
            Commands::Proxy { command } => {
                let proxy_handler = proxy::ProxyHandler::new(self.config.clone());
                proxy_handler.handle(command).await
            }
        }
    }

    async fn run_proxy(&self) -> Result<()> {
        // Create app directory based on the resolved cert_dir parent
        let app_dir = self
            .config
            .tls
            .cert_dir
            .parent()
            .unwrap_or(&PathBuf::from("."))
            .to_path_buf();
        std::fs::create_dir_all(&app_dir)?;

        info!("Loaded proxy configuration");

        // Create certificate authority using pre-resolved cert_dir
        std::fs::create_dir_all(&self.config.tls.cert_dir)?;
        let ca = CertificateAuthority::new(self.config.tls.cert_dir.clone()).await?;
        info!("Certificate Authority initialized");

        // Initialize database using pre-resolved path
        if let Some(parent) = self.config.db.db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let db = Db::from_path(self.config.db.db_path.clone(), &self.config.db.db_password).await?;
        db.migrate().await?;
        info!(
            "Database initialized and migrated at: {}",
            self.config.db.db_path.display()
        );

        // Plugin registry which will be shared across the proxy and web server
        let plugin_registry = if self.config.plugins.enabled {
            let runtime = Runtime::default()?;
            let mut registry = PluginRegistry::new(db, runtime);
            registry.load_plugins().await?;
            info!("Number of plugins loaded: {}", registry.plugins().len());
            Some(Arc::new(RwLock::new(registry)))
        } else {
            None
        };

        let mut proxy = WitmProxy::new(ca, plugin_registry, self.config.clone());
        proxy.start().await?;

        // Capture the bound addresses
        let proxy_addr = proxy
            .proxy_listen_addr()
            .ok_or_else(|| anyhow::anyhow!("Failed to get proxy listen address"))?;
        let web_addr = proxy
            .web_listen_addr()
            .ok_or_else(|| anyhow::anyhow!("Failed to get web listen address"))?;

        // Create services structure
        let services = Services {
            proxy: proxy_addr.to_string(),
            web: web_addr.to_string(),
        };

        // Write services.json to config root (app_dir)
        let services_path = app_dir.join("services.json");
        let services_json = serde_json::to_string_pretty(&services)?;
        std::fs::write(&services_path, services_json)?;
        info!("Services information written to: {:?}", services_path);

        // Continue running the proxy
        proxy.join().await?;
        proxy.shutdown().await;

        Ok(())
    }
}
