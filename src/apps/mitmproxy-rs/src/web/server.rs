use super::templates::DashboardTemplate;
use super::{
    cert_info, download_ca_crt, download_ca_pem, download_certificate, index_page, AppState,
};
use crate::cert::CertificateAuthority;
use anyhow::Result;
use askama_axum::IntoResponse;
use axum::{routing::get, Router};
use std::net::SocketAddr;
use std::sync::Arc;
use tower::ServiceBuilder;
use tower_http::cors::CorsLayer;
use tracing::info;

#[derive(Debug)]
pub struct WebServer {
    listen_addr: SocketAddr,
    ca: CertificateAuthority,
}

impl WebServer {
    pub fn new(listen_addr: SocketAddr, ca: CertificateAuthority) -> Self {
        Self { listen_addr, ca }
    }

    pub async fn start(self) -> Result<()> {
        let state = Arc::new(AppState { ca: self.ca });

        let app = Router::new()
            // Main certificate endpoints
            .route("/", get(index_page))
            .route("/cert", get(download_certificate))
            // Legacy compatibility endpoints
            .route("/ca.crt", get(download_ca_crt))
            .route("/ca.pem", get(download_ca_pem))
            .route("/mitm-proxy-ca.crt", get(download_ca_crt))
            .route("/mitm-proxy-ca.pem", get(download_ca_pem))
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

        info!("Web server starting on {}", self.listen_addr);

        let listener = tokio::net::TcpListener::bind(self.listen_addr).await?;
        axum::serve(listener, app).await?;

        Ok(())
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
