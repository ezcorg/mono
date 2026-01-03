mod tests {
    use crate::{
        AppConfig, Db, Runtime,
        cli::{Commands, ResolvedCli, load_plugins_from_directory, plugin::PluginCommands},
        config::confique_app_config_layer::AppConfigLayer,
        plugins::{WitmPlugin, registry::PluginRegistry},
        test_utils::test_component_path,
        wasm::bindgen::Event,
    };
    use anyhow::Result;
    use cel_cxx::{Env, EnvBuilder};
    use confique::{Config, Layer};
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use tempfile::tempdir;
    use tokio::sync::RwLock;

    /// Helper function to create a static CEL environment for tests
    fn create_static_cel_env() -> Result<&'static Env<'static>> {
        let env = Event::register(EnvBuilder::new())?.build()?;
        // Leak the env to get a static reference since it contains only static data
        // and we want it to live for the program duration
        Ok(Box::leak(Box::new(env)))
    }

    /// Test helper that creates a ResolvedCli with test configuration
    async fn create_test_cli(temp_path: &Path) -> ResolvedCli {
        create_test_cli_with_options(temp_path, None, false).await
    }

    /// Test helper that creates a ResolvedCli with test configuration and options
    async fn create_test_cli_with_options(
        temp_path: &Path,
        plugin_dir: Option<PathBuf>,
        auto: bool,
    ) -> ResolvedCli {
        let db_path = temp_path.join("test.db");
        let mut partial_config = AppConfigLayer::default_values();
        partial_config.db.db_path = Some(db_path);
        partial_config.db.db_password = Some("test_password".to_string());

        // Create a resolved config directly for testing
        let config = AppConfig::builder()
            .preloaded(partial_config)
            .load()
            .expect("Failed to load test config")
            .with_resolved_paths()
            .expect("Failed to resolve paths in test config");

        ResolvedCli {
            command: None,
            config,
            verbose: true,
            plugin_dir,
            auto,
        }
    }

    #[tokio::test]
    async fn test_witm_plugin_add_local_wasm() -> Result<()> {
        // Create a temporary directory for the test config
        let temp_dir = tempdir().unwrap();
        let temp_path = temp_dir.path();

        // Create resolved CLI instance with test configuration
        let cli = create_test_cli(temp_path).await;

        // Test path to the signed WASM component
        let wasm_path = test_component_path()?;

        // Test adding the plugin
        let command = Commands::Plugin {
            command: PluginCommands::Add {
                source: wasm_path.clone(),
            },
        };
        cli.handle_command(&command).await?;
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

        // Check that at least one plugin was added
        let test_plugin = plugins
            .iter()
            .find(|p| p.name.contains("test") || p.namespace.contains("test"));
        assert!(test_plugin.is_some(), "Test plugin not found in database");

        if let Some(plugin) = test_plugin {
            assert!(
                !plugin.component_bytes.is_empty(),
                "Plugin component bytes should not be empty"
            );
            assert!(
                !plugin.publickey.is_empty(),
                "Plugin should have a public key"
            );
        }
        Ok(())
    }

    #[tokio::test]
    async fn test_witm_plugin_add_nonexistent_file() {
        let temp_dir = tempdir().unwrap();
        let temp_path = temp_dir.path();

        // Create resolved CLI instance with test configuration
        let cli = create_test_cli(temp_path).await;
        let command = Commands::Plugin {
            command: PluginCommands::Add {
                source: "/nonexistent/file.wasm".to_string(),
            },
        };

        // Test with non-existent file
        let result = cli.handle_command(&command).await;

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

        // Create resolved CLI instance with test configuration
        let cli = create_test_cli(temp_path).await;

        // Test with non-WASM file
        let command = Commands::Plugin {
            command: PluginCommands::Add {
                source: dummy_file.to_str().unwrap().to_string(),
            },
        };
        let result = cli.handle_command(&command).await;

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

        // Create resolved CLI instance with test configuration
        let cli = create_test_cli(temp_path).await;

        // Test path to the signed WASM component
        let wasm_path = test_component_path()?;

        // Add the plugin first
        let add_command = Commands::Plugin {
            command: PluginCommands::Add {
                source: wasm_path.clone(),
            },
        };
        let result = cli.handle_command(&add_command).await;
        assert!(result.is_ok(), "Failed to add plugin: {:?}", result.err());

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
        let remove_command = Commands::Plugin {
            command: PluginCommands::Remove {
                plugin_name: plugin_name.clone(),
            },
        };
        let remove_result = cli.handle_command(&remove_command).await;
        assert!(
            remove_result.is_ok(),
            "Failed to remove plugin: {:?}",
            remove_result.err()
        );

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

        // Create resolved CLI instance with test configuration
        let cli = create_test_cli(temp_path).await;

        // Test path to the signed WASM component
        let wasm_path = test_component_path()?;

        // Add the plugin first
        let add_command = Commands::Plugin {
            command: PluginCommands::Add {
                source: wasm_path.clone(),
            },
        };
        let result = cli.handle_command(&add_command).await;
        assert!(result.is_ok(), "Failed to add plugin: {:?}", result.err());

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
        let remove_command = Commands::Plugin {
            command: PluginCommands::Remove {
                plugin_name: full_plugin_id.clone(),
            },
        };
        let remove_result = cli.handle_command(&remove_command).await;
        assert!(
            remove_result.is_ok(),
            "Failed to remove plugin: {:?}",
            remove_result.err()
        );

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

        // Create resolved CLI instance with test configuration
        let cli = create_test_cli(temp_path).await;

        // Test removing a nonexistent plugin
        let remove_command = Commands::Plugin {
            command: PluginCommands::Remove {
                plugin_name: "nonexistent_plugin".to_string(),
            },
        };
        let remove_result = cli.handle_command(&remove_command).await;
        assert!(
            remove_result.is_ok(),
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

            // Verify plugin was loaded correctly
            let plugin = reg.plugins().values().next().unwrap();
            assert!(
                !plugin.component_bytes.is_empty(),
                "Plugin component bytes should not be empty"
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
}
