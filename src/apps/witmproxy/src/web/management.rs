use salvo::http::StatusCode;
use salvo::oapi::extract::{JsonBody, PathParam};
use salvo::oapi::{ToSchema, endpoint};
use salvo::prelude::*;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tracing::warn;

use crate::db::tenants::{self, Group, Tenant};

// ---------------------------------------------------------------------------
// Tenant endpoints
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
struct TenantResponse {
    id: String,
    display_name: String,
    email: Option<String>,
    enabled: bool,
    created_at: Option<String>,
}

impl From<Tenant> for TenantResponse {
    fn from(t: Tenant) -> Self {
        Self {
            id: t.id,
            display_name: t.display_name,
            email: t.email,
            enabled: t.enabled,
            created_at: t.created_at,
        }
    }
}

/// GET /api/manage/tenants -- list all tenants.
#[endpoint]
pub async fn list_tenants(depot: &mut Depot, res: &mut Response) {
    let pool = match depot.obtain::<SqlitePool>() {
        Ok(p) => p.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Database not available"));
            return;
        }
    };

    match Tenant::all(&pool).await {
        Ok(tenants) => {
            let resp: Vec<TenantResponse> = tenants.into_iter().map(Into::into).collect();
            res.render(Json(resp));
        }
        Err(e) => {
            warn!("Failed to list tenants: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Internal error"));
        }
    }
}

/// GET /api/manage/tenants/:id -- get tenant by ID.
#[endpoint]
pub async fn get_tenant(id: PathParam<String>, depot: &mut Depot, res: &mut Response) {
    let pool = match depot.obtain::<SqlitePool>() {
        Ok(p) => p.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Database not available"));
            return;
        }
    };

    match Tenant::by_id(&pool, &id.into_inner()).await {
        Ok(Some(tenant)) => res.render(Json(TenantResponse::from(tenant))),
        Ok(None) => {
            res.status_code(StatusCode::NOT_FOUND);
            res.render(Text::Plain("Tenant not found"));
        }
        Err(e) => {
            warn!("Failed to get tenant: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Internal error"));
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateTenantRequest {
    pub display_name: Option<String>,
    pub enabled: Option<bool>,
}

/// PUT /api/manage/tenants/:id -- update tenant.
#[endpoint]
pub async fn update_tenant(
    id: PathParam<String>,
    body: JsonBody<UpdateTenantRequest>,
    depot: &mut Depot,
    res: &mut Response,
) {
    let pool = match depot.obtain::<SqlitePool>() {
        Ok(p) => p.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Database not available"));
            return;
        }
    };

    let body = body.into_inner();

    let tenant_id = id.into_inner();

    if let Some(enabled) = body.enabled
        && let Err(e) = Tenant::update_enabled(&pool, &tenant_id, enabled).await
    {
        warn!("Failed to update tenant: {}", e);
        res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
        res.render(Text::Plain("Internal error"));
        return;
    }

    if let Some(ref display_name) = body.display_name
        && let Err(e) = sqlx::query("UPDATE tenants SET display_name = ? WHERE id = ?")
            .bind(display_name)
            .bind(&tenant_id)
            .execute(&pool)
            .await
    {
        warn!("Failed to update tenant display_name: {}", e);
        res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
        res.render(Text::Plain("Internal error"));
        return;
    }

    match Tenant::by_id(&pool, &tenant_id).await {
        Ok(Some(tenant)) => res.render(Json(TenantResponse::from(tenant))),
        Ok(None) => {
            res.status_code(StatusCode::NOT_FOUND);
            res.render(Text::Plain("Tenant not found"));
        }
        Err(e) => {
            warn!("Failed to get tenant after update: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Internal error"));
        }
    }
}

/// DELETE /api/manage/tenants/:id -- delete tenant.
#[endpoint]
pub async fn delete_tenant(id: PathParam<String>, depot: &mut Depot, res: &mut Response) {
    let pool = match depot.obtain::<SqlitePool>() {
        Ok(p) => p.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Database not available"));
            return;
        }
    };

    match Tenant::delete(&pool, &id.into_inner()).await {
        Ok(true) => {
            res.status_code(StatusCode::OK);
            res.render(Text::Plain("Tenant deleted"));
        }
        Ok(false) => {
            res.status_code(StatusCode::NOT_FOUND);
            res.render(Text::Plain("Tenant not found"));
        }
        Err(e) => {
            warn!("Failed to delete tenant: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Internal error"));
        }
    }
}

// ---------------------------------------------------------------------------
// Group endpoints
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
struct GroupResponse {
    id: String,
    name: String,
    description: String,
}

impl From<Group> for GroupResponse {
    fn from(g: Group) -> Self {
        Self {
            id: g.id,
            name: g.name,
            description: g.description,
        }
    }
}

/// GET /api/manage/groups -- list all groups.
#[endpoint]
pub async fn list_groups(depot: &mut Depot, res: &mut Response) {
    let pool = match depot.obtain::<SqlitePool>() {
        Ok(p) => p.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Database not available"));
            return;
        }
    };

    match Group::all(&pool).await {
        Ok(groups) => {
            let resp: Vec<GroupResponse> = groups.into_iter().map(Into::into).collect();
            res.render(Json(resp));
        }
        Err(e) => {
            warn!("Failed to list groups: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Internal error"));
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateGroupRequest {
    pub name: String,
    pub description: Option<String>,
}

/// POST /api/manage/groups -- create a group.
#[endpoint]
pub async fn create_group(
    body: JsonBody<CreateGroupRequest>,
    depot: &mut Depot,
    res: &mut Response,
) {
    let pool = match depot.obtain::<SqlitePool>() {
        Ok(p) => p.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Database not available"));
            return;
        }
    };

    let body = body.into_inner();

    let group_id = uuid::Uuid::new_v4().to_string();
    let description = body.description.as_deref().unwrap_or("");

    match Group::create(&pool, &group_id, &body.name, description).await {
        Ok(group) => {
            res.status_code(StatusCode::CREATED);
            res.render(Json(GroupResponse::from(group)));
        }
        Err(e) => {
            warn!("Failed to create group: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain(format!("Failed to create group: {}", e)));
        }
    }
}

/// DELETE /api/manage/groups/:id -- delete a group.
#[endpoint]
pub async fn delete_group(id: PathParam<String>, depot: &mut Depot, res: &mut Response) {
    let pool = match depot.obtain::<SqlitePool>() {
        Ok(p) => p.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Database not available"));
            return;
        }
    };

    match Group::delete(&pool, &id.into_inner()).await {
        Ok(true) => {
            res.status_code(StatusCode::OK);
            res.render(Text::Plain("Group deleted"));
        }
        Ok(false) => {
            res.status_code(StatusCode::NOT_FOUND);
            res.render(Text::Plain("Group not found"));
        }
        Err(e) => {
            warn!("Failed to delete group: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Internal error"));
        }
    }
}

// ---------------------------------------------------------------------------
// Group membership endpoints
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, ToSchema)]
pub struct MemberRequest {
    pub tenant_id: String,
}

/// POST /api/manage/groups/:id/members -- add member to group.
#[endpoint]
pub async fn add_group_member(
    id: PathParam<String>,
    body: JsonBody<MemberRequest>,
    depot: &mut Depot,
    res: &mut Response,
) {
    let pool = match depot.obtain::<SqlitePool>() {
        Ok(p) => p.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Database not available"));
            return;
        }
    };

    let body = body.into_inner();

    match Group::add_member(&pool, &id.into_inner(), &body.tenant_id).await {
        Ok(()) => {
            res.status_code(StatusCode::OK);
            res.render(Text::Plain("Member added"));
        }
        Err(e) => {
            warn!("Failed to add group member: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain(format!("Failed: {}", e)));
        }
    }
}

/// DELETE /api/manage/groups/:id/members -- remove member from group.
#[endpoint]
pub async fn remove_group_member(
    id: PathParam<String>,
    body: JsonBody<MemberRequest>,
    depot: &mut Depot,
    res: &mut Response,
) {
    let pool = match depot.obtain::<SqlitePool>() {
        Ok(p) => p.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Database not available"));
            return;
        }
    };

    let body = body.into_inner();

    match Group::remove_member(&pool, &id.into_inner(), &body.tenant_id).await {
        Ok(()) => {
            res.status_code(StatusCode::OK);
            res.render(Text::Plain("Member removed"));
        }
        Err(e) => {
            warn!("Failed to remove group member: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain(format!("Failed: {}", e)));
        }
    }
}

// ---------------------------------------------------------------------------
// Group permissions endpoints
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, ToSchema)]
pub struct AddPermissionRequest {
    pub effect: String,
    pub resource: String,
}

/// POST /api/manage/groups/:id/permissions -- add permission to group.
#[endpoint]
pub async fn add_group_permission(
    id: PathParam<String>,
    body: JsonBody<AddPermissionRequest>,
    depot: &mut Depot,
    res: &mut Response,
) {
    let pool = match depot.obtain::<SqlitePool>() {
        Ok(p) => p.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Database not available"));
            return;
        }
    };

    let body = body.into_inner();

    // Validate effect
    if body.effect != "grant" && body.effect != "deny" {
        res.status_code(StatusCode::BAD_REQUEST);
        res.render(Text::Plain("Effect must be 'grant' or 'deny'"));
        return;
    }

    let permission_id = uuid::Uuid::new_v4().to_string();

    match Group::add_permission(
        &pool,
        &permission_id,
        &id.into_inner(),
        &body.effect,
        &body.resource,
    )
    .await
    {
        Ok(()) => {
            res.status_code(StatusCode::CREATED);
            res.render(Json(serde_json::json!({
                "id": permission_id,
                "effect": body.effect,
                "resource": body.resource,
            })));
        }
        Err(e) => {
            warn!("Failed to add permission: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain(format!("Failed: {}", e)));
        }
    }
}

/// DELETE /api/manage/groups/:id/permissions/:permission_id -- remove permission.
#[endpoint]
pub async fn remove_group_permission(
    id: PathParam<String>,
    permission_id: PathParam<String>,
    depot: &mut Depot,
    res: &mut Response,
) {
    let pool = match depot.obtain::<SqlitePool>() {
        Ok(p) => p.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Database not available"));
            return;
        }
    };

    let _ = id.into_inner(); // group_id for ACL context (already checked by middleware)

    match Group::remove_permission(&pool, &permission_id.into_inner()).await {
        Ok(true) => {
            res.status_code(StatusCode::OK);
            res.render(Text::Plain("Permission removed"));
        }
        Ok(false) => {
            res.status_code(StatusCode::NOT_FOUND);
            res.render(Text::Plain("Permission not found"));
        }
        Err(e) => {
            warn!("Failed to remove permission: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Internal error"));
        }
    }
}

// ---------------------------------------------------------------------------
// Tenant plugin configuration endpoints
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetPluginEnabledRequest {
    pub enabled: bool,
}

/// PUT /api/manage/tenants/:id/plugins/:ns/:name/enabled -- set per-tenant plugin enabled state.
#[endpoint]
pub async fn set_tenant_plugin_enabled(
    id: PathParam<String>,
    ns: PathParam<String>,
    name: PathParam<String>,
    body: JsonBody<SetPluginEnabledRequest>,
    depot: &mut Depot,
    res: &mut Response,
) {
    let pool = match depot.obtain::<SqlitePool>() {
        Ok(p) => p.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Database not available"));
            return;
        }
    };

    let body = body.into_inner();

    match tenants::set_plugin_override(
        &pool,
        &id.into_inner(),
        &ns.into_inner(),
        &name.into_inner(),
        Some(body.enabled),
    )
    .await
    {
        Ok(()) => {
            res.status_code(StatusCode::OK);
            res.render(Text::Plain("Plugin override set"));
        }
        Err(e) => {
            warn!("Failed to set plugin override: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain(format!("Failed: {}", e)));
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetPluginConfigRequest {
    pub config: std::collections::HashMap<String, String>,
}

/// PUT /api/manage/tenants/:id/plugins/:ns/:name/config -- set per-tenant plugin config.
#[endpoint]
pub async fn set_tenant_plugin_config(
    id: PathParam<String>,
    ns: PathParam<String>,
    name: PathParam<String>,
    body: JsonBody<SetPluginConfigRequest>,
    depot: &mut Depot,
    res: &mut Response,
) {
    let pool = match depot.obtain::<SqlitePool>() {
        Ok(p) => p.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Database not available"));
            return;
        }
    };

    let body = body.into_inner();

    let tenant_id = id.into_inner();
    let namespace = ns.into_inner();
    let plugin_name = name.into_inner();

    for (input_name, input_value) in &body.config {
        if let Err(e) = tenants::set_plugin_config(
            &pool,
            &tenant_id,
            &namespace,
            &plugin_name,
            input_name,
            input_value,
        )
        .await
        {
            warn!("Failed to set plugin config: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain(format!("Failed: {}", e)));
            return;
        }
    }

    res.status_code(StatusCode::OK);
    res.render(Text::Plain("Plugin config updated"));
}

// ---------------------------------------------------------------------------
// Tenant IP mapping endpoints
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, ToSchema)]
pub struct IpMappingRequest {
    pub ip_address: String,
}

/// GET /api/manage/tenants/:id/ip-mappings -- list IP mappings for a tenant.
#[endpoint]
pub async fn list_ip_mappings(id: PathParam<String>, depot: &mut Depot, res: &mut Response) {
    let pool = match depot.obtain::<SqlitePool>() {
        Ok(p) => p.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Database not available"));
            return;
        }
    };

    let tenant_id = id.into_inner();
    match Tenant::by_id(&pool, &tenant_id).await {
        Ok(Some(tenant)) => match tenant.ip_mappings(&pool).await {
            Ok(mappings) => {
                let ips: Vec<&str> = mappings.iter().map(|m| m.ip_address.as_str()).collect();
                res.render(Json(ips));
            }
            Err(e) => {
                warn!("Failed to list IP mappings: {}", e);
                res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
                res.render(Text::Plain("Internal error"));
            }
        },
        Ok(None) => {
            res.status_code(StatusCode::NOT_FOUND);
            res.render(Text::Plain("Tenant not found"));
        }
        Err(e) => {
            warn!("Failed to get tenant: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Internal error"));
        }
    }
}

/// POST /api/manage/tenants/:id/ip-mappings -- add IP mapping.
#[endpoint]
pub async fn add_ip_mapping(
    id: PathParam<String>,
    body: JsonBody<IpMappingRequest>,
    depot: &mut Depot,
    res: &mut Response,
) {
    let pool = match depot.obtain::<SqlitePool>() {
        Ok(p) => p.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Database not available"));
            return;
        }
    };

    let body = body.into_inner();

    match tenants::add_ip_mapping(&pool, &id.into_inner(), &body.ip_address).await {
        Ok(()) => {
            res.status_code(StatusCode::CREATED);
            res.render(Text::Plain("IP mapping added"));
        }
        Err(e) => {
            warn!("Failed to add IP mapping: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain(format!("Failed: {}", e)));
        }
    }
}

/// DELETE /api/manage/tenants/:id/ip-mappings -- remove IP mapping.
#[endpoint]
pub async fn remove_ip_mapping(
    id: PathParam<String>,
    body: JsonBody<IpMappingRequest>,
    depot: &mut Depot,
    res: &mut Response,
) {
    let pool = match depot.obtain::<SqlitePool>() {
        Ok(p) => p.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Database not available"));
            return;
        }
    };

    let body = body.into_inner();

    match tenants::remove_ip_mapping(&pool, &id.into_inner(), &body.ip_address).await {
        Ok(()) => {
            res.status_code(StatusCode::OK);
            res.render(Text::Plain("IP mapping removed"));
        }
        Err(e) => {
            warn!("Failed to remove IP mapping: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain(format!("Failed: {}", e)));
        }
    }
}

// ---------------------------------------------------------------------------
// Configuration endpoints
// ---------------------------------------------------------------------------

/// Subset of AppConfig fields that are safe to expose and modify at runtime.
/// Excludes sensitive fields (db_password, jwt_secret, admin_password) and
/// fields that require a restart to take effect (bind addresses, cert paths).
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct RuntimeConfig {
    pub plugins_enabled: bool,
    pub plugins_timeout_ms: u64,
    pub plugins_max_memory_mb: u64,
    pub plugins_max_fuel: u64,
    pub auto_update: bool,
    pub transparent_enabled: bool,
}

impl RuntimeConfig {
    fn from_app_config(config: &crate::config::AppConfig) -> Self {
        Self {
            plugins_enabled: config.plugins.enabled,
            plugins_timeout_ms: config.plugins.timeout_ms,
            plugins_max_memory_mb: config.plugins.max_memory_mb,
            plugins_max_fuel: config.plugins.max_fuel,
            auto_update: config.update.auto_update,
            transparent_enabled: config.transparent.enabled,
        }
    }

    fn apply_to(&self, config: &mut crate::config::AppConfig) {
        config.plugins.enabled = self.plugins_enabled;
        config.plugins.timeout_ms = self.plugins_timeout_ms;
        config.plugins.max_memory_mb = self.plugins_max_memory_mb;
        config.plugins.max_fuel = self.plugins_max_fuel;
        config.update.auto_update = self.auto_update;
        config.transparent.enabled = self.transparent_enabled;
    }
}

/// GET /api/manage/config -- get current runtime configuration.
#[endpoint]
pub async fn get_config(depot: &mut Depot, res: &mut Response) {
    let config = match depot.obtain::<crate::config::AppConfig>() {
        Ok(c) => c.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Config not available"));
            return;
        }
    };

    res.render(Json(RuntimeConfig::from_app_config(&config)));
}

/// PUT /api/manage/config -- update runtime configuration and persist to disk.
#[endpoint]
pub async fn update_config(body: JsonBody<RuntimeConfig>, depot: &mut Depot, res: &mut Response) {
    let mut config = match depot.obtain::<crate::config::AppConfig>() {
        Ok(c) => c.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Config not available"));
            return;
        }
    };

    let config_path = match depot.obtain::<ConfigPath>() {
        Ok(p) => p.0.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Config path not available"));
            return;
        }
    };

    let updates = body.into_inner();
    updates.apply_to(&mut config);

    if let Err(e) = config.save(&config_path) {
        warn!("Failed to save config: {}", e);
        res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
        res.render(Text::Plain(format!("Failed to save config: {}", e)));
        return;
    }

    res.render(Json(RuntimeConfig::from_app_config(&config)));
}

/// Newtype for injecting the config file path via depot
#[derive(Clone)]
pub struct ConfigPath(pub std::path::PathBuf);
