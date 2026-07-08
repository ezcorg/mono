//! Application configuration.
//!
//! Config is defined once as a set of nested structs and layered from four
//! sources with 12-factor precedence (highest wins): **CLI args → environment
//! variables → config file (`config.toml`) → defaults**. The layering, CLI
//! generation, and `--help` output are all produced by the [`conf`] derive; the
//! TOML file is supplied as a value source via [`conf::Conf::conf_builder`] +
//! `.doc(...)` (see [`crate::cli`]).
//!
//! Fields are only *required* within the subcommand whose config struct they
//! belong to. In particular [`DbConfig`] is flattened only into the config
//! structs of commands that actually open the database, so a command like
//! `witm service uninstall` never demands `DB_PASSWORD`.

use anyhow::Result;
use conf::Conf;
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

/// Resolve the application data directory from a (resolved) certificate
/// directory. On Linux the system service always uses `/var/lib/witmproxy`;
/// elsewhere the app dir is the parent of the cert dir (`~/.witmproxy`).
pub fn app_dir_for(cert_dir: &Path) -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        let _ = cert_dir;
        PathBuf::from("/var/lib/witmproxy")
    }
    #[cfg(not(target_os = "linux"))]
    {
        cert_dir
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(system_app_dir)
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

// ---------------------------------------------------------------------------
// Config sections
// ---------------------------------------------------------------------------

#[derive(Conf, Clone, Deserialize, Serialize, Default, Debug)]
#[conf(serde)]
pub struct ProxyConfig {
    /// The address the proxy server will bind to (default: 127.0.0.1:0)
    #[arg(long = "proxy-bind-addr", env = "PROXY_BIND_ADDR")]
    pub proxy_bind_addr: Option<String>,

    /// Tenant resolver strategy: ip-mapping, tailscale, or header (default: ip-mapping)
    #[arg(
        long = "tenant-resolver",
        env = "PROXY_TENANT_RESOLVER",
        default_value = "ip-mapping"
    )]
    pub tenant_resolver: crate::proxy::tenant_resolver::TenantResolverKind,

    /// Header name for header-based tenant resolution
    #[arg(long = "tenant-header", env = "PROXY_TENANT_HEADER")]
    pub tenant_header: Option<String>,
}

#[derive(Conf, Clone, Deserialize, Serialize, Default, Debug)]
#[conf(serde)]
pub struct AuthConfig {
    /// Enable authentication for the management API (default: true).
    /// When false, the management API is served without authentication — allowed,
    /// but only bind it to a trusted interface.
    #[arg(
        parameter,
        long = "auth-enabled",
        env = "AUTH_ENABLED",
        default_value = "true"
    )]
    pub enabled: bool,

    /// External JWKS URL for token verification
    #[arg(long = "auth-jwks-url", env = "AUTH_JWKS_URL")]
    pub jwks_url: Option<String>,

    /// JWT issuer claim
    #[arg(long = "auth-jwt-issuer", env = "AUTH_JWT_ISSUER")]
    pub jwt_issuer: Option<String>,

    /// JWT audience claim
    #[arg(long = "auth-jwt-audience", env = "AUTH_JWT_AUDIENCE")]
    pub jwt_audience: Option<String>,

    /// JWT secret for local token signing. If unset while auth is enabled, a
    /// random secret is generated and persisted to the config file on first startup.
    #[arg(long = "auth-jwt-secret", env = "AUTH_JWT_SECRET")]
    pub jwt_secret: Option<String>,

    /// Default admin email (default: admin@localhost)
    #[arg(
        long = "auth-admin-email",
        env = "AUTH_ADMIN_EMAIL",
        default_value = "admin@localhost"
    )]
    pub admin_email: String,

    /// Default admin password (if unset, a random password is generated on first startup)
    #[arg(long = "auth-admin-password", env = "AUTH_ADMIN_PASSWORD")]
    pub admin_password: Option<String>,
}

#[derive(Conf, Clone, Deserialize, Serialize, Default, Debug)]
#[conf(serde)]
pub struct TransparentProxyConfig {
    /// Enable transparent proxy mode (default: false)
    #[arg(
        parameter,
        long = "transparent-enabled",
        env = "TRANSPARENT_ENABLED",
        default_value = "false"
    )]
    pub enabled: bool,

    /// Listen address for transparent proxy (default: 0.0.0.0:8080)
    #[arg(long = "transparent-listen-addr", env = "TRANSPARENT_LISTEN_ADDR")]
    pub listen_addr: Option<String>,

    /// Network interface for iptables rules (default: tailscale0)
    #[arg(long = "transparent-interface", env = "TRANSPARENT_INTERFACE")]
    pub interface: Option<String>,

    /// Automatically configure iptables rules (default: true)
    #[arg(
        parameter,
        long = "transparent-auto-iptables",
        env = "TRANSPARENT_AUTO_IPTABLES",
        default_value = "true"
    )]
    pub auto_iptables: bool,
}

#[derive(Conf, Clone, Deserialize, Serialize, Default, Debug)]
#[conf(serde)]
pub struct DbConfig {
    /// Path to the SQLite database file (default: /var/lib/witmproxy/witmproxy.db on Linux, $HOME/.witmproxy/db.sqlite otherwise)
    #[cfg(target_os = "linux")]
    #[arg(
        long = "db-path",
        env = "DB_PATH",
        default_value = "/var/lib/witmproxy/witmproxy.db"
    )]
    pub db_path: PathBuf,

    /// Path to the SQLite database file (default: $HOME/.witmproxy/db.sqlite)
    #[cfg(not(target_os = "linux"))]
    #[arg(
        long = "db-path",
        env = "DB_PATH",
        default_value = "$HOME/.witmproxy/db.sqlite"
    )]
    pub db_path: PathBuf,

    /// The database password used to encrypt the local SQLite database (SQLCipher).
    /// Optional at parse time so that commands which never open the database
    /// (e.g. `service uninstall`, `status`) don't demand it. Commands that DO
    /// open the database validate its presence lazily via
    /// [`DbConfig::require_password`], which produces an actionable error.
    #[arg(long = "db-password", env = "DB_PASSWORD")]
    pub db_password: Option<String>,
}

impl DbConfig {
    /// Return the database password, or an actionable error naming both the
    /// environment variable and the CLI flag that can supply it.
    pub fn require_password(&self) -> Result<&str> {
        self.db_password.as_deref().filter(|p| !p.is_empty()).ok_or_else(|| {
            anyhow::anyhow!(
                "a database password is required for this command.\n  \
                 Set the DB_PASSWORD environment variable or pass --db-password <value>."
            )
        })
    }
}

#[derive(Conf, Clone, Deserialize, Serialize, Default, Debug)]
#[conf(serde)]
pub struct TlsConfig {
    /// Size of generated TLS keys in bits (default: 2048)
    #[arg(long = "key-size", env = "TLS_KEY_SIZE", default_value = "2048")]
    pub key_size: u32,

    /// Size of the minted certificate cache (default: 1024)
    #[arg(long = "cache-size", env = "TLS_CACHE_SIZE", default_value = "1024")]
    pub cache_size: usize,

    /// Directory where root certificates are stored (default: /var/lib/witmproxy/certs on Linux, $HOME/.witmproxy/certs otherwise)
    #[cfg(target_os = "linux")]
    #[arg(
        long = "cert-dir",
        env = "TLS_CERT_DIR",
        default_value = "/var/lib/witmproxy/certs"
    )]
    pub cert_dir: PathBuf,

    /// Directory where root certificates are stored (default: $HOME/.witmproxy/certs)
    #[cfg(not(target_os = "linux"))]
    #[arg(
        long = "cert-dir",
        env = "TLS_CERT_DIR",
        default_value = "$HOME/.witmproxy/certs"
    )]
    pub cert_dir: PathBuf,
}

#[derive(Conf, Clone, Deserialize, Serialize, Default, Debug)]
#[conf(serde)]
pub struct PluginConfig {
    /// Enable or disable the plugin system (default: true)
    #[arg(
        parameter,
        long = "plugins-enabled",
        env = "PLUGINS_ENABLED",
        default_value = "true"
    )]
    pub enabled: bool,

    /// Plugin execution timeout in milliseconds (default: 1000). Set to 0 for no timeout.
    #[arg(
        long = "timeout-ms",
        env = "PLUGINS_TIMEOUT_MS",
        default_value = "1000"
    )]
    pub timeout_ms: u64,

    /// Maximum memory per plugin in MB (default: 1024). Set to 0 for unlimited.
    #[arg(
        long = "max-memory-mb",
        env = "PLUGINS_MAX_MEMORY_MB",
        default_value = "1024"
    )]
    pub max_memory_mb: u64,

    /// WASM fuel limit per plugin execution (default: 1000000). Set to 0 for unlimited.
    #[arg(
        long = "max-fuel",
        env = "PLUGINS_MAX_FUEL",
        default_value = "1000000"
    )]
    pub max_fuel: u64,
}

#[derive(Conf, Clone, Deserialize, Serialize, Default, Debug)]
#[conf(serde)]
pub struct WebConfig {
    /// The address the web frontend will bind to (default: 127.0.0.1:0)
    #[arg(long = "web-bind-addr", env = "WEB_BIND_ADDR")]
    pub web_bind_addr: Option<String>,

    /// Path to a TLS certificate file (PEM) for the web server.
    /// When set (along with web_tls_key_path), the web server uses this
    /// certificate instead of auto-generating one from the proxy CA.
    /// Useful with `tailscale cert` which produces <hostname>.crt/.key files.
    #[arg(long = "web-tls-cert-path", env = "WEB_TLS_CERT_PATH")]
    pub web_tls_cert_path: Option<PathBuf>,

    /// Path to a TLS private key file (PEM) for the web server.
    /// Must be set together with web_tls_cert_path.
    #[arg(long = "web-tls-key-path", env = "WEB_TLS_KEY_PATH")]
    pub web_tls_key_path: Option<PathBuf>,
}

#[derive(Conf, Clone, Deserialize, Serialize, Default, Debug)]
#[conf(serde)]
pub struct UpdateConfig {
    /// Enable automatic updates in daemon mode (default: true)
    #[arg(
        parameter,
        long = "auto-update",
        env = "UPDATE_AUTO_UPDATE",
        default_value = "true"
    )]
    pub auto_update: bool,

    /// Seconds between auto-update checks in daemon mode (default: 21600 = 6 hours)
    #[arg(
        long = "check-interval-seconds",
        env = "UPDATE_CHECK_INTERVAL_SECONDS",
        default_value = "21600"
    )]
    pub check_interval_seconds: u64,

    /// Show update warnings in interactive CLI mode (default: true)
    #[arg(
        parameter,
        long = "cli-update-warning",
        env = "UPDATE_CLI_UPDATE_WARNING",
        default_value = "true"
    )]
    pub cli_update_warning: bool,

    /// Prefer prebuilt GitHub release binaries over cargo install (default: true)
    #[arg(
        parameter,
        long = "prefer-prebuilt",
        env = "UPDATE_PREFER_PREBUILT",
        default_value = "true"
    )]
    pub prefer_prebuilt: bool,
}

#[derive(Conf, Clone, Deserialize, Serialize, Default, Debug)]
#[conf(serde)]
pub struct LogConfig {
    /// Log level filter (default: info). Use "debug" or "trace" for more output.
    #[arg(long = "log-level", env = "LOG_LEVEL", default_value = "info")]
    pub log_level: String,

    /// Directory where log files are written in daemon mode.
    /// Defaults to the app directory (/var/lib/witmproxy on Linux, ~/.witmproxy otherwise).
    #[arg(long = "log-dir", env = "LOG_DIR")]
    pub log_dir: Option<PathBuf>,

    /// Log rotation policy: "daily", "hourly", or "never" (default: daily)
    #[arg(long = "rotation", env = "LOG_ROTATION", default_value = "daily")]
    pub rotation: String,

    /// Maximum number of rotated log files to retain (default: 7).
    /// Older files are deleted automatically. Only applies when rotation is not "never".
    #[arg(long = "max-files", env = "LOG_MAX_FILES", default_value = "7")]
    pub max_files: usize,
}

#[derive(Conf, Clone, Deserialize, Serialize, Default, Debug)]
#[conf(serde)]
pub struct TelemetryConfig {
    /// Enable OpenTelemetry export (default: false). Only effective when compiled with the `otel` feature.
    #[arg(
        parameter,
        long = "otel-enabled",
        env = "OTEL_ENABLED",
        default_value = "false"
    )]
    pub enabled: bool,

    /// OTLP endpoint for traces, metrics, and logs (default: http://localhost:4317)
    #[arg(
        long = "otel-endpoint",
        env = "OTEL_EXPORTER_OTLP_ENDPOINT",
        default_value = "http://localhost:4317"
    )]
    pub endpoint: String,

    /// Enable trace export (default: true when telemetry is enabled)
    #[arg(
        parameter,
        long = "otel-traces",
        env = "OTEL_TRACES_ENABLED",
        default_value = "true"
    )]
    pub traces_enabled: bool,

    /// Enable metrics export (default: true when telemetry is enabled)
    #[arg(
        parameter,
        long = "otel-metrics",
        env = "OTEL_METRICS_ENABLED",
        default_value = "true"
    )]
    pub metrics_enabled: bool,

    /// Enable log export (default: true when telemetry is enabled)
    #[arg(
        parameter,
        long = "otel-logs",
        env = "OTEL_LOGS_ENABLED",
        default_value = "true"
    )]
    pub logs_enabled: bool,

    /// Enable system resource metrics (CPU, memory, disk, network) (default: true)
    #[arg(
        parameter,
        long = "otel-resource-metrics",
        env = "OTEL_RESOURCE_METRICS_ENABLED",
        default_value = "true"
    )]
    pub resource_metrics_enabled: bool,

    /// System resource metrics collection interval in seconds (default: 15)
    #[arg(
        long = "otel-resource-metrics-interval",
        env = "OTEL_RESOURCE_METRICS_INTERVAL_SECS",
        default_value = "15"
    )]
    pub resource_metrics_interval_secs: u64,
}

impl TlsConfig {
    pub fn resolve_paths(&mut self) -> Result<()> {
        self.cert_dir = expand_home_in_path(&self.cert_dir)?;
        Ok(())
    }
}

impl DbConfig {
    pub fn resolve_paths(&mut self) -> Result<()> {
        self.db_path = expand_home_in_path(&self.db_path)?;
        Ok(())
    }
}

impl LogConfig {
    pub fn resolve_paths(&mut self) -> Result<()> {
        if let Some(ref p) = self.log_dir {
            self.log_dir = Some(expand_home_in_path(p)?);
        }
        Ok(())
    }
}

impl WebConfig {
    pub fn resolve_paths(&mut self) -> Result<()> {
        if let Some(ref p) = self.web_tls_cert_path {
            self.web_tls_cert_path = Some(expand_home_in_path(p)?);
        }
        if let Some(ref p) = self.web_tls_key_path {
            self.web_tls_key_path = Some(expand_home_in_path(p)?);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Full application config (used by the proxy-running / install commands)
// ---------------------------------------------------------------------------

/// The complete application configuration. Flattens every section, so it
/// contains [`DbConfig`] and therefore requires `DB_PASSWORD`. Used by the
/// commands that actually run the proxy (`run`, `serve`, `start`) and by
/// `service install` (which persists it to `config.toml`).
#[derive(Conf, Clone, Deserialize, Serialize, Default, Debug)]
#[conf(serde)]
pub struct AppConfig {
    #[arg(flatten)]
    #[serde(default)]
    pub proxy: ProxyConfig,

    #[arg(flatten)]
    #[serde(default)]
    pub db: DbConfig,

    #[arg(flatten)]
    #[serde(default)]
    pub tls: TlsConfig,

    #[arg(flatten)]
    #[serde(default)]
    pub plugins: PluginConfig,

    #[arg(flatten)]
    #[serde(default)]
    pub web: WebConfig,

    #[arg(flatten)]
    #[serde(default)]
    pub auth: AuthConfig,

    #[arg(flatten)]
    #[serde(default)]
    pub transparent: TransparentProxyConfig,

    #[arg(flatten)]
    #[serde(default)]
    pub update: UpdateConfig,

    #[arg(flatten)]
    #[serde(default)]
    pub log: LogConfig,

    #[arg(flatten)]
    #[serde(default)]
    pub telemetry: TelemetryConfig,
}

impl AppConfig {
    /// Load configuration directly from a TOML file (no CLI/env layering).
    /// Best-effort helper for early startup reads; prefer the layered
    /// [`conf`] parse in [`crate::cli`] for the authoritative config.
    pub fn load<P: AsRef<Path>>(path: P) -> Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let config: AppConfig = toml::from_str(&content)?;
        Ok(config)
    }

    /// Serialize the effective configuration to a TOML file.
    ///
    /// The file may contain secrets (`db_password`, `jwt_secret`,
    /// `admin_password`); callers are responsible for restricting its
    /// permissions (see [`crate::fs_secure`]).
    pub fn save<P: AsRef<Path>>(&self, path: P) -> Result<()> {
        let content = toml::to_string_pretty(self)?;
        crate::fs_secure::write_secret(path, content)?;
        Ok(())
    }

    /// The application data directory implied by this configuration.
    pub fn app_dir(&self) -> PathBuf {
        app_dir_for(&self.tls.cert_dir)
    }

    /// Resolve all potential $HOME placeholders in configuration paths.
    /// This should be called once during initialization to avoid repeated path resolution.
    pub fn with_resolved_paths(mut self) -> Result<Self> {
        self.db.resolve_paths()?;
        self.tls.resolve_paths()?;
        self.log.resolve_paths()?;
        self.web.resolve_paths()?;
        Ok(self)
    }
}

// Handlers receive the individual section structs above (e.g. `TlsConfig`,
// `DbConfig`, `UpdateConfig`) — the "appropriately scoped object" for each
// command — rather than the whole `AppConfig`. See `crate::cli`.
