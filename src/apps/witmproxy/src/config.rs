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

pub use crate::util::secret::Secret;

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
    /// random secret is generated and persisted to the config file on first
    /// startup. Passing a value on the command line exposes it to shell
    /// history and process listings; pass the bare flag to be prompted
    /// instead.
    #[arg(
        long = "auth-jwt-secret",
        env = "AUTH_JWT_SECRET",
        default_if_missing = ""
    )]
    pub jwt_secret: Option<Secret>,

    /// Default admin email (default: admin@localhost)
    #[arg(
        long = "auth-admin-email",
        env = "AUTH_ADMIN_EMAIL",
        default_value = "admin@localhost"
    )]
    pub admin_email: String,

    /// Default admin password (if unset, a random password is generated on
    /// first startup). Passing a value on the command line exposes it to
    /// shell history and process listings; pass the bare flag to be prompted
    /// instead.
    #[arg(
        long = "auth-admin-password",
        env = "AUTH_ADMIN_PASSWORD",
        default_if_missing = ""
    )]
    pub admin_password: Option<Secret>,
}

impl AuthConfig {
    /// Whether no usable JWT signing secret is set — either absent or the empty
    /// "prompt me" sentinel. Callers generate one in this case, so an empty
    /// sentinel that slipped past [`AppConfig::resolve_secret_prompts`] (e.g.
    /// the non-interactive daemon path) is regenerated rather than used to sign
    /// tokens.
    pub fn jwt_secret_missing(&self) -> bool {
        self.jwt_secret.as_ref().is_none_or(Secret::is_empty)
    }

    /// Whether no usable admin password is set (absent or the empty sentinel).
    pub fn admin_password_missing(&self) -> bool {
        self.admin_password.as_ref().is_none_or(Secret::is_empty)
    }
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

    /// The database password used to encrypt the local SQLite database
    /// (SQLCipher). Only required by commands that open the database; the
    /// daemon generates and persists one on first startup if unset. Passing
    /// a value on the command line exposes it to shell history and process
    /// listings; pass the bare flag to be prompted instead.
    //
    // Optional at parse time so commands that open the database resolve it
    // lazily via `DbConfig::resolve_password` (prompt for the bare-flag
    // sentinel, actionable error when absent).
    #[arg(long = "db-password", env = "DB_PASSWORD", default_if_missing = "")]
    pub db_password: Option<Secret>,
}

impl DbConfig {
    /// Resolve the database password: an explicit non-empty value is used
    /// as-is; the empty "prompt me" sentinel (a bare `--db-password`) prompts
    /// — hidden on a TTY, one line from stdin otherwise; an absent value is
    /// an actionable error naming every way to supply it.
    pub fn resolve_password(&self) -> Result<Secret> {
        match &self.db_password {
            Some(secret) if !secret.is_empty() => Ok(secret.clone()),
            Some(_) => crate::util::secret::prompt("Database password"),
            None => Err(anyhow::anyhow!(
                "a database password is required for this command.\n  \
                 Set the DB_PASSWORD environment variable, pass --db-password <value>,\n  \
                 or pass a bare --db-password to be prompted."
            )),
        }
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

    /// Plugin execution timeout in milliseconds (default: 10000). Set to 0 for no timeout.
    #[arg(
        long = "timeout-ms",
        env = "PLUGINS_TIMEOUT_MS",
        default_value = "10000"
    )]
    pub timeout_ms: u64,

    /// Maximum memory per plugin in MB (default: 1024). Set to 0 for unlimited.
    #[arg(
        long = "max-memory-mb",
        env = "PLUGINS_MAX_MEMORY_MB",
        default_value = "1024"
    )]
    pub max_memory_mb: u64,

    /// WASM fuel limit per plugin execution (default: 0 = unlimited).
    ///
    /// `--timeout-ms` is the DoS control: it is enforced by epoch interruption,
    /// which preempts even a guest that never yields. Fuel bounds an abstract
    /// instruction count instead of wall clock; the previous default of
    /// 1,000,000 could not parse a 400 KB HTML page, so it broke content
    /// rewriting on real pages while adding nothing the timeout did not cover.
    #[arg(long = "max-fuel", env = "PLUGINS_MAX_FUEL", default_value = "0")]
    pub max_fuel: u64,

    /// Maximum table elements a plugin may allocate (default: 100000). Set to 0
    /// for unlimited. Table growth is host allocation that `max_memory_mb`,
    /// which caps guest linear memory, does not bound.
    #[arg(
        long = "max-table-elements",
        env = "PLUGINS_MAX_TABLE_ELEMENTS",
        default_value = "100000"
    )]
    pub max_table_elements: u64,

    /// Maximum concurrent WASM instances per plugin store (default: 64). Set to
    /// 0 for unlimited.
    #[arg(
        long = "max-instances",
        env = "PLUGINS_MAX_INSTANCES",
        default_value = "64"
    )]
    pub max_instances: u64,

    /// Maximum bytes a plugin may retain in host-side local storage
    /// (default: 8388608 = 8 MiB). Set to 0 for unlimited.
    ///
    /// This is HOST memory, not guest memory, so it is not covered by
    /// `max_memory_mb`; without a cap a plugin can grow the daemon's resident
    /// set without bound.
    #[arg(
        long = "max-local-storage-bytes",
        env = "PLUGINS_MAX_LOCAL_STORAGE_BYTES",
        default_value = "8388608"
    )]
    pub max_local_storage_bytes: u64,

    /// Maximum distinct keys a plugin may retain in local storage
    /// (default: 4096). Set to 0 for unlimited.
    #[arg(
        long = "max-local-storage-keys",
        env = "PLUGINS_MAX_LOCAL_STORAGE_KEYS",
        default_value = "4096"
    )]
    pub max_local_storage_keys: u64,

    /// Maximum bytes a plugin may write to the log per event
    /// (default: 65536 = 64 KiB). Set to 0 for unlimited.
    #[arg(
        long = "max-log-bytes-per-event",
        env = "PLUGINS_MAX_LOG_BYTES_PER_EVENT",
        default_value = "65536"
    )]
    pub max_log_bytes_per_event: u64,

    /// Maximum log messages a plugin may emit per event (default: 256). Set to
    /// 0 for unlimited.
    #[arg(
        long = "max-log-messages-per-event",
        env = "PLUGINS_MAX_LOG_MESSAGES_PER_EVENT",
        default_value = "256"
    )]
    pub max_log_messages_per_event: u64,

    /// Maximum bytes a plugin may write into a replacement body
    /// (default: 134217728 = 128 MiB). Set to 0 for unlimited.
    ///
    /// Bounds the amplification available from `content.set-body`: without it a
    /// plugin can answer a small request with an unbounded response stream.
    #[arg(
        long = "max-response-body-bytes",
        env = "PLUGINS_MAX_RESPONSE_BODY_BYTES",
        default_value = "134217728"
    )]
    pub max_response_body_bytes: u64,

    /// Maximum host memory used to duplicate event data so a failed plugin can
    /// be recovered from (default: 16777216 = 16 MiB). Set to 0 for unlimited.
    /// Only consulted when recovery is `fail-open`.
    #[arg(
        long = "max-event-recovery-buffer-bytes",
        env = "PLUGINS_MAX_EVENT_RECOVERY_BUFFER_BYTES",
        default_value = "16777216"
    )]
    pub max_event_recovery_buffer_bytes: u64,

    /// What to do when a plugin fails mid-event: `fail-closed` (default) ends
    /// the event; `fail-open` rebuilds the event as the failing plugin
    /// received it and continues the chain.
    ///
    /// `fail-open` costs host memory only for body bytes a guest actually
    /// read, bounded by `--max-event-recovery-buffer-bytes`. It restores the
    /// event payload, not side effects the plugin already performed.
    #[arg(
        long = "plugin-recovery",
        env = "PLUGINS_RECOVERY",
        default_value = "fail-closed"
    )]
    pub recovery: String,
}

impl PluginConfig {
    /// The global baseline limits. Per-plugin overrides stored in the database
    /// are resolved against this; see `crate::plugins::limits`.
    pub fn resolved_limits(&self) -> crate::plugins::limits::ResolvedLimits {
        crate::plugins::limits::ResolvedLimits {
            max_fuel: self.max_fuel,
            max_memory_mb: self.max_memory_mb,
            timeout_ms: self.timeout_ms,
            max_table_elements: self.max_table_elements,
            max_instances: self.max_instances,
            max_local_storage_bytes: self.max_local_storage_bytes,
            max_local_storage_keys: self.max_local_storage_keys,
            max_log_bytes_per_event: self.max_log_bytes_per_event,
            max_log_messages_per_event: self.max_log_messages_per_event,
            max_response_body_bytes: self.max_response_body_bytes,
            max_event_recovery_buffer_bytes: self.max_event_recovery_buffer_bytes,
            // An unrecognised value must not silently widen the blast radius,
            // so anything other than an explicit `fail-open` stays closed.
            recovery: match self.recovery.as_str() {
                "fail-open" => crate::plugins::limits::RecoveryPolicy::FailOpen,
                _ => crate::plugins::limits::RecoveryPolicy::FailClosed,
            },
        }
    }
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

#[derive(Conf, Clone, Deserialize, Serialize, Debug)]
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

#[derive(Conf, Clone, Deserialize, Serialize, Debug)]
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

// Manual `Default`s matching the parse-time `default_value`s above, so
// commands whose config scope omits these sections (and code building a
// partial `AppConfig`) see the same defaults as a `conf` parse.
impl Default for UpdateConfig {
    fn default() -> Self {
        Self {
            auto_update: true,
            check_interval_seconds: 21600,
            cli_update_warning: true,
            prefer_prebuilt: true,
        }
    }
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            log_level: "info".to_string(),
            log_dir: None,
            rotation: "daily".to_string(),
            max_files: 7,
        }
    }
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

/// The on-disk shape of `config.toml`: everything nested under a single
/// `[config]` table. This matches what the `conf` parse reads — every
/// config-bearing subcommand variant is `#[conf(serde(rename = "config"))]`,
/// so they all read the same `[config]` section (full or scoped).
#[derive(Deserialize)]
struct ConfigFile {
    #[serde(default)]
    config: AppConfig,
}

#[derive(Serialize)]
struct ConfigFileRef<'a> {
    config: &'a AppConfig,
}

impl AppConfig {
    /// Load configuration directly from a TOML file (no CLI/env layering).
    /// Best-effort helper for early startup reads; prefer the layered
    /// [`conf`] parse in [`crate::cli`] for the authoritative config.
    pub fn load<P: AsRef<Path>>(path: P) -> Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let file: ConfigFile = toml::from_str(&content)?;
        Ok(file.config)
    }

    /// Serialize the effective configuration to a TOML file (under `[config]`,
    /// see [`ConfigFile`]).
    ///
    /// The file may contain secrets (`db_password`, `jwt_secret`,
    /// `admin_password`); callers are responsible for restricting its
    /// permissions (see [`crate::fs_secure`]).
    pub fn save<P: AsRef<Path>>(&self, path: P) -> Result<()> {
        let content = toml::to_string_pretty(&ConfigFileRef { config: self })?;
        crate::util::fs_secure::write_secret(path, content)?;
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

    /// Resolve any "prompt me" secret sentinels (a bare `--db-password`,
    /// `--auth-jwt-secret`, or `--auth-admin-password`) by prompting, in that
    /// fixed order. The full-config commands call this once, up front, so
    /// prompted values flow into everything downstream — including
    /// `service install`, which persists them to the config file.
    pub fn resolve_secret_prompts(mut self) -> Result<Self> {
        use crate::util::secret::prompt;
        if self.db.db_password.as_ref().is_some_and(Secret::is_empty) {
            self.db.db_password = Some(prompt("Database password")?);
        }
        if self.auth.jwt_secret.as_ref().is_some_and(Secret::is_empty) {
            self.auth.jwt_secret = Some(prompt("JWT signing secret")?);
        }
        if self.auth.admin_password.as_ref().is_some_and(Secret::is_empty) {
            self.auth.admin_password = Some(prompt("Admin password")?);
        }
        Ok(self)
    }
}

// ---------------------------------------------------------------------------
// Scoped config subsets (per-subcommand)
// ---------------------------------------------------------------------------
//
// Commands that don't run the proxy flatten one of these instead of the full
// `AppConfig`, so their `--help` documents only the options they actually use.
// They read the same `[config]` file section as the full config; the
// `allow_unknown_fields` attribute lets them ignore the `[config.*]` tables
// they don't declare.

/// Config subset for commands that only need to locate the app/cert directory
/// (`ca`, `proxy`, `openapi`).
#[derive(Conf, Clone, Debug, Default)]
#[conf(serde(allow_unknown_fields))]
pub struct TlsScopedConfig {
    #[arg(flatten)]
    pub tls: TlsConfig,
}

impl TlsScopedConfig {
    pub fn with_resolved_paths(mut self) -> Result<Self> {
        self.tls.resolve_paths()?;
        Ok(self)
    }
}

/// Config subset for service-control commands that never open the database
/// (`stop`, `status`, `logs`): the app dir (via tls) and the log dir.
#[derive(Conf, Clone, Debug, Default)]
#[conf(serde(allow_unknown_fields))]
pub struct ServiceScopedConfig {
    #[arg(flatten)]
    pub tls: TlsConfig,

    #[arg(flatten)]
    pub log: LogConfig,
}

impl ServiceScopedConfig {
    pub fn with_resolved_paths(mut self) -> Result<Self> {
        self.tls.resolve_paths()?;
        self.log.resolve_paths()?;
        Ok(self)
    }
}

/// Config subset for `plugin` commands: the plugin database plus the app/cert
/// directory.
#[derive(Conf, Clone, Debug, Default)]
#[conf(serde(allow_unknown_fields))]
pub struct PluginScopedConfig {
    #[arg(flatten)]
    pub db: DbConfig,

    #[arg(flatten)]
    pub tls: TlsConfig,
}

impl PluginScopedConfig {
    pub fn with_resolved_paths(mut self) -> Result<Self> {
        self.db.resolve_paths()?;
        self.tls.resolve_paths()?;
        Ok(self)
    }
}

/// Config subset for the `update` command.
#[derive(Conf, Clone, Debug, Default)]
#[conf(serde(allow_unknown_fields))]
pub struct UpdateScopedConfig {
    #[arg(flatten)]
    pub update: UpdateConfig,
}

// Handlers receive the individual section structs above (e.g. `TlsConfig`,
// `DbConfig`, `UpdateConfig`) or one of the scoped subsets — the
// "appropriately scoped object" for each command — rather than the whole
// `AppConfig`. See `crate::cli`.

#[cfg(test)]
mod tests {
    use super::*;

    /// The empty "prompt me" sentinel (a bare secret flag) must count as
    /// missing, so it's regenerated/prompted rather than used as a real
    /// secret. Guards the daemon path where prompting isn't possible.
    #[test]
    fn empty_secret_sentinel_counts_as_missing() {
        let mut auth = AuthConfig {
            enabled: true,
            ..Default::default()
        };
        assert!(auth.jwt_secret_missing(), "absent → missing");
        assert!(auth.admin_password_missing(), "absent → missing");

        auth.jwt_secret = Some(Secret::from(""));
        auth.admin_password = Some(Secret::from(""));
        assert!(auth.jwt_secret_missing(), "empty sentinel → missing");
        assert!(auth.admin_password_missing(), "empty sentinel → missing");

        auth.jwt_secret = Some(Secret::from("real"));
        auth.admin_password = Some(Secret::from("real"));
        assert!(!auth.jwt_secret_missing(), "real value → present");
        assert!(!auth.admin_password_missing(), "real value → present");
    }

    /// `resolve_secret_prompts` leaves absent and real values untouched (only
    /// the empty sentinel prompts, which needs a TTY and isn't exercised here).
    #[test]
    fn resolve_secret_prompts_passes_through_non_sentinels() {
        let config = AppConfig {
            db: DbConfig {
                db_password: Some(Secret::from("real-db")),
                ..Default::default()
            },
            auth: AuthConfig {
                jwt_secret: None,
                admin_password: Some(Secret::from("real-admin")),
                ..Default::default()
            },
            ..Default::default()
        };
        let resolved = config.resolve_secret_prompts().unwrap();
        assert_eq!(
            resolved.db.db_password.as_ref().map(Secret::expose),
            Some("real-db")
        );
        assert!(resolved.auth.jwt_secret.is_none());
        assert_eq!(
            resolved.auth.admin_password.as_ref().map(Secret::expose),
            Some("real-admin")
        );
    }

    /// `save` writes the config nested under `[config]` — the same section
    /// every config-bearing subcommand reads via `conf` — and `load` unwraps
    /// it back.
    #[test]
    fn config_file_round_trips_under_config_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");

        let mut config = AppConfig::default();
        config.db.db_password = Some(Secret::from("round-trip"));
        config.tls.cert_dir = PathBuf::from("/tmp/rt/certs");
        config.save(&path).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(
            content.contains("[config.db]"),
            "expected [config.*] tables, got:\n{content}"
        );

        let loaded = AppConfig::load(&path).unwrap();
        assert_eq!(
            loaded.db.db_password.as_ref().map(Secret::expose),
            Some("round-trip")
        );
        assert_eq!(loaded.tls.cert_dir, PathBuf::from("/tmp/rt/certs"));
    }
}
