//! End-to-end test infrastructure for ezfilter.
//!
//! Spins up a real witmproxy backend via [`witmproxy_test::TestEnv`] and drives
//! the Tauri desktop app through WebDriver (via `tauri-driver`).
//!
//! ## Requirements
//!
//! - **tauri-driver** on `$PATH` (install: `cargo install tauri-driver`)
//! - A **built** ezfilter binary (run `cargo build` in `src-tauri/` first)
//!
//! Tests skip gracefully when requirements are not met.

use std::net::SocketAddr;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result};
use fantoccini::ClientBuilder;
pub use witmproxy_test::{EchoResponse, Protocol, TestEnv};

/// Re-export so tests can use db helpers directly.
pub use witmproxy_test::tenants;

// ---------------------------------------------------------------------------
// Tool availability checks
// ---------------------------------------------------------------------------

/// Returns `true` if `tauri-driver` is on `$PATH`.
pub fn require_tauri_driver() -> bool {
    match which::which("tauri-driver") {
        Ok(p) => {
            tracing::debug!("tauri-driver found at {}", p.display());
            true
        }
        Err(_) => {
            tracing::warn!(
                "tauri-driver not found on PATH; \
                 install with `cargo install tauri-driver`. \
                 Tests that require it will be skipped."
            );
            false
        }
    }
}

/// Returns the path to the built ezfilter binary, or `None` if it doesn't
/// exist (needs `cargo build` in `src-tauri/`).
pub fn ezfilter_binary_path() -> Option<String> {
    // Try workspace target dir first (most common in monorepo)
    let candidates = [
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/debug/ezfilter"),
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src-tauri/target/debug/ezfilter"
        ),
    ];
    for path in &candidates {
        let p = std::path::Path::new(path);
        if p.exists() {
            return Some(p.canonicalize().unwrap().to_string_lossy().into_owned());
        }
    }
    // Fall back to the monorepo root target dir
    let mono_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()? // ezfilter/
        .parent()? // apps/
        .parent()?; // mono/
    let binary = mono_root.join("target/debug/ezfilter");
    if binary.exists() {
        return Some(
            binary
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        );
    }
    tracing::warn!(
        "ezfilter binary not found; run `cargo build` in src-tauri/ first. \
         Searched: {:?}",
        candidates
    );
    None
}

/// Initialize tracing for tests (idempotent).
pub fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("ezfilter_e2e=debug,witmproxy=info,witmproxy_test=debug")
        .with_test_writer()
        .try_init();
}

// ---------------------------------------------------------------------------
// TauriDriver — manages the tauri-driver WebDriver process
// ---------------------------------------------------------------------------

/// A running `tauri-driver` process that acts as a WebDriver server.
pub struct TauriDriver {
    child: Child,
    port: u16,
}

impl TauriDriver {
    /// Spawn `tauri-driver` on an available port.
    pub fn spawn() -> Result<Self> {
        let port = pick_free_port();
        let child = Command::new("tauri-driver")
            .args(["--port", &port.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .context("Failed to spawn tauri-driver")?;

        // Give it a moment to bind
        std::thread::sleep(Duration::from_millis(500));

        Ok(Self { child, port })
    }

    /// The WebDriver endpoint URL.
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

impl Drop for TauriDriver {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ---------------------------------------------------------------------------
// EzfilterApp — WebDriver session for the running Tauri app
// ---------------------------------------------------------------------------

/// A WebDriver client connected to a running ezfilter Tauri instance.
pub struct EzfilterApp {
    pub client: fantoccini::Client,
    _driver: TauriDriver,
}

impl EzfilterApp {
    /// Launch ezfilter via tauri-driver and connect a WebDriver session.
    ///
    /// `binary` is the path to the built ezfilter executable.
    pub async fn launch(binary: &str) -> Result<Self> {
        let driver = TauriDriver::spawn()?;

        let mut caps = serde_json::Map::new();
        caps.insert(
            "tauri:options".into(),
            serde_json::json!({
                "application": binary,
            }),
        );

        let client = ClientBuilder::native()
            .capabilities(serde_json::Value::Object(caps).as_object().unwrap().clone())
            .connect(&driver.url())
            .await
            .context("Failed to connect to tauri-driver")?;

        Ok(Self {
            client,
            _driver: driver,
        })
    }

    /// Close the app and WebDriver session.
    pub async fn close(self) {
        let _ = self.client.close().await;
        // _driver is dropped here, killing tauri-driver
    }

    // -- Navigation helpers --

    /// Wait for an element matching the CSS selector to appear, with timeout.
    pub async fn wait_for(
        &self,
        selector: &str,
        timeout: Duration,
    ) -> Result<fantoccini::elements::Element> {
        let start = std::time::Instant::now();
        loop {
            if let Ok(el) = self.client.find(fantoccini::Locator::Css(selector)).await {
                return Ok(el);
            }
            if start.elapsed() > timeout {
                anyhow::bail!("Timed out waiting for selector: {}", selector);
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// Wait for an element and click it.
    pub async fn click(&self, selector: &str) -> Result<()> {
        let el = self.wait_for(selector, Duration::from_secs(10)).await?;
        el.click().await.context("Failed to click element")?;
        Ok(())
    }

    /// Wait for an input element and type text into it.
    pub async fn type_into(&self, selector: &str, text: &str) -> Result<()> {
        let el = self.wait_for(selector, Duration::from_secs(10)).await?;
        el.clear().await?;
        el.send_keys(text).await?;
        Ok(())
    }

    /// Get the text content of an element.
    pub async fn text_of(&self, selector: &str) -> Result<String> {
        let el = self.wait_for(selector, Duration::from_secs(10)).await?;
        Ok(el.text().await?)
    }

    /// Check whether an element matching the selector exists.
    pub async fn exists(&self, selector: &str) -> bool {
        self.client
            .find(fantoccini::Locator::Css(selector))
            .await
            .is_ok()
    }

    /// Get the current URL.
    pub async fn current_url(&self) -> Result<String> {
        Ok(self.client.current_url().await?.to_string())
    }

    /// Wait until the URL contains the given substring.
    pub async fn wait_for_url_contains(&self, substring: &str, timeout: Duration) -> Result<()> {
        let start = std::time::Instant::now();
        loop {
            let url = self.current_url().await?;
            if url.contains(substring) {
                return Ok(());
            }
            if start.elapsed() > timeout {
                anyhow::bail!(
                    "Timed out waiting for URL to contain '{}'; current: {}",
                    substring,
                    url
                );
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn pick_free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

/// Format a witmproxy web server address as an HTTPS URL.
pub fn web_url(addr: SocketAddr) -> String {
    format!("https://127.0.0.1:{}", addr.port())
}
