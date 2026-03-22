//! Core proxy functionality and plugin API surface tests.
//!
//! These tests use only the `reqwest` HTTP client (no external binaries
//! required) and exercise every event type the plugin system supports.

use anyhow::Result;
use witmproxy_test::{EchoResponse, Protocol, TestEnv};

// ---------------------------------------------------------------------------
// Basic proxy lifecycle
// ---------------------------------------------------------------------------

#[tokio::test]
async fn proxy_starts_and_binds() -> Result<()> {
    let env = TestEnv::start().await?;
    let addr = env.proxy_addr();
    assert_ne!(addr.port(), 0, "proxy must bind to an actual port");
    env.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn web_server_starts_and_binds() -> Result<()> {
    let env = TestEnv::start().await?;
    let addr = env.web_addr();
    assert_ne!(addr.port(), 0);
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// HTTPS proxying (no plugins — transparent forwarding)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn https_request_without_plugins() -> Result<()> {
    let env = TestEnv::start().await?;
    // No plugins registered → CONNECT should forward transparently
    let echo = env.start_echo_server("127.0.0.1", Protocol::Http1).await;
    let client = env.create_http_client(Protocol::Http1).await;

    let resp = client
        .get(format!(
            "https://127.0.0.1:{}/no-plugin",
            echo.listen_addr().port()
        ))
        .send()
        .await?;

    assert!(resp.status().is_success());
    echo.shutdown().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Plugin: request header injection (wasm-test-component)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn plugin_adds_request_header() -> Result<()> {
    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    let echo = env.start_echo_server("127.0.0.1", Protocol::Http2).await;
    let client = env.create_http_client(Protocol::Http2).await;

    let resp = client
        .get(format!(
            "https://127.0.0.1:{}/example",
            echo.listen_addr().port()
        ))
        .send()
        .await?;

    let body: EchoResponse = resp.json().await?;
    assert_eq!(body.path, "/example");
    assert_eq!(body.method, "GET");
    // The test component adds `witmproxy: req` to the outgoing request
    assert!(
        body.headers
            .get("witmproxy")
            .is_some_and(|v| v.contains("req")),
        "Expected 'witmproxy: req' request header injected by plugin; got {:?}",
        body.headers.get("witmproxy"),
    );

    echo.shutdown().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Plugin: response header injection
// ---------------------------------------------------------------------------

#[tokio::test]
async fn plugin_adds_response_header() -> Result<()> {
    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    let echo = env.start_echo_server("127.0.0.1", Protocol::Http2).await;
    let client = env.create_http_client(Protocol::Http2).await;

    let resp = client
        .get(format!(
            "https://127.0.0.1:{}/resp-header",
            echo.listen_addr().port()
        ))
        .send()
        .await?;

    let hdr = resp
        .headers()
        .get("witmproxy")
        .expect("Expected 'witmproxy' response header");
    assert!(
        hdr.to_str().unwrap().contains("res"),
        "Response header should contain 'res'"
    );

    echo.shutdown().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Plugin: InboundContent HTML injection
// ---------------------------------------------------------------------------

#[tokio::test]
async fn plugin_injects_html_comment() -> Result<()> {
    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    let html_server = env.start_html_server("127.0.0.1", Protocol::Http2).await;
    let client = env.create_http_client(Protocol::Http2).await;

    let body = client
        .get(format!(
            "https://127.0.0.1:{}/",
            html_server.listen_addr().port()
        ))
        .send()
        .await?
        .text()
        .await?;

    assert!(
        body.contains("<!-- Processed by `wasm-test-component` plugin -->"),
        "HTML body should contain injected comment: {body}"
    );
    assert!(
        body.contains("<h1>Hello from test server</h1>"),
        "Original HTML content must still be present"
    );

    // Comment should appear before the DOCTYPE
    let comment_pos = body
        .find("<!-- Processed by `wasm-test-component` plugin -->")
        .unwrap();
    let doctype_pos = body.find("<!DOCTYPE html>").unwrap();
    assert!(
        comment_pos < doctype_pos,
        "Comment should be prepended before DOCTYPE"
    );

    html_server.shutdown().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Plugin: CEL scope — `donotprocess.com` is excluded
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cel_scope_excludes_host() -> Result<()> {
    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    // The wasm-test-component CEL scope excludes `donotprocess.com`.
    // Because the echo server is bound to 127.0.0.1, we can't really connect
    // to donotprocess.com. Instead we can use the `skipthis: true` header
    // which the plugin's CEL expression also checks.
    let echo = env.start_echo_server("127.0.0.1", Protocol::Http2).await;
    let client = env.create_http_client(Protocol::Http2).await;

    let resp = client
        .get(format!(
            "https://127.0.0.1:{}/skip-me",
            echo.listen_addr().port()
        ))
        .header("skipthis", "true")
        .send()
        .await?;

    let body: EchoResponse = resp.json().await?;
    // The plugin should NOT have added the header because the scope excludes
    // requests with `skipthis: true`.
    assert!(
        !body
            .headers
            .get("witmproxy")
            .is_some_and(|v| v.contains("req")),
        "Plugin should NOT inject header when CEL scope excludes the request"
    );

    echo.shutdown().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Plugin: noop passes through unchanged
// ---------------------------------------------------------------------------

#[tokio::test]
async fn noop_plugin_passes_through() -> Result<()> {
    let env = TestEnv::start().await?;
    env.register_noop_plugin().await?;

    let echo = env.start_echo_server("127.0.0.1", Protocol::Http1).await;
    let client = env.create_http_client(Protocol::Http1).await;

    let resp = client
        .get(format!(
            "https://127.0.0.1:{}/noop",
            echo.listen_addr().port()
        ))
        .send()
        .await?;

    let body: EchoResponse = resp.json().await?;
    assert_eq!(body.path, "/noop");
    // noop shouldn't add any witmproxy headers
    assert!(
        !body.headers.contains_key("witmproxy"),
        "noop plugin should not modify request headers"
    );

    echo.shutdown().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Multiple plugins in chain
// ---------------------------------------------------------------------------

#[tokio::test]
async fn multiple_plugins_chain() -> Result<()> {
    let env = TestEnv::start().await?;
    // Register both noop and test component
    env.register_noop_plugin().await?;
    env.register_test_component().await?;

    let echo = env.start_echo_server("127.0.0.1", Protocol::Http2).await;
    let client = env.create_http_client(Protocol::Http2).await;

    let resp = client
        .get(format!(
            "https://127.0.0.1:{}/chain",
            echo.listen_addr().port()
        ))
        .send()
        .await?;

    let headers = resp.headers().clone();
    let body: EchoResponse = resp.json().await?;

    // noop passes through, test-component adds headers
    assert!(
        body.headers
            .get("witmproxy")
            .is_some_and(|v| v.contains("req")),
        "test-component should have added request header after noop"
    );
    assert!(
        headers
            .get("witmproxy")
            .is_some_and(|v| v.to_str().unwrap().contains("res")),
        "test-component should have added response header after noop"
    );

    echo.shutdown().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// HTTP/1.1 ↔ HTTP/1.1 proxying
// ---------------------------------------------------------------------------

#[tokio::test]
async fn http1_to_http1() -> Result<()> {
    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    let echo = env.start_echo_server("127.0.0.1", Protocol::Http1).await;
    let client = env.create_http_client(Protocol::Http1).await;

    let resp = client
        .get(format!(
            "https://127.0.0.1:{}/h1h1",
            echo.listen_addr().port()
        ))
        .send()
        .await?;
    assert!(resp.status().is_success());

    let body: EchoResponse = resp.json().await?;
    assert_eq!(body.path, "/h1h1");
    assert!(
        body.headers
            .get("witmproxy")
            .is_some_and(|v| v.contains("req"))
    );

    echo.shutdown().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// HTTP/2 ↔ HTTP/2 proxying
// ---------------------------------------------------------------------------

#[tokio::test]
async fn http2_to_http2() -> Result<()> {
    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    let echo = env.start_echo_server("127.0.0.1", Protocol::Http2).await;
    let client = env.create_http_client(Protocol::Http2).await;

    let resp = client
        .get(format!(
            "https://127.0.0.1:{}/h2h2",
            echo.listen_addr().port()
        ))
        .send()
        .await?;
    assert!(resp.status().is_success());

    let body: EchoResponse = resp.json().await?;
    assert_eq!(body.path, "/h2h2");
    assert!(
        body.headers
            .get("witmproxy")
            .is_some_and(|v| v.contains("req"))
    );

    echo.shutdown().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// HTTP/2 client ↔ HTTP/1.1 upstream
// ---------------------------------------------------------------------------

#[tokio::test]
async fn http2_to_http1() -> Result<()> {
    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    let echo = env.start_echo_server("127.0.0.1", Protocol::Http1).await;
    let client = env.create_http_client(Protocol::Http2).await;

    let resp = client
        .get(format!(
            "https://127.0.0.1:{}/h2h1",
            echo.listen_addr().port()
        ))
        .send()
        .await?;
    assert!(resp.status().is_success());

    let body: EchoResponse = resp.json().await?;
    assert_eq!(body.path, "/h2h1");

    echo.shutdown().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// HTTP/1.1 client ↔ HTTP/2 upstream
// ---------------------------------------------------------------------------

#[tokio::test]
async fn http1_to_http2() -> Result<()> {
    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    let echo = env.start_echo_server("127.0.0.1", Protocol::Http2).await;
    let client = env.create_http_client(Protocol::Http1).await;

    let resp = client
        .get(format!(
            "https://127.0.0.1:{}/h1h2",
            echo.listen_addr().port()
        ))
        .send()
        .await?;
    assert!(resp.status().is_success());

    let body: EchoResponse = resp.json().await?;
    assert_eq!(body.path, "/h1h2");

    echo.shutdown().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Plugin: both request and response modified in single request
// ---------------------------------------------------------------------------

#[tokio::test]
async fn plugin_modifies_request_and_response() -> Result<()> {
    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    let echo = env.start_echo_server("127.0.0.1", Protocol::Http2).await;
    let client = env.create_http_client(Protocol::Http2).await;

    let resp = client
        .get(format!(
            "https://127.0.0.1:{}/both",
            echo.listen_addr().port()
        ))
        .send()
        .await?;

    // Check response header
    let resp_header = resp.headers().get("witmproxy").cloned();
    let body: EchoResponse = resp.json().await?;

    // Check request header (as seen by upstream)
    assert!(
        body.headers
            .get("witmproxy")
            .is_some_and(|v| v.contains("req")),
        "Plugin should add request header"
    );
    assert!(
        resp_header.is_some_and(|v| v.to_str().unwrap().contains("res")),
        "Plugin should add response header"
    );

    echo.shutdown().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// POST request body passthrough (noop plugin — no request reconstruction)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_request_body_passthrough() -> Result<()> {
    let env = TestEnv::start().await?;
    // Use noop plugin so method/body are preserved faithfully
    env.register_noop_plugin().await?;

    let echo = env.start_echo_server("127.0.0.1", Protocol::Http2).await;
    let client = env.create_http_client(Protocol::Http2).await;

    let resp = client
        .post(format!(
            "https://127.0.0.1:{}/post-body",
            echo.listen_addr().port()
        ))
        .body("hello world")
        .send()
        .await?;

    let body: EchoResponse = resp.json().await?;
    assert_eq!(body.method, "POST");
    assert_eq!(body.path, "/post-body");
    assert_eq!(body.body.as_deref(), Some("hello world"));

    echo.shutdown().await;
    env.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// InboundContent: non-HTML responses are not processed
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inbound_content_skips_json() -> Result<()> {
    let env = TestEnv::start().await?;
    env.register_test_component().await?;

    // The echo server returns application/json — the test-component's
    // InboundContent scope is `content.content_type() == 'text/html'`, so
    // the JSON body should pass through unmodified.
    let echo = env.start_echo_server("127.0.0.1", Protocol::Http2).await;
    let client = env.create_http_client(Protocol::Http2).await;

    let body = client
        .get(format!(
            "https://127.0.0.1:{}/json-passthrough",
            echo.listen_addr().port()
        ))
        .send()
        .await?
        .text()
        .await?;

    assert!(
        !body.contains("<!-- Processed by `wasm-test-component` plugin -->"),
        "JSON response should not have HTML comment injected"
    );
    // Should still be valid JSON
    let _: EchoResponse = serde_json::from_str(&body)?;

    echo.shutdown().await;
    env.shutdown().await;
    Ok(())
}
