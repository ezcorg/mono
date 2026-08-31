#[cfg(target_os = "linux")]
use crate::config::TransparentProxyConfig;
use super::{GlobalArgs, ServiceCtlArgs};
use crate::config::{AppConfig, LogConfig, ServiceScopedConfig, TelemetryConfig};
use anyhow::{Context, Result};
use conf::{Conf, Subcommands};
use service_manager::{
    ServiceInstallCtx, ServiceLabel, ServiceManager, ServiceStartCtx, ServiceStatus,
    ServiceStatusCtx, ServiceStopCtx, ServiceUninstallCtx,
};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use tracing::{error, info};

#[cfg(target_os = "macos")]
use service_manager::LaunchdServiceManager;

#[cfg(target_os = "linux")]
use service_manager::SystemdServiceManager;

/// Service label used by the service-manager crate
const SERVICE_LABEL: &str = "co.ez.witmproxy";

/// Platform-specific service file name
#[cfg(target_os = "macos")]
const SERVICE_FILE_NAME: &str = "co.ez.witmproxy.plist";
#[cfg(target_os = "linux")]
const SERVICE_FILE_NAME: &str = "ez-witmproxy.service";

/// Log file name within the app directory
const LOG_FILE_NAME: &str = "witmproxy.log";

/// The reconciled service state we display, from the runtime manager plus the
/// on-disk service file. See [`ServiceHandler::classify_status`].
#[derive(Debug, PartialEq, Eq)]
enum ServiceState {
    /// No service file on disk and the manager doesn't know it.
    NotInstalled,
    /// Installed and reported running by the manager.
    Running,
    /// Installed and reported stopped by the manager (optional reason).
    Stopped(Option<String>),
    /// Service file on disk but the manager hasn't loaded it (e.g. freshly
    /// installed on macOS, not yet `service start`ed).
    NotStarted,
}

/// Every leaf reads its config subset from the `[config]` file section: the
/// variants are all `serde(rename = "config")` and `Cli::parse_args` mirrors
/// the `[config]` table under this command's doc key (see
/// `mirror_config_for_nested_commands`).
// Boxing the large variant would mean the `Subcommands` derive generating
// against a `Box<T>`, which it does not support. The enum is constructed once
// per CLI invocation, so the size difference costs nothing here.
#[allow(clippy::large_enum_variant)]
#[derive(Subcommands)]
#[conf(serde)]
pub enum ServiceCommands {
    /// Install the witmproxy service (does not start it)
    #[conf(serde(rename = "config"))]
    Install(ServiceInstallArgs),
    /// Uninstall the witmproxy service
    #[conf(serde(rename = "config"))]
    Uninstall(ServiceUninstallArgs),
    /// Start the witmproxy service
    #[conf(serde(rename = "config"))]
    Start(ServiceCtlArgs),
    /// Stop the witmproxy service
    #[conf(serde(rename = "config"))]
    Stop(ServiceCtlArgs),
    /// Restart the witmproxy service
    #[conf(serde(rename = "config"))]
    Restart(ServiceCtlArgs),
    /// Show the status of the witmproxy service
    #[conf(serde(rename = "config"))]
    Status(ServiceCtlArgs),
    /// Show the path to the daemon log file
    #[conf(serde(rename = "config"))]
    Logs(ServiceLogsArgs),
}

impl ServiceCommands {
    pub(crate) fn globals(&self) -> &GlobalArgs {
        match self {
            ServiceCommands::Install(a) => &a.globals,
            ServiceCommands::Uninstall(a) => &a.globals,
            ServiceCommands::Start(a)
            | ServiceCommands::Stop(a)
            | ServiceCommands::Restart(a)
            | ServiceCommands::Status(a) => &a.globals,
            ServiceCommands::Logs(a) => &a.globals,
        }
    }

    /// The tls+log scope of whichever leaf was invoked (for `install`,
    /// derived from its full config).
    pub(crate) fn ctl_config(&self) -> ServiceScopedConfig {
        match self {
            ServiceCommands::Install(a) => ServiceScopedConfig {
                tls: a.config.tls.clone(),
                log: a.config.log.clone(),
            },
            ServiceCommands::Uninstall(a) => a.config.clone(),
            ServiceCommands::Start(a)
            | ServiceCommands::Stop(a)
            | ServiceCommands::Restart(a)
            | ServiceCommands::Status(a) => a.config.clone(),
            ServiceCommands::Logs(a) => a.config.clone(),
        }
    }

    /// Telemetry/log settings + `--verbose` as visible to this leaf.
    pub(crate) fn telemetry_settings(&self) -> (TelemetryConfig, LogConfig, bool) {
        match self {
            ServiceCommands::Install(a) => (
                a.config.telemetry.clone(),
                a.config.log.clone(),
                a.globals.verbose,
            ),
            other => {
                let scoped = other.ctl_config();
                (
                    TelemetryConfig::default(),
                    scoped.log,
                    other.globals().verbose,
                )
            }
        }
    }
}

#[derive(Conf)]
#[conf(serde)]
pub struct ServiceInstallArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,

    /// Application configuration: `service install` persists the full,
    /// effective config for the daemon.
    #[conf(flatten, serde(flatten))]
    pub config: AppConfig,

    /// Directory to load plugins from, watched for changes
    #[arg(long = "plugin-dir")]
    pub plugin_dir: Option<PathBuf>,
    /// Automatically trust the proxy CA and configure system proxy settings on startup
    #[arg(long = "auto")]
    pub auto: bool,
    /// Skip confirmation prompts
    #[arg(long = "yes", short = 'y')]
    pub yes: bool,
}

#[derive(Conf)]
#[conf(serde(allow_unknown_fields))]
pub struct ServiceUninstallArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,
    #[conf(flatten, serde(flatten))]
    pub config: ServiceScopedConfig,

    /// Skip confirmation prompts
    #[arg(long = "yes", short = 'y')]
    pub yes: bool,
}

#[derive(Conf)]
#[conf(serde(allow_unknown_fields))]
pub struct ServiceLogsArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,
    #[conf(flatten, serde(flatten))]
    pub config: ServiceScopedConfig,

    /// Follow the log output (like tail -f)
    #[arg(long = "follow", short = 'f')]
    pub follow: bool,
    /// Number of lines to show from the end
    #[arg(long = "lines", short = 'n', default_value = "50")]
    pub lines: usize,
}

pub struct ServiceHandler {
    pub(crate) config: AppConfig,
    verbose: bool,
    plugin_dir: Option<PathBuf>,
    auto: bool,
}

impl ServiceHandler {
    pub fn new(config: AppConfig, verbose: bool, plugin_dir: Option<PathBuf>, auto: bool) -> Self {
        Self {
            config,
            verbose,
            plugin_dir,
            auto,
        }
    }

    /// Get the service label
    fn service_label() -> ServiceLabel {
        #[allow(
        clippy::expect_used,
        reason = "SERVICE_LABEL is a compile-time constant known to parse"
    )]
    SERVICE_LABEL.parse().expect("valid service label")
    }

    /// Get the native service manager for the current platform
    /// Linux: system-level systemd service (requires root)
    /// macOS: user-level launchd service
    fn get_manager() -> Result<Box<dyn ServiceManager>> {
        #[cfg(target_os = "macos")]
        {
            // Use user-level launchd services (~/Library/LaunchAgents)
            Ok(Box::new(LaunchdServiceManager::user()))
        }

        #[cfg(target_os = "linux")]
        {
            // Use system-level systemd services (/etc/systemd/system)
            Ok(Box::new(SystemdServiceManager::system()))
        }

        #[cfg(target_os = "windows")]
        {
            // Windows services require admin privileges
            let manager = <dyn ServiceManager>::native()
                .context("Failed to get native service manager for Windows")?;
            Ok(manager)
        }

        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        {
            let manager = <dyn ServiceManager>::native()
                .context("Failed to get native service manager for this platform")?;
            Ok(manager)
        }
    }

    /// Get the path to the current executable
    fn get_executable_path() -> Result<PathBuf> {
        std::env::current_exe().context("Failed to get current executable path")
    }

    /// Get the app directory
    /// Linux system service: /var/lib/witmproxy
    /// macOS / other: parent of cert_dir (~/.witmproxy)
    fn get_app_dir(&self) -> PathBuf {
        #[cfg(target_os = "linux")]
        {
            PathBuf::from("/var/lib/witmproxy")
        }
        #[cfg(not(target_os = "linux"))]
        {
            self.config
                .tls
                .cert_dir
                .parent()
                .unwrap_or(&PathBuf::from("."))
                .to_path_buf()
        }
    }

    /// Get the log file path
    pub fn get_log_path(&self) -> PathBuf {
        self.get_app_dir().join(LOG_FILE_NAME)
    }

    /// Get the config file path
    fn get_config_path(&self) -> PathBuf {
        self.get_app_dir().join("config.toml")
    }

    /// Resolve the daemon's actual log file. The rolling appender writes files
    /// named `witmproxy.<date>.log` (or `witmproxy.log` when rotation is off), so
    /// return the most recently modified `witmproxy*.log` in the app directory,
    /// falling back to the un-rotated name.
    pub fn current_log_file(&self) -> PathBuf {
        let app_dir = self.get_app_dir();
        std::fs::read_dir(&app_dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("witmproxy") && n.ends_with(".log"))
            })
            .max_by_key(|p| {
                std::fs::metadata(p)
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::UNIX_EPOCH)
            })
            .unwrap_or_else(|| app_dir.join(LOG_FILE_NAME))
    }

    /// Query the native service manager (launchd/systemd/SCM) for the real
    /// runtime state, rather than guessing from a log file's presence/mtime.
    fn query_service_status(&self) -> Option<ServiceStatus> {
        let manager = Self::get_manager().ok()?;
        let label = Self::service_label();
        manager.status(ServiceStatusCtx { label }).ok()
    }

    /// Probe the running web server's `/api/health` endpoint for true
    /// application health. `Some(true/false)` if the server was reachable,
    /// `None` if it couldn't be reached at all.
    async fn probe_health(&self) -> Option<bool> {
        let services_path = self.get_app_dir().join("services.json");
        let contents = std::fs::read_to_string(&services_path).ok()?;
        let services: super::Services = serde_json::from_str(&contents).ok()?;
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .ok()?;
        let resp = client
            .get(format!("https://{}/api/health", services.web))
            .send()
            .await
            .ok()?;
        Some(resp.status().is_success())
    }

    pub async fn handle(&self, command: &ServiceCommands) -> Result<()> {
        match command {
            ServiceCommands::Install(_) => {
                anyhow::bail!("install is handled by Cli::run and must not reach the service handler")
            }
            ServiceCommands::Uninstall(a) => self.uninstall_service(a.yes).await,
            ServiceCommands::Start(_) => self.start_service().await,
            ServiceCommands::Stop(_) => self.stop_service().await,
            ServiceCommands::Restart(_) => self.restart_service().await,
            ServiceCommands::Status(_) => self.show_status().await,
            ServiceCommands::Logs(a) => self.show_logs(a.follow, a.lines).await,
        }
    }

    /// On Linux, ensure root for daemon management commands.
    /// If not running as root, automatically re-executes the current command
    /// with `sudo` and exits with the child's exit code.
    #[cfg(target_os = "linux")]
    fn ensure_root() -> Result<()> {
        let is_root = std::process::Command::new("id")
            .arg("-u")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .is_some_and(|uid| uid.trim() == "0");

        if is_root {
            return Ok(());
        }

        // Re-execute the full command under sudo
        let exe = std::env::current_exe().context("failed to get current executable path")?;
        let args: Vec<String> = std::env::args().skip(1).collect();

        eprintln!("This command requires elevated privileges. Re-running with sudo...");
        let status = std::process::Command::new("sudo")
            .arg("--")
            .arg(&exe)
            .args(&args)
            .status()
            .context("failed to execute sudo — is it installed?")?;

        std::process::exit(status.code().unwrap_or(1));
    }

    /// Ensure the service directory exists for the current platform
    fn ensure_service_directory_exists() -> Result<()> {
        #[cfg(target_os = "macos")]
        {
            if let Some(home) = dirs::home_dir() {
                let launch_agents_dir = home.join("Library/LaunchAgents");
                if !launch_agents_dir.exists() {
                    info!("Creating LaunchAgents directory: {:?}", launch_agents_dir);
                    std::fs::create_dir_all(&launch_agents_dir)
                        .context("Failed to create ~/Library/LaunchAgents directory")?;
                }
            }
        }

        // Linux: /etc/systemd/system/ already exists, nothing to create

        Ok(())
    }

    /// Install the service
    pub async fn install_service(&self, skip_confirm: bool) -> Result<()> {
        #[cfg(target_os = "linux")]
        Self::ensure_root()?;

        if !skip_confirm {
            #[cfg(target_os = "linux")]
            {
                println!("This will install witmproxy as a system service.");
                println!("The service will be configured to:");
                println!("  - Run the proxy server in the background");
                println!("  - Start automatically on boot");
            }
            #[cfg(not(target_os = "linux"))]
            {
                println!("This will install witmproxy as a user service.");
                println!("The service will be configured to:");
                println!("  - Run the proxy server in the background");
                println!("  - Start automatically on login (on supported platforms)");
            }
            println!();
            print!("Continue? [y/N] ");
            use std::io::{self, Write};
            io::stdout().flush()?;
            let mut input = String::new();
            io::stdin().read_line(&mut input)?;
            if !input.trim().eq_ignore_ascii_case("y") {
                println!("Installation cancelled.");
                return Ok(());
            }
        }

        // Ensure platform-specific service directories exist
        Self::ensure_service_directory_exists()?;

        // Build service arguments
        let exe_path = Self::get_executable_path()?;
        let config_path = self.get_config_path();

        // Create app directory with restricted (0o700) permissions — it holds
        // the config, certs, db, and logs, which may contain secrets.
        let app_dir = self.get_app_dir();
        crate::util::fs_secure::create_dir_secure(&app_dir)?;

        // Persist the fully-resolved configuration (CLI > env > file > defaults),
        // pinned to the daemon's standard paths. `AppConfig::save` writes the
        // file 0o600 since it may contain db_password / jwt_secret / admin_password.
        let mut config_to_save = self.config.clone();
        config_to_save.db.db_path = app_dir.join("witmproxy.db");
        config_to_save.tls.cert_dir = app_dir.join("certs");
        config_to_save
            .save(&config_path)
            .context("Failed to save configuration")?;
        info!("Configuration saved to {:?}", config_path);

        // Provision the database and default admin account NOW, while we're an
        // interactive command with a real stdout — the daemon runs detached and
        // could not show a generated admin password to anyone. This also
        // generates + persists the db key and JWT secret up front, so the
        // daemon just opens an already-provisioned database.
        let provisioned = super::provision(&config_to_save, &config_path, true)
            .await
            .context("Failed to provision database and admin account")?;
        if let Some(password) = &provisioned.generated_admin_password {
            super::print_admin_credentials(&provisioned.effective_config.auth.admin_email, password);
        }
        // Close the provisioning database handle; the daemon opens its own.
        drop(provisioned);

        // The native service manager isn't `Send`; create it only after all
        // `.await`s above so this method's future stays `Send` (the daemon
        // auto-update loop spawns `install_service`).
        let manager = Self::get_manager()?;
        let label = Self::service_label();

        // Build arguments for the 'serve' subcommand. ALL options — including
        // the shared --config-path/--verbose — are declared on the subcommand
        // itself, so everything goes AFTER the subcommand name.
        let mut args: Vec<OsString> = vec![];

        // Subcommand name
        args.push("serve".into());

        args.push("--config-path".into());
        args.push(config_path.into());

        if self.verbose {
            args.push("--verbose".into());
        }

        // Subcommand args (defined on ProxyRunOptions / Serve)
        // Canonicalize plugin-dir to absolute path since the daemon's
        // working directory differs from the user's current directory
        if let Some(ref plugin_dir) = self.plugin_dir {
            let absolute_dir = if plugin_dir.is_relative() {
                std::env::current_dir()
                    .context("Failed to get current directory for resolving plugin-dir")?
                    .join(plugin_dir)
            } else {
                plugin_dir.clone()
            };
            args.push("--plugin-dir".into());
            args.push(absolute_dir.into());
        }

        if self.auto {
            args.push("--auto".into());
        }

        let log_path = self.get_log_path();
        args.push("--log-file".into());
        args.push(log_path.clone().into());

        info!("Installing service with executable: {:?}", exe_path);
        info!("Service arguments: {:?}", args);

        // On Linux, generate a custom unit file with ExecStopPost for iptables cleanup
        #[cfg(target_os = "linux")]
        let contents = {
            let unit =
                generate_systemd_unit(&exe_path, &args, &app_dir, &config_to_save.transparent);
            Some(unit)
        };
        #[cfg(not(target_os = "linux"))]
        let contents: Option<String> = None;

        let install_ctx = ServiceInstallCtx {
            label: label.clone(),
            program: exe_path,
            args,
            contents,
            username: None, // Run as current user
            working_directory: Some(app_dir),
            environment: None,
            autostart: true, // Start on boot
            restart_policy: service_manager::RestartPolicy::OnFailure {
                delay_secs: Some(1),
                max_retries: None,
                reset_after_secs: None,
            },
        };

        manager
            .install(install_ctx)
            .context("Failed to install service. On macOS, ensure ~/Library/LaunchAgents exists. On Linux, ensure you are running as root.")?;

        println!("✓ Service installed successfully.");
        println!("  Log file: {:?}", log_path);
        println!();
        println!("To start the service, run: witm service start");
        println!("To check status, run: witm service status");

        Ok(())
    }

    /// Uninstall the service
    pub async fn uninstall_service(&self, skip_confirm: bool) -> Result<()> {
        #[cfg(target_os = "linux")]
        Self::ensure_root()?;

        if !skip_confirm {
            println!("This will uninstall the witmproxy service.");
            println!("The service will be stopped if running.");
            println!();
            print!("Continue? [y/N] ");
            use std::io::{self, Write};
            io::stdout().flush()?;
            let mut input = String::new();
            io::stdin().read_line(&mut input)?;
            if !input.trim().eq_ignore_ascii_case("y") {
                println!("Uninstallation cancelled.");
                return Ok(());
            }
        }

        let manager = Self::get_manager()?;
        let label = Self::service_label();

        // Try to stop the service first
        let _ = manager.stop(ServiceStopCtx {
            label: label.clone(),
        });

        manager
            .uninstall(ServiceUninstallCtx { label })
            .context("Failed to uninstall service")?;

        println!("✓ Service uninstalled successfully.");

        Ok(())
    }

    /// Start the service
    pub async fn start_service(&self) -> Result<()> {
        #[cfg(target_os = "linux")]
        Self::ensure_root()?;

        let manager = Self::get_manager()?;
        let label = Self::service_label();

        manager
            .start(ServiceStartCtx { label })
            .context("Failed to start service")?;

        println!("✓ Service started.");
        println!("  To view logs: witm service logs -f");

        Ok(())
    }

    /// Stop the service
    pub async fn stop_service(&self) -> Result<()> {
        #[cfg(target_os = "linux")]
        Self::ensure_root()?;

        let manager = Self::get_manager()?;
        let label = Self::service_label();

        manager
            .stop(ServiceStopCtx { label })
            .context("Failed to stop service")?;

        println!("✓ Service stopped.");

        Ok(())
    }

    /// Restart the service
    pub async fn restart_service(&self) -> Result<()> {
        #[cfg(target_os = "linux")]
        Self::ensure_root()?;

        let manager = Self::get_manager()?;
        let label = Self::service_label();

        // Stop then start
        let _ = manager.stop(ServiceStopCtx {
            label: label.clone(),
        });

        manager
            .start(ServiceStartCtx { label })
            .context("Failed to start service")?;

        println!("✓ Service restarted.");

        Ok(())
    }

    /// Check if the service is installed
    pub fn is_service_installed(&self) -> bool {
        if let Ok(manager) = Self::get_manager() {
            // Try to query the service - if it fails, it's likely not installed
            // service-manager doesn't have a direct "is_installed" method,
            // so we check platform-specific files
            #[cfg(target_os = "macos")]
            {
                let plist_path = dirs::home_dir()
                    .map(|h| h.join("Library/LaunchAgents").join(SERVICE_FILE_NAME));
                if let Some(path) = plist_path {
                    return path.exists();
                }
            }

            #[cfg(target_os = "linux")]
            {
                let path = PathBuf::from("/etc/systemd/system").join(SERVICE_FILE_NAME);
                if path.exists() {
                    return true;
                }
            }

            #[cfg(target_os = "windows")]
            {
                use std::process::Command;
                let output = Command::new("sc").args(["query", SERVICE_LABEL]).output();
                if let Ok(output) = output {
                    return output.status.success();
                }
            }

            // If we get here on any platform without specific checking, assume not installed
            let _ = manager; // suppress unused warning
        }
        false
    }

    /// Reconcile the runtime manager's status with the on-disk service file
    /// into the state we report. The on-disk file is the ground truth for
    /// *installed*: on macOS `service install` writes the launchd plist without
    /// loading it, so `launchctl` reports `NotInstalled` until `service start`
    /// bootstraps it — trusting that alone made a freshly-installed service read
    /// as "Not installed". The manager's report is only authoritative when it
    /// actually knows the service (Running/Stopped).
    fn classify_status(manager: Option<&ServiceStatus>, file_present: bool) -> ServiceState {
        match manager {
            Some(ServiceStatus::Running) => ServiceState::Running,
            Some(ServiceStatus::Stopped(reason)) => ServiceState::Stopped(reason.clone()),
            // Manager says not-installed, or couldn't report at all: the plist /
            // unit file on disk decides. Present ⇒ installed but not loaded yet.
            Some(ServiceStatus::NotInstalled) | None => {
                if file_present {
                    ServiceState::NotStarted
                } else {
                    ServiceState::NotInstalled
                }
            }
        }
    }

    /// Show service status.
    ///
    /// Reports three distinct things instead of guessing from a log file:
    ///   1. Installed?  — the on-disk service file (manager confirms running state)
    ///   2. Running?    — the manager's real runtime state (launchd/systemd/SCM)
    ///   3. Healthy?    — an actual probe of the web server's `/api/health`
    pub async fn show_status(&self) -> Result<()> {
        let status = self.query_service_status();
        let state = Self::classify_status(status.as_ref(), self.is_service_installed());

        if state == ServiceState::NotInstalled {
            println!("Service status: Not installed");
            println!();
            println!("To install: witm service install");
            return Ok(());
        }

        println!("Service status: Installed");
        match &state {
            ServiceState::Running => println!("Service:        Running"),
            ServiceState::Stopped(Some(reason)) => println!("Service:        Stopped ({reason})"),
            ServiceState::Stopped(None) => println!("Service:        Stopped"),
            ServiceState::NotStarted => println!("Service:        Stopped (not started)"),
            ServiceState::NotInstalled => {
                    anyhow::bail!("service is not installed")
                }
        }

        // Real application health: probe the endpoint the web server exposes.
        match self.probe_health().await {
            Some(true) => println!("Health:         Healthy (/api/health OK)"),
            Some(false) => println!("Health:         Unhealthy (/api/health returned an error)"),
            None => println!("Health:         Unreachable (daemon not accepting connections)"),
        }

        println!();
        println!("Log file: {:?}", self.current_log_file());

        // Show services.json if it exists
        let services_path = self.get_app_dir().join("services.json");
        if services_path.exists()
            && let Ok(contents) = std::fs::read_to_string(&services_path)
        {
            println!();
            println!("Active services:");
            println!("{}", contents);
        }

        Ok(())
    }

    /// Show daemon logs
    pub async fn show_logs(&self, follow: bool, lines: usize) -> Result<()> {
        let log_path = self.current_log_file();

        if !log_path.exists() {
            println!("Log file does not exist yet: {:?}", log_path);
            println!("The service may not have been started.");
            return Ok(());
        }

        if follow {
            // Use tail -f for following logs
            #[cfg(unix)]
            {
                use std::process::Command;
                let status = Command::new("tail")
                    .args(["-f", "-n", &lines.to_string()])
                    .arg(&log_path)
                    .status()
                    .context("Failed to run tail command")?;

                if !status.success() {
                    error!("tail command failed");
                }
            }

            #[cfg(windows)]
            {
                // On Windows, use PowerShell's Get-Content -Wait
                use std::process::Command;
                let status = Command::new("powershell")
                    .args([
                        "-Command",
                        &format!(
                            "Get-Content -Path '{}' -Tail {} -Wait",
                            log_path.display(),
                            lines
                        ),
                    ])
                    .status()
                    .context("Failed to run PowerShell command")?;

                if !status.success() {
                    error!("PowerShell command failed");
                }
            }
        } else {
            // Just show the last N lines
            let contents = std::fs::read_to_string(&log_path).context("Failed to read log file")?;
            let all_lines: Vec<&str> = contents.lines().collect();
            let start = if all_lines.len() > lines {
                all_lines.len() - lines
            } else {
                0
            };
            for line in all_lines.get(start..).unwrap_or(&all_lines) {
                println!("{}", line);
            }
        }

        Ok(())
    }

    /// Attach to daemon logs (used by default run behavior)
    pub async fn attach_to_logs(&self) -> Result<()> {
        info!("Attaching to daemon logs...");
        println!("Attached to witmproxy daemon. Press Ctrl+C to detach.");
        println!("---");
        self.show_logs(true, 20).await
    }
}

#[cfg(target_os = "linux")]
fn generate_systemd_unit(
    exe_path: &Path,
    args: &[OsString],
    app_dir: &Path,
    transparent_config: &TransparentProxyConfig,
) -> String {
    use crate::proxy::netfilter::NetfilterManager;

    let interface = transparent_config
        .interface
        .as_deref()
        .unwrap_or("tailscale0");
    let redirect_port: u16 = transparent_config
        .listen_addr
        .as_deref()
        .unwrap_or("0.0.0.0:8080")
        .rsplit(':')
        .next()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);

    let args_str = args
        .iter()
        .map(|a| a.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(" ");

    let exec_start = format!("{} {}", exe_path.display(), args_str);

    let cleanup_commands = NetfilterManager::cleanup_commands(interface, redirect_port);
    let exec_stop_post_lines: Vec<String> = cleanup_commands
        .iter()
        .map(|(cmd, cmd_args)| {
            let path = if cmd == "iptables" {
                "/usr/sbin/iptables"
            } else {
                "/usr/sbin/ip6tables"
            };
            format!("ExecStopPost=-{} {}", path, cmd_args.join(" "))
        })
        .collect();

    format!(
        "\
[Unit]
Description=witmproxy transparent proxy service
After=network.target

[Service]
Type=simple
ExecStart={exec_start}
WorkingDirectory={work_dir}
Restart=on-failure
RestartSec=1
{exec_stop_post}

[Install]
WantedBy=multi-user.target
",
        exec_start = exec_start,
        work_dir = app_dir.display(),
        exec_stop_post = exec_stop_post_lines.join("\n"),
    )
}

/// Check if the daemon is already running by checking the services.json file
pub fn is_daemon_running(app_dir: &Path) -> bool {
    let services_path = app_dir.join("services.json");
    if !services_path.exists() {
        return false;
    }

    // Check if services.json was recently modified (within last minute)
    if let Ok(metadata) = std::fs::metadata(&services_path)
        && let Ok(modified) = metadata.modified()
    {
        let duration = std::time::SystemTime::now()
            .duration_since(modified)
            .unwrap_or_default();
        // If modified within last 5 minutes, assume running
        // This is a heuristic - the actual check would be to connect to the service
        if duration.as_secs() < 300 {
            return true;
        }
    }

    false
}

#[cfg(test)]
mod status_tests {
    use super::*;

    #[test]
    fn running_is_running_regardless_of_file() {
        assert_eq!(
            ServiceHandler::classify_status(Some(&ServiceStatus::Running), true),
            ServiceState::Running
        );
        assert_eq!(
            ServiceHandler::classify_status(Some(&ServiceStatus::Running), false),
            ServiceState::Running
        );
    }

    /// The reported bug: after `service install` on macOS the plist is on disk
    /// but launchd reports `NotInstalled` until `service start` loads it. That
    /// must read as installed-but-not-started, not "Not installed".
    #[test]
    fn plist_on_disk_but_manager_not_installed_is_not_started() {
        assert_eq!(
            ServiceHandler::classify_status(Some(&ServiceStatus::NotInstalled), true),
            ServiceState::NotStarted
        );
    }

    #[test]
    fn truly_not_installed_when_no_file_and_manager_agrees() {
        assert_eq!(
            ServiceHandler::classify_status(Some(&ServiceStatus::NotInstalled), false),
            ServiceState::NotInstalled
        );
        assert_eq!(
            ServiceHandler::classify_status(None, false),
            ServiceState::NotInstalled
        );
    }

    /// Manager query failed but the file exists → installed, not yet loaded.
    #[test]
    fn query_error_with_file_present_is_not_started() {
        assert_eq!(
            ServiceHandler::classify_status(None, true),
            ServiceState::NotStarted
        );
    }

    #[test]
    fn stopped_is_passed_through_with_reason() {
        assert_eq!(
            ServiceHandler::classify_status(Some(&ServiceStatus::Stopped(None)), true),
            ServiceState::Stopped(None)
        );
        assert_eq!(
            ServiceHandler::classify_status(
                Some(&ServiceStatus::Stopped(Some("boom".into()))),
                true
            ),
            ServiceState::Stopped(Some("boom".into()))
        );
    }
}

#[cfg(test)]
#[cfg(target_os = "linux")]
mod tests {
    use super::*;
    use crate::config::TransparentProxyConfig;

    fn default_transparent_config() -> TransparentProxyConfig {
        TransparentProxyConfig {
            enabled: true,
            listen_addr: None,
            interface: None,
            auto_iptables: true,
        }
    }

    #[test]
    fn generate_unit_has_valid_structure() {
        let unit = generate_systemd_unit(
            Path::new("/usr/bin/witm"),
            &[
                "serve".into(),
                "--config-path".into(),
                "/etc/witm.toml".into(),
            ],
            Path::new("/var/lib/witmproxy"),
            &default_transparent_config(),
        );

        assert!(unit.contains("[Unit]"));
        assert!(unit.contains("[Service]"));
        assert!(unit.contains("[Install]"));
        assert!(unit.contains("ExecStart=/usr/bin/witm serve --config-path /etc/witm.toml"));
        assert!(unit.contains("WorkingDirectory=/var/lib/witmproxy"));
        assert!(unit.contains("Restart=on-failure"));
        assert!(unit.contains("WantedBy=multi-user.target"));
    }

    #[test]
    fn generate_unit_has_exec_stop_post_lines() {
        let unit = generate_systemd_unit(
            Path::new("/usr/bin/witm"),
            &["serve".into()],
            Path::new("/var/lib/witmproxy"),
            &default_transparent_config(),
        );

        // 4 PREROUTING + 4 OUTPUT DNAT + 2 OUTPUT QUIC block + 2 FORWARD QUIC block = 12 ExecStopPost lines
        let stop_post_lines: Vec<&str> = unit
            .lines()
            .filter(|l| l.starts_with("ExecStopPost="))
            .collect();
        assert_eq!(stop_post_lines.len(), 12);

        // All should use the `-` prefix for error suppression
        for line in &stop_post_lines {
            assert!(line.starts_with("ExecStopPost=-/usr/sbin/"));
        }

        // TCP rules (PREROUTING + OUTPUT DNAT) should reference port 8080
        let tcp_lines: Vec<&&str> = stop_post_lines
            .iter()
            .filter(|l| !l.contains("udp"))
            .collect();
        for line in &tcp_lines {
            assert!(line.contains("8080"), "missing port 8080: {}", line);
        }

        // QUIC block rules should reference UDP port 443
        let udp_lines: Vec<&&str> = stop_post_lines
            .iter()
            .filter(|l| l.contains("udp"))
            .collect();
        assert_eq!(udp_lines.len(), 4); // 2 OUTPUT + 2 FORWARD
        for line in &udp_lines {
            assert!(line.contains("443"), "missing port 443: {}", line);
        }
    }

    #[test]
    fn generate_unit_with_custom_interface_and_port() {
        let config = TransparentProxyConfig {
            enabled: true,
            listen_addr: Some("0.0.0.0:9090".to_string()),
            interface: Some("eth0".to_string()),
            auto_iptables: true,
        };

        let unit = generate_systemd_unit(
            Path::new("/usr/bin/witm"),
            &["serve".into()],
            Path::new("/var/lib/witmproxy"),
            &config,
        );

        let stop_post_lines: Vec<&str> = unit
            .lines()
            .filter(|l| l.starts_with("ExecStopPost="))
            .collect();
        assert_eq!(stop_post_lines.len(), 12);

        // PREROUTING lines should have eth0
        let prerouting_lines: Vec<&&str> = stop_post_lines
            .iter()
            .filter(|l| l.contains("PREROUTING"))
            .collect();
        let output_lines: Vec<&&str> = stop_post_lines
            .iter()
            .filter(|l| l.contains("OUTPUT"))
            .collect();
        let forward_lines: Vec<&&str> = stop_post_lines
            .iter()
            .filter(|l| l.contains("FORWARD"))
            .collect();
        assert_eq!(prerouting_lines.len(), 4);
        assert_eq!(output_lines.len(), 6); // 4 DNAT + 2 QUIC block
        assert_eq!(forward_lines.len(), 2); // 2 FORWARD QUIC block
        for line in &prerouting_lines {
            assert!(line.contains("eth0"), "missing custom interface: {}", line);
        }
        // TCP rules should reference port 9090
        let tcp_lines: Vec<&&str> = stop_post_lines
            .iter()
            .filter(|l| !l.contains("udp"))
            .collect();
        for line in &tcp_lines {
            assert!(line.contains("9090"), "missing custom port 9090: {}", line);
        }
    }

    #[test]
    fn exec_stop_post_matches_cleanup_commands() {
        use crate::proxy::netfilter::NetfilterManager;

        let config = default_transparent_config();
        let unit = generate_systemd_unit(
            Path::new("/usr/bin/witm"),
            &["serve".into()],
            Path::new("/var/lib/witmproxy"),
            &config,
        );

        let cleanup = NetfilterManager::cleanup_commands("tailscale0", 8080);
        let stop_post_lines: Vec<&str> = unit
            .lines()
            .filter(|l| l.starts_with("ExecStopPost="))
            .collect();

        assert_eq!(stop_post_lines.len(), cleanup.len());

        for ((cmd, args), line) in cleanup.iter().zip(stop_post_lines.iter()) {
            // The line should contain all the args from cleanup_commands
            for arg in args {
                assert!(
                    line.contains(arg),
                    "ExecStopPost line missing arg '{}': {}",
                    arg,
                    line
                );
            }
            // Should use the full path
            let expected_path = if cmd == "iptables" {
                "/usr/sbin/iptables"
            } else {
                "/usr/sbin/ip6tables"
            };
            assert!(line.contains(expected_path), "missing path: {}", line);
        }
    }
}
