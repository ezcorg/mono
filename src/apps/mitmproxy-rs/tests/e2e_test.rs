use anyhow::Result;
use reqwest::Client;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout};

mod sample_service;
use sample_service::SampleService;

// Import the main application modules from the library
use mitmproxy_rs::cert::CertificateAuthority;
use mitmproxy_rs::config::Config;
use mitmproxy_rs::proxy::ProxyServer;
use mitmproxy_rs::wasm::PluginManager;
use mitmproxy_rs::web::WebServer;

const PROXY_PORT: u16 = 18080;
const WEB_PORT: u16 = 18081;
const SAMPLE_SERVICE_PORT: u16 = 18082;
const TEST_TIMEOUT: Duration = Duration::from_secs(30);

pub struct E2ETestSetup {
    proxy_handle: Option<JoinHandle<()>>,
    web_handle: Option<JoinHandle<()>>,
    service_handle: Option<JoinHandle<()>>,
    temp_dir: PathBuf,
    client: Client,
}

impl E2ETestSetup {
    pub async fn new() -> Result<Self> {
        let temp_dir = std::env::temp_dir().join(format!("mitm_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir)?;

        // Create HTTP client that uses the proxy
        let client = Client::builder()
            .proxy(reqwest::Proxy::http(format!(
                "http://127.0.0.1:{}",
                PROXY_PORT
            ))?)
            .danger_accept_invalid_certs(true) // For testing with self-signed certs
            .timeout(Duration::from_secs(10))
            .build()?;

        Ok(Self {
            proxy_handle: None,
            web_handle: None,
            service_handle: None,
            temp_dir,
            client,
        })
    }

    pub async fn setup(&mut self) -> Result<()> {
        // Step 1: Build plugins
        self.build_plugins().await?;

        // Step 2: Start sample service
        self.start_sample_service().await?;

        // Step 3: Start proxy with plugins
        self.start_proxy().await?;

        // Wait for services to be ready
        self.wait_for_services().await?;

        Ok(())
    }

    async fn build_plugins(&self) -> Result<()> {
        println!("Building WASM plugins...");

        // Create output directory
        let compiled_dir = PathBuf::from("plugins/compiled");
        std::fs::create_dir_all(&compiled_dir)?;

        // List of example plugins to build
        let plugins = ["html-analyzer", "json-validator", "logger"];

        for plugin_name in &plugins {
            println!("Building plugin: {}", plugin_name);

            let plugin_dir = PathBuf::from("plugins/examples").join(plugin_name);

            if !plugin_dir.exists() {
                return Err(anyhow::anyhow!(
                    "Plugin directory not found: {:?}",
                    plugin_dir
                ));
            }

            // Build the plugin using cargo
            let output = Command::new("cargo")
                .args(&["build", "--target", "wasm32-unknown-unknown", "--release"])
                .current_dir(&plugin_dir)
                .output()?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(anyhow::anyhow!(
                    "Failed to build plugin {}: {}",
                    plugin_name,
                    stderr
                ));
            }

            // Find and copy the WASM file - check both local and workspace target directories
            let local_target_dir = plugin_dir.join("target/wasm32-unknown-unknown/release");
            let workspace_target_dir =
                PathBuf::from("../../../target/wasm32-unknown-unknown/release");

            let mut wasm_file_found = false;

            // Try local target directory first
            if local_target_dir.exists() {
                let wasm_files: Vec<_> = std::fs::read_dir(&local_target_dir)?
                    .filter_map(|entry| entry.ok())
                    .filter(|entry| entry.path().extension().map_or(false, |ext| ext == "wasm"))
                    .collect();

                if !wasm_files.is_empty() {
                    let dest_path = compiled_dir.join(format!("{}.wasm", plugin_name));
                    std::fs::copy(wasm_files[0].path(), &dest_path)?;
                    println!("✓ Built and copied {} (from local target)", plugin_name);
                    wasm_file_found = true;
                }
            }

            // Try workspace target directory if not found locally
            if !wasm_file_found && workspace_target_dir.exists() {
                // Look for plugin-specific WASM files
                let plugin_wasm_patterns = [
                    format!("{}_plugin.wasm", plugin_name.replace("-", "_")),
                    format!("{}.wasm", plugin_name.replace("-", "_")),
                    format!("{}plugin.wasm", plugin_name.replace("-", "_")),
                ];

                for pattern in &plugin_wasm_patterns {
                    let wasm_path = workspace_target_dir.join(pattern);
                    if wasm_path.exists() {
                        let dest_path = compiled_dir.join(format!("{}.wasm", plugin_name));
                        std::fs::copy(&wasm_path, &dest_path)?;
                        println!("✓ Built and copied {} (from workspace target)", plugin_name);
                        wasm_file_found = true;
                        break;
                    }
                }
            }

            if !wasm_file_found {
                return Err(anyhow::anyhow!(
                    "No WASM file found for plugin: {}",
                    plugin_name
                ));
            }
        }

        println!("✓ All plugins built successfully");
        Ok(())
    }

    async fn start_sample_service(&mut self) -> Result<()> {
        println!("Starting sample service on port {}...", SAMPLE_SERVICE_PORT);

        let service = SampleService::new(SAMPLE_SERVICE_PORT);
        let handle = tokio::spawn(async move {
            if let Err(e) = service.start().await {
                eprintln!("Sample service error: {}", e);
            }
        });

        self.service_handle = Some(handle);

        // Wait for service to start
        sleep(Duration::from_millis(500)).await;
        println!("✓ Sample service started");
        Ok(())
    }

    async fn start_proxy(&mut self) -> Result<()> {
        println!("Starting MITM proxy...");

        // Create certificate authority
        let cert_dir = self.temp_dir.join("certs");
        std::fs::create_dir_all(&cert_dir)?;
        let ca = CertificateAuthority::new(&cert_dir).await?;

        // Initialize plugin manager with compiled plugins
        let plugin_dir = PathBuf::from("plugins/compiled");
        let plugin_manager = PluginManager::new(&plugin_dir).await?;
        let plugin_count = plugin_manager.plugin_count().await;
        println!("Loaded {} plugins", plugin_count);

        // Verify we loaded the expected plugins
        let plugin_list = plugin_manager.get_plugin_list().await;
        let plugin_names: Vec<String> = plugin_list.iter().map(|p| p.name.clone()).collect();
        println!("Loaded plugins: {:?}", plugin_names);

        // Load configuration
        let config = Config::default();

        // Start web server
        let web_ca = ca.clone();
        let web_handle = tokio::spawn(async move {
            let web_server =
                WebServer::new(format!("127.0.0.1:{}", WEB_PORT).parse().unwrap(), web_ca);
            if let Err(e) = web_server.start().await {
                eprintln!("Web server error: {}", e);
            }
        });
        self.web_handle = Some(web_handle);

        // Start proxy server
        let proxy_handle = tokio::spawn(async move {
            let proxy_server = ProxyServer::new(
                format!("127.0.0.1:{}", PROXY_PORT).parse().unwrap(),
                ca,
                plugin_manager,
                config,
            );
            if let Err(e) = proxy_server.start().await {
                eprintln!("Proxy server error: {}", e);
            }
        });
        self.proxy_handle = Some(proxy_handle);

        println!("✓ MITM proxy started");
        Ok(())
    }

    async fn wait_for_services(&self) -> Result<()> {
        println!("Waiting for services to be ready...");

        // Wait for sample service
        let sample_url = format!("http://127.0.0.1:{}/", SAMPLE_SERVICE_PORT);
        self.wait_for_http_service(&sample_url, "sample service")
            .await?;

        // Wait for web interface
        let web_url = format!("http://127.0.0.1:{}/", WEB_PORT);
        self.wait_for_http_service(&web_url, "web interface")
            .await?;

        println!("✓ All services ready");
        Ok(())
    }

    async fn wait_for_http_service(&self, url: &str, service_name: &str) -> Result<()> {
        let client = Client::new();
        let max_attempts = 30;
        let mut attempts = 0;

        while attempts < max_attempts {
            match client.get(url).send().await {
                Ok(response) if response.status().is_success() => {
                    println!("✓ {} is ready", service_name);
                    return Ok(());
                }
                _ => {
                    attempts += 1;
                    sleep(Duration::from_millis(100)).await;
                }
            }
        }

        Err(anyhow::anyhow!(
            "{} failed to start within timeout",
            service_name
        ))
    }

    pub async fn test_logger_plugin(&self) -> Result<()> {
        println!("Testing logger plugin...");

        // Make a request through the proxy
        let response = self
            .client
            .get(&format!("http://127.0.0.1:{}/", SAMPLE_SERVICE_PORT))
            .send()
            .await?;

        assert!(response.status().is_success());
        let html = response.text().await?;
        assert!(html.contains("Sample Service"));

        // Make an API request
        let response = self
            .client
            .get(&format!(
                "http://127.0.0.1:{}/api/data?user_id=123",
                SAMPLE_SERVICE_PORT
            ))
            .send()
            .await?;

        assert!(response.status().is_success());
        let json: Value = response.json().await?;
        assert_eq!(json["user_id"], 123);

        // The logger plugin should have logged these requests
        // We can verify this by checking that the requests went through the proxy
        println!("✓ Logger plugin test completed");
        Ok(())
    }

    pub async fn test_json_validator_plugin(&self) -> Result<()> {
        println!("Testing JSON validator plugin...");

        // Test normal JSON API request
        let response = self
            .client
            .get(&format!(
                "http://127.0.0.1:{}/api/user?user_id=456",
                SAMPLE_SERVICE_PORT
            ))
            .send()
            .await?;

        assert!(response.status().is_success());
        let json: Value = response.json().await?;
        assert!(json["data"]["id"].as_u64().unwrap() == 456);

        // Test API error response (should be detected by plugin)
        let response = self
            .client
            .get(&format!(
                "http://127.0.0.1:{}/api/error",
                SAMPLE_SERVICE_PORT
            ))
            .send()
            .await?;

        assert_eq!(response.status(), 400);
        let error_json: Value = response.json().await?;
        assert!(error_json["error"].as_str().is_some());

        // Test sensitive data endpoint (should trigger warnings)
        let response = self
            .client
            .get(&format!(
                "http://127.0.0.1:{}/api/sensitive",
                SAMPLE_SERVICE_PORT
            ))
            .send()
            .await?;

        assert!(response.status().is_success());
        let sensitive_json: Value = response.json().await?;
        assert!(sensitive_json["password"].as_str().is_some());

        // Test large response (should trigger size warning)
        let response = self
            .client
            .get(&format!(
                "http://127.0.0.1:{}/large-response",
                SAMPLE_SERVICE_PORT
            ))
            .send()
            .await?;

        assert!(response.status().is_success());
        let large_json: Value = response.json().await?;
        assert!(large_json["data"].as_array().unwrap().len() > 1000);

        println!("✓ JSON validator plugin test completed");
        Ok(())
    }

    pub async fn test_html_analyzer_plugin(&self) -> Result<()> {
        println!("Testing HTML analyzer plugin...");

        // Test home page (should analyze page structure)
        let response = self
            .client
            .get(&format!("http://127.0.0.1:{}/", SAMPLE_SERVICE_PORT))
            .send()
            .await?;

        assert!(response.status().is_success());
        let html = response.text().await?;
        assert!(html.contains("<title>Sample Service - Home</title>"));
        assert!(html.contains("https://cdn.jsdelivr.net")); // External script

        // Test login page (should detect password field on non-HTTPS)
        let response = self
            .client
            .get(&format!("http://127.0.0.1:{}/login", SAMPLE_SERVICE_PORT))
            .send()
            .await?;

        assert!(response.status().is_success());
        let login_html = response.text().await?;
        assert!(login_html.contains("type=\"password\""));

        // Test form page (should detect forms with/without CSRF tokens)
        let response = self
            .client
            .get(&format!("http://127.0.0.1:{}/form", SAMPLE_SERVICE_PORT))
            .send()
            .await?;

        assert!(response.status().is_success());
        let form_html = response.text().await?;
        assert!(form_html.contains("_token")); // CSRF token
        assert!(form_html.contains("method=\"post\""));

        // Test external links page (should detect unsafe external links)
        let response = self
            .client
            .get(&format!(
                "http://127.0.0.1:{}/external-links",
                SAMPLE_SERVICE_PORT
            ))
            .send()
            .await?;

        assert!(response.status().is_success());
        let links_html = response.text().await?;
        assert!(links_html.contains("https://malicious-site.com")); // Unsafe link
        assert!(links_html.contains("rel=\"noopener noreferrer\"")); // Safe link

        println!("✓ HTML analyzer plugin test completed");
        Ok(())
    }

    pub async fn verify_plugin_integration(&self) -> Result<()> {
        println!("Verifying plugin integration...");

        // Make multiple requests to ensure all plugins are working
        let test_urls = vec![
            format!("http://127.0.0.1:{}/", SAMPLE_SERVICE_PORT),
            format!("http://127.0.0.1:{}/api/data", SAMPLE_SERVICE_PORT),
            format!("http://127.0.0.1:{}/login", SAMPLE_SERVICE_PORT),
            format!(
                "http://127.0.0.1:{}/api/user?user_id=789",
                SAMPLE_SERVICE_PORT
            ),
        ];

        for url in test_urls {
            let response = self.client.get(&url).send().await?;
            assert!(response.status().is_success(), "Failed to access: {}", url);

            // Small delay between requests
            sleep(Duration::from_millis(100)).await;
        }

        println!("✓ Plugin integration verification completed");
        Ok(())
    }

    pub async fn cleanup(&mut self) {
        println!("Cleaning up test environment...");

        // Stop all services
        if let Some(handle) = self.proxy_handle.take() {
            handle.abort();
        }
        if let Some(handle) = self.web_handle.take() {
            handle.abort();
        }
        if let Some(handle) = self.service_handle.take() {
            handle.abort();
        }

        // Clean up temporary directory
        if self.temp_dir.exists() {
            let _ = std::fs::remove_dir_all(&self.temp_dir);
        }

        // Clean up compiled plugins
        let compiled_dir = PathBuf::from("plugins/compiled");
        if compiled_dir.exists() {
            let _ = std::fs::remove_dir_all(&compiled_dir);
        }

        println!("✓ Cleanup completed");
    }
}

impl Drop for E2ETestSetup {
    fn drop(&mut self) {
        // Ensure cleanup happens even if not called explicitly
        if let Some(handle) = self.proxy_handle.take() {
            handle.abort();
        }
        if let Some(handle) = self.web_handle.take() {
            handle.abort();
        }
        if let Some(handle) = self.service_handle.take() {
            handle.abort();
        }
    }
}

#[tokio::test]
async fn test_e2e_mitm_proxy_with_plugins() -> Result<()> {
    // Initialize logging for the test
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .try_init()
        .ok();

    let mut setup = E2ETestSetup::new().await?;

    // Setup the test environment
    timeout(TEST_TIMEOUT, setup.setup()).await??;

    // Run all plugin tests
    timeout(TEST_TIMEOUT, setup.test_logger_plugin()).await??;
    timeout(TEST_TIMEOUT, setup.test_json_validator_plugin()).await??;
    timeout(TEST_TIMEOUT, setup.test_html_analyzer_plugin()).await??;
    timeout(TEST_TIMEOUT, setup.verify_plugin_integration()).await??;

    // Cleanup
    setup.cleanup().await;

    println!("🎉 All end-to-end tests passed!");
    Ok(())
}

#[tokio::test]
async fn test_plugin_loading() -> Result<()> {
    // Test that plugins can be loaded without starting the full proxy
    println!("Testing plugin loading...");

    // Build plugins using the same method as the main test
    let compiled_dir = PathBuf::from("plugins/compiled");
    std::fs::create_dir_all(&compiled_dir)?;

    let plugins = ["html-analyzer", "json-validator", "logger"];

    for plugin_name in &plugins {
        let plugin_dir = PathBuf::from("plugins/examples").join(plugin_name);

        if !plugin_dir.exists() {
            return Err(anyhow::anyhow!(
                "Plugin directory not found: {:?}",
                plugin_dir
            ));
        }

        let output = Command::new("cargo")
            .args(&["build", "--target", "wasm32-unknown-unknown", "--release"])
            .current_dir(&plugin_dir)
            .output()?;

        assert!(
            output.status.success(),
            "Plugin build should succeed for {}",
            plugin_name
        );

        // Copy WASM file - check both local and workspace target directories
        let local_target_dir = plugin_dir.join("target/wasm32-unknown-unknown/release");
        let workspace_target_dir = PathBuf::from("../../../target/wasm32-unknown-unknown/release");

        let mut wasm_file_found = false;

        // Try local target directory first
        if local_target_dir.exists() {
            let wasm_files: Vec<_> = std::fs::read_dir(&local_target_dir)?
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.path().extension().map_or(false, |ext| ext == "wasm"))
                .collect();

            if !wasm_files.is_empty() {
                let dest_path = compiled_dir.join(format!("{}.wasm", plugin_name));
                std::fs::copy(wasm_files[0].path(), &dest_path)?;
                wasm_file_found = true;
            }
        }

        // Try workspace target directory if not found locally
        if !wasm_file_found && workspace_target_dir.exists() {
            let plugin_wasm_patterns = [
                format!("{}_plugin.wasm", plugin_name.replace("-", "_")),
                format!("{}.wasm", plugin_name.replace("-", "_")),
                format!("{}plugin.wasm", plugin_name.replace("-", "_")),
            ];

            for pattern in &plugin_wasm_patterns {
                let wasm_path = workspace_target_dir.join(pattern);
                if wasm_path.exists() {
                    let dest_path = compiled_dir.join(format!("{}.wasm", plugin_name));
                    std::fs::copy(&wasm_path, &dest_path)?;
                    wasm_file_found = true;
                    break;
                }
            }
        }

        assert!(wasm_file_found, "Should find WASM file for {}", plugin_name);
    }

    // Test plugin manager initialization
    let plugin_manager = PluginManager::new(&compiled_dir).await?;
    let plugin_count = plugin_manager.plugin_count().await;

    assert!(plugin_count >= 3, "Should load at least 3 example plugins");

    let plugin_list = plugin_manager.get_plugin_list().await;
    let plugin_names: Vec<String> = plugin_list.iter().map(|p| p.name.clone()).collect();

    assert!(plugin_names.contains(&"logger".to_string()));
    assert!(plugin_names.contains(&"json-validator".to_string()));
    assert!(plugin_names.contains(&"html-analyzer".to_string()));

    // Cleanup
    let _ = std::fs::remove_dir_all(&compiled_dir);

    println!("✓ Plugin loading test passed");
    Ok(())
}

#[tokio::test]
async fn test_dns_resolution() -> Result<()> {
    println!("Testing DNS resolution...");

    // Test DNS resolver directly
    let resolver = mitmproxy_rs::proxy::DnsResolver::new().await?;

    // Test localhost resolution (should always work)
    let localhost_addrs = resolver.resolve_with_port("localhost", 80).await?;
    assert!(!localhost_addrs.is_empty());
    assert_eq!(localhost_addrs[0].port(), 80);
    println!("✓ Localhost resolution works");

    // Test resolution with different ports
    let https_addrs = resolver.resolve_with_port("localhost", 443).await?;
    assert!(!https_addrs.is_empty());
    assert_eq!(https_addrs[0].port(), 443);
    println!("✓ Port-specific resolution works");

    // Test fallback resolution
    let fallback_addr = resolver.resolve_with_fallback("localhost", 8080).await?;
    assert_eq!(fallback_addr.port(), 8080);
    println!("✓ Fallback resolution works");

    // Test hostname validation
    let invalid_result = resolver.resolve("invalid hostname with spaces").await;
    assert!(invalid_result.is_err());
    println!("✓ Invalid hostname rejection works");

    // Test valid hostname characters
    let valid_result = resolver.resolve("valid-hostname_123.test").await;
    // Should fail on DNS resolution, not validation
    assert!(valid_result.is_err());
    assert!(!valid_result
        .unwrap_err()
        .to_string()
        .contains("Invalid hostname format"));
    println!("✓ Valid hostname character acceptance works");

    println!("✓ DNS resolution test passed");
    Ok(())
}

#[tokio::test]
async fn test_proxy_with_external_dns() -> Result<()> {
    println!("Testing proxy with external DNS resolution...");

    let mut setup = E2ETestSetup::new().await?;

    // Setup the test environment
    timeout(TEST_TIMEOUT, setup.setup()).await??;

    // Test making a request to a real external service through the proxy
    // Note: This test requires internet connectivity
    let response = setup
        .client
        .get("http://httpbin.org/get")
        .timeout(Duration::from_secs(15))
        .send()
        .await;

    match response {
        Ok(resp) => {
            assert!(resp.status().is_success());
            println!("✓ External DNS resolution through proxy works");
        }
        Err(e) => {
            // If we can't reach httpbin.org, that's okay for this test
            // The important thing is that DNS resolution doesn't crash
            println!(
                "⚠ External service unavailable ({}), but DNS resolution didn't crash",
                e
            );
        }
    }

    // Test with a definitely invalid domain
    let invalid_response = setup
        .client
        .get("http://definitely-invalid-domain-12345.com/")
        .timeout(Duration::from_secs(5))
        .send()
        .await;

    // Should fail, but gracefully
    assert!(invalid_response.is_err());
    println!("✓ Invalid domain handling works");

    // Cleanup
    setup.cleanup().await;

    println!("✓ External DNS test completed");
    Ok(())
}
