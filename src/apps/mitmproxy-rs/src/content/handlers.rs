use super::{ContentParser, ParsedContent};
use crate::wasm::{EventType, PluginAction, RequestContext};
use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info};

/// Result of content handler execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum HandlerResult {
    Continue,
    Block(String),
    Redirect(String),
    ModifyContent(ParsedContent),
    ModifyRaw(Vec<u8>),
}

/// Trait for content-specific handlers
#[async_trait]
pub trait ContentHandler: Send + Sync + std::fmt::Debug {
    /// Handle parsed JSON content
    async fn handle_json(
        &self,
        context: &RequestContext,
        json_data: &serde_json::Value,
        event_type: EventType,
    ) -> Result<HandlerResult>;

    /// Handle parsed HTML content
    async fn handle_html(
        &self,
        context: &RequestContext,
        html_doc: &super::HtmlDocument,
        event_type: EventType,
    ) -> Result<HandlerResult>;

    /// Handle text content
    async fn handle_text(
        &self,
        context: &RequestContext,
        text: &str,
        event_type: EventType,
    ) -> Result<HandlerResult>;

    /// Handle binary content
    async fn handle_binary(
        &self,
        context: &RequestContext,
        data: &[u8],
        event_type: EventType,
    ) -> Result<HandlerResult>;

    /// Get handler metadata
    fn get_metadata(&self) -> ContentHandlerMetadata;
}

/// Metadata for content handlers
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentHandlerMetadata {
    pub name: String,
    pub version: String,
    pub description: String,
    pub supported_content_types: Vec<String>,
    pub supported_events: Vec<String>,
}

/// Manager for content-specific handlers
pub struct ContentHandlerManager {
    json_handlers: Arc<RwLock<Vec<Arc<dyn ContentHandler>>>>,
    html_handlers: Arc<RwLock<Vec<Arc<dyn ContentHandler>>>>,
    text_handlers: Arc<RwLock<Vec<Arc<dyn ContentHandler>>>>,
    binary_handlers: Arc<RwLock<Vec<Arc<dyn ContentHandler>>>>,
}

impl ContentHandlerManager {
    pub fn new() -> Self {
        Self {
            json_handlers: Arc::new(RwLock::new(Vec::new())),
            html_handlers: Arc::new(RwLock::new(Vec::new())),
            text_handlers: Arc::new(RwLock::new(Vec::new())),
            binary_handlers: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Register a JSON content handler
    pub async fn register_json_handler(&self, handler: Arc<dyn ContentHandler>) {
        let mut handlers = self.json_handlers.write().await;
        handlers.push(handler);
        info!("Registered JSON content handler");
    }

    /// Register an HTML content handler
    pub async fn register_html_handler(&self, handler: Arc<dyn ContentHandler>) {
        let mut handlers = self.html_handlers.write().await;
        handlers.push(handler);
        info!("Registered HTML content handler");
    }

    /// Register a text content handler
    pub async fn register_text_handler(&self, handler: Arc<dyn ContentHandler>) {
        let mut handlers = self.text_handlers.write().await;
        handlers.push(handler);
        info!("Registered text content handler");
    }

    /// Register a binary content handler
    pub async fn register_binary_handler(&self, handler: Arc<dyn ContentHandler>) {
        let mut handlers = self.binary_handlers.write().await;
        handlers.push(handler);
        info!("Registered binary content handler");
    }

    /// Process content with appropriate handlers
    pub async fn process_content(
        &self,
        context: &RequestContext,
        content_type: &str,
        body: &[u8],
        event_type: EventType,
    ) -> Result<Vec<HandlerResult>> {
        // Parse content based on type
        let parsed_content = ContentParser::parse(content_type, body)?;

        debug!(
            "Processing {} content for event {:?}",
            content_type, event_type
        );

        let mut results = Vec::new();

        match parsed_content {
            ParsedContent::Json(ref json_data) => {
                let handlers = self.json_handlers.read().await;
                for handler in handlers.iter() {
                    match handler
                        .handle_json(context, json_data, event_type.clone())
                        .await
                    {
                        Ok(result) => results.push(result),
                        Err(e) => {
                            error!("JSON handler failed: {}", e);
                        }
                    }
                }
            }
            ParsedContent::Html(ref html_doc) => {
                let handlers = self.html_handlers.read().await;
                for handler in handlers.iter() {
                    match handler
                        .handle_html(context, html_doc, event_type.clone())
                        .await
                    {
                        Ok(result) => results.push(result),
                        Err(e) => {
                            error!("HTML handler failed: {}", e);
                        }
                    }
                }
            }
            ParsedContent::Text(ref text) => {
                let handlers = self.text_handlers.read().await;
                for handler in handlers.iter() {
                    match handler.handle_text(context, text, event_type.clone()).await {
                        Ok(result) => results.push(result),
                        Err(e) => {
                            error!("Text handler failed: {}", e);
                        }
                    }
                }
            }
            ParsedContent::Binary(ref data) => {
                let handlers = self.binary_handlers.read().await;
                for handler in handlers.iter() {
                    match handler
                        .handle_binary(context, data, event_type.clone())
                        .await
                    {
                        Ok(result) => results.push(result),
                        Err(e) => {
                            error!("Binary handler failed: {}", e);
                        }
                    }
                }
            }
        }

        Ok(results)
    }

    /// Check if there are any handlers for the given content type
    pub async fn has_handlers_for_content_type(&self, content_type: &str) -> bool {
        if super::is_json_content(content_type) {
            let handlers = self.json_handlers.read().await;
            !handlers.is_empty()
        } else if super::is_html_content(content_type) {
            let handlers = self.html_handlers.read().await;
            !handlers.is_empty()
        } else if content_type.starts_with("text/") {
            let handlers = self.text_handlers.read().await;
            !handlers.is_empty()
        } else {
            let handlers = self.binary_handlers.read().await;
            !handlers.is_empty()
        }
    }

    /// Get all registered handler metadata
    pub async fn get_handler_metadata(&self) -> Vec<ContentHandlerMetadata> {
        let mut metadata = Vec::new();

        // Collect JSON handler metadata
        let json_handlers = self.json_handlers.read().await;
        for handler in json_handlers.iter() {
            metadata.push(handler.get_metadata());
        }

        // Collect HTML handler metadata
        let html_handlers = self.html_handlers.read().await;
        for handler in html_handlers.iter() {
            metadata.push(handler.get_metadata());
        }

        // Collect text handler metadata
        let text_handlers = self.text_handlers.read().await;
        for handler in text_handlers.iter() {
            metadata.push(handler.get_metadata());
        }

        // Collect binary handler metadata
        let binary_handlers = self.binary_handlers.read().await;
        for handler in binary_handlers.iter() {
            metadata.push(handler.get_metadata());
        }

        metadata
    }
}

impl Default for ContentHandlerManager {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for ContentHandlerManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ContentHandlerManager")
            .field("json_handlers", &"<handlers>")
            .field("html_handlers", &"<handlers>")
            .field("text_handlers", &"<handlers>")
            .field("binary_handlers", &"<handlers>")
            .finish()
    }
}

/// Convert HandlerResult to PluginAction
impl From<HandlerResult> for PluginAction {
    fn from(result: HandlerResult) -> Self {
        match result {
            HandlerResult::Continue => PluginAction::Continue,
            HandlerResult::Block(reason) => PluginAction::Block(reason),
            HandlerResult::Redirect(url) => PluginAction::Redirect(url),
            HandlerResult::ModifyContent(_) => {
                // For now, just continue - in a full implementation,
                // we'd need to serialize the content back to bytes
                PluginAction::Continue
            }
            HandlerResult::ModifyRaw(_data) => {
                // This would need to be handled by modifying the request/response
                PluginAction::Continue
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wasm::HttpRequest;
    use std::collections::HashMap;
    use std::net::IpAddr;

    #[derive(Debug)]
    struct TestJsonHandler;

    #[async_trait]
    impl ContentHandler for TestJsonHandler {
        async fn handle_json(
            &self,
            _context: &RequestContext,
            json_data: &serde_json::Value,
            _event_type: EventType,
        ) -> Result<HandlerResult> {
            if json_data.get("block").is_some() {
                Ok(HandlerResult::Block("Blocked by test handler".to_string()))
            } else {
                Ok(HandlerResult::Continue)
            }
        }

        async fn handle_html(
            &self,
            _context: &RequestContext,
            _html_doc: &super::super::HtmlDocument,
            _event_type: EventType,
        ) -> Result<HandlerResult> {
            Ok(HandlerResult::Continue)
        }

        async fn handle_text(
            &self,
            _context: &RequestContext,
            _text: &str,
            _event_type: EventType,
        ) -> Result<HandlerResult> {
            Ok(HandlerResult::Continue)
        }

        async fn handle_binary(
            &self,
            _context: &RequestContext,
            _data: &[u8],
            _event_type: EventType,
        ) -> Result<HandlerResult> {
            Ok(HandlerResult::Continue)
        }

        fn get_metadata(&self) -> ContentHandlerMetadata {
            ContentHandlerMetadata {
                name: "test-json-handler".to_string(),
                version: "1.0.0".to_string(),
                description: "Test JSON handler".to_string(),
                supported_content_types: vec!["application/json".to_string()],
                supported_events: vec!["request_body".to_string(), "response_body".to_string()],
            }
        }
    }

    #[tokio::test]
    async fn test_content_handler_manager() {
        let manager = ContentHandlerManager::new();
        let handler = Arc::new(TestJsonHandler);

        manager.register_json_handler(handler).await;

        assert!(
            manager
                .has_handlers_for_content_type("application/json")
                .await
        );
        assert!(!manager.has_handlers_for_content_type("text/html").await);

        let context = RequestContext {
            request_id: "test".to_string(),
            client_ip: "127.0.0.1".parse::<IpAddr>().unwrap(),
            target_host: "example.com".to_string(),
            request: HttpRequest {
                method: "POST".to_string(),
                url: "/api/test".to_string(),
                headers: HashMap::new(),
                body: Vec::new(),
            },
            response: None,
        };

        let json_data = r#"{"test": "value"}"#;
        let results = manager
            .process_content(
                &context,
                "application/json",
                json_data.as_bytes(),
                EventType::RequestBody,
            )
            .await
            .unwrap();

        assert_eq!(results.len(), 1);
        assert!(matches!(results[0], HandlerResult::Continue));

        let block_json = r#"{"block": true}"#;
        let results = manager
            .process_content(
                &context,
                "application/json",
                block_json.as_bytes(),
                EventType::RequestBody,
            )
            .await
            .unwrap();

        assert_eq!(results.len(), 1);
        assert!(matches!(results[0], HandlerResult::Block(_)));
    }
}
