use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub proxy: ProxyConfig,
    pub tls: TlsConfig,
    pub plugins: PluginConfig,
    pub web: WebConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyConfig {
    pub max_connections: usize,
    pub connection_timeout_secs: u64,
    pub buffer_size: usize,
    pub upstream_timeout_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlsConfig {
    pub cert_validity_days: u32,
    pub key_size: u32,
    pub cache_size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginConfig {
    pub enabled: bool,
    pub timeout_ms: u64,
    pub max_memory_mb: u64,
    pub plugin_settings: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebConfig {
    pub enable_dashboard: bool,
    pub static_dir: String,
    pub template_dir: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            proxy: ProxyConfig {
                max_connections: 1000,
                connection_timeout_secs: 30,
                buffer_size: 8192,
                upstream_timeout_secs: 30,
            },
            tls: TlsConfig {
                cert_validity_days: 365,
                key_size: 2048,
                cache_size: 1000,
            },
            plugins: PluginConfig {
                enabled: true,
                timeout_ms: 5000,
                max_memory_mb: 64,
                plugin_settings: HashMap::new(),
            },
            web: WebConfig {
                enable_dashboard: true,
                static_dir: "./web-ui/static".to_string(),
                template_dir: "./web-ui/templates".to_string(),
            },
        }
    }
}

impl Config {
    pub fn load<P: AsRef<Path>>(path: P) -> Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let config: Config = toml::from_str(&content)?;
        Ok(config)
    }

    pub fn save<P: AsRef<Path>>(&self, path: P) -> Result<()> {
        let content = toml::to_string_pretty(self)?;
        std::fs::write(path, content)?;
        Ok(())
    }
}
