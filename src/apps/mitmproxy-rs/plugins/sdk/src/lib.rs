use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// Re-export for convenience
pub use paste;
pub use serde_json;

// Memory allocator for WASM
#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

// WASI bindings
#[cfg(target_arch = "wasm32")]
wit_bindgen::generate!({
    world: "mitm-plugin",
    path: "./wit",
});

#[cfg(target_arch = "wasm32")]
use exports::component::mitm_plugin::*;

// Plugin metadata structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginMetadata {
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub events: Vec<String>,
    pub config_schema: Option<serde_json::Value>,
}

// Request/Response structures
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestContext {
    pub request_id: String,
    pub client_ip: String,
    pub target_host: String,
    pub request: HttpRequest,
    pub response: Option<HttpResponse>,
}

// Plugin result types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PluginResult {
    Continue,
    Block(String),
    Redirect(String),
    ModifyData(Vec<u8>),
}

/// Represents different types of parsed content
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ParsedContent {
    Json(serde_json::Value),
    Html(HtmlDocument),
    Text(String),
    Binary(Vec<u8>),
}

/// Simplified HTML document representation for plugins
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HtmlDocument {
    pub title: Option<String>,
    pub meta: HashMap<String, String>,
    pub links: Vec<HtmlLink>,
    pub forms: Vec<HtmlForm>,
    pub scripts: Vec<String>,
    pub text_content: String,
    pub raw_html: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HtmlLink {
    pub href: String,
    pub rel: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HtmlForm {
    pub action: Option<String>,
    pub method: String,
    pub inputs: Vec<HtmlInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HtmlInput {
    pub name: Option<String>,
    pub input_type: String,
    pub value: Option<String>,
}

// Log levels
#[derive(Debug, Clone, Copy)]
pub enum LogLevel {
    Error = 0,
    Warn = 1,
    Info = 2,
    Debug = 3,
    Trace = 4,
}

// WASI imports are now handled by wit-bindgen

// WASI components handle memory management automatically

// Helper functions for plugins using WASI
pub struct PluginApi;

impl PluginApi {
    /// Log a message to the host using WASI logging
    pub fn log(level: LogLevel, message: &str) {
        #[cfg(target_arch = "wasm32")]
        {
            // For now, use web_sys console until WASI logging is properly configured
            let level_str = match level {
                LogLevel::Error => "ERROR",
                LogLevel::Warn => "WARN",
                LogLevel::Info => "INFO",
                LogLevel::Debug => "DEBUG",
                LogLevel::Trace => "TRACE",
            };
            web_sys::console::log_1(&format!("[{}] {}", level_str, message).into());
        }
    }

    /// Store a value in the plugin storage using WASI key-value
    pub fn storage_set(key: &str, value: &serde_json::Value) {
        #[cfg(target_arch = "wasm32")]
        {
            // For now, use localStorage until WASI key-value is properly configured
            if let Some(storage) = web_sys::window().and_then(|w| w.local_storage().ok().flatten())
            {
                let value_str = serde_json::to_string(value).unwrap_or_default();
                let _ = storage.set_item(key, &value_str);
            }
        }
    }

    /// Get a value from the plugin storage using WASI key-value
    pub fn storage_get(key: &str) -> Option<serde_json::Value> {
        #[cfg(target_arch = "wasm32")]
        {
            // For now, use localStorage until WASI key-value is properly configured
            if let Some(storage) = web_sys::window().and_then(|w| w.local_storage().ok().flatten())
            {
                if let Ok(Some(value_str)) = storage.get_item(key) {
                    return serde_json::from_str(&value_str).ok();
                }
            }
        }
        None
    }

    /// Make an HTTP request using WASI HTTP
    pub fn http_request(url: &str, method: &str) -> Option<Vec<u8>> {
        #[cfg(target_arch = "wasm32")]
        {
            // For now, return empty until WASI HTTP is properly configured
            // In a real implementation, you'd use fetch API or WASI HTTP
            let _ = (url, method); // Suppress unused warnings
            Some(Vec::new())
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = (url, method); // Suppress unused warnings
            None
        }
    }

    /// Get current timestamp in milliseconds using WASI clocks
    pub fn get_timestamp() -> i64 {
        #[cfg(target_arch = "wasm32")]
        {
            // Use JavaScript Date.now() for now
            js_sys::Date::now() as i64
        }
        #[cfg(not(target_arch = "wasm32"))]
        0
    }
}

// Extension traits for modifying HTTP requests and responses
pub trait HttpRequestExt {
    /// Modify a header in the HTTP request
    fn modify_header(&mut self, key: &str, value: &str);

    /// Remove a header from the HTTP request
    fn remove_header(&mut self, key: &str);
}

pub trait HttpResponseExt {
    /// Modify a header in the HTTP response
    fn modify_header(&mut self, key: &str, value: &str);

    /// Remove a header from the HTTP response
    fn remove_header(&mut self, key: &str);
}

impl HttpRequestExt for HttpRequest {
    fn modify_header(&mut self, key: &str, value: &str) {
        self.headers.insert(key.to_string(), value.to_string());
    }

    fn remove_header(&mut self, key: &str) {
        self.headers.remove(key);
    }
}

impl HttpResponseExt for HttpResponse {
    fn modify_header(&mut self, key: &str, value: &str) {
        self.headers.insert(key.to_string(), value.to_string());
    }

    fn remove_header(&mut self, key: &str) {
        self.headers.remove(key);
    }
}

// WASI-based plugin macros
#[macro_export]
macro_rules! plugin_metadata {
    ($name:expr, $version:expr, $description:expr, $author:expr, $events:expr) => {
        #[cfg(target_arch = "wasm32")]
        struct Component;

        #[cfg(target_arch = "wasm32")]
        impl exports::component::mitm_plugin::Guest for Component {
            fn get_metadata() -> String {
                let metadata = $crate::PluginMetadata {
                    name: $name.to_string(),
                    version: $version.to_string(),
                    description: $description.to_string(),
                    author: $author.to_string(),
                    events: $events.iter().map(|s| s.to_string()).collect(),
                    config_schema: None,
                };
                $crate::serde_json::to_string(&metadata).unwrap_or_default()
            }
        }

        #[cfg(target_arch = "wasm32")]
        wit_bindgen::rt::export!(Component with_types_in wit_bindgen::rt);
    };
}

#[macro_export]
macro_rules! plugin_event_handler {
    ($event:expr, $handler:expr) => {
        $crate::paste::paste! {
            #[cfg(target_arch = "wasm32")]
            impl exports::component::mitm_plugin::Guest for Component {
                fn [<on_ $event>](context: String) -> String {
                    let ctx: $crate::RequestContext = match $crate::serde_json::from_str(&context) {
                        Ok(ctx) => ctx,
                        Err(_) => return $crate::serde_json::to_string(&$crate::PluginResult::Continue).unwrap_or_default(),
                    };

                    let result = $handler(ctx);
                    $crate::serde_json::to_string(&result).unwrap_or_default()
                }
            }
        }
    };
}

// Convenience logging macros
#[macro_export]
macro_rules! log_error {
    ($($arg:tt)*) => {
        $crate::PluginApi::log($crate::LogLevel::Error, &format!($($arg)*));
    };
}

#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)*) => {
        $crate::PluginApi::log($crate::LogLevel::Warn, &format!($($arg)*));
    };
}

#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => {
        $crate::PluginApi::log($crate::LogLevel::Info, &format!($($arg)*));
    };
}

#[macro_export]
macro_rules! log_debug {
    ($($arg:tt)*) => {
        $crate::PluginApi::log($crate::LogLevel::Debug, &format!($($arg)*));
    };
}

// WASI-based content handler macros
#[macro_export]
macro_rules! json_handler {
    ($handler_fn:ident) => {
        #[cfg(target_arch = "wasm32")]
        impl exports::component::mitm_plugin::Guest for Component {
            fn on_request_body(context: String, body: Vec<u8>) -> String {
                let ctx: $crate::RequestContext = match $crate::serde_json::from_str(&context) {
                    Ok(ctx) => ctx,
                    Err(_) => {
                        return $crate::serde_json::to_string(&$crate::PluginResult::Continue)
                            .unwrap_or_default()
                    }
                };

                let json_value: $crate::serde_json::Value =
                    match $crate::serde_json::from_slice(&body) {
                        Ok(val) => val,
                        Err(_) => {
                            return $crate::serde_json::to_string(&$crate::PluginResult::Continue)
                                .unwrap_or_default()
                        }
                    };

                let result = $handler_fn(ctx, json_value);
                $crate::serde_json::to_string(&result).unwrap_or_default()
            }
        }
    };
}

#[macro_export]
macro_rules! html_handler {
    ($handler_fn:ident) => {
        #[cfg(target_arch = "wasm32")]
        impl exports::component::mitm_plugin::Guest for Component {
            fn on_response_body(context: String, body: Vec<u8>) -> String {
                let ctx: $crate::RequestContext = match $crate::serde_json::from_str(&context) {
                    Ok(ctx) => ctx,
                    Err(_) => {
                        return $crate::serde_json::to_string(&$crate::PluginResult::Continue)
                            .unwrap_or_default()
                    }
                };

                // Parse HTML from body (simplified - you'd use a proper HTML parser)
                let html_content = String::from_utf8_lossy(&body);
                let html_doc = $crate::HtmlDocument {
                    title: None,
                    meta: std::collections::HashMap::new(),
                    links: Vec::new(),
                    forms: Vec::new(),
                    scripts: Vec::new(),
                    text_content: html_content.to_string(),
                    raw_html: html_content.to_string(),
                };

                let result = $handler_fn(ctx, html_doc);
                $crate::serde_json::to_string(&result).unwrap_or_default()
            }
        }
    };
}
