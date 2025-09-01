use super::templates::DashboardTemplate;
use super::{
    cert_info, download_ca_crt, download_ca_pem, download_certificate, index_page, AppState,
};
use crate::cert::CertificateAuthority;
use crate::config::AppConfig;
use anyhow::Result;
use askama_axum::IntoResponse;
use axum::{routing::get, Router};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::Notify;
use tower::ServiceBuilder;
use tower_http::cors::CorsLayer;
use tracing::info;

#[derive(Debug)]
pub struct WebServer {
    listen_addr: Option<SocketAddr>,
    ca: CertificateAuthority,
    config: Arc<AppConfig>,
    shutdown_notify: Arc<Notify>,
}

impl WebServer {
    pub fn new(ca: CertificateAuthority, config: AppConfig) -> Self {
        Self {
            listen_addr: None,
            ca,
            config: Arc::new(config),
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
            // Main certificate endpoints
            .route("/", get(index_page))
            .route("/cert", get(download_certificate))
            .route("/ca.crt", get(download_ca_crt))
            .route("/ca.pem", get(download_ca_pem))
            // API endpoints
            .route("/api/cert-info", get(cert_info))
            .route("/api/health", get(health_check))
            .route("/api/stats", get(proxy_stats))
            // Plugin management endpoints (if dashboard is enabled)
            .route("/api/plugins", get(list_plugins))
            .route("/api/plugins/:name", get(get_plugin_info))
            .route("/api/plugins/:name/enable", get(enable_plugin))
            .route("/api/plugins/:name/disable", get(disable_plugin))
            .route("/api/plugins/logs", get(get_plugin_logs))
            // Static files and dashboard
            .nest_service(
                "/static",
                tower_http::services::ServeDir::new("web-ui/static"),
            )
            .route("/dashboard", get(dashboard_page))
            .layer(ServiceBuilder::new().layer(CorsLayer::permissive()))
            .with_state(state);

        let listener = tokio::net::TcpListener::bind(bind_addr).await?;

        // Store the actual bound address
        self.listen_addr = Some(listener.local_addr()?);
        let shutdown = self.shutdown_notify.clone();

        // Use axum's graceful shutdown with our shutdown signal
        let _ = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    shutdown.notified().await;
                    info!("Shutdown signal received, stopping web server");
                })
                .await
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

// Health check endpoint
async fn health_check() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({
        "status": "healthy",
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "version": env!("CARGO_PKG_VERSION")
    }))
}

// Proxy statistics endpoint
async fn proxy_stats(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> Result<axum::Json<serde_json::Value>, axum::http::StatusCode> {
    let (cache_size, cache_max) = state.ca.cache_stats().await;

    Ok(axum::Json(serde_json::json!({
        "certificate_cache": {
            "size": cache_size,
            "max_size": cache_max,
            "hit_rate": "N/A" // Would need to track this
        },
        "connections": {
            "active": "N/A", // Would need to track this
            "total": "N/A"
        }
    })))
}

// Plugin management endpoints
async fn list_plugins() -> axum::Json<serde_json::Value> {
    // This would integrate with the plugin manager
    // For now, return empty list
    axum::Json(serde_json::json!({
        "plugins": [],
        "total": 0
    }))
}

async fn get_plugin_info(
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Result<axum::Json<serde_json::Value>, axum::http::StatusCode> {
    // This would get plugin info from the plugin manager
    Ok(axum::Json(serde_json::json!({
        "name": name,
        "status": "not_implemented"
    })))
}

async fn enable_plugin(
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Result<axum::Json<serde_json::Value>, axum::http::StatusCode> {
    // This would enable the plugin
    Ok(axum::Json(serde_json::json!({
        "plugin": name,
        "action": "enable",
        "status": "not_implemented"
    })))
}

async fn disable_plugin(
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Result<axum::Json<serde_json::Value>, axum::http::StatusCode> {
    // This would disable the plugin
    Ok(axum::Json(serde_json::json!({
        "plugin": name,
        "action": "disable",
        "status": "not_implemented"
    })))
}

async fn get_plugin_logs() -> axum::Json<serde_json::Value> {
    // This would get plugin logs from the plugin manager
    axum::Json(serde_json::json!({
        "logs": [],
        "total": 0
    }))
}

// Dashboard page
async fn dashboard_page() -> Result<impl IntoResponse, axum::http::StatusCode> {
    let template = DashboardTemplate::new();
    Ok(template)
}
