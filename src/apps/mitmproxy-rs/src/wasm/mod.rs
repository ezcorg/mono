pub mod bindings;
pub mod host_functions;
pub mod plugin_manager;
pub mod runtime;

pub use plugin_manager::PluginManager;
pub use runtime::WasmPlugin;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use tokio::sync::RwLock;

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

#[derive(Debug, Clone, Serialize)]
pub struct RequestContext {
    pub request_id: String,
    pub client_ip: IpAddr,
    pub target_host: String,
    pub request: HttpRequest,
    pub response: Option<HttpResponse>,
}

#[derive(Debug, Clone)]
pub enum PluginAction {
    Continue,
    Block(String),
    Redirect(String),
    ModifyRequest(HttpRequest),
    ModifyResponse(HttpResponse),
}

#[derive(Debug, thiserror::Error)]
pub enum WasmError {
    #[error("Plugin execution failed: {0}")]
    Execution(#[from] wasmtime::Error),

    #[error("Plugin timeout")]
    Timeout,

    #[error("Plugin not found: {0}")]
    NotFound(String),

    #[error("Invalid plugin format: {0}")]
    InvalidFormat(String),

    #[error("Memory limit exceeded")]
    MemoryLimit,

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Memory access error: {0}")]
    MemoryAccess(String),
}

impl From<wasmtime::MemoryAccessError> for WasmError {
    fn from(err: wasmtime::MemoryAccessError) -> Self {
        WasmError::MemoryAccess(err.to_string())
    }
}

pub type WasmResult<T> = Result<T, WasmError>;

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

// Plugin configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginConfig {
    pub enabled: bool,
    pub priority: i32,
    pub settings: HashMap<String, serde_json::Value>,
}

impl Default for PluginConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            priority: 0,
            settings: HashMap::new(),
        }
    }
}

// Event types that plugins can handle
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum EventType {
    RequestStart,
    RequestHeaders,
    RequestBody,
    ResponseStart,
    ResponseHeaders,
    ResponseBody,
    ConnectionOpen,
    ConnectionClose,
}

impl EventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            EventType::RequestStart => "request_start",
            EventType::RequestHeaders => "request_headers",
            EventType::RequestBody => "request_body",
            EventType::ResponseStart => "response_start",
            EventType::ResponseHeaders => "response_headers",
            EventType::ResponseBody => "response_body",
            EventType::ConnectionOpen => "connection_open",
            EventType::ConnectionClose => "connection_close",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "request_start" => Some(EventType::RequestStart),
            "request_headers" => Some(EventType::RequestHeaders),
            "request_body" => Some(EventType::RequestBody),
            "response_start" => Some(EventType::ResponseStart),
            "response_headers" => Some(EventType::ResponseHeaders),
            "response_body" => Some(EventType::ResponseBody),
            "connection_open" => Some(EventType::ConnectionOpen),
            "connection_close" => Some(EventType::ConnectionClose),
            _ => None,
        }
    }
}

// Shared state between host and plugins
#[derive(Debug)]
pub struct PluginState {
    pub storage: Arc<RwLock<HashMap<String, serde_json::Value>>>,
    pub logs: Arc<RwLock<Vec<LogEntry>>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub level: LogLevel,
    pub plugin: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl PluginState {
    pub fn new() -> Self {
        Self {
            storage: Arc::new(RwLock::new(HashMap::new())),
            logs: Arc::new(RwLock::new(Vec::new())),
        }
    }

    pub async fn log(&self, level: LogLevel, plugin: &str, message: &str) {
        let entry = LogEntry {
            timestamp: chrono::Utc::now(),
            level,
            plugin: plugin.to_string(),
            message: message.to_string(),
        };

        let mut logs = self.logs.write().await;
        logs.push(entry);

        // Keep only last 1000 log entries
        if logs.len() > 1000 {
            let excess = logs.len() - 1000;
            logs.drain(0..excess);
        }
    }

    pub async fn get_logs(&self) -> Vec<LogEntry> {
        let logs = self.logs.read().await;
        logs.clone()
    }

    pub async fn set_storage(&self, key: &str, value: serde_json::Value) {
        let mut storage = self.storage.write().await;
        storage.insert(key.to_string(), value);
    }

    pub async fn get_storage(&self, key: &str) -> Option<serde_json::Value> {
        let storage = self.storage.read().await;
        storage.get(key).cloned()
    }
}

impl Default for PluginState {
    fn default() -> Self {
        Self::new()
    }
}
