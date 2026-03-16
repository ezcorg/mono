use std::net::SocketAddr;
use std::process::Command;

use serde::Deserialize;
use tracing::{debug, info, warn};

#[derive(Debug)]
pub struct TailscaleInfo {
    pub ipv4: Option<String>,
    pub ipv6: Option<String>,
    pub dns_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct TailscaleStatus {
    backend_state: Option<String>,
    #[serde(rename = "Self")]
    self_node: Option<TailscaleSelfNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct TailscaleSelfNode {
    #[serde(rename = "TailscaleIPs")]
    tailscale_ips: Option<Vec<String>>,
    #[serde(rename = "DNSName")]
    dns_name: Option<String>,
}

/// Detect Tailscale and return info about this node, or None if unavailable.
fn detect_tailscale() -> Option<TailscaleInfo> {
    let output = match Command::new("tailscale")
        .args(["status", "--json"])
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            debug!("tailscale binary not found or not executable: {}", e);
            return None;
        }
    };

    if !output.status.success() {
        debug!(
            "tailscale status exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        return None;
    }

    let status: TailscaleStatus = match serde_json::from_slice(&output.stdout) {
        Ok(s) => s,
        Err(e) => {
            debug!("Failed to parse tailscale status JSON: {}", e);
            return None;
        }
    };

    if status.backend_state.as_deref() != Some("Running") {
        debug!(
            "Tailscale backend not running (state: {:?})",
            status.backend_state
        );
        return None;
    }

    let node = status.self_node?;
    let ips = node.tailscale_ips.unwrap_or_default();

    let ipv4 = ips.iter().find(|ip| ip.contains('.')).cloned();
    let ipv6 = ips.iter().find(|ip| ip.contains(':')).cloned();
    let dns_name = node.dns_name.map(|n| n.trim_end_matches('.').to_string());

    if ipv4.is_none() && ipv6.is_none() {
        debug!("Tailscale running but no IPs assigned");
        return None;
    }

    Some(TailscaleInfo {
        ipv4,
        ipv6,
        dns_name,
    })
}

/// Check whether a TCP connection to the given address succeeds (i.e. no firewall block).
async fn check_reachable(ip: &str, port: u16) -> bool {
    let addr = format!("{}:{}", ip, port);
    match tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::net::TcpStream::connect(&addr),
    )
    .await
    {
        Ok(Ok(_)) => true,
        Ok(Err(e)) => {
            debug!("TCP connect to {} failed: {}", addr, e);
            false
        }
        Err(_) => {
            debug!("TCP connect to {} timed out", addr);
            false
        }
    }
}

/// Detect Tailscale, verify the web server is reachable over it, and display
/// a URL + QR code if everything checks out.
pub async fn discover_and_display(web_addr: SocketAddr) -> Option<TailscaleInfo> {
    let info = detect_tailscale()?;
    debug!("Tailscale detected: {:?}", info);

    let port = web_addr.port();

    // Pick the best address: DNS name > IPv4 > IPv6
    let host = info
        .dns_name
        .as_deref()
        .or(info.ipv4.as_deref())
        .or(info.ipv6.as_deref())?;

    // Check reachability using the raw IP (DNS may not resolve locally)
    let check_ip = info.ipv4.as_deref().or(info.ipv6.as_deref())?;
    let reachable = check_reachable(check_ip, port).await;

    if !reachable {
        warn!(
            "Tailscale detected but web server is not reachable at {}:{}",
            check_ip, port
        );
        if web_addr.ip().is_loopback() {
            warn!("The web server is bound to {} (localhost only)", web_addr);
            warn!(
                "To make it accessible over Tailscale, set web_bind_addr = \"0.0.0.0:0\" in your config"
            );
        } else {
            warn!("Check that no firewall is blocking port {}", port);
        }
        return Some(info);
    }

    let cert_url = format!("https://{}:{}/cert", host, port);

    info!(
        "Tailscale: install the CA certificate on other devices by visiting: {}",
        cert_url
    );
    match qrcode::QrCode::new(&cert_url) {
        Ok(code) => {
            let qr = code
                .render::<char>()
                .quiet_zone(true)
                .module_dimensions(2, 1)
                .build();
            info!("Scan to install CA certificate:\n{}", qr);
        }
        Err(e) => debug!("Failed to render QR code: {}", e),
    }

    Some(info)
}
