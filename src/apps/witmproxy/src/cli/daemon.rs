use crate::config::AppConfig;
use anyhow::{Context, Result};
use clap::Subcommand;
use service_manager::{
    ServiceInstallCtx, ServiceLabel, ServiceManager, ServiceStartCtx, ServiceStopCtx,
    ServiceUninstallCtx,
};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use tracing::{error, info};

#[cfg(target_os = "macos")]
use service_manager::LaunchdServiceManager;

#[cfg(target_os = "linux")]
use service_manager::SystemdServiceManager;

/// Service label for witmproxy daemon
const SERVICE_LABEL: &str = "co.joinez.witmproxy";

/// Log file name within the app directory
const LOG_FILE_NAME: &str = "witmproxy.log";

#[derive(Subcommand)]
pub enum DaemonCommands {
    /// Install the witmproxy service (does not start it)
    Install {
        /// Skip confirmation prompts
        #[arg(short, long)]
        yes: bool,
    },
    /// Uninstall the witmproxy service
    Uninstall {
        /// Skip confirmation prompts
        #[arg(short, long)]
        yes: bool,
    },
    /// Start the witmproxy service
    Start,
    /// Stop the witmproxy service
    Stop,
    /// Restart the witmproxy service
    Restart,
    /// Show the status of the witmproxy service
    Status,
    /// Show the path to the daemon log file
    Logs {
        /// Follow the log output (like tail -f)
        #[arg(short, long)]
        follow: bool,
        /// Number of lines to show from the end
        #[arg(short, long, default_value = "50")]
        lines: usize,
    },
}

pub struct DaemonHandler {
    config: AppConfig,
    verbose: bool,
    plugin_dir: Option<PathBuf>,
    auto: bool,
}

impl DaemonHandler {
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
    /// Linux system service: /etc/witmproxy
    /// macOS / other: parent of cert_dir (~/.witmproxy)
    fn get_app_dir(&self) -> PathBuf {
        #[cfg(target_os = "linux")]
        {
            PathBuf::from("/etc/witmproxy")
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
    /// Linux system service: /var/log/witmproxy/witmproxy.log
    /// macOS / other: <app_dir>/witmproxy.log
    pub fn get_log_path(&self) -> PathBuf {
        #[cfg(target_os = "linux")]
        {
            PathBuf::from("/var/log/witmproxy").join(LOG_FILE_NAME)
        }
        #[cfg(not(target_os = "linux"))]
        {
            self.get_app_dir().join(LOG_FILE_NAME)
        }
    }

    /// Get the config file path
    fn get_config_path(&self) -> PathBuf {
        self.get_app_dir().join("config.toml")
    }

    pub async fn handle(&self, command: &DaemonCommands) -> Result<()> {
        match command {
            DaemonCommands::Install { yes } => self.install_service(*yes).await,
            DaemonCommands::Uninstall { yes } => self.uninstall_service(*yes).await,
            DaemonCommands::Start => self.start_service().await,
            DaemonCommands::Stop => self.stop_service().await,
            DaemonCommands::Restart => self.restart_service().await,
            DaemonCommands::Status => self.show_status().await,
            DaemonCommands::Logs { follow, lines } => self.show_logs(*follow, *lines).await,
        }
    }

    /// On Linux, require root for daemon management commands.
    #[cfg(target_os = "linux")]
    fn require_root() -> Result<()> {
        if std::process::Command::new("id")
            .arg("-u")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .is_none_or(|uid| uid.trim() != "0")
        {
            anyhow::bail!("This command must be run as root (use sudo)");
        }
        Ok(())
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
        Self::require_root()?;

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

        let manager = Self::get_manager()?;
        let label = Self::service_label();

        // Build service arguments
        let exe_path = Self::get_executable_path()?;
        let config_path = self.get_config_path();

        // Create app directory and log directory
        let app_dir = self.get_app_dir();
        std::fs::create_dir_all(&app_dir)?;
        let log_dir = self.get_log_path().parent().unwrap().to_path_buf();
        std::fs::create_dir_all(&log_dir)?;

        // Save the current configuration to the config file
        // This ensures settings like db_password are available to the daemon
        self.config
            .save(&config_path)
            .context("Failed to save configuration")?;
        info!("Configuration saved to {:?}", config_path);

        // Build arguments for the 'serve' subcommand
        let mut args: Vec<OsString> = vec![];

        // Add config path (always exists now since we saved it above)
        args.push("--config-path".into());
        args.push(config_path.into());

        // Forward verbose flag
        if self.verbose {
            args.push("--verbose".into());
        }

        // Forward plugin-dir (canonicalize to absolute path since the daemon's
        // working directory differs from the user's current directory)
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

        // Forward auto flag
        if self.auto {
            args.push("--auto".into());
        }

        // Add the serve subcommand
        args.push("serve".into());

        // Add log file path
        let log_path = self.get_log_path();
        args.push("--log-file".into());
        args.push(log_path.clone().into());

        info!("Installing service with executable: {:?}", exe_path);
        info!("Service arguments: {:?}", args);

        let install_ctx = ServiceInstallCtx {
            label: label.clone(),
            program: exe_path,
            args,
            contents: None, // Use default service file contents
            username: None, // Run as current user
            working_directory: Some(app_dir),
            environment: None,
            autostart: true, // Start on boot
            restart_policy: service_manager::RestartPolicy::OnFailure {
                delay_secs: Some(1),
            },
        };

        manager
            .install(install_ctx)
            .context("Failed to install service. On macOS, ensure ~/Library/LaunchAgents exists. On Linux, ensure you are running as root.")?;

        println!("✓ Service installed successfully.");
        println!("  Log file: {:?}", log_path);
        println!();
        println!("To start the service, run: witm daemon start");
        println!("To check status, run: witm daemon status");

        Ok(())
    }

    /// Uninstall the service
    pub async fn uninstall_service(&self, skip_confirm: bool) -> Result<()> {
        #[cfg(target_os = "linux")]
        Self::require_root()?;

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
        Self::require_root()?;

        let manager = Self::get_manager()?;
        let label = Self::service_label();

        manager
            .start(ServiceStartCtx { label })
            .context("Failed to start service")?;

        println!("✓ Service started.");
        println!("  To view logs: witm daemon logs -f");

        Ok(())
    }

    /// Stop the service
    pub async fn stop_service(&self) -> Result<()> {
        #[cfg(target_os = "linux")]
        Self::require_root()?;

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
        Self::require_root()?;

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
                let plist_path = dirs::home_dir().map(|h| {
                    h.join("Library/LaunchAgents")
                        .join(format!("{}.plist", SERVICE_LABEL))
                });
                if let Some(path) = plist_path {
                    return path.exists();
                }
            }

            #[cfg(target_os = "linux")]
            {
                // The service-manager crate converts dotted labels like "co.joinez.witmproxy"
                // to hyphenated filenames by stripping the first segment: "joinez-witmproxy.service"
                let label_parts: Vec<&str> = SERVICE_LABEL.split('.').collect();
                let systemd_name = if label_parts.len() > 1 {
                    label_parts[1..].join("-")
                } else {
                    SERVICE_LABEL.to_string()
                };

                let systemd_system_path =
                    PathBuf::from(format!("/etc/systemd/system/{}.service", systemd_name));

                if systemd_system_path.exists() {
                    return true;
                }
            }

            #[cfg(target_os = "windows")]
            {
                // On Windows, we'd need to query the service control manager
                // For now, just return false and let the install command handle it
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

    /// Show service status
    pub async fn show_status(&self) -> Result<()> {
        let is_installed = self.is_service_installed();

        if !is_installed {
            println!("Service status: Not installed");
            println!();
            println!("To install: witm daemon install");
            return Ok(());
        }

        println!("Service status: Installed");

        // Check if running by looking at the log file modification time or PID file
        // This is a simplified check - actual implementation would vary by platform
        let log_path = self.get_log_path();
        if log_path.exists() {
            if let Ok(metadata) = std::fs::metadata(&log_path)
                && let Ok(modified) = metadata.modified()
            {
                let duration = std::time::SystemTime::now()
                    .duration_since(modified)
                    .unwrap_or_default();
                if duration.as_secs() < 60 {
                    println!("Service appears to be: Running (log recently updated)");
                } else {
                    println!("Service appears to be: Stopped (log not recently updated)");
                }
            }
        } else {
            println!("Service appears to be: Stopped (no log file)");
        }

        println!();
        println!("Log file: {:?}", log_path);

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
        let log_path = self.get_log_path();

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
            for line in &all_lines[start..] {
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
