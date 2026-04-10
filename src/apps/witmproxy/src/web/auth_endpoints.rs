use salvo::http::{StatusCode, StatusError};
use salvo::oapi::extract::JsonBody;
use salvo::oapi::{ToSchema, endpoint};
use salvo::prelude::*;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tracing::warn;

use crate::config::AuthConfig;
use crate::db::tenants::Tenant;
use crate::web::auth::{Claims, create_token, hash_password, verify_password};

#[derive(Debug, Deserialize, ToSchema)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
    pub display_name: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AuthResponse {
    pub token: String,
    pub tenant_id: String,
}

/// POST /api/auth/register -- create a new tenant with email/password, return JWT.
#[endpoint(status_codes(200, 201, 400, 500))]
pub async fn register(
    body: JsonBody<RegisterRequest>,
    depot: &mut Depot,
    res: &mut Response,
) -> Result<Json<AuthResponse>, StatusError> {
    let pool = depot
        .obtain::<SqlitePool>()
        .cloned()
        .map_err(|_| StatusError::internal_server_error().brief("Database not available"))?;

    let auth_config = depot
        .obtain::<AuthConfig>()
        .cloned()
        .map_err(|_| StatusError::internal_server_error().brief("Auth config not available"))?;

    let body = body.into_inner();

    // Check if email already exists
    if let Ok(Some(_)) = Tenant::by_email(&pool, &body.email).await {
        return Err(StatusError::from_code(StatusCode::CONFLICT)
            .unwrap_or_else(StatusError::internal_server_error)
            .brief("Email already registered"));
    }

    let password_hash = hash_password(&body.password).map_err(|e| {
        warn!("Password hashing failed: {}", e);
        StatusError::internal_server_error().brief("Internal error")
    })?;

    let tenant_id = uuid::Uuid::new_v4().to_string();

    Tenant::create(
        &pool,
        &tenant_id,
        &body.display_name,
        Some(&body.email),
        Some(&password_hash),
        None,
        None,
    )
    .await
    .map_err(|e| {
        warn!("Tenant creation failed: {}", e);
        StatusError::internal_server_error().brief(format!("Failed to create tenant: {}", e))
    })?;

    let secret = auth_config
        .jwt_secret
        .as_deref()
        .unwrap_or("default-secret");
    let issuer = auth_config.jwt_issuer.as_deref().unwrap_or("witmproxy");
    let claims = Claims::new(&tenant_id, Some(&body.email), issuer, 86400);

    let token = create_token(&claims, secret).map_err(|e| {
        warn!("Token creation failed: {}", e);
        StatusError::internal_server_error().brief("Failed to create token")
    })?;

    res.status_code(StatusCode::CREATED);
    Ok(Json(AuthResponse { token, tenant_id }))
}

/// POST /api/auth/login -- authenticate with email/password, return JWT.
#[endpoint(status_codes(200, 400, 401, 403, 500))]
pub async fn login(
    body: JsonBody<LoginRequest>,
    depot: &mut Depot,
) -> Result<Json<AuthResponse>, StatusError> {
    let pool = depot
        .obtain::<SqlitePool>()
        .cloned()
        .map_err(|_| StatusError::internal_server_error().brief("Database not available"))?;

    let auth_config = depot
        .obtain::<AuthConfig>()
        .cloned()
        .map_err(|_| StatusError::internal_server_error().brief("Auth config not available"))?;

    let body = body.into_inner();

    let tenant = match Tenant::by_email(&pool, &body.email).await {
        Ok(Some(t)) => t,
        Ok(None) => {
            return Err(StatusError::unauthorized().brief("Invalid credentials"));
        }
        Err(e) => {
            warn!("Database error during login: {}", e);
            return Err(StatusError::internal_server_error().brief("Internal error"));
        }
    };

    if !tenant.enabled {
        return Err(StatusError::forbidden().brief("Account disabled"));
    }

    let password_hash = tenant
        .password_hash
        .as_deref()
        .ok_or_else(|| StatusError::unauthorized().brief("Invalid credentials"))?;

    match verify_password(&body.password, password_hash) {
        Ok(true) => {
            let secret = auth_config
                .jwt_secret
                .as_deref()
                .unwrap_or("default-secret");
            let issuer = auth_config.jwt_issuer.as_deref().unwrap_or("witmproxy");
            let claims = Claims::new(&tenant.id, tenant.email.as_deref(), issuer, 86400);

            let token = create_token(&claims, secret).map_err(|e| {
                warn!("Token creation failed: {}", e);
                StatusError::internal_server_error().brief("Failed to create token")
            })?;

            Ok(Json(AuthResponse {
                token,
                tenant_id: tenant.id,
            }))
        }
        Ok(false) => Err(StatusError::unauthorized().brief("Invalid credentials")),
        Err(e) => {
            warn!("Password verification error: {}", e);
            Err(StatusError::internal_server_error().brief("Internal error"))
        }
    }
}
