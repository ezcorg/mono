// Library interface for mitmproxy-rs
// This exposes the internal modules for testing and external use

pub mod cert;
pub mod config;
pub mod content;
pub mod proxy;
pub mod wasm;
pub mod web;

// Re-export commonly used types for convenience
pub use cert::CertificateAuthority;
pub use config::Config;
pub use proxy::ProxyServer;
pub use wasm::PluginManager;
pub use web::WebServer;
