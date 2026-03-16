use crate::config::{AppConfig, system_app_dir};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tracing::{info, warn};

// ---------------------------------------------------------------------------
// 4a. Current version
// ---------------------------------------------------------------------------

pub fn current_version() -> semver::Version {
    env!("CARGO_PKG_VERSION").parse().expect("valid semver")
}

// ---------------------------------------------------------------------------
// 4b. Version cache
// ---------------------------------------------------------------------------

const CACHE_FILE_NAME: &str = "update_cache.json";
/// How long the CLI considers the cache fresh before re-checking (1 hour).
const CLI_CACHE_TTL_SECS: u64 = 3600;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionCache {
    pub latest_version: String,
    pub checked_at: chrono::DateTime<chrono::Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
}

fn cache_path() -> PathBuf {
    system_app_dir().join(CACHE_FILE_NAME)
}

fn read_cache() -> Option<VersionCache> {
    let data = std::fs::read_to_string(cache_path()).ok()?;
    serde_json::from_str(&data).ok()
}

fn write_cache(cache: &VersionCache) -> Result<()> {
    let dir = system_app_dir();
    std::fs::create_dir_all(&dir)?;
    let data = serde_json::to_string_pretty(cache)?;
    std::fs::write(cache_path(), data)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 4c. Version check via crates.io sparse index
// ---------------------------------------------------------------------------

/// Fetch the latest non-yanked version from the crates.io sparse index.
/// Sends conditional headers when `cache` is provided so the server can
/// respond with 304 Not Modified.
async fn fetch_latest_version(
    cache: Option<&VersionCache>,
) -> Result<Option<(semver::Version, Option<String>, Option<String>)>> {
    let url = "https://index.crates.io/wi/tm/witmproxy";

    let client = reqwest::Client::builder()
        .user_agent("witmproxy-updater")
        .build()?;

    let mut req = client.get(url);

    // Conditional request headers
    if let Some(c) = cache {
        if let Some(ref etag) = c.etag {
            req = req.header("If-None-Match", etag);
        }
        if let Some(ref lm) = c.last_modified {
            req = req.header("If-Modified-Since", lm);
        }
    }

    let resp = req
        .send()
        .await
        .context("failed to reach crates.io sparse index")?;

    if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
        // Nothing changed — return the cached version if available
        if let Some(c) = cache {
            let ver: semver::Version = c.latest_version.parse()?;
            return Ok(Some((ver, c.etag.clone(), c.last_modified.clone())));
        }
        return Ok(None);
    }

    if !resp.status().is_success() {
        anyhow::bail!("crates.io sparse index returned status {}", resp.status());
    }

    let etag = resp
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let last_modified = resp
        .headers()
        .get("last-modified")
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    let body = resp.text().await?;

    // Each line is a JSON object for a published version
    let mut max_version: Option<semver::Version> = None;
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Minimal struct for the fields we care about
        #[derive(Deserialize)]
        struct IndexEntry {
            vers: String,
            #[serde(default)]
            yanked: bool,
        }
        if let Ok(entry) = serde_json::from_str::<IndexEntry>(line) {
            if entry.yanked {
                continue;
            }
            if let Ok(ver) = entry.vers.parse::<semver::Version>() {
                if max_version.as_ref().is_none_or(|m| ver > *m) {
                    max_version = Some(ver);
                }
            }
        }
    }

    match max_version {
        Some(v) => Ok(Some((v, etag, last_modified))),
        None => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// 4d. Cached check (for CLI startup)
// ---------------------------------------------------------------------------

/// Check whether an update is available. Uses the on-disk cache when it is
/// fresh (< 1 hour) and `force` is false.
pub async fn check_for_update_cached(force: bool) -> Result<Option<semver::Version>> {
    let current = current_version();
    let cache = read_cache();

    // If cache is fresh and not forced, use it directly
    if !force {
        if let Some(ref c) = cache {
            let age = chrono::Utc::now()
                .signed_duration_since(c.checked_at)
                .num_seconds();
            if age >= 0 && (age as u64) < CLI_CACHE_TTL_SECS {
                let cached_ver: semver::Version = c.latest_version.parse()?;
                if cached_ver > current {
                    return Ok(Some(cached_ver));
                }
                return Ok(None);
            }
        }
    }

    // Fetch from sparse index (may 304 when nothing changed)
    let result = fetch_latest_version(cache.as_ref()).await?;
    if let Some((latest, etag, last_modified)) = result {
        let new_cache = VersionCache {
            latest_version: latest.to_string(),
            checked_at: chrono::Utc::now(),
            etag,
            last_modified,
        };
        let _ = write_cache(&new_cache);
        if latest > current {
            return Ok(Some(latest));
        }
    }

    Ok(None)
}

// ---------------------------------------------------------------------------
// 4e. GitHub release binary download
// ---------------------------------------------------------------------------

fn asset_name() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "witm-macos-arm64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "witm-macos-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "witm-linux-x64"
    }
    // Fallback for unsupported platforms — callers should handle None from download
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
    )))]
    {
        "witm-unknown"
    }
}

async fn download_release_binary(version: &semver::Version) -> Result<Vec<u8>> {
    let name = asset_name();
    let url = format!(
        "https://github.com/ezcorg/mono/releases/download/witmproxy-v{}/{}",
        version, name
    );

    info!("Downloading release binary from {}", url);
    let client = reqwest::Client::builder()
        .user_agent("witmproxy-updater")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()?;

    let resp = client
        .get(&url)
        .send()
        .await
        .context("failed to download release binary")?;

    if !resp.status().is_success() {
        anyhow::bail!(
            "GitHub release download returned status {} for {}",
            resp.status(),
            url
        );
    }

    let bytes = resp.bytes().await?.to_vec();

    // Basic magic-byte validation
    let valid = if cfg!(target_os = "macos") {
        // Mach-O: 0xFEEDFACE, 0xFEEDFACF, or fat binary 0xCAFEBABE
        bytes.len() >= 4
            && (bytes[..4] == [0xFE, 0xED, 0xFA, 0xCE]
                || bytes[..4] == [0xFE, 0xED, 0xFA, 0xCF]
                || bytes[..4] == [0xCF, 0xFA, 0xED, 0xFE]
                || bytes[..4] == [0xCE, 0xFA, 0xED, 0xFE]
                || bytes[..4] == [0xCA, 0xFE, 0xBA, 0xBE])
    } else {
        // ELF: 0x7F ELF
        bytes.len() >= 4 && bytes[..4] == [0x7F, b'E', b'L', b'F']
    };

    if !valid {
        anyhow::bail!("Downloaded binary has invalid magic bytes — not a valid executable");
    }

    Ok(bytes)
}

// ---------------------------------------------------------------------------
// 4f. Binary replacement
// ---------------------------------------------------------------------------

fn replace_binary(new_binary: &[u8]) -> Result<()> {
    let current_exe = std::env::current_exe().context("failed to get current executable path")?;
    let current_exe = current_exe.canonicalize().unwrap_or(current_exe);

    let dir = current_exe
        .parent()
        .context("executable has no parent directory")?;
    let pid = std::process::id();
    let temp_path = dir.join(format!(".witm.update.{}", pid));
    let old_path = current_exe.with_extension("old");

    // Write new binary to temp file
    std::fs::write(&temp_path, new_binary).context("failed to write temp binary")?;

    // Set executable permissions
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(0o755))?;
    }

    // Rename current → .old, temp → current
    if let Err(e) = std::fs::rename(&current_exe, &old_path) {
        // Clean up temp
        let _ = std::fs::remove_file(&temp_path);
        return Err(e).context("failed to rename current binary to .old");
    }

    if let Err(e) = std::fs::rename(&temp_path, &current_exe) {
        // Restore old binary
        let _ = std::fs::rename(&old_path, &current_exe);
        return Err(e).context("failed to rename new binary into place");
    }

    // Clean up .old
    let _ = std::fs::remove_file(&old_path);

    Ok(())
}

// ---------------------------------------------------------------------------
// 4g. Cargo install fallback
// ---------------------------------------------------------------------------

async fn update_via_cargo_install(version: &semver::Version) -> Result<()> {
    info!(
        "Falling back to `cargo install witmproxy@{} --force`",
        version
    );
    let status = tokio::process::Command::new("cargo")
        .args(["install", &format!("witmproxy@{}", version), "--force"])
        .status()
        .await
        .context("failed to run cargo install")?;

    if !status.success() {
        anyhow::bail!("cargo install exited with status {}", status);
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// 4h. UpdateHandler
// ---------------------------------------------------------------------------

pub struct UpdateHandler {
    config: AppConfig,
}

impl UpdateHandler {
    pub fn new(config: AppConfig) -> Self {
        Self { config }
    }

    pub async fn handle(&self, force: bool, from_source: bool) -> Result<()> {
        let current = current_version();
        eprintln!("Current version: {}", current);
        eprintln!("Checking for updates...");

        // Always bypass cache for the explicit `witm update` command
        let result = fetch_latest_version(read_cache().as_ref()).await?;

        let latest = match result {
            Some((v, etag, last_modified)) => {
                // Update cache
                let _ = write_cache(&VersionCache {
                    latest_version: v.to_string(),
                    checked_at: chrono::Utc::now(),
                    etag,
                    last_modified,
                });
                v
            }
            None => {
                eprintln!("Could not determine latest version from crates.io.");
                return Ok(());
            }
        };

        if latest <= current && !force {
            eprintln!("Already on the latest version ({}).", current);
            return Ok(());
        }

        eprintln!("Updating witm from {} to {}...", current, latest);

        let mut updated = false;

        if !from_source && self.config.update.prefer_prebuilt {
            match download_release_binary(&latest).await {
                Ok(binary) => match replace_binary(&binary) {
                    Ok(()) => {
                        updated = true;
                    }
                    Err(e) => {
                        warn!(
                            "Binary replacement failed: {:#}. Trying cargo install...",
                            e
                        );
                    }
                },
                Err(e) => {
                    warn!("Prebuilt download failed: {:#}. Trying cargo install...", e);
                }
            }
        }

        if !updated {
            update_via_cargo_install(&latest).await?;
        }

        eprintln!("Successfully updated witm to {}.", latest);

        // Hint about daemon restart
        let app_dir = system_app_dir();
        if crate::cli::service::is_daemon_running(&app_dir) {
            eprintln!("Note: The witmproxy daemon is running. Restart it to use the new version:");
            eprintln!("  witm service restart");
        }

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 4i. Daemon auto-update loop
// ---------------------------------------------------------------------------

pub async fn auto_update_loop(interval_seconds: u64, config: AppConfig) {
    // Wait 60s after startup to avoid startup churn
    tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;

    let interval = tokio::time::Duration::from_secs(interval_seconds);
    loop {
        info!("Auto-update: checking for new version...");
        let current = current_version();

        match fetch_latest_version(read_cache().as_ref()).await {
            Ok(Some((latest, etag, last_modified))) => {
                // Update cache regardless
                let _ = write_cache(&VersionCache {
                    latest_version: latest.to_string(),
                    checked_at: chrono::Utc::now(),
                    etag,
                    last_modified,
                });

                if latest > current {
                    info!(
                        "Auto-update: new version {} available (current: {})",
                        latest, current
                    );

                    if config.update.prefer_prebuilt {
                        match download_release_binary(&latest).await {
                            Ok(binary) => match replace_binary(&binary) {
                                Ok(()) => {
                                    info!(
                                        "Auto-update: binary replaced with version {}. Reinstalling service and restarting...",
                                        latest
                                    );

                                    // Reinstall and restart the service so the new binary is used.
                                    // The service manager will kill this process when the service restarts.
                                    let handler = crate::cli::service::ServiceHandler::new(
                                        config.clone(),
                                        false,
                                        None,
                                        false,
                                    );
                                    if let Err(e) = handler.install_service(true).await {
                                        warn!("Auto-update: failed to reinstall service: {:#}", e);
                                    }
                                    if let Err(e) = handler.restart_service().await {
                                        warn!("Auto-update: failed to restart service: {:#}", e);
                                    }
                                    // The restart should kill this process; if it didn't,
                                    // just continue the loop.
                                    return;
                                }
                                Err(e) => {
                                    warn!("Auto-update: binary replacement failed: {:#}", e);
                                }
                            },
                            Err(e) => {
                                warn!("Auto-update: prebuilt download failed: {:#}", e);
                            }
                        }
                    }
                    // No cargo install fallback for daemon — prebuilt only
                } else {
                    info!("Auto-update: already on latest version ({})", current);
                }
            }
            Ok(None) => {
                info!("Auto-update: could not determine latest version");
            }
            Err(e) => {
                warn!("Auto-update: version check failed: {:#}", e);
            }
        }

        tokio::time::sleep(interval).await;
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CACHE_FILE_NAME);

        let cache = VersionCache {
            latest_version: "0.1.0".to_string(),
            checked_at: chrono::Utc::now(),
            etag: Some("\"abc123\"".to_string()),
            last_modified: Some("Sat, 14 Mar 2026 10:00:00 GMT".to_string()),
        };

        let data = serde_json::to_string_pretty(&cache).unwrap();
        std::fs::write(&path, &data).unwrap();

        let loaded: VersionCache =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(loaded.latest_version, "0.1.0");
        assert_eq!(loaded.etag.as_deref(), Some("\"abc123\""));
        assert_eq!(
            loaded.last_modified.as_deref(),
            Some("Sat, 14 Mar 2026 10:00:00 GMT")
        );
    }

    #[test]
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn test_asset_name_macos_arm64() {
        assert_eq!(asset_name(), "witm-macos-arm64");
    }

    #[test]
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    fn test_asset_name_macos_x64() {
        assert_eq!(asset_name(), "witm-macos-x64");
    }

    #[test]
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    fn test_asset_name_linux_x64() {
        assert_eq!(asset_name(), "witm-linux-x64");
    }
}
