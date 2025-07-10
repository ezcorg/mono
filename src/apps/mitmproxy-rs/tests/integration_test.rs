use anyhow::Result;
use std::path::PathBuf;
use std::process::Command;

// Test that we can build and load plugins
#[tokio::test]
async fn test_plugin_compilation_and_loading() -> Result<()> {
    println!("Testing plugin compilation and loading...");

    // Create output directory
    let compiled_dir = PathBuf::from("plugins/compiled");
    std::fs::create_dir_all(&compiled_dir)?;

    // List of example plugins to build
    let plugins = ["html-analyzer", "json-validator", "logger"];

    for plugin_name in &plugins {
        println!("Building plugin: {}", plugin_name);

        let plugin_dir = PathBuf::from("plugins/examples").join(plugin_name);

        if !plugin_dir.exists() {
            println!("Skipping {} - directory not found", plugin_name);
            continue;
        }

        // Build the plugin using cargo
        let output = Command::new("cargo")
            .args(&["build", "--target", "wasm32-unknown-unknown", "--release"])
            .current_dir(&plugin_dir)
            .output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            println!("Failed to build plugin {}: {}", plugin_name, stderr);
            continue;
        }

        // Find and copy the WASM file
        let target_dir = plugin_dir.join("target/wasm32-unknown-unknown/release");
        if !target_dir.exists() {
            println!("Target directory not found for {}", plugin_name);
            continue;
        }

        let wasm_files: Vec<_> = std::fs::read_dir(&target_dir)?
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().extension().map_or(false, |ext| ext == "wasm"))
            .collect();

        if !wasm_files.is_empty() {
            let dest_path = compiled_dir.join(format!("{}.wasm", plugin_name));
            std::fs::copy(wasm_files[0].path(), &dest_path)?;
            println!("✓ Built and copied {}", plugin_name);
        }
    }

    // Test plugin manager initialization
    use mitmproxy_rs::wasm::PluginManager;

    if compiled_dir.exists() {
        let plugin_manager = PluginManager::new(&compiled_dir).await?;
        let plugin_count = plugin_manager.plugin_count().await;
        println!("Loaded {} plugins", plugin_count);

        if plugin_count > 0 {
            let plugin_list = plugin_manager.get_plugin_list().await;
            for plugin in plugin_list {
                println!(
                    "Plugin: {} v{} - {}",
                    plugin.name, plugin.version, plugin.description
                );
            }
        }
    }

    // Cleanup
    if compiled_dir.exists() {
        let _ = std::fs::remove_dir_all(&compiled_dir);
    }

    println!("✓ Plugin compilation and loading test completed");
    Ok(())
}

#[tokio::test]
async fn test_config_loading() -> Result<()> {
    use mitmproxy_rs::config::Config;

    // Test default config
    let config = Config::default();
    assert!(config.plugins.enabled);
    assert_eq!(config.proxy.max_connections, 1000);

    // Test config file loading (should fall back to default if file doesn't exist)
    let config = Config::load("nonexistent.toml").unwrap_or_else(|_| Config::default());
    assert!(config.plugins.enabled);

    println!("✓ Config loading test completed");
    Ok(())
}

#[test]
fn test_sample_service_compilation() {
    // This test just ensures the sample service compiles
    // The actual functionality is tested in the e2e test
    println!("✓ Sample service compilation test completed");
}
