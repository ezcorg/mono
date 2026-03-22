#![doc = include_str!("../README.md")]

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Result;
use tokio::sync::RwLock;
use tracing::warn;

// Re-export witmproxy types that test authors need.
pub use witmproxy::test_utils::{EchoResponse, Protocol, ServerHandle};
pub use witmproxy::{
    AppConfig, CertificateAuthority, PluginRegistry, WitmProxy,
    db::{self, Db, tenants},
};

/// Check whether a host binary is on `$PATH`.
///
/// Returns `true` if found, `false` otherwise.
/// Emits a [`tracing::warn!`] when the binary is missing so that test runners
/// surface the skip reason even in CI.
pub fn require_binary(name: &str) -> bool {
    match which::which(name) {
        Ok(path) => {
            tracing::debug!("{name} found at {}", path.display());
            true
        }
        Err(_) => {
            warn!("{name} not found on PATH; tests that require it will be skipped");
            false
        }
    }
}

/// Check for `chromedriver` (needed for desktop Chrome WebDriver tests).
pub fn require_chromedriver() -> bool {
    require_binary("chromedriver")
}

/// Check for `geckodriver` (needed for desktop Firefox WebDriver tests).
pub fn require_geckodriver() -> bool {
    require_binary("geckodriver")
}

/// Check for `safaridriver` (needed for desktop Safari WebDriver tests, macOS only).
pub fn require_safaridriver() -> bool {
    if !cfg!(target_os = "macos") {
        warn!("safaridriver is only available on macOS; skipping");
        return false;
    }
    require_binary("safaridriver")
}

/// Check for `appium` (needed for mobile browser tests).
pub fn require_appium() -> bool {
    require_binary("appium")
}

/// Check for Android SDK tools (`adb` + `emulator`).
pub fn require_android_tools() -> bool {
    require_binary("adb") && require_binary("emulator")
}

/// Check for iOS tooling (`xcrun simctl`).
pub fn require_ios_tools() -> bool {
    if !cfg!(target_os = "macos") {
        warn!("iOS simulator is only available on macOS; skipping");
        return false;
    }
    require_binary("xcrun")
}

/// Initialize tracing for tests (idempotent).
pub fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(format!("witmproxy={},witmproxy_test={}", "debug", "debug"))
        .with_test_writer()
        .try_init();
}

// ---------------------------------------------------------------------------
// TestEnv — one-stop shop for e2e tests
// ---------------------------------------------------------------------------

/// A self-contained test environment that spins up a [`WitmProxy`] instance
/// together with a temporary database and CA.
///
/// Plugin authors can use this to run the same e2e tests against their own
/// plugins:
///
/// ```rust,no_run
/// # async fn example() -> anyhow::Result<()> {
/// use witmproxy_test::{TestEnv, Protocol};
///
/// let mut env = TestEnv::start().await?;
/// env.register_plugin_from_path("/path/to/my_plugin.signed.wasm").await?;
///
/// let echo = env.start_echo_server("127.0.0.1", Protocol::Http1).await;
/// let client = env.create_http_client(Protocol::Http1).await;
///
/// let resp = client
///     .get(format!("https://127.0.0.1:{}/test", echo.listen_addr().port()))
///     .send()
///     .await?;
/// assert!(resp.status().is_success());
///
/// echo.shutdown().await;
/// env.shutdown().await;
/// # Ok(())
/// # }
/// ```
pub struct TestEnv {
    proxy: WitmProxy,
    registry: Arc<RwLock<PluginRegistry>>,
    ca: CertificateAuthority,
    _temp_dir: tempfile::TempDir,
}

impl TestEnv {
    /// Create **and start** a new test environment.
    pub async fn start() -> Result<Self> {
        init_tracing();
        let (proxy, registry, ca, _config, temp_dir) =
            witmproxy::test_utils::create_witmproxy().await?;

        let mut env = Self {
            proxy,
            registry,
            ca,
            _temp_dir: temp_dir,
        };

        env.proxy.start().await?;
        Ok(env)
    }

    /// Proxy server listen address (e.g. `127.0.0.1:<port>`).
    pub fn proxy_addr(&self) -> SocketAddr {
        self.proxy
            .proxy_listen_addr()
            .expect("proxy not started yet")
    }

    /// Web / management API listen address.
    pub fn web_addr(&self) -> SocketAddr {
        self.proxy
            .web_listen_addr()
            .expect("web server not started yet")
    }

    /// The test CA — use it to create upstream mock servers that the proxy
    /// will trust.
    pub fn ca(&self) -> &CertificateAuthority {
        &self.ca
    }

    /// A clone of the underlying `SqlitePool`, useful for direct DB operations
    /// (tenant creation, IP mappings, plugin overrides, …).
    pub async fn db_pool(&self) -> witmproxy::db::Db {
        let reg = self.registry.read().await;
        reg.db.clone()
    }

    // -- HTTP client helpers ------------------------------------------------

    /// Build a [`reqwest::Client`] that routes through the proxy and trusts
    /// the test CA.
    pub async fn create_http_client(&self, proto: Protocol) -> reqwest::Client {
        witmproxy::test_utils::create_client(
            self.ca.clone(),
            &format!("http://{}", self.proxy_addr()),
            proto,
        )
        .await
    }

    // -- Mock upstream servers ----------------------------------------------

    /// Start a JSON echo server that reflects request details back as JSON.
    pub async fn start_echo_server(&self, host: &str, proto: Protocol) -> ServerHandle {
        witmproxy::test_utils::create_json_echo_server(host, None, self.ca.clone(), proto).await
    }

    /// Start a static HTML server.
    pub async fn start_html_server(&self, host: &str, proto: Protocol) -> ServerHandle {
        witmproxy::test_utils::create_html_server(host, None, self.ca.clone(), proto).await
    }

    // -- Plugin management --------------------------------------------------

    /// Register a WASM plugin component from a file path.
    pub async fn register_plugin_from_path(&self, path: &str) -> Result<()> {
        let component_bytes = std::fs::read(path)?;
        let mut reg = self.registry.write().await;
        let plugin = reg.plugin_from_component(component_bytes).await?;
        reg.register_plugin(plugin).await
    }

    /// Register the built-in `wasm-test-component` plugin.
    ///
    /// This plugin adds `witmproxy: req` header to requests and
    /// `witmproxy: res` header to responses, and prepends an HTML comment
    /// to `text/html` bodies.
    pub async fn register_test_component(&self) -> Result<()> {
        let mut reg = self.registry.write().await;
        witmproxy::test_utils::register_test_component(&mut reg).await
    }

    /// Register the built-in `noop` plugin (passes all events through
    /// unchanged).
    pub async fn register_noop_plugin(&self) -> Result<()> {
        let mut reg = self.registry.write().await;
        witmproxy::test_utils::register_noop_plugin(&mut reg).await
    }

    /// Register the built-in `noshorts` plugin.
    pub async fn register_noshorts_plugin(&self) -> Result<()> {
        let mut reg = self.registry.write().await;
        witmproxy::test_utils::register_noshorts_plugin(&mut reg).await
    }

    /// Remove a plugin by name with optional namespace filter.
    pub async fn remove_plugin(&self, name: &str, namespace: Option<&str>) -> Result<Vec<String>> {
        let mut reg = self.registry.write().await;
        reg.remove_plugin(name, namespace).await
    }

    /// Get the set of currently-registered plugin IDs (`"namespace/name"`).
    pub async fn plugin_ids(&self) -> HashSet<String> {
        let reg = self.registry.read().await;
        reg.plugins().keys().cloned().collect()
    }

    // -- Tenant management --------------------------------------------------

    /// Create a tenant in the database.
    pub async fn create_tenant(&self, id: &str, display_name: &str) -> Result<tenants::Tenant> {
        let db = self.db_pool().await;
        tenants::Tenant::create(&db.pool, id, display_name, None, None, None, None).await
    }

    /// Map an IP address to a tenant (used by the IP-mapping tenant resolver).
    pub async fn set_tenant_ip(&self, tenant_id: &str, ip: &str) -> Result<()> {
        let db = self.db_pool().await;
        tenants::add_ip_mapping(&db.pool, tenant_id, ip).await
    }

    /// Set a per-tenant plugin override (enable / disable).
    pub async fn set_tenant_plugin_override(
        &self,
        tenant_id: &str,
        namespace: &str,
        name: &str,
        enabled: Option<bool>,
    ) -> Result<()> {
        let db = self.db_pool().await;
        tenants::set_plugin_override(&db.pool, tenant_id, namespace, name, enabled).await
    }

    /// Set per-tenant plugin configuration values.
    pub async fn set_tenant_plugin_config(
        &self,
        tenant_id: &str,
        namespace: &str,
        name: &str,
        input_name: &str,
        input_value: &str,
    ) -> Result<()> {
        let db = self.db_pool().await;
        tenants::set_plugin_config(
            &db.pool,
            tenant_id,
            namespace,
            name,
            input_name,
            input_value,
        )
        .await
    }

    /// Query the effective set of plugin IDs for a tenant.
    pub async fn effective_plugins_for_tenant(&self, tenant_id: &str) -> Result<HashSet<String>> {
        let db = self.db_pool().await;
        let tenant = tenants::Tenant::by_id(&db.pool, tenant_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("tenant {tenant_id} not found"))?;
        let overrides = tenant.plugin_overrides(&db.pool).await?;
        let reg = self.registry.read().await;
        Ok(reg.effective_plugins_for_tenant(&overrides))
    }

    // -- Lifecycle ----------------------------------------------------------

    /// Gracefully shut down the test environment.
    pub async fn shutdown(mut self) {
        self.proxy.shutdown().await;
    }
}

// ---------------------------------------------------------------------------
// WebDriver / Appium session helpers
// ---------------------------------------------------------------------------

/// Configuration for creating a browser session through a WebDriver server.
pub struct WebDriverSessionConfig {
    /// WebDriver server URL (e.g. `http://localhost:9515` for chromedriver).
    pub webdriver_url: String,
    /// Proxy address in `host:port` form.
    pub proxy_addr: String,
}

/// Start a `chromedriver` child process on a random port and return
/// `(child, webdriver_url)`.
///
/// Returns `None` if `chromedriver` is not installed (emits a warning).
pub fn start_chromedriver() -> Option<(std::process::Child, String)> {
    if !require_chromedriver() {
        return None;
    }
    // Port 0 = let OS assign
    let port = portpicker::pick_unused_port().unwrap_or(9515);
    let child = std::process::Command::new("chromedriver")
        .arg(format!("--port={port}"))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    // Give the driver a moment to bind
    std::thread::sleep(std::time::Duration::from_millis(500));
    Some((child, format!("http://127.0.0.1:{port}")))
}

/// Start a `geckodriver` child process on a random port and return
/// `(child, webdriver_url)`.
///
/// Returns `None` if `geckodriver` is not installed.
pub fn start_geckodriver() -> Option<(std::process::Child, String)> {
    if !require_geckodriver() {
        return None;
    }
    let port = portpicker::pick_unused_port().unwrap_or(4444);
    let child = std::process::Command::new("geckodriver")
        .arg("--port")
        .arg(port.to_string())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    std::thread::sleep(std::time::Duration::from_millis(500));
    Some((child, format!("http://127.0.0.1:{port}")))
}

// portpicker is a tiny utility; inline a fallback if the crate is absent.
mod portpicker {
    use std::net::TcpListener;

    pub fn pick_unused_port() -> Option<u16> {
        TcpListener::bind("127.0.0.1:0")
            .ok()
            .map(|l| l.local_addr().unwrap().port())
    }
}
