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
    // Skip ACL for CORS preflight requests
    if req.method() == salvo::http::Method::OPTIONS {
        return;
    }

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

/// Derive the resource a request is about from its path and method. A
/// typed resource, not a string: an id with a colon in it (a Tailscale
/// tenant) is one id, not three fields.
fn derive_resource_from_request(req: &Request) -> acl::Resource {
    use acl::{Action, Kind, Resource};

    let path = req.uri().path();
    let action = match req.method().as_str() {
        "GET" | "HEAD" => Action::Read,
        "POST" | "PUT" | "PATCH" => Action::Write,
        "DELETE" => Action::Delete,
        _ => Action::Read,
    };

    // Global plugin routes live outside /api/manage/. Map them to a
    // `plugins` resource instead of `Unknown`, which only an all-wildcard
    // grant reaches.
    // /api/plugins             -> plugins, the collection
    // /api/plugins/:ns/:name   -> plugins, "<ns>/<name>"
    if let Some(rest) = path.strip_prefix("/api/plugins") {
        let segs: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
        return match segs.as_slice() {
            [] => Resource::all(Kind::Plugins, action),
            [name] => Resource::new(Kind::Plugins, Some(*name), action),
            [ns, name, ..] => Resource::new(Kind::Plugins, Some(format!("{ns}/{name}")), action),
        };
    }

    // /api/manage/tenants                        -> tenants, the collection
    // /api/manage/tenants/:id                    -> tenants, id
    // /api/manage/tenants/:id/plugins/...        -> tenants, id, configure
    // /api/manage/tenants/:id/ip-mappings/...    -> tenants, id, configure
    // /api/manage/tenants/:id/policy             -> tenants, id, configure
    // /api/manage/groups                         -> groups, the collection
    // /api/manage/groups/:id                     -> groups, id
    // /api/manage/groups/:id/members|permissions -> groups, id, manage
    let segments: Vec<&str> = path
        .trim_start_matches("/api/manage/")
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();

    match segments.as_slice() {
        ["tenants"] => Resource::all(Kind::Tenants, action),
        ["tenants", id] => Resource::new(Kind::Tenants, Some(*id), action),
        ["tenants", id, "plugins", ..]
        | ["tenants", id, "ip-mappings", ..]
        | ["tenants", id, "policy"] => Resource::new(Kind::Tenants, Some(*id), Action::Configure),
        ["groups"] => Resource::all(Kind::Groups, action),
        ["groups", id] => Resource::new(Kind::Groups, Some(*id), action),
        ["groups", id, "members"] | ["groups", id, "permissions"] => {
            Resource::new(Kind::Groups, Some(*id), Action::Manage)
        }
        _ => Resource::all(Kind::Unknown, action),
    }
}
