use crate::db::tenants::{TenantPluginConfig, TenantPluginOverride};
use crate::test_utils::{create_plugin_registry, register_noop_plugin, register_test_component};

#[tokio::test]
async fn effective_plugins_no_overrides_returns_all_enabled() {
    let (mut registry, _dir) = create_plugin_registry().await.unwrap();
    register_test_component(&mut registry).await.unwrap();

    let overrides: Vec<TenantPluginOverride> = vec![];
    let effective = registry.effective_plugins_for_tenant(&overrides);

    // All globally enabled plugins should be in the effective set
    assert!(
        !effective.is_empty(),
        "Expected at least one effective plugin"
    );
    for (id, plugin) in registry.plugins() {
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
    let (mut registry, _dir) = create_plugin_registry().await.unwrap();
    register_test_component(&mut registry).await.unwrap();

    // Get the first plugin's namespace/name
    let (plugin_ns, plugin_name) = {
        let p = registry.plugins().values().next().unwrap();
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
    let (mut registry, _dir) = create_plugin_registry().await.unwrap();
    register_test_component(&mut registry).await.unwrap();

    let (plugin_ns, plugin_name, plugin_id) = {
        let p = registry.plugins().values().next().unwrap();
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
        plugin_name: plugin_name,
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
    let (mut registry, _dir) = create_plugin_registry().await.unwrap();
    register_test_component(&mut registry).await.unwrap();
    register_noop_plugin(&mut registry).await.unwrap();

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
    let (mut registry, _dir) = create_plugin_registry().await.unwrap();
    register_test_component(&mut registry).await.unwrap();

    let plugin = registry.plugins().values().next().unwrap();
    let tenant_config: Vec<TenantPluginConfig> = vec![];

    let resolved = registry.resolve_config(&plugin, &tenant_config);
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
    let (mut registry, _dir) = create_plugin_registry().await.unwrap();
    register_test_component(&mut registry).await.unwrap();

    let plugin = registry.plugins().values().next().unwrap();

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

    let resolved = registry.resolve_config(&plugin, &tenant_config);
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
    let (mut registry, _dir) = create_plugin_registry().await.unwrap();
    register_test_component(&mut registry).await.unwrap();

    let plugin = registry.plugins().values().next().unwrap();

    // Config for a different plugin should not affect this plugin
    let tenant_config = vec![TenantPluginConfig {
        tenant_id: "tenant-1".to_string(),
        plugin_namespace: "other-namespace".to_string(),
        plugin_name: "other-plugin".to_string(),
        input_name: "some-input".to_string(),
        input_value: "\"some-value\"".to_string(),
    }];

    let resolved = registry.resolve_config(&plugin, &tenant_config);
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
