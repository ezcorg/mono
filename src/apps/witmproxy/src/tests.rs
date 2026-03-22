use anyhow::Result;
use tracing::debug;

use crate::test_utils::{
    EchoResponse, Protocol, create_client, create_html_server, create_json_echo_server,
    create_witmproxy, register_noshorts_plugin, register_test_component,
};

#[tokio::test]
async fn e2e_simple_json_test() -> Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(format!("witmproxy={},{}", "debug", "info"))
        .try_init();
    let (mut proxy, registry, ca, _config, _temp_dir) = create_witmproxy().await?;
    proxy.start().await.unwrap();

    // Register test component, ensure write lock is dropped after use to prevent deadlock
    {
        let mut registry = registry.write().await;
        register_test_component(&mut registry).await.unwrap();
    }

    let target = create_json_echo_server("127.0.0.1", None, ca.clone(), Protocol::Http2).await;
    let client = create_client(
        ca,
        &format!("http://{}", proxy.proxy_listen_addr().unwrap()),
        Protocol::Http2,
    )
    .await;
    let resp = client
        .get(format!(
            "https://127.0.0.1:{}/example",
            target.listen_addr().port()
        ))
        .send()
        .await
        .unwrap();
    let headers = resp.headers().clone();
    let response_text = resp.text().await.unwrap();

    // Try to parse the response as JSON
    let json: EchoResponse = serde_json::from_str(&response_text)
        .map_err(|e| {
            panic!(
                "Failed to parse JSON response: {}. Response body was: '{}'",
                e, response_text
            );
        })
        .unwrap();
    assert_eq!(json.path, "/example");
    assert_eq!(json.method, "GET");

    debug!("Response JSON: {:?}", json);
    // Expect the request header added by the WASM plugin
    assert!(json.headers.contains_key("witmproxy"));
    assert!(json.headers.get("witmproxy").unwrap().contains("req"));
    // Expect the response header added by the WASM plugin
    assert!(headers.contains_key("witmproxy"));
    assert!(
        headers
            .get("witmproxy")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("res")
    );
    Ok(())
}

#[tokio::test]
async fn e2e_simple_html_test() -> Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(format!("witmproxy={},{}", "debug", "info"))
        .try_init();
    let (mut proxy, registry, ca, _config, _temp_dir) = create_witmproxy().await?;
    proxy.start().await.unwrap();

    // Register test component, ensure write lock is dropped after use to prevent deadlock
    {
        let mut registry = registry.write().await;
        register_test_component(&mut registry).await.unwrap();
    }

    let target = create_html_server("127.0.0.1", None, ca.clone(), Protocol::Http2).await;
    let client = create_client(
        ca,
        &format!("http://{}", proxy.proxy_listen_addr().unwrap()),
        Protocol::Http2,
    )
    .await;
    let resp = client
        .get(format!(
            "https://127.0.0.1:{}/",
            target.listen_addr().port()
        ))
        .send()
        .await
        .unwrap();
    let response_text = resp.text().await.unwrap();

    // Verify that the original HTML content is still present
    assert!(
        response_text.contains("<h1>Hello from test server</h1>"),
        "Expected original HTML content to be present. Response was: '{}'",
        response_text
    );

    // Verify that the WASM plugin injected the expected comment
    assert!(
        response_text.contains("<!-- Processed by `wasm-test-component` plugin -->"),
        "Expected HTML to contain injected comment. Response was: '{}'",
        response_text
    );

    // Verify the injected comment comes before the DOCTYPE
    let comment_pos = response_text
        .find("<!-- Processed by `wasm-test-component` plugin -->")
        .expect("Comment should be present");
    let doctype_pos = response_text
        .find("<!DOCTYPE html>")
        .expect("DOCTYPE should be present");
    assert!(
        comment_pos < doctype_pos,
        "Expected comment to be prepended before DOCTYPE"
    );

    Ok(())
}

/// Tests that a plugin using body-streaming subtasks (wit_bindgen::spawn)
/// correctly produces response body data through the proxy.
///
/// This is a regression test for the wasmtime TaskExit removal (PR #12570).
/// Plugins that spawn WASM subtasks to read/transform/write body streams
/// require the store's run_concurrent context to remain alive while the
/// response body is being consumed by the client.
#[tokio::test]
async fn e2e_plugin_body_streaming_subtask() -> Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(format!("witmproxy={},{}", "debug", "info"))
        .try_init();
    let (mut proxy, registry, ca, _config, _temp_dir) = create_witmproxy().await?;
    proxy.start().await.unwrap();

    // Register both plugins:
    // - test component: has Connect scope "true" so MITM is triggered for 127.0.0.1
    // - noshorts: has InboundContent scope matching text/html, uses spawn for body streaming
    {
        let mut registry = registry.write().await;
        register_test_component(&mut registry).await.unwrap();
        register_noshorts_plugin(&mut registry).await.unwrap();
    }

    let target = create_html_server("127.0.0.1", None, ca.clone(), Protocol::Http2).await;
    let client = create_client(
        ca,
        &format!("http://{}", proxy.proxy_listen_addr().unwrap()),
        Protocol::Http2,
    )
    .await;
    let resp = client
        .get(format!(
            "https://127.0.0.1:{}/",
            target.listen_addr().port()
        ))
        .send()
        .await
        .unwrap();

    assert!(
        resp.status().is_success(),
        "Expected successful response, got: {}",
        resp.status()
    );

    let response_text = resp.text().await.unwrap();

    // The noshorts plugin reads the entire body via a spawned subtask,
    // processes it through lol_html, and writes it back via a stream.
    // If the store's concurrent context isn't kept alive, the body will
    // be empty because the subtask can't make progress.
    assert!(
        !response_text.is_empty(),
        "Response body should not be empty (plugin subtask must be driven to completion)"
    );

    // Verify the original HTML content survived the streaming pipeline
    assert!(
        response_text.contains("<h1>Hello from test server</h1>"),
        "Expected original HTML content after plugin processing. Response was: '{}'",
        response_text
    );

    // Verify the noshorts plugin injected its styles via the body-streaming subtask
    assert!(
        response_text.contains(r#"a[href*="shorts"]"#),
        "Expected noshorts CSS selector to be injected. Response was: '{}'",
        response_text
    );

    assert!(
        response_text.contains("<style>"),
        "Expected <style> tag injected by noshorts plugin. Response was: '{}'",
        response_text
    );

    Ok(())
}
