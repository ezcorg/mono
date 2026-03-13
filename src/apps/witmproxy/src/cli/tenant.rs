use anyhow::Result;
use clap::Subcommand;

use crate::cli::api_client::ApiClient;

#[derive(Subcommand)]
pub enum TenantCommands {
    /// List all tenants
    List,
    /// Create a new tenant
    Create {
        /// Display name
        display_name: String,
        /// Email address
        #[arg(long)]
        email: Option<String>,
    },
    /// Enable a tenant
    Enable {
        /// Tenant ID
        id: String,
    },
    /// Disable a tenant
    Disable {
        /// Tenant ID
        id: String,
    },
    /// Map an IP address to a tenant
    MapIp {
        /// Tenant ID
        tenant_id: String,
        /// IP address
        ip: String,
    },
    /// Enable a plugin for a tenant
    EnablePlugin {
        /// Tenant ID
        tenant_id: String,
        /// Plugin (namespace/name format)
        plugin: String,
    },
    /// Disable a plugin for a tenant
    DisablePlugin {
        /// Tenant ID
        tenant_id: String,
        /// Plugin (namespace/name format)
        plugin: String,
    },
    /// Set plugin configuration for a tenant
    SetPluginConfig {
        /// Tenant ID
        tenant_id: String,
        /// Plugin (namespace/name format)
        plugin: String,
        /// Configuration as JSON object
        json: String,
    },
}

pub struct TenantHandler;

impl TenantHandler {
    pub async fn handle(&self, command: &TenantCommands) -> Result<()> {
        let client = ApiClient::from_auth_store()?
            .ok_or_else(|| anyhow::anyhow!("Not authenticated. Run 'witm auth login' first."))?;

        match command {
            TenantCommands::List => {
                let resp = client.get("/api/manage/tenants").await?;
                let body = resp.text().await?;
                println!("{}", body);
            }
            TenantCommands::Create {
                display_name,
                email,
            } => {
                let mut body = serde_json::json!({
                    "display_name": display_name,
                });
                if let Some(email) = email {
                    body["email"] = serde_json::json!(email);
                }
                let resp = client
                    .post_json("/api/auth/register", &serde_json::json!({
                        "display_name": display_name,
                        "email": email.as_deref().unwrap_or(""),
                        "password": "", // Placeholder for CLI tenant creation
                    }))
                    .await?;
                let text = resp.text().await?;
                println!("{}", text);
            }
            TenantCommands::Enable { id } => {
                let resp = client
                    .put_json(
                        &format!("/api/manage/tenants/{}", id),
                        &serde_json::json!({"enabled": true}),
                    )
                    .await?;
                println!("{}", resp.text().await?);
            }
            TenantCommands::Disable { id } => {
                let resp = client
                    .put_json(
                        &format!("/api/manage/tenants/{}", id),
                        &serde_json::json!({"enabled": false}),
                    )
                    .await?;
                println!("{}", resp.text().await?);
            }
            TenantCommands::MapIp { tenant_id, ip } => {
                let resp = client
                    .post_json(
                        &format!("/api/manage/tenants/{}/ip-mappings", tenant_id),
                        &serde_json::json!({"ip_address": ip}),
                    )
                    .await?;
                println!("{}", resp.text().await?);
            }
            TenantCommands::EnablePlugin { tenant_id, plugin } => {
                let (ns, name) = parse_plugin_id(plugin)?;
                let resp = client
                    .put_json(
                        &format!(
                            "/api/manage/tenants/{}/plugins/{}/{}/enabled",
                            tenant_id, ns, name
                        ),
                        &serde_json::json!({"enabled": true}),
                    )
                    .await?;
                println!("{}", resp.text().await?);
            }
            TenantCommands::DisablePlugin { tenant_id, plugin } => {
                let (ns, name) = parse_plugin_id(plugin)?;
                let resp = client
                    .put_json(
                        &format!(
                            "/api/manage/tenants/{}/plugins/{}/{}/enabled",
                            tenant_id, ns, name
                        ),
                        &serde_json::json!({"enabled": false}),
                    )
                    .await?;
                println!("{}", resp.text().await?);
            }
            TenantCommands::SetPluginConfig {
                tenant_id,
                plugin,
                json,
            } => {
                let (ns, name) = parse_plugin_id(plugin)?;
                let config: serde_json::Value = serde_json::from_str(json)?;
                let resp = client
                    .put_json(
                        &format!(
                            "/api/manage/tenants/{}/plugins/{}/{}/config",
                            tenant_id, ns, name
                        ),
                        &serde_json::json!({"config": config}),
                    )
                    .await?;
                println!("{}", resp.text().await?);
            }
        }
        Ok(())
    }
}

fn parse_plugin_id(plugin: &str) -> Result<(&str, &str)> {
    let parts: Vec<&str> = plugin.splitn(2, '/').collect();
    if parts.len() != 2 {
        anyhow::bail!("Plugin must be in 'namespace/name' format, got: {}", plugin);
    }
    Ok((parts[0], parts[1]))
}
