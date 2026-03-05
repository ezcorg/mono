use salvo::handler;
use salvo::http::StatusCode;
use salvo::prelude::*;
use sqlx::SqlitePool;
use tracing::{debug, warn};

use crate::acl;
use crate::db::tenants::Tenant;

/// ACL middleware that checks if the authenticated tenant has permission
/// to access the requested resource. The resource string is injected
/// into the depot by the endpoint handler before this middleware runs,
/// or computed from the request path.
///
/// Usage: Add this handler after `jwt_auth` in the middleware chain.
/// The `tenant_id` must already be in the depot (set by jwt_auth).
#[handler]
pub async fn acl_check(
    req: &mut Request,
    depot: &mut Depot,
    res: &mut Response,
    ctrl: &mut FlowCtrl,
) {
    // If auth is disabled, skip ACL checks
    let _auth_config = match depot.obtain::<crate::config::AuthConfig>() {
        Ok(config) if config.enabled => config.clone(),
        _ => return,
    };

    let tenant_id = match depot.get::<String>("tenant_id") {
        Ok(id) => id.clone(),
        Err(_) => {
            // No tenant_id means jwt_auth didn't run or auth is disabled
            res.status_code(StatusCode::UNAUTHORIZED);
            res.render(Text::Plain("Authentication required"));
            ctrl.skip_rest();
            return;
        }
    };

    let pool = match depot.obtain::<SqlitePool>() {
        Ok(p) => p.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Database not available"));
            ctrl.skip_rest();
            return;
        }
    };

    // Load tenant and their permissions
    let tenant = match Tenant::by_id(&pool, &tenant_id).await {
        Ok(Some(t)) if t.enabled => t,
        Ok(Some(_)) => {
            res.status_code(StatusCode::FORBIDDEN);
            res.render(Text::Plain("Account disabled"));
            ctrl.skip_rest();
            return;
        }
        Ok(None) => {
            res.status_code(StatusCode::UNAUTHORIZED);
            res.render(Text::Plain("Tenant not found"));
            ctrl.skip_rest();
            return;
        }
        Err(e) => {
            warn!("Database error loading tenant: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Internal error"));
            ctrl.skip_rest();
            return;
        }
    };

    let permissions = match tenant.permissions(&pool).await {
        Ok(p) => p,
        Err(e) => {
            warn!("Failed to load permissions for tenant {}: {}", tenant_id, e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Internal error"));
            ctrl.skip_rest();
            return;
        }
    };

    // Derive resource string from the request path + method
    let resource = derive_resource_from_request(req);
    debug!(
        "ACL check: tenant={}, resource={}, permissions={}",
        tenant_id,
        resource,
        permissions.len()
    );

    if acl::evaluate(&permissions, &resource) {
        debug!("ACL granted: {} -> {}", tenant_id, resource);
        // Store permissions in depot for potential further use
        depot.insert("acl_permissions", permissions);
    } else {
        debug!("ACL denied: {} -> {}", tenant_id, resource);
        res.status_code(StatusCode::FORBIDDEN);
        res.render(Text::Plain("Insufficient permissions"));
        ctrl.skip_rest();
    }
}

/// Derive an ACL resource string from the request path and method.
/// Maps REST endpoints to colon-delimited resource patterns.
fn derive_resource_from_request(req: &Request) -> String {
    let path = req.uri().path();
    let method = req.method().as_str();

    let action = match method {
        "GET" | "HEAD" => "read",
        "POST" => "write",
        "PUT" | "PATCH" => "write",
        "DELETE" => "delete",
        _ => "read",
    };

    // Parse management API paths
    // /api/manage/tenants -> tenants:*:action
    // /api/manage/tenants/:id -> tenants:<id>:action
    // /api/manage/groups -> groups:*:action
    // /api/manage/groups/:id -> groups:<id>:action
    // /api/manage/groups/:id/members -> groups:<id>:manage
    // /api/manage/groups/:id/permissions -> groups:<id>:manage
    // /api/manage/tenants/:id/plugins/:ns/:name/... -> plugins:<ns>/<name>:configure

    let segments: Vec<&str> = path
        .trim_start_matches("/api/manage/")
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();

    match segments.as_slice() {
        ["tenants"] => format!("tenants:*:{}", action),
        ["tenants", id] => format!("tenants:{}:{}", id, action),
        ["tenants", id, "plugins", ..] => format!("tenants:{}:configure", id),
        ["tenants", id, "ip-mappings", ..] => format!("tenants:{}:configure", id),
        ["groups"] => format!("groups:*:{}", action),
        ["groups", id] => format!("groups:{}:{}", id, action),
        ["groups", id, "members"] => format!("groups:{}:manage", id),
        ["groups", id, "permissions"] => format!("groups:{}:manage", id),
        _ => format!("unknown:*:{}", action),
    }
}
