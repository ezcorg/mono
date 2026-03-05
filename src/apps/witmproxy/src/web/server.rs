use super::{AppState, download_certificate, index_page};
use crate::cert::CertificateAuthority;
use crate::config::AppConfig;
use crate::plugins::registry::PluginRegistry;
use crate::web::{
    auth::jwt_auth,
    acl_middleware::acl_check,
    auth_endpoints,
    management,
};
use anyhow::Result;
use rust_embed::RustEmbed;
use salvo::Writer;
use salvo::conn::rustls::{Keycert, RustlsConfig};
use salvo::oapi::endpoint;
use salvo::oapi::extract::{FormFile, PathParam};
use salvo::prelude::ForceHttps;
use salvo::serve_static::static_embed;
use salvo::server::ServerHandle;
use salvo::{Depot, Listener, Server, affix_state};
use salvo::{Router, conn::TcpListener, oapi::OpenApi, prelude::SwaggerUi};
use sqlx::SqlitePool;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::fs;
use tokio::sync::{Notify, RwLock};
use tracing::warn;

pub struct WebServer {
    listen_addr: Option<SocketAddr>,
    ca: CertificateAuthority,
    plugin_registry: Option<Arc<RwLock<PluginRegistry>>>,
    config: AppConfig,
    db_pool: Option<SqlitePool>,
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
            db_pool: None,
            shutdown_notify: Arc::new(Notify::new()),
            handle: None,
        }
    }

    /// Set the database pool for management API endpoints.
    pub fn with_db_pool(mut self, pool: SqlitePool) -> Self {
        self.db_pool = Some(pool);
        self
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

        salvo::http::request::set_global_secure_max_size(1024 * 1024 * 1024); // 1 GB

        // TODO: HTTPS when cert is trusted
        // Generate a certificate for the web server using our CA
        let server_cert = self.ca.get_certificate_for_domain("127.0.0.1").await?;

        // Build certificate chain: server cert + CA cert (in PEM format)
        let ca_cert_pem = self.ca.get_root_certificate_pem()?;
        let cert_chain = format!("{}\n{}", server_cert.pem_cert, ca_cert_pem);
        let rustls = RustlsConfig::new(
            Keycert::new()
                .cert(cert_chain.as_bytes().to_vec())
                .key(server_cert.pem_key.as_bytes().to_vec()),
        );

        let acceptor = TcpListener::new(bind_addr).rustls(rustls).bind().await;
        // Store the actual bound address
        self.listen_addr = Some(acceptor.inner().local_addr()?);
        let mut app = Router::new()
            .hoop(ForceHttps::new().https_port(self.listen_addr.unwrap().port()))
            .hoop(affix_state::inject(state))
            .push(Router::with_path("/").get(index_page))
            .push(Router::with_path("/cert").get(download_certificate))
            .push(Router::with_path("/api/health").get(health_check))
            .push(
                Router::with_path("/api/plugins")
                    .get(list_plugins)
                    .post(upsert_plugin),
            )
            .push(Router::with_path("/api/plugins/{namespace}/{name}").delete(delete_plugin))
            // Static assets
            .push(Router::with_path("/static/{*path}").get(static_embed::<Assets>()));

        // Auth endpoints (unauthenticated)
        app = app
            .push(Router::with_path("/api/auth/register").post(auth_endpoints::register))
            .push(Router::with_path("/api/auth/login").post(auth_endpoints::login));

        // Inject auth config and db pool for auth/management endpoints
        if let Some(ref pool) = self.db_pool {
            app = app
                .hoop(affix_state::inject(pool.clone()))
                .hoop(affix_state::inject(self.config.auth.clone()));

            // Management endpoints (JWT + ACL protected)
            // Routes ordered most-specific first to avoid prefix-matching issues
            let manage_router = Router::new()
                .hoop(jwt_auth)
                .hoop(acl_check)
                // Group permissions (most specific first)
                .push(
                    Router::with_path("/api/manage/groups/{id}/permissions/{permission_id}")
                        .delete(management::remove_group_permission)
                )
                .push(
                    Router::with_path("/api/manage/groups/{id}/permissions")
                        .post(management::add_group_permission)
                )
                // Group members
                .push(
                    Router::with_path("/api/manage/groups/{id}/members")
                        .post(management::add_group_member)
                        .delete(management::remove_group_member)
                )
                // Tenant plugin config
                .push(
                    Router::with_path("/api/manage/tenants/{id}/plugins/{ns}/{name}/enabled")
                        .put(management::set_tenant_plugin_enabled)
                )
                .push(
                    Router::with_path("/api/manage/tenants/{id}/plugins/{ns}/{name}/config")
                        .put(management::set_tenant_plugin_config)
                )
                // Tenant IP mappings
                .push(
                    Router::with_path("/api/manage/tenants/{id}/ip-mappings")
                        .get(management::list_ip_mappings)
                        .post(management::add_ip_mapping)
                        .delete(management::remove_ip_mapping)
                )
                // Single resource routes
                .push(
                    Router::with_path("/api/manage/groups/{id}")
                        .delete(management::delete_group)
                )
                .push(
                    Router::with_path("/api/manage/tenants/{id}")
                        .get(management::get_tenant)
                        .put(management::update_tenant)
                        .delete(management::delete_tenant)
                )
                // Collection routes (least specific)
                .push(
                    Router::with_path("/api/manage/groups")
                        .get(management::list_groups)
                        .post(management::create_group)
                )
                .push(Router::with_path("/api/manage/tenants").get(management::list_tenants));

            app = app.push(manage_router);

        }

        // TODO: get version from Cargo.toml
        let doc = OpenApi::new("witmproxy", "0.0.1").merge_router(&app);
        let app = app
            .unshift(doc.into_router("/api/docs/openapi.json"))
            .unshift(SwaggerUi::new("/api/docs/openapi.json").into_router("/swagger"));

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
    let registry = if let Ok(state) = depot.obtain::<AppState>() {
        state.plugin_registry.clone()
    } else {
        warn!("Failed to obtain AppState in list_plugins");
        res.status_code(salvo::http::StatusCode::INTERNAL_SERVER_ERROR);
        res.render(salvo::writing::Text::Plain("Internal server error"));
        return;
    };

    // TODO: return plugin details
    if let Some(registry) = registry {
        let registry = registry.read().await;
        let plugin_names: Vec<String> = registry.plugins().keys().cloned().collect();
        res.status_code(salvo::http::StatusCode::OK);
        res.render(salvo::writing::Json(plugin_names));
    } else {
        res.status_code(salvo::http::StatusCode::OK);
        res.render(salvo::writing::Json(Vec::<String>::new()));
    }
}

#[endpoint]
async fn upsert_plugin(file: FormFile, depot: &mut Depot, res: &mut salvo::Response) {
    let registry = if let Ok(state) = depot.obtain::<AppState>() {
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

    let bytes = match fs::read(file.path()).await {
        Ok(b) => b,
        Err(e) => {
            warn!("Failed to read uploaded file: {}", e);
            res.status_code(salvo::http::StatusCode::INTERNAL_SERVER_ERROR);
            res.render(salvo::writing::Text::Plain(format!(
                "Failed to read uploaded file: {}",
                e
            )));
            return;
        }
    };

    let plugin = match registry.read().await.plugin_from_component(bytes).await {
        Ok(p) => p,
        Err(e) => {
            warn!("Failed to parse plugin: {}", e);
            res.status_code(salvo::http::StatusCode::BAD_REQUEST);
            res.render(salvo::writing::Text::Plain(format!(
                "Failed to parse plugin: {}",
                e
            )));
            return;
        }
    };
    let mut registry = registry.write().await;

    let result = registry.register_plugin(plugin).await;
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

#[endpoint]
async fn delete_plugin(
    namespace: PathParam<String>,
    name: PathParam<String>,
    depot: &mut Depot,
    res: &mut salvo::Response,
) {
    let registry = if let Ok(state) = depot.obtain::<AppState>() {
        state.plugin_registry.clone()
    } else {
        warn!("Failed to obtain AppState in delete_plugin");
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
    match registry
        .remove_plugin(&name.into_inner(), Some(&namespace.into_inner()))
        .await
    {
        Ok(removed) => {
            if removed.is_empty() {
                res.status_code(salvo::http::StatusCode::NOT_FOUND);
                res.render(salvo::writing::Text::Plain("Plugin not found"));
            } else {
                res.status_code(salvo::http::StatusCode::OK);
                res.render(salvo::writing::Text::Plain("Plugin removed successfully"));
            }
        }
        Err(e) => {
            warn!("Failed to remove plugin: {}", e);
            res.status_code(salvo::http::StatusCode::INTERNAL_SERVER_ERROR);
            res.render(salvo::writing::Text::Plain(format!(
                "Failed to remove plugin: {}",
                e
            )));
        }
    }
}
