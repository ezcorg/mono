use super::{download_certificate, index_page, AppState};
use crate::cert::CertificateAuthority;
use crate::config::AppConfig;
use crate::plugins::registry::PluginRegistry;
use crate::plugins::WitmPlugin;
use anyhow::Result;
use rust_embed::RustEmbed;
use salvo::oapi::endpoint;
use salvo::oapi::extract::JsonBody;
use salvo::serve_static::static_embed;
use salvo::server::ServerHandle;
use salvo::Writer;
use salvo::{affix_state, Depot, Listener, Server};
use salvo::{conn::TcpListener, oapi::OpenApi, prelude::SwaggerUi, Router};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::{Notify, RwLock};
use tracing::warn;

pub struct WebServer {
    listen_addr: Option<SocketAddr>,
    ca: CertificateAuthority,
    plugin_registry: Option<Arc<RwLock<PluginRegistry>>>,
    config: AppConfig,
    shutdown_notify: Arc<Notify>,
    handle: Option<ServerHandle>,
}

#[derive(RustEmbed)]
#[folder = "web-ui/static"]
struct Assets;

impl WebServer {
    pub fn new(
        ca: CertificateAuthority,
        plugin_registry: Option<Arc<RwLock<PluginRegistry>>>,
        config: AppConfig,
    ) -> Self {
        Self {
            listen_addr: None,
            ca,
            config,
            plugin_registry,
            shutdown_notify: Arc::new(Notify::new()),
            handle: None,
        }
    }

    /// Returns the actual bound listen address, if the server has been started
    pub fn listen_addr(&self) -> Option<SocketAddr> {
        self.listen_addr
    }

    /// Starts the server: binds the listener and spawns the accept loop.
    /// Returns immediately once the listener is bound.
    pub async fn start(&mut self) -> Result<()> {
        // Determine the bind address: use configured address or default to OS-assigned port
        let bind_addr: SocketAddr = if let Some(ref addr_str) = self.config.web.web_bind_addr {
            addr_str
                .parse()
                .map_err(|e| anyhow::anyhow!("Invalid web bind address: {}", e))?
        } else {
            "127.0.0.1:0".parse().unwrap()
        };

        let state = AppState {
            ca: self.ca.clone(),
            plugin_registry: self.plugin_registry.clone(),
        };

        salvo::http::request::set_global_secure_max_size(1 * 1024 * 1024 * 1024); // 1 GB

        let app = Router::new()
            .hoop(affix_state::inject(state))
            .push(Router::with_path("/").get(index_page))
            .push(Router::with_path("/cert").get(download_certificate))
            .push(Router::with_path("/api/health").get(health_check))
            .push(
                Router::with_path("/api/plugins")
                    .get(list_plugins)
                    .put(upsert_plugin),
            )
            // Static assets
            .push(Router::with_path("/static/{*path}").get(static_embed::<Assets>()));

        let doc = OpenApi::new("citmproxy", "0.0.1").merge_router(&app);
        let app = app
            .unshift(doc.into_router("/api/docs/openapi.json"))
            .unshift(SwaggerUi::new("/api/docs/openapi.json").into_router("/swagger"));
        let acceptor = TcpListener::new(bind_addr).bind().await;

        // Store the actual bound address
        self.listen_addr = Some(acceptor.local_addr()?);
        let did_shutdown = self.shutdown_notify.clone();
        let server = Server::new(acceptor);
        self.handle = Some(server.handle());

        tokio::spawn(async move {
            server.serve(app).await;
            did_shutdown.notify_waiters();
        });

        Ok(())
    }

    /// Returns a future that resolves when the server stops.
    pub async fn join(&self) {
        self.shutdown_notify.notified().await;
    }

    pub async fn shutdown(&self) {
        self.shutdown_notify.notify_waiters();

        if let Some(handle) = &self.handle {
            handle.stop_graceful(None);
        }
    }
}

// // Health check endpoint
#[endpoint]
async fn health_check(res: &mut salvo::Response) {
    res.status_code(salvo::http::StatusCode::OK);
    res.render(salvo::writing::Text::Plain("OK"));
}

// Plugin management endpoints
#[endpoint]
async fn list_plugins(depot: &mut Depot, res: &mut salvo::Response) {
    let registry = if let Some(state) = depot.obtain::<AppState>().ok() {
        state.plugin_registry.clone()
    } else {
        warn!("Failed to obtain AppState in list_plugins");
        res.status_code(salvo::http::StatusCode::INTERNAL_SERVER_ERROR);
        res.render(salvo::writing::Text::Plain("Internal server error"));
        return;
    };

    if let Some(registry) = registry {
        let registry = registry.read().await;
        let plugin_names: Vec<String> = registry
            .plugins
            .iter()
            .map(|(name, _)| name.clone())
            .collect();
        res.status_code(salvo::http::StatusCode::OK);
        res.render(salvo::writing::Json(plugin_names));
    } else {
        res.status_code(salvo::http::StatusCode::OK);
        res.render(salvo::writing::Json(Vec::<String>::new()));
    }
}

#[endpoint]
async fn upsert_plugin(depot: &mut Depot, plugin: JsonBody<WitmPlugin>, res: &mut salvo::Response) {
    let registry = if let Some(state) = depot.obtain::<AppState>().ok() {
        state.plugin_registry.clone()
    } else {
        warn!("Failed to obtain AppState in upsert_plugin");
        res.status_code(salvo::http::StatusCode::INTERNAL_SERVER_ERROR);
        res.render(salvo::writing::Text::Plain("Internal server error"));
        return;
    };

    let registry = if let Some(r) = registry {
        r
    } else {
        res.status_code(salvo::http::StatusCode::BAD_REQUEST);
        res.render(salvo::writing::Text::Plain("Plugin system is disabled"));
        return;
    };

    let mut registry = registry.write().await;

    let result = registry.register_plugin(plugin.0).await;
    match result {
        Ok(_) => {
            res.status_code(salvo::http::StatusCode::OK);
            res.render(salvo::writing::Text::Plain(
                "Plugin added/updated successfully",
            ));
        }
        Err(e) => {
            warn!("Failed to add/update plugin: {}", e);
            res.status_code(salvo::http::StatusCode::INTERNAL_SERVER_ERROR);
            res.render(salvo::writing::Text::Plain(format!(
                "Failed to add/update plugin: {}",
                e
            )));
        }
    }
}
