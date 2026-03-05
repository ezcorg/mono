use crate::db::Db;
use crate::db::tenants::*;

async fn setup_db() -> (Db, tempfile::TempDir) {
    let temp_dir = tempfile::tempdir().unwrap();
    let db_path = temp_dir.path().join("test.db");
    let db = Db::from_path(db_path, "test_password").await.unwrap();
    db.migrate().await.unwrap();
    (db, temp_dir)
}

/// Insert a dummy plugin row so FK constraints on tenant_plugin_* tables are satisfied.
async fn insert_dummy_plugin(pool: &sqlx::SqlitePool, namespace: &str, name: &str) {
    sqlx::query(
        "INSERT INTO plugins (namespace, name, version, author, description, license, url, publickey, enabled, component)
         VALUES (?, ?, '0.0.1', 'test', 'test plugin', 'MIT', '', X'00', 1, X'00')",
    )
    .bind(namespace)
    .bind(name)
    .execute(pool)
    .await
    .unwrap();
}

// ---------------------------------------------------------------------------
// Tenant CRUD
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_and_retrieve_tenant() {
    let (db, _dir) = setup_db().await;
    let pool = &db.pool;

    let tenant = Tenant::create(pool, "t1", "Alice", Some("alice@test.com"), None, None, None)
        .await
        .unwrap();
    assert_eq!(tenant.id, "t1");
    assert_eq!(tenant.display_name, "Alice");
    assert_eq!(tenant.email.as_deref(), Some("alice@test.com"));
    assert!(tenant.enabled);
}

#[tokio::test]
async fn tenant_by_email() {
    let (db, _dir) = setup_db().await;
    let pool = &db.pool;

    Tenant::create(pool, "t1", "Alice", Some("alice@test.com"), None, None, None)
        .await
        .unwrap();

    let found = Tenant::by_email(pool, "alice@test.com").await.unwrap();
    assert!(found.is_some());
    assert_eq!(found.unwrap().id, "t1");

    let not_found = Tenant::by_email(pool, "nobody@test.com").await.unwrap();
    assert!(not_found.is_none());
}

#[tokio::test]
async fn tenant_update_enabled() {
    let (db, _dir) = setup_db().await;
    let pool = &db.pool;

    Tenant::create(pool, "t1", "Alice", None, None, None, None)
        .await
        .unwrap();

    Tenant::update_enabled(pool, "t1", false).await.unwrap();
    let tenant = Tenant::by_id(pool, "t1").await.unwrap().unwrap();
    assert!(!tenant.enabled);

    Tenant::update_enabled(pool, "t1", true).await.unwrap();
    let tenant = Tenant::by_id(pool, "t1").await.unwrap().unwrap();
    assert!(tenant.enabled);
}

#[tokio::test]
async fn tenant_delete() {
    let (db, _dir) = setup_db().await;
    let pool = &db.pool;

    Tenant::create(pool, "t1", "Alice", None, None, None, None)
        .await
        .unwrap();

    let deleted = Tenant::delete(pool, "t1").await.unwrap();
    assert!(deleted);

    let not_found = Tenant::by_id(pool, "t1").await.unwrap();
    assert!(not_found.is_none());

    // Delete non-existent returns false
    let deleted = Tenant::delete(pool, "t1").await.unwrap();
    assert!(!deleted);
}

#[tokio::test]
async fn tenant_all() {
    let (db, _dir) = setup_db().await;
    let pool = &db.pool;

    Tenant::create(pool, "t1", "Alice", None, None, None, None)
        .await
        .unwrap();
    Tenant::create(pool, "t2", "Bob", None, None, None, None)
        .await
        .unwrap();

    let all = Tenant::all(pool).await.unwrap();
    assert_eq!(all.len(), 2);
}

// ---------------------------------------------------------------------------
// Group CRUD & Membership
// ---------------------------------------------------------------------------

#[tokio::test]
async fn group_create_and_retrieve() {
    let (db, _dir) = setup_db().await;
    let pool = &db.pool;

    let group = Group::create(pool, "g1", "admins", "Administrator group")
        .await
        .unwrap();
    assert_eq!(group.id, "g1");
    assert_eq!(group.name, "admins");

    let found = Group::by_name(pool, "admins").await.unwrap();
    assert!(found.is_some());
}

#[tokio::test]
async fn group_membership() {
    let (db, _dir) = setup_db().await;
    let pool = &db.pool;

    Tenant::create(pool, "t1", "Alice", None, None, None, None)
        .await
        .unwrap();
    Tenant::create(pool, "t2", "Bob", None, None, None, None)
        .await
        .unwrap();
    Group::create(pool, "g1", "admins", "").await.unwrap();

    // Add members
    Group::add_member(pool, "g1", "t1").await.unwrap();
    Group::add_member(pool, "g1", "t2").await.unwrap();

    // Verify tenant groups
    let t1 = Tenant::by_id(pool, "t1").await.unwrap().unwrap();
    let groups = t1.groups(pool).await.unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].name, "admins");

    // Remove member
    Group::remove_member(pool, "g1", "t2").await.unwrap();
    let t2 = Tenant::by_id(pool, "t2").await.unwrap().unwrap();
    let groups = t2.groups(pool).await.unwrap();
    assert_eq!(groups.len(), 0);
}

#[tokio::test]
async fn group_delete_cascades_membership() {
    let (db, _dir) = setup_db().await;
    let pool = &db.pool;

    Tenant::create(pool, "t1", "Alice", None, None, None, None)
        .await
        .unwrap();
    Group::create(pool, "g1", "admins", "").await.unwrap();
    Group::add_member(pool, "g1", "t1").await.unwrap();

    Group::delete(pool, "g1").await.unwrap();

    let t1 = Tenant::by_id(pool, "t1").await.unwrap().unwrap();
    let groups = t1.groups(pool).await.unwrap();
    assert_eq!(groups.len(), 0);
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tenant_permissions_aggregated_from_groups() {
    let (db, _dir) = setup_db().await;
    let pool = &db.pool;

    Tenant::create(pool, "t1", "Alice", None, None, None, None)
        .await
        .unwrap();
    Group::create(pool, "g1", "readers", "").await.unwrap();
    Group::create(pool, "g2", "writers", "").await.unwrap();

    Group::add_member(pool, "g1", "t1").await.unwrap();
    Group::add_member(pool, "g2", "t1").await.unwrap();

    Group::add_permission(pool, "p1", "g1", "grant", "tenants:*:read")
        .await
        .unwrap();
    Group::add_permission(pool, "p2", "g2", "grant", "tenants:*:write")
        .await
        .unwrap();

    let t1 = Tenant::by_id(pool, "t1").await.unwrap().unwrap();
    let permissions = t1.permissions(pool).await.unwrap();
    assert_eq!(permissions.len(), 2, "Should have permissions from both groups");
}

#[tokio::test]
async fn group_permissions_crud() {
    let (db, _dir) = setup_db().await;
    let pool = &db.pool;

    Group::create(pool, "g1", "admins", "").await.unwrap();

    Group::add_permission(pool, "p1", "g1", "grant", "tenants:*:read")
        .await
        .unwrap();
    Group::add_permission(pool, "p2", "g1", "deny", "tenants:secret:read")
        .await
        .unwrap();

    let perms = Group::permissions(pool, "g1").await.unwrap();
    assert_eq!(perms.len(), 2);

    // Remove one
    let removed = Group::remove_permission(pool, "p1").await.unwrap();
    assert!(removed);

    let perms = Group::permissions(pool, "g1").await.unwrap();
    assert_eq!(perms.len(), 1);
}

// ---------------------------------------------------------------------------
// IP Mappings
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ip_mapping_crud() {
    let (db, _dir) = setup_db().await;
    let pool = &db.pool;

    Tenant::create(pool, "t1", "Alice", None, None, None, None)
        .await
        .unwrap();

    add_ip_mapping(pool, "t1", "192.168.1.100").await.unwrap();
    add_ip_mapping(pool, "t1", "192.168.1.101").await.unwrap();

    let t1 = Tenant::by_id(pool, "t1").await.unwrap().unwrap();
    let mappings = t1.ip_mappings(pool).await.unwrap();
    assert_eq!(mappings.len(), 2);

    // Lookup by IP
    let found = tenant_by_ip(pool, "192.168.1.100").await.unwrap();
    assert!(found.is_some());
    assert_eq!(found.unwrap().id, "t1");

    // Unmapped IP
    let not_found = tenant_by_ip(pool, "10.0.0.1").await.unwrap();
    assert!(not_found.is_none());

    // Remove mapping
    remove_ip_mapping(pool, "t1", "192.168.1.100").await.unwrap();
    let mappings = t1.ip_mappings(pool).await.unwrap();
    assert_eq!(mappings.len(), 1);
}

#[tokio::test]
async fn tenant_by_ip_lookup() {
    let (db, _dir) = setup_db().await;
    let pool = &db.pool;

    Tenant::create(pool, "t1", "Alice", None, None, None, None)
        .await
        .unwrap();
    Tenant::create(pool, "t2", "Bob", None, None, None, None)
        .await
        .unwrap();

    add_ip_mapping(pool, "t1", "10.0.0.1").await.unwrap();
    add_ip_mapping(pool, "t2", "10.0.0.2").await.unwrap();

    let found1 = Tenant::by_ip(pool, "10.0.0.1").await.unwrap().unwrap();
    assert_eq!(found1.id, "t1");

    let found2 = Tenant::by_ip(pool, "10.0.0.2").await.unwrap().unwrap();
    assert_eq!(found2.id, "t2");
}

// ---------------------------------------------------------------------------
// Plugin Overrides & Config
// ---------------------------------------------------------------------------

#[tokio::test]
async fn plugin_override_set_and_retrieve() {
    let (db, _dir) = setup_db().await;
    let pool = &db.pool;

    Tenant::create(pool, "t1", "Alice", None, None, None, None)
        .await
        .unwrap();
    insert_dummy_plugin(pool, "ns", "myplugin").await;

    set_plugin_override(pool, "t1", "ns", "myplugin", Some(false))
        .await
        .unwrap();

    let t1 = Tenant::by_id(pool, "t1").await.unwrap().unwrap();
    let overrides = t1.plugin_overrides(pool).await.unwrap();
    assert_eq!(overrides.len(), 1);
    assert_eq!(overrides[0].plugin_namespace, "ns");
    assert_eq!(overrides[0].plugin_name, "myplugin");
    assert_eq!(overrides[0].enabled, Some(false));
}

#[tokio::test]
async fn plugin_config_set_and_retrieve() {
    let (db, _dir) = setup_db().await;
    let pool = &db.pool;

    Tenant::create(pool, "t1", "Alice", None, None, None, None)
        .await
        .unwrap();
    insert_dummy_plugin(pool, "ns", "myplugin").await;

    set_plugin_config(pool, "t1", "ns", "myplugin", "threshold", "42")
        .await
        .unwrap();
    set_plugin_config(pool, "t1", "ns", "myplugin", "mode", "\"strict\"")
        .await
        .unwrap();

    let t1 = Tenant::by_id(pool, "t1").await.unwrap().unwrap();
    let config = t1.plugin_config(pool).await.unwrap();
    assert_eq!(config.len(), 2);

    let threshold = config.iter().find(|c| c.input_name == "threshold").unwrap();
    assert_eq!(threshold.input_value, "42");
}

#[tokio::test]
async fn plugin_override_upsert() {
    let (db, _dir) = setup_db().await;
    let pool = &db.pool;

    Tenant::create(pool, "t1", "Alice", None, None, None, None)
        .await
        .unwrap();
    insert_dummy_plugin(pool, "ns", "myplugin").await;

    // Set to false
    set_plugin_override(pool, "t1", "ns", "myplugin", Some(false))
        .await
        .unwrap();

    // Update to true (upsert)
    set_plugin_override(pool, "t1", "ns", "myplugin", Some(true))
        .await
        .unwrap();

    let t1 = Tenant::by_id(pool, "t1").await.unwrap().unwrap();
    let overrides = t1.plugin_overrides(pool).await.unwrap();
    assert_eq!(overrides.len(), 1);
    assert_eq!(overrides[0].enabled, Some(true));
}

// ---------------------------------------------------------------------------
// ACL integration (permissions evaluated via acl::evaluate)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn acl_evaluate_with_db_permissions() {
    use crate::acl;

    let (db, _dir) = setup_db().await;
    let pool = &db.pool;

    Tenant::create(pool, "t1", "Alice", None, None, None, None)
        .await
        .unwrap();
    Group::create(pool, "g1", "readers", "").await.unwrap();
    Group::add_member(pool, "g1", "t1").await.unwrap();
    Group::add_permission(pool, "p1", "g1", "grant", "tenants:*:read")
        .await
        .unwrap();

    let t1 = Tenant::by_id(pool, "t1").await.unwrap().unwrap();
    let permissions = t1.permissions(pool).await.unwrap();

    // Should be granted read access
    assert!(acl::evaluate(&permissions, "tenants:123:read"));
    // Should be denied write access (no grant)
    assert!(!acl::evaluate(&permissions, "tenants:123:write"));
}

#[tokio::test]
async fn acl_deny_overrides_grant_at_same_specificity() {
    use crate::acl;

    let (db, _dir) = setup_db().await;
    let pool = &db.pool;

    Tenant::create(pool, "t1", "Alice", None, None, None, None)
        .await
        .unwrap();
    Group::create(pool, "g1", "mixed", "").await.unwrap();
    Group::add_member(pool, "g1", "t1").await.unwrap();

    // Grant and deny at same specificity
    Group::add_permission(pool, "p1", "g1", "grant", "tenants:*:read")
        .await
        .unwrap();
    Group::add_permission(pool, "p2", "g1", "deny", "tenants:*:read")
        .await
        .unwrap();

    let t1 = Tenant::by_id(pool, "t1").await.unwrap().unwrap();
    let permissions = t1.permissions(pool).await.unwrap();

    // Deny wins at equal specificity
    assert!(!acl::evaluate(&permissions, "tenants:123:read"));
}

#[tokio::test]
async fn acl_more_specific_grant_overrides_less_specific_deny() {
    use crate::acl;

    let (db, _dir) = setup_db().await;
    let pool = &db.pool;

    Tenant::create(pool, "t1", "Alice", None, None, None, None)
        .await
        .unwrap();
    Group::create(pool, "g1", "mixed", "").await.unwrap();
    Group::add_member(pool, "g1", "t1").await.unwrap();

    // Deny all tenants read, but grant specific tenant read
    Group::add_permission(pool, "p1", "g1", "deny", "tenants:*:read")
        .await
        .unwrap();
    Group::add_permission(pool, "p2", "g1", "grant", "tenants:123:read")
        .await
        .unwrap();

    let t1 = Tenant::by_id(pool, "t1").await.unwrap().unwrap();
    let permissions = t1.permissions(pool).await.unwrap();

    // More specific grant wins
    assert!(acl::evaluate(&permissions, "tenants:123:read"));
    // Other tenants still denied
    assert!(!acl::evaluate(&permissions, "tenants:456:read"));
}

#[tokio::test]
async fn tenant_delete_cascades_ip_mappings() {
    let (db, _dir) = setup_db().await;
    let pool = &db.pool;

    Tenant::create(pool, "t1", "Alice", None, None, None, None)
        .await
        .unwrap();
    add_ip_mapping(pool, "t1", "10.0.0.1").await.unwrap();

    Tenant::delete(pool, "t1").await.unwrap();

    // IP mapping should be gone
    let found = tenant_by_ip(pool, "10.0.0.1").await.unwrap();
    assert!(found.is_none());
}
