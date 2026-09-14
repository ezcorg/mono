use anyhow::{Context, Result};
use conf::Conf;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::GlobalArgs;
use crate::config::{TlsConfig, app_dir_for};

/// How to reach the management API, for commands that talk to a running
/// daemon. Both flags are optional: without them the server and token saved
/// by `witm auth login` are used, and failing that the daemon on this machine.
#[derive(Conf, Clone, Default)]
#[conf(serde(allow_unknown_fields))]
pub struct DaemonAuthArgs {
    /// Management API URL (default: the server from `witm auth login`, else the local daemon)
    #[arg(long = "server", env = "WITM_SERVER", serde(skip))]
    pub server: Option<String>,
    /// Bearer token for the management API (default: the token from `witm auth login`)
    #[arg(long = "token", env = "WITM_TOKEN", serde(skip))]
    pub token: Option<String>,
}

/// The shared flags plus daemon auth, for subcommands that take nothing else.
#[derive(Conf)]
#[conf(serde)]
pub struct DaemonArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,
    #[conf(flatten)]
    pub auth: DaemonAuthArgs,
}

/// What a daemon on this machine left behind in its app directory: the
/// management address in `services.json` and the CA it serves TLS with.
pub struct LocalDaemon {
    pub web_url: Option<String>,
    pub root_cert: Option<reqwest::Certificate>,
}

impl LocalDaemon {
    /// Looks next to the given certificate directory.
    pub fn from_tls(tls: &TlsConfig) -> Self {
        let app_dir = app_dir_for(&tls.cert_dir);
        let web_url = std::fs::read_to_string(app_dir.join("services.json"))
            .ok()
            .and_then(|c| serde_json::from_str::<super::Services>(&c).ok())
            .map(|s| format!("https://{}", s.web));
        let root_cert = std::fs::read(crate::cert::ca::get_root_cert_path(&tls.cert_dir))
            .ok()
            .and_then(|pem| reqwest::Certificate::from_pem(&pem).ok());
        Self { web_url, root_cert }
    }

    /// Looks in the default locations (for commands that take no TLS config).
    pub fn from_default_paths() -> Self {
        let mut tls = TlsConfig::default();
        let _ = tls.resolve_paths();
        Self::from_tls(&tls)
    }
}

/// `host:port` becomes `https://host:port`; trailing slashes and case are
/// dropped so two spellings of one server compare equal.
pub(crate) fn normalise_server_url(u: &str) -> String {
    let u = u.trim().trim_end_matches('/');
    let with_scheme = if u.contains("://") {
        u.to_string()
    } else {
        format!("https://{u}")
    };
    with_scheme.to_ascii_lowercase()
}

/// Which server to talk to and with what token.
///
/// Server: `--server`, else the one saved by `witm auth login`, else the
/// local daemon. Token: `--token`, else the saved one when it was issued by
/// the chosen server. `None` when no server can be found at all.
pub(crate) fn resolve_endpoint(
    args: &DaemonAuthArgs,
    stored: Option<&AuthStore>,
    local_web_url: Option<&str>,
) -> Option<(String, Option<String>)> {
    let normalise = normalise_server_url;
    let server = args
        .server
        .as_deref()
        .or(stored.map(|s| s.server_url.as_str()))
        .or(local_web_url)
        .map(normalise)?;
    let token = args.token.clone().or_else(|| {
        stored
            .filter(|s| normalise(&s.server_url) == server)
            .map(|s| s.token.clone())
    });
    Some((server, token))
}

/// Stored authentication credentials.
#[derive(Debug, Serialize, Deserialize)]
pub struct AuthStore {
    pub token: String,
    pub server_url: String,
}

impl AuthStore {
    /// Path to the auth storage file.
    pub fn path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".witmproxy")
            .join("auth.json")
    }

    /// Load stored auth credentials.
    pub fn load() -> Result<Option<Self>> {
        let path = Self::path();
        if !path.exists() {
            return Ok(None);
        }
        let content = std::fs::read_to_string(&path)?;
        let store: Self = serde_json::from_str(&content)?;
        Ok(Some(store))
    }

    /// Save auth credentials.
    pub fn save(&self) -> Result<()> {
        let path = Self::path();
        if let Some(parent) = path.parent() {
            crate::util::fs_secure::create_dir_secure(parent)?;
        }
        let content = serde_json::to_string_pretty(self)?;
        // auth.json holds a bearer token granting management-API access; keep it 0o600.
        crate::util::fs_secure::write_secret(&path, content)?;
        Ok(())
    }

    /// Remove stored auth credentials.
    pub fn remove() -> Result<()> {
        let path = Self::path();
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        Ok(())
    }
}

/// HTTP client for the witmproxy management API.
pub struct ApiClient {
    client: reqwest::Client,
    base_url: String,
    token: Option<String>,
}

impl ApiClient {
    /// Build a client for the management API.
    ///
    /// Fallible because `reqwest` can fail to initialise its TLS backend;
    /// unwrapping that would abort the CLI with a panic instead of a message.
    pub fn new(
        base_url: &str,
        token: Option<&str>,
        root_cert: Option<reqwest::Certificate>,
    ) -> Result<Self> {
        let mut builder = reqwest::Client::builder();
        if let Some(cert) = root_cert {
            // The local daemon serves its management API under its own CA.
            builder = builder.add_root_certificate(cert);
        }
        Ok(Self {
            client: builder
                .build()
                .context("failed to build the API HTTP client")?,
            base_url: base_url.trim_end_matches('/').to_string(),
            token: token.map(|t| t.to_string()),
        })
    }

    /// Build a client from the command's auth flags, the stored login and
    /// the local daemon. `None` when no server is known.
    pub fn resolve(args: &DaemonAuthArgs, local: LocalDaemon) -> Result<Option<Self>> {
        let stored = AuthStore::load()?;
        let Some((server, token)) =
            resolve_endpoint(args, stored.as_ref(), local.web_url.as_deref())
        else {
            return Ok(None);
        };
        Ok(Some(Self::new(&server, token.as_deref(), local.root_cert)?))
    }

    /// Like [`Self::resolve`], but a missing server is an error for commands
    /// that cannot do anything without one.
    pub fn resolve_required(args: &DaemonAuthArgs, local: LocalDaemon) -> Result<Self> {
        Self::resolve(args, local)?.ok_or_else(|| {
            anyhow::anyhow!(
                "No server to talk to. Pass --server <url> (or WITM_SERVER), run \
                 `witm auth login`, or start the local daemon."
            )
        })
    }

    /// The reply body, or an error carrying the auth hint when the server
    /// refused the credentials. For commands that just print what the
    /// server said.
    pub async fn body(&self, resp: reqwest::Response) -> Result<String> {
        if let Some(hint) = self.auth_hint(resp.status()) {
            anyhow::bail!("{hint}");
        }
        Ok(resp.text().await?)
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn has_token(&self) -> bool {
        self.token.is_some()
    }

    /// What to tell the operator when the server refused the credentials.
    pub fn auth_hint(&self, status: reqwest::StatusCode) -> Option<String> {
        match status {
            reqwest::StatusCode::UNAUTHORIZED => Some(if self.has_token() {
                format!(
                    "{} rejected the token. Log in again with `witm auth login --server {}`, \
                     or pass a valid --token / WITM_TOKEN.",
                    self.base_url, self.base_url
                )
            } else {
                format!(
                    "{} requires authentication. Run `witm auth login --server {}` first, \
                     or pass --token / WITM_TOKEN.",
                    self.base_url, self.base_url
                )
            }),
            reqwest::StatusCode::FORBIDDEN => Some(format!(
                "{} refused: the account behind this token is not allowed to do that.",
                self.base_url
            )),
            _ => None,
        }
    }

    async fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let url = format!("{}{}", self.base_url, path);
        // Salvo renders errors as a full HTML page unless asked for JSON.
        let mut req = self
            .client
            .request(method, &url)
            .header("Accept", "application/json");
        if let Some(ref token) = self.token {
            req = req.header("Authorization", format!("Bearer {}", token));
        }
        req
    }

    pub async fn get(&self, path: &str) -> Result<reqwest::Response> {
        let resp = self
            .request(reqwest::Method::GET, path)
            .await
            .send()
            .await?;
        Ok(resp)
    }

    pub async fn post_json<T: Serialize>(&self, path: &str, body: &T) -> Result<reqwest::Response> {
        let resp = self
            .request(reqwest::Method::POST, path)
            .await
            .json(body)
            .send()
            .await?;
        Ok(resp)
    }

    pub async fn put_json<T: Serialize>(&self, path: &str, body: &T) -> Result<reqwest::Response> {
        let resp = self
            .request(reqwest::Method::PUT, path)
            .await
            .json(body)
            .send()
            .await?;
        Ok(resp)
    }

    pub async fn post_multipart(
        &self,
        path: &str,
        form: reqwest::multipart::Form,
        headers: &[(&str, String)],
    ) -> Result<reqwest::Response> {
        let mut req = self
            .request(reqwest::Method::POST, path)
            .await
            .multipart(form);
        for (k, v) in headers {
            req = req.header(*k, v);
        }
        Ok(req.send().await?)
    }

    pub async fn delete(&self, path: &str) -> Result<reqwest::Response> {
        let resp = self
            .request(reqwest::Method::DELETE, path)
            .await
            .send()
            .await?;
        Ok(resp)
    }

    pub async fn delete_json<T: Serialize>(
        &self,
        path: &str,
        body: &T,
    ) -> Result<reqwest::Response> {
        let resp = self
            .request(reqwest::Method::DELETE, path)
            .await
            .json(body)
            .send()
            .await?;
        Ok(resp)
    }

    // --- Auth ---

    pub async fn register(
        &self,
        email: &str,
        password: &str,
        display_name: &str,
    ) -> Result<serde_json::Value> {
        let body = serde_json::json!({
            "email": email,
            "password": password,
            "display_name": display_name,
        });
        let resp = self.post_json("/api/auth/register", &body).await?;
        Self::json_or_error(resp).await
    }

    pub async fn login(&self, email: &str, password: &str) -> Result<serde_json::Value> {
        let body = serde_json::json!({
            "email": email,
            "password": password,
        });
        let resp = self.post_json("/api/auth/login", &body).await?;
        Self::json_or_error(resp).await
    }

    /// The JSON body of a successful reply; a failure becomes an error that
    /// carries the server's status and message (which is not JSON).
    async fn json_or_error(resp: reqwest::Response) -> Result<serde_json::Value> {
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            let trimmed = text.trim();
            // A rendered error page says nothing the status line does not.
            let looks_like_html = trimmed.starts_with('<');
            let detail = serde_json::from_str::<serde_json::Value>(trimmed)
                .ok()
                .and_then(|v| {
                    // Salvo: {"error":{"brief":..}}; ad-hoc handlers: {"error":".."} or {"message":".."}.
                    let error = v.get("error");
                    let nested = error.and_then(|e| e.get("brief").or_else(|| e.get("detail")));
                    nested
                        .or(error)
                        .or_else(|| v.get("message"))
                        .and_then(|m| m.as_str().map(str::to_string))
                })
                .or_else(|| (!looks_like_html && !trimmed.is_empty()).then(|| trimmed.to_string()));
            match detail {
                Some(d) => anyhow::bail!("{status}: {d}"),
                None => anyhow::bail!("{status}"),
            }
        }
        serde_json::from_str(&text)
            .with_context(|| format!("unexpected reply from the server: {}", text.trim()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(server: Option<&str>, token: Option<&str>) -> DaemonAuthArgs {
        DaemonAuthArgs {
            server: server.map(str::to_string),
            token: token.map(str::to_string),
        }
    }

    fn stored(server: &str) -> AuthStore {
        AuthStore {
            token: "stored-token".into(),
            server_url: server.into(),
        }
    }

    #[test]
    fn bare_host_port_gets_https() {
        assert_eq!(normalise_server_url("127.0.0.1:1/"), "https://127.0.0.1:1");
        assert_eq!(normalise_server_url("HTTP://x"), "http://x");
        assert_eq!(
            resolve_endpoint(
                &args(Some("127.0.0.1:1"), None),
                Some(&stored("https://127.0.0.1:1")),
                None
            ),
            Some(("https://127.0.0.1:1".into(), Some("stored-token".into())))
        );
    }

    #[test]
    fn flags_win_over_everything() {
        let r = resolve_endpoint(
            &args(Some("https://remote/"), Some("flag-token")),
            Some(&stored("https://other")),
            Some("https://127.0.0.1:1"),
        );
        assert_eq!(
            r,
            Some(("https://remote".into(), Some("flag-token".into())))
        );
    }

    #[test]
    fn stored_login_is_used_for_its_own_server_only() {
        let st = stored("https://127.0.0.1:1/");
        let r = resolve_endpoint(&args(None, None), Some(&st), Some("https://127.0.0.1:1"));
        assert_eq!(
            r,
            Some(("https://127.0.0.1:1".into(), Some("stored-token".into())))
        );

        // An explicit different server does not get the stored token.
        let r = resolve_endpoint(&args(Some("https://elsewhere"), None), Some(&st), None);
        assert_eq!(r, Some(("https://elsewhere".into(), None)));

        // The stored server is preferred over the local daemon.
        let r = resolve_endpoint(
            &args(None, None),
            Some(&stored("https://remote")),
            Some("https://127.0.0.1:1"),
        );
        assert_eq!(
            r,
            Some(("https://remote".into(), Some("stored-token".into())))
        );
    }

    #[test]
    fn local_daemon_without_login_has_no_token() {
        let r = resolve_endpoint(&args(None, None), None, Some("https://127.0.0.1:1"));
        assert_eq!(r, Some(("https://127.0.0.1:1".into(), None)));
        assert_eq!(resolve_endpoint(&args(None, Some("t")), None, None), None);
    }
}
