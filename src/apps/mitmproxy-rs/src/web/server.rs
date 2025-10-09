use super::{
    download_certificate, index_page, AppState,
};
use crate::cert::CertificateAuthority;
use crate::config::AppConfig;
use crate::plugins::registry::PluginRegistry;
use anyhow::Result;
use salvo::server::ServerHandle;
use salvo::{conn::TcpListener, oapi::OpenApi, prelude::SwaggerUi, Router};
use tokio::signal;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::{Notify, RwLock};
use tower::ServiceBuilder;
use tower_http::cors::CorsLayer;
use tracing::info;
use rust_embed::{RustEmbed};
use salvo::serve_static::static_embed;
use salvo::{affix_state, Listener, Server};
#[cfg(unix)]
use tokio::signal::unix;
use tokio::task;


pub struct WebServer {
    listen_addr: Option<SocketAddr>,
    ca: CertificateAuthority,
    plugin_registry: Option<Arc<RwLock<PluginRegistry>>>,
    config: AppConfig,
    shutdown_notify: Arc<Notify>,
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

        let state = Arc::new(AppState {
            ca: self.ca.clone(),
        });

        let app = Router::new()
            .hoop(affix_state::inject(state))
            .push(Router::with_path("/").get(index_page))
            .push(Router::with_path("/cert").get(download_certificate))
            // .push(Router::with_path("/ca.crt").get(download_ca_crt))
            // .push(Router::with_path("/ca.pem").get(download_ca_pem))
            // .push(Router::with_path("/api/cert-info").get(cert_info))
            // .push(Router::with_path("/api/health").get(health_check))
            // .push(Router::with_path("/api/plugins").get(list_plugins))
            // Static assets
            .push(Router::with_path("/static/{*path}").get(static_embed::<Assets>()));


        let doc = OpenApi::new("test api", "0.0.1").merge_router(&app);
        let app = app
            .unshift(doc.into_router("/api-doc/openapi.json"))
            .unshift(SwaggerUi::new("/api-doc/openapi.json").into_router("/swagger-ui"));


        let acceptor = TcpListener::new(bind_addr).bind().await;

        // Store the actual bound address
        self.listen_addr = Some(acceptor.local_addr()?);
        let shutdown = self.shutdown_notify.clone();
        let server = Server::new(acceptor);
        let handle = server.handle();

        tokio::spawn(async move {
            listen_shutdown_signal(handle).await;
            shutdown.notify_waiters();
        });
        tokio::spawn(async move {
            server.serve(app).await;
        });

        Ok(())
    }

    /// Returns a future that resolves when the server stops.
    pub async fn join(&self) {
        self.shutdown_notify.notified().await;
    }

    pub async fn shutdown(&self) {
        self.shutdown_notify.notify_waiters();
    }
}

// // Health check endpoint
// async fn health_check() -> axum::Json<serde_json::Value> {
//     axum::Json(serde_json::json!({
//         "status": "healthy",
//         "timestamp": chrono::Utc::now().to_rfc3339(),
//         "version": env!("CARGO_PKG_VERSION")
//     }))
// }

// // Proxy statistics endpoint
// async fn proxy_stats(
//     axum::extract::State(state): axum::extract::State<Arc<AppState>>,
// ) -> Result<axum::Json<serde_json::Value>, axum::http::StatusCode> {
//     let (cache_size, cache_max) = state.ca.cache_stats().await;

//     Ok(axum::Json(serde_json::json!({
//         "certificate_cache": {
//             "size": cache_size,
//             "max_size": cache_max,
//             "hit_rate": "N/A" // Would need to track this
//         },
//         "connections": {
//             "active": "N/A", // Would need to track this
//             "total": "N/A"
//         }
//     })))
// }

// // Plugin management endpoints
// async fn list_plugins() -> axum::Json<serde_json::Value> {
//     // This would integrate with the plugin manager
//     // For now, return empty list
//     axum::Json(serde_json::json!({
//         "plugins": [],
//         "total": 0
//     }))
// }

async fn listen_shutdown_signal(handle: ServerHandle) {
    // Wait Shutdown Signal
    let ctrl_c = async {
        // Handle Ctrl+C signal
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        // Handle SIGTERM on Unix systems
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(windows)]
    let terminate = async {
        // Handle Ctrl+C on Windows (alternative implementation)
        signal::windows::ctrl_c()
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    // Wait for either signal to be received
    tokio::select! {
        _ = ctrl_c => println!("ctrl_c signal received"),
        _ = terminate => println!("terminate signal received"),
    };

    // Graceful Shutdown Server
    handle.stop_graceful(None);
}