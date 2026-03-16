use crate::db::Db;
use crate::db::tenants::{Group, Tenant};
use crate::test_utils::create_ca_and_config;
use crate::wasm::Runtime;
use crate::web::WebServer;
use crate::web::auth::{Claims, create_token};
use std::sync::Arc;
use tempfile::tempdir;
use tokio::sync::RwLock;

/// Helper to create a web server with auth enabled and a DB pool.
async fn setup_auth_server() -> (reqwest::Client, String, sqlx::SqlitePool, tempfile::TempDir) {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let (ca, mut config) = create_ca_and_config().await;
    config.auth.enabled = true;
    config.auth.jwt_secret = Some("test-secret-key".to_string());
    config.auth.jwt_issuer = Some("witmproxy".to_string());

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("test.db");
    let db = Db::from_path(db_path, "test_password").await.unwrap();
    db.migrate().await.unwrap();
    let pool = db.pool.clone();

    let runtime = Runtime::try_default().unwrap();
    let plugin_registry = Arc::new(RwLock::new(
        crate::plugins::registry::PluginRegistry::new(db, runtime).unwrap(),
    ));

    let mut web_server = WebServer::new(ca, Some(plugin_registry), config);
    web_server = web_server.with_db_pool(pool.clone());
    web_server.start().await.unwrap();
    let bind_addr = web_server.listen_addr().unwrap();

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .unwrap();

    let base_url = format!("https://{}", bind_addr);

    // Leak web_server so it stays alive for the test
    std::mem::forget(web_server);

    (client, base_url, pool, temp_dir)
}

fn make_token(tenant_id: &str, secret: &str) -> String {
    let claims = Claims::new(tenant_id, Some("test@test.com"), "witmproxy", 86400);
    create_token(&claims, secret).unwrap()
}

fn make_expired_token(tenant_id: &str, secret: &str) -> String {
    let claims = Claims {
        sub: tenant_id.to_string(),
        email: Some("test@test.com".to_string()),
        iat: 1000,
        exp: 1001, // Expired long ago
        iss: "witmproxy".to_string(),
    };
    create_token(&claims, secret).unwrap()
}

// ---------------------------------------------------------------------------
// Register + Login flow
// ---------------------------------------------------------------------------

#[tokio::test]
async fn register_returns_jwt() {
    let (client, base_url, _pool, _dir) = setup_auth_server().await;

    let resp = client
        .post(format!("{}/api/auth/register", base_url))
        .json(&serde_json::json!({
            "email": "alice@test.com",
            "password": "securepassword",
            "display_name": "Alice"
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 201, "Register should return 201 Created");
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body["token"].is_string(), "Response should contain a token");
    assert!(
        body["tenant_id"].is_string(),
        "Response should contain tenant_id"
    );
}

#[tokio::test]
async fn login_with_valid_credentials() {
    let (client, base_url, _pool, _dir) = setup_auth_server().await;

    // Register first
    client
        .post(format!("{}/api/auth/register", base_url))
        .json(&serde_json::json!({
            "email": "bob@test.com",
            "password": "mypassword",
            "display_name": "Bob"
        }))
        .send()
        .await
        .unwrap();

    // Login
    let resp = client
        .post(format!("{}/api/auth/login", base_url))
        .json(&serde_json::json!({
            "email": "bob@test.com",
            "password": "mypassword"
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200, "Login should return 200");
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body["token"].is_string());
}

#[tokio::test]
async fn login_with_invalid_credentials_returns_401() {
    let (client, base_url, _pool, _dir) = setup_auth_server().await;

    // Register
    client
        .post(format!("{}/api/auth/register", base_url))
        .json(&serde_json::json!({
            "email": "charlie@test.com",
            "password": "rightpassword",
            "display_name": "Charlie"
        }))
        .send()
        .await
        .unwrap();

    // Login with wrong password
    let resp = client
        .post(format!("{}/api/auth/login", base_url))
        .json(&serde_json::json!({
            "email": "charlie@test.com",
            "password": "wrongpassword"
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 401);
}

#[tokio::test]
async fn login_nonexistent_email_returns_401() {
    let (client, base_url, _pool, _dir) = setup_auth_server().await;

    let resp = client
        .post(format!("{}/api/auth/login", base_url))
        .json(&serde_json::json!({
            "email": "nobody@test.com",
            "password": "password"
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 401);
}

#[tokio::test]
async fn register_duplicate_email_returns_409() {
    let (client, base_url, _pool, _dir) = setup_auth_server().await;

    let body = serde_json::json!({
        "email": "dup@test.com",
        "password": "password",
        "display_name": "Dup"
    });

    client
        .post(format!("{}/api/auth/register", base_url))
        .json(&body)
        .send()
        .await
        .unwrap();

    let resp = client
        .post(format!("{}/api/auth/register", base_url))
        .json(&body)
        .send()
        .await
        .unwrap();

    assert_eq!(
        resp.status(),
        409,
        "Duplicate email should return 409 Conflict"
    );
}

// ---------------------------------------------------------------------------
// JWT validation on management endpoints
// ---------------------------------------------------------------------------

#[tokio::test]
async fn management_api_without_token_returns_401() {
    let (client, base_url, _pool, _dir) = setup_auth_server().await;

    let resp = client
        .get(format!("{}/api/manage/tenants", base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 401, "No token should get 401");
}

#[tokio::test]
async fn management_api_with_malformed_token_returns_401() {
    let (client, base_url, _pool, _dir) = setup_auth_server().await;

    let resp = client
        .get(format!("{}/api/manage/tenants", base_url))
        .header("Authorization", "Bearer not-a-valid-jwt")
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 401);
}

#[tokio::test]
async fn management_api_with_expired_token_returns_401() {
    let (client, base_url, _pool, _dir) = setup_auth_server().await;

    let token = make_expired_token("some-tenant", "test-secret-key");

    let resp = client
        .get(format!("{}/api/manage/tenants", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 401);
}

#[tokio::test]
async fn management_api_with_wrong_secret_returns_401() {
    let (client, base_url, _pool, _dir) = setup_auth_server().await;

    let token = make_token("some-tenant", "wrong-secret");

    let resp = client
        .get(format!("{}/api/manage/tenants", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 401);
}

// ---------------------------------------------------------------------------
// ACL enforcement on management endpoints
// ---------------------------------------------------------------------------

#[tokio::test]
async fn management_api_with_valid_token_but_no_permissions_returns_403() {
    let (client, base_url, pool, _dir) = setup_auth_server().await;

    // Create a tenant directly in DB (no permissions)
    Tenant::create(
        &pool,
        "t-noperm",
        "NoPerms",
        Some("noperm@test.com"),
        None,
        None,
        None,
    )
    .await
    .unwrap();

    let token = make_token("t-noperm", "test-secret-key");

    let resp = client
        .get(format!("{}/api/manage/tenants", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .unwrap();

    assert_eq!(
        resp.status(),
        403,
        "Tenant without permissions should get 403"
    );
}

#[tokio::test]
async fn management_api_with_permissions_succeeds() {
    let (client, base_url, pool, _dir) = setup_auth_server().await;

    // Create tenant + group + permission
    Tenant::create(
        &pool,
        "t-admin",
        "Admin",
        Some("admin@test.com"),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    Group::create(&pool, "g-admin", "admins", "").await.unwrap();
    Group::add_member(&pool, "g-admin", "t-admin")
        .await
        .unwrap();
    Group::add_permission(&pool, "p1", "g-admin", "grant", "tenants:*:read")
        .await
        .unwrap();

    let token = make_token("t-admin", "test-secret-key");

    let resp = client
        .get(format!("{}/api/manage/tenants", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .unwrap();

    assert_eq!(
        resp.status(),
        200,
        "Tenant with read permission should succeed"
    );
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body.is_array());
}

#[tokio::test]
async fn management_api_denied_for_wrong_action() {
    let (client, base_url, pool, _dir) = setup_auth_server().await;

    // Tenant with only read permission
    Tenant::create(
        &pool,
        "t-reader",
        "Reader",
        Some("reader@test.com"),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    Group::create(&pool, "g-read", "readers", "").await.unwrap();
    Group::add_member(&pool, "g-read", "t-reader")
        .await
        .unwrap();
    Group::add_permission(&pool, "p1", "g-read", "grant", "tenants:*:read")
        .await
        .unwrap();

    let token = make_token("t-reader", "test-secret-key");

    // DELETE requires "delete" action, tenant only has "read"
    let resp = client
        .delete(format!("{}/api/manage/tenants/some-id", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .unwrap();

    assert_eq!(
        resp.status(),
        403,
        "Tenant with only read permission should be denied delete"
    );
}

// ---------------------------------------------------------------------------
// Tenant management CRUD via API
// ---------------------------------------------------------------------------

#[tokio::test]
async fn management_tenant_crud_flow() {
    let (client, base_url, pool, _dir) = setup_auth_server().await;

    // Create admin tenant with broad permissions
    Tenant::create(
        &pool,
        "t-super",
        "Super",
        Some("super@test.com"),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    Group::create(&pool, "g-super", "superadmins", "")
        .await
        .unwrap();
    Group::add_member(&pool, "g-super", "t-super")
        .await
        .unwrap();
    Group::add_permission(&pool, "p1", "g-super", "grant", "tenants:*:read")
        .await
        .unwrap();
    Group::add_permission(&pool, "p2", "g-super", "grant", "tenants:*:write")
        .await
        .unwrap();
    Group::add_permission(&pool, "p3", "g-super", "grant", "tenants:*:delete")
        .await
        .unwrap();
    Group::add_permission(&pool, "p4", "g-super", "grant", "tenants:*:configure")
        .await
        .unwrap();

    let token = make_token("t-super", "test-secret-key");

    // List tenants
    let resp = client
        .get(format!("{}/api/manage/tenants", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    // Get specific tenant
    let resp = client
        .get(format!("{}/api/manage/tenants/t-super", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .unwrap();
    let status = resp.status();
    let body_text = resp.text().await.unwrap();
    assert_eq!(
        status.as_u16(),
        200,
        "GET tenant by id failed: status={}, body={}",
        status,
        body_text
    );
    let body: serde_json::Value = serde_json::from_str(&body_text).unwrap();
    assert_eq!(body["display_name"], "Super");

    // Update tenant
    let resp = client
        .put(format!("{}/api/manage/tenants/t-super", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"display_name": "SuperAdmin"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["display_name"], "SuperAdmin");

    // Get non-existent tenant
    let resp = client
        .get(format!("{}/api/manage/tenants/nonexistent", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
}

// ---------------------------------------------------------------------------
// Group management via API
// ---------------------------------------------------------------------------

#[tokio::test]
async fn management_group_crud_flow() {
    let (client, base_url, pool, _dir) = setup_auth_server().await;

    // Create admin with group permissions
    Tenant::create(&pool, "t-ga", "GroupAdmin", None, None, None, None)
        .await
        .unwrap();
    Group::create(&pool, "g-ga", "groupadmins", "")
        .await
        .unwrap();
    Group::add_member(&pool, "g-ga", "t-ga").await.unwrap();
    Group::add_permission(&pool, "p1", "g-ga", "grant", "groups:*:read")
        .await
        .unwrap();
    Group::add_permission(&pool, "p2", "g-ga", "grant", "groups:*:write")
        .await
        .unwrap();
    Group::add_permission(&pool, "p3", "g-ga", "grant", "groups:*:delete")
        .await
        .unwrap();
    Group::add_permission(&pool, "p4", "g-ga", "grant", "groups:*:manage")
        .await
        .unwrap();

    let token = make_token("t-ga", "test-secret-key");

    // Create group via API
    let resp = client
        .post(format!("{}/api/manage/groups", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name": "testgroup", "description": "A test group"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["name"], "testgroup");
    let group_id = body["id"].as_str().unwrap().to_string();

    // List groups
    let resp = client
        .get(format!("{}/api/manage/groups", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    // Delete group
    let resp = client
        .delete(format!("{}/api/manage/groups/{}", base_url, group_id))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
}

// ---------------------------------------------------------------------------
// Health check (unauthenticated)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn health_check_no_auth_required() {
    let (client, base_url, _pool, _dir) = setup_auth_server().await;

    let resp = client
        .get(format!("{}/api/health", base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
}
