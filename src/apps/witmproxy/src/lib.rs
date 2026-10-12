// The `conf` Subcommands derive emits private helper structs for named-field
// variants, which surface through the generated impls on our `pub` command
// enums. This is benign (the helpers are an implementation detail), so allow it.
#![allow(private_interfaces)]
// Library interface for witmproxy
// This exposes the internal modules for testing and external use

pub mod acl;
pub mod cert;
pub mod cli;
pub mod config;
pub mod db;
pub mod events;
pub mod http;
pub mod plugins;
pub mod policy;
pub mod proxy;
pub mod util;
pub mod wasm;
pub mod web;

// Make test_utils available for both internal tests and external integration tests
#[cfg(any(test, feature = "test-helpers"))]
pub mod test_utils;

#[cfg(test)]
mod tests;

// Re-export commonly used types for convenience
pub use cert::CertificateAuthority;
pub use config::{
    AppConfig, AuthConfig, DbConfig, PluginConfig, ProxyConfig, TlsConfig, TransparentProxyConfig,
    WebConfig,
};
pub use db::Db;
pub use plugins::registry::PluginRegistry;
pub use proxy::ProxyServer;
use proxy::tenant_resolver::TenantResolver;
pub use wasm::Runtime;
pub use web::WebServer;

use anyhow::Result;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::Notify;
use tracing::{info, warn};

/// Main WitmProxy struct that holds everything necessary to run the proxy
pub struct WitmProxy {
    ca: CertificateAuthority,
    plugin_registry: Option<Arc<PluginRegistry>>,
    config: AppConfig,
    config_path: Option<std::path::PathBuf>,
    db_pool: Option<sqlx::SqlitePool>,
    /// Who a proxy connection belongs to; `None` treats every client as
    /// anonymous.
    tenant_resolver: Option<Arc<dyn TenantResolver>>,
    /// Who may dial what, shared by the proxy (which asks it) and the
    /// management API (which edits tenants' policies in it).
    egress: Option<Arc<proxy::egress::Egress>>,
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
        plugin_registry: Option<Arc<PluginRegistry>>,
        config: AppConfig,
    ) -> Self {
        Self {
            ca,
            plugin_registry,
            config,
            config_path: None,
            db_pool: None,
            tenant_resolver: None,
            egress: None,
            proxy_server: None,
            web_server: None,
            shutdown_notify: Arc::new(Notify::new()),
        }
    }

    /// The policy stack, once started.
    pub fn egress(&self) -> Option<Arc<proxy::egress::Egress>> {
        self.egress.clone()
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
    pub fn plugin_registry(&self) -> &Option<Arc<PluginRegistry>> {
        &self.plugin_registry
    }

    /// Set the database pool for management API endpoints.
    pub fn with_db_pool(mut self, pool: sqlx::SqlitePool) -> Self {
        self.db_pool = Some(pool);
        self
    }

    /// Set the config file path so the management API can persist changes.
    pub fn with_config_path(mut self, path: std::path::PathBuf) -> Self {
        self.config_path = Some(path);
        self
    }

    /// Resolve each proxy connection's tenant with `resolver`, so plugins
    /// run per tenant rather than for everyone alike.
    pub fn with_tenant_resolver(mut self, resolver: Arc<dyn TenantResolver>) -> Self {
        self.tenant_resolver = Some(resolver);
        self
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

        // The policy: the instance's floor from the configuration, and every
        // tenant's from the database, validated against that floor. A
        // tenant policy that no longer compiles or passes its checks is left
        // out, loudly: that tenant is then judged by the floor alone.
        let egress = Arc::new(proxy::egress::Egress::from_config(&self.config.proxy)?);
        if let Some(pool) = &self.db_pool {
            for (tenant_id, json) in db::tenants::all_policies(pool).await? {
                let loaded = serde_json::from_str::<policy::PolicyDoc>(&json)
                    .map_err(|e| anyhow::anyhow!("{e}"))
                    .and_then(|doc| {
                        policy::Policy::compile(&doc, policy::Origin::Tenant(tenant_id.clone()))
                            .map_err(|e| anyhow::anyhow!("{e}"))
                    })
                    .and_then(|p| {
                        p.validate(Some(egress.floor()))
                            .map(|()| p)
                            .map_err(|e| anyhow::anyhow!("{e}"))
                    });
                match loaded {
                    Ok(p) => egress.set_tenant(&tenant_id, p),
                    Err(e) => warn!("tenant {tenant_id}: stored policy not loaded: {e}"),
                }
            }
        }
        self.egress = Some(Arc::clone(&egress));

        // Start web server for certificate distribution and management API
        let mut web_server = WebServer::new(
            self.ca.clone(),
            self.plugin_registry.clone(),
            self.config.clone(),
        );
        if let Some(ref path) = self.config_path {
            web_server = web_server.with_config_path(path.clone());
        }
        if let Some(ref pool) = self.db_pool {
            web_server = web_server.with_db_pool(pool.clone());
        }
        if let Some(resolver) = &self.tenant_resolver {
            web_server = web_server.with_tenant_resolver(Arc::clone(resolver));
        }
        web_server = web_server.with_egress(Arc::clone(&egress));
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
        )?
        .with_egress(Arc::clone(&egress));
        if let Some(resolver) = &self.tenant_resolver {
            proxy_server = proxy_server.with_tenant_resolver(Arc::clone(resolver));
        }
        // Tell the proxy where its own management server is so it can
        // short-circuit traffic targeting that port back to loopback.
        proxy_server.set_management_addr(web_addr);
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
