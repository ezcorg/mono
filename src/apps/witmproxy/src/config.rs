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
use std::fmt;
use std::path::{Path, PathBuf};
use std::str::FromStr;

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

/// The app directory of a witmproxy that is one user's: on Linux
/// `$XDG_STATE_HOME/witmproxy` (`~/.local/state/witmproxy`), where a user's
/// daemons keep their state; elsewhere `~/.witmproxy`, which is where every
/// install off Linux already lives.
pub fn user_app_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".local/state")
            })
            .join("witmproxy")
    }
    #[cfg(not(target_os = "linux"))]
    {
        system_app_dir()
    }
}

/// Whose service a witmproxy is: the host's, or one user's.
///
/// A *system* witmproxy is installed by root, keeps its state under
/// `/var/lib/witmproxy`, runs as a system unit from boot, and is what every
/// Linux install has been. A *user* witmproxy is installed by a user without
/// root, keeps its state in that user's home, runs as a `systemctl --user`
/// unit (a LaunchAgent on macOS), and lives as long as the user's session
/// unless `loginctl enable-linger` keeps the user's manager running. Off
/// Linux, user is the only scope there is: a system-level install there (a
/// LaunchDaemon with `UserName`, for a daemon that must outlive logout) is
/// not written yet.
///
/// `--user` (or `WITM_USER=1`) selects the user scope on any command; the
/// system scope needs no flag, like `systemctl`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Scope {
    System,
    User,
}

impl Default for Scope {
    /// What an invocation without `--user` means: the system scope on Linux,
    /// the user scope everywhere else (where it is the only one).
    fn default() -> Self {
        if cfg!(target_os = "linux") {
            Scope::System
        } else {
            Scope::User
        }
    }
}

impl Scope {
    /// The scope this process was invoked for: `--user` anywhere on the
    /// command line, else `WITM_USER` (set and not `0`/`false`/`off`/empty),
    /// else the platform's default. Read from the raw argv, like
    /// `--instance`, because the structured parse's path defaults depend on
    /// it.
    pub fn from_invocation() -> Self {
        if cfg!(not(target_os = "linux")) {
            return Scope::User;
        }
        let flagged = std::env::args_os().skip(1).any(|a| a == "--user");
        if flagged || Self::env_requests_user() {
            Scope::User
        } else {
            Scope::System
        }
    }

    /// Whether `WITM_USER` asks for the user scope.
    pub fn env_requests_user() -> bool {
        match std::env::var("WITM_USER") {
            Ok(v) => !matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "" | "0" | "false" | "f" | "off" | "o" | "no"
            ),
            Err(_) => false,
        }
    }

    /// The app directory for this scope: [`system_app_dir`] or
    /// [`user_app_dir`].
    pub fn app_dir(self) -> PathBuf {
        match self {
            Scope::System => system_app_dir(),
            Scope::User => user_app_dir(),
        }
    }

    pub fn is_user(self) -> bool {
        self == Scope::User
    }
}

/// The database file name inside an instance's root: what a fresh daemon
/// creates when `--db-path` is unset.
#[cfg(target_os = "linux")]
const DB_FILE_NAME: &str = "witmproxy.db";
#[cfg(not(target_os = "linux"))]
const DB_FILE_NAME: &str = "db.sqlite";

/// Which of the witmproxys on this host an invocation is about.
///
/// An instance is a namespace and nothing more: it decides where a daemon
/// keeps its state, what its service unit is called, which keychain entry
/// holds its database key and where the CLI keeps the token for it. Nothing
/// orchestrates instances; the operator (or a tool such as rig) decides which
/// exist and what each binds. The *default* instance is the unnamed one every
/// existing install is: its paths and unit names are exactly what they were
/// before instances existed. A *named* instance lives under
/// `<app dir>/instances/<name>` and runs as `ez-witmproxy@<name>`.
///
/// An instance also has a [`Scope`]: the host's (`/var/lib/witmproxy`, a
/// system unit) or one user's (the user's home, a user unit). The two scopes
/// are two namespaces, so a user's `agent-1` and the host's `agent-1` never
/// touch.
///
/// The instance is read from the raw command line (`--instance` and `--user`,
/// then `WITM_INSTANCE` and `WITM_USER`) before the structured parse, like
/// `--config-path`: it decides where the config file is and what the path
/// defaults are, both of which the structured parse needs to know. See
/// [`Instance::from_invocation`].
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Instance {
    /// `None` is the default instance.
    name: Option<String>,
    scope: Scope,
}

/// A rejected instance name, with the rule it broke.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceNameError(String);

impl fmt::Display for InstanceNameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "invalid instance name {:?}: an instance name is 1 to 63 characters of a-z, 0-9, \
             '.', '_' and '-', starting with a letter or digit ({})",
            self.0,
            Instance::NAME_RULE
        )
    }
}

impl std::error::Error for InstanceNameError {}

impl Instance {
    /// What a name must match. Lowercase so unit names, directory names and
    /// keychain entries never differ by case; no `/` or leading `.`, so a name
    /// is always one directory under `instances/`.
    pub const NAME_RULE: &'static str = "^[a-z0-9][a-z0-9._-]{0,62}$";

    /// How the default instance is spelled where a name is needed: in
    /// `witm service list`, and as `--instance default`.
    pub const DEFAULT_NAME: &'static str = "default";

    /// The instance called `name`; `default` is the default instance.
    pub fn named(name: &str) -> Result<Self, InstanceNameError> {
        if name == Self::DEFAULT_NAME {
            return Ok(Self::default());
        }
        let mut chars = name.chars();
        let first_ok = chars
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
        let rest_ok = chars
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'));
        if first_ok && rest_ok && name.len() <= 63 {
            Ok(Self {
                name: Some(name.to_string()),
                scope: Scope::default(),
            })
        } else {
            Err(InstanceNameError(name.to_string()))
        }
    }

    /// This instance in `scope`.
    pub fn with_scope(mut self, scope: Scope) -> Self {
        self.scope = scope;
        self
    }

    /// The default instance of the user scope.
    pub fn user() -> Self {
        Self::default().with_scope(Scope::User)
    }

    /// The instance this process was invoked for: `--instance` anywhere on
    /// the command line, else `WITM_INSTANCE`, else the default; in the scope
    /// `--user`/`WITM_USER` select. Read from the raw argv (position-agnostic,
    /// like `--config-path`) because the structured parse's own defaults
    /// depend on it.
    pub fn from_invocation() -> Result<Self, InstanceNameError> {
        let raw = conf::find_parameter("instance", std::env::args_os())
            .or_else(|| std::env::var_os("WITM_INSTANCE"));
        let instance = match raw {
            None => Self::default(),
            Some(raw) => Self::named(&raw.to_string_lossy())?,
        };
        Ok(instance.with_scope(Scope::from_invocation()))
    }

    /// [`Self::from_invocation`] for the parser's path defaults, which cannot
    /// fail: a bad name falls back to the default instance's paths, and the
    /// structured parse then rejects the name itself before any of those paths
    /// is used.
    pub fn current() -> Self {
        Self::from_invocation().unwrap_or_default()
    }

    /// `None` for the default instance.
    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    pub fn is_default(&self) -> bool {
        self.name.is_none()
    }

    pub fn scope(&self) -> Scope {
        self.scope
    }

    /// Whether this is one user's witmproxy rather than the host's.
    pub fn is_user(&self) -> bool {
        self.scope.is_user()
    }

    /// ` --user` when the scope is not the platform's default, so a hint
    /// such as `witm service start --user --instance x` names the same
    /// instance the operator did; empty otherwise.
    pub fn scope_flag(&self) -> &'static str {
        if self.scope != Scope::default() {
            " --user"
        } else {
            ""
        }
    }

    /// Where the named instances of `scope` live: `<app dir>/instances`.
    pub fn instances_dir_for(scope: Scope) -> PathBuf {
        scope.app_dir().join("instances")
    }

    /// Where the named instances of this instance's scope live.
    pub fn instances_dir(&self) -> PathBuf {
        Self::instances_dir_for(self.scope)
    }

    /// The default instance of `scope` and every directory under its
    /// [`Self::instances_dir_for`] whose name is a valid instance name, the
    /// default first and the rest sorted. A directory is an instance; nothing
    /// else registers one.
    pub fn list(scope: Scope) -> Vec<Self> {
        let mut named: Vec<Self> = std::fs::read_dir(Self::instances_dir_for(scope))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| Self::named(&entry.file_name().to_string_lossy()).ok())
            .filter(|instance| !instance.is_default())
            .map(|instance| instance.with_scope(scope))
            .collect();
        named.sort_by(|a, b| a.name.cmp(&b.name));
        std::iter::once(Self::default().with_scope(scope))
            .chain(named)
            .collect()
    }

    /// The state directory: the scope's app dir (`/var/lib/witmproxy` for
    /// the host's on Linux, `~/.local/state/witmproxy` for a user's there,
    /// `~/.witmproxy` elsewhere) for the default instance, `instances/<name>`
    /// under that for a named one. Holds the config, the database, the CA,
    /// `services.json` and the logs.
    pub fn root(&self) -> PathBuf {
        match &self.name {
            None => self.scope.app_dir(),
            Some(name) => self.instances_dir().join(name),
        }
    }

    /// `<root>/config.toml`, what `--config-path` defaults to.
    pub fn config_file(&self) -> PathBuf {
        self.root().join("config.toml")
    }

    /// `<root>/witmproxy.db` on Linux, `<root>/db.sqlite` elsewhere: what
    /// `--db-path` defaults to.
    pub fn db_file(&self) -> PathBuf {
        self.root().join(DB_FILE_NAME)
    }

    /// `<root>/certs`, what `--cert-dir` defaults to.
    pub fn cert_dir(&self) -> PathBuf {
        self.root().join("certs")
    }

    /// `<root>/services.json`: the addresses the daemon bound, written when
    /// it starts.
    pub fn services_file(&self) -> PathBuf {
        self.root().join("services.json")
    }

    /// Where the daemon's rolling log files go when `--log-dir` is unset:
    /// the root itself.
    pub fn log_dir(&self) -> PathBuf {
        self.root()
    }

    /// `<root>/witmproxy.log`, the un-rotated log file name the service unit
    /// passes as `--log-file`.
    pub fn log_file(&self) -> PathBuf {
        self.root().join("witmproxy.log")
    }

    /// Where `witm auth login` keeps this instance's token. For the host's
    /// witmproxy, `~/.witmproxy/auth.json` for the default instance and
    /// `~/.witmproxy/instances/<name>/auth.json` otherwise: under the home
    /// directory, since it is the operator's credential, not the daemon's
    /// state. For a user's witmproxy, `auth.json` in the instance's root,
    /// which is in that user's home already (and is, off Linux, the same
    /// path as ever).
    pub fn auth_file(&self) -> PathBuf {
        match self.scope {
            Scope::User => self.root().join("auth.json"),
            Scope::System => {
                let base = dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".witmproxy");
                match &self.name {
                    None => base.join("auth.json"),
                    Some(name) => base.join("instances").join(name).join("auth.json"),
                }
            }
        }
    }

    /// The application name the database key is filed under in the OS
    /// keychain (and the key file beside the database is named after):
    /// `witmproxy` for the default instance, `witmproxy@<name>` otherwise.
    /// The keychain entry is keyed by this name alone, so two instances must
    /// not share it. The two scopes may: the host's daemon runs as root and
    /// a user's as that user, and a keychain is per user.
    pub fn keychain_app(&self) -> String {
        match &self.name {
            None => "witmproxy".to_string(),
            Some(name) => format!("witmproxy@{name}"),
        }
    }

    /// The systemd unit name without `.service`: `ez-witmproxy` for the
    /// default instance, `ez-witmproxy@<name>` otherwise (a concrete unit file
    /// with that name, so `systemctl status ez-witmproxy@<name>` reads
    /// naturally).
    pub fn unit_name(&self) -> String {
        match &self.name {
            None => "ez-witmproxy".to_string(),
            Some(name) => format!("ez-witmproxy@{name}"),
        }
    }

    /// The launchd label: `co.ez.witmproxy` for the default instance,
    /// `co.ez.witmproxy.<name>` otherwise.
    pub fn launchd_label(&self) -> String {
        match &self.name {
            None => "co.ez.witmproxy".to_string(),
            Some(name) => format!("co.ez.witmproxy.{name}"),
        }
    }

    /// The label the `service_manager` crate derives this platform's service
    /// name from: on Linux its script name (`<organization>-<application>`)
    /// must be [`Self::unit_name`], elsewhere its qualified name must be
    /// [`Self::launchd_label`].
    pub fn service_label(&self) -> String {
        #[cfg(target_os = "linux")]
        {
            match &self.name {
                None => "co.ez.witmproxy".to_string(),
                Some(name) => format!("co.ez.witmproxy@{name}"),
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            self.launchd_label()
        }
    }

    /// The service file's name in the service manager's directory:
    /// `<unit name>.service` on Linux, `<label>.plist` on macOS.
    pub fn service_file_name(&self) -> String {
        #[cfg(target_os = "linux")]
        {
            format!("{}.service", self.unit_name())
        }
        #[cfg(target_os = "macos")]
        {
            format!("{}.plist", self.launchd_label())
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            self.service_label()
        }
    }
}

impl fmt::Display for Instance {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name.as_deref().unwrap_or(Self::DEFAULT_NAME))
    }
}

impl FromStr for Instance {
    type Err = InstanceNameError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::named(s)
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

    /// Addresses the proxy never connects to on a client's behalf, as a
    /// comma-separated list of CIDRs (`10.0.0.0/8,192.168.0.0/16,::1/128`).
    /// Judged after resolution, on the address about to be dialed: a CONNECT
    /// or request whose host is or resolves only to denied addresses is
    /// refused, and denied addresses among several are skipped. For a proxy
    /// fronting clients that may reach less than it can.
    #[arg(long = "upstream-deny", env = "PROXY_UPSTREAM_DENY")]
    pub upstream_deny: Option<String>,

    /// The instance's egress policy, a TOML file: who may dial what, as
    /// `permit`/`forbid` rules over sources and `host:port` destinations
    /// (see "Policy" in the README). Unset: `policy.toml` in the instance's
    /// root when there is one, else no policy beyond `--upstream-deny`, and
    /// every dial is permitted.
    #[arg(long = "policy-file", env = "PROXY_POLICY_FILE")]
    pub policy_file: Option<PathBuf>,
}

impl ProxyConfig {
    /// Fill an unset `policy_file` with the instance's `policy.toml` when
    /// that file exists, and expand `$HOME`.
    pub fn resolve_paths(&mut self, instance: &Instance) -> Result<()> {
        if self.policy_file.is_none() {
            let default = instance.root().join("policy.toml");
            if default.exists() {
                self.policy_file = Some(default);
            }
        }
        if let Some(ref p) = self.policy_file {
            self.policy_file = Some(expand_home_in_path(p)?);
        }
        Ok(())
    }
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
    /// Path to the SQLite database file. Unset (or empty): the instance's,
    /// `<instance root>/witmproxy.db` on Linux and `<instance root>/db.sqlite`
    /// elsewhere, where the default instance's root is `/var/lib/witmproxy`
    /// or `$HOME/.witmproxy` and a named instance's is `instances/<name>`
    /// under that (see `--instance`). Filled in by `resolve_paths`.
    #[arg(
        long = "db-path",
        env = "DB_PATH",
        default,
        default_help_str = "<instance root>/witmproxy.db on Linux, <instance root>/db.sqlite elsewhere"
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
    ///
    /// The keychain entry is keyed by the instance (`witmproxy` for the
    /// default, `witmproxy@<name>` otherwise), never shared between two.
    pub fn resolve_password(&self, instance: &Instance) -> Result<Secret> {
        match &self.db_password {
            Some(secret) if !secret.is_empty() => Ok(secret.clone()),
            Some(_) => crate::util::secret::prompt("Database password"),
            // Nothing supplied: the machine's keychain, or a 0600 key file
            // beside the database, holds a key that is created on first use.
            // An explicit password still wins, so existing deployments keep
            // opening with the passphrase they were created with.
            None => {
                let dir = self
                    .db_path
                    .parent()
                    .map(std::path::Path::to_path_buf)
                    .unwrap_or_else(|| std::path::PathBuf::from("."));
                let key = ezdb::KeySource::default_for(&instance.keychain_app(), dir)
                    .resolve()
                    .map_err(|e| {
                        anyhow::anyhow!(
                            "no database password was given and no key source is available:\n{e}\n  \
                             Set the DB_PASSWORD environment variable, pass --db-password <value>,\n  \
                             or pass a bare --db-password to be prompted."
                        )
                    })?;
                Ok(Secret::from(key.expose()))
            }
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

    /// Directory where root certificates are stored. Unset (or empty): the
    /// instance's, `<instance root>/certs`, where the default instance's root
    /// is `/var/lib/witmproxy` on Linux or `$HOME/.witmproxy` elsewhere and a
    /// named instance's is `instances/<name>` under that (see `--instance`).
    /// Filled in by `resolve_paths`.
    #[arg(
        long = "cert-dir",
        env = "TLS_CERT_DIR",
        default,
        default_help_str = "<instance root>/certs"
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

    /// An icanhaz broker (`ws://127.0.0.1:7777`, the tray app) that decides,
    /// at install time, which of the capabilities a plugin wants it gets. The
    /// human sees each one there, may narrow its scope, and witmproxy
    /// enforces the result. Unset: every wanted capability is granted as
    /// proposed.
    #[arg(long = "plugins-icanhaz", env = "PLUGINS_ICANHAZ")]
    pub icanhaz: Option<String>,

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
    /// Useful with `tailscale cert` which produces `<hostname>.crt` / `.key` files.
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
    /// Defaults to the instance's root (/var/lib/witmproxy on Linux,
    /// ~/.witmproxy otherwise; `instances/<name>` under that for a named instance).
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
    /// Fill an unset (empty) `cert_dir` with the instance's and expand `$HOME`.
    pub fn resolve_paths(&mut self, instance: &Instance) -> Result<()> {
        if self.cert_dir.as_os_str().is_empty() {
            self.cert_dir = instance.cert_dir();
        }
        self.cert_dir = expand_home_in_path(&self.cert_dir)?;
        Ok(())
    }
}

impl DbConfig {
    /// Fill an unset (empty) `db_path` with the instance's and expand `$HOME`.
    pub fn resolve_paths(&mut self, instance: &Instance) -> Result<()> {
        if self.db_path.as_os_str().is_empty() {
            self.db_path = instance.db_file();
        }
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
    /// see `ConfigFile`).
    ///
    /// The file may contain secrets (`db_password`, `jwt_secret`,
    /// `admin_password`); callers are responsible for restricting its
    /// permissions (see `crate::util::fs_secure`).
    pub fn save<P: AsRef<Path>>(&self, path: P) -> Result<()> {
        let content = toml::to_string_pretty(&ConfigFileRef { config: self })?;
        crate::util::fs_secure::write_secret(path, content)?;
        Ok(())
    }

    /// Fill the paths left unset with the instance's and expand every `$HOME`
    /// placeholder. Called once during initialization, so the rest of the
    /// program sees concrete paths.
    pub fn with_resolved_paths(mut self, instance: &Instance) -> Result<Self> {
        self.db.resolve_paths(instance)?;
        self.tls.resolve_paths(instance)?;
        self.log.resolve_paths()?;
        self.web.resolve_paths()?;
        self.proxy.resolve_paths(instance)?;
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
        if self
            .auth
            .admin_password
            .as_ref()
            .is_some_and(Secret::is_empty)
        {
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

/// Config subset for commands that only need the certificate directory
/// (`ca`, `proxy`, `openapi`); the instance's root comes from `--instance`.
#[derive(Conf, Clone, Debug, Default)]
#[conf(serde(allow_unknown_fields))]
pub struct TlsScopedConfig {
    #[arg(flatten)]
    pub tls: TlsConfig,
}

impl TlsScopedConfig {
    pub fn with_resolved_paths(mut self, instance: &Instance) -> Result<Self> {
        self.tls.resolve_paths(instance)?;
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
    pub fn with_resolved_paths(mut self, instance: &Instance) -> Result<Self> {
        self.tls.resolve_paths(instance)?;
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

    /// An icanhaz broker (`ws://127.0.0.1:7777`, the tray app) that decides
    /// which of the capabilities a plugin wants it gets (see
    /// `PluginConfig::icanhaz`). Unset: everything as proposed.
    #[arg(long = "plugins-icanhaz", env = "PLUGINS_ICANHAZ")]
    pub icanhaz: Option<String>,
}

impl PluginScopedConfig {
    pub fn with_resolved_paths(mut self, instance: &Instance) -> Result<Self> {
        self.db.resolve_paths(instance)?;
        self.tls.resolve_paths(instance)?;
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

    // ----- instances -----

    #[test]
    fn instance_names_that_match_the_rule_are_accepted() {
        for name in [
            "a",
            "0",
            "agent-1",
            "agent_1",
            "agent.1",
            "a-b.c_d",
            "x".repeat(63).as_str(),
        ] {
            let instance = Instance::named(name).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(instance.name(), Some(name));
            assert!(!instance.is_default());
            assert_eq!(instance.to_string(), name);
            assert_eq!(name.parse::<Instance>().unwrap(), instance);
        }
    }

    #[test]
    fn instance_names_that_break_the_rule_are_refused_with_the_rule() {
        for name in [
            "",
            "Agent",
            "-agent",
            ".agent",
            "_agent",
            "agent 1",
            "agent/1",
            "agent@1",
            "ägent",
            "x".repeat(64).as_str(),
        ] {
            let err = Instance::named(name).expect_err(name);
            let msg = err.to_string();
            assert!(msg.contains(&format!("{name:?}")), "{msg}");
            assert!(msg.contains(Instance::NAME_RULE), "{msg}");
            assert!(name.parse::<Instance>().is_err());
        }
    }

    /// `default` is how the default instance is spelled, not a name a
    /// second instance can take.
    #[test]
    fn default_is_the_default_instance_not_a_name() {
        let instance = Instance::named("default").unwrap();
        assert!(instance.is_default());
        assert_eq!(instance, Instance::default());
        assert_eq!(instance.to_string(), "default");
        assert_eq!(Instance::default().name(), None);
    }

    /// The default instance's layout is byte-for-byte what every install had
    /// before instances existed, so nothing moves under an existing daemon.
    #[cfg(target_os = "linux")]
    #[test]
    fn default_instance_layout_is_the_historical_one_on_linux() {
        let d = Instance::default();
        assert_eq!(d.root(), PathBuf::from("/var/lib/witmproxy"));
        assert_eq!(
            d.config_file(),
            PathBuf::from("/var/lib/witmproxy/config.toml")
        );
        assert_eq!(
            d.db_file(),
            PathBuf::from("/var/lib/witmproxy/witmproxy.db")
        );
        assert_eq!(d.cert_dir(), PathBuf::from("/var/lib/witmproxy/certs"));
        assert_eq!(
            d.services_file(),
            PathBuf::from("/var/lib/witmproxy/services.json")
        );
        assert_eq!(d.log_dir(), PathBuf::from("/var/lib/witmproxy"));
        assert_eq!(
            d.log_file(),
            PathBuf::from("/var/lib/witmproxy/witmproxy.log")
        );
        assert_eq!(d.keychain_app(), "witmproxy");
        assert_eq!(d.unit_name(), "ez-witmproxy");
        assert_eq!(d.service_file_name(), "ez-witmproxy.service");
        assert_eq!(d.service_label(), "co.ez.witmproxy");
        assert_eq!(d.launchd_label(), "co.ez.witmproxy");
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        assert_eq!(d.auth_file(), home.join(".witmproxy/auth.json"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn named_instance_layout_on_linux() {
        let i = Instance::named("agent-1").unwrap();
        let root = PathBuf::from("/var/lib/witmproxy/instances/agent-1");
        assert_eq!(
            Instance::instances_dir_for(Scope::System),
            PathBuf::from("/var/lib/witmproxy/instances")
        );
        assert_eq!(i.root(), root);
        assert_eq!(i.config_file(), root.join("config.toml"));
        assert_eq!(i.db_file(), root.join("witmproxy.db"));
        assert_eq!(i.cert_dir(), root.join("certs"));
        assert_eq!(i.services_file(), root.join("services.json"));
        assert_eq!(i.log_dir(), root);
        assert_eq!(i.log_file(), root.join("witmproxy.log"));
        assert_eq!(i.keychain_app(), "witmproxy@agent-1");
        assert_eq!(i.unit_name(), "ez-witmproxy@agent-1");
        assert_eq!(i.service_file_name(), "ez-witmproxy@agent-1.service");
        assert_eq!(i.service_label(), "co.ez.witmproxy@agent-1");
        assert_eq!(i.launchd_label(), "co.ez.witmproxy.agent-1");
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        assert_eq!(
            i.auth_file(),
            home.join(".witmproxy/instances/agent-1/auth.json")
        );
    }

    /// A user's witmproxy on Linux lives in that user's state directory, its
    /// login beside it, and nothing it names coincides with the host's.
    #[cfg(target_os = "linux")]
    #[test]
    fn user_scope_layout_on_linux() {
        let state = std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".local/state")
            })
            .join("witmproxy");
        let d = Instance::user();
        assert!(d.is_default() && d.is_user());
        assert_eq!(d.root(), state);
        assert_eq!(d.config_file(), state.join("config.toml"));
        assert_eq!(d.auth_file(), state.join("auth.json"));
        assert_eq!(d.unit_name(), "ez-witmproxy");
        assert_eq!(d.scope_flag(), " --user");
        assert_eq!(Instance::default().scope_flag(), "");

        let i = Instance::named("agent-1").unwrap().with_scope(Scope::User);
        let root = state.join("instances/agent-1");
        assert_eq!(
            Instance::instances_dir_for(Scope::User),
            state.join("instances")
        );
        assert_eq!(i.root(), root);
        assert_eq!(i.auth_file(), root.join("auth.json"));
        assert_eq!(i.unit_name(), "ez-witmproxy@agent-1");
        assert_ne!(i, Instance::named("agent-1").unwrap());
        assert_ne!(i.root(), Instance::named("agent-1").unwrap().root());
        assert_ne!(
            i.auth_file(),
            Instance::named("agent-1").unwrap().auth_file()
        );
    }

    #[test]
    fn a_scope_is_part_of_the_name_an_invocation_means() {
        assert_eq!(
            Instance::named("default").unwrap().scope(),
            Scope::default()
        );
        assert!(Instance::user().is_user());
        assert!(
            Instance::named("a")
                .unwrap()
                .with_scope(Scope::User)
                .is_user()
        );
        assert_eq!(
            Instance::user().with_scope(Scope::default()),
            Instance::default()
        );
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn instance_layout_off_linux_lives_under_the_home_directory() {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let base = home.join(".witmproxy");
        let d = Instance::default();
        assert_eq!(d.root(), base);
        assert_eq!(d.config_file(), base.join("config.toml"));
        assert_eq!(d.db_file(), base.join("db.sqlite"));
        assert_eq!(d.cert_dir(), base.join("certs"));
        assert_eq!(d.auth_file(), base.join("auth.json"));
        assert_eq!(d.launchd_label(), "co.ez.witmproxy");
        assert_eq!(d.service_label(), "co.ez.witmproxy");

        let i = Instance::named("agent-1").unwrap();
        let root = base.join("instances").join("agent-1");
        assert_eq!(i.root(), root);
        assert_eq!(i.db_file(), root.join("db.sqlite"));
        assert_eq!(i.cert_dir(), root.join("certs"));
        assert_eq!(i.auth_file(), root.join("auth.json"));
        assert_eq!(i.launchd_label(), "co.ez.witmproxy.agent-1");
        assert_eq!(i.service_label(), "co.ez.witmproxy.agent-1");
        #[cfg(target_os = "macos")]
        assert_eq!(i.service_file_name(), "co.ez.witmproxy.agent-1.plist");
    }

    /// A dotted name stays one unit: the service-manager label still derives
    /// this platform's service name for it.
    #[test]
    fn dotted_instance_names_keep_their_unit_and_label() {
        let i = Instance::named("agent.1").unwrap();
        assert_eq!(i.unit_name(), "ez-witmproxy@agent.1");
        assert_eq!(i.launchd_label(), "co.ez.witmproxy.agent.1");
        assert_eq!(i.root().file_name().unwrap(), "agent.1");
    }

    /// Unset paths resolve to the instance's; set ones are left alone (with
    /// `$HOME` expanded). This is what keeps `--instance` and an explicit
    /// `--db-path`/`--cert-dir` composable.
    #[test]
    fn unset_paths_resolve_to_the_instances() {
        let i = Instance::named("agent-1").unwrap();
        let resolved = AppConfig::default().with_resolved_paths(&i).unwrap();
        assert_eq!(resolved.db.db_path, i.db_file());
        assert_eq!(resolved.tls.cert_dir, i.cert_dir());
        assert_eq!(resolved.log.log_dir, None, "log_dir stays unset until used");

        let mut explicit = AppConfig::default();
        explicit.db.db_path = PathBuf::from("/elsewhere/db");
        explicit.tls.cert_dir = PathBuf::from("$HOME/certs");
        let resolved = explicit.with_resolved_paths(&i).unwrap();
        assert_eq!(resolved.db.db_path, PathBuf::from("/elsewhere/db"));
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        assert_eq!(resolved.tls.cert_dir, home.join("certs"));

        let scoped = TlsScopedConfig::default().with_resolved_paths(&i).unwrap();
        assert_eq!(scoped.tls.cert_dir, i.cert_dir());
        let scoped = PluginScopedConfig::default()
            .with_resolved_paths(&i)
            .unwrap();
        assert_eq!(scoped.db.db_path, i.db_file());
        let scoped = ServiceScopedConfig::default()
            .with_resolved_paths(&i)
            .unwrap();
        assert_eq!(scoped.tls.cert_dir, i.cert_dir());
    }

    /// Parsed without `--db-path`/`--cert-dir`, the config carries the unset
    /// sentinel, so whichever instance the command names decides the paths —
    /// and the default instance decides today's.
    #[test]
    fn parsed_defaults_follow_the_instance() {
        let parsed = AppConfig::try_parse_from::<&str, &str, &str>(vec!["witm"], vec![]).unwrap();
        assert!(parsed.db.db_path.as_os_str().is_empty());
        assert!(parsed.tls.cert_dir.as_os_str().is_empty());

        let as_default = parsed
            .clone()
            .with_resolved_paths(&Instance::default())
            .unwrap();
        assert_eq!(as_default.db.db_path, Instance::default().db_file());
        assert_eq!(as_default.tls.cert_dir, Instance::default().cert_dir());
        #[cfg(target_os = "linux")]
        {
            assert_eq!(
                as_default.db.db_path,
                PathBuf::from("/var/lib/witmproxy/witmproxy.db")
            );
            assert_eq!(
                as_default.tls.cert_dir,
                PathBuf::from("/var/lib/witmproxy/certs")
            );
        }

        let named = Instance::named("agent-1").unwrap();
        let as_named = parsed.with_resolved_paths(&named).unwrap();
        assert_eq!(as_named.db.db_path, named.db_file());
        assert_eq!(as_named.tls.cert_dir, named.cert_dir());

        let explicit = AppConfig::try_parse_from::<&str, &str, &str>(
            vec!["witm", "--db-path", "/x/db", "--cert-dir", "/x/certs"],
            vec![],
        )
        .unwrap()
        .with_resolved_paths(&named)
        .unwrap();
        assert_eq!(explicit.db.db_path, PathBuf::from("/x/db"));
        assert_eq!(explicit.tls.cert_dir, PathBuf::from("/x/certs"));
    }

    /// `list` is the default instance plus the directories under
    /// `instances/`; a stray file or an invalid name there is not an instance.
    /// Exercised through `named` and `root` since the real directory is the
    /// host's.
    #[test]
    fn listing_starts_with_the_default_instance() {
        for scope in [Scope::System, Scope::User] {
            let listed = Instance::list(scope);
            assert_eq!(listed.first(), Some(&Instance::default().with_scope(scope)));
            assert!(listed.iter().skip(1).all(|i| !i.is_default()));
            assert!(listed.iter().all(|i| i.scope() == scope));
            assert!(
                listed
                    .iter()
                    .skip(1)
                    .all(|i| i.root().starts_with(Instance::instances_dir_for(scope)))
            );
        }
    }
}
