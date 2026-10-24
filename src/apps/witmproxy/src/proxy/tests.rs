use std::sync::Arc;

use crate::ProxyServer;
use crate::test_utils::{
    Protocol, create_ca_and_config, create_client, create_hello_server, create_plugin_registry,
    register_noop_plugin,
};

struct TestCase {
    client_proto: Protocol,
    server_proto: Protocol,
    proxy_port: u16,
    target_port: u16,
}

async fn run_test(test: TestCase) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (ca, mut config) = create_ca_and_config().await;
    let server_handle =
        create_hello_server("127.0.0.1", test.target_port, ca.clone(), test.server_proto).await;
    let (registry, _temp_dir) = create_plugin_registry().await.unwrap();
    register_noop_plugin(&registry).await.unwrap();

    // Set the specific proxy port for testing
    config.proxy.proxy_bind_addr = Some(format!("127.0.0.1:{}", test.proxy_port));

    let mut proxy = ProxyServer::new(ca.clone(), Some(Arc::new(registry)), config).unwrap();
    proxy.start().await.unwrap();
    let actual_proxy_addr = proxy.listen_addr().unwrap();
    let client = create_client(
        ca,
        &format!("http://{}", actual_proxy_addr),
        test.client_proto,
    )
    .await;
    let resp = client
        .get(format!("https://127.0.0.1:{}", test.target_port))
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

/// A request inside a tunnel to one host, for another host, is refused:
/// otherwise a client allowed to reach only the proxy reaches whatever the
/// proxy can, by writing a Host header.
/// With a policy in force, a CONNECT the rules forbid is answered 403 before
/// any tunnel exists, and one they permit is served as ever.
#[tokio::test]
async fn a_connect_the_policy_forbids_is_refused_before_the_tunnel() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let _ = rustls::crypto::ring::default_provider().install_default();
    let (ca, mut config) = create_ca_and_config().await;
    let permitted_port = 1240;
    let forbidden_port = 1241;
    let permitted =
        create_hello_server("127.0.0.1", permitted_port, ca.clone(), Protocol::Http1).await;
    let forbidden =
        create_hello_server("127.0.0.1", forbidden_port, ca.clone(), Protocol::Http1).await;

    let dir = tempfile::tempdir().unwrap();
    let policy = dir.path().join("policy.toml");
    std::fs::write(
        &policy,
        format!(
            "default = \"forbid\"\n[[rules]]\neffect = \"permit\"\ndst = [\"127.0.0.1:{permitted_port}\"]\ncomment = \"the one server\"\n"
        ),
    )
    .unwrap();
    config.proxy.policy_file = Some(policy);
    config.proxy.proxy_bind_addr = Some("127.0.0.1:2350".to_string());
    let (registry, _temp_dir) = create_plugin_registry().await.unwrap();
    register_noop_plugin(&registry).await.unwrap();

    let mut proxy = ProxyServer::new(ca.clone(), Some(Arc::new(registry)), config).unwrap();
    proxy.start().await.unwrap();
    let proxy_addr = proxy.listen_addr().unwrap();

    // Permitted: served.
    let client = create_client(ca, &format!("http://{}", proxy_addr), Protocol::Http1).await;
    let resp = client
        .get(format!("https://127.0.0.1:{permitted_port}"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.text().await.unwrap(), "hello world");

    // Forbidden: a 403 with the rule, instead of a 200 and a dead tunnel.
    let mut raw = tokio::net::TcpStream::connect(proxy_addr).await.unwrap();
    raw.write_all(
        format!(
            "CONNECT 127.0.0.1:{forbidden_port} HTTP/1.1\r\nHost: 127.0.0.1:{forbidden_port}\r\n\r\n"
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let mut buf = vec![0u8; 4096];
    let n = raw.read(&mut buf).await.unwrap();
    let answer = String::from_utf8_lossy(&buf[..n]).to_string();
    assert!(answer.starts_with("HTTP/1.1 403"), "{answer}");
    assert!(answer.contains("forbid by default"), "{answer}");

    // A literal the floor forbids says which rule.
    let mut raw = tokio::net::TcpStream::connect(proxy_addr).await.unwrap();
    raw.write_all(b"CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n")
        .await
        .unwrap();
    let n = raw.read(&mut buf).await.unwrap();
    let answer = String::from_utf8_lossy(&buf[..n]).to_string();
    assert!(answer.starts_with("HTTP/1.1 403"), "{answer}");

    proxy.shutdown().await;
    permitted.shutdown().await;
    forbidden.shutdown().await;
}

#[test]
fn a_request_for_another_host_is_misdirected() {
    use crate::proxy::misdirected;
    assert!(!misdirected(Some("api.example.com"), "api.example.com"));
    assert!(!misdirected(Some("API.Example.com."), "api.example.com"));
    assert!(!misdirected(None, "api.example.com"));
    assert!(misdirected(Some("192.168.1.1"), "api.example.com"));
    assert!(misdirected(Some("other.example.com"), "api.example.com"));
}
