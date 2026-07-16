use anyhow::Result;
use conf::{Conf, Subcommands};

use super::GlobalArgs;
use crate::cli::api_client::ApiClient;

#[derive(Subcommands)]
#[conf(serde)]
pub enum TenantCommands {
    /// List all tenants
    List(GlobalArgs),
    /// Create a new tenant
    Create(TenantCreateArgs),
    /// Enable a tenant
    Enable(TenantIdArgs),
    /// Disable a tenant
    Disable(TenantIdArgs),
    /// Map an IP address to a tenant
    MapIp(TenantMapIpArgs),
    /// Enable a plugin for a tenant
    EnablePlugin(TenantPluginArgs),
    /// Disable a plugin for a tenant
    DisablePlugin(TenantPluginArgs),
    /// Set plugin configuration for a tenant
    SetPluginConfig(TenantSetConfigArgs),
}

#[derive(Conf)]
#[conf(serde)]
pub struct TenantCreateArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,

    /// Display name
    #[arg(pos)]
    pub display_name: String,
    /// Email address
    #[arg(long)]
    pub email: Option<String>,
}

#[derive(Conf)]
#[conf(serde)]
pub struct TenantIdArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,

    /// Tenant ID
    #[arg(pos)]
    pub id: String,
}

#[derive(Conf)]
#[conf(serde)]
pub struct TenantMapIpArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,

    /// Tenant ID
    #[arg(pos)]
    pub tenant_id: String,
    /// IP address
    #[arg(pos)]
    pub ip: String,
}

#[derive(Conf)]
#[conf(serde)]
pub struct TenantPluginArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,

    /// Tenant ID
    #[arg(pos)]
    pub tenant_id: String,
    /// Plugin (namespace/name format)
    #[arg(pos)]
    pub plugin: String,
}

#[derive(Conf)]
#[conf(serde)]
pub struct TenantSetConfigArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,

    /// Tenant ID
    #[arg(pos)]
    pub tenant_id: String,
    /// Plugin (namespace/name format)
    #[arg(pos)]
    pub plugin: String,
    /// Configuration as JSON object
    #[arg(pos)]
    pub json: String,
}

impl TenantCommands {
    pub(crate) fn globals(&self) -> &GlobalArgs {
        match self {
            TenantCommands::List(g) => g,
            TenantCommands::Create(a) => &a.globals,
            TenantCommands::Enable(a) | TenantCommands::Disable(a) => &a.globals,
            TenantCommands::MapIp(a) => &a.globals,
            TenantCommands::EnablePlugin(a) | TenantCommands::DisablePlugin(a) => &a.globals,
            TenantCommands::SetPluginConfig(a) => &a.globals,
        }
    }
}

pub struct TenantHandler;

impl TenantHandler {
    pub async fn handle(&self, command: &TenantCommands) -> Result<()> {
        let client = ApiClient::from_auth_store()?
            .ok_or_else(|| anyhow::anyhow!("Not authenticated. Run 'witm auth login' first."))?;

        match command {
            TenantCommands::List(_) => {
                let resp = client.get("/api/manage/tenants").await?;
                let body = resp.text().await?;
                println!("{}", body);
            }
            TenantCommands::Create(a) => {
                let display_name = &a.display_name;
                let email = &a.email;
                let mut body = serde_json::json!({
                    "display_name": display_name,
                });
                if let Some(email) = email {
                    body["email"] = serde_json::json!(email);
                }
                let resp = client
                    .post_json(
                        "/api/auth/register",
                        &serde_json::json!({
                            "display_name": display_name,
                            "email": email.as_deref().unwrap_or(""),
                            "password": "", // Placeholder for CLI tenant creation
                        }),
                    )
                    .await?;
                let text = resp.text().await?;
                println!("{}", text);
            }
            TenantCommands::Enable(a) => {
                let resp = client
                    .put_json(
                        &format!("/api/manage/tenants/{}", a.id),
                        &serde_json::json!({"enabled": true}),
                    )
                    .await?;
                println!("{}", resp.text().await?);
            }
            TenantCommands::Disable(a) => {
                let resp = client
                    .put_json(
                        &format!("/api/manage/tenants/{}", a.id),
                        &serde_json::json!({"enabled": false}),
                    )
                    .await?;
                println!("{}", resp.text().await?);
            }
            TenantCommands::MapIp(a) => {
                let resp = client
                    .post_json(
                        &format!("/api/manage/tenants/{}/ip-mappings", a.tenant_id),
                        &serde_json::json!({"ip_address": a.ip}),
                    )
                    .await?;
                println!("{}", resp.text().await?);
            }
            TenantCommands::EnablePlugin(a) => {
                let (ns, name) = parse_plugin_id(&a.plugin)?;
                let resp = client
                    .put_json(
                        &format!(
                            "/api/manage/tenants/{}/plugins/{}/{}/enabled",
                            a.tenant_id, ns, name
                        ),
                        &serde_json::json!({"enabled": true}),
                    )
                    .await?;
                println!("{}", resp.text().await?);
            }
            TenantCommands::DisablePlugin(a) => {
                let (ns, name) = parse_plugin_id(&a.plugin)?;
                let resp = client
                    .put_json(
                        &format!(
                            "/api/manage/tenants/{}/plugins/{}/{}/enabled",
                            a.tenant_id, ns, name
                        ),
                        &serde_json::json!({"enabled": false}),
                    )
                    .await?;
                println!("{}", resp.text().await?);
            }
            TenantCommands::SetPluginConfig(a) => {
                let (ns, name) = parse_plugin_id(&a.plugin)?;
                let tenant_id = &a.tenant_id;
                let config: serde_json::Value = serde_json::from_str(&a.json)?;
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
