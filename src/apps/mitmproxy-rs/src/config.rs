use anyhow::Result;
use clap::Args;
use confique::Config;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Config, Clone, Default, Debug, Serialize, Deserialize)]
#[config(partial_attr(derive(Args, Serialize, Clone, Debug)))]
pub struct AppConfig {
    #[config(nested, partial_attr(command(flatten)))]
    pub proxy: ProxyConfig,

    #[config(nested, partial_attr(command(flatten)))]
    pub tls: TlsConfig,

    #[config(nested, partial_attr(command(flatten)))]
    pub plugins: PluginConfig,

    #[config(nested, partial_attr(command(flatten)))]
    pub web: WebConfig,
}

#[derive(Clone, Debug, Config, Deserialize, Serialize, Default)]
#[config(partial_attr(derive(Args, Clone, Debug, Serialize,)))]
pub struct ProxyConfig {
    /// The address the proxy server will bind to
    #[config(
        default = "127.0.0.1:8082",
        partial_attr(arg(long, default_value = "127.0.0.1:8082"))
    )]
    pub proxy_bind_addr: String,
}

#[derive(Clone, Debug, Config, Deserialize, Serialize, Default)]
#[config(partial_attr(derive(Args, Clone, Debug, Serialize,)))]
pub struct TlsConfig {
    /// The size of the generated key
    #[config(default = 2048, partial_attr(arg(long, default_value = "2048")))]
    pub key_size: u32,

    /// The size of the cache for minted certificates
    #[config(default = 1024, partial_attr(arg(long, default_value = "1024")))]
    pub cache_size: usize,

    /// The directory where root certificates are stored
    #[config(
        default = "./certs",
        partial_attr(arg(long, default_value = "./certs"))
    )]
    pub cert_dir: PathBuf,
}

#[derive(Clone, Debug, Config, Deserialize, Serialize, Default)]
#[config(partial_attr(derive(Args, Clone, Debug, Serialize,)))]
pub struct PluginConfig {
    /// Whether or not plugins are enabled for the proxy
    #[config(default = true, partial_attr(arg(long, default_value = "true")))]
    pub enabled: bool,

    /// The timeout for plugin execution
    #[config(default = 1000, partial_attr(arg(long, default_value = "1000")))]
    pub timeout_ms: u64,

    /// The maximum amount of memory a plugin can use
    #[config(default = 1024, partial_attr(arg(long, default_value = "1024")))]
    pub max_memory_mb: u64,

    /// Where to load plugins from
    #[config(
        default = "./plugins",
        partial_attr(arg(short, long, default_value = "./plugins"))
    )]
    pub plugin_dir: PathBuf,
}

#[derive(Clone, Debug, Config, Deserialize, Serialize, Default)]
#[config(partial_attr(derive(Args, Clone, Debug, Serialize,)))]
pub struct WebConfig {
    #[config(default = true, partial_attr(arg(long, default_value = "true")))]
    pub enable_dashboard: bool,

    #[config(
        default = "static/",
        partial_attr(arg(long, default_value = "static/"))
    )]
    pub static_dir: String,

    #[config(
        default = "templates/",
        partial_attr(arg(long, default_value = "templates/"))
    )]
    pub template_dir: String,

    /// The address the web frontend will bind to
    #[config(
        default = "127.0.0.1:8083",
        partial_attr(arg(long, default_value = "127.0.0.1:8083"))
    )]
    pub web_bind_addr: String,
}

impl AppConfig {
    pub fn load<P: AsRef<Path>>(path: P) -> Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let config: AppConfig = toml::from_str(&content)?;
        Ok(config)
    }

    pub fn save<P: AsRef<Path>>(&self, path: P) -> Result<()> {
        let content = toml::to_string_pretty(self)?;
        std::fs::write(path, content)?;
        Ok(())
    }
}
