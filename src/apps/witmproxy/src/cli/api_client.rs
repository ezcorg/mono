use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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
            std::fs::create_dir_all(parent)?;
        }
        let content = serde_json::to_string_pretty(self)?;
        std::fs::write(&path, content)?;
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
    pub fn new(base_url: &str, token: Option<&str>) -> Self {
        Self {
            client: reqwest::Client::builder()
                .build()
                .unwrap(),
            base_url: base_url.trim_end_matches('/').to_string(),
            token: token.map(|t| t.to_string()),
        }
    }

    /// Load from stored auth credentials.
    pub fn from_auth_store() -> Result<Option<Self>> {
        match AuthStore::load()? {
            Some(store) => Ok(Some(Self::new(&store.server_url, Some(&store.token)))),
            None => Ok(None),
        }
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
    ) -> reqwest::RequestBuilder {
        let url = format!("{}{}", self.base_url, path);
        let mut req = self.client.request(method, &url);
        if let Some(ref token) = self.token {
            req = req.header("Authorization", format!("Bearer {}", token));
        }
        req
    }

    pub async fn get(&self, path: &str) -> Result<reqwest::Response> {
        let resp = self.request(reqwest::Method::GET, path).await.send().await?;
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
        let json: serde_json::Value = resp.json().await?;
        Ok(json)
    }

    pub async fn login(&self, email: &str, password: &str) -> Result<serde_json::Value> {
        let body = serde_json::json!({
            "email": email,
            "password": password,
        });
        let resp = self.post_json("/api/auth/login", &body).await?;
        let json: serde_json::Value = resp.json().await?;
        Ok(json)
    }
}
