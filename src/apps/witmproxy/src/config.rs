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
    /// The address the proxy server will bind to (default: 127.0.0.1:0)
    #[config(env = "PROXY_BIND_ADDR", layer_attr(arg(long)))]
    pub proxy_bind_addr: Option<String>,

    /// Tenant resolver strategy: ip-mapping, tailscale, or header (default: ip-mapping)
    #[config(default = "ip-mapping", env = "PROXY_TENANT_RESOLVER", layer_attr(arg(long)))]
    pub tenant_resolver: crate::proxy::tenant_resolver::TenantResolverKind,

    /// Header name for header-based tenant resolution
    #[config(env = "PROXY_TENANT_HEADER", layer_attr(arg(long)))]
    pub tenant_header: Option<String>,
}

#[derive(Clone, Config, Deserialize, Serialize, Default)]
#[config(layer_attr(derive(Args, Clone, Serialize,)))]
pub struct AuthConfig {
    /// Enable authentication for management API (default: false)
    #[config(default = false, env = "AUTH_ENABLED", layer_attr(arg(long = "auth-enabled", id = "auth-enabled")))]
    pub enabled: bool,

    /// External JWKS URL for token verification
    #[config(env = "AUTH_JWKS_URL", layer_attr(arg(long = "auth-jwks-url")))]
    pub jwks_url: Option<String>,

    /// JWT issuer claim
    #[config(env = "AUTH_JWT_ISSUER", layer_attr(arg(long = "auth-jwt-issuer")))]
    pub jwt_issuer: Option<String>,

    /// JWT audience claim
    #[config(env = "AUTH_JWT_AUDIENCE", layer_attr(arg(long = "auth-jwt-audience")))]
    pub jwt_audience: Option<String>,

    /// JWT secret for local token signing
    #[config(env = "AUTH_JWT_SECRET", layer_attr(arg(long = "auth-jwt-secret")))]
    pub jwt_secret: Option<String>,
}

#[derive(Clone, Config, Deserialize, Serialize, Default)]
#[config(layer_attr(derive(Args, Clone, Serialize,)))]
pub struct TransparentProxyConfig {
    /// Enable transparent proxy mode (default: false)
    #[config(default = false, env = "TRANSPARENT_ENABLED", layer_attr(arg(long = "transparent-enabled", id = "transparent-enabled")))]
    pub enabled: bool,

    /// Listen address for transparent proxy (default: 0.0.0.0:8080)
    #[config(env = "TRANSPARENT_LISTEN_ADDR", layer_attr(arg(long = "transparent-listen-addr")))]
    pub listen_addr: Option<String>,

    /// Network interface for iptables rules (default: tailscale0)
    #[config(env = "TRANSPARENT_INTERFACE", layer_attr(arg(long = "transparent-interface")))]
    pub interface: Option<String>,

    /// Automatically configure iptables rules (default: true)
    #[config(default = true, env = "TRANSPARENT_AUTO_IPTABLES", layer_attr(arg(long = "transparent-auto-iptables")))]
    pub auto_iptables: bool,
}

#[derive(Clone, Config, Deserialize, Serialize, Default)]
#[config(layer_attr(derive(Args, Clone, Serialize,)))]
pub struct DbConfig {
    /// Path to the SQLite database file (default: /var/lib/witmproxy/witmproxy.db on Linux, $HOME/.witmproxy/db.sqlite otherwise)
    #[cfg_attr(
        target_os = "linux",
        config(
            default = "/var/lib/witmproxy/witmproxy.db",
            env = "DB_PATH",
            layer_attr(arg(long))
        )
    )]
    #[cfg_attr(
        not(target_os = "linux"),
        config(
            default = "$HOME/.witmproxy/db.sqlite",
            env = "DB_PATH",
            layer_attr(arg(long))
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
    /// Size of generated TLS keys in bits (default: 2048)
    #[config(default = 2048, env = "TLS_KEY_SIZE", layer_attr(arg(long)))]
    pub key_size: u32,

    /// Size of the minted certificate cache (default: 1024)
    #[config(default = 1024, env = "TLS_CACHE_SIZE", layer_attr(arg(long)))]
    pub cache_size: usize,

    /// Directory where root certificates are stored (default: /var/lib/witmproxy/certs on Linux, $HOME/.witmproxy/certs otherwise)
    #[cfg_attr(
        target_os = "linux",
        config(
            default = "/var/lib/witmproxy/certs",
            env = "TLS_CERT_DIR",
            layer_attr(arg(long))
        )
    )]
    #[cfg_attr(
        not(target_os = "linux"),
        config(
            default = "$HOME/.witmproxy/certs",
            env = "TLS_CERT_DIR",
            layer_attr(arg(long))
        )
    )]
    pub cert_dir: PathBuf,
}

#[derive(Clone, Config, Deserialize, Serialize, Default)]
#[config(layer_attr(derive(Args, Clone, Serialize,)))]
pub struct PluginConfig {
    /// Enable or disable the plugin system (default: true)
    #[config(default = true, env = "PLUGINS_ENABLED", layer_attr(arg(long = "plugins-enabled", id = "plugins-enabled")))]
    pub enabled: bool,

    /// Plugin execution timeout in milliseconds (default: 1000)
    #[config(default = 1000, env = "PLUGINS_TIMEOUT_MS", layer_attr(arg(long)))]
    pub timeout_ms: u64,

    /// Maximum memory per plugin in MB (default: 1024)
    #[config(default = 1024, env = "PLUGINS_MAX_MEMORY_MB", layer_attr(arg(long)))]
    pub max_memory_mb: u64,

    /// WASM fuel limit per plugin execution (default: 1000000)
    #[config(default = 1_000_000, env = "PLUGINS_MAX_FUEL", layer_attr(arg(long)))]
    pub max_fuel: u64,
}

#[derive(Clone, Config, Deserialize, Serialize, Default)]
#[config(layer_attr(derive(Args, Clone, Serialize,)))]
pub struct WebConfig {
    /// The address the web frontend will bind to (default: 127.0.0.1:0)
    #[config(env = "WEB_BIND_ADDR", layer_attr(arg(long)))]
    pub web_bind_addr: Option<String>,
}

#[derive(Clone, Config, Deserialize, Serialize, Default)]
#[config(layer_attr(derive(Args, Clone, Serialize,)))]
pub struct UpdateConfig {
    /// Enable automatic updates in daemon mode (default: true)
    #[config(default = true, env = "UPDATE_AUTO_UPDATE", layer_attr(arg(long)))]
    pub auto_update: bool,

    /// Seconds between auto-update checks in daemon mode (default: 21600 = 6 hours)
    #[config(default = 21600, env = "UPDATE_CHECK_INTERVAL_SECONDS", layer_attr(arg(long)))]
    pub check_interval_seconds: u64,

    /// Show update warnings in interactive CLI mode (default: true)
    #[config(default = true, env = "UPDATE_CLI_UPDATE_WARNING", layer_attr(arg(long)))]
    pub cli_update_warning: bool,

    /// Prefer prebuilt GitHub release binaries over cargo install (default: true)
    #[config(default = true, env = "UPDATE_PREFER_PREBUILT", layer_attr(arg(long)))]
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
