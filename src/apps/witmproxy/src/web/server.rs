use super::{AppState, download_certificate, index_page};
use crate::cert::CertificateAuthority;
use crate::config::AppConfig;
use crate::plugins::registry::PluginRegistry;
use crate::web::{acl_middleware::acl_check, auth::jwt_auth, auth_endpoints, management};
use anyhow::Result;
use rust_embed::RustEmbed;
use salvo::Writer;
use salvo::conn::rustls::{Keycert, RustlsConfig};
use salvo::cors::{AllowHeaders, AllowMethods, AllowOrigin, Cors};
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
    config_path: Option<std::path::PathBuf>,
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
            config_path: None,
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

    /// Set the config file path so the management API can persist changes.
    pub fn with_config_path(mut self, path: std::path::PathBuf) -> Self {
        self.config_path = Some(path);
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

        // Build TLS config: use user-provided cert/key if available,
        // otherwise generate one from our CA (e.g. for localhost dev).
        // User-provided certs are useful with `tailscale cert` which
        // produces publicly-trusted certs for your Tailscale hostname.
        let rustls = if let (Some(cert_path), Some(key_path)) = (
            &self.config.web.web_tls_cert_path,
            &self.config.web.web_tls_key_path,
        ) {
            let cert_pem = std::fs::read(cert_path)
                .map_err(|e| anyhow::anyhow!("Failed to read TLS cert {:?}: {}", cert_path, e))?;
            let key_pem = std::fs::read(key_path)
                .map_err(|e| anyhow::anyhow!("Failed to read TLS key {:?}: {}", key_path, e))?;
            RustlsConfig::new(Keycert::new().cert(cert_pem).key(key_pem))
        } else {
            let server_cert = self.ca.get_certificate_for_domain("127.0.0.1").await?;
            let ca_cert_pem = self.ca.get_root_certificate_pem()?;
            let cert_chain = format!("{}\n{}", server_cert.pem_cert, ca_cert_pem);
            RustlsConfig::new(
                Keycert::new()
                    .cert(cert_chain.as_bytes().to_vec())
                    .key(server_cert.pem_key.as_bytes().to_vec()),
            )
        };

        let acceptor = TcpListener::new(bind_addr).rustls(rustls).bind().await;
        // Store the actual bound address
        self.listen_addr = Some(acceptor.inner().local_addr()?);
        let cors = Cors::new()
            .allow_origin(AllowOrigin::any())
            .allow_methods(AllowMethods::any())
            .allow_headers(AllowHeaders::any())
            .into_handler();

        let mut app = Router::new()
            .hoop(ForceHttps::new().https_port(self.listen_addr.unwrap().port()))
            .hoop(cors)
            .hoop(affix_state::inject(state))
            .push(Router::with_path("/").get(index_page))
            .push(Router::with_path("/cert").get(download_certificate))
            .push(
                Router::with_path("/api/health")
                    .get(health_check)
                    .options(preflight),
            )
            // Static assets
            .push(Router::with_path("/static/{*path}").get(static_embed::<Assets>()));

        // Inject db pool and auth config for auth + management endpoints
        if let Some(ref pool) = self.db_pool {
            app = app
                .hoop(affix_state::inject(pool.clone()))
                .hoop(affix_state::inject(self.config.auth.clone()))
                .hoop(affix_state::inject(self.config.clone()))
                .hoop(affix_state::inject(management::ConfigPath(
                    self.config_path.clone().unwrap_or_default(),
                )));

            // Auth endpoints (unauthenticated, but need db pool + auth config)
            app = app
                .push(
                    Router::with_path("/api/auth/register")
                        .post(auth_endpoints::register)
                        .options(preflight),
                )
                .push(
                    Router::with_path("/api/auth/login")
                        .post(auth_endpoints::login)
                        .options(preflight),
                );

            // Management endpoints (JWT + ACL protected)
            // Routes ordered most-specific first to avoid prefix-matching issues
            let manage_router = Router::new()
                .hoop(jwt_auth)
                .hoop(acl_check)
                .push(
                    Router::with_path("/api/manage/groups/{id}/permissions/{permission_id}")
                        .delete(management::remove_group_permission)
                        .options(preflight),
                )
                .push(
                    Router::with_path("/api/manage/groups/{id}/permissions")
                        .get(management::list_group_permissions)
                        .post(management::add_group_permission)
                        .options(preflight),
                )
                .push(
                    Router::with_path("/api/manage/groups/{id}/members")
                        .get(management::list_group_members)
                        .post(management::add_group_member)
                        .delete(management::remove_group_member)
                        .options(preflight),
                )
                .push(
                    Router::with_path("/api/manage/tenants/{id}/plugins/{ns}/{name}/enabled")
                        .put(management::set_tenant_plugin_enabled)
                        .options(preflight),
                )
                .push(
                    Router::with_path("/api/manage/tenants/{id}/plugins/{ns}/{name}/config")
                        .put(management::set_tenant_plugin_config)
                        .options(preflight),
                )
                .push(
                    Router::with_path("/api/manage/tenants/{id}/ip-mappings")
                        .get(management::list_ip_mappings)
                        .post(management::add_ip_mapping)
                        .delete(management::remove_ip_mapping)
                        .options(preflight),
                )
                .push(
                    Router::with_path("/api/manage/groups/{id}")
                        .delete(management::delete_group)
                        .options(preflight),
                )
                .push(
                    Router::with_path("/api/manage/tenants/{id}")
                        .get(management::get_tenant)
                        .put(management::update_tenant)
                        .delete(management::delete_tenant)
                        .options(preflight),
                )
                .push(
                    Router::with_path("/api/manage/groups")
                        .get(management::list_groups)
                        .post(management::create_group)
                        .options(preflight),
                )
                .push(
                    Router::with_path("/api/manage/tenants")
                        .get(management::list_tenants)
                        .options(preflight),
                )
                .push(
                    Router::with_path("/api/manage/config")
                        .get(management::get_config)
                        .put(management::update_config)
                        .options(preflight),
                )
                .push(
                    Router::with_path("/api/plugins")
                        .get(list_plugins)
                        .post(upsert_plugin)
                        .options(preflight),
                )
                .push(
                    Router::with_path("/api/plugins/{namespace}/{name}/enabled")
                        .put(set_plugin_enabled)
                        .options(preflight),
                )
                .push(
                    Router::with_path("/api/plugins/{namespace}/{name}")
                        .delete(delete_plugin)
                        .options(preflight),
                );

            app = app.push(manage_router);
        }

        let doc = OpenApi::new("witmproxy", env!("CARGO_PKG_VERSION"))
            .merge_router(&app)
            .add_security_scheme(
                "bearer",
                salvo::oapi::security::SecurityScheme::Http(
                    salvo::oapi::security::Http::new(salvo::oapi::security::HttpAuthScheme::Bearer)
                        .bearer_format("JWT")
                        .description(
                            "JWT token obtained from /api/auth/login or /api/auth/register",
                        ),
                ),
            );
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

/// Responds to CORS preflight OPTIONS requests with 204 No Content.
/// The CORS hoop adds the Access-Control-Allow-* headers automatically.
#[endpoint]
async fn preflight(res: &mut salvo::Response) {
    res.status_code(salvo::http::StatusCode::NO_CONTENT);
}

#[endpoint(status_codes(200))]
async fn health_check() -> &'static str {
    "OK"
}

// Plugin management endpoints

#[derive(serde::Serialize)]
struct PluginSummary {
    namespace: String,
    name: String,
    version: String,
    author: String,
    description: String,
    license: String,
    url: String,
    enabled: bool,
    capabilities: Vec<PluginCapSummary>,
}

#[derive(serde::Serialize)]
struct PluginCapSummary {
    kind: String,
    scope: String,
    granted: bool,
}

#[endpoint(security(("bearer" = [])), status_codes(200, 401, 403, 500))]
async fn list_plugins(depot: &mut Depot, res: &mut salvo::Response) {
    let registry = if let Ok(state) = depot.obtain::<AppState>() {
        state.plugin_registry.clone()
    } else {
        warn!("Failed to obtain AppState in list_plugins");
        res.status_code(salvo::http::StatusCode::INTERNAL_SERVER_ERROR);
        res.render(salvo::writing::Text::Plain("Internal server error"));
        return;
    };

    if let Some(registry) = registry {
        let registry = registry.read().await;
        let plugins: Vec<PluginSummary> = registry
            .plugins()
            .values()
            .map(|p| PluginSummary {
                namespace: p.namespace.clone(),
                name: p.name.clone(),
                version: p.version.clone(),
                author: p.author.clone(),
                description: p.description.clone(),
                license: p.license.clone(),
                url: p.url.clone(),
                enabled: p.enabled,
                capabilities: p
                    .capabilities
                    .iter()
                    .map(|c| PluginCapSummary {
                        kind: c.inner.kind.to_string(),
                        scope: c.inner.scope.expression.clone(),
                        granted: c.granted,
                    })
                    .collect(),
            })
            .collect();
        res.status_code(salvo::http::StatusCode::OK);
        res.render(salvo::writing::Json(plugins));
    } else {
        res.status_code(salvo::http::StatusCode::OK);
        res.render(salvo::writing::Json(Vec::<PluginSummary>::new()));
    }
}

#[endpoint(security(("bearer" = [])), status_codes(200, 400, 401, 403, 500))]
async fn upsert_plugin(
    file: FormFile,
    req: &mut salvo::Request,
    depot: &mut Depot,
    res: &mut salvo::Response,
) {
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

    // Extract optional expected public key from header (hex-encoded)
    let expected_key = req
        .headers()
        .get("X-Expected-Public-Key")
        .and_then(|v| v.to_str().ok())
        .and_then(|hex_str| hex::decode(hex_str).ok());

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

    let plugin = match registry
        .read()
        .await
        .plugin_from_component_with_key(bytes, expected_key.as_deref())
        .await
    {
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

#[endpoint(security(("bearer" = [])), status_codes(200, 401, 403, 404, 500))]
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

#[derive(serde::Deserialize, salvo::oapi::ToSchema)]
struct SetPluginEnabledBody {
    enabled: bool,
}

/// PUT /api/plugins/{namespace}/{name}/enabled -- toggle global plugin enabled state.
#[endpoint(security(("bearer" = [])), status_codes(200, 400, 401, 403, 404, 500))]
async fn set_plugin_enabled(
    namespace: PathParam<String>,
    name: PathParam<String>,
    body: salvo::oapi::extract::JsonBody<SetPluginEnabledBody>,
    depot: &mut Depot,
) -> Result<&'static str, salvo::http::StatusError> {
    let registry = depot
        .obtain::<AppState>()
        .map(|s| s.plugin_registry.clone())
        .map_err(|_| {
            salvo::http::StatusError::internal_server_error().brief("Internal server error")
        })?;

    let registry = registry.ok_or_else(|| {
        salvo::http::StatusError::bad_request().brief("Plugin system is disabled")
    })?;

    let ns = namespace.into_inner();
    let plugin_name = name.into_inner();
    let enabled = body.into_inner().enabled;

    let mut reg = registry.write().await;
    let plugin_id = format!("{}/{}", ns, plugin_name);
    if let Some(plugin) = reg.plugins_mut().get_mut(&plugin_id) {
        plugin.enabled = enabled;
        Ok(if enabled {
            "Plugin enabled"
        } else {
            "Plugin disabled"
        })
    } else {
        Err(salvo::http::StatusError::not_found().brief("Plugin not found"))
    }
}
