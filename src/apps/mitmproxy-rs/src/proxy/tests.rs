mod tests {
    use crate::test_utils::{create_client, setup_ca_and_config, start_target_server, Protocol};
    use crate::ProxyServer;

    struct TestCase {
        client_proto: Protocol,
        server_proto: Protocol,
        proxy_port: u16,
        target_port: u16,
    }

    async fn run_test(test: TestCase) {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (ca, config) = setup_ca_and_config().await;
        let server_handle =
            start_target_server("127.0.0.1", test.target_port, ca.clone(), test.server_proto).await;
        let proxy_addr = format!("127.0.0.1:{}", test.proxy_port).parse().unwrap();
        let mut proxy = ProxyServer::new(proxy_addr, ca.clone(), config).unwrap();
        proxy.start().await.unwrap();
        let client = create_client(
            ca,
            &format!("http://127.0.0.1:{}", test.proxy_port),
            test.client_proto,
        )
        .await;
        let resp = client
            .get(&format!("https://127.0.0.1:{}", test.target_port))
            .send()
            .await
            .unwrap();
        let text = resp.text().await.unwrap();
        assert_eq!(text, "hello world");
        proxy.shutdown().await;
        server_handle.shutdown().await;
    }

    #[tokio::test]
    async fn test_http1_to_http1() {
        run_test(TestCase {
            client_proto: Protocol::Http1,
            server_proto: Protocol::Http1,
            proxy_port: 2345,
            target_port: 1234,
        })
        .await;
    }

    #[tokio::test]
    async fn test_http2_to_http1() {
        run_test(TestCase {
            client_proto: Protocol::Http2,
            server_proto: Protocol::Http1,
            proxy_port: 2346,
            target_port: 1235,
        })
        .await;
    }

    #[tokio::test]
    async fn test_http2_to_http2() {
        run_test(TestCase {
            client_proto: Protocol::Http2,
            server_proto: Protocol::Http2,
            proxy_port: 2347,
            target_port: 1236,
        })
        .await;
    }

    #[tokio::test]
    async fn test_http1_to_http2() {
        run_test(TestCase {
            client_proto: Protocol::Http1,
            server_proto: Protocol::Http2,
            proxy_port: 2348,
            target_port: 1237,
        })
        .await;
    }
}
