use super::Services;
use crate::config::AppConfig;
use anyhow::Result;
use clap::Subcommand;
use std::path::PathBuf;
use std::process::Command;
use tracing::{info, warn};
#[cfg(target_os = "macos")]
use tracing::{error};

#[derive(Subcommand)]
pub enum ProxyCommands {
    /// Enable system HTTP proxy to route through witmproxy
    Enable {
        /// Show what would be done without actually doing it
        #[arg(short = 'n', long)]
        dry_run: bool,
    },
    /// Disable system HTTP proxy
    Disable {
        /// Show what would be done without actually doing it
        #[arg(short = 'n', long)]
        dry_run: bool,
    },
    /// Show current proxy status
    Status,
}

pub struct ProxyHandler {
    config: AppConfig,
}

impl ProxyHandler {
    pub fn new(config: AppConfig) -> Self {
        Self { config }
    }

    pub async fn handle(&self, command: &ProxyCommands) -> Result<()> {
        match command {
            ProxyCommands::Enable { dry_run } => self.enable_proxy(*dry_run).await,
            ProxyCommands::Disable { dry_run } => self.disable_proxy(*dry_run).await,
            ProxyCommands::Status => self.show_proxy_status().await,
        }
    }

    async fn enable_proxy(&self, dry_run: bool) -> Result<()> {
        let proxy_url = self.get_proxy_url().await?;

        if dry_run {
            println!("Would enable system proxy with URL: {}", proxy_url);
            return Ok(());
        }

        println!(
            "This will configure your system to proxy HTTP traffic through: {}",
            proxy_url
        );
        warn!("This action requires administrator privileges and may prompt for your password.");

        info!("Enabling system proxy: {}", proxy_url);
        self.set_system_proxy(&proxy_url, true).await?;
        println!("System proxy enabled: {}", proxy_url);
        Ok(())
    }

    async fn disable_proxy(&self, dry_run: bool) -> Result<()> {
        if dry_run {
            println!("Would disable system proxy");
            return Ok(());
        }

        println!("This will disable your system HTTP proxy settings.");
        warn!("This action requires administrator privileges and may prompt for your password.");

        info!("Disabling system proxy");
        self.set_system_proxy("", false).await?;
        println!("System proxy disabled");
        Ok(())
    }

    /// Internal method for enabling proxy without warning messages (used by --auto mode)
    pub async fn enable_proxy_internal(&self, dry_run: bool) -> Result<()> {
        let proxy_url = self.get_proxy_url().await?;

        if dry_run {
            info!("Would enable system proxy with URL: {}", proxy_url);
            return Ok(());
        }

        info!("Enabling system proxy: {}", proxy_url);
        self.set_system_proxy(&proxy_url, true).await?;
        info!("System proxy enabled: {}", proxy_url);
        Ok(())
    }

    /// Internal method for disabling proxy without warning messages (used by --auto mode)
    pub async fn disable_proxy_internal(&self, dry_run: bool) -> Result<()> {
        if dry_run {
            info!("Would disable system proxy");
            return Ok(());
        }

        info!("Disabling system proxy");
        self.set_system_proxy("", false).await?;
        info!("System proxy disabled");
        Ok(())
    }

    async fn show_proxy_status(&self) -> Result<()> {
        match self.get_current_system_proxy().await {
            Ok(Some(proxy)) => {
                println!("System proxy is enabled: {}", proxy);
                // Check if it matches our proxy
                if let Ok(our_proxy) = self.get_proxy_url().await {
                    if proxy.contains(&our_proxy) {
                        println!("✓ Currently using witmproxy");
                    } else {
                        println!("⚠ Using different proxy (not witmproxy)");
                    }
                }
            }
            Ok(None) => println!("System proxy is disabled"),
            Err(e) => {
                warn!("Could not determine proxy status: {}", e);
                println!("Proxy status unknown");
            }
        }
        Ok(())
    }

    async fn get_proxy_url(&self) -> Result<String> {
        // Get app directory from cert_dir parent
        let app_dir = self
            .config
            .tls
            .cert_dir
            .parent()
            .unwrap_or(&PathBuf::from("."))
            .to_path_buf();

        let services_path = app_dir.join("services.json");

        if !services_path.exists() {
            anyhow::bail!(
                "Services file not found at {:?}. Is witmproxy running?",
                services_path
            );
        }

        let services_content = std::fs::read_to_string(&services_path)?;
        let services: Services = serde_json::from_str(&services_content)?;

        // Format as HTTP proxy URL
        let proxy_url = if services.proxy.starts_with("http://") {
            services.proxy
        } else {
            format!("http://{}", services.proxy)
        };

        Ok(proxy_url)
    }

    async fn set_system_proxy(&self, proxy_url: &str, enable: bool) -> Result<()> {
        #[cfg(target_os = "macos")]
        {
            self.set_macos_proxy(proxy_url, enable).await
        }
        #[cfg(target_os = "linux")]
        {
            self.set_linux_proxy(proxy_url, enable).await
        }
        #[cfg(target_os = "windows")]
        {
            self.set_windows_proxy(proxy_url, enable).await
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        {
            anyhow::bail!("Proxy configuration not supported on this platform")
        }
    }

    async fn get_current_system_proxy(&self) -> Result<Option<String>> {
        #[cfg(target_os = "macos")]
        {
            self.get_macos_proxy().await
        }
        #[cfg(target_os = "linux")]
        {
            self.get_linux_proxy().await
        }
        #[cfg(target_os = "windows")]
        {
            self.get_windows_proxy().await
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        {
            anyhow::bail!("Proxy status check not supported on this platform")
        }
    }

    #[cfg(target_os = "macos")]
    async fn set_macos_proxy(&self, proxy_url: &str, enable: bool) -> Result<()> {
        // Get network services
        let output = Command::new("networksetup")
            .args(["-listallnetworkservices"])
            .output()?;

        if !output.status.success() {
            anyhow::bail!("Failed to list network services");
        }

        let services_output = String::from_utf8(output.stdout)?;
        let services: Vec<&str> = services_output
            .lines()
            .skip(1) // Skip header line
            .filter(|line| !line.starts_with('*')) // Skip disabled services
            .collect();

        if services.is_empty() {
            anyhow::bail!("No active network services found");
        }

        for service in services {
            info!("Configuring proxy for network service: {}", service);

            if enable {
                // Parse proxy URL to get host and port

                use anyhow::anyhow;
                let url_without_protocol = proxy_url.strip_prefix("http://").unwrap_or(proxy_url);
                let parts: Vec<&str> = url_without_protocol.split(':').collect();
                let host = parts[0];
                let port = parts
                    .get(1)
                    .ok_or_else(|| anyhow!("Missing port in proxy URL"))?
                    .to_string();

                // Enable HTTP proxy
                let status = Command::new("sudo")
                    .args(["networksetup", "-setwebproxy", service, host, &port])
                    .status()?;

                if !status.success() {
                    error!("Failed to set HTTP proxy for {}", service);
                    continue;
                }

                // Enable HTTPS proxy
                let status = Command::new("sudo")
                    .args(["networksetup", "-setsecurewebproxy", service, host, &port])
                    .status()?;

                if !status.success() {
                    error!("Failed to set HTTPS proxy for {}", service);
                    continue;
                }

                info!("Enabled proxy for {}", service);
            } else {
                // Disable HTTP proxy
                let status = Command::new("sudo")
                    .args(["networksetup", "-setwebproxystate", service, "off"])
                    .status()?;

                if !status.success() {
                    error!("Failed to disable HTTP proxy for {}", service);
                }

                // Disable HTTPS proxy
                let status = Command::new("sudo")
                    .args(["networksetup", "-setsecurewebproxystate", service, "off"])
                    .status()?;

                if !status.success() {
                    error!("Failed to disable HTTPS proxy for {}", service);
                }

                info!("Disabled proxy for {}", service);
            }
        }

        Ok(())
    }

    #[cfg(target_os = "macos")]
    async fn get_macos_proxy(&self) -> Result<Option<String>> {
        let output = Command::new("networksetup")
            .args(["-getwebproxy", "Wi-Fi"]) // Try Wi-Fi first
            .output()?;

        if !output.status.success() {
            return Ok(None);
        }

        let proxy_output = String::from_utf8(output.stdout)?;

        // Parse networksetup output
        let mut enabled = false;
        let mut server = String::new();
        let mut port = String::new();

        for line in proxy_output.lines() {
            if line.starts_with("Enabled: Yes") {
                enabled = true;
            } else if line.starts_with("Server: ") {
                server = line.strip_prefix("Server: ").unwrap_or("").to_string();
            } else if line.starts_with("Port: ") {
                port = line.strip_prefix("Port: ").unwrap_or("").to_string();
            }
        }

        if enabled && !server.is_empty() {
            Ok(Some(format!("http://{}:{}", server, port)))
        } else {
            Ok(None)
        }
    }

    #[cfg(target_os = "linux")]
    async fn set_linux_proxy(&self, proxy_url: &str, enable: bool) -> Result<()> {
        if enable {
            // Set environment variables via gsettings (GNOME)
            let _ = Command::new("gsettings")
                .args([
                    "set",
                    "org.gnome.system.proxy.http",
                    "host",
                    &proxy_url
                        .split("://")
                        .last()
                        .unwrap_or(proxy_url)
                        .split(':')
                        .next()
                        .unwrap_or(""),
                ])
                .status();

            let port = proxy_url.split(':').last().unwrap_or("8080");
            let _ = Command::new("gsettings")
                .args(["set", "org.gnome.system.proxy.http", "port", port])
                .status();

            let _ = Command::new("gsettings")
                .args(["set", "org.gnome.system.proxy", "mode", "manual"])
                .status();

            println!("Note: You may also need to set these environment variables:");
            println!("export http_proxy={}", proxy_url);
            println!("export https_proxy={}", proxy_url);
            println!("export HTTP_PROXY={}", proxy_url);
            println!("export HTTPS_PROXY={}", proxy_url);
        } else {
            let _ = Command::new("gsettings")
                .args(["set", "org.gnome.system.proxy", "mode", "none"])
                .status();

            println!("Note: You may also need to unset these environment variables:");
            println!("unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY");
        }

        Ok(())
    }

    #[cfg(target_os = "linux")]
    async fn get_linux_proxy(&self) -> Result<Option<String>> {
        let output = Command::new("gsettings")
            .args(["get", "org.gnome.system.proxy", "mode"])
            .output();

        if let Ok(output) = output {
            let mode = String::from_utf8_lossy(&output.stdout);
            if mode.trim().contains("manual") {
                let host_output = Command::new("gsettings")
                    .args(["get", "org.gnome.system.proxy.http", "host"])
                    .output()?;
                let port_output = Command::new("gsettings")
                    .args(["get", "org.gnome.system.proxy.http", "port"])
                    .output()?;

                let host = String::from_utf8_lossy(&host_output.stdout)
                    .trim()
                    .trim_matches('\'')
                    .to_string();
                let port = String::from_utf8_lossy(&port_output.stdout)
                    .trim()
                    .to_string();

                if !host.is_empty() && host != "''" {
                    return Ok(Some(format!("http://{}:{}", host, port)));
                }
            }
        }

        // Also check environment variables
        if let Ok(proxy) = std::env::var("http_proxy") {
            return Ok(Some(proxy));
        }

        Ok(None)
    }

    #[cfg(target_os = "windows")]
    async fn set_windows_proxy(&self, proxy_url: &str, enable: bool) -> Result<()> {
        if enable {
            let proxy_server = proxy_url.strip_prefix("http://").unwrap_or(proxy_url);

            // Enable proxy via registry
            let status = Command::new("reg")
                .args([
                    "add",
                    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
                    "/v",
                    "ProxyEnable",
                    "/t",
                    "REG_DWORD",
                    "/d",
                    "1",
                    "/f",
                ])
                .status()?;

            if !status.success() {
                anyhow::bail!("Failed to enable proxy in registry");
            }

            let status = Command::new("reg")
                .args([
                    "add",
                    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
                    "/v",
                    "ProxyServer",
                    "/t",
                    "REG_SZ",
                    "/d",
                    proxy_server,
                    "/f",
                ])
                .status()?;

            if !status.success() {
                anyhow::bail!("Failed to set proxy server in registry");
            }
        } else {
            let status = Command::new("reg")
                .args([
                    "add",
                    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
                    "/v",
                    "ProxyEnable",
                    "/t",
                    "REG_DWORD",
                    "/d",
                    "0",
                    "/f",
                ])
                .status()?;

            if !status.success() {
                anyhow::bail!("Failed to disable proxy in registry");
            }
        }

        Ok(())
    }

    #[cfg(target_os = "windows")]
    async fn get_windows_proxy(&self) -> Result<Option<String>> {
        let output = Command::new("reg")
            .args([
                "query",
                "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
                "/v",
                "ProxyEnable",
            ])
            .output()?;

        if output.status.success() {
            let reg_output = String::from_utf8_lossy(&output.stdout);
            if reg_output.contains("0x1") {
                // Proxy is enabled, get the server
                let server_output = Command::new("reg")
                    .args([
                        "query",
                        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
                        "/v",
                        "ProxyServer",
                    ])
                    .output()?;

                if server_output.status.success() {
                    let server_reg = String::from_utf8_lossy(&server_output.stdout);
                    // Parse the registry output to extract proxy server
                    for line in server_reg.lines() {
                        if line.contains("ProxyServer") && line.contains("REG_SZ") {
                            if let Some(server) = line.split_whitespace().last() {
                                return Ok(Some(format!("http://{}", server)));
                            }
                        }
                    }
                }
            }
        }

        Ok(None)
    }
}
