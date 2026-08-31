use crate::db::Db;
use crate::plugins::registry::PluginRegistry;
use crate::test_utils::{create_ca_and_config, test_component_path};
use crate::wasm::Runtime;
use crate::web::WebServer;
use anyhow::Result;
use std::sync::Arc;
use tempfile::tempdir;

#[tokio::test]
async fn test_plugin_upsert() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Create CA and config
    let (ca, config) = create_ca_and_config().await;

    // Create a temporary database for testing
    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("test.db");
    let db = Db::from_path(db_path, "test_password").await.unwrap();
    db.migrate().await.unwrap();

    // Create runtime
    let runtime = Runtime::try_default().unwrap();

    // Create plugin registry
    let plugin_registry = Arc::new(PluginRegistry::new(db, runtime)?);

    let mut web_server = WebServer::new(ca.clone(), Some(plugin_registry), config);
    web_server.start().await.unwrap();
    let bind_addr = web_server.listen_addr().unwrap();

    let wasm_path = test_component_path()?;
    let component_bytes = std::fs::read(&wasm_path)?;

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

/// PUT /api/manage/config must update the *running* process's config, so a
/// subsequent GET reflects the change (not just persist to disk while the
/// running server keeps serving the startup snapshot).
#[tokio::test]
async fn config_update_is_reflected_in_running_process() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let (ca, mut config) = create_ca_and_config().await;
    config.auth.enabled = false; // reachable without a token for the test
    config.plugins.timeout_ms = 1000;

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("test.db");
    let db = Db::from_path(db_path, "test_password").await.unwrap();
    db.migrate().await.unwrap();
    let pool = db.pool.clone();

    let runtime = Runtime::try_default().unwrap();
    let plugin_registry = Arc::new(PluginRegistry::new(db, runtime).unwrap());

    let cfg_path = temp_dir.path().join("config.toml");
    let mut web_server = WebServer::new(ca, Some(plugin_registry), config)
        .with_config_path(cfg_path.clone());
    web_server = web_server.with_db_pool(pool);
    web_server.start().await.unwrap();
    let bind_addr = web_server.listen_addr().unwrap();
    // Keep the server alive for the rest of the test; the process
    // exits at the end, so leaking it is the intent.
    #[allow(clippy::mem_forget, reason = "test fixture outlives the test body")]
    std::mem::forget(web_server);

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .unwrap();
    let base = format!("https://{}", bind_addr);

    // Sanity: GET reports the startup value.
    let got: serde_json::Value = client
        .get(format!("{}/api/manage/config", base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(got["plugins_timeout_ms"], 1000);

    // Change the value via PUT.
    let mut updated = got.clone();
    updated["plugins_timeout_ms"] = serde_json::json!(7777);
    let put = client
        .put(format!("{}/api/manage/config", base))
        .json(&updated)
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 200, "PUT /api/manage/config should succeed");

    // GET again: the running process must reflect the new value.
    let after: serde_json::Value = client
        .get(format!("{}/api/manage/config", base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        after["plugins_timeout_ms"], 7777,
        "running process config should reflect the PUT update"
    );
    Ok(())
}
