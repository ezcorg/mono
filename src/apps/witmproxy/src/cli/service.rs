#[cfg(target_os = "linux")]
use crate::config::TransparentProxyConfig;
use crate::config::{AppConfig, confique_app_config_layer::AppConfigLayer};
use anyhow::{Context, Result};
use clap::Subcommand;
use confique::Config;
use service_manager::{
    ServiceInstallCtx, ServiceLabel, ServiceManager, ServiceStartCtx, ServiceStopCtx,
    ServiceUninstallCtx,
};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use tracing::{error, info, warn};

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

#[derive(Subcommand)]
pub enum ServiceCommands {
    /// Install the witmproxy service (does not start it)
    Install {
        #[command(flatten)]
        options: Box<super::ProxyRunOptions>,

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

    pub async fn handle(&self, command: &ServiceCommands) -> Result<()> {
        match command {
            ServiceCommands::Install { .. } => {
                unreachable!("Install is handled directly by Cli::run()")
            }
            ServiceCommands::Uninstall { yes } => self.uninstall_service(*yes).await,
            ServiceCommands::Start => self.start_service().await,
            ServiceCommands::Stop => self.stop_service().await,
            ServiceCommands::Restart => self.restart_service().await,
            ServiceCommands::Status => self.show_status().await,
            ServiceCommands::Logs { follow, lines } => self.show_logs(*follow, *lines).await,
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
    pub async fn install_service(&self, layer: AppConfigLayer, skip_confirm: bool) -> Result<()> {
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

        // Create app directory with restricted permissions
        let app_dir = self.get_app_dir();
        std::fs::create_dir_all(&app_dir)?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // 0o700: owner (root) only — config, certs, db, and logs may contain sensitive data
            std::fs::set_permissions(&app_dir, std::fs::Permissions::from_mode(0o700))?;
        }

        // Build daemon config using confique layering:
        // CLI args → env vars → existing config file → defaults
        // This ensures CLI-provided values override existing config,
        // while preserving settings the user didn't explicitly set.
        let source_config_path = if config_path.exists() {
            config_path.clone()
        } else {
            // Fall back to the invoking user's home config.
            // Under sudo, $HOME may point to /root — use SUDO_USER to find
            // the real user's home directory instead.
            let home = std::env::var("SUDO_USER")
                .ok()
                .and_then(|user| {
                    // Look up the user's home dir from /etc/passwd
                    std::fs::read_to_string("/etc/passwd")
                        .ok()
                        .and_then(|passwd| {
                            passwd
                                .lines()
                                .find(|line| line.starts_with(&format!("{}:", user)))
                                .and_then(|line| line.split(':').nth(5))
                                .map(PathBuf::from)
                        })
                })
                .or_else(dirs::home_dir);
            home.map(|h| h.join(".witmproxy/config.toml"))
                .unwrap_or_default()
        };

        let mut builder = AppConfig::builder().preloaded(layer).env();
        if source_config_path.exists() {
            builder = builder.file(&source_config_path);
        }
        let mut config_to_save = match builder.load() {
            Ok(config) => config,
            Err(e) => {
                warn!(
                    "Could not build config from sources: {}, using resolved config",
                    e
                );
                self.config.clone()
            }
        };

        // Always use the daemon's standard paths regardless of source
        config_to_save.db.db_path = app_dir.join("witmproxy.db");
        config_to_save.tls.cert_dir = app_dir.join("certs");
        config_to_save
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
        println!("  To view logs: witm service logs -f");

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

    /// Show service status
    pub async fn show_status(&self) -> Result<()> {
        let is_installed = self.is_service_installed();

        if !is_installed {
            println!("Service status: Not installed");
            println!();
            println!("To install: witm service install");
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
                "--config-path".into(),
                "/etc/witm.toml".into(),
                "serve".into(),
            ],
            Path::new("/var/lib/witmproxy"),
            &default_transparent_config(),
        );

        assert!(unit.contains("[Unit]"));
        assert!(unit.contains("[Service]"));
        assert!(unit.contains("[Install]"));
        assert!(unit.contains("ExecStart=/usr/bin/witm --config-path /etc/witm.toml serve"));
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
