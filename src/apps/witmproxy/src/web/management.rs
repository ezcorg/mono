use salvo::http::{StatusCode, StatusError};
use salvo::oapi::extract::{JsonBody, PathParam};
use salvo::oapi::{ToSchema, endpoint};
use salvo::prelude::*;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tracing::warn;

use crate::db::tenants::{self, Group, Tenant};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn db(depot: &mut Depot) -> Result<SqlitePool, StatusError> {
    depot
        .obtain::<SqlitePool>()
        .cloned()
        .map_err(|_| StatusError::internal_server_error().brief("Database not available"))
}

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
#[endpoint(security(("bearer" = [])), status_codes(200, 401, 403, 500))]
pub async fn list_tenants(depot: &mut Depot) -> Result<Json<Vec<TenantResponse>>, StatusError> {
    let pool = db(depot)?;
    let tenants = Tenant::all(&pool).await.map_err(|e| {
        warn!("Failed to list tenants: {}", e);
        StatusError::internal_server_error().brief("Internal error")
    })?;
    Ok(Json(tenants.into_iter().map(Into::into).collect()))
}

/// GET /api/manage/tenants/:id -- get tenant by ID.
#[endpoint(security(("bearer" = [])), status_codes(200, 201, 400, 401, 403, 404, 500))]
pub async fn get_tenant(
    id: PathParam<String>,
    depot: &mut Depot,
) -> Result<Json<TenantResponse>, StatusError> {
    let pool = db(depot)?;
    match Tenant::by_id(&pool, &id.into_inner()).await {
        Ok(Some(tenant)) => Ok(Json(TenantResponse::from(tenant))),
        Ok(None) => Err(StatusError::not_found().brief("Tenant not found")),
        Err(e) => {
            warn!("Failed to get tenant: {}", e);
            Err(StatusError::internal_server_error().brief("Internal error"))
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateTenantRequest {
    pub display_name: Option<String>,
    pub enabled: Option<bool>,
}

/// PUT /api/manage/tenants/:id -- update tenant.
#[endpoint(security(("bearer" = [])), status_codes(200, 201, 400, 401, 403, 404, 500))]
pub async fn update_tenant(
    id: PathParam<String>,
    body: JsonBody<UpdateTenantRequest>,
    depot: &mut Depot,
) -> Result<Json<TenantResponse>, StatusError> {
    let pool = db(depot)?;
    let body = body.into_inner();
    let tenant_id = id.into_inner();

    if let Some(enabled) = body.enabled
        && let Err(e) = Tenant::update_enabled(&pool, &tenant_id, enabled).await
    {
        warn!("Failed to update tenant: {}", e);
        return Err(StatusError::internal_server_error().brief("Internal error"));
    }

    if let Some(ref display_name) = body.display_name
        && let Err(e) = sqlx::query("UPDATE tenants SET display_name = ? WHERE id = ?")
            .bind(display_name)
            .bind(&tenant_id)
            .execute(&pool)
            .await
    {
        warn!("Failed to update tenant display_name: {}", e);
        return Err(StatusError::internal_server_error().brief("Internal error"));
    }

    match Tenant::by_id(&pool, &tenant_id).await {
        Ok(Some(tenant)) => Ok(Json(TenantResponse::from(tenant))),
        Ok(None) => Err(StatusError::not_found().brief("Tenant not found")),
        Err(e) => {
            warn!("Failed to get tenant after update: {}", e);
            Err(StatusError::internal_server_error().brief("Internal error"))
        }
    }
}

/// DELETE /api/manage/tenants/:id -- delete tenant.
#[endpoint(security(("bearer" = [])), status_codes(200, 201, 400, 401, 403, 404, 500))]
pub async fn delete_tenant(
    id: PathParam<String>,
    depot: &mut Depot,
    res: &mut Response,
) -> Result<&'static str, StatusError> {
    let pool = db(depot)?;
    match Tenant::delete(&pool, &id.into_inner()).await {
        Ok(true) => {
            res.status_code(StatusCode::OK);
            Ok("Tenant deleted")
        }
        Ok(false) => Err(StatusError::not_found().brief("Tenant not found")),
        Err(e) => {
            warn!("Failed to delete tenant: {}", e);
            Err(StatusError::internal_server_error().brief("Internal error"))
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
#[endpoint(security(("bearer" = [])), status_codes(200, 201, 400, 401, 403, 404, 500))]
pub async fn list_groups(depot: &mut Depot) -> Result<Json<Vec<GroupResponse>>, StatusError> {
    let pool = db(depot)?;
    let groups = Group::all(&pool).await.map_err(|e| {
        warn!("Failed to list groups: {}", e);
        StatusError::internal_server_error().brief("Internal error")
    })?;
    Ok(Json(groups.into_iter().map(Into::into).collect()))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateGroupRequest {
    pub name: String,
    pub description: Option<String>,
}

/// POST /api/manage/groups -- create a group.
#[endpoint(security(("bearer" = [])), status_codes(200, 201, 400, 401, 403, 404, 500))]
pub async fn create_group(
    body: JsonBody<CreateGroupRequest>,
    depot: &mut Depot,
    res: &mut Response,
) -> Result<Json<GroupResponse>, StatusError> {
    let pool = db(depot)?;
    let body = body.into_inner();
    let group_id = uuid::Uuid::new_v4().to_string();
    let description = body.description.as_deref().unwrap_or("");

    match Group::create(&pool, &group_id, &body.name, description).await {
        Ok(group) => {
            res.status_code(StatusCode::CREATED);
            Ok(Json(GroupResponse::from(group)))
        }
        Err(e) => {
            warn!("Failed to create group: {}", e);
            Err(StatusError::internal_server_error()
                .brief(format!("Failed to create group: {}", e)))
        }
    }
}

/// DELETE /api/manage/groups/:id -- delete a group.
#[endpoint(security(("bearer" = [])), status_codes(200, 201, 400, 401, 403, 404, 500))]
pub async fn delete_group(
    id: PathParam<String>,
    depot: &mut Depot,
) -> Result<&'static str, StatusError> {
    let pool = db(depot)?;
    match Group::delete(&pool, &id.into_inner()).await {
        Ok(true) => Ok("Group deleted"),
        Ok(false) => Err(StatusError::not_found().brief("Group not found")),
        Err(e) => {
            warn!("Failed to delete group: {}", e);
            Err(StatusError::internal_server_error().brief("Internal error"))
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
#[endpoint(security(("bearer" = [])), status_codes(200, 201, 400, 401, 403, 404, 500))]
pub async fn add_group_member(
    id: PathParam<String>,
    body: JsonBody<MemberRequest>,
    depot: &mut Depot,
) -> Result<&'static str, StatusError> {
    let pool = db(depot)?;
    let body = body.into_inner();
    Group::add_member(&pool, &id.into_inner(), &body.tenant_id)
        .await
        .map_err(|e| {
            warn!("Failed to add group member: {}", e);
            StatusError::internal_server_error().brief(format!("Failed: {}", e))
        })?;
    Ok("Member added")
}

/// DELETE /api/manage/groups/:id/members -- remove member from group.
#[endpoint(security(("bearer" = [])), status_codes(200, 201, 400, 401, 403, 404, 500))]
pub async fn remove_group_member(
    id: PathParam<String>,
    body: JsonBody<MemberRequest>,
    depot: &mut Depot,
) -> Result<&'static str, StatusError> {
    let pool = db(depot)?;
    let body = body.into_inner();
    Group::remove_member(&pool, &id.into_inner(), &body.tenant_id)
        .await
        .map_err(|e| {
            warn!("Failed to remove group member: {}", e);
            StatusError::internal_server_error().brief(format!("Failed: {}", e))
        })?;
    Ok("Member removed")
}

// ---------------------------------------------------------------------------
// Group permissions endpoints
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, ToSchema)]
pub struct AddPermissionRequest {
    pub effect: String,
    pub resource: String,
}

#[derive(Debug, Serialize, ToSchema)]
struct PermissionResponse {
    id: String,
    effect: String,
    resource: String,
}

/// POST /api/manage/groups/:id/permissions -- add permission to group.
#[endpoint(security(("bearer" = [])), status_codes(200, 201, 400, 401, 403, 404, 500))]
pub async fn add_group_permission(
    id: PathParam<String>,
    body: JsonBody<AddPermissionRequest>,
    depot: &mut Depot,
    res: &mut Response,
) -> Result<Json<PermissionResponse>, StatusError> {
    let pool = db(depot)?;
    let body = body.into_inner();

    if body.effect != "grant" && body.effect != "deny" {
        return Err(StatusError::bad_request().brief("Effect must be 'grant' or 'deny'"));
    }

    let permission_id = uuid::Uuid::new_v4().to_string();

    Group::add_permission(
        &pool,
        &permission_id,
        &id.into_inner(),
        &body.effect,
        &body.resource,
    )
    .await
    .map_err(|e| {
        warn!("Failed to add permission: {}", e);
        StatusError::internal_server_error().brief(format!("Failed: {}", e))
    })?;

    res.status_code(StatusCode::CREATED);
    Ok(Json(PermissionResponse {
        id: permission_id,
        effect: body.effect,
        resource: body.resource,
    }))
}

/// DELETE /api/manage/groups/:id/permissions/:permission_id -- remove permission.
#[endpoint(security(("bearer" = [])), status_codes(200, 201, 400, 401, 403, 404, 500))]
pub async fn remove_group_permission(
    id: PathParam<String>,
    permission_id: PathParam<String>,
    depot: &mut Depot,
) -> Result<&'static str, StatusError> {
    let pool = db(depot)?;
    let _ = id.into_inner(); // group_id for ACL context (already checked by middleware)

    match Group::remove_permission(&pool, &permission_id.into_inner()).await {
        Ok(true) => Ok("Permission removed"),
        Ok(false) => Err(StatusError::not_found().brief("Permission not found")),
        Err(e) => {
            warn!("Failed to remove permission: {}", e);
            Err(StatusError::internal_server_error().brief("Internal error"))
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
#[endpoint(security(("bearer" = [])), status_codes(200, 201, 400, 401, 403, 404, 500))]
pub async fn set_tenant_plugin_enabled(
    id: PathParam<String>,
    ns: PathParam<String>,
    name: PathParam<String>,
    body: JsonBody<SetPluginEnabledRequest>,
    depot: &mut Depot,
) -> Result<&'static str, StatusError> {
    let pool = db(depot)?;
    let body = body.into_inner();

    tenants::set_plugin_override(
        &pool,
        &id.into_inner(),
        &ns.into_inner(),
        &name.into_inner(),
        Some(body.enabled),
    )
    .await
    .map_err(|e| {
        warn!("Failed to set plugin override: {}", e);
        StatusError::internal_server_error().brief(format!("Failed: {}", e))
    })?;

    Ok("Plugin override set")
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetPluginConfigRequest {
    pub config: std::collections::HashMap<String, String>,
}

/// PUT /api/manage/tenants/:id/plugins/:ns/:name/config -- set per-tenant plugin config.
#[endpoint(security(("bearer" = [])), status_codes(200, 201, 400, 401, 403, 404, 500))]
pub async fn set_tenant_plugin_config(
    id: PathParam<String>,
    ns: PathParam<String>,
    name: PathParam<String>,
    body: JsonBody<SetPluginConfigRequest>,
    depot: &mut Depot,
) -> Result<&'static str, StatusError> {
    let pool = db(depot)?;
    let body = body.into_inner();
    let tenant_id = id.into_inner();
    let namespace = ns.into_inner();
    let plugin_name = name.into_inner();

    for (input_name, input_value) in &body.config {
        tenants::set_plugin_config(
            &pool,
            &tenant_id,
            &namespace,
            &plugin_name,
            input_name,
            input_value,
        )
        .await
        .map_err(|e| {
            warn!("Failed to set plugin config: {}", e);
            StatusError::internal_server_error().brief(format!("Failed: {}", e))
        })?;
    }

    Ok("Plugin config updated")
}

// ---------------------------------------------------------------------------
// Tenant IP mapping endpoints
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, ToSchema)]
pub struct IpMappingRequest {
    pub ip_address: String,
}

/// GET /api/manage/tenants/:id/ip-mappings -- list IP mappings for a tenant.
#[endpoint(security(("bearer" = [])), status_codes(200, 201, 400, 401, 403, 404, 500))]
pub async fn list_ip_mappings(
    id: PathParam<String>,
    depot: &mut Depot,
) -> Result<Json<Vec<String>>, StatusError> {
    let pool = db(depot)?;
    let tenant_id = id.into_inner();

    let tenant = Tenant::by_id(&pool, &tenant_id)
        .await
        .map_err(|e| {
            warn!("Failed to get tenant: {}", e);
            StatusError::internal_server_error().brief("Internal error")
        })?
        .ok_or_else(|| StatusError::not_found().brief("Tenant not found"))?;

    let mappings = tenant.ip_mappings(&pool).await.map_err(|e| {
        warn!("Failed to list IP mappings: {}", e);
        StatusError::internal_server_error().brief("Internal error")
    })?;

    Ok(Json(
        mappings.iter().map(|m| m.ip_address.clone()).collect(),
    ))
}

/// POST /api/manage/tenants/:id/ip-mappings -- add IP mapping.
#[endpoint(security(("bearer" = [])), status_codes(200, 201, 400, 401, 403, 404, 500))]
pub async fn add_ip_mapping(
    id: PathParam<String>,
    body: JsonBody<IpMappingRequest>,
    depot: &mut Depot,
    res: &mut Response,
) -> Result<&'static str, StatusError> {
    let pool = db(depot)?;
    let body = body.into_inner();

    tenants::add_ip_mapping(&pool, &id.into_inner(), &body.ip_address)
        .await
        .map_err(|e| {
            warn!("Failed to add IP mapping: {}", e);
            StatusError::internal_server_error().brief(format!("Failed: {}", e))
        })?;

    res.status_code(StatusCode::CREATED);
    Ok("IP mapping added")
}

/// DELETE /api/manage/tenants/:id/ip-mappings -- remove IP mapping.
#[endpoint(security(("bearer" = [])), status_codes(200, 201, 400, 401, 403, 404, 500))]
pub async fn remove_ip_mapping(
    id: PathParam<String>,
    body: JsonBody<IpMappingRequest>,
    depot: &mut Depot,
) -> Result<&'static str, StatusError> {
    let pool = db(depot)?;
    let body = body.into_inner();

    tenants::remove_ip_mapping(&pool, &id.into_inner(), &body.ip_address)
        .await
        .map_err(|e| {
            warn!("Failed to remove IP mapping: {}", e);
            StatusError::internal_server_error().brief(format!("Failed: {}", e))
        })?;

    Ok("IP mapping removed")
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
#[endpoint(security(("bearer" = [])), status_codes(200, 201, 400, 401, 403, 404, 500))]
pub async fn get_config(depot: &mut Depot) -> Result<Json<RuntimeConfig>, StatusError> {
    let config = depot
        .obtain::<crate::config::AppConfig>()
        .cloned()
        .map_err(|_| StatusError::internal_server_error().brief("Config not available"))?;

    Ok(Json(RuntimeConfig::from_app_config(&config)))
}

/// PUT /api/manage/config -- update runtime configuration and persist to disk.
#[endpoint(security(("bearer" = [])), status_codes(200, 201, 400, 401, 403, 404, 500))]
pub async fn update_config(
    body: JsonBody<RuntimeConfig>,
    depot: &mut Depot,
) -> Result<Json<RuntimeConfig>, StatusError> {
    let mut config = depot
        .obtain::<crate::config::AppConfig>()
        .cloned()
        .map_err(|_| StatusError::internal_server_error().brief("Config not available"))?;

    let config_path = depot
        .obtain::<ConfigPath>()
        .map(|p| p.0.clone())
        .map_err(|_| StatusError::internal_server_error().brief("Config path not available"))?;

    let updates = body.into_inner();
    updates.apply_to(&mut config);

    config.save(&config_path).map_err(|e| {
        warn!("Failed to save config: {}", e);
        StatusError::internal_server_error().brief(format!("Failed to save config: {}", e))
    })?;

    Ok(Json(RuntimeConfig::from_app_config(&config)))
}

/// Newtype for injecting the config file path via depot
#[derive(Clone)]
pub struct ConfigPath(pub std::path::PathBuf);
