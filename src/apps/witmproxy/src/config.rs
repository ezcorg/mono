use anyhow::Result;
use clap::Args;
use confique::Config;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Returns the system-level app directory on Linux (`/var/lib/witmproxy`).
/// On other platforms, returns `~/.witmproxy`.
pub fn system_app_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        PathBuf::from("/var/lib/witmproxy")
    }
    #[cfg(not(target_os = "linux"))]
    {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".witmproxy")
    }
}

/// Utility function to expand $HOME in a PathBuf
pub fn expand_home_in_path(path: &Path) -> Result<PathBuf> {
    let home_dir = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let path_str = path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("Invalid UTF-8 in path"))?;

    if path_str.contains("$HOME") {
        let expanded = path_str.replace("$HOME", home_dir.to_str().unwrap_or("."));
        Ok(PathBuf::from(expanded))
    } else {
        Ok(path.to_path_buf())
    }
}

#[derive(Config, Clone, Default, Serialize, Deserialize)]
#[config(layer_attr(derive(Args, Serialize, Clone)))]
pub struct AppConfig {
    #[config(nested, layer_attr(command(flatten)))]
    pub proxy: ProxyConfig,

    #[config(nested, layer_attr(command(flatten)))]
    pub db: DbConfig,

    #[config(nested, layer_attr(command(flatten)))]
    pub tls: TlsConfig,

    #[config(nested, layer_attr(command(flatten)))]
    pub plugins: PluginConfig,

    #[config(nested, layer_attr(command(flatten)))]
    pub web: WebConfig,

    #[config(nested, layer_attr(command(flatten)))]
    pub auth: AuthConfig,

    #[config(nested, layer_attr(command(flatten)))]
    pub transparent: TransparentProxyConfig,

    #[config(nested, layer_attr(command(flatten)))]
    pub update: UpdateConfig,
}

#[derive(Clone, Config, Deserialize, Serialize, Default)]
#[config(layer_attr(derive(Args, Clone, Serialize,)))]
pub struct ProxyConfig {
    /// The address the proxy server will bind to (optional, defaults to 127.0.0.1:0)
    #[config(env = "PROXY_BIND_ADDR", layer_attr(arg(long)))]
    pub proxy_bind_addr: Option<String>,

    /// Tenant resolver strategy: ip-mapping, tailscale, or header
    #[config(default = "ip-mapping", layer_attr(arg(skip)))]
    pub tenant_resolver: crate::proxy::tenant_resolver::TenantResolverKind,

    /// Header name for header-based tenant resolution
    #[config(layer_attr(arg(skip)))]
    pub tenant_header: Option<String>,
}

#[derive(Clone, Config, Deserialize, Serialize, Default)]
#[config(layer_attr(derive(Args, Clone, Serialize,)))]
pub struct AuthConfig {
    /// Enable authentication for management API
    #[config(default = false, layer_attr(arg(skip)))]
    pub enabled: bool,

    /// External JWKS URL for token verification
    #[config(layer_attr(arg(skip)))]
    pub jwks_url: Option<String>,

    /// JWT issuer
    #[config(layer_attr(arg(skip)))]
    pub jwt_issuer: Option<String>,

    /// JWT audience
    #[config(layer_attr(arg(skip)))]
    pub jwt_audience: Option<String>,

    /// JWT secret for local token signing (env: AUTH_JWT_SECRET)
    #[config(env = "AUTH_JWT_SECRET", layer_attr(arg(skip)))]
    pub jwt_secret: Option<String>,
}

#[derive(Clone, Config, Deserialize, Serialize, Default)]
#[config(layer_attr(derive(Args, Clone, Serialize,)))]
pub struct TransparentProxyConfig {
    /// Enable transparent proxy mode
    #[config(default = false, layer_attr(arg(skip)))]
    pub enabled: bool,

    /// Listen address for transparent proxy (default: 0.0.0.0:8080)
    #[config(layer_attr(arg(skip)))]
    pub listen_addr: Option<String>,

    /// Network interface for iptables rules (default: tailscale0)
    #[config(layer_attr(arg(skip)))]
    pub interface: Option<String>,

    /// Automatically configure iptables rules
    #[config(default = true, layer_attr(arg(skip)))]
    pub auto_iptables: bool,
}

#[derive(Clone, Config, Deserialize, Serialize, Default)]
#[config(layer_attr(derive(Args, Clone, Serialize,)))]
pub struct DbConfig {
    /// The database connection URL
    #[cfg_attr(
        target_os = "linux",
        config(
            default = "/var/lib/witmproxy/witmproxy.db",
            layer_attr(arg(long, default_value = "/var/lib/witmproxy/witmproxy.db"))
        )
    )]
    #[cfg_attr(
        not(target_os = "linux"),
        config(
            default = "$HOME/.witmproxy/db.sqlite",
            layer_attr(arg(long, default_value = "$HOME/.witmproxy/db.sqlite"))
        )
    )]
    pub db_path: PathBuf,

    /// The database password
    #[config(env = "DB_PASSWORD", layer_attr(arg(long)))]
    pub db_password: String,
}

#[derive(Clone, Config, Deserialize, Serialize, Default)]
#[config(layer_attr(derive(Args, Clone, Serialize,)))]
pub struct TlsConfig {
    /// The size of the generated key
    #[config(default = 2048, layer_attr(arg(long, default_value = "2048")))]
    pub key_size: u32,

    /// The size of the cache for minted certificates
    #[config(default = 1024, layer_attr(arg(long, default_value = "1024")))]
    pub cache_size: usize,

    /// The directory where root certificates are stored
    #[cfg_attr(
        target_os = "linux",
        config(
            default = "/var/lib/witmproxy/certs",
            layer_attr(arg(long, default_value = "/var/lib/witmproxy/certs"))
        )
    )]
    #[cfg_attr(
        not(target_os = "linux"),
        config(
            default = "$HOME/.witmproxy/certs",
            layer_attr(arg(long, default_value = "$HOME/.witmproxy/certs"))
        )
    )]
    pub cert_dir: PathBuf,
}

#[derive(Clone, Config, Deserialize, Serialize, Default)]
#[config(layer_attr(derive(Args, Clone, Serialize,)))]
pub struct PluginConfig {
    /// Whether or not plugins are enabled for the proxy
    #[config(default = true, layer_attr(arg(long, default_value = "true")))]
    pub enabled: bool,

    /// The timeout for plugin execution
    #[config(default = 1000, layer_attr(arg(long, default_value = "1000")))]
    pub timeout_ms: u64,

    /// The maximum amount of memory a plugin can use
    #[config(default = 1024, layer_attr(arg(long, default_value = "1024")))]
    pub max_memory_mb: u64,

    /// The maximum amount of fuel a plugin can use
    #[config(default = 1_000_000, layer_attr(arg(long, default_value = "1000000")))]
    pub max_fuel: u64,
}

#[derive(Clone, Config, Deserialize, Serialize, Default)]
#[config(layer_attr(derive(Args, Clone, Serialize,)))]
pub struct WebConfig {
    /// The address the web frontend will bind to (optional, defaults to 127.0.0.1:0)
    #[config(layer_attr(arg(long)))]
    pub web_bind_addr: Option<String>,
}

#[derive(Clone, Config, Deserialize, Serialize, Default)]
#[config(layer_attr(derive(Args, Clone, Serialize,)))]
pub struct UpdateConfig {
    /// Enable automatic updates in daemon mode (default: true)
    #[config(default = true, layer_attr(arg(skip)))]
    pub auto_update: bool,

    /// Seconds between auto-update checks in daemon mode (default: 21600 = 6 hours)
    #[config(default = 21600, layer_attr(arg(skip)))]
    pub check_interval_seconds: u64,

    /// Show update warnings in interactive CLI mode (default: true)
    #[config(default = true, layer_attr(arg(skip)))]
    pub cli_update_warning: bool,

    /// Prefer prebuilt GitHub release binaries over cargo install (default: true)
    #[config(default = true, layer_attr(arg(skip)))]
    pub prefer_prebuilt: bool,
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
