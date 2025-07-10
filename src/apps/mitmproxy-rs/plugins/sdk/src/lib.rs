use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// Re-export for convenience
pub use paste;
pub use serde_json;

// Memory allocator for WASM
#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

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

// Host function declarations
extern "C" {
    fn host_log(level: i32, ptr: *const u8, len: i32);
    fn host_storage_set(key_ptr: *const u8, key_len: i32, value_ptr: *const u8, value_len: i32);
    fn host_storage_get(key_ptr: *const u8, key_len: i32) -> i32;
    fn host_modify_request_header(
        key_ptr: *const u8,
        key_len: i32,
        value_ptr: *const u8,
        value_len: i32,
    );
    fn host_modify_response_header(
        key_ptr: *const u8,
        key_len: i32,
        value_ptr: *const u8,
        value_len: i32,
    );
    fn host_http_request(
        url_ptr: *const u8,
        url_len: i32,
        method_ptr: *const u8,
        method_len: i32,
    ) -> i32;
    fn host_get_timestamp() -> i64;
    fn host_get_context() -> i32;
}

// Memory management functions that plugins must implement
#[no_mangle]
pub extern "C" fn alloc(size: i32) -> *mut u8 {
    let mut buf = Vec::with_capacity(size as usize);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[no_mangle]
pub extern "C" fn free(ptr: *mut u8, size: i32) {
    unsafe {
        let _ = Vec::from_raw_parts(ptr, 0, size as usize);
    }
}

// Helper functions for plugins
pub struct PluginApi;

impl PluginApi {
    /// Log a message to the host
    pub fn log(level: LogLevel, message: &str) {
        unsafe {
            host_log(level as i32, message.as_ptr(), message.len() as i32);
        }
    }

    /// Store a value in the plugin storage
    pub fn storage_set(key: &str, value: &serde_json::Value) {
        let value_bytes = serde_json::to_vec(value).unwrap_or_default();
        unsafe {
            host_storage_set(
                key.as_ptr(),
                key.len() as i32,
                value_bytes.as_ptr(),
                value_bytes.len() as i32,
            );
        }
    }

    /// Get a value from the plugin storage
    pub fn storage_get(key: &str) -> Option<serde_json::Value> {
        unsafe {
            let result_ptr = host_storage_get(key.as_ptr(), key.len() as i32);
            if result_ptr == 0 {
                return None;
            }

            // Read length
            let len_bytes = std::slice::from_raw_parts(result_ptr as *const u8, 4);
            let len = u32::from_le_bytes([len_bytes[0], len_bytes[1], len_bytes[2], len_bytes[3]])
                as usize;

            // Read data
            let data_bytes = std::slice::from_raw_parts((result_ptr + 4) as *const u8, len);
            let value: serde_json::Value = serde_json::from_slice(data_bytes).ok()?;

            // Free the memory (host should provide this)
            // free(result_ptr as *mut u8, (len + 4) as i32);

            Some(value)
        }
    }

    /// Modify a request header
    pub fn modify_request_header(key: &str, value: &str) {
        unsafe {
            host_modify_request_header(
                key.as_ptr(),
                key.len() as i32,
                value.as_ptr(),
                value.len() as i32,
            );
        }
    }

    /// Modify a response header
    pub fn modify_response_header(key: &str, value: &str) {
        unsafe {
            host_modify_response_header(
                key.as_ptr(),
                key.len() as i32,
                value.as_ptr(),
                value.len() as i32,
            );
        }
    }

    /// Make an HTTP request
    pub fn http_request(url: &str, method: &str) -> Option<Vec<u8>> {
        unsafe {
            let result_ptr = host_http_request(
                url.as_ptr(),
                url.len() as i32,
                method.as_ptr(),
                method.len() as i32,
            );

            if result_ptr == 0 {
                return None;
            }

            // Read length
            let len_bytes = std::slice::from_raw_parts(result_ptr as *const u8, 4);
            let len = u32::from_le_bytes([len_bytes[0], len_bytes[1], len_bytes[2], len_bytes[3]])
                as usize;

            // Read data
            let data_bytes = std::slice::from_raw_parts((result_ptr + 4) as *const u8, len);
            let data = data_bytes.to_vec();

            Some(data)
        }
    }

    /// Get current timestamp in milliseconds
    pub fn get_timestamp() -> i64 {
        unsafe { host_get_timestamp() }
    }

    /// Get the current request context
    pub fn get_context() -> Option<RequestContext> {
        unsafe {
            let result_ptr = host_get_context();
            if result_ptr == 0 {
                return None;
            }

            // Read length
            let len_bytes = std::slice::from_raw_parts(result_ptr as *const u8, 4);
            let len = u32::from_le_bytes([len_bytes[0], len_bytes[1], len_bytes[2], len_bytes[3]])
                as usize;

            // Read data
            let data_bytes = std::slice::from_raw_parts((result_ptr + 4) as *const u8, len);
            let context: RequestContext = serde_json::from_slice(data_bytes).ok()?;

            Some(context)
        }
    }
}

// Convenience macros for plugin development
#[macro_export]
macro_rules! plugin_metadata {
    ($name:expr, $version:expr, $description:expr, $author:expr, $events:expr) => {
        #[no_mangle]
        pub extern "C" fn get_metadata() -> i32 {
            let metadata = $crate::PluginMetadata {
                name: $name.to_string(),
                version: $version.to_string(),
                description: $description.to_string(),
                author: $author.to_string(),
                events: $events.iter().map(|s| s.to_string()).collect(),
                config_schema: None,
            };

            let json = $crate::serde_json::to_vec(&metadata).unwrap_or_default();
            let total_len = json.len() + 4;
            let ptr = $crate::alloc(total_len as i32);

            unsafe {
                // Write length first
                let len_bytes = (json.len() as u32).to_le_bytes();
                std::ptr::copy_nonoverlapping(len_bytes.as_ptr(), ptr, 4);

                // Write data
                std::ptr::copy_nonoverlapping(json.as_ptr(), ptr.add(4), json.len());
            }

            ptr as i32
        }
    };
}

#[macro_export]
macro_rules! plugin_event_handler {
    ($event:expr, $handler:expr) => {
        $crate::paste::paste! {
            #[no_mangle]
            pub extern "C" fn [<on_ $event>](context_ptr: i32, context_len: i32) -> i32 {
                let context_bytes = unsafe {
                    std::slice::from_raw_parts(context_ptr as *const u8, context_len as usize)
                };

                let context: $crate::RequestContext = match $crate::serde_json::from_slice(context_bytes) {
                    Ok(ctx) => ctx,
                    Err(_) => return 0, // Return null pointer on error
                };

                let result = $handler(context);
                let json = $crate::serde_json::to_vec(&result).unwrap_or_default();
                let total_len = json.len() + 4;
                let ptr = $crate::alloc(total_len as i32);

                unsafe {
                    // Write length first
                    let len_bytes = (json.len() as u32).to_le_bytes();
                    std::ptr::copy_nonoverlapping(len_bytes.as_ptr(), ptr, 4);

                    // Write data
                    std::ptr::copy_nonoverlapping(json.as_ptr(), ptr.add(4), json.len());
                }

                ptr as i32
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

// Convenience macros for JSON and HTML content handlers
#[macro_export]
macro_rules! json_handler {
    ($export_name:expr, $handler_fn:ident) => {
        $crate::paste::paste! {
            #[no_mangle]
            pub extern "C" fn [<$export_name>](context_ptr: i32, context_len: i32, json_ptr: i32, json_len: i32) -> i32 {
                let context_bytes = unsafe {
                    std::slice::from_raw_parts(context_ptr as *const u8, context_len as usize)
                };

                let json_bytes = unsafe {
                    std::slice::from_raw_parts(json_ptr as *const u8, json_len as usize)
                };

                let context: $crate::RequestContext = match $crate::serde_json::from_slice(context_bytes) {
                    Ok(ctx) => ctx,
                    Err(_) => return 0,
                };

                let json_value: $crate::serde_json::Value = match $crate::serde_json::from_slice(json_bytes) {
                    Ok(val) => val,
                    Err(_) => return 0,
                };

                let result = $handler_fn(context, json_value);
                let json = $crate::serde_json::to_vec(&result).unwrap_or_default();
                let total_len = json.len() + 4;
                let ptr = $crate::alloc(total_len as i32);

                unsafe {
                    let len_bytes = (json.len() as u32).to_le_bytes();
                    std::ptr::copy_nonoverlapping(len_bytes.as_ptr(), ptr, 4);
                    std::ptr::copy_nonoverlapping(json.as_ptr(), ptr.add(4), json.len());
                }

                ptr as i32
            }
        }
    };
}

#[macro_export]
macro_rules! html_handler {
    ($export_name:expr, $handler_fn:ident) => {
        $crate::paste::paste! {
            #[no_mangle]
            pub extern "C" fn [<$export_name>](context_ptr: i32, context_len: i32, html_ptr: i32, html_len: i32) -> i32 {
                let context_bytes = unsafe {
                    std::slice::from_raw_parts(context_ptr as *const u8, context_len as usize)
                };

                let html_bytes = unsafe {
                    std::slice::from_raw_parts(html_ptr as *const u8, html_len as usize)
                };

                let context: $crate::RequestContext = match $crate::serde_json::from_slice(context_bytes) {
                    Ok(ctx) => ctx,
                    Err(_) => return 0,
                };

                let html_doc: $crate::HtmlDocument = match $crate::serde_json::from_slice(html_bytes) {
                    Ok(doc) => doc,
                    Err(_) => return 0,
                };

                let result = $handler_fn(context, html_doc);
                let json = $crate::serde_json::to_vec(&result).unwrap_or_default();
                let total_len = json.len() + 4;
                let ptr = $crate::alloc(total_len as i32);

                unsafe {
                    let len_bytes = (json.len() as u32).to_le_bytes();
                    std::ptr::copy_nonoverlapping(len_bytes.as_ptr(), ptr, 4);
                    std::ptr::copy_nonoverlapping(json.as_ptr(), ptr.add(4), json.len());
                }

                ptr as i32
            }
        }
    };
}
