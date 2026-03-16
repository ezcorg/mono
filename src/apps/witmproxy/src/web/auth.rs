use jsonwebtoken::{DecodingKey, EncodingKey, Header, TokenData, Validation, decode, encode};
use salvo::handler;
use salvo::http::StatusCode;
use salvo::prelude::*;
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

use crate::config::AuthConfig;

/// JWT claims for witmproxy management tokens.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    /// Subject: the tenant ID
    pub sub: String,
    /// Email (optional)
    pub email: Option<String>,
    /// Issued at (Unix timestamp)
    pub iat: u64,
    /// Expiration (Unix timestamp)
    pub exp: u64,
    /// Issuer
    pub iss: String,
}

impl Claims {
    pub fn new(tenant_id: &str, email: Option<&str>, issuer: &str, duration_secs: u64) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        Self {
            sub: tenant_id.to_string(),
            email: email.map(|e| e.to_string()),
            iat: now,
            exp: now + duration_secs,
            iss: issuer.to_string(),
        }
    }
}

/// Create a signed JWT from claims using a local secret.
pub fn create_token(claims: &Claims, secret: &str) -> Result<String, jsonwebtoken::errors::Error> {
    encode(
        &Header::default(),
        claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
}

/// Validate and decode a JWT using a local secret.
pub fn decode_token(
    token: &str,
    secret: &str,
    issuer: Option<&str>,
    audience: Option<&str>,
) -> Result<TokenData<Claims>, jsonwebtoken::errors::Error> {
    let mut validation = Validation::default();
    if let Some(iss) = issuer {
        validation.set_issuer(&[iss]);
    }
    if let Some(aud) = audience {
        validation.set_audience(&[aud]);
    }
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
}

/// Salvo handler/middleware that extracts and validates JWT from Authorization header.
/// On success, injects `tenant_id` (String) and `Claims` into the depot.
#[handler]
pub async fn jwt_auth(
    req: &mut Request,
    depot: &mut Depot,
    res: &mut Response,
    ctrl: &mut FlowCtrl,
) {
    let auth_config = match depot.obtain::<AuthConfig>() {
        Ok(config) => config.clone(),
        Err(_) => {
            warn!("AuthConfig not found in depot");
            res.status_code(StatusCode::INTERNAL_SERVER_ERROR);
            res.render(Text::Plain("Server configuration error"));
            ctrl.skip_rest();
            return;
        }
    };

    if !auth_config.enabled {
        // Auth disabled: allow all requests through without authentication
        return;
    }

    let token = match extract_bearer_token(req) {
        Some(t) => t,
        None => {
            res.status_code(StatusCode::UNAUTHORIZED);
            res.render(Text::Plain("Missing or invalid Authorization header"));
            ctrl.skip_rest();
            return;
        }
    };

    // Try local secret first
    if let Some(ref secret) = auth_config.jwt_secret {
        match decode_token(
            &token,
            secret,
            auth_config.jwt_issuer.as_deref(),
            auth_config.jwt_audience.as_deref(),
        ) {
            Ok(token_data) => {
                debug!("JWT validated for tenant: {}", token_data.claims.sub);
                depot.insert("tenant_id", token_data.claims.sub.clone());
                depot.insert("claims", token_data.claims);
                return;
            }
            Err(e) => {
                debug!("Local JWT validation failed: {}", e);
                // Fall through to JWKS if configured
            }
        }
    }

    // TODO: JWKS validation for external OIDC providers
    // if let Some(ref _jwks_url) = auth_config.jwks_url { ... }

    res.status_code(StatusCode::UNAUTHORIZED);
    res.render(Text::Plain("Invalid or expired token"));
    ctrl.skip_rest();
}

fn extract_bearer_token(req: &Request) -> Option<String> {
    let header = req.headers().get("authorization")?;
    let value = header.to_str().ok()?;
    if value.starts_with("Bearer ") || value.starts_with("bearer ") {
        Some(value[7..].trim().to_string())
    } else {
        None
    }
}

/// Hash a password using argon2.
pub fn hash_password(password: &str) -> Result<String, argon2::password_hash::Error> {
    use argon2::password_hash::SaltString;
    use argon2::password_hash::rand_core::OsRng;
    use argon2::{Argon2, PasswordHasher};

    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2.hash_password(password.as_bytes(), &salt)?;
    Ok(hash.to_string())
}

/// Verify a password against an argon2 hash.
pub fn verify_password(password: &str, hash: &str) -> Result<bool, argon2::password_hash::Error> {
    use argon2::password_hash::PasswordHash;
    use argon2::{Argon2, PasswordVerifier};

    let parsed_hash = PasswordHash::new(hash)?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok())
}
