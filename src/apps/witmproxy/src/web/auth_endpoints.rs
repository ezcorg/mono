use salvo::http::StatusCode;
use salvo::oapi::endpoint;
use salvo::prelude::*;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tracing::warn;

use crate::config::AuthConfig;
use crate::db::tenants::Tenant;
use crate::web::auth::{Claims, create_token, hash_password, verify_password};

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
    pub display_name: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub tenant_id: String,
}

/// POST /api/auth/register -- create a new tenant with email/password, return JWT.
#[endpoint]
pub async fn register(req: &mut Request, depot: &mut Depot, res: &mut Response) {
    let pool = match depot.obtain::<SqlitePool>() {
        Ok(p) => p.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Database not available"));
            return;
        }
    };

    let auth_config = match depot.obtain::<AuthConfig>() {
        Ok(c) => c.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Auth config not available"));
            return;
        }
    };

    let body: RegisterRequest = match req.parse_json().await {
        Ok(b) => b,
        Err(e) => {
            res.status_code(StatusCode::BAD_REQUEST);
            res.render(Text::Plain(format!("Invalid request body: {}", e)));
            return;
        }
    };

    // Check if email already exists
    if let Ok(Some(_)) = Tenant::by_email(&pool, &body.email).await {
        res.status_code(StatusCode::CONFLICT);
        res.render(Text::Plain("Email already registered"));
        return;
    }

    // Hash password
    let password_hash = match hash_password(&body.password) {
        Ok(h) => h,
        Err(e) => {
            warn!("Password hashing failed: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Internal error"));
            return;
        }
    };

    let tenant_id = uuid::Uuid::new_v4().to_string();

    match Tenant::create(
        &pool,
        &tenant_id,
        &body.display_name,
        Some(&body.email),
        Some(&password_hash),
        None,
        None,
    )
    .await
    {
        Ok(_tenant) => {
            let secret = auth_config
                .jwt_secret
                .as_deref()
                .unwrap_or("default-secret");
            let issuer = auth_config
                .jwt_issuer
                .as_deref()
                .unwrap_or("witmproxy");
            let claims = Claims::new(&tenant_id, Some(&body.email), issuer, 86400);

            match create_token(&claims, secret) {
                Ok(token) => {
                    res.status_code(StatusCode::CREATED);
                    res.render(Json(AuthResponse {
                        token,
                        tenant_id,
                    }));
                }
                Err(e) => {
                    warn!("Token creation failed: {}", e);
                    res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
                    res.render(Text::Plain("Failed to create token"));
                }
            }
        }
        Err(e) => {
            warn!("Tenant creation failed: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain(format!("Failed to create tenant: {}", e)));
        }
    }
}

/// POST /api/auth/login -- authenticate with email/password, return JWT.
#[endpoint]
pub async fn login(req: &mut Request, depot: &mut Depot, res: &mut Response) {
    let pool = match depot.obtain::<SqlitePool>() {
        Ok(p) => p.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Database not available"));
            return;
        }
    };

    let auth_config = match depot.obtain::<AuthConfig>() {
        Ok(c) => c.clone(),
        Err(_) => {
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Auth config not available"));
            return;
        }
    };

    let body: LoginRequest = match req.parse_json().await {
        Ok(b) => b,
        Err(e) => {
            res.status_code(StatusCode::BAD_REQUEST);
            res.render(Text::Plain(format!("Invalid request body: {}", e)));
            return;
        }
    };

    let tenant = match Tenant::by_email(&pool, &body.email).await {
        Ok(Some(t)) => t,
        Ok(None) => {
            res.status_code(StatusCode::UNAUTHORIZED);
            res.render(Text::Plain("Invalid credentials"));
            return;
        }
        Err(e) => {
            warn!("Database error during login: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Internal error"));
            return;
        }
    };

    if !tenant.enabled {
        res.status_code(StatusCode::FORBIDDEN);
        res.render(Text::Plain("Account disabled"));
        return;
    }

    let password_hash = match &tenant.password_hash {
        Some(h) => h,
        None => {
            res.status_code(StatusCode::UNAUTHORIZED);
            res.render(Text::Plain("Invalid credentials"));
            return;
        }
    };

    match verify_password(&body.password, password_hash) {
        Ok(true) => {
            let secret = auth_config
                .jwt_secret
                .as_deref()
                .unwrap_or("default-secret");
            let issuer = auth_config
                .jwt_issuer
                .as_deref()
                .unwrap_or("witmproxy");
            let claims = Claims::new(&tenant.id, tenant.email.as_deref(), issuer, 86400);

            match create_token(&claims, secret) {
                Ok(token) => {
                    res.status_code(StatusCode::OK);
                    res.render(Json(AuthResponse {
                        token,
                        tenant_id: tenant.id,
                    }));
                }
                Err(e) => {
                    warn!("Token creation failed: {}", e);
                    res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
                    res.render(Text::Plain("Failed to create token"));
                }
            }
        }
        Ok(false) => {
            res.status_code(StatusCode::UNAUTHORIZED);
            res.render(Text::Plain("Invalid credentials"));
        }
        Err(e) => {
            warn!("Password verification error: {}", e);
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Internal error"));
        }
    }
}
