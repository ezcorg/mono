#![feature(if_let_guard)]
// Library interface for witmproxy
// This exposes the internal modules for testing and external use

pub mod cert;
pub mod cli;
pub mod config;
pub mod content;
pub mod db;
pub mod plugins;
pub mod proxy;
pub mod wasm;
pub mod web;

#[cfg(test)]
pub mod test_utils;
#[cfg(test)]
mod tests;

// Re-export commonly used types for convenience
pub use cert::CertificateAuthority;
pub use config::{AppConfig, DbConfig, PluginConfig, ProxyConfig, TlsConfig, WebConfig};
pub use db::Db;
pub use plugins::registry::PluginRegistry;
pub use proxy::ProxyServer;
pub use wasm::Runtime;
pub use web::WebServer;

use anyhow::Result;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::{Notify, RwLock};
use tracing::{info, warn};

/// Main WitmProxy struct that holds everything necessary to run the proxy
pub struct WitmProxy {
    ca: CertificateAuthority,
    plugin_registry: Option<Arc<RwLock<PluginRegistry>>>,
    config: AppConfig,
    proxy_server: Option<ProxyServer>,
    web_server: Option<WebServer>,
    shutdown_notify: Arc<Notify>,
}

impl WitmProxy {
    /// Create a new WitmProxy instance with the given components
    ///
    /// # Arguments
    /// * [`ca`](CertificateAuthority) - The certificate authority for TLS operations
    /// * [`plugin_registry`](PluginRegistry) - Optional plugin registry for WASM plugins
    /// * [`config`](AppConfig) - The application configuration
    pub fn new(
        ca: CertificateAuthority,
        plugin_registry: Option<Arc<RwLock<PluginRegistry>>>,
        config: AppConfig,
    ) -> Self {
        Self {
            ca,
            plugin_registry,
            config,
            proxy_server: None,
            web_server: None,
            shutdown_notify: Arc::new(Notify::new()),
        }
    }

    /// Get the current configuration
    pub fn config(&self) -> &AppConfig {
        &self.config
    }

    /// Get the certificate authority
    pub fn certificate_authority(&self) -> &CertificateAuthority {
        &self.ca
    }

    /// Get the plugin registry
    pub fn plugin_registry(&self) -> &Option<Arc<RwLock<PluginRegistry>>> {
        &self.plugin_registry
    }

    /// Get the proxy server listen address (only available after start() is called)
    pub fn proxy_listen_addr(&self) -> Option<SocketAddr> {
        self.proxy_server.as_ref().and_then(|s| s.listen_addr())
    }

    /// Get the web server listen address (only available after start() is called)
    pub fn web_listen_addr(&self) -> Option<SocketAddr> {
        self.web_server.as_ref().and_then(|s| s.listen_addr())
    }

    /// Initialize and start all services
    pub async fn start(&mut self) -> Result<()> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        info!("Hi there! Starting up witmproxy for ya");

        // Start web server for certificate distribution
        let mut web_server = WebServer::new(
            self.ca.clone(),
            self.plugin_registry.clone(),
            self.config.clone(),
        );
        web_server.start().await?;
        let web_addr = web_server
            .listen_addr()
            .ok_or_else(|| anyhow::anyhow!("Failed to get web server listen address"))?;
        info!("Web listening on {}", web_addr);
        info!("Visit the web interface to download the root certificate");

        // Start proxy server
        let mut proxy_server = ProxyServer::new(
            self.ca.clone(),
            self.plugin_registry.clone(),
            self.config.clone(),
        )?;
        proxy_server.start().await?;
        let proxy_addr = proxy_server
            .listen_addr()
            .ok_or_else(|| anyhow::anyhow!("Failed to get proxy server listen address"))?;
        info!("Proxy listening on {}", proxy_addr);

        // Store server instances
        self.web_server = Some(web_server);
        self.proxy_server = Some(proxy_server);

        info!("witmproxy started successfully");
        Ok(())
    }

    /// Wait for the proxy to finish running (blocks until shutdown is called)
    pub async fn join(&self) -> Result<()> {
        if let (Some(web_server), Some(proxy_server)) = (&self.web_server, &self.proxy_server) {
            tokio::select! {
                _ = web_server.join() => {},
                _ = proxy_server.join() => {},
                _ = self.listen_shutdown_signal() => {}
            };
        }
        Ok(())
    }

    /// Shutdown all services gracefully
    pub async fn shutdown(&mut self) {
        info!("Shutting down...");

        if let Some(web_server) = &self.web_server {
            web_server.shutdown().await;
        }

        if let Some(proxy_server) = &self.proxy_server {
            proxy_server.shutdown().await;
        }

        self.shutdown_notify.notify_waiters();
        info!("Thanks for stopping by!");
    }

    /// Run the proxy until a shutdown signal is received
    pub async fn run(&mut self) -> Result<()> {
        self.start().await?;
        self.join().await?;
        self.shutdown().await;
        Ok(())
    }

    /// Listen for shutdown signals (SIGINT, SIGTERM)
    async fn listen_shutdown_signal(&self) {
        #[cfg(unix)]
        let terminate = async {
            if let Ok(mut sigterm) =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            {
                sigterm.recv().await;
            } else {
                warn!("Warning: failed to install SIGTERM handler");
                futures::future::pending::<()>().await;
            }
        };

        #[cfg(windows)]
        let terminate = async {
            if let Ok(mut sigterm) = tokio::signal::windows::ctrl_c() {
                sigterm.recv().await;
            } else {
                warn!("Warning: failed to install SIGBREAK handler");
                futures::future::pending::<()>().await;
            }
        };

        // Wait for either signal to be received
        tokio::select! {
            _ = terminate => {},
            _ = tokio::signal::ctrl_c() => {},
            _ = self.shutdown_notify.notified() => {},
        };
    }
}
