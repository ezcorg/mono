mod tests {
    use crate::db::Db;
    use crate::plugins::registry::PluginRegistry;
    use crate::wasm::Runtime;
    use crate::web::WebServer;
    use crate::{
        test_utils::create_ca_and_config,
    };
    use anyhow::Result;
    use std::sync::Arc;
    use tempfile::tempdir;
    use tokio::sync::RwLock;

    #[tokio::test]
    async fn test_plugin_upsert() -> Result<()> {
        let _ = rustls::crypto::ring::default_provider().install_default();

        // Create CA and config
        let (ca, config) = create_ca_and_config().await;

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

        let component_bytes = std::fs::read(
            "/home/theo/dev/mono/target/wasm32-wasip2/release/wasm_test_component.signed.wasm",
        )
        .unwrap();

        // Create a temporary file with the component bytes for upload
        let temp_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(temp_file.path(), &component_bytes).unwrap();
        
        // Create form with file upload
        let form = reqwest::multipart::Form::new()
            .file("file", temp_file.path())
            .await
            .unwrap();

        // Create HTTP client that accepts self-signed certificates
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .unwrap();

        let response = client
            .post(format!("https://{}/api/plugins", bind_addr))
            .multipart(form)
            .send()
            .await
            .unwrap();

        assert!(
            response.status().is_success(),
            "Expected successful response, got: {} - {}",
            response.status(),
            response
                .text()
                .await
                .unwrap_or_else(|_| "Unable to read response body".to_string())
        );
        Ok(())
    }
}
