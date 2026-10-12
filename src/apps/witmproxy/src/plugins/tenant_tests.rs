use crate::db::tenants::{TenantPluginConfig, TenantPluginOverride};
use crate::test_utils::{create_plugin_registry, register_noop_plugin, register_test_component};

#[tokio::test]
async fn effective_plugins_no_overrides_returns_all_enabled() {
    let (registry, _dir) = create_plugin_registry().await.unwrap();
    register_test_component(&registry).await.unwrap();

    let overrides: Vec<TenantPluginOverride> = vec![];
    let effective = registry.effective_plugins_for_tenant(&overrides);

    // All globally enabled plugins should be in the effective set
    assert!(
        !effective.is_empty(),
        "Expected at least one effective plugin"
    );
    for (id, plugin) in registry.plugins().iter() {
        if plugin.enabled {
            assert!(
                effective.contains(id),
                "Globally enabled plugin {} should be effective",
                id
            );
        }
    }
}

#[tokio::test]
async fn effective_plugins_tenant_override_disables_plugin() {
    let (registry, _dir) = create_plugin_registry().await.unwrap();
    register_test_component(&registry).await.unwrap();

    // Get the first plugin's namespace/name
    let (plugin_ns, plugin_name) = {
        let plugins = registry.plugins();
        let p = plugins.values().next().unwrap();
        (p.namespace.clone(), p.name.clone())
    };

    let overrides = vec![TenantPluginOverride {
        tenant_id: "tenant-1".to_string(),
        plugin_namespace: plugin_ns.clone(),
        plugin_name: plugin_name.clone(),
        enabled: Some(false),
    }];

    let effective = registry.effective_plugins_for_tenant(&overrides);
    let plugin_id = format!("{}/{}", plugin_ns, plugin_name);
    assert!(
        !effective.contains(&plugin_id),
        "Plugin disabled by tenant override should not be effective"
    );
}

#[tokio::test]
async fn effective_plugins_tenant_override_enables_disabled_plugin() {
    let (registry, _dir) = create_plugin_registry().await.unwrap();
    register_test_component(&registry).await.unwrap();

    let (plugin_ns, plugin_name, plugin_id) = {
        let plugins = registry.plugins();
        let p = plugins.values().next().unwrap();
        (p.namespace.clone(), p.name.clone(), p.id())
    };

    // Simulate a globally disabled plugin by creating an override that disables it
    // and then an override that re-enables it.
    // First, verify it IS in the effective set by default (globally enabled)
    let effective = registry.effective_plugins_for_tenant(&[]);
    assert!(
        effective.contains(&plugin_id),
        "Plugin should be effective by default"
    );

    // Disable via override
    let disable_overrides = vec![TenantPluginOverride {
        tenant_id: "tenant-1".to_string(),
        plugin_namespace: plugin_ns.clone(),
        plugin_name: plugin_name.clone(),
        enabled: Some(false),
    }];
    let effective = registry.effective_plugins_for_tenant(&disable_overrides);
    assert!(
        !effective.contains(&plugin_id),
        "Plugin disabled by override should not be effective"
    );

    // Re-enable via override
    let enable_overrides = vec![TenantPluginOverride {
        tenant_id: "tenant-1".to_string(),
        plugin_namespace: plugin_ns,
        plugin_name,
        enabled: Some(true),
    }];
    let effective = registry.effective_plugins_for_tenant(&enable_overrides);
    assert!(
        effective.contains(&plugin_id),
        "Plugin enabled by tenant override should be effective"
    );
}

#[tokio::test]
async fn effective_plugins_multiple_plugins_different_overrides() {
    let (registry, _dir) = create_plugin_registry().await.unwrap();
    register_test_component(&registry).await.unwrap();
    register_noop_plugin(&registry).await.unwrap();

    let plugins: Vec<_> = registry
        .plugins()
        .values()
        .map(|p| (p.namespace.clone(), p.name.clone(), p.id()))
        .collect();
    assert!(plugins.len() >= 2, "Need at least 2 plugins for this test");

    let (ns1, name1, id1) = &plugins[0];
    let (_ns2, _name2, id2) = &plugins[1];

    // Disable plugin1 for tenant, leave plugin2 enabled
    let overrides = vec![TenantPluginOverride {
        tenant_id: "tenant-1".to_string(),
        plugin_namespace: ns1.clone(),
        plugin_name: name1.clone(),
        enabled: Some(false),
    }];

    let effective = registry.effective_plugins_for_tenant(&overrides);
    assert!(
        !effective.contains(id1),
        "Plugin 1 should be disabled for tenant"
    );
    assert!(effective.contains(id2), "Plugin 2 should still be enabled");
}

#[tokio::test]
async fn resolve_config_no_tenant_config_returns_global() {
    let (registry, _dir) = create_plugin_registry().await.unwrap();
    register_test_component(&registry).await.unwrap();

    let plugins = registry.plugins();
    let plugin = plugins.values().next().unwrap();
    let tenant_config: Vec<TenantPluginConfig> = vec![];

    let resolved = registry.resolve_config(plugin, &tenant_config);
    // With no tenant overrides, resolved config should be identical to global
    for (resolved_input, global_input) in resolved.iter().zip(plugin.configuration.iter()) {
        assert_eq!(
            resolved_input.name, global_input.name,
            "Resolved config input names should match global config"
        );
    }
}

#[tokio::test]
async fn resolve_config_tenant_overrides_specific_input() {
    let (registry, _dir) = create_plugin_registry().await.unwrap();
    register_test_component(&registry).await.unwrap();

    let plugins = registry.plugins();
    let plugin = plugins.values().next().unwrap();

    // Only test if the plugin has configuration inputs
    if plugin.configuration.is_empty() {
        // Plugin has no config inputs, skip this test
        return;
    }

    let first_input = &plugin.configuration[0];
    let tenant_config = vec![TenantPluginConfig {
        tenant_id: "tenant-1".to_string(),
        plugin_namespace: plugin.namespace.clone(),
        plugin_name: plugin.name.clone(),
        input_name: first_input.name.clone(),
        input_value: "\"tenant-custom-value\"".to_string(),
    }];

    let resolved = registry.resolve_config(plugin, &tenant_config);
    assert_eq!(resolved.len(), plugin.configuration.len());
    // Verify the overridden input received the tenant-specific value
    let overridden = resolved
        .iter()
        .find(|i| i.name == first_input.name)
        .expect("Overridden input should be present");
    let serialized = serde_json::to_string(&overridden.value).unwrap();
    assert!(
        serialized.contains("tenant-custom-value"),
        "Override value should be reflected in resolved config, got: {}",
        serialized
    );
}

#[tokio::test]
async fn resolve_config_ignores_config_for_other_plugins() {
    let (registry, _dir) = create_plugin_registry().await.unwrap();
    register_test_component(&registry).await.unwrap();

    let plugins = registry.plugins();
    let plugin = plugins.values().next().unwrap();

    // Config for a different plugin should not affect this plugin
    let tenant_config = vec![TenantPluginConfig {
        tenant_id: "tenant-1".to_string(),
        plugin_namespace: "other-namespace".to_string(),
        plugin_name: "other-plugin".to_string(),
        input_name: "some-input".to_string(),
        input_value: "\"some-value\"".to_string(),
    }];

    let resolved = registry.resolve_config(plugin, &tenant_config);
    // Config should be identical to global since the tenant config is for a different plugin
    for (resolved_input, global_input) in resolved.iter().zip(plugin.configuration.iter()) {
        assert_eq!(resolved_input.name, global_input.name);
    }
    assert_eq!(
        resolved.len(),
        plugin.configuration.len(),
        "Config for other plugins should not add extra entries"
    );
}

// ---------------------------------------------------------------------------
// Dispatch: which plugins run for whom, and with what configuration
// ---------------------------------------------------------------------------

mod dispatch {
    use crate::db::tenants::{self, Tenant};
    use crate::events::Event;
    use crate::events::connect::Connect;
    use crate::proxy::tenant::TenantContext;
    use crate::test_utils::{
        create_plugin_registry, register_noshorts_plugin, register_test_component,
    };
    use crate::wasm::bindgen::Event as WasmEvent;
    use crate::{PluginRegistry, plugins::registry::TENANT_POLICY_TTL};
    use bytes::Bytes;
    use http_body_util::Full;
    use hyper::{Method, Request};
    use wasmtime_wasi_http::WasiHttpView;
    use wasmtime_wasi_http::p3::Request as WasiRequest;

    /// The test component's ids: it is `ezco/wasm-test-component`, and it
    /// stamps `witmproxy: req` on every request it handles, which is how a
    /// test tells whether it ran.
    const NS: &str = "ezco";
    const NAME: &str = "wasm-test-component";

    fn connect(host: &str) -> Box<dyn Event> {
        Box::new(Connect::new(host.to_string(), 443))
    }

    fn request(url: &str, host: &str) -> Box<dyn Event> {
        let req = Request::builder()
            .method(Method::GET)
            .uri(url)
            .header("host", host)
            .body(Full::new(Bytes::from("test body")))
            .unwrap();
        let (wasi_req, _io) = WasiRequest::from_http(wasmtime_wasi_http::default_hooks(), req);
        Box::new(wasi_req)
    }

    /// Runs a request through the registry for `tenant` and reports whether
    /// the test component stamped it.
    async fn stamped_for(registry: &PluginRegistry, tenant: &TenantContext) -> bool {
        let (event, mut store) = registry
            .handle_event_for(request("https://example.com/", "example.com"), tenant)
            .await
            .expect("request event handled");
        let WasmEvent::Request(handle) = event else {
            panic!("a request event must come back as a request");
        };
        let req = store.data_mut().http().table.delete(handle).unwrap();
        req.headers
            .get("witmproxy")
            .is_some_and(|v| v.as_bytes() == b"req")
    }

    async fn create_tenant(registry: &PluginRegistry, id: &str) {
        Tenant::create(&registry.db.pool, id, id, None, None, None, None)
            .await
            .unwrap();
    }

    /// A plugin switched off for everyone runs for the one tenant whose
    /// override switches it on: its CONNECTs are intercepted and its
    /// requests handled. Anonymous traffic, another tenant and a tenant the
    /// database does not know all still get nothing.
    #[tokio::test]
    async fn tenant_override_enables_a_globally_disabled_plugin_for_that_tenant_only() {
        let (registry, _dir) = create_plugin_registry().await.unwrap();
        register_test_component(&registry).await.unwrap();
        assert!(registry.set_plugin_enabled(NS, NAME, false).await.unwrap());
        create_tenant(&registry, "t-on").await;
        create_tenant(&registry, "t-off").await;
        tenants::set_plugin_override(&registry.db.pool, "t-on", NS, NAME, Some(true))
            .await
            .unwrap();

        let on = TenantContext::new("t-on".into());
        let off = TenantContext::new("t-off".into());
        let unknown = TenantContext::new("nobody".into());
        let anon = TenantContext::anonymous();

        // The CONNECT decision.
        assert!(!registry.can_handle(&*connect("example.com")));
        assert!(registry.can_handle_for(&*connect("example.com"), &on).await);
        assert!(
            !registry
                .can_handle_for(&*connect("example.com"), &off)
                .await
        );
        assert!(
            !registry
                .can_handle_for(&*connect("example.com"), &unknown)
                .await
        );
        assert!(
            !registry
                .can_handle_for(&*connect("example.com"), &anon)
                .await
        );
        // A scope that does not match is still a scope: the override turns
        // the plugin on, it does not widen what it asked for.
        assert!(
            !registry
                .can_handle_for(
                    &*request("https://donotprocess.com/", "donotprocess.com"),
                    &on
                )
                .await
        );

        // The request itself.
        assert!(stamped_for(&registry, &on).await);
        assert!(!stamped_for(&registry, &off).await);
        assert!(!stamped_for(&registry, &unknown).await);
        assert!(!stamped_for(&registry, &anon).await);
    }

    /// The tenant's policy is cached for [`TENANT_POLICY_TTL`]; an edit is
    /// live at once when the cache entry is dropped, as the management
    /// handlers do, and otherwise by the next interval.
    #[tokio::test]
    async fn tenant_policy_is_cached_until_invalidated() {
        assert!(TENANT_POLICY_TTL.as_secs() <= 2, "the cache must be short");
        let (registry, _dir) = create_plugin_registry().await.unwrap();
        register_test_component(&registry).await.unwrap();
        registry.set_plugin_enabled(NS, NAME, false).await.unwrap();
        create_tenant(&registry, "t-on").await;
        let pool = registry.db.pool.clone();
        tenants::set_plugin_override(&pool, "t-on", NS, NAME, Some(true))
            .await
            .unwrap();
        let on = TenantContext::new("t-on".into());
        assert!(registry.can_handle_for(&*connect("example.com"), &on).await);

        tenants::set_plugin_override(&pool, "t-on", NS, NAME, Some(false))
            .await
            .unwrap();
        // Still the cached answer...
        assert!(registry.can_handle_for(&*connect("example.com"), &on).await);
        // ...until the entry is dropped.
        registry.invalidate_tenant_policy("t-on");
        assert!(!registry.can_handle_for(&*connect("example.com"), &on).await);
    }

    /// A tenant's configuration is what its plugins are created with. The
    /// noshorts plugin validates its inputs in `create`: a budget that is
    /// not a number is refused there, which ends the event for that tenant
    /// and nobody else; a hosts list that leaves YouTube out makes it hand a
    /// YouTube request back untouched where the default would judge it.
    #[tokio::test]
    async fn tenant_configuration_reaches_the_plugin_create() {
        let (registry, _dir) = create_plugin_registry().await.unwrap();
        register_noshorts_plugin(&registry).await.unwrap();
        let pool = registry.db.pool.clone();
        for id in ["t-bad", "t-elsewhere"] {
            create_tenant(&registry, id).await;
        }
        tenants::set_plugin_config(
            &pool,
            "t-bad",
            "witmproxy",
            "noshorts",
            "daily_budget_minutes",
            "lots",
        )
        .await
        .unwrap();
        tenants::set_plugin_config(
            &pool,
            "t-elsewhere",
            "witmproxy",
            "noshorts",
            "hosts",
            "example.com",
        )
        .await
        .unwrap();

        let youtube = || request("https://www.youtube.com/watch?v=x", "www.youtube.com");

        let err = registry
            .handle_event_for(youtube(), &TenantContext::new("t-bad".into()))
            .await
            .err()
            .expect("a configuration the plugin refuses ends the event");
        let chain = format!("{err:#}");
        assert!(
            chain.contains("configure") && chain.contains("daily_budget_minutes"),
            "the plugin's own refusal, from create(): {chain}"
        );

        let (event, _store) = registry
            .handle_event_for(youtube(), &TenantContext::new("t-elsewhere".into()))
            .await
            .expect("a tenant whose hosts exclude YouTube gets the request back");
        assert!(
            matches!(event, WasmEvent::Request(_)),
            "not managed for this tenant, so neither blocked nor rewritten"
        );
    }

    /// A tenant value is typed as the plugin's manifest declares the input,
    /// the way a command-line value is, so a plugin that reads a number
    /// gets a number.
    #[tokio::test]
    async fn tenant_configuration_is_typed_by_the_declared_input() {
        use crate::db::tenants::TenantPluginConfig;
        use crate::wasm::bindgen::ActualInput;

        let (registry, _dir) = create_plugin_registry().await.unwrap();
        register_noshorts_plugin(&registry).await.unwrap();
        let plugins = registry.plugins();
        let plugin = plugins.get("witmproxy/noshorts").unwrap();
        let config = |name: &str, value: &str| TenantPluginConfig {
            tenant_id: "t".into(),
            plugin_namespace: "witmproxy".into(),
            plugin_name: "noshorts".into(),
            input_name: name.into(),
            input_value: value.into(),
        };
        let resolved = registry.resolve_config(
            plugin,
            &[
                config("daily_budget_minutes", "45"),
                config("block_shorts", "no"),
                config("hosts", "example.com"),
                // Already typed, as the global store writes it.
                config("hide_shorts_ui", r#"{"boolean":true}"#),
                // Not an input the plugin declares: passed through as text.
                config("undeclared", "x"),
            ],
        );
        let value = |name: &str| &resolved.iter().find(|i| i.name == name).unwrap().value;
        assert!(
            matches!(value("daily_budget_minutes"), ActualInput::Number(n) if (*n - 45.0).abs() < f64::EPSILON)
        );
        assert!(matches!(value("block_shorts"), ActualInput::Boolean(false)));
        assert!(matches!(value("hosts"), ActualInput::Str(s) if s == "example.com"));
        assert!(matches!(
            value("hide_shorts_ui"),
            ActualInput::Boolean(true)
        ));
        assert!(matches!(value("undeclared"), ActualInput::Str(s) if s == "x"));
    }

    /// Anonymous traffic is untouched by tenancy: the globally enabled
    /// plugins run for it with their global configuration, whatever any
    /// tenant has overridden, and a tenant that is unknown or disabled is
    /// treated the same way.
    #[tokio::test]
    async fn anonymous_behaviour_is_unchanged_by_tenant_overrides() {
        let (registry, _dir) = create_plugin_registry().await.unwrap();
        register_test_component(&registry).await.unwrap();
        let pool = registry.db.pool.clone();
        create_tenant(&registry, "t-off").await;
        create_tenant(&registry, "t-disabled").await;
        tenants::set_plugin_override(&pool, "t-off", NS, NAME, Some(false))
            .await
            .unwrap();
        tenants::set_plugin_override(&pool, "t-disabled", NS, NAME, Some(false))
            .await
            .unwrap();
        Tenant::update_enabled(&pool, "t-disabled", false)
            .await
            .unwrap();

        let anon = TenantContext::anonymous();
        let off = TenantContext::new("t-off".into());
        let disabled = TenantContext::new("t-disabled".into());
        let unknown = TenantContext::new("nobody".into());

        assert!(registry.can_handle(&*connect("example.com")));
        assert!(
            registry
                .can_handle_for(&*connect("example.com"), &anon)
                .await
        );
        assert!(
            registry
                .can_handle_for(&*connect("example.com"), &unknown)
                .await
        );
        assert!(
            registry
                .can_handle_for(&*connect("example.com"), &disabled)
                .await
        );
        assert!(
            !registry
                .can_handle_for(&*connect("example.com"), &off)
                .await
        );

        // `handle_event` is the anonymous dispatch.
        let (event, mut store) = registry
            .handle_event(request("https://example.com/", "example.com"))
            .await
            .unwrap();
        let WasmEvent::Request(handle) = event else {
            panic!("a request event must come back as a request");
        };
        let req = store.data_mut().http().table.delete(handle).unwrap();
        assert_eq!(
            req.headers.get("witmproxy").map(|v| v.as_bytes()),
            Some(&b"req"[..])
        );

        assert!(stamped_for(&registry, &anon).await);
        assert!(stamped_for(&registry, &unknown).await);
        assert!(stamped_for(&registry, &disabled).await);
        assert!(!stamped_for(&registry, &off).await);
    }
}
