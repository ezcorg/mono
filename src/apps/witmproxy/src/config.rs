use anyhow::Result;
use clap::Args;
use confique::Config;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Utility function to expand $HOME in a PathBuf
pub fn expand_home_in_path(path: &PathBuf) -> Result<PathBuf> {
    let home_dir = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let path_str = path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("Invalid UTF-8 in path"))?;

    if path_str.contains("$HOME") {
        let expanded = path_str.replace("$HOME", home_dir.to_str().unwrap_or("."));
        Ok(PathBuf::from(expanded))
    } else {
        Ok(path.clone())
    }
}

#[derive(Config, Clone, Default, Serialize, Deserialize)]
#[config(partial_attr(derive(Args, Serialize, Clone)))]
pub struct AppConfig {
    #[config(nested, partial_attr(command(flatten)))]
    pub proxy: ProxyConfig,

    #[config(nested, partial_attr(command(flatten)))]
    pub db: DbConfig,

    #[config(nested, partial_attr(command(flatten)))]
    pub tls: TlsConfig,

    #[config(nested, partial_attr(command(flatten)))]
    pub plugins: PluginConfig,

    #[config(nested, partial_attr(command(flatten)))]
    pub web: WebConfig,
}

#[derive(Clone, Config, Deserialize, Serialize, Default)]
#[config(partial_attr(derive(Args, Clone, Serialize,)))]
pub struct ProxyConfig {
    /// The address the proxy server will bind to (optional, defaults to 127.0.0.1:0)
    #[config(env = "PROXY_BIND_ADDR", partial_attr(arg(long)))]
    pub proxy_bind_addr: Option<String>,
}

#[derive(Clone, Config, Deserialize, Serialize, Default)]
#[config(partial_attr(derive(Args, Clone, Serialize,)))]
pub struct DbConfig {
    /// The database connection URL
    #[config(
        default = "$HOME/.witmproxy/db.sqlite",
        partial_attr(arg(long, default_value = "$HOME/.witmproxy/db.sqlite"))
    )]
    pub db_path: PathBuf,

    /// The database password
    #[config(env = "DB_PASSWORD", partial_attr(arg(long)))]
    pub db_password: String,
}

#[derive(Clone, Config, Deserialize, Serialize, Default)]
#[config(partial_attr(derive(Args, Clone, Serialize,)))]
pub struct TlsConfig {
    /// The size of the generated key
    #[config(default = 2048, partial_attr(arg(long, default_value = "2048")))]
    pub key_size: u32,

    /// The size of the cache for minted certificates
    #[config(default = 1024, partial_attr(arg(long, default_value = "1024")))]
    pub cache_size: usize,

    /// The directory where root certificates are stored
    #[config(
        default = "$HOME/.witmproxy/certs",
        partial_attr(arg(long, default_value = "$HOME/.witmproxy/certs"))
    )]
    pub cert_dir: PathBuf,
}

#[derive(Clone, Config, Deserialize, Serialize, Default)]
#[config(partial_attr(derive(Args, Clone, Serialize,)))]
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

    /// The maximum amount of fuel a plugin can use
    #[config(
        default = 1_000_000,
        partial_attr(arg(long, default_value = "1000000"))
    )]
    pub max_fuel: u64,
}

#[derive(Clone, Config, Deserialize, Serialize, Default)]
#[config(partial_attr(derive(Args, Clone, Serialize,)))]
pub struct WebConfig {
    /// The address the web frontend will bind to (optional, defaults to 127.0.0.1:0)
    #[config(partial_attr(arg(long)))]
    pub web_bind_addr: Option<String>,
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

    /// Resolve all potential $HOME placeholders in configuration paths
    /// This should be called once during initialization to avoid repeated path resolution
    pub fn with_resolved_paths(mut self) -> Result<Self> {
        // Resolve database path
        self.db.db_path = expand_home_in_path(&self.db.db_path)?;

        // Resolve TLS certificate directory
        self.tls.cert_dir = expand_home_in_path(&self.tls.cert_dir)?;

        Ok(self)
    }
}
