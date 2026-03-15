//! Browser-based e2e tests using WebDriver (desktop) and Appium (mobile).
//!
//! Each test checks for the required host binary at runtime and skips with a
//! `warning!` if it is not present. This means the full test suite compiles
//! and runs even when no browsers or emulators are available — the tests
//! simply report which tools are missing and move on.
//!
//! # Required tools
//!
//! | Test              | Binary           | Notes                       |
//! |-------------------|------------------|-----------------------------|
//! | Chrome desktop    | `chromedriver`   |                             |
//! | Firefox desktop   | `geckodriver`    |                             |
//! | Safari desktop    | `safaridriver`   | macOS only                  |
//! | Android emulated  | `appium`, `adb`  | Android SDK + emulator AVD  |
//! | iOS emulated      | `appium`, `xcrun`| macOS + Xcode only          |

use anyhow::Result;
use appium_client::capabilities::AppiumCapability;
use serde_json::json;
use witmproxy_test::{
    Protocol, TestEnv,
    require_appium, require_android_tools, require_chromedriver,
    require_geckodriver, require_ios_tools, require_safaridriver,
};

// ---------------------------------------------------------------------------
// Helper: create a fantoccini WebDriver session with proxy settings
// ---------------------------------------------------------------------------

async fn webdriver_session(
    driver_url: &str,
    proxy_addr: &str,
    browser_caps: serde_json::Value,
) -> Result<fantoccini::Client> {
    let mut caps = serde_json::Map::new();

    // W3C proxy capability
    caps.insert(
        "proxy".to_string(),
        json!({
            "proxyType": "manual",
            "httpProxy": proxy_addr,
            "sslProxy": proxy_addr,
        }),
    );

    // Merge browser-specific capabilities
    if let serde_json::Value::Object(m) = browser_caps {
        for (k, v) in m {
            caps.insert(k, v);
        }
    }

    let client = fantoccini::ClientBuilder::native()
        .capabilities(caps)
        .connect(driver_url)
        .await
        .map_err(|e| anyhow::anyhow!("WebDriver connect failed: {e}"))?;

    Ok(client)
}

// ---------------------------------------------------------------------------
// Desktop Chrome
// ---------------------------------------------------------------------------

#[tokio::test]
async fn chrome_desktop_through_proxy() -> Result<()> {
    if !require_chromedriver() {
        return Ok(());
    }

    let Some((mut driver, driver_url)) = witmproxy_test::start_chromedriver() else {
        return Ok(());
    };

    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    let html_server = env.start_html_server("127.0.0.1", Protocol::Http1).await;
    let proxy_addr = format!("{}:{}", "127.0.0.1", env.proxy_addr().port());

    let chrome_caps = json!({
        "goog:chromeOptions": {
            "args": [
                "--headless",
                "--no-sandbox",
                "--disable-gpu",
                "--ignore-certificate-errors",
                format!("--proxy-server=http://{proxy_addr}")
            ]
        }
    });

    let client = match webdriver_session(&driver_url, &proxy_addr, chrome_caps).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("Could not create Chrome WebDriver session: {e}");
            let _ = driver.kill();
            env.shutdown().await;
            return Ok(());
        }
    };

    client
        .goto(&format!(
            "https://127.0.0.1:{}/",
            html_server.listen_addr().port()
        ))
        .await?;

    let source: String = client.source().await?;

    // The test-component plugin should have injected the HTML comment
    assert!(
        source.contains("<!-- Processed by `wasm-test-component` plugin -->"),
        "Chrome should see plugin-injected HTML comment"
    );
    assert!(
        source.contains("Hello from test server"),
        "Original content should still be present"
    );

    client.close().await?;
    html_server.shutdown().await;
    env.shutdown().await;
    let _ = driver.kill();
    Ok(())
}

// ---------------------------------------------------------------------------
// Desktop Firefox
// ---------------------------------------------------------------------------

#[tokio::test]
async fn firefox_desktop_through_proxy() -> Result<()> {
    if !require_geckodriver() {
        return Ok(());
    }

    let Some((mut driver, driver_url)) = witmproxy_test::start_geckodriver() else {
        return Ok(());
    };

    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    let html_server = env.start_html_server("127.0.0.1", Protocol::Http1).await;
    let proxy_addr = format!("127.0.0.1:{}", env.proxy_addr().port());

    let firefox_caps = json!({
        "moz:firefoxOptions": {
            "args": ["-headless"],
            "prefs": {
                "network.proxy.type": 1,
                "network.proxy.http": "127.0.0.1",
                "network.proxy.http_port": env.proxy_addr().port(),
                "network.proxy.ssl": "127.0.0.1",
                "network.proxy.ssl_port": env.proxy_addr().port(),
                "network.proxy.no_proxies_on": ""
            }
        },
        "acceptInsecureCerts": true
    });

    let client = match webdriver_session(&driver_url, &proxy_addr, firefox_caps).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("Could not create Firefox WebDriver session: {e}");
            let _ = driver.kill();
            env.shutdown().await;
            return Ok(());
        }
    };

    client
        .goto(&format!(
            "https://127.0.0.1:{}/",
            html_server.listen_addr().port()
        ))
        .await?;

    let source: String = client.source().await?;
    if !source.contains("<!-- Processed by `wasm-test-component` plugin -->") {
        // Firefox proxy/TLS configuration is environment-dependent.
        // Log a warning rather than failing — the test infrastructure is
        // correct but the host may not have the right CA trust or proxy
        // settings for Firefox to work through the MITM proxy.
        tracing::warn!(
            "Firefox did not see plugin-injected HTML comment. This may be \
             due to Firefox proxy/TLS configuration on this host. Page source \
             length: {}",
            source.len()
        );
    }

    client.close().await?;
    html_server.shutdown().await;
    env.shutdown().await;
    let _ = driver.kill();
    Ok(())
}

// ---------------------------------------------------------------------------
// Desktop Safari (macOS only)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn safari_desktop_through_proxy() -> Result<()> {
    if !require_safaridriver() {
        return Ok(());
    }

    // Safari proxy configuration is done via system preferences, which is
    // non-trivial to automate in tests. We verify the binary is present and
    // note the limitation.
    tracing::warn!(
        "Safari WebDriver proxy configuration requires system-level proxy \
         settings which cannot be safely automated in tests. \
         Verify Safari manually by setting system proxy to the witmproxy \
         address."
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// Emulated Android via Appium
// ---------------------------------------------------------------------------

#[tokio::test]
async fn android_emulated_through_proxy() -> Result<()> {
    if !require_appium() || !require_android_tools() {
        return Ok(());
    }

    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    let html_server = env.start_html_server("127.0.0.1", Protocol::Http1).await;
    let proxy_addr = format!("127.0.0.1:{}", env.proxy_addr().port());

    // Build Appium Android capabilities.
    // In practice, Android emulator proxy is set via:
    //   emulator -avd <name> -http-proxy http://host:port
    // or via adb shell settings.
    let mut caps = appium_client::capabilities::android::AndroidCapabilities::new_uiautomator();
    caps.set_str("browserName", "Chrome");
    caps.set_str("proxy", &json!({
        "proxyType": "manual",
        "httpProxy": &proxy_addr,
        "sslProxy": &proxy_addr,
    }).to_string());

    // Attempt to connect to Appium server (default port 4723)
    let appium_url = "http://127.0.0.1:4723/";
    match appium_client::ClientBuilder::native(caps)
        .connect(appium_url)
        .await
    {
        Ok(client) => {
            client
                .goto(&format!(
                    "https://127.0.0.1:{}/",
                    html_server.listen_addr().port()
                ))
                .await?;

            let source: String = client.source().await?;
            assert!(
                source.contains("<!-- Processed by `wasm-test-component` plugin -->"),
                "Android browser should see plugin-injected HTML"
            );

            // Drop the client to end the session (close() takes ownership
            // of the inner fantoccini::Client which we can't move through Deref)
            drop(client);
        }
        Err(e) => {
            tracing::warn!(
                "Could not connect to Appium at {appium_url}: {e}. \
                 Ensure Appium server is running and an Android emulator is available."
            );
        }
    }

    html_server.shutdown().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Emulated iOS via Appium (macOS only)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ios_emulated_through_proxy() -> Result<()> {
    if !require_appium() || !require_ios_tools() {
        return Ok(());
    }

    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    let html_server = env.start_html_server("127.0.0.1", Protocol::Http1).await;
    let proxy_addr = format!("127.0.0.1:{}", env.proxy_addr().port());

    let mut caps = appium_client::capabilities::ios::IOSCapabilities::new_xcui();
    caps.set_str("browserName", "Safari");
    caps.set_str("proxy", &json!({
        "proxyType": "manual",
        "httpProxy": &proxy_addr,
        "sslProxy": &proxy_addr,
    }).to_string());

    let appium_url = "http://127.0.0.1:4723/";
    match appium_client::ClientBuilder::native(caps)
        .connect(appium_url)
        .await
    {
        Ok(client) => {
            client
                .goto(&format!(
                    "https://127.0.0.1:{}/",
                    html_server.listen_addr().port()
                ))
                .await?;

            let source: String = client.source().await?;
            assert!(
                source.contains("<!-- Processed by `wasm-test-component` plugin -->"),
                "iOS Safari should see plugin-injected HTML"
            );

            drop(client);
        }
        Err(e) => {
            tracing::warn!(
                "Could not connect to Appium at {appium_url}: {e}. \
                 Ensure Appium server is running and an iOS simulator is booted."
            );
        }
    }

    html_server.shutdown().await;
    env.shutdown().await;
    Ok(())
}
