//! Tenant-specific functionality and dynamic server update tests.
//!
//! These tests verify that:
//! - Tenant plugin overrides (enable/disable) take effect
//! - Dynamic plugin registration / removal is observed by clients
//! - Per-tenant configuration resolves correctly

use anyhow::Result;
use witmproxy_test::{EchoResponse, Protocol, TestEnv};

// ---------------------------------------------------------------------------
// Tenant plugin overrides
// ---------------------------------------------------------------------------

#[tokio::test]
async fn effective_plugins_includes_globally_enabled() -> Result<()> {
    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    env.create_tenant("t1", "Test Tenant 1").await?;
    let effective = env.effective_plugins_for_tenant("t1").await?;

    // With no overrides, the tenant should inherit all globally-enabled plugins
    assert!(
        !effective.is_empty(),
        "Tenant should inherit globally enabled plugins"
    );

    env.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn tenant_override_disables_plugin() -> Result<()> {
    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    env.create_tenant("t2", "Disabled Test").await?;
    env.set_tenant_plugin_override("t2", "ezco", "wasm-test-component", Some(false))
        .await?;

    let effective = env.effective_plugins_for_tenant("t2").await?;
    assert!(
        !effective.contains("ezco/wasm-test-component"),
        "Plugin disabled by tenant override should not be effective"
    );

    env.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn tenant_override_reenable_plugin() -> Result<()> {
    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    env.create_tenant("t3", "Re-enable Test").await?;

    // Disable then re-enable
    env.set_tenant_plugin_override("t3", "ezco", "wasm-test-component", Some(false))
        .await?;
    let eff = env.effective_plugins_for_tenant("t3").await?;
    assert!(!eff.contains("ezco/wasm-test-component"));

    env.set_tenant_plugin_override("t3", "ezco", "wasm-test-component", Some(true))
        .await?;
    let eff = env.effective_plugins_for_tenant("t3").await?;
    assert!(
        eff.contains("ezco/wasm-test-component"),
        "Re-enabled plugin should be effective"
    );

    env.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn two_tenants_different_overrides() -> Result<()> {
    let env = TestEnv::start().await?;
    env.register_test_component().await?;
    env.register_noop_plugin().await?;

    env.create_tenant("alice", "Alice").await?;
    env.create_tenant("bob", "Bob").await?;

    // Alice disables the test component
    env.set_tenant_plugin_override("alice", "ezco", "wasm-test-component", Some(false))
        .await?;
    // Bob disables noop
    env.set_tenant_plugin_override("bob", "witmproxy", "noop", Some(false))
        .await?;

    let alice_eff = env.effective_plugins_for_tenant("alice").await?;
    let bob_eff = env.effective_plugins_for_tenant("bob").await?;

    assert!(
        !alice_eff.contains("ezco/wasm-test-component"),
        "Alice should NOT have test-component"
    );
    assert!(
        alice_eff.contains("witmproxy/noop"),
        "Alice should still have noop"
    );

    assert!(
        bob_eff.contains("ezco/wasm-test-component"),
        "Bob should still have test-component"
    );
    assert!(
        !bob_eff.contains("witmproxy/noop"),
        "Bob should NOT have noop"
    );

    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tenant IP mapping
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tenant_ip_mapping_roundtrip() -> Result<()> {
    let env = TestEnv::start().await?;
    env.create_tenant("ip-tenant", "IP Mapped Tenant").await?;
    env.set_tenant_ip("ip-tenant", "10.0.0.42").await?;

    let db = env.db_pool().await;
    let tenant = witmproxy_test::tenants::tenant_by_ip(&db.pool, "10.0.0.42").await?;
    assert!(
        tenant.is_some_and(|t| t.id == "ip-tenant"),
        "Should resolve tenant by mapped IP"
    );

    env.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn tenant_multiple_ip_mappings() -> Result<()> {
    let env = TestEnv::start().await?;
    env.create_tenant("multi-ip", "Multi IP Tenant").await?;
    env.set_tenant_ip("multi-ip", "10.0.0.1").await?;
    env.set_tenant_ip("multi-ip", "10.0.0.2").await?;

    let db = env.db_pool().await;
    let t1 = witmproxy_test::tenants::tenant_by_ip(&db.pool, "10.0.0.1").await?;
    let t2 = witmproxy_test::tenants::tenant_by_ip(&db.pool, "10.0.0.2").await?;

    assert!(t1.is_some_and(|t| t.id == "multi-ip"));
    assert!(t2.is_some_and(|t| t.id == "multi-ip"));

    env.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn unmapped_ip_returns_none() -> Result<()> {
    let env = TestEnv::start().await?;
    let db = env.db_pool().await;
    let tenant = witmproxy_test::tenants::tenant_by_ip(&db.pool, "192.168.99.99").await?;
    assert!(tenant.is_none(), "Unmapped IP should return no tenant");
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Dynamic plugin registration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn dynamic_plugin_registration() -> Result<()> {
    let env = TestEnv::start().await?;

    let echo = env.start_echo_server("127.0.0.1", Protocol::Http2).await;

    // Initially no plugins registered — request goes through transparently
    {
        let client = env.create_http_client(Protocol::Http2).await;
        let resp = client
            .get(format!(
                "https://127.0.0.1:{}/before-register",
                echo.listen_addr().port()
            ))
            .send()
            .await?;
        assert!(resp.status().is_success());
    }

    // Register the test component dynamically
    env.register_test_component().await?;

    // New client forces a new connection — CONNECT is re-evaluated and the
    // plugin's Connect capability now triggers MITM.
    {
        let client = env.create_http_client(Protocol::Http2).await;
        let resp = client
            .get(format!(
                "https://127.0.0.1:{}/after-register",
                echo.listen_addr().port()
            ))
            .send()
            .await?;

        let headers = resp.headers().clone();
        let body: EchoResponse = resp.json().await?;

        assert!(
            body.headers
                .get("witmproxy")
                .is_some_and(|v| v.contains("req")),
            "After dynamic registration, plugin should inject request header"
        );
        assert!(
            headers
                .get("witmproxy")
                .is_some_and(|v| v.to_str().unwrap().contains("res")),
            "After dynamic registration, plugin should inject response header"
        );
    }

    echo.shutdown().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Dynamic plugin removal
// ---------------------------------------------------------------------------

#[tokio::test]
async fn dynamic_plugin_removal() -> Result<()> {
    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    let echo = env.start_echo_server("127.0.0.1", Protocol::Http2).await;
    let client = env.create_http_client(Protocol::Http2).await;

    // First request — plugin is active
    let resp = client
        .get(format!(
            "https://127.0.0.1:{}/before-remove",
            echo.listen_addr().port()
        ))
        .send()
        .await?;
    let body: EchoResponse = resp.json().await?;
    assert!(
        body.headers
            .get("witmproxy")
            .is_some_and(|v| v.contains("req")),
        "Plugin should be active before removal"
    );

    // Remove the plugin
    let removed = env
        .remove_plugin("wasm-test-component", Some("ezco"))
        .await?;
    assert!(
        !removed.is_empty(),
        "Should have removed at least one plugin"
    );

    // Subsequent request — no plugin
    let resp = client
        .get(format!(
            "https://127.0.0.1:{}/after-remove",
            echo.listen_addr().port()
        ))
        .send()
        .await?;
    assert!(resp.status().is_success());

    echo.shutdown().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Dynamic tenant override change observed by client
// ---------------------------------------------------------------------------

#[tokio::test]
async fn dynamic_tenant_override_change() -> Result<()> {
    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    env.create_tenant("dyn-t", "Dynamic Tenant").await?;

    // Initially the test component is enabled for this tenant
    let eff = env.effective_plugins_for_tenant("dyn-t").await?;
    assert!(eff.contains("ezco/wasm-test-component"));

    // Disable it
    env.set_tenant_plugin_override("dyn-t", "ezco", "wasm-test-component", Some(false))
        .await?;
    let eff = env.effective_plugins_for_tenant("dyn-t").await?;
    assert!(
        !eff.contains("ezco/wasm-test-component"),
        "After override, plugin should be disabled for tenant"
    );

    // Re-enable
    env.set_tenant_plugin_override("dyn-t", "ezco", "wasm-test-component", Some(true))
        .await?;
    let eff = env.effective_plugins_for_tenant("dyn-t").await?;
    assert!(
        eff.contains("ezco/wasm-test-component"),
        "After re-enable, plugin should be effective again"
    );

    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Multiple clients observe same dynamic plugin registration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn multiple_clients_observe_registration() -> Result<()> {
    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    let echo = env.start_echo_server("127.0.0.1", Protocol::Http2).await;

    // Two independent clients (HTTP/2 and HTTP/1) both observe the plugin.
    // Each creates its own CONNECT tunnel and TLS session, so this verifies
    // the plugin applies to all new connections regardless of protocol.
    let client_h2 = env.create_http_client(Protocol::Http2).await;
    let client_h1 = env.create_http_client(Protocol::Http1).await;

    let r1 = client_h2
        .get(format!(
            "https://127.0.0.1:{}/c1",
            echo.listen_addr().port()
        ))
        .send()
        .await?;
    let body1: EchoResponse = r1.json().await?;
    assert!(
        body1
            .headers
            .get("witmproxy")
            .is_some_and(|v| v.contains("req")),
        "HTTP/2 client should see plugin header"
    );

    let r2 = client_h1
        .get(format!(
            "https://127.0.0.1:{}/c2",
            echo.listen_addr().port()
        ))
        .send()
        .await?;
    let body2: EchoResponse = r2.json().await?;
    assert!(
        body2
            .headers
            .get("witmproxy")
            .is_some_and(|v| v.contains("req")),
        "HTTP/1.1 client should see plugin header"
    );

    echo.shutdown().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Plugin IDs tracking
// ---------------------------------------------------------------------------

#[tokio::test]
async fn plugin_ids_tracks_registrations() -> Result<()> {
    let env = TestEnv::start().await?;

    let ids = env.plugin_ids().await;
    assert!(ids.is_empty(), "No plugins registered initially");

    env.register_test_component().await?;
    let ids = env.plugin_ids().await;
    assert!(ids.contains("ezco/wasm-test-component"));

    env.register_noop_plugin().await?;
    let ids = env.plugin_ids().await;
    assert!(ids.contains("witmproxy/noop"));
    assert_eq!(ids.len(), 2);

    env.remove_plugin("noop", Some("witmproxy")).await?;
    let ids = env.plugin_ids().await;
    assert!(!ids.contains("witmproxy/noop"));
    assert_eq!(ids.len(), 1);

    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tenant CRUD via DB helpers
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tenant_crud() -> Result<()> {
    let env = TestEnv::start().await?;
    let db = env.db_pool().await;

    // Create
    let tenant = env.create_tenant("crud-t", "CRUD Tenant").await?;
    assert_eq!(tenant.id, "crud-t");
    assert_eq!(tenant.display_name, "CRUD Tenant");
    assert!(tenant.enabled);

    // Read
    let fetched = witmproxy_test::tenants::Tenant::by_id(&db.pool, "crud-t").await?;
    assert!(fetched.is_some());

    // Disable
    witmproxy_test::tenants::Tenant::update_enabled(&db.pool, "crud-t", false).await?;
    let fetched = witmproxy_test::tenants::Tenant::by_id(&db.pool, "crud-t")
        .await?
        .unwrap();
    assert!(!fetched.enabled);

    // Delete
    let deleted = witmproxy_test::tenants::Tenant::delete(&db.pool, "crud-t").await?;
    assert!(deleted);
    let gone = witmproxy_test::tenants::Tenant::by_id(&db.pool, "crud-t").await?;
    assert!(gone.is_none());

    env.shutdown().await;
    Ok(())
}
