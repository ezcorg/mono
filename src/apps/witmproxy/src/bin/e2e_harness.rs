//! E2E test harness for witmproxy.
//!
//! Starts a full witmproxy instance with WASM test plugins, plus JSON echo and
//! HTML target servers. Writes a JSON config file and CA PEM for Puppeteer tests
//! to consume, then waits for stdin EOF or SIGINT before shutting down.
//!
//! ```sh
//! cargo run -p witmproxy --bin e2e-harness --features test-helpers
//! ```

use std::io::Write as _;

use anyhow::Result;
use serde::Serialize;
use tokio::io::AsyncBufReadExt;

use witmproxy::test_utils::*;

#[derive(Serialize)]
struct HarnessConfig {
    proxy_addr: String,
    web_addr: String,
    echo_url: String,
    html_url: String,
    ca_pem_path: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("witmproxy=info")
        .try_init();

    let _ = rustls::crypto::ring::default_provider().install_default();

    // Output paths (overridable via env)
    let config_path = std::env::var("E2E_CONFIG_PATH")
        .unwrap_or_else(|_| "/tmp/witmproxy-e2e-config.json".into());
    let ca_pem_path = std::env::var("E2E_CA_PEM_PATH")
        .unwrap_or_else(|_| "/tmp/witmproxy-e2e-ca.pem".into());

    // ── Proxy ───────────────────────────────────────────────────────────
    let (mut proxy, registry, ca, _config, _temp_dir) = create_witmproxy().await?;
    proxy.start().await?;

    // Register the WASM test plugin (adds witmproxy:req/res headers,
    // prepends an HTML comment to responses).
    {
        let mut reg = registry.write().await;
        register_test_component(&mut reg).await?;
    }

    // ── Target servers ──────────────────────────────────────────────────
    let echo =
        create_json_echo_server("127.0.0.1", None, ca.clone(), Protocol::Http1).await;
    let html =
        create_html_server("127.0.0.1", None, ca.clone(), Protocol::Http1).await;

    // ── Export CA certificate ───────────────────────────────────────────
    let pem = ca.get_root_certificate_pem()?;
    std::fs::write(&ca_pem_path, &pem)?;

    // ── Write config JSON ───────────────────────────────────────────────
    let cfg = HarnessConfig {
        proxy_addr: format!("127.0.0.1:{}", proxy.proxy_listen_addr().unwrap().port()),
        web_addr: format!("https://127.0.0.1:{}", proxy.web_listen_addr().unwrap().port()),
        echo_url: format!("https://127.0.0.1:{}", echo.listen_addr().port()),
        html_url: format!("https://127.0.0.1:{}", html.listen_addr().port()),
        ca_pem_path: ca_pem_path.clone(),
    };
    let json = serde_json::to_string_pretty(&cfg)?;
    std::fs::write(&config_path, &json)?;

    // Signal readiness
    println!("READY {config_path}");
    std::io::stdout().flush()?;

    // ── Wait for termination ────────────────────────────────────────────
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    // When stdin closes (parent process died) or we read "STOP", shut down.
    tokio::spawn(async move {
        let stdin = tokio::io::stdin();
        let mut reader = tokio::io::BufReader::new(stdin);
        let mut buf = String::new();
        loop {
            match reader.read_line(&mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    if buf.trim() == "STOP" {
                        break;
                    }
                    buf.clear();
                }
                Err(_) => break,
            }
        }
        let _ = shutdown_tx.send(());
    });

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = shutdown_rx => {},
    }

    // ── Cleanup ─────────────────────────────────────────────────────────
    proxy.shutdown().await;
    echo.shutdown().await;
    html.shutdown().await;

    let _ = std::fs::remove_file(&config_path);
    let _ = std::fs::remove_file(&ca_pem_path);

    Ok(())
}
