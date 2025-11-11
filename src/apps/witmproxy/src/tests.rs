mod tests {
    use anyhow::Result;

    use crate::test_utils::{
        EchoResponse, Protocol, create_client, create_echo_server, create_witmproxy,
        register_test_component,
    };

    #[tokio::test]
    async fn e2e_test() -> Result<()> {
        tracing_subscriber::fmt()
            .with_env_filter(format!("witmproxy={},{}", "debug", "debug"))
            .init();
        let (mut proxy, registry, ca, _config, _temp_dir) = create_witmproxy().await?;
        proxy.start().await.unwrap();

        // Register test component, ensure write lock is dropped after use to prevent deadlock
        {
            let mut registry = registry.write().await;
            register_test_component(&mut registry).await.unwrap();
        }

        let target = create_echo_server("127.0.0.1", None, ca.clone(), Protocol::Http2).await;
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
}
