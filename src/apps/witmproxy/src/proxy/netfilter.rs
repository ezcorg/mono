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

    /// Returns the iptables commands needed to remove all witmproxy redirect rules.
    /// Used by both runtime teardown() and systemd ExecStopPost generation.
    pub fn cleanup_commands(interface: &str, redirect_port: u16) -> Vec<(String, Vec<String>)> {
        let port = redirect_port.to_string();
        vec![
            // PREROUTING rules (traffic from other machines on the interface)
            (
                "iptables".into(),
                vec![
                    "-t",
                    "nat",
                    "-D",
                    "PREROUTING",
                    "-i",
                    interface,
                    "-p",
                    "tcp",
                    "--dport",
                    "80",
                    "-j",
                    "REDIRECT",
                    "--to-port",
                    &port,
                ]
                .into_iter()
                .map(String::from)
                .collect(),
            ),
            (
                "iptables".into(),
                vec![
                    "-t",
                    "nat",
                    "-D",
                    "PREROUTING",
                    "-i",
                    interface,
                    "-p",
                    "tcp",
                    "--dport",
                    "443",
                    "-j",
                    "REDIRECT",
                    "--to-port",
                    &port,
                ]
                .into_iter()
                .map(String::from)
                .collect(),
            ),
            (
                "ip6tables".into(),
                vec![
                    "-t",
                    "nat",
                    "-D",
                    "PREROUTING",
                    "-i",
                    interface,
                    "-p",
                    "tcp",
                    "--dport",
                    "80",
                    "-j",
                    "REDIRECT",
                    "--to-port",
                    &port,
                ]
                .into_iter()
                .map(String::from)
                .collect(),
            ),
            (
                "ip6tables".into(),
                vec![
                    "-t",
                    "nat",
                    "-D",
                    "PREROUTING",
                    "-i",
                    interface,
                    "-p",
                    "tcp",
                    "--dport",
                    "443",
                    "-j",
                    "REDIRECT",
                    "--to-port",
                    &port,
                ]
                .into_iter()
                .map(String::from)
                .collect(),
            ),
            // OUTPUT rules (locally-originated traffic, excluding root/proxy to avoid loops)
            (
                "iptables".into(),
                vec![
                    "-t",
                    "nat",
                    "-D",
                    "OUTPUT",
                    "-p",
                    "tcp",
                    "--dport",
                    "80",
                    "-m",
                    "owner",
                    "!",
                    "--uid-owner",
                    "0",
                    "-j",
                    "DNAT",
                    "--to-destination",
                    &format!("127.0.0.1:{}", port),
                ]
                .into_iter()
                .map(String::from)
                .collect(),
            ),
            (
                "iptables".into(),
                vec![
                    "-t",
                    "nat",
                    "-D",
                    "OUTPUT",
                    "-p",
                    "tcp",
                    "--dport",
                    "443",
                    "-m",
                    "owner",
                    "!",
                    "--uid-owner",
                    "0",
                    "-j",
                    "DNAT",
                    "--to-destination",
                    &format!("127.0.0.1:{}", port),
                ]
                .into_iter()
                .map(String::from)
                .collect(),
            ),
            (
                "ip6tables".into(),
                vec![
                    "-t",
                    "nat",
                    "-D",
                    "OUTPUT",
                    "-p",
                    "tcp",
                    "--dport",
                    "80",
                    "-m",
                    "owner",
                    "!",
                    "--uid-owner",
                    "0",
                    "-j",
                    "DNAT",
                    "--to-destination",
                    &format!("[::1]:{}", port),
                ]
                .into_iter()
                .map(String::from)
                .collect(),
            ),
            (
                "ip6tables".into(),
                vec![
                    "-t",
                    "nat",
                    "-D",
                    "OUTPUT",
                    "-p",
                    "tcp",
                    "--dport",
                    "443",
                    "-m",
                    "owner",
                    "!",
                    "--uid-owner",
                    "0",
                    "-j",
                    "DNAT",
                    "--to-destination",
                    &format!("[::1]:{}", port),
                ]
                .into_iter()
                .map(String::from)
                .collect(),
            ),
            // QUIC/HTTP3 block rules (DROP UDP 443 to force TCP fallback through proxy)
            // OUTPUT: locally-originated traffic (excluding root/proxy)
            (
                "iptables".into(),
                vec![
                    "-D",
                    "OUTPUT",
                    "-p",
                    "udp",
                    "--dport",
                    "443",
                    "-m",
                    "owner",
                    "!",
                    "--uid-owner",
                    "0",
                    "-j",
                    "DROP",
                ]
                .into_iter()
                .map(String::from)
                .collect(),
            ),
            (
                "ip6tables".into(),
                vec![
                    "-D",
                    "OUTPUT",
                    "-p",
                    "udp",
                    "--dport",
                    "443",
                    "-m",
                    "owner",
                    "!",
                    "--uid-owner",
                    "0",
                    "-j",
                    "DROP",
                ]
                .into_iter()
                .map(String::from)
                .collect(),
            ),
            // FORWARD: traffic from remote clients (e.g. phones using this machine as exit node)
            (
                "iptables".into(),
                vec![
                    "-D", "FORWARD", "-i", interface, "-p", "udp", "--dport", "443", "-j", "DROP",
                ]
                .into_iter()
                .map(String::from)
                .collect(),
            ),
            (
                "ip6tables".into(),
                vec![
                    "-D", "FORWARD", "-i", interface, "-p", "udp", "--dport", "443", "-j", "DROP",
                ]
                .into_iter()
                .map(String::from)
                .collect(),
            ),
        ]
    }

    /// Set up iptables rules to redirect HTTP/HTTPS traffic to the transparent proxy.
    /// Adds both PREROUTING rules (for traffic from other machines on the interface)
    /// and OUTPUT rules (for locally-originated traffic, excluding root to avoid loops).
    pub fn setup(&mut self) -> Result<()> {
        info!(
            "Setting up iptables rules: interface={}, redirect_port={}",
            self.interface, self.redirect_port,
        );

        let port = self.redirect_port.to_string();

        // PREROUTING rules: intercept traffic arriving on the specified interface
        let prerouting_rules = [
            ("iptables", "80"),
            ("iptables", "443"),
            ("ip6tables", "80"),
            ("ip6tables", "443"),
        ];

        for (cmd, dport) in &prerouting_rules {
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
                Ok(s) if s.success() => info!("{} PREROUTING rule added for port {}", cmd, dport),
                Ok(s) => warn!("{} PREROUTING rule for port {} failed: {}", cmd, dport, s),
                Err(e) => warn!("Failed to execute {}: {}", cmd, e),
            }
        }

        // OUTPUT rules: intercept locally-originated traffic.
        // Exclude uid 0 (root) since the proxy runs as root — without this
        // exclusion the proxy's own upstream connections would loop back.
        // Use DNAT instead of REDIRECT on the OUTPUT chain for reliable
        // interception on nftables-backed iptables.
        let output_rules = [
            ("iptables", "80", "127.0.0.1"),
            ("iptables", "443", "127.0.0.1"),
            ("ip6tables", "80", "[::1]"),
            ("ip6tables", "443", "[::1]"),
        ];

        for (cmd, dport, loopback) in &output_rules {
            let dest = format!("{}:{}", loopback, port);
            let status = Command::new(cmd)
                .args([
                    "-t",
                    "nat",
                    "-I",
                    "OUTPUT",
                    "1",
                    "-p",
                    "tcp",
                    "--dport",
                    dport,
                    "-m",
                    "owner",
                    "!",
                    "--uid-owner",
                    "0",
                    "-j",
                    "DNAT",
                    "--to-destination",
                    &dest,
                ])
                .status();

            match status {
                Ok(s) if s.success() => info!("{} OUTPUT rule added for port {}", cmd, dport),
                Ok(s) => warn!("{} OUTPUT rule for port {} failed: {}", cmd, dport, s),
                Err(e) => warn!("Failed to execute {}: {}", cmd, e),
            }
        }

        // Block QUIC/HTTP3 (UDP port 443) to force browsers to fall back to TCP,
        // which the transparent proxy can intercept. Without this, browsers like
        // Chrome cache QUIC support for domains and bypass the proxy entirely.
        //
        // OUTPUT rules handle locally-originated traffic.
        // FORWARD rules handle traffic from remote clients (e.g. phones routing
        // through this machine as a Tailscale exit node).
        let quic_block_rules = [("iptables", "443"), ("ip6tables", "443")];

        for (cmd, dport) in &quic_block_rules {
            // OUTPUT: local traffic (exclude root to avoid blocking proxy's own connections)
            let status = Command::new(cmd)
                .args([
                    "-I",
                    "OUTPUT",
                    "1",
                    "-p",
                    "udp",
                    "--dport",
                    dport,
                    "-m",
                    "owner",
                    "!",
                    "--uid-owner",
                    "0",
                    "-j",
                    "DROP",
                ])
                .status();

            match status {
                Ok(s) if s.success() => {
                    info!("{} QUIC block rule added for OUTPUT (UDP {})", cmd, dport)
                }
                Ok(s) => warn!(
                    "{} QUIC block rule for OUTPUT UDP {} failed: {}",
                    cmd, dport, s
                ),
                Err(e) => warn!("Failed to execute {} for QUIC block: {}", cmd, e),
            }

            // FORWARD: remote client traffic arriving on the proxy interface
            let status = Command::new(cmd)
                .args([
                    "-I",
                    "FORWARD",
                    "1",
                    "-i",
                    &self.interface,
                    "-p",
                    "udp",
                    "--dport",
                    dport,
                    "-j",
                    "DROP",
                ])
                .status();

            match status {
                Ok(s) if s.success() => {
                    info!("{} QUIC block rule added for FORWARD (UDP {})", cmd, dport)
                }
                Ok(s) => warn!(
                    "{} QUIC block rule for FORWARD UDP {} failed: {}",
                    cmd, dport, s
                ),
                Err(e) => warn!("Failed to execute {} for FORWARD QUIC block: {}", cmd, e),
            }
        }

        // Flush conntrack to ensure stale NAT entries don't prevent new rules from taking effect
        for flush_cmd in [
            // Try conntrack tool first
            vec!["conntrack", "-F"],
            // Alternative: flush via /proc
            vec![
                "sh",
                "-c",
                "echo 1 > /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || true",
            ],
        ] {
            match Command::new(flush_cmd[0]).args(&flush_cmd[1..]).status() {
                Ok(s) if s.success() => {
                    info!("Flushed conntrack table via {}", flush_cmd[0]);
                    break;
                }
                _ => {}
            }
        }

        // Dump the current OUTPUT chain for diagnostics — both iptables and raw nft views
        for cmd in ["iptables", "ip6tables"] {
            match Command::new(cmd)
                .args(["-t", "nat", "-L", "OUTPUT", "-n", "-v", "--line-numbers"])
                .output()
            {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    info!("{} nat OUTPUT chain after setup:\n{}", cmd, stdout);
                }
                Err(e) => warn!("Failed to list {} OUTPUT chain: {}", cmd, e),
            }
        }
        // Raw nft view — shows actual chain hook/priority and rule handles
        for family in ["ip", "ip6"] {
            match Command::new("nft")
                .args(["-a", "list", "chain", family, "nat", "OUTPUT"])
                .output()
            {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    info!("nft {} nat OUTPUT chain:\n{}", family, stdout);
                }
                Err(e) => warn!("Failed to list nft {} nat OUTPUT: {}", family, e),
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

        for (cmd, args) in Self::cleanup_commands(&self.interface, self.redirect_port) {
            let status = Command::new(&cmd).args(&args).status();

            // Extract dport from args for logging (it's the arg after "--dport")
            let dport = args
                .iter()
                .zip(args.iter().skip(1))
                .find(|(a, _)| a.as_str() == "--dport")
                .map(|(_, b)| b.as_str())
                .unwrap_or("?");

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_commands_match_setup_rules() {
        let commands = NetfilterManager::cleanup_commands("tailscale0", 8080);
        // 4 PREROUTING + 4 OUTPUT DNAT + 2 OUTPUT QUIC block + 2 FORWARD QUIC block = 12 total
        assert_eq!(commands.len(), 12);

        // All commands should use -D (delete)
        for (_, args) in &commands {
            assert!(args.contains(&"-D".to_string()));
        }

        let prerouting: Vec<_> = commands
            .iter()
            .filter(|(_, a)| a.contains(&"PREROUTING".to_string()))
            .collect();
        let output: Vec<_> = commands
            .iter()
            .filter(|(_, a)| a.contains(&"OUTPUT".to_string()))
            .collect();
        let forward: Vec<_> = commands
            .iter()
            .filter(|(_, a)| a.contains(&"FORWARD".to_string()))
            .collect();
        assert_eq!(prerouting.len(), 4);
        assert_eq!(output.len(), 6); // 4 DNAT + 2 QUIC DROP
        assert_eq!(forward.len(), 2); // 2 QUIC DROP for remote clients

        // PREROUTING rules should reference the interface
        for (_, args) in &prerouting {
            assert!(args.contains(&"tailscale0".to_string()));
        }

        // FORWARD QUIC rules should reference the interface and DROP UDP
        for (_, args) in &forward {
            assert!(args.contains(&"tailscale0".to_string()));
            assert!(args.contains(&"DROP".to_string()));
            assert!(args.contains(&"udp".to_string()));
        }

        // OUTPUT DNAT rules should have owner match and DNAT
        let output_dnat: Vec<_> = commands
            .iter()
            .filter(|(_, a)| a.contains(&"DNAT".to_string()))
            .collect();
        assert_eq!(output_dnat.len(), 4);
        for (_, args) in &output_dnat {
            assert!(args.contains(&"owner".to_string()));
        }

        // QUIC block rules should DROP UDP 443 (OUTPUT + FORWARD = 4 total)
        let quic_rules: Vec<_> = commands
            .iter()
            .filter(|(_, a)| a.contains(&"udp".to_string()))
            .collect();
        assert_eq!(quic_rules.len(), 4);
        for (_, args) in &quic_rules {
            assert!(args.contains(&"DROP".to_string()));
            assert!(args.contains(&"443".to_string()));
        }

        // TCP rules should reference port 8080 (either as --to-port or in --to-destination)
        let tcp_rules: Vec<_> = commands
            .iter()
            .filter(|(_, a)| !a.contains(&"udp".to_string()))
            .collect();
        for (_, args) in &tcp_rules {
            assert!(
                args.iter().any(|a| a.contains("8080")),
                "missing port 8080 in args: {:?}",
                args,
            );
        }
    }

    #[test]
    fn cleanup_commands_with_custom_values() {
        let commands = NetfilterManager::cleanup_commands("eth0", 9090);
        assert_eq!(commands.len(), 12);
        // PREROUTING rules use interface, OUTPUT rules don't
        let prerouting: Vec<_> = commands
            .iter()
            .filter(|(_, a)| a.contains(&"PREROUTING".to_string()))
            .collect();
        for (_, args) in &prerouting {
            assert!(args.contains(&"eth0".to_string()));
        }
        let tcp_rules: Vec<_> = commands
            .iter()
            .filter(|(_, a)| !a.contains(&"udp".to_string()))
            .collect();
        for (_, args) in &tcp_rules {
            assert!(
                args.iter().any(|a| a.contains("9090")),
                "missing port 9090 in args: {:?}",
                args,
            );
        }
    }
}
