//! Comprehensive tests for multi-protocol proxy support
//!
//! These tests verify that the proxy can handle HTTP/1.1, HTTP/2, and HTTP/3
//! protocols correctly, with proper ALPN negotiation and plugin integration.

use http::{HeaderMap, Method, StatusCode, Uri};
use mitmproxy_rs::proxy::forwarder::UnifiedForwarder;
use mitmproxy_rs::proxy::handlers::{Http1Handler, Http2Handler, Http3Handler};
use mitmproxy_rs::proxy::message::{HttpProtocol, ProxyRequest, ProxyResponse};
use mitmproxy_rs::proxy::protocol::{ProtocolHandler, ProtocolNegotiator, RequestContext};
use mitmproxy_rs::proxy::DnsResolver;
use mitmproxy_rs::wasm::{HttpRequest, HttpResponse, PluginAction, ProtocolAdapter};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio;

/// Test that protocol handlers can be created and implement the correct protocol
#[tokio::test]
async fn test_protocol_handler_creation() {
    let http1_handler = Http1Handler::new();
    let http2_handler = Http2Handler::new();
    let http3_handler = Http3Handler::new();

    assert_eq!(http1_handler.protocol(), HttpProtocol::Http1_1);
    assert_eq!(http2_handler.protocol(), HttpProtocol::Http2);
    assert_eq!(http3_handler.protocol(), HttpProtocol::Http3);
}

/// Test ALPN protocol negotiation
#[test]
fn test_alpn_protocol_negotiation() {
    let mut negotiator = ProtocolNegotiator::new();

    // Register handlers
    negotiator.register_handler(Box::new(Http1Handler::new()));
    negotiator.register_handler(Box::new(Http2Handler::new()));
    negotiator.register_handler(Box::new(Http3Handler::new()));

    // Test HTTP/2 negotiation
    let result = negotiator.negotiate_protocol(Some(b"h2"));
    assert!(matches!(
        result,
        mitmproxy_rs::proxy::protocol::ProtocolNegotiation::Http2
    ));

    // Test HTTP/1.1 negotiation
    let result = negotiator.negotiate_protocol(Some(b"http/1.1"));
    assert!(matches!(
        result,
        mitmproxy_rs::proxy::protocol::ProtocolNegotiation::Http1_1
    ));

    // Test HTTP/3 negotiation
    let result = negotiator.negotiate_protocol(Some(b"h3"));
    assert!(matches!(
        result,
        mitmproxy_rs::proxy::protocol::ProtocolNegotiation::Http3
    ));

    // Test unknown protocol
    let result = negotiator.negotiate_protocol(Some(b"unknown"));
    assert!(matches!(
        result,
        mitmproxy_rs::proxy::protocol::ProtocolNegotiation::Unsupported(_)
    ));

    // Test no ALPN (should default to HTTP/1.1)
    let result = negotiator.negotiate_protocol(None);
    assert!(matches!(
        result,
        mitmproxy_rs::proxy::protocol::ProtocolNegotiation::Http1_1
    ));
}

/// Test unified forwarder creation and protocol selection
#[tokio::test]
async fn test_unified_forwarder() {
    let dns_resolver = Arc::new(DnsResolver::new().await.unwrap());
    let forwarder = UnifiedForwarder::new(dns_resolver);

    // Test protocol support detection
    let protocols = forwarder.get_supported_protocols("example.com", 443).await;
    assert!(protocols.contains(&HttpProtocol::Http2));
    assert!(protocols.contains(&HttpProtocol::Http1_1));

    let protocols = forwarder.get_supported_protocols("example.com", 80).await;
    assert!(protocols.contains(&HttpProtocol::Http1_1));

    // Test protocol support checking
    assert!(
        forwarder
            .is_protocol_supported("example.com", 443, HttpProtocol::Http2)
            .await
    );
    assert!(
        forwarder
            .is_protocol_supported("example.com", 80, HttpProtocol::Http1_1)
            .await
    );
}

/// Test protocol adapter for plugin integration
#[test]
fn test_protocol_adapter() {
    // Create a test ProxyRequest
    let mut headers = HeaderMap::new();
    headers.insert("content-type", "application/json".parse().unwrap());
    headers.insert("user-agent", "test-agent/1.0".parse().unwrap());

    let proxy_request = ProxyRequest::new(
        Method::POST,
        "https://api.example.com/data".parse().unwrap(),
        headers,
        b"test request body".to_vec(),
        HttpProtocol::Http2,
    );

    // Convert to plugin format
    let plugin_request = ProtocolAdapter::proxy_request_to_plugin_format(&proxy_request);

    assert_eq!(plugin_request.method, "POST");
    assert_eq!(plugin_request.url, "https://api.example.com/data");
    assert_eq!(plugin_request.body, b"test request body");
    assert_eq!(
        plugin_request.headers.get("content-type"),
        Some(&"application/json".to_string())
    );
    assert_eq!(
        plugin_request.headers.get("user-agent"),
        Some(&"test-agent/1.0".to_string())
    );

    // Convert back to ProxyRequest
    let converted_back =
        ProtocolAdapter::plugin_format_to_proxy_request(&plugin_request, HttpProtocol::Http2)
            .unwrap();

    assert_eq!(converted_back.method, proxy_request.method);
    assert_eq!(converted_back.uri, proxy_request.uri);
    assert_eq!(converted_back.protocol, proxy_request.protocol);
    assert_eq!(converted_back.body, proxy_request.body);
}

/// Test protocol adapter with response messages
#[test]
fn test_protocol_adapter_response() {
    // Create a test ProxyResponse
    let mut headers = HeaderMap::new();
    headers.insert("content-type", "application/json".parse().unwrap());
    headers.insert("server", "test-server/1.0".parse().unwrap());

    let proxy_response = ProxyResponse::new(
        StatusCode::OK,
        headers,
        b"test response body".to_vec(),
        HttpProtocol::Http1_1,
    );

    // Convert to plugin format
    let plugin_response = ProtocolAdapter::proxy_response_to_plugin_format(&proxy_response);

    assert_eq!(plugin_response.status, 200);
    assert_eq!(plugin_response.body, b"test response body");
    assert_eq!(
        plugin_response.headers.get("content-type"),
        Some(&"application/json".to_string())
    );
    assert_eq!(
        plugin_response.headers.get("server"),
        Some(&"test-server/1.0".to_string())
    );

    // Convert back to ProxyResponse
    let converted_back =
        ProtocolAdapter::plugin_format_to_proxy_response(&plugin_response, HttpProtocol::Http1_1)
            .unwrap();

    assert_eq!(converted_back.status, proxy_response.status);
    assert_eq!(converted_back.protocol, proxy_response.protocol);
    assert_eq!(converted_back.body, proxy_response.body);
}

/// Test plugin action handling
#[test]
fn test_plugin_action_handling() {
    let actions = vec![
        PluginAction::Continue,
        PluginAction::Block("Blocked by security policy".to_string()),
        PluginAction::ModifyRequest(HttpRequest {
            method: "GET".to_string(),
            url: "https://example.com/modified".to_string(),
            headers: HashMap::new(),
            body: Vec::new(),
        }),
    ];

    // Test immediate action detection
    assert!(ProtocolAdapter::has_immediate_actions(&actions));

    let immediate_actions = ProtocolAdapter::extract_immediate_actions(&actions);
    assert_eq!(immediate_actions.len(), 1);
    assert!(matches!(immediate_actions[0], PluginAction::Block(_)));

    let modification_actions = ProtocolAdapter::extract_modification_actions(&actions);
    assert_eq!(modification_actions.len(), 1);
    assert!(matches!(
        modification_actions[0],
        PluginAction::ModifyRequest(_)
    ));
}

/// Test request modification through protocol adapter
#[test]
fn test_request_modification() {
    let mut proxy_request = ProxyRequest::new(
        Method::GET,
        "https://example.com/original".parse().unwrap(),
        HeaderMap::new(),
        Vec::new(),
        HttpProtocol::Http1_1,
    );

    let mut modified_headers = HashMap::new();
    modified_headers.insert("x-modified".to_string(), "true".to_string());

    let actions = vec![PluginAction::ModifyRequest(HttpRequest {
        method: "POST".to_string(),
        url: "https://example.com/modified".to_string(),
        headers: modified_headers,
        body: b"modified body".to_vec(),
    })];

    // Apply modifications
    ProtocolAdapter::apply_plugin_actions_to_request(&mut proxy_request, &actions).unwrap();

    assert_eq!(proxy_request.method, Method::POST);
    assert_eq!(
        proxy_request.uri.to_string(),
        "https://example.com/modified"
    );
    assert_eq!(proxy_request.body, b"modified body");
    assert!(proxy_request.headers.contains_key("x-modified"));
}

/// Test response modification through protocol adapter
#[test]
fn test_response_modification() {
    let mut proxy_response = ProxyResponse::new(
        StatusCode::OK,
        HeaderMap::new(),
        b"original body".to_vec(),
        HttpProtocol::Http2,
    );

    let mut modified_headers = HashMap::new();
    modified_headers.insert("x-modified".to_string(), "true".to_string());

    let actions = vec![PluginAction::ModifyResponse(HttpResponse {
        status: 201,
        headers: modified_headers,
        body: b"modified response body".to_vec(),
    })];

    // Apply modifications
    ProtocolAdapter::apply_plugin_actions_to_response(&mut proxy_response, &actions).unwrap();

    assert_eq!(proxy_response.status, StatusCode::CREATED);
    assert_eq!(proxy_response.body, b"modified response body");
    assert!(proxy_response.headers.contains_key("x-modified"));
}

/// Test message conversion between protocols
#[test]
fn test_cross_protocol_message_conversion() {
    // Test that messages can be converted between different protocols
    let original_request = ProxyRequest::new(
        Method::GET,
        "https://example.com/test".parse().unwrap(),
        HeaderMap::new(),
        b"test body".to_vec(),
        HttpProtocol::Http1_1,
    );

    // Convert to plugin format (protocol-agnostic)
    let plugin_format = ProtocolAdapter::proxy_request_to_plugin_format(&original_request);

    // Convert back to different protocol
    let http2_request =
        ProtocolAdapter::plugin_format_to_proxy_request(&plugin_format, HttpProtocol::Http2)
            .unwrap();

    let http3_request =
        ProtocolAdapter::plugin_format_to_proxy_request(&plugin_format, HttpProtocol::Http3)
            .unwrap();

    // Verify that the core message content is preserved across protocols
    assert_eq!(original_request.method, http2_request.method);
    assert_eq!(original_request.method, http3_request.method);
    assert_eq!(original_request.uri, http2_request.uri);
    assert_eq!(original_request.uri, http3_request.uri);
    assert_eq!(original_request.body, http2_request.body);
    assert_eq!(original_request.body, http3_request.body);

    // Verify that protocols are correctly set
    assert_eq!(http2_request.protocol, HttpProtocol::Http2);
    assert_eq!(http3_request.protocol, HttpProtocol::Http3);
}

/// Test that HTTP versions are correctly mapped to protocols
#[test]
fn test_http_version_mapping() {
    use http::Version;

    assert_eq!(HttpProtocol::Http1_1.http_version(), Version::HTTP_11);
    assert_eq!(HttpProtocol::Http2.http_version(), Version::HTTP_2);
    assert_eq!(HttpProtocol::Http3.http_version(), Version::HTTP_3);
}

/// Test ALPN identifier mapping
#[test]
fn test_alpn_identifier_mapping() {
    assert_eq!(HttpProtocol::Http1_1.alpn_id(), b"http/1.1");
    assert_eq!(HttpProtocol::Http2.alpn_id(), b"h2");
    assert_eq!(HttpProtocol::Http3.alpn_id(), b"h3");

    assert_eq!(
        HttpProtocol::from_alpn(b"http/1.1"),
        Some(HttpProtocol::Http1_1)
    );
    assert_eq!(HttpProtocol::from_alpn(b"h2"), Some(HttpProtocol::Http2));
    assert_eq!(HttpProtocol::from_alpn(b"h3"), Some(HttpProtocol::Http3));
    assert_eq!(HttpProtocol::from_alpn(b"unknown"), None);
}

/// Integration test that demonstrates the full multi-protocol flow
#[tokio::test]
async fn test_multi_protocol_integration() {
    // This test demonstrates how all the components work together

    // 1. Create protocol handlers
    let http1_handler = Http1Handler::new();
    let http2_handler = Http2Handler::new();
    let http3_handler = Http3Handler::new();

    // 2. Create protocol negotiator
    let mut negotiator = ProtocolNegotiator::new();
    negotiator.register_handler(Box::new(http1_handler));
    negotiator.register_handler(Box::new(http2_handler));
    negotiator.register_handler(Box::new(http3_handler));

    // 3. Test protocol negotiation
    let supported_protocols = negotiator.supported_alpn_protocols();
    assert!(supported_protocols.contains(&b"http/1.1".to_vec()));
    assert!(supported_protocols.contains(&b"h2".to_vec()));
    assert!(supported_protocols.contains(&b"h3".to_vec()));

    // 4. Create unified forwarder
    let dns_resolver = Arc::new(DnsResolver::new().await.unwrap());
    let forwarder = UnifiedForwarder::new(dns_resolver);

    // 5. Test that forwarder can handle different protocols
    let stats = forwarder.get_stats();
    assert_eq!(stats.total_requests, 0); // No requests processed yet

    // 6. Create a test request and demonstrate protocol adapter usage
    let test_request = ProxyRequest::new(
        Method::GET,
        "https://httpbin.org/get".parse().unwrap(),
        HeaderMap::new(),
        Vec::new(),
        HttpProtocol::Http2,
    );

    // 7. Convert to plugin format and back
    let plugin_format = ProtocolAdapter::proxy_request_to_plugin_format(&test_request);
    let converted_back = ProtocolAdapter::plugin_format_to_proxy_request(
        &plugin_format,
        HttpProtocol::Http1_1, // Convert to different protocol
    )
    .unwrap();

    // 8. Verify that the message content is preserved but protocol changed
    assert_eq!(test_request.method, converted_back.method);
    assert_eq!(test_request.uri, converted_back.uri);
    assert_eq!(test_request.body, converted_back.body);
    assert_ne!(test_request.protocol, converted_back.protocol);
    assert_eq!(converted_back.protocol, HttpProtocol::Http1_1);
}

/// Test error handling in protocol conversion
#[test]
fn test_protocol_conversion_error_handling() {
    // Test invalid method
    let invalid_request = HttpRequest {
        method: "INVALID_METHOD".to_string(),
        url: "https://example.com".to_string(),
        headers: HashMap::new(),
        body: Vec::new(),
    };

    let result =
        ProtocolAdapter::plugin_format_to_proxy_request(&invalid_request, HttpProtocol::Http1_1);
    assert!(result.is_err());

    // Test invalid URL
    let invalid_url_request = HttpRequest {
        method: "GET".to_string(),
        url: "not-a-valid-url".to_string(),
        headers: HashMap::new(),
        body: Vec::new(),
    };

    let result = ProtocolAdapter::plugin_format_to_proxy_request(
        &invalid_url_request,
        HttpProtocol::Http1_1,
    );
    assert!(result.is_err());

    // Test invalid status code
    let invalid_response = HttpResponse {
        status: 999, // Invalid status code
        headers: HashMap::new(),
        body: Vec::new(),
    };

    let result =
        ProtocolAdapter::plugin_format_to_proxy_response(&invalid_response, HttpProtocol::Http1_1);
    assert!(result.is_err());
}
