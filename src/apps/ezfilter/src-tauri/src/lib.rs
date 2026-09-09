use serde::Serialize;
use std::process::Command;
use std::sync::Mutex;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

pub struct MetricsState {
    system: Mutex<System>,
}

impl Default for MetricsState {
    fn default() -> Self {
        Self {
            system: Mutex::new(System::new()),
        }
    }
}

#[derive(Serialize)]
pub struct ProcessMetrics {
    pub cpu_percent: f32,
    pub mem_bytes: u64,
}

/// Sample CPU% and resident memory of the current process. CPU% is based on
/// the delta since the previous call, so the first call typically returns 0.
#[tauri::command]
fn get_process_metrics(state: tauri::State<'_, MetricsState>) -> ProcessMetrics {
    let pid = Pid::from_u32(std::process::id());
    let mut sys = state.system.lock().unwrap();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_cpu().with_memory(),
    );
    let cpu_count = sys.cpus().len().max(1) as f32;
    if let Some(proc_) = sys.process(pid) {
        ProcessMetrics {
            cpu_percent: proc_.cpu_usage() / cpu_count,
            mem_bytes: proc_.memory(),
        }
    } else {
        ProcessMetrics {
            cpu_percent: 0.0,
            mem_bytes: 0,
        }
    }
}

#[derive(Serialize)]
pub struct BinaryCheckResult {
    pub found: bool,
    pub path: Option<String>,
}

/// Check if a binary exists on the system PATH.
#[tauri::command]
fn check_binary(name: String) -> BinaryCheckResult {
    match which::which(&name) {
        Ok(path) => BinaryCheckResult {
            found: true,
            path: Some(path.to_string_lossy().to_string()),
        },
        Err(_) => BinaryCheckResult {
            found: false,
            path: None,
        },
    }
}

/// Validate that a given path is a witmproxy binary by running `<path> version`.
#[tauri::command]
fn validate_binary(path: String) -> BinaryCheckResult {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return BinaryCheckResult {
            found: false,
            path: None,
        };
    }
    match Command::new(&path).arg("version").output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            BinaryCheckResult {
                found: stdout.contains("witmproxy"),
                path: Some(path),
            }
        }
        Err(_) => BinaryCheckResult {
            found: false,
            path: None,
        },
    }
}

#[derive(Serialize)]
pub struct StepResult {
    pub success: bool,
    pub already_done: bool,
    pub message: String,
}

/// Run a command that may require elevated privileges.
/// Tries pkexec first (graphical sudo prompt on Linux), falls back to direct execution.
fn run_privileged(binary_path: &str, args: &[&str]) -> std::io::Result<std::process::Output> {
    // Try pkexec first for a graphical privilege prompt
    if cfg!(target_os = "linux") {
        if let Ok(output) = Command::new("pkexec").arg(binary_path).args(args).output() {
            // pkexec returns 126 if the user dismissed the dialog, 127 if not found
            if output.status.code() != Some(126) && output.status.code() != Some(127) {
                return Ok(output);
            }
        }
    }
    // Fall back to direct execution (works if already root or on macOS where
    // witmproxy commands handle their own privilege escalation)
    Command::new(binary_path).args(args).output()
}

/// Check if the witmproxy service is running via `witm service status`.
/// This command requires elevated privileges to read the config.
#[tauri::command]
fn check_service_running(binary_path: String) -> StepResult {
    match run_privileged(&binary_path, &["service", "status"]) {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let combined = format!("{}{}", stdout, stderr);
            let running = combined.contains("Running");
            StepResult {
                success: running,
                already_done: running,
                message: if running {
                    "Service is running".to_string()
                } else {
                    stdout.trim().to_string()
                },
            }
        }
        Err(e) => StepResult {
            success: false,
            already_done: false,
            message: format!("Could not check service: {}", e),
        },
    }
}

/// Start the witmproxy service via `witm start`.
/// Requires elevated privileges.
#[tauri::command]
fn start_service(binary_path: String) -> StepResult {
    match run_privileged(&binary_path, &["start", "--detach"]) {
        Ok(output) => {
            let success = output.status.success();
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            StepResult {
                success,
                already_done: false,
                message: if success {
                    stdout.trim().to_string()
                } else {
                    stderr.trim().to_string()
                },
            }
        }
        Err(e) => StepResult {
            success: false,
            already_done: false,
            message: format!("Failed to start service: {}", e),
        },
    }
}

/// Check CA trust status via `witm ca status`, install if needed via `witm ca install`.
/// Both require elevated privileges to read the config and modify the system trust store.
#[tauri::command]
fn check_ca_status(binary_path: String) -> StepResult {
    match run_privileged(&binary_path, &["ca", "status"]) {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let combined = format!("{}{}", stdout, stderr);
            let installed = combined.contains("Installed") || combined.contains("Trusted");
            StepResult {
                success: installed,
                already_done: installed,
                message: if installed {
                    "CA is trusted".to_string()
                } else {
                    "CA is not yet trusted".to_string()
                },
            }
        }
        Err(e) => StepResult {
            success: false,
            already_done: false,
            message: format!("Could not check CA status: {}", e),
        },
    }
}

/// Install the CA certificate to the system trust store via `witm ca install`.
#[tauri::command]
fn install_ca(binary_path: String) -> StepResult {
    match run_privileged(&binary_path, &["ca", "install"]) {
        Ok(output) => {
            let success = output.status.success();
            let stderr = String::from_utf8_lossy(&output.stderr);
            StepResult {
                success,
                already_done: false,
                message: if success {
                    "CA certificate installed and trusted".to_string()
                } else {
                    format!("Failed: {}", stderr.trim())
                },
            }
        }
        Err(e) => StepResult {
            success: false,
            already_done: false,
            message: format!("Failed to install CA: {}", e),
        },
    }
}

/// Discover the witmproxy web server URL by reading its services.json file.
/// The services.json is written by witmproxy on startup next to the cert directory.
#[tauri::command]
fn discover_server_url(binary_path: String) -> DiscoverResult {
    let candidates: Vec<std::path::PathBuf> = vec![
        // User home dir (most likely readable without sudo)
        dirs::home_dir()
            .unwrap_or_default()
            .join(".witmproxy/services.json"),
        // Linux system service (may need sudo)
        std::path::PathBuf::from("/var/lib/witmproxy/services.json"),
    ];

    for path in &candidates {
        if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok(services) = serde_json::from_str::<serde_json::Value>(&content) {
                let web = services
                    .get("web")
                    .and_then(|v| v.as_str())
                    .map(|addr| format_as_url(addr, "https"));
                let proxy = services
                    .get("proxy")
                    .and_then(|v| v.as_str())
                    .map(|addr| format_as_url(addr, "http"));
                if web.is_some() || proxy.is_some() {
                    return DiscoverResult { proxy, web };
                }
            }
        }
    }

    let _ = binary_path;
    DiscoverResult {
        proxy: None,
        web: None,
    }
}

/// Format a raw address (e.g. "0.0.0.0:9443") as a proper URL.
/// Replaces 0.0.0.0 with 127.0.0.1 and adds the protocol scheme.
fn format_as_url(addr: &str, scheme: &str) -> String {
    // Strip any existing scheme
    let bare = addr
        .strip_prefix("https://")
        .or_else(|| addr.strip_prefix("http://"))
        .unwrap_or(addr);
    // Replace 0.0.0.0 with localhost
    let normalized = bare.replace("0.0.0.0", "127.0.0.1");
    format!("{}://{}", scheme, normalized)
}

#[derive(Serialize)]
struct DiscoverResult {
    proxy: Option<String>,
    web: Option<String>,
}

/// Enable the system proxy by configuring the OS to route HTTP(S) traffic
/// through the given proxy URL. `bypass_hosts` are hostnames the OS should
/// reach directly instead of via the proxy (loopback, the management UI's
/// hostname, etc) — without these, the management UI loops through the
/// proxy and fails. Works directly without needing the `witm` binary.
#[tauri::command]
fn enable_proxy(proxy_url: String, bypass_hosts: Option<Vec<String>>) -> StepResult {
    set_system_proxy(&proxy_url, true, bypass_hosts.unwrap_or_default())
}

/// Disable the system proxy, restoring normal network operation.
#[tauri::command]
fn disable_proxy() -> StepResult {
    set_system_proxy("", false, Vec::new())
}

/// Check the current system proxy status.
#[tauri::command]
fn check_proxy_status() -> StepResult {
    match get_current_system_proxy() {
        Some(url) => StepResult {
            success: true,
            already_done: true,
            message: format!("System proxy is active: {}", url),
        },
        None => StepResult {
            success: false,
            already_done: false,
            message: "System proxy is not active".to_string(),
        },
    }
}

/// Set or unset the system HTTP/HTTPS proxy using platform-specific tools.
fn set_system_proxy(proxy_url: &str, enable: bool, bypass_hosts: Vec<String>) -> StepResult {
    #[cfg(target_os = "linux")]
    {
        set_linux_proxy(proxy_url, enable, &bypass_hosts)
    }
    #[cfg(target_os = "macos")]
    {
        set_macos_proxy(proxy_url, enable, &bypass_hosts)
    }
    #[cfg(target_os = "windows")]
    {
        set_windows_proxy(proxy_url, enable, &bypass_hosts)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (proxy_url, enable, bypass_hosts);
        StepResult {
            success: false,
            already_done: false,
            message: "System proxy configuration not supported on this platform".to_string(),
        }
    }
}

/// Query the currently configured system proxy, if any.
fn get_current_system_proxy() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        get_linux_proxy()
    }
    #[cfg(target_os = "macos")]
    {
        get_macos_proxy()
    }
    #[cfg(target_os = "windows")]
    {
        get_windows_proxy()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

// ── Linux: gsettings (GNOME) ──

#[cfg(target_os = "linux")]
fn gsettings_cmd() -> Command {
    // When running as root/sudo, forward to the real user
    if let Ok(sudo_user) = std::env::var("SUDO_USER") {
        let mut cmd = Command::new("sudo");
        cmd.arg("-u").arg(&sudo_user);
        if let Ok(addr) = std::env::var("DBUS_SESSION_BUS_ADDRESS") {
            cmd.arg(format!("DBUS_SESSION_BUS_ADDRESS={}", addr));
        } else if let Ok(uid) = std::env::var("SUDO_UID") {
            cmd.arg(format!(
                "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{}/bus",
                uid
            ));
        }
        cmd.arg("gsettings");
        cmd
    } else {
        Command::new("gsettings")
    }
}

#[cfg(target_os = "linux")]
fn set_linux_proxy(proxy_url: &str, enable: bool, bypass_hosts: &[String]) -> StepResult {
    if enable {
        let url_without_protocol = proxy_url
            .strip_prefix("http://")
            .or_else(|| proxy_url.strip_prefix("https://"))
            .unwrap_or(proxy_url);
        let parts: Vec<&str> = url_without_protocol.split(':').collect();
        let host = parts[0];
        let port = parts.get(1).unwrap_or(&"8080");

        let _ = gsettings_cmd()
            .args(["set", "org.gnome.system.proxy.http", "host", host])
            .status();
        let _ = gsettings_cmd()
            .args(["set", "org.gnome.system.proxy.http", "port", port])
            .status();
        let _ = gsettings_cmd()
            .args(["set", "org.gnome.system.proxy.https", "host", host])
            .status();
        let _ = gsettings_cmd()
            .args(["set", "org.gnome.system.proxy.https", "port", port])
            .status();
        // ignore-hosts is a GVariant array of strings
        let ignore = format!(
            "[{}]",
            bypass_hosts
                .iter()
                .map(|h| format!("'{}'", h.replace('\'', "")))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let _ = gsettings_cmd()
            .args(["set", "org.gnome.system.proxy", "ignore-hosts", &ignore])
            .status();
        let _ = gsettings_cmd()
            .args(["set", "org.gnome.system.proxy", "mode", "manual"])
            .status();

        StepResult {
            success: true,
            already_done: false,
            message: format!("System proxy enabled: {}:{}", host, port),
        }
    } else {
        let _ = gsettings_cmd()
            .args(["set", "org.gnome.system.proxy", "mode", "none"])
            .status();

        StepResult {
            success: true,
            already_done: false,
            message: "System proxy disabled".to_string(),
        }
    }
}

#[cfg(target_os = "linux")]
fn get_linux_proxy() -> Option<String> {
    let output = gsettings_cmd()
        .args(["get", "org.gnome.system.proxy", "mode"])
        .output()
        .ok()?;
    let mode = String::from_utf8_lossy(&output.stdout);
    if !mode.trim().contains("manual") {
        return None;
    }
    let host_out = gsettings_cmd()
        .args(["get", "org.gnome.system.proxy.http", "host"])
        .output()
        .ok()?;
    let port_out = gsettings_cmd()
        .args(["get", "org.gnome.system.proxy.http", "port"])
        .output()
        .ok()?;
    let host = String::from_utf8_lossy(&host_out.stdout)
        .trim()
        .trim_matches('\'')
        .to_string();
    let port = String::from_utf8_lossy(&port_out.stdout).trim().to_string();
    if host.is_empty() || host == "''" {
        return None;
    }
    Some(format!("http://{}:{}", host, port))
}

// ── macOS: networksetup ──

#[cfg(target_os = "macos")]
fn set_macos_proxy(proxy_url: &str, enable: bool, bypass_hosts: &[String]) -> StepResult {
    let output = match Command::new("networksetup")
        .args(["-listallnetworkservices"])
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            return StepResult {
                success: false,
                already_done: false,
                message: format!("Failed to list network services: {}", e),
            }
        }
    };
    let services_output = String::from_utf8_lossy(&output.stdout);
    let services: Vec<&str> = services_output
        .lines()
        .skip(1)
        .filter(|l| !l.starts_with('*'))
        .collect();

    for service in &services {
        if enable {
            let url = proxy_url.strip_prefix("http://").unwrap_or(proxy_url);
            let parts: Vec<&str> = url.split(':').collect();
            let host = parts[0];
            let port = parts.get(1).unwrap_or(&"8080");
            let _ = Command::new("networksetup")
                .args(["-setwebproxy", service, host, port])
                .status();
            let _ = Command::new("networksetup")
                .args(["-setsecurewebproxy", service, host, port])
                .status();
            // Set bypass list. networksetup expects each host as a separate
            // positional arg after the service name; pass "Empty" to clear.
            let mut args: Vec<&str> = vec!["-setproxybypassdomains", service];
            if bypass_hosts.is_empty() {
                args.push("Empty");
            } else {
                for h in bypass_hosts {
                    args.push(h.as_str());
                }
            }
            let _ = Command::new("networksetup").args(&args).status();
        } else {
            let _ = Command::new("networksetup")
                .args(["-setwebproxystate", service, "off"])
                .status();
            let _ = Command::new("networksetup")
                .args(["-setsecurewebproxystate", service, "off"])
                .status();
            let _ = Command::new("networksetup")
                .args(["-setproxybypassdomains", service, "Empty"])
                .status();
        }
    }

    StepResult {
        success: true,
        already_done: false,
        message: if enable {
            "System proxy enabled".to_string()
        } else {
            "System proxy disabled".to_string()
        },
    }
}

#[cfg(target_os = "macos")]
fn get_macos_proxy() -> Option<String> {
    let output = Command::new("networksetup")
        .args(["-getwebproxy", "Wi-Fi"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut enabled = false;
    let mut server = String::new();
    let mut port = String::new();
    for line in text.lines() {
        if line.starts_with("Enabled: Yes") {
            enabled = true;
        } else if let Some(s) = line.strip_prefix("Server: ") {
            server = s.to_string();
        } else if let Some(p) = line.strip_prefix("Port: ") {
            port = p.to_string();
        }
    }
    if enabled && !server.is_empty() {
        Some(format!("http://{}:{}", server, port))
    } else {
        None
    }
}

// ── Windows: registry ──

#[cfg(target_os = "windows")]
fn set_windows_proxy(proxy_url: &str, enable: bool, bypass_hosts: &[String]) -> StepResult {
    let reg_path = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    if enable {
        let proxy_server = proxy_url.strip_prefix("http://").unwrap_or(proxy_url);
        let _ = Command::new("reg")
            .args([
                "add",
                reg_path,
                "/v",
                "ProxyEnable",
                "/t",
                "REG_DWORD",
                "/d",
                "1",
                "/f",
            ])
            .status();
        let _ = Command::new("reg")
            .args([
                "add",
                reg_path,
                "/v",
                "ProxyServer",
                "/t",
                "REG_SZ",
                "/d",
                proxy_server,
                "/f",
            ])
            .status();
        // ProxyOverride is a semicolon-delimited list of bypass hosts.
        // Append "<local>" to also bypass plain (no-dot) hostnames.
        if !bypass_hosts.is_empty() {
            let mut entries: Vec<String> = bypass_hosts.to_vec();
            entries.push("<local>".to_string());
            let override_value = entries.join(";");
            let _ = Command::new("reg")
                .args([
                    "add",
                    reg_path,
                    "/v",
                    "ProxyOverride",
                    "/t",
                    "REG_SZ",
                    "/d",
                    &override_value,
                    "/f",
                ])
                .status();
        }
    } else {
        let _ = Command::new("reg")
            .args([
                "add",
                reg_path,
                "/v",
                "ProxyEnable",
                "/t",
                "REG_DWORD",
                "/d",
                "0",
                "/f",
            ])
            .status();
    }
    StepResult {
        success: true,
        already_done: false,
        message: if enable {
            "System proxy enabled".to_string()
        } else {
            "System proxy disabled".to_string()
        },
    }
}

#[cfg(target_os = "windows")]
fn get_windows_proxy() -> Option<String> {
    let reg_path = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let output = Command::new("reg")
        .args(["query", reg_path, "/v", "ProxyEnable"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    if !text.contains("0x1") {
        return None;
    }
    let output = Command::new("reg")
        .args(["query", reg_path, "/v", "ProxyServer"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if line.contains("ProxyServer") && line.contains("REG_SZ") {
            if let Some(server) = line.split_whitespace().last() {
                return Some(format!("http://{}", server));
            }
        }
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(MetricsState::default())
        .invoke_handler(tauri::generate_handler![
            check_binary,
            validate_binary,
            discover_server_url,
            check_service_running,
            start_service,
            check_ca_status,
            install_ca,
            enable_proxy,
            disable_proxy,
            check_proxy_status,
            get_process_metrics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_binary_finds_witm() {
        // This test requires `witm` to be on PATH
        let result = check_binary("witm".to_string());
        if result.found {
            assert!(result.path.is_some());
            let path = result.path.unwrap();
            assert!(
                path.contains("witm"),
                "Path should contain 'witm': {}",
                path
            );
        }
        // If not found, test is inconclusive (CI may not have it)
    }

    #[test]
    fn test_check_binary_not_found() {
        let result = check_binary("definitely_not_a_real_binary_xyz123".to_string());
        assert!(!result.found);
        assert!(result.path.is_none());
    }

    #[test]
    fn test_validate_binary_nonexistent_path() {
        let result = validate_binary("/nonexistent/path/to/witm".to_string());
        assert!(!result.found);
    }

    #[test]
    fn test_validate_binary_real_witm() {
        // Find witm on PATH first, then validate it
        let check = check_binary("witm".to_string());
        if let Some(path) = check.path {
            let result = validate_binary(path.clone());
            assert!(
                result.found,
                "validate_binary should confirm witm at {}",
                path
            );
            assert_eq!(result.path.as_deref(), Some(path.as_str()));
        }
    }

    #[test]
    fn test_validate_binary_wrong_binary() {
        // /bin/ls exists but is not witmproxy
        let result = validate_binary("/bin/ls".to_string());
        assert!(!result.found, "/bin/ls should not validate as witmproxy");
    }
}
