//! End-to-end happy-path tests for ezfilter.
//!
//! Each test spins up a real witmproxy backend, launches the ezfilter Tauri app
//! via tauri-driver, and drives the UI through WebDriver.
//!
//! ## Requirements
//!
//! - `tauri-driver` on PATH (`cargo install tauri-driver`)
//! - Built ezfilter binary (`cargo build` in `src-tauri/`)
//! - WASM test plugins built (`cargo build --target wasm32-wasip2` in the plugin crates)
//!
//! Tests skip gracefully when requirements aren't met.

use std::time::Duration;

use anyhow::Result;
use ezfilter_e2e::*;

/// Guard that skips the test if prerequisites aren't available.
fn prerequisites() -> Option<String> {
    init_tracing();
    if !require_tauri_driver() {
        return None;
    }
    ezfilter_binary_path()
}

/// Register a user account via the witmproxy web API.
/// Returns the auth token and tenant_id.
async fn register_user(
    web_addr: std::net::SocketAddr,
    ca: &witmproxy::CertificateAuthority,
    email: &str,
    password: &str,
) -> Result<(String, String)> {
    let cert_pem = ca.get_root_certificate_pem()?;
    let cert = reqwest::tls::Certificate::from_pem(cert_pem.as_bytes())?;
    let client = reqwest::Client::builder()
        .add_root_certificate(cert)
        .danger_accept_invalid_certs(true)
        .build()?;

    let resp = client
        .post(format!(
            "https://127.0.0.1:{}/api/auth/register",
            web_addr.port()
        ))
        .json(&serde_json::json!({
            "email": email,
            "password": password,
            "display_name": email,
        }))
        .send()
        .await?;

    let body: serde_json::Value = resp.json().await?;
    let token = body["token"].as_str().unwrap_or_default().to_string();
    let tenant_id = body["tenant_id"].as_str().unwrap_or_default().to_string();
    Ok((token, tenant_id))
}

// ---------------------------------------------------------------------------
// 1. Onboarding: self-hosted login → land on plugins page
// ---------------------------------------------------------------------------

#[tokio::test]
async fn onboarding_selfhosted_login() -> Result<()> {
    let Some(binary) = prerequisites() else {
        eprintln!("SKIP: prerequisites not met");
        return Ok(());
    };

    // Start a real witmproxy backend
    let env = TestEnv::start().await?;
    let server_url = web_url(env.web_addr());

    // Register a test account via the API
    let test_email = "test@example.com";
    let test_password = "testpassword123";
    register_user(env.web_addr(), env.ca(), test_email, test_password).await?;

    // Launch the app
    let app = EzfilterApp::launch(&binary).await?;

    // Wait for loading screen to pass
    tokio::time::sleep(Duration::from_secs(3)).await;

    // Step 1: Select "Self-hosted" and Continue
    app.click("[data-value='self-host']").await.ok();
    tokio::time::sleep(Duration::from_millis(300)).await;
    click_button_with_text(&app, "Continue").await;
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Step 2: "Yes, I have a server"
    click_button_with_text(&app, "Yes").await;
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Step 3: Enter server URL
    app.type_into("input[type='url']", &server_url).await?;
    tokio::time::sleep(Duration::from_secs(2)).await; // health check
    click_button_with_text(&app, "Continue").await;
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Step 4: Login
    app.type_into("input[type='email']", test_email).await?;
    app.type_into("input[type='password']", test_password)
        .await?;
    click_button_with_text(&app, "Sign In").await;

    // Should land on the plugins page
    app.wait_for_url_contains("plugins", Duration::from_secs(10))
        .await?;

    let header = app.text_of("h2").await?;
    assert!(
        header.contains("Plugins"),
        "Should be on plugins page, got header: {}",
        header
    );

    app.close().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// 2. Import a WASM plugin → appears in plugin list with expected effect
// ---------------------------------------------------------------------------

#[tokio::test]
async fn import_plugin_and_verify_effect() -> Result<()> {
    let Some(binary) = prerequisites() else {
        eprintln!("SKIP: prerequisites not met");
        return Ok(());
    };

    let env = TestEnv::start().await?;
    let server_url = web_url(env.web_addr());

    // Pre-register the test component at the backend so it shows in the plugin list
    env.register_test_component().await?;

    let test_email = "import@example.com";
    let test_password = "testpass123";
    register_user(env.web_addr(), env.ca(), test_email, test_password).await?;

    let app = EzfilterApp::launch(&binary).await?;
    complete_onboarding(&app, &server_url, test_email, test_password).await?;

    // Should be on plugins page with the test component visible
    app.wait_for_url_contains("plugins", Duration::from_secs(10))
        .await?;
    tokio::time::sleep(Duration::from_secs(1)).await;

    // Verify the test component plugin appears
    let page_source = app.client.source().await.unwrap_or_default();
    assert!(
        page_source.contains("wasm-test-component") || page_source.contains("test"),
        "Plugin list should contain the test component"
    );

    // Verify the plugin has the expected effect on proxied traffic
    let echo = env.start_echo_server("127.0.0.1", Protocol::Http2).await;
    let client = env.create_http_client(Protocol::Http2).await;
    let resp = client
        .get(format!(
            "https://127.0.0.1:{}/verify-effect",
            echo.listen_addr().port()
        ))
        .send()
        .await?;
    let body: EchoResponse = resp.json().await?;
    assert!(
        body.headers
            .get("witmproxy")
            .is_some_and(|v| v.contains("req")),
        "Test component should inject request header"
    );

    echo.shutdown().await;
    app.close().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// 3. Remove a plugin → gone from UI and backend
// ---------------------------------------------------------------------------

#[tokio::test]
async fn remove_plugin() -> Result<()> {
    let Some(binary) = prerequisites() else {
        eprintln!("SKIP: prerequisites not met");
        return Ok(());
    };

    let env = TestEnv::start().await?;
    let server_url = web_url(env.web_addr());
    env.register_test_component().await?;

    let test_email = "remove@example.com";
    let test_password = "testpass123";
    register_user(env.web_addr(), env.ca(), test_email, test_password).await?;

    let app = EzfilterApp::launch(&binary).await?;
    complete_onboarding(&app, &server_url, test_email, test_password).await?;
    app.wait_for_url_contains("plugins", Duration::from_secs(10))
        .await?;
    tokio::time::sleep(Duration::from_secs(1)).await;

    // Open dropdown menu on the plugin card and click "Remove plugin"
    app.click("button svg.lucide-chevron-down").await.ok();
    tokio::time::sleep(Duration::from_millis(300)).await;
    click_button_with_text(&app, "Remove plugin").await;

    // Confirm deletion in dialog
    tokio::time::sleep(Duration::from_millis(500)).await;
    app.click("button.bg-red-500").await.ok();
    tokio::time::sleep(Duration::from_secs(1)).await;

    // Verify the plugin is gone from the backend
    let plugin_ids = env.plugin_ids().await;
    assert!(
        plugin_ids.is_empty(),
        "Plugin should be removed from backend; still present: {:?}",
        plugin_ids
    );

    // Verify the plugin no longer affects traffic (transparent forwarding, no header injection)
    let echo = env.start_echo_server("127.0.0.1", Protocol::Http1).await;
    let client = env.create_http_client(Protocol::Http1).await;
    let resp = client
        .get(format!(
            "https://127.0.0.1:{}/after-remove",
            echo.listen_addr().port()
        ))
        .send()
        .await?;
    let body_text = resp.text().await?;
    assert!(
        !body_text.contains("\"witmproxy\":\"req\""),
        "Removed plugin should no longer inject headers"
    );

    echo.shutdown().await;
    app.close().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// 4. Disable a plugin → shown as disabled, no longer affects traffic
// ---------------------------------------------------------------------------

#[tokio::test]
async fn disable_plugin() -> Result<()> {
    let Some(binary) = prerequisites() else {
        eprintln!("SKIP: prerequisites not met");
        return Ok(());
    };

    let env = TestEnv::start().await?;
    let server_url = web_url(env.web_addr());
    env.register_test_component().await?;

    let test_email = "disable@example.com";
    let test_password = "testpass123";
    register_user(env.web_addr(), env.ca(), test_email, test_password).await?;

    let app = EzfilterApp::launch(&binary).await?;
    complete_onboarding(&app, &server_url, test_email, test_password).await?;
    app.wait_for_url_contains("plugins", Duration::from_secs(10))
        .await?;
    tokio::time::sleep(Duration::from_secs(1)).await;

    // Open dropdown and click Disable
    app.click("button svg.lucide-chevron-down").await.ok();
    tokio::time::sleep(Duration::from_millis(300)).await;
    click_button_with_text(&app, "Disable").await;
    tokio::time::sleep(Duration::from_secs(1)).await;

    // Verify the badge shows "Disabled" in the UI
    let page_source = app.client.source().await.unwrap_or_default();
    assert!(
        page_source.contains("Disabled"),
        "Plugin card should show Disabled badge"
    );

    // Verify the plugin no longer affects proxied traffic
    let echo = env.start_echo_server("127.0.0.1", Protocol::Http1).await;
    let client = env.create_http_client(Protocol::Http1).await;
    let resp = client
        .get(format!(
            "https://127.0.0.1:{}/after-disable",
            echo.listen_addr().port()
        ))
        .send()
        .await?;
    let body_text = resp.text().await?;
    assert!(
        !body_text.contains("\"witmproxy\":\"req\""),
        "Disabled plugin should no longer inject headers"
    );

    echo.shutdown().await;
    app.close().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// 5. Logout → returns to onboarding
// ---------------------------------------------------------------------------

#[tokio::test]
async fn logout_returns_to_onboarding() -> Result<()> {
    let Some(binary) = prerequisites() else {
        eprintln!("SKIP: prerequisites not met");
        return Ok(());
    };

    let env = TestEnv::start().await?;
    let server_url = web_url(env.web_addr());

    let test_email = "logout@example.com";
    let test_password = "testpass123";
    register_user(env.web_addr(), env.ca(), test_email, test_password).await?;

    let app = EzfilterApp::launch(&binary).await?;
    complete_onboarding(&app, &server_url, test_email, test_password).await?;
    app.wait_for_url_contains("plugins", Duration::from_secs(10))
        .await?;

    // Click Logout in the sidebar
    click_button_with_text(&app, "Logout").await;

    // Should return to the root/setup page
    tokio::time::sleep(Duration::from_secs(2)).await;
    let url = app.current_url().await?;
    assert!(
        url.ends_with('/') || url.contains("setup"),
        "After logout, should be back at root/onboarding; got: {}",
        url
    );

    app.close().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Click the first button whose text content contains `needle`.
async fn click_button_with_text(app: &EzfilterApp, needle: &str) {
    if let Ok(buttons) = app
        .client
        .find_all(fantoccini::Locator::Css("button"))
        .await
    {
        for btn in buttons {
            if let Ok(text) = btn.text().await
                && text.contains(needle)
            {
                btn.click().await.ok();
                return;
            }
        }
    }
    // Also try non-button clickable elements (links, role=button)
    if let Ok(els) = app
        .client
        .find_all(fantoccini::Locator::Css("[role='button'], a"))
        .await
    {
        for el in els {
            if let Ok(text) = el.text().await
                && text.contains(needle)
            {
                el.click().await.ok();
                return;
            }
        }
    }
}

/// Complete the onboarding flow: self-hosted → server URL → login.
async fn complete_onboarding(
    app: &EzfilterApp,
    server_url: &str,
    email: &str,
    password: &str,
) -> Result<()> {
    // Wait for app to load past splash screen
    tokio::time::sleep(Duration::from_secs(3)).await;

    // Step 1: Hosting mode → Self-hosted → Continue
    app.click("[data-value='self-host']").await.ok();
    tokio::time::sleep(Duration::from_millis(300)).await;
    click_button_with_text(app, "Continue").await;
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Step 2: "Yes, I have a server"
    click_button_with_text(app, "Yes").await;
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Step 3: Server URL + health check
    app.type_into("input[type='url']", server_url).await?;
    tokio::time::sleep(Duration::from_secs(2)).await;
    click_button_with_text(app, "Continue").await;
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Step 4: Login
    app.type_into("input[type='email']", email).await?;
    app.type_into("input[type='password']", password).await?;
    click_button_with_text(app, "Sign In").await;
    tokio::time::sleep(Duration::from_secs(2)).await;

    Ok(())
}
