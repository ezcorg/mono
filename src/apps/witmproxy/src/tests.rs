mod tests {
    use anyhow::Result;
    use tracing::debug;
    use tracing_subscriber::field::debug;

    use crate::test_utils::{
        EchoResponse, Protocol, create_client, create_html_server, create_json_echo_server,
        create_witmproxy, register_test_component,
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
            .get(&format!(
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
            .get(&format!(
                "https://127.0.0.1:{}/",
                target.listen_addr().port()
            ))
            .send()
            .await
            .unwrap();

        // Debug: check response status and headers
        eprintln!("Response status: {}", resp.status());
        eprintln!("Response headers: {:?}", resp.headers());

        let response_text = resp.text().await.unwrap();
        eprintln!("Response text length: {}", response_text.len());
        eprintln!("Response text: {}", response_text);

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
}
