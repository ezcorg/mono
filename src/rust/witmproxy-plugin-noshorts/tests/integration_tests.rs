use anyhow::Result;

#[cfg(test)]
mod e2e_tests {
    use super::*;

    // Import test utilities from witmproxy
    use witmproxy::test_utils::{create_witmproxy, register_noshorts_plugin};

    #[tokio::test]
    async fn test_noshorts_plugin_loads_successfully() -> Result<()> {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(format!("witmproxy={},{}", "debug", "info"))
            .try_init();

        let (mut proxy, registry, _ca, _config, _temp_dir) = create_witmproxy().await?;
        proxy.start().await.unwrap();

        // Verify we can register the noshorts plugin without errors
        {
            let mut registry = registry.write().await;
            register_noshorts_plugin(&mut registry)
                .await
                .expect("Should be able to register noshorts plugin");
        }

        // Verify the plugin is registered
        {
            let registry = registry.read().await;
            let plugins = registry.plugins();
            assert!(
                plugins.values().any(|p| p.name == "noshorts"),
                "noshorts plugin should be registered"
            );
        }

        Ok(())
    }

    #[tokio::test]
    async fn test_noshorts_plugin_real_youtube_request() -> Result<()> {
        use witmproxy::test_utils::{Protocol, create_client};

        let _ = tracing_subscriber::fmt()
            .with_env_filter(format!("witmproxy={},{}", "debug", "info"))
            .try_init();

        let (mut proxy, registry, ca, _config, _temp_dir) = create_witmproxy().await?;
        proxy.start().await.unwrap();

        // Register noshorts plugin
        {
            let mut registry = registry.write().await;
            register_noshorts_plugin(&mut registry).await.unwrap();
        }

        let client = create_client(
            ca,
            &format!("http://{}", proxy.proxy_listen_addr().unwrap()),
            Protocol::Http2,
        )
        .await;

        // Make a real request to YouTube
        let resp = client.get("https://www.youtube.com/").send().await.unwrap();

        let status = resp.status();
        assert!(
            status.is_success() || status.is_redirection(),
            "Expected successful response from YouTube, got: {}",
            status
        );

        let response_text = resp.text().await.unwrap();

        // Verify we got HTML content
        assert!(
            response_text.contains("<html") || response_text.contains("<!DOCTYPE"),
            "Expected HTML content from YouTube"
        );

        // Verify the noshorts plugin injected the CSS styles
        assert!(
            response_text.contains(r#"a[href*="shorts"]"#),
            "Expected CSS to contain shorts selector in real YouTube page"
        );

        assert!(
            response_text.contains(r#"display: none !important"#),
            "Expected CSS to hide shorts in real YouTube page"
        );

        assert!(
            response_text.contains(r#"[is-shorts="true"]"#),
            "Expected CSS to contain is-shorts attribute selector in real YouTube page"
        );

        // Verify the styles are inside a <style> tag
        assert!(
            response_text.contains("<style>"),
            "Expected <style> tag in real YouTube page"
        );

        // If we can find the head tag, verify styles are in the right place
        if let Some(head_pos) = response_text.find("<head") {
            if let Some(style_pos) = response_text.find(r#"a[href*="shorts"]"#) {
                if let Some(head_close_pos) = response_text.find("</head>") {
                    assert!(
                        style_pos > head_pos && style_pos < head_close_pos,
                        "Expected injected styles to be inside <head> tag"
                    );
                }
            }
        }

        println!("Successfully tested noshorts plugin with real YouTube request");
        Ok(())
    }
}
