// `witm` is a user-facing CLI: printing results to stdout is the whole point
// here. The workspace-level `print_stdout`/`print_stderr` lints exist to keep
// diagnostics out of the daemon and proxy paths, where they must go to
// `tracing` instead, so the exemption is scoped to this module.
#![allow(clippy::print_stdout, clippy::print_stderr)]

use crate::{
    AppConfig, CertificateAuthority, WitmProxy,
    config::{
        LogConfig, ServiceScopedConfig, TelemetryConfig, TlsScopedConfig, UpdateConfig,
        UpdateScopedConfig, app_dir_for, expand_home_in_path,
    },
    db::Db,
    plugins::registry::PluginRegistry,
    proxy::tenant_resolver,
    wasm::Runtime,
};
use auth::AuthCommands;
use group::GroupCommands;
use plugin::PluginCommands;
use proxy::ProxyCommands;
use service::ServiceCommands;
use tenant::TenantCommands;
use trust::CaCommands;

use anyhow::Result;
use conf::{Conf, Subcommands};
use notify::{Event as NotifyEvent, RecommendedWatcher, RecursiveMode, Watcher, event::ModifyKind};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::sync::{RwLock, mpsc};
use tracing::{error, info, warn};

pub mod api_client;
pub mod auth;
pub mod group;
mod plugin;
pub mod template;
mod proxy;
pub mod service;
mod tailscale;
pub mod tenant;
mod trust;
pub mod update;

#[cfg(test)]
mod scoping_verify_tests;
#[cfg(test)]
mod tests;

/// witmproxy — a WASM-in-the-middle proxy.
///
/// Run `witm <command> --help` to see the options, environment variables, and
/// config-file keys relevant to that command.
//
// The root carries ONLY the subcommand list, so `witm --help` stays a bare
// subcommand list; each subcommand's args struct flattens the config subset
// it actually needs (see `Command`).
#[derive(Conf)]
#[conf(serde(allow_unknown_fields))]
#[conf(name = "witmproxy")]
pub struct Cli {
    #[arg(subcommands)]
    command: Command,
}

/// Flags shared by every subcommand. Flattened into each subcommand's args so
/// they appear in that subcommand's `--help` and are accepted after the
/// subcommand name (`witm status -v`), keeping `witm --help` a bare
/// subcommand list. `--config-path` is consumed at parse time (via
/// `conf::find_parameter`, which is position-agnostic) to locate the config
/// file.
#[derive(Conf, Clone, Debug, Default)]
#[conf(serde)]
pub struct GlobalArgs {
    /// Configuration file path
    #[cfg(target_os = "linux")]
    #[arg(
        long = "config-path",
        short = 'c',
        env = "WITM_CONFIG_PATH",
        default_value = "/var/lib/witmproxy/config.toml",
        serde(skip)
    )]
    #[allow(dead_code)]
    config_path: PathBuf,
    /// Configuration file path
    #[cfg(not(target_os = "linux"))]
    #[arg(
        long = "config-path",
        short = 'c',
        env = "WITM_CONFIG_PATH",
        default_value = "$HOME/.witmproxy/config.toml",
        serde(skip)
    )]
    // Only read at parse time (via `conf::find_parameter` over the raw argv,
    // before the structured parse); the field exists so the flag is declared,
    // documented, and accepted on every subcommand.
    #[allow(dead_code)]
    config_path: PathBuf,

    /// Enable verbose logging
    #[arg(long = "verbose", short = 'v', serde(skip))]
    verbose: bool,
}

/// Internal helper struct that holds the resolved configuration for the
/// proxy-running commands (`run`, `serve`, `start`).
pub struct ResolvedCli {
    pub(crate) config: AppConfig,
    verbose: bool,
    plugin_dir: Option<PathBuf>,
    auto: bool,
    detach: bool,
    /// Whether this runs attached to a real terminal (`run` foreground) rather
    /// than as the detached daemon (`serve`). Provisioning surfaces a generated
    /// admin password to stdout only when interactive.
    interactive: bool,
}

/// Root-level config-bearing variants are `#[conf(serde(rename = "config"))]`
/// so they read the `[config]` section of the config file directly. The
/// dispatcher variants (`service`, `plugin`, `ca`, `proxy`) carry no options
/// themselves — their LEAVES hold the config subset (each leaf variant is
/// renamed "config" and reads the mirror of `[config]` that
/// `mirror_config_for_nested_commands` places under the dispatcher's doc
/// key). `auth`/`tenant`/`group` leaves take no config at all.
#[derive(Subcommands)]
#[conf(serde)]
enum Command {
    /// Install/restart the daemon service and attach to logs.
    ///
    /// This is the recommended way to run witmproxy. It installs (or updates)
    /// the system service with the current configuration, restarts the daemon,
    /// and attaches to logs so you can see the proxy start up.
    #[conf(serde(rename = "config"))]
    Start(StartArgs),
    /// Stop the running witmproxy daemon service.
    #[conf(serde(rename = "config"))]
    Stop(ServiceCtlArgs),
    /// Run the proxy server directly in the foreground (no daemon).
    ///
    /// Starts the web and proxy servers in the current terminal. Press Ctrl+C to stop.
    #[conf(serde(rename = "config"))]
    Run(RunArgs),
    /// Run the proxy server in daemon mode (internal, called by the service manager).
    #[conf(serde(rename = "config"))]
    Serve(ServeArgs),
    /// Plugin management commands
    Plugin(PluginArgs),
    /// Certificate authority management commands
    Ca(CaArgs),
    /// System proxy management commands
    Proxy(ProxyArgs),
    /// Service management commands
    Service(ServiceArgs),
    /// Show the status of the witmproxy service (alias for `service status`)
    #[conf(serde(rename = "config"))]
    Status(ServiceCtlArgs),
    /// Show the daemon log file (alias for `service logs`)
    #[conf(serde(rename = "config"))]
    Logs(LogsArgs),
    /// Authentication commands (for remote management)
    #[conf(serde(skip))]
    Auth(AuthArgs),
    /// Tenant management commands (remote)
    #[conf(serde(skip))]
    Tenant(TenantArgs),
    /// Group management commands (remote)
    #[conf(serde(skip))]
    Group(GroupArgs),
    /// Check for updates and update the CLI binary
    #[conf(serde(rename = "config"))]
    Update(UpdateArgs),
    /// Print version and build information
    Version,
    /// Fetch and output the OpenAPI specification from a running server
    #[conf(serde(rename = "config"))]
    Openapi(OpenapiArgs),
}

/// Full config + plugin-dir/auto flags; shared shape for the proxy-running
/// commands (`start`, `run`, `serve`).
#[derive(Conf)]
#[conf(serde)]
pub struct StartArgs {
    #[conf(flatten)]
    globals: GlobalArgs,

    /// Application configuration. Every config option is also settable via its
    /// environment variable or the `[config]` section of the config file.
    #[conf(flatten, serde(flatten))]
    config: AppConfig,

    /// Directory to load plugins from, watched for changes
    #[arg(long = "plugin-dir")]
    plugin_dir: Option<PathBuf>,
    /// Automatically trust the proxy CA and configure system proxy settings on startup
    #[arg(long = "auto")]
    auto: bool,
    /// Detach from the daemon after starting, don't attach to logs
    #[arg(long = "detach", short = 'd')]
    detach: bool,
}

#[derive(Conf)]
#[conf(serde)]
pub struct RunArgs {
    #[conf(flatten)]
    globals: GlobalArgs,

    /// Application configuration. Every config option is also settable via its
    /// environment variable or the `[config]` section of the config file.
    #[conf(flatten, serde(flatten))]
    config: AppConfig,

    /// Directory to load plugins from, watched for changes
    #[arg(long = "plugin-dir")]
    plugin_dir: Option<PathBuf>,
    /// Automatically trust the proxy CA and configure system proxy settings on startup
    #[arg(long = "auto")]
    auto: bool,
}

#[derive(Conf)]
#[conf(serde)]
pub struct ServeArgs {
    #[conf(flatten)]
    globals: GlobalArgs,

    /// Application configuration. Every config option is also settable via its
    /// environment variable or the `[config]` section of the config file.
    #[conf(flatten, serde(flatten))]
    config: AppConfig,

    /// Directory to load plugins from, watched for changes
    #[arg(long = "plugin-dir")]
    plugin_dir: Option<PathBuf>,
    /// Automatically trust the proxy CA and configure system proxy settings on startup
    #[arg(long = "auto")]
    auto: bool,
    /// Log file path for daemon mode (its directory holds the rolling log files)
    #[arg(long = "log-file")]
    log_file: Option<PathBuf>,
}

/// Pure dispatcher: `witm plugin --help` lists only the subcommands. Each
/// leaf carries the shared flags plus the db+tls config scope.
#[derive(Conf)]
#[conf(serde)]
pub struct PluginArgs {
    #[arg(subcommands)]
    command: PluginCommands,
}

/// Pure dispatcher: `witm ca --help` lists only the subcommands. Each leaf
/// carries the shared flags plus the tls config scope.
#[derive(Conf)]
#[conf(serde)]
pub struct CaArgs {
    #[arg(subcommands)]
    command: CaCommands,
}

/// Pure dispatcher: `witm proxy --help` lists only the subcommands. Each
/// leaf carries the shared flags plus the tls config scope.
#[derive(Conf)]
#[conf(serde)]
pub struct ProxyArgs {
    #[arg(subcommands)]
    command: ProxyCommands,
}

/// Pure dispatcher: `witm service --help` lists only the subcommands.
/// `service install` carries the full config (it persists it for the
/// daemon); the other leaves carry the tls+log scope.
#[derive(Conf)]
#[conf(serde)]
pub struct ServiceArgs {
    #[arg(subcommands)]
    command: ServiceCommands,
}

/// Args for the service-control commands that never open the database
/// (top-level `stop` and `status`): just enough config to locate the app and
/// log directories.
#[derive(Conf)]
#[conf(serde(allow_unknown_fields))]
pub struct ServiceCtlArgs {
    #[conf(flatten)]
    globals: GlobalArgs,

    #[conf(flatten, serde(flatten))]
    config: ServiceScopedConfig,
}

#[derive(Conf)]
#[conf(serde(allow_unknown_fields))]
pub struct LogsArgs {
    #[conf(flatten)]
    globals: GlobalArgs,

    #[conf(flatten, serde(flatten))]
    config: ServiceScopedConfig,

    /// Follow the log output (like tail -f)
    #[arg(long = "follow", short = 'f')]
    follow: bool,
    /// Number of lines to show from the end
    #[arg(long = "lines", short = 'n', default_value = "50")]
    lines: usize,
}

#[derive(Conf)]
#[conf(serde)]
pub struct AuthArgs {
    #[arg(subcommands)]
    command: AuthCommands,
}

#[derive(Conf)]
#[conf(serde)]
pub struct TenantArgs {
    #[arg(subcommands)]
    command: TenantCommands,
}

#[derive(Conf)]
#[conf(serde)]
pub struct GroupArgs {
    #[arg(subcommands)]
    command: GroupCommands,
}

#[derive(Conf)]
#[conf(serde(allow_unknown_fields))]
pub struct UpdateArgs {
    #[conf(flatten)]
    globals: GlobalArgs,

    #[conf(flatten, serde(flatten))]
    config: UpdateScopedConfig,

    /// Force update even if already on the latest version
    #[arg(long = "force")]
    force: bool,
    /// Use cargo install instead of prebuilt binaries
    #[arg(long = "from-source")]
    from_source: bool,
}

#[derive(Conf)]
#[conf(serde(allow_unknown_fields))]
pub struct OpenapiArgs {
    #[conf(flatten)]
    globals: GlobalArgs,

    /// Used to locate services.json when --server isn't given.
    #[conf(flatten, serde(flatten))]
    config: TlsScopedConfig,

    /// URL of a running witmproxy server (reads from services.json if not specified)
    #[arg(long = "server")]
    server: Option<String>,
    /// Output file path (prints to stdout if not specified)
    #[arg(long = "output", short = 'o')]
    output: Option<PathBuf>,
}

impl ServiceCtlArgs {
    /// Build the partial [`AppConfig`] the [`service::ServiceHandler`] wants
    /// from this command's scoped sections (everything else stays default —
    /// these commands never touch the DB, web server, etc.).
    fn service_config(&self) -> Result<AppConfig> {
        AppConfig {
            tls: self.config.tls.clone(),
            log: self.config.log.clone(),
            ..Default::default()
        }
        .with_resolved_paths()
    }
}

impl Command {
    /// The telemetry/log settings visible to this subcommand, plus its
    /// `--verbose` flag. Commands whose config scope carries the sections use
    /// the parsed (CLI > env > file > default) values; the rest fall back to
    /// the defaults (log level "info", OTel off).
    fn telemetry_settings(&self) -> (TelemetryConfig, LogConfig, bool) {
        match self {
            Command::Start(a) => (
                a.config.telemetry.clone(),
                a.config.log.clone(),
                a.globals.verbose,
            ),
            Command::Run(a) => (
                a.config.telemetry.clone(),
                a.config.log.clone(),
                a.globals.verbose,
            ),
            Command::Serve(a) => (
                a.config.telemetry.clone(),
                a.config.log.clone(),
                a.globals.verbose,
            ),
            Command::Service(a) => a.command.telemetry_settings(),
            Command::Stop(a) | Command::Status(a) => (
                TelemetryConfig::default(),
                a.config.log.clone(),
                a.globals.verbose,
            ),
            Command::Logs(a) => (
                TelemetryConfig::default(),
                a.config.log.clone(),
                a.globals.verbose,
            ),
            Command::Plugin(a) => (
                Default::default(),
                Default::default(),
                a.command.scope().1.verbose,
            ),
            Command::Ca(a) => (
                Default::default(),
                Default::default(),
                a.command.scope().1.verbose,
            ),
            Command::Proxy(a) => (
                Default::default(),
                Default::default(),
                a.command.scope().1.verbose,
            ),
            Command::Auth(a) => (
                Default::default(),
                Default::default(),
                a.command.globals().verbose,
            ),
            Command::Tenant(a) => (
                Default::default(),
                Default::default(),
                a.command.globals().verbose,
            ),
            Command::Group(a) => (
                Default::default(),
                Default::default(),
                a.command.globals().verbose,
            ),
            Command::Update(a) => (Default::default(), Default::default(), a.globals.verbose),
            Command::Openapi(a) => (Default::default(), Default::default(), a.globals.verbose),
            Command::Version => (Default::default(), Default::default(), false),
        }
    }
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Services {
    pub proxy: String,
    pub web: String,
}

type UpdateCheckHandle = tokio::task::JoinHandle<
    Result<Result<Option<semver::Version>, anyhow::Error>, tokio::time::error::Elapsed>,
>;

/// `conf` scopes a nested subcommand's doc under its parent's key, so the
/// leaves of the dispatcher commands (`service install`, `plugin add`, …)
/// read `doc[<parent>]["config"]` rather than the top-level `[config]`.
/// Mirror the file's `[config]` table at each of those paths so every leaf
/// sees the same section the root-level commands read.
fn mirror_config_for_nested_commands(mut doc: toml::Value) -> toml::Value {
    const DISPATCHER_COMMANDS: &[&str] = &["service", "plugin", "ca", "proxy"];
    let Some(config) = doc.get("config").cloned() else {
        return doc;
    };
    if let Some(root) = doc.as_table_mut() {
        for parent in DISPATCHER_COMMANDS {
            let entry = root
                .entry((*parent).to_string())
                .or_insert_with(|| toml::Value::Table(toml::value::Table::new()));
            if let Some(table) = entry.as_table_mut() {
                table.insert("config".to_string(), config.clone());
            }
        }
    }
    doc
}

/// Generate a random secret (32 bytes of OS entropy, hex-encoded) — used for
/// the first-startup database password and JWT signing secret.
fn generate_secret() -> crate::config::Secret {
    use argon2::password_hash::rand_core::{OsRng, RngCore};
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    crate::config::Secret::from(hex::encode(bytes))
}

/// The outcome of [`provision`]: an open, migrated database, the effective
/// config (with any generated secrets filled in), and — when a default admin
/// account was just created with a *generated* password — that password, for
/// an interactive caller to print.
pub(crate) struct Provisioned {
    pub(crate) db: Db,
    pub(crate) effective_config: AppConfig,
    pub(crate) generated_admin_password: Option<crate::config::Secret>,
}

/// Ensure everything the proxy needs before serving exists: the database key
/// (generated + persisted on first run), the migrated schema, the JWT signing
/// secret, and the default admin account. Generates and persists whatever is
/// missing to `cfg_path`.
///
/// `create_admin` distinguishes the interactive callers (`witm run`,
/// `witm service install`, which have a real stdout) from the background daemon
/// (`witm serve`, whose stdout is discarded). When true, a missing admin
/// account is created and any generated password is returned so the caller can
/// show it. When false, a missing admin is reported via a warning instead of
/// being created with a password nobody could ever see — the daemon relies on
/// `service install` having already provisioned it.
pub(crate) async fn provision(
    config: &AppConfig,
    cfg_path: &std::path::Path,
    create_admin: bool,
) -> Result<Provisioned> {
    use crate::db::tenants::{Group, Tenant};
    use crate::web::auth::hash_password;

    if let Some(parent) = config.db.db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut effective_config = config.clone();

    // Database password: explicit value > prompt (bare flag) > generated on
    // first startup (no password AND no database yet), persisted like the JWT
    // secret. An unpersisted generated key would orphan the new database, so a
    // save failure here is fatal.
    let db_password = match &effective_config.db.db_password {
        Some(secret) if !secret.is_empty() => secret.clone(),
        Some(_) => crate::util::secret::prompt("Database password")?,
        None if !effective_config.db.db_path.exists() => {
            let secret = generate_secret();
            effective_config.db.db_password = Some(secret.clone());
            effective_config.save(cfg_path).map_err(|e| {
                anyhow::anyhow!(
                    "generated a database password but could not persist it to {:?}: {}.\n  \
                     Refusing to create a database whose key would be lost.",
                    cfg_path,
                    e
                )
            })?;
            info!(
                "Generated a database password and persisted it to {:?}",
                cfg_path
            );
            secret
        }
        None => {
            return Err(anyhow::anyhow!(
                "the database at {} exists but no password was provided.\n  \
                 Set the DB_PASSWORD environment variable, pass --db-password <value>,\n  \
                 or pass a bare --db-password to be prompted.",
                effective_config.db.db_path.display()
            ));
        }
    };

    let db = Db::from_path(effective_config.db.db_path.clone(), db_password.expose()).await?;
    drop(db_password);
    db.migrate().await?;
    info!(
        "Database initialized and migrated at: {}",
        effective_config.db.db_path.display()
    );

    // JWT signing secret: generate + persist if missing, so tokens are never
    // signed with a well-known default and the secret is stable across restarts.
    if effective_config.auth.enabled && effective_config.auth.jwt_secret_missing() {
        effective_config.auth.jwt_secret = Some(generate_secret());
        match effective_config.save(cfg_path) {
            Ok(()) => info!("Generated and persisted a JWT signing secret"),
            Err(e) => warn!(
                "Generated a JWT signing secret but failed to persist it to {:?}: {}",
                cfg_path, e
            ),
        }
    }

    // Default admin account.
    let mut generated_admin_password = None;
    if effective_config.auth.enabled {
        let admin_email = effective_config.auth.admin_email.clone();
        match Tenant::by_email(&db.pool, &admin_email).await {
            Ok(Some(_)) => info!("Admin account already exists: {}", admin_email),
            Ok(None) if !create_admin => {
                // The daemon has no terminal to show a generated password on, so
                // it must not silently create an unknowable admin account.
                warn!(
                    "No admin account exists for {admin_email}. Run `witm service install` \
                     (or `witm run`), or set AUTH_ADMIN_PASSWORD, to create one."
                );
            }
            Ok(None) => {
                let was_generated = effective_config.auth.admin_password_missing();
                let password = if was_generated {
                    use argon2::password_hash::rand_core::{OsRng, RngCore};
                    let mut bytes = [0u8; 18];
                    OsRng.fill_bytes(&mut bytes);
                    crate::config::Secret::from(hex::encode(bytes)[..24].to_string())
                } else {
                    match effective_config.auth.admin_password.clone() {
                        Some(password) => password,
                        // Unreachable while `admin_password_missing()` and this
                        // field agree, but that is two calls having to stay in
                        // step rather than one thing being true.
                        None => anyhow::bail!(
                            "admin password reported as present but is not set"
                        ),
                    }
                };

                let password_hash = hash_password(password.expose())
                    .map_err(|e| anyhow::anyhow!("Failed to hash admin password: {}", e))?;

                let tenant_id = uuid::Uuid::new_v4().to_string();
                Tenant::create(
                    &db.pool,
                    &tenant_id,
                    "Admin",
                    Some(&admin_email),
                    Some(&password_hash),
                    None,
                    None,
                )
                .await?;

                let group_id = uuid::Uuid::new_v4().to_string();
                let perm_id = uuid::Uuid::new_v4().to_string();
                Group::create(&db.pool, &group_id, "admins", "Full administrative access").await?;
                Group::add_permission(&db.pool, &perm_id, &group_id, "grant", "*:*:*").await?;
                Group::add_member(&db.pool, &group_id, &tenant_id).await?;
                info!("Admin group created with full access");
                info!("Default admin account created: {}", admin_email);

                if was_generated {
                    generated_admin_password = Some(password);
                }
            }
            Err(e) => warn!("Failed to check for admin account: {}", e),
        }
    }

    Ok(Provisioned {
        db,
        effective_config,
        generated_admin_password,
    })
}

/// Print a freshly generated default admin password to stdout. Only called
/// from interactive contexts (foreground `witm run`, `witm service install`,
/// and therefore `witm start`) where stdout reaches the user.
pub(crate) fn print_admin_credentials(email: &str, password: &crate::config::Secret) {
    println!("\n╔══════════════════════════════════════════╗");
    println!("║  Default admin account created           ║");
    println!("║  Email: {email:<36} ║");
    println!("║  Password: {password:<33?} ║");
    println!("║                                          ║");
    println!("║  Save this password - it won't be        ║");
    println!("║  shown again.                            ║");
    println!("╚══════════════════════════════════════════╝\n");
}

/// The default config file path for this platform.
fn default_config_path() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        PathBuf::from("/var/lib/witmproxy/config.toml")
    }
    #[cfg(not(target_os = "linux"))]
    {
        crate::config::system_app_dir().join("config.toml")
    }
}

impl Cli {
    /// Parse the CLI, layering in the config file located via `--config-path` /
    /// `WITM_CONFIG_PATH`. The file must be located before the main parse so it
    /// can be supplied as a value source (CLI > env > file > defaults).
    pub fn parse_args() -> Self {
        let config_path = conf::find_parameter("config-path", std::env::args_os())
            .or_else(|| std::env::var_os("WITM_CONFIG_PATH"))
            .map(PathBuf::from)
            .unwrap_or_else(default_config_path);
        let resolved = expand_home_in_path(&config_path).unwrap_or(config_path);

        // Load the config file as a value source when present. A missing file is
        // fine (args + env + defaults); a malformed file falls back the same way
        // rather than aborting commands that don't need it.
        match std::fs::read_to_string(&resolved) {
            Ok(contents) => match toml::from_str::<toml::Value>(&contents) {
                Ok(doc) => Cli::conf_builder()
                    .doc(
                        resolved.to_string_lossy().into_owned(),
                        mirror_config_for_nested_commands(doc),
                    )
                    .parse(),
                Err(e) => {
                    eprintln!("warning: ignoring malformed config file {resolved:?}: {e}");
                    Cli::parse()
                }
            },
            Err(_) => Cli::parse(),
        }
    }

    pub async fn run(self) -> Result<()> {
        let Cli { command } = self;

        // Initialize telemetry/logging for interactive commands from whatever
        // telemetry/log settings the active subcommand's config scope carries.
        // The daemon (`serve`) sets up its own rolling-file logging in
        // `run_serve`.
        let _telemetry_guard = if !matches!(command, Command::Serve(_)) {
            let (telemetry, mut log_config, verbose) = command.telemetry_settings();
            if verbose {
                log_config.log_level = "debug".to_string();
            }
            Some(crate::util::telemetry::otel::init_telemetry(
                &telemetry,
                &log_config,
                None,
            ))
        } else {
            None
        };

        match command {
            Command::Start(args) => {
                let config = args
                    .config
                    .with_resolved_paths()?
                    .resolve_secret_prompts()?;
                let resolved = ResolvedCli::from_run_args(
                    config,
                    args.globals.verbose,
                    args.plugin_dir,
                    args.auto,
                    args.detach,
                    true,
                )?;
                let update = resolved.config.update.clone();
                Self::with_update_check(&update, resolved.run_start()).await
            }
            Command::Stop(args) => {
                let handler = service::ServiceHandler::new(
                    args.service_config()?,
                    args.globals.verbose,
                    None,
                    false,
                );
                Self::with_update_check(&UpdateConfig::default(), handler.stop_service()).await
            }
            Command::Run(args) => {
                let config = args
                    .config
                    .with_resolved_paths()?
                    .resolve_secret_prompts()?;
                let resolved = ResolvedCli::from_run_args(
                    config,
                    args.globals.verbose,
                    args.plugin_dir,
                    args.auto,
                    false,
                    true,
                )?;
                let update = resolved.config.update.clone();
                Self::with_update_check(&update, resolved.run_foreground()).await
            }
            Command::Serve(args) => {
                let config = args.config.with_resolved_paths()?;
                let resolved = ResolvedCli::from_run_args(
                    config,
                    args.globals.verbose,
                    args.plugin_dir,
                    args.auto,
                    false,
                    false,
                )?;
                resolved.run_serve(args.log_file).await
            }
            Command::Service(args) => match args.command {
                ServiceCommands::Install(install) => {
                    let verbose = install.globals.verbose;
                    let config = install
                        .config
                        .with_resolved_paths()?
                        .resolve_secret_prompts()?;
                    let plugin_dir = install
                        .plugin_dir
                        .as_ref()
                        .map(|d| expand_home_in_path(d))
                        .transpose()?;
                    let handler = service::ServiceHandler::new(
                        config.clone(),
                        verbose,
                        plugin_dir,
                        install.auto,
                    );
                    Self::with_update_check(&config.update, handler.install_service(install.yes))
                        .await
                }
                other => {
                    let verbose = other.globals().verbose;
                    let scoped = other.ctl_config().with_resolved_paths()?;
                    let config = AppConfig {
                        tls: scoped.tls,
                        log: scoped.log,
                        ..Default::default()
                    };
                    let handler = service::ServiceHandler::new(config, verbose, None, false);
                    Self::with_update_check(&UpdateConfig::default(), handler.handle(&other)).await
                }
            },
            Command::Status(args) => {
                let handler = service::ServiceHandler::new(
                    args.service_config()?,
                    args.globals.verbose,
                    None,
                    false,
                );
                Self::with_update_check(&UpdateConfig::default(), handler.show_status()).await
            }
            Command::Logs(args) => {
                let config = AppConfig {
                    tls: args.config.tls.clone(),
                    log: args.config.log.clone(),
                    ..Default::default()
                }
                .with_resolved_paths()?;
                let handler =
                    service::ServiceHandler::new(config, args.globals.verbose, None, false);
                Self::with_update_check(
                    &UpdateConfig::default(),
                    handler.show_logs(args.follow, args.lines),
                )
                .await
            }
            Command::Plugin(args) => {
                let (scoped, globals) = args.command.scope();
                let config = scoped.clone().with_resolved_paths()?;
                let handler = plugin::PluginHandler::new(config, globals.verbose);
                Self::with_update_check(&UpdateConfig::default(), handler.handle(&args.command))
                    .await
            }
            Command::Ca(args) => {
                let (scoped, _) = args.command.scope();
                let config = scoped.clone().with_resolved_paths()?;
                let handler = trust::CaHandler::new(config.tls);
                Self::with_update_check(&UpdateConfig::default(), handler.handle(&args.command))
                    .await
            }
            Command::Proxy(args) => {
                let (scoped, _) = args.command.scope();
                let config = scoped.clone().with_resolved_paths()?;
                let handler = proxy::ProxyHandler::new(config.tls);
                Self::with_update_check(&UpdateConfig::default(), handler.handle(&args.command))
                    .await
            }
            Command::Auth(args) => {
                let handler = auth::AuthHandler;
                Self::with_update_check(&UpdateConfig::default(), handler.handle(&args.command))
                    .await
            }
            Command::Tenant(args) => {
                let handler = tenant::TenantHandler;
                Self::with_update_check(&UpdateConfig::default(), handler.handle(&args.command))
                    .await
            }
            Command::Group(args) => {
                let handler = group::GroupHandler;
                Self::with_update_check(&UpdateConfig::default(), handler.handle(&args.command))
                    .await
            }
            Command::Update(args) => {
                let handler = update::UpdateHandler::new(args.config.update);
                handler.handle(args.force, args.from_source).await
            }
            Command::Version => {
                Self::print_version();
                Ok(())
            }
            Command::Openapi(args) => {
                let OpenapiArgs {
                    globals: _,
                    config,
                    server,
                    output,
                } = args;
                let url = if let Some(s) = server {
                    s
                } else {
                    // Try to read from services.json
                    let tls = config.with_resolved_paths()?.tls;
                    let services_path = app_dir_for(&tls.cert_dir).join("services.json");
                    let services: Services = serde_json::from_str(
                        &std::fs::read_to_string(&services_path)
                            .map_err(|e| anyhow::anyhow!(
                                "No --server specified and could not read services.json at {:?} ({e}). Is witmproxy running?",
                                services_path
                            ))?,
                    )?;
                    format!("https://{}", services.web)
                };

                // Fetch the OpenAPI spec, accepting self-signed certs
                let client = reqwest::Client::builder()
                    .danger_accept_invalid_certs(true)
                    .build()?;
                let spec = client
                    .get(format!(
                        "{}/api/docs/openapi.json",
                        url.trim_end_matches('/')
                    ))
                    .send()
                    .await?
                    .error_for_status()?
                    .text()
                    .await?;

                // Pretty-print the JSON
                let parsed: serde_json::Value = serde_json::from_str(&spec)?;
                let pretty = serde_json::to_string_pretty(&parsed)?;

                if let Some(output_path) = output {
                    if let Some(parent) = output_path.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::fs::write(&output_path, &pretty)?;
                    eprintln!("OpenAPI spec written to: {:?}", output_path);
                } else {
                    println!("{}", pretty);
                }

                Ok(())
            }
        }
    }

    fn print_version() {
        println!("witmproxy {}", env!("CARGO_PKG_VERSION"));
        if let Some(commit) = option_env!("GIT_COMMIT_HASH") {
            println!("commit:  {}", commit);
        }
        println!(
            "target:  {}-{}",
            std::env::consts::ARCH,
            std::env::consts::OS
        );
        if let Some(ts) = option_env!("BUILD_TIMESTAMP") {
            println!("built:   {}", ts);
        }
    }

    /// Run `f`, wrapping it with the background "new version available" check.
    /// Deduplicates the check/handler/warning dance across every subcommand.
    /// Commands whose config scope doesn't include the `[config.update]`
    /// section pass `UpdateConfig::default()` (warning enabled).
    async fn with_update_check(
        update: &UpdateConfig,
        f: impl std::future::Future<Output = Result<()>>,
    ) -> Result<()> {
        let check = Self::maybe_spawn_update_check(update);
        let result = f.await;
        Self::show_update_warning(check).await;
        result
    }

    /// Spawn a background update check if enabled
    fn maybe_spawn_update_check(update: &UpdateConfig) -> Option<UpdateCheckHandle> {
        if update.cli_update_warning {
            Some(tokio::spawn(async {
                tokio::time::timeout(
                    tokio::time::Duration::from_secs(2),
                    update::check_for_update_cached(false),
                )
                .await
            }))
        } else {
            None
        }
    }

    /// Show update warning if a newer version is available
    async fn show_update_warning(handle: Option<UpdateCheckHandle>) {
        if let Some(handle) = handle
            && let Ok(Ok(Ok(Some(latest)))) = handle.await
        {
            eprintln!(
                "\nA new version of witm is available: {} -> {}\nRun 'witm update' to install it.",
                update::current_version(),
                latest
            );
        }
    }
}

impl ResolvedCli {
    fn from_run_args(
        config: AppConfig,
        verbose: bool,
        plugin_dir: Option<PathBuf>,
        auto: bool,
        detach: bool,
        interactive: bool,
    ) -> Result<Self> {
        let plugin_dir = plugin_dir.map(|d| expand_home_in_path(&d)).transpose()?;
        Ok(ResolvedCli {
            config,
            verbose,
            plugin_dir,
            auto,
            detach,
            interactive,
        })
    }

    /// Install/restart the daemon service and optionally attach to logs
    async fn run_start(&self) -> Result<()> {
        let service_handler = service::ServiceHandler::new(
            self.config.clone(),
            self.verbose,
            self.plugin_dir.clone(),
            self.auto,
        );
        // Always (re)install the service to ensure the service file reflects
        // the current CLI arguments (e.g. --plugin-dir, --verbose, --auto)
        service_handler.install_service(true).await?;

        // Restart the service so it picks up the latest service file,
        // configuration, and any plugins added since the last start
        info!("Starting witmproxy service...");
        service_handler.restart_service().await?;

        // Wait a moment for the service to start
        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

        // Check status
        service_handler.show_status().await?;

        // Unless --detach is specified, attach to the service logs
        if !self.detach {
            println!();
            service_handler.attach_to_logs().await?;
        } else {
            println!();
            println!("Service started in background. Use 'witm service logs -f' to view logs.");
        }

        Ok(())
    }

    /// Run the proxy server directly in the foreground (no daemon)
    ///
    /// This starts both the web and proxy servers directly in the current process.
    /// Logs are output to stdout. Press Ctrl+C to stop.
    /// Useful for development, debugging, or when daemon overhead is not desired.
    async fn run_foreground(&self) -> Result<()> {
        info!("Starting witmproxy in foreground mode (no daemon)");
        println!("Starting witmproxy in foreground mode...");
        println!("Press Ctrl+C to stop the proxy.\n");

        // Run the proxy directly - tracing is already initialized by Cli::run()
        match self.run_proxy_internal().await {
            Ok(()) => {
                info!("witmproxy stopped gracefully");
                Ok(())
            }
            Err(e) => {
                error!("witmproxy failed with error: {:#}", e);
                Err(e)
            }
        }
    }

    /// Run the proxy server directly (daemon mode)
    /// This method is called by the daemon service and writes logs to a file
    async fn run_serve(&self, log_file: Option<PathBuf>) -> Result<()> {
        let mut log_config = self.config.log.clone();
        // --verbose flag overrides configured log level
        if self.verbose {
            log_config.log_level = "debug".to_string();
        }

        // Determine the log directory for rolling files.
        // If --log-file was passed (legacy), use its parent directory.
        // Otherwise fall back to the configured log_dir or the app directory.
        let log_dir = if let Some(ref log_path) = log_file {
            log_path.parent().map(|p| p.to_path_buf())
        } else {
            log_config
                .log_dir
                .clone()
                .or_else(|| self.config.tls.cert_dir.parent().map(|p| p.to_path_buf()))
        };

        if let Some(ref dir) = log_dir {
            std::fs::create_dir_all(dir)?;
        }

        let _telemetry_guard = crate::util::telemetry::otel::init_telemetry(
            &self.config.telemetry,
            &log_config,
            log_dir.as_deref(),
        );

        if let Some(ref dir) = log_dir {
            info!("witmproxy daemon starting, logging to {:?}", dir);
        }

        // Now run the proxy (same as run_proxy but without log initialization)
        // Wrap in catch to log any errors before the process exits
        match self.run_proxy_internal().await {
            Ok(()) => Ok(()),
            Err(e) => {
                error!("Daemon failed with error: {:#}", e);
                Err(e)
            }
        }
    }

    /// Internal proxy run method (used by both run_proxy and run_serve)
    async fn run_proxy_internal(&self) -> Result<()> {
        // Create app directory based on the resolved cert_dir parent
        let app_dir = self
            .config
            .tls
            .cert_dir
            .parent()
            .unwrap_or(&PathBuf::from("."))
            .to_path_buf();
        // 0o700: the app dir holds the config (with secrets), CA key, and DB.
        crate::util::fs_secure::create_dir_secure(&app_dir)?;

        info!("Loaded proxy configuration");

        // Spawn system resource metrics if OTel is enabled
        #[cfg(feature = "otel")]
        let _resource_metrics_handle =
            if self.config.telemetry.enabled && self.config.telemetry.resource_metrics_enabled {
                Some(crate::util::telemetry::otel::spawn_resource_metrics(
                    self.config.telemetry.resource_metrics_interval_secs,
                ))
            } else {
                None
            };

        // Create certificate authority using pre-resolved cert_dir (0o700 — holds the CA key)
        crate::util::fs_secure::create_dir_secure(&self.config.tls.cert_dir)?;
        let ca = CertificateAuthority::new(self.config.tls.cert_dir.clone()).await?;
        info!("Certificate Authority initialized");

        // Handle --auto flag: trust CA if needed
        if self.auto {
            info!("Auto mode enabled: checking CA trust status");
            ca.install_root_certificate(true, false).await?;
        }

        // Ensure the database (key + migrations), the JWT signing secret, and
        // the default admin account all exist, generating/persisting whatever is
        // missing. `run` (foreground) is interactive, so a generated admin
        // password is surfaced to stdout here; the daemon (`serve`) is not —
        // its admin account was already provisioned by `service install`.
        let cfg_path = app_dir.join("config.toml");
        let Provisioned {
            db,
            effective_config,
            generated_admin_password,
        } = provision(&self.config, &cfg_path, self.interactive).await?;
        if let Some(password) = &generated_admin_password {
            print_admin_credentials(&effective_config.auth.admin_email, password);
        }

        // Keep a pool handle for transparent proxy tenant resolution
        let db_pool = db.pool.clone();

        // Plugin registry which will be shared across the proxy and web server
        let plugin_registry = if self.config.plugins.enabled {
            let runtime = Runtime::try_default()?;
            let mut registry = PluginRegistry::new(db, runtime)?;
            // Activate the global baseline sandbox limits from config. A value
            // of 0 means "unlimited" for that dimension. Individual plugins may
            // carry overrides in the database, which are resolved against this
            // baseline per event.
            registry.set_limits(self.config.plugins.resolved_limits());
            registry.load_plugins().await?;
            info!("Number of plugins loaded: {}", registry.plugins().len());
            Some(Arc::new(registry))
        } else {
            None
        };

        // Clone for plugin_dir loading to transfer ownership
        let plugin_registry = plugin_registry;

        // If --plugin-dir is specified, load plugins from directory
        if let Some(ref plugin_dir) = self.plugin_dir {
            if let Some(ref registry) = plugin_registry {
                info!("Loading plugins from directory: {:?}", plugin_dir);
                std::fs::create_dir_all(plugin_dir)?;
                load_plugins_from_directory(plugin_dir, registry.clone()).await?;
            } else {
                warn!("--plugin-dir specified but plugins are disabled in configuration");
            }
        }

        // Reuse the CA created above instead of re-reading/parsing it from disk;
        // CertificateAuthority is Clone (Arc internals) and shares the cert cache.
        let ca_for_proxy = ca.clone();
        let config_path = app_dir.join("config.toml");
        let mut proxy = WitmProxy::new(ca_for_proxy, plugin_registry.clone(), effective_config)
            .with_config_path(config_path)
            .with_db_pool(db_pool.clone());
        proxy.start().await?;

        // Capture the bound addresses
        let proxy_addr = proxy
            .proxy_listen_addr()
            .ok_or_else(|| anyhow::anyhow!("Failed to get proxy listen address"))?;
        let web_addr = proxy
            .web_listen_addr()
            .ok_or_else(|| anyhow::anyhow!("Failed to get web listen address"))?;

        // Create services structure
        let services = Services {
            proxy: proxy_addr.to_string(),
            web: web_addr.to_string(),
        };

        // Write services.json to config root (app_dir)
        let services_path = app_dir.join("services.json");
        let services_json = serde_json::to_string_pretty(&services)?;
        std::fs::write(&services_path, services_json)?;
        info!("Services information written to: {:?}", services_path);

        // Detect Tailscale and display QR code for cert distribution
        tailscale::discover_and_display(web_addr).await;

        // Start transparent proxy if enabled
        let mut _transparent_proxy = None;
        if self.config.transparent.enabled {
            info!("Transparent proxy mode enabled, starting...");
            let resolver = tenant_resolver::build_resolver(
                &self.config.proxy.tenant_resolver,
                db_pool.clone(),
                self.config.proxy.tenant_header.clone(),
            );
            let upstream = crate::proxy::client(ca.clone())?;
            let shutdown_notify = Arc::new(tokio::sync::Notify::new());
            let mut tp = crate::proxy::transparent::TransparentProxy::new(
                Arc::new(ca),
                plugin_registry.clone(),
                resolver,
                upstream,
                self.config.transparent.clone(),
                shutdown_notify,
            );
            tp.start().await?;
            info!(
                "Transparent proxy listening on {}",
                tp.listen_addr().map(|a| a.to_string()).unwrap_or_default()
            );
            _transparent_proxy = Some(tp);
        }

        // Handle --auto flag: enable system proxy
        if self.auto {
            info!("Auto mode: enabling system proxy");
            let proxy_handler = proxy::ProxyHandler::new(self.config.tls.clone());
            proxy_handler.enable_proxy_internal(false).await?;
        }

        // Spawn auto-update loop if enabled
        if self.config.update.auto_update {
            let update_config = self.config.clone();
            let interval = self.config.update.check_interval_seconds;
            tokio::spawn(async move {
                update::auto_update_loop(interval, update_config).await;
            });
        }

        // Set up file watcher for plugin directory if specified
        let _watcher = if let Some(ref plugin_dir) = self.plugin_dir {
            if let Some(ref registry) = plugin_registry {
                Some(setup_plugin_dir_watcher(
                    plugin_dir.clone(),
                    registry.clone(),
                )?)
            } else {
                None
            }
        } else {
            None
        };

        // Continue running the proxy
        proxy.join().await?;

        // Handle --auto flag: disable system proxy on shutdown
        if self.auto {
            info!("Auto mode: disabling system proxy on shutdown");
            let proxy_handler = proxy::ProxyHandler::new(self.config.tls.clone());
            proxy_handler.disable_proxy_internal(false).await?;
        }

        proxy.shutdown().await;

        Ok(())
    }
}

/// Load all .wasm plugins from a directory into the registry
pub async fn load_plugins_from_directory(
    dir: &PathBuf,
    registry: Arc<PluginRegistry>,
) -> Result<()> {
    let entries = std::fs::read_dir(dir)?;

    for entry in entries {
        let entry = entry?;
        let path = entry.path();

        if path.is_file() && path.extension().is_some_and(|ext| ext == "wasm") {
            match load_plugin_from_file(&path, &registry).await {
                Ok(plugin_id) => {
                    info!("Loaded plugin from file: {:?} ({})", path, plugin_id);
                }
                Err(e) => {
                    warn!("Failed to load plugin from {:?}: {}", path, e);
                }
            }
        }
    }

    Ok(())
}

/// Load a single plugin from a .wasm file
async fn load_plugin_from_file(path: &PathBuf, registry: &Arc<PluginRegistry>) -> Result<String> {
    let component_bytes = std::fs::read(path)?;
    let plugin = registry.plugin_from_component(component_bytes).await?;
    let plugin_id = plugin.id();
    registry.register_plugin(plugin).await?;
    Ok(plugin_id)
}

/// Set up a file watcher for the plugin directory
fn setup_plugin_dir_watcher(
    plugin_dir: PathBuf,
    registry: Arc<PluginRegistry>,
) -> Result<RecommendedWatcher> {
    let (tx, mut rx) = mpsc::channel::<notify::Result<NotifyEvent>>(100);

    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.blocking_send(res);
    })?;

    watcher.watch(&plugin_dir, RecursiveMode::NonRecursive)?;
    info!("Watching plugin directory for changes: {:?}", plugin_dir);

    // Track file -> plugin_id mapping for deletion handling
    let file_plugin_map: Arc<RwLock<HashMap<PathBuf, String>>> =
        Arc::new(RwLock::new(HashMap::new()));

    // Initialize the file map with current plugins
    let registry_clone = registry.clone();
    let plugin_dir_clone = plugin_dir.clone();
    let file_plugin_map_clone = file_plugin_map.clone();

    tokio::spawn(async move {
        // Initial scan to populate file_plugin_map
        if let Ok(entries) = std::fs::read_dir(&plugin_dir_clone) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file()
                    && path.extension().is_some_and(|ext| ext == "wasm")
                    && let Ok(component_bytes) = std::fs::read(&path)
                    && let Ok(plugin) = registry_clone.plugin_from_component(component_bytes).await
                    {
                        let mut map = file_plugin_map_clone.write().await;
                        map.insert(path, plugin.id());
                    }
            }
        }
    });

    // Spawn task to handle file events
    let registry_for_handler = registry.clone();
    let file_plugin_map_for_handler = file_plugin_map;

    tokio::spawn(async move {
        while let Some(res) = rx.recv().await {
            match res {
                Ok(event) => {
                    handle_plugin_file_event(
                        event,
                        &registry_for_handler,
                        &file_plugin_map_for_handler,
                    )
                    .await;
                }
                Err(e) => {
                    error!("File watcher error: {}", e);
                }
            }
        }
    });

    Ok(watcher)
}

/// Handle a file system event for the plugin directory
async fn handle_plugin_file_event(
    event: NotifyEvent,
    registry: &Arc<PluginRegistry>,
    file_plugin_map: &Arc<RwLock<HashMap<PathBuf, String>>>,
) {
    use notify::EventKind;

    for path in event.paths {
        // Only handle .wasm files
        if path.extension().is_none_or(|ext| ext != "wasm") {
            continue;
        }

        match event.kind {
            EventKind::Create(_) | EventKind::Modify(ModifyKind::Data(_)) => {
                info!("Plugin file created/modified: {:?}", path);

                // Remove old plugin if it exists
                {
                    let map = file_plugin_map.read().await;
                    if let Some(old_plugin_id) = map.get(&path) {
                        let parts: Vec<&str> = old_plugin_id.split('/').collect();
                        if let [namespace, name] = parts.as_slice() {
                            match registry.remove_plugin(name, Some(namespace)).await {
                                Ok(removed) => {
                                    if !removed.is_empty() {
                                        info!("Removed old plugin version: {}", old_plugin_id);
                                    }
                                }
                                Err(e) => {
                                    warn!("Failed to remove old plugin {}: {}", old_plugin_id, e);
                                }
                            }
                        }
                    }
                }

                // Load new plugin
                match load_plugin_from_file(&path, registry).await {
                    Ok(plugin_id) => {
                        info!("Loaded/updated plugin: {} from {:?}", plugin_id, path);
                        let mut map = file_plugin_map.write().await;
                        map.insert(path.clone(), plugin_id);
                    }
                    Err(e) => {
                        warn!("Failed to load plugin from {:?}: {}", path, e);
                    }
                }
            }
            EventKind::Remove(_) => {
                info!("Plugin file removed: {:?}", path);

                let plugin_id = {
                    let mut map = file_plugin_map.write().await;
                    map.remove(&path)
                };

                if let Some(plugin_id) = plugin_id {
                    let parts: Vec<&str> = plugin_id.split('/').collect();
                    if let [namespace, name] = parts.as_slice() {
                        match registry.remove_plugin(name, Some(namespace)).await {
                            Ok(removed) => {
                                if !removed.is_empty() {
                                    info!("Removed plugin: {}", plugin_id);
                                }
                            }
                            Err(e) => {
                                warn!("Failed to remove plugin {}: {}", plugin_id, e);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
}
