// Library interface for witmproxy
// This exposes the internal modules for testing and external use

pub mod cert;
pub mod config;
pub mod content;
pub mod db;
pub mod plugins;
pub mod proxy;
pub mod web;
pub mod wasm;

#[cfg(test)]
pub mod test_utils;

// Re-export commonly used types for convenience
pub use cert::CertificateAuthority;
pub use config::AppConfig;
pub use proxy::ProxyServer;
pub use web::WebServer;