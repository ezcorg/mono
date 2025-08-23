//! Protocol adapter for making plugins work with unified message types
//!
//! This module provides adapters to convert between the new unified ProxyMessage
//! types and the legacy plugin format, ensuring plugins remain protocol-agnostic.

use crate::proxy::message::{ProxyRequest, ProxyResponse};
use crate::wasm::{HttpRequest, HttpResponse, PluginAction, RequestContext};
use std::collections::HashMap;
use tracing::{debug, warn};

/// Adapter for converting between unified proxy messages and plugin format
pub struct ProtocolAdapter;

impl ProtocolAdapter {
    /// Convert a ProxyRequest to the legacy plugin format
    pub fn proxy_request_to_plugin_format(request: &ProxyRequest) -> HttpRequest {
        let headers: HashMap<String, String> = request
            .headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();

        HttpRequest {
            method: request.method.to_string(),
            url: request.uri.to_string(),
            headers,
            body: request.body.clone(),
        }
    }

    /// Convert a ProxyResponse to the legacy plugin format
    pub fn proxy_response_to_plugin_format(response: &ProxyResponse) -> HttpResponse {
        let headers: HashMap<String, String> = response
            .headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();

        HttpResponse {
            status: response.status.as_u16(),
            headers,
            body: response.body.clone(),
        }
    }

    /// Convert plugin format request back to ProxyRequest
    pub fn plugin_format_to_proxy_request(
        plugin_request: &HttpRequest,
        original_protocol: crate::proxy::message::HttpProtocol,
    ) -> Result<ProxyRequest, Box<dyn std::error::Error>> {
        let method = plugin_request.method.parse()?;
        let uri = plugin_request.url.parse()?;

        let mut headers = http::HeaderMap::new();
        for (k, v) in &plugin_request.headers {
            let header_name: http::HeaderName = k.parse()?;
            let header_value: http::HeaderValue = v.parse()?;
            headers.insert(header_name, header_value);
        }

        Ok(ProxyRequest::new(
            method,
            uri,
            headers,
            plugin_request.body.clone(),
            original_protocol,
        ))
    }

    /// Convert plugin format response back to ProxyResponse
    pub fn plugin_format_to_proxy_response(
        plugin_response: &HttpResponse,
        original_protocol: crate::proxy::message::HttpProtocol,
    ) -> Result<ProxyResponse, Box<dyn std::error::Error>> {
        let status = http::StatusCode::from_u16(plugin_response.status)?;

        let mut headers = http::HeaderMap::new();
        for (k, v) in &plugin_response.headers {
            let header_name: http::HeaderName = k.parse()?;
            let header_value: http::HeaderValue = v.parse()?;
            headers.insert(header_name, header_value);
        }

        Ok(ProxyResponse::new(
            status,
            headers,
            plugin_response.body.clone(),
            original_protocol,
        ))
    }

    /// Apply plugin actions to a ProxyRequest
    pub fn apply_plugin_actions_to_request(
        request: &mut ProxyRequest,
        actions: &[PluginAction],
    ) -> Result<(), Box<dyn std::error::Error>> {
        for action in actions {
            match action {
                PluginAction::ModifyRequest(modified_request) => {
                    debug!("Applying request modification from plugin");

                    // Convert the modified request back to ProxyRequest format
                    let modified_proxy_request =
                        Self::plugin_format_to_proxy_request(modified_request, request.protocol)?;

                    // Apply the modifications
                    request.method = modified_proxy_request.method;
                    request.uri = modified_proxy_request.uri;
                    request.headers = modified_proxy_request.headers;
                    request.body = modified_proxy_request.body;
                }
                PluginAction::Continue => {
                    // No action needed
                }
                PluginAction::Block(_) | PluginAction::Redirect(_) => {
                    // These should be handled at a higher level
                    debug!("Block/Redirect action should be handled by caller");
                }
                PluginAction::ModifyResponse(_) => {
                    warn!("Response modification action applied to request - ignoring");
                }
            }
        }
        Ok(())
    }

    /// Apply plugin actions to a ProxyResponse
    pub fn apply_plugin_actions_to_response(
        response: &mut ProxyResponse,
        actions: &[PluginAction],
    ) -> Result<(), Box<dyn std::error::Error>> {
        for action in actions {
            match action {
                PluginAction::ModifyResponse(modified_response) => {
                    debug!("Applying response modification from plugin");

                    // Convert the modified response back to ProxyResponse format
                    let modified_proxy_response = Self::plugin_format_to_proxy_response(
                        modified_response,
                        response.protocol,
                    )?;

                    // Apply the modifications
                    response.status = modified_proxy_response.status;
                    response.headers = modified_proxy_response.headers;
                    response.body = modified_proxy_response.body;
                }
                PluginAction::Continue => {
                    // No action needed
                }
                PluginAction::Block(_) | PluginAction::Redirect(_) => {
                    // These should be handled at a higher level
                    debug!("Block/Redirect action should be handled by caller");
                }
                PluginAction::ModifyRequest(_) => {
                    warn!("Request modification action applied to response - ignoring");
                }
            }
        }
        Ok(())
    }

    /// Create a RequestContext from ProxyRequest and ProxyResponse
    pub fn create_request_context_from_proxy_messages(
        request_id: String,
        client_ip: std::net::IpAddr,
        target_host: String,
        proxy_request: &ProxyRequest,
        proxy_response: Option<&ProxyResponse>,
    ) -> RequestContext {
        let request = Self::proxy_request_to_plugin_format(proxy_request);
        let response = proxy_response.map(|r| Self::proxy_response_to_plugin_format(r));

        RequestContext {
            request_id,
            client_ip,
            target_host,
            request,
            response,
        }
    }

    /// Check if any plugin actions require immediate handling (block/redirect)
    pub fn has_immediate_actions(actions: &[PluginAction]) -> bool {
        actions
            .iter()
            .any(|action| matches!(action, PluginAction::Block(_) | PluginAction::Redirect(_)))
    }

    /// Extract block/redirect actions from a list of plugin actions
    pub fn extract_immediate_actions(actions: &[PluginAction]) -> Vec<&PluginAction> {
        actions
            .iter()
            .filter(|action| matches!(action, PluginAction::Block(_) | PluginAction::Redirect(_)))
            .collect()
    }

    /// Extract modification actions from a list of plugin actions
    pub fn extract_modification_actions(actions: &[PluginAction]) -> Vec<&PluginAction> {
        actions
            .iter()
            .filter(|action| {
                matches!(
                    action,
                    PluginAction::ModifyRequest(_) | PluginAction::ModifyResponse(_)
                )
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::message::{HttpProtocol, ProxyRequest, ProxyResponse};
    use http::{HeaderMap, Method, StatusCode, Uri};
    use std::collections::HashMap;

    #[test]
    fn test_proxy_request_to_plugin_format() {
        let mut headers = HeaderMap::new();
        headers.insert("content-type", "application/json".parse().unwrap());
        headers.insert("user-agent", "test-agent".parse().unwrap());

        let proxy_request = ProxyRequest::new(
            Method::POST,
            "https://example.com/api".parse().unwrap(),
            headers,
            b"test body".to_vec(),
            HttpProtocol::Http2,
        );

        let plugin_request = ProtocolAdapter::proxy_request_to_plugin_format(&proxy_request);

        assert_eq!(plugin_request.method, "POST");
        assert_eq!(plugin_request.url, "https://example.com/api");
        assert_eq!(plugin_request.body, b"test body");
        assert_eq!(
            plugin_request.headers.get("content-type"),
            Some(&"application/json".to_string())
        );
        assert_eq!(
            plugin_request.headers.get("user-agent"),
            Some(&"test-agent".to_string())
        );
    }

    #[test]
    fn test_proxy_response_to_plugin_format() {
        let mut headers = HeaderMap::new();
        headers.insert("content-type", "application/json".parse().unwrap());

        let proxy_response = ProxyResponse::new(
            StatusCode::OK,
            headers,
            b"response body".to_vec(),
            HttpProtocol::Http1_1,
        );

        let plugin_response = ProtocolAdapter::proxy_response_to_plugin_format(&proxy_response);

        assert_eq!(plugin_response.status, 200);
        assert_eq!(plugin_response.body, b"response body");
        assert_eq!(
            plugin_response.headers.get("content-type"),
            Some(&"application/json".to_string())
        );
    }

    #[test]
    fn test_plugin_format_to_proxy_request() {
        let mut headers = HashMap::new();
        headers.insert("content-type".to_string(), "text/plain".to_string());

        let plugin_request = HttpRequest {
            method: "GET".to_string(),
            url: "https://example.com/test".to_string(),
            headers,
            body: b"test".to_vec(),
        };

        let proxy_request =
            ProtocolAdapter::plugin_format_to_proxy_request(&plugin_request, HttpProtocol::Http3)
                .unwrap();

        assert_eq!(proxy_request.method, Method::GET);
        assert_eq!(proxy_request.uri.to_string(), "https://example.com/test");
        assert_eq!(proxy_request.body, b"test");
        assert_eq!(proxy_request.protocol, HttpProtocol::Http3);
    }

    #[test]
    fn test_has_immediate_actions() {
        let actions = vec![
            PluginAction::Continue,
            PluginAction::Block("test".to_string()),
            PluginAction::ModifyRequest(HttpRequest {
                method: "GET".to_string(),
                url: "https://example.com".to_string(),
                headers: HashMap::new(),
                body: Vec::new(),
            }),
        ];

        assert!(ProtocolAdapter::has_immediate_actions(&actions));

        let actions_no_immediate = vec![
            PluginAction::Continue,
            PluginAction::ModifyRequest(HttpRequest {
                method: "GET".to_string(),
                url: "https://example.com".to_string(),
                headers: HashMap::new(),
                body: Vec::new(),
            }),
        ];

        assert!(!ProtocolAdapter::has_immediate_actions(
            &actions_no_immediate
        ));
    }
}
