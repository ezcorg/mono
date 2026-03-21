use crate::{
    AppConfig, Db, Runtime,
    cli::load_plugins_from_directory,
    config::confique_app_config_layer::AppConfigLayer,
    plugins::{WitmPlugin, registry::PluginRegistry},
    test_utils::test_component_path,
    wasm::bindgen::Event,
};
use anyhow::Result;
use cel_cxx::{Env, EnvBuilder};
use confique::{Config, Layer};
use std::path::Path;
use std::sync::Arc;
use tempfile::tempdir;
use tokio::sync::RwLock;

use super::plugin;

/// Helper function to create a static CEL environment for tests
fn create_static_cel_env() -> Result<&'static Env<'static>> {
    let env = Event::register(EnvBuilder::new())?.build()?;
    // Leak the env to get a static reference since it contains only static data
    // and we want it to live for the program duration
    Ok(Box::leak(Box::new(env)))
}

/// Test helper that creates an AppConfig with test paths
fn create_test_config(temp_path: &Path) -> AppConfig {
    let db_path = temp_path.join("test.db");
    let cert_dir = temp_path.join("certs");
    let mut partial_config = AppConfigLayer::default_values();
    partial_config.db.db_path = Some(db_path);
    partial_config.db.db_password = Some("test_password".to_string());
    partial_config.tls.cert_dir = Some(cert_dir);

    AppConfig::builder()
        .preloaded(partial_config)
        .load()
        .expect("Failed to load test config")
        .with_resolved_paths()
        .expect("Failed to resolve paths in test config")
}

#[tokio::test]
async fn test_witm_plugin_add_local_wasm() -> Result<()> {
    // Create a temporary directory for the test config
    let temp_dir = tempdir().unwrap();
    let temp_path = temp_dir.path();

    let config = create_test_config(temp_path);
    let plugin_handler = plugin::PluginHandler::new(config, true);

    // Test path to the signed WASM component
    let wasm_path = test_component_path()?;

    // Test adding the plugin
    plugin_handler
        .handle(&plugin::PluginCommands::Add {
            source: wasm_path.clone(),
        })
        .await?;

    // Verify the plugin was actually added to the database
    let db_file_path = temp_path.join("test.db");
    let mut db = Db::from_path(db_file_path, "test_password").await.unwrap();

    // Create runtime to check plugins
    let runtime = Runtime::try_default().unwrap();
    let env = create_static_cel_env()?;
    let plugins = WitmPlugin::all(&mut db, &runtime.engine, env)
        .await
        .unwrap();
    assert!(
        !plugins.is_empty(),
        "No plugins found in database after adding"
    );

    // Verify the specific test plugin was added with its expected properties
    let test_plugin = plugins
        .iter()
        .find(|p| p.name.contains("test") || p.namespace.contains("test"))
        .expect("Test plugin not found in database");

    assert!(
        !test_plugin.component_bytes.is_empty(),
        "Plugin component bytes should not be empty"
    );
    assert!(
        !test_plugin.publickey.is_empty(),
        "Plugin should have a public key"
    );
    Ok(())
}

#[tokio::test]
async fn test_witm_plugin_add_nonexistent_file() {
    let temp_dir = tempdir().unwrap();
    let temp_path = temp_dir.path();

    let config = create_test_config(temp_path);
    let plugin_handler = plugin::PluginHandler::new(config, true);

    // Test with non-existent file
    let result = plugin_handler
        .handle(&plugin::PluginCommands::Add {
            source: "/nonexistent/file.wasm".to_string(),
        })
        .await;

    assert!(result.is_err(), "Should fail for non-existent file");
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("File does not exist")
    );
}

#[tokio::test]
async fn test_witm_plugin_add_non_wasm_file() {
    let temp_dir = tempdir().unwrap();
    let temp_path = temp_dir.path();
    let dummy_file = temp_path.join("not_a_wasm.txt");

    // Create a dummy non-WASM file
    std::fs::write(&dummy_file, "This is not a WASM file").unwrap();

    let config = create_test_config(temp_path);
    let plugin_handler = plugin::PluginHandler::new(config, true);

    // Test with non-WASM file
    let result = plugin_handler
        .handle(&plugin::PluginCommands::Add {
            source: dummy_file.to_str().unwrap().to_string(),
        })
        .await;

    assert!(result.is_err(), "Should fail for non-WASM file");
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("Only .wasm files are supported")
    );
}

#[tokio::test]
async fn test_witm_plugin_remove_by_name() -> Result<()> {
    let temp_dir = tempdir().unwrap();
    let temp_path = temp_dir.path();

    let config = create_test_config(temp_path);
    let plugin_handler = plugin::PluginHandler::new(config, true);

    // Test path to the signed WASM component
    let wasm_path = test_component_path()?;

    // Add the plugin first
    plugin_handler
        .handle(&plugin::PluginCommands::Add {
            source: wasm_path.clone(),
        })
        .await?;

    // Verify plugin was added
    let db_file_path = temp_path.join("test.db");
    let mut db = Db::from_path(db_file_path, "test_password").await.unwrap();

    let runtime = Runtime::try_default().unwrap();
    let env = create_static_cel_env()?;
    let plugins_before = WitmPlugin::all(&mut db, &runtime.engine, env)
        .await
        .unwrap();
    assert!(!plugins_before.is_empty(), "No plugins found after adding");

    let test_plugin = &plugins_before[0];
    let plugin_name = &test_plugin.name;

    // Test removing the plugin by name
    plugin_handler
        .handle(&plugin::PluginCommands::Remove {
            plugin_name: plugin_name.clone(),
        })
        .await?;

    // Verify plugin was removed
    let plugins_after = WitmPlugin::all(&mut db, &runtime.engine, env)
        .await
        .unwrap();
    assert!(
        plugins_after.is_empty(),
        "Plugin was not removed from database"
    );
    Ok(())
}

#[tokio::test]
async fn test_witm_plugin_remove_by_namespace_name() -> Result<()> {
    let temp_dir = tempdir().unwrap();
    let temp_path = temp_dir.path();

    let config = create_test_config(temp_path);
    let plugin_handler = plugin::PluginHandler::new(config, true);

    // Test path to the signed WASM component
    let wasm_path = test_component_path()?;

    // Add the plugin first
    plugin_handler
        .handle(&plugin::PluginCommands::Add {
            source: wasm_path.clone(),
        })
        .await?;

    // Verify plugin was added and get its full ID
    let db_file_path = temp_path.join("test.db");
    let mut db = Db::from_path(db_file_path, "test_password").await.unwrap();

    let runtime = Runtime::try_default().unwrap();
    let env = create_static_cel_env()?;
    let plugins_before = WitmPlugin::all(&mut db, &runtime.engine, env)
        .await
        .unwrap();
    assert!(!plugins_before.is_empty(), "No plugins found after adding");

    let test_plugin = &plugins_before[0];
    let full_plugin_id = format!("{}/{}", test_plugin.namespace, test_plugin.name);

    // Test removing the plugin by namespace/name
    plugin_handler
        .handle(&plugin::PluginCommands::Remove {
            plugin_name: full_plugin_id.clone(),
        })
        .await?;

    // Verify plugin was removed
    let plugins_after = WitmPlugin::all(&mut db, &runtime.engine, env)
        .await
        .unwrap();
    assert!(
        plugins_after.is_empty(),
        "Plugin was not removed from database"
    );
    Ok(())
}

#[tokio::test]
async fn test_witm_plugin_remove_nonexistent() {
    let temp_dir = tempdir().unwrap();
    let temp_path = temp_dir.path();

    let config = create_test_config(temp_path);
    let plugin_handler = plugin::PluginHandler::new(config, true);

    // Test removing a nonexistent plugin
    let result = plugin_handler
        .handle(&plugin::PluginCommands::Remove {
            plugin_name: "nonexistent_plugin".to_string(),
        })
        .await;
    assert!(
        result.is_ok(),
        "Should not fail when removing nonexistent plugin"
    );
}

#[tokio::test]
async fn test_plugin_dir_loading() -> Result<()> {
    // Create temporary directories
    let temp_dir = tempdir().unwrap();
    let temp_path = temp_dir.path();
    let plugin_dir = temp_path.join("plugins");
    std::fs::create_dir_all(&plugin_dir)?;

    // Initialize database
    let db_path = temp_path.join("test.db");
    let db = Db::from_path(db_path, "test_password").await?;
    db.migrate().await?;

    // Create runtime and plugin registry
    let runtime = Runtime::try_default()?;
    let registry = PluginRegistry::new(db, runtime)?;
    let registry = Arc::new(RwLock::new(registry));

    // Initially, plugin directory is empty, so no plugins should be loaded
    load_plugins_from_directory(&plugin_dir, registry.clone()).await?;
    {
        let reg = registry.read().await;
        assert!(
            reg.plugins().is_empty(),
            "No plugins should be loaded from empty directory"
        );
    }

    // Copy test component to plugin directory
    let wasm_path = test_component_path()?;
    let dest_path = plugin_dir.join("test_plugin.wasm");
    std::fs::copy(&wasm_path, &dest_path)?;

    // Load plugins again - should find the plugin now
    load_plugins_from_directory(&plugin_dir, registry.clone()).await?;
    {
        let reg = registry.read().await;
        assert_eq!(
            reg.plugins().len(),
            1,
            "Expected exactly one plugin to be loaded from directory"
        );
    }

    Ok(())
}

#[tokio::test]
async fn test_plugin_dir_invalid_wasm_skipped() -> Result<()> {
    // Create temporary directories
    let temp_dir = tempdir().unwrap();
    let temp_path = temp_dir.path();
    let plugin_dir = temp_path.join("plugins");
    std::fs::create_dir_all(&plugin_dir)?;

    // Initialize database
    let db_path = temp_path.join("test.db");
    let db = Db::from_path(db_path, "test_password").await?;
    db.migrate().await?;

    // Create runtime and plugin registry
    let runtime = Runtime::try_default()?;
    let registry = PluginRegistry::new(db, runtime)?;
    let registry = Arc::new(RwLock::new(registry));

    // Create an invalid wasm file
    let invalid_path = plugin_dir.join("invalid.wasm");
    std::fs::write(&invalid_path, b"not a valid wasm file")?;

    // Also copy a valid plugin
    let wasm_path = test_component_path()?;
    let valid_path = plugin_dir.join("valid_plugin.wasm");
    std::fs::copy(&wasm_path, &valid_path)?;

    // Load plugins - should load valid one and skip invalid
    let result = load_plugins_from_directory(&plugin_dir, registry.clone()).await;
    assert!(
        result.is_ok(),
        "Should not fail even with invalid wasm files"
    );

    {
        let reg = registry.read().await;
        assert_eq!(
            reg.plugins().len(),
            1,
            "Should load only the valid plugin, skipping invalid"
        );
    }

    Ok(())
}

#[tokio::test]
async fn test_plugin_dir_non_wasm_files_ignored() -> Result<()> {
    // Create temporary directories
    let temp_dir = tempdir().unwrap();
    let temp_path = temp_dir.path();
    let plugin_dir = temp_path.join("plugins");
    std::fs::create_dir_all(&plugin_dir)?;

    // Initialize database
    let db_path = temp_path.join("test.db");
    let db = Db::from_path(db_path, "test_password").await?;
    db.migrate().await?;

    // Create runtime and plugin registry
    let runtime = Runtime::try_default()?;
    let registry = PluginRegistry::new(db, runtime)?;
    let registry = Arc::new(RwLock::new(registry));

    // Create non-wasm files that should be ignored
    std::fs::write(plugin_dir.join("readme.txt"), b"readme content")?;
    std::fs::write(plugin_dir.join("config.json"), b"{}")?;

    // Copy a valid plugin
    let wasm_path = test_component_path()?;
    let valid_path = plugin_dir.join("plugin.wasm");
    std::fs::copy(&wasm_path, &valid_path)?;

    // Load plugins - should only load .wasm files
    load_plugins_from_directory(&plugin_dir, registry.clone()).await?;

    {
        let reg = registry.read().await;
        assert_eq!(
            reg.plugins().len(),
            1,
            "Should only load .wasm files, ignoring other extensions"
        );
    }

    Ok(())
}
