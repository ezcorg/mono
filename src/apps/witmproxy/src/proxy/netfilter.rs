use std::process::Command;

use anyhow::Result;
use tracing::{info, warn};

/// Manages iptables/nftables rules for transparent proxy mode.
/// Redirects incoming traffic on a specified interface to the transparent proxy listener.
///
/// The service runs as root (system service), so iptables commands are executed directly.
pub struct NetfilterManager {
    interface: String,
    redirect_port: u16,
    active: bool,
}

impl NetfilterManager {
    pub fn new(interface: String, redirect_port: u16) -> Self {
        Self {
            interface,
            redirect_port,
            active: false,
        }
    }

    /// Set up iptables rules to redirect HTTP/HTTPS traffic to the transparent proxy.
    pub fn setup(&mut self) -> Result<()> {
        info!(
            "Setting up iptables rules: interface={}, redirect_port={}",
            self.interface, self.redirect_port,
        );

        let port = self.redirect_port.to_string();
        let rules = [
            // IPv4
            ("iptables", "80"),
            ("iptables", "443"),
            // IPv6
            ("ip6tables", "80"),
            ("ip6tables", "443"),
        ];

        for (cmd, dport) in &rules {
            let status = Command::new(cmd)
                .args([
                    "-t",
                    "nat",
                    "-A",
                    "PREROUTING",
                    "-i",
                    &self.interface,
                    "-p",
                    "tcp",
                    "--dport",
                    dport,
                    "-j",
                    "REDIRECT",
                    "--to-port",
                    &port,
                ])
                .status();

            match status {
                Ok(s) if s.success() => {
                    info!("{} PREROUTING rule added for port {}", cmd, dport);
                }
                Ok(s) => {
                    warn!(
                        "{} PREROUTING rule for port {} failed with status: {}",
                        cmd, dport, s
                    );
                }
                Err(e) => {
                    warn!("Failed to execute {}: {}", cmd, e);
                }
            }
        }

        self.active = true;
        Ok(())
    }

    /// Remove the iptables rules added by setup().
    pub fn teardown(&mut self) -> Result<()> {
        if !self.active {
            return Ok(());
        }

        info!(
            "Tearing down iptables rules: interface={}, redirect_port={}",
            self.interface, self.redirect_port,
        );

        let port = self.redirect_port.to_string();
        let rules = [
            ("iptables", "80"),
            ("iptables", "443"),
            ("ip6tables", "80"),
            ("ip6tables", "443"),
        ];

        for (cmd, dport) in &rules {
            let status = Command::new(cmd)
                .args([
                    "-t",
                    "nat",
                    "-D",
                    "PREROUTING",
                    "-i",
                    &self.interface,
                    "-p",
                    "tcp",
                    "--dport",
                    dport,
                    "-j",
                    "REDIRECT",
                    "--to-port",
                    &port,
                ])
                .status();

            match status {
                Ok(s) if s.success() => {
                    info!("{} PREROUTING rule removed for port {}", cmd, dport);
                }
                Ok(s) => {
                    warn!(
                        "{} PREROUTING rule removal for port {} failed with status: {}",
                        cmd, dport, s
                    );
                }
                Err(e) => {
                    warn!("Failed to execute {} for teardown: {}", cmd, e);
                }
            }
        }

        self.active = false;
        Ok(())
    }
}

impl Drop for NetfilterManager {
    fn drop(&mut self) {
        if self.active {
            let _ = self.teardown();
        }
    }
}
