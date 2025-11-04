mod tests {
    use crate::{
        Db, Runtime, cli::ResolvedCli, config::confique_partial_app_config::PartialAppConfig, plugins::WitmPlugin, test_utils::test_component_path, AppConfig
    };
    use confique::{Config, Partial};
    use tempfile::{tempdir};
    use std::path::Path;

    /// Test helper that creates a ResolvedCli with test configuration
    async fn create_test_cli(temp_path: &Path) -> ResolvedCli {
        let db_path = temp_path.join("test.db");
        let mut partial_config = PartialAppConfig::default_values();
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
        }
    }

    #[tokio::test]
    async fn test_witm_plugin_add_local_wasm() {
        // Create a temporary directory for the test config
        let temp_dir = tempdir().unwrap();
        let temp_path = temp_dir.path();

        // Create resolved CLI instance with test configuration
        let cli = create_test_cli(temp_path).await;

        // Test path to the signed WASM component
        let wasm_path = test_component_path();

        // Check if the test WASM file exists before running the test
        if !std::path::Path::new(&wasm_path).exists() {
            panic!(
                "WASM test component not found at {}, build it first",
                wasm_path
            );
        }

        // Test adding the plugin
        let result = cli.add_plugin(&wasm_path).await;

        match result {
            Ok(()) => {
                // Verify the plugin was actually added to the database
                let db_file_path = temp_path.join("test.db");
                let db_url = format!("sqlite://{}", db_file_path.display());
                let mut db = Db::from_path(&db_url, "test_password").await.unwrap();

                // Create runtime to check plugins
                let runtime = Runtime::default().unwrap();
                let plugins = WitmPlugin::all(&mut db, &runtime.engine).await.unwrap();

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
            }
            Err(e) => {
                panic!("Failed to add plugin: {}", e);
            }
        }
    }

    #[tokio::test]
    async fn test_witm_plugin_add_nonexistent_file() {
        let temp_dir = tempdir().unwrap();
        let temp_path = temp_dir.path();

        // Create resolved CLI instance with test configuration
        let cli = create_test_cli(temp_path).await;

        // Test with non-existent file
        let result = cli.add_plugin("/nonexistent/file.wasm").await;

        assert!(result.is_err(), "Should fail for non-existent file");
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("File does not exist"));
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
        let result = cli.add_plugin(dummy_file.to_str().unwrap()).await;

        assert!(result.is_err(), "Should fail for non-WASM file");
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Only .wasm files are supported"));
    }

    #[tokio::test]
    async fn test_witm_plugin_remove_by_name() {
        let temp_dir = tempdir().unwrap();
        let temp_path = temp_dir.path();

        // Create resolved CLI instance with test configuration
        let cli = create_test_cli(temp_path).await;

        // Test path to the signed WASM component
        let wasm_path = test_component_path();

        // Check if the test WASM file exists before running the test
        if !std::path::Path::new(&wasm_path).exists() {
            panic!(
                "WASM test component not found at {}, build it first",
                wasm_path
            );
        }

        // Add the plugin first
        let result = cli.add_plugin(&wasm_path).await;
        assert!(result.is_ok(), "Failed to add plugin: {:?}", result.err());

        // Verify plugin was added
        let db_file_path = temp_path.join("test.db");
        let db_url = format!("sqlite://{}", db_file_path.display());
        let mut db = Db::from_path(&db_url, "test_password").await.unwrap();

        let runtime = Runtime::default().unwrap();
        let plugins_before = WitmPlugin::all(&mut db, &runtime.engine).await.unwrap();
        assert!(!plugins_before.is_empty(), "No plugins found after adding");

        let test_plugin = &plugins_before[0];
        let plugin_name = &test_plugin.name;

        // Test removing the plugin by name
        let remove_result = cli.remove_plugin(plugin_name).await;
        assert!(
            remove_result.is_ok(),
            "Failed to remove plugin: {:?}",
            remove_result.err()
        );

        // Verify plugin was removed
        let plugins_after = WitmPlugin::all(&mut db, &runtime.engine).await.unwrap();
        assert!(
            plugins_after.is_empty(),
            "Plugin was not removed from database"
        );
    }

    #[tokio::test]
    async fn test_witm_plugin_remove_by_namespace_name() {
        let temp_dir = tempdir().unwrap();
        let temp_path = temp_dir.path();

        // Create resolved CLI instance with test configuration
        let cli = create_test_cli(temp_path).await;

        // Test path to the signed WASM component
        let wasm_path = test_component_path();

        // Check if the test WASM file exists before running the test
        if !std::path::Path::new(&wasm_path).exists() {
            panic!(
                "WASM test component not found at {}, build it first",
                wasm_path
            );
        }

        // Add the plugin first
        let result = cli.add_plugin(&wasm_path).await;
        assert!(result.is_ok(), "Failed to add plugin: {:?}", result.err());

        // Verify plugin was added and get its full ID
        let db_file_path = temp_path.join("test.db");
        let db_url = format!("sqlite://{}", db_file_path.display());
        let mut db = Db::from_path(&db_url, "test_password").await.unwrap();

        let runtime = Runtime::default().unwrap();
        let plugins_before = WitmPlugin::all(&mut db, &runtime.engine).await.unwrap();
        assert!(!plugins_before.is_empty(), "No plugins found after adding");

        let test_plugin = &plugins_before[0];
        let full_plugin_id = format!("{}/{}", test_plugin.namespace, test_plugin.name);

        // Test removing the plugin by namespace/name
        let remove_result = cli.remove_plugin(&full_plugin_id).await;
        assert!(
            remove_result.is_ok(),
            "Failed to remove plugin: {:?}",
            remove_result.err()
        );

        // Verify plugin was removed
        let plugins_after = WitmPlugin::all(&mut db, &runtime.engine).await.unwrap();
        assert!(
            plugins_after.is_empty(),
            "Plugin was not removed from database"
        );
    }

    #[tokio::test]
    async fn test_witm_plugin_remove_nonexistent() {
        let temp_dir = tempdir().unwrap();
        let temp_path = temp_dir.path();

        // Create resolved CLI instance with test configuration
        let cli = create_test_cli(temp_path).await;

        // Test removing a nonexistent plugin
        let remove_result = cli.remove_plugin("nonexistent_plugin").await;
        assert!(
            remove_result.is_err(),
            "Should fail when removing nonexistent plugin"
        );
        assert!(remove_result
            .unwrap_err()
            .to_string()
            .contains("No plugin found"));
    }
}
