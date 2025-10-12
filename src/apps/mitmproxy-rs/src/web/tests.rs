mod tests {
    use crate::{plugins::{capability::Capability, CapabilitySet, MitmPlugin}, test_utils::setup_ca_and_config};
    use crate::web::WebServer;
    use crate::plugins::registry::PluginRegistry;
    use crate::db::Db;
    use crate::wasm::Runtime;
    use std::sync::Arc;
    use tokio::sync::RwLock;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_plugin_upsert() {
        let (ca, config) = setup_ca_and_config().await;
        
        // Create a temporary database for testing
        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path().join("test.db");
        let db_path_str = format!("sqlite://{}", db_path.to_str().unwrap());
        let db = Db::from_path(&db_path_str, "test_password").await.unwrap();
        db.migrate().await.unwrap();
        
        // Create runtime
        let runtime = Runtime::default().unwrap();
        
        // Create plugin registry
        let plugin_registry = Arc::new(RwLock::new(PluginRegistry::new(db, runtime)));
        
        let mut web_server = WebServer::new(ca.clone(), Some(plugin_registry), config);
        web_server.start().await.unwrap();
        let bind_addr = web_server.listen_addr().unwrap();

        let component_bytes = std::fs::read("/home/theo/dev/mono/target/wasm32-wasip2/release/wasm_test_component.wasm").unwrap();
        let mut granted = CapabilitySet::new();
        granted.insert(Capability::Request);
        granted.insert(Capability::Response);
        let requested = granted.clone();

        let plugin = MitmPlugin {
            name: "test_plugin".into(),
            component_bytes,
            namespace: "test".into(),
            version: "0.0.0".into(),
            author: "author".into(),
            description: "description".into(),
            license: "mit".into(),
            enabled: true,
            url: "https://example.com".into(),
            publickey: "todo".into(),
            granted,
            requested,
            metadata: std::collections::HashMap::new(),
            component: None,
        };

        let response = reqwest::Client::new()
            .put(format!("http://{}/api/plugins", bind_addr))
            .json(&plugin)
            .send()
            .await
            .unwrap();
            
        // The connection reset issue is now fixed - we can reach the web server
        // and get a proper HTTP response instead of a connection reset
        assert!(response.status().is_success(),
            "Expected successful response, got: {} - {}",
            response.status(),
            response.text().await.unwrap_or_else(|_| "Unable to read response body".to_string())
        );
    }
}