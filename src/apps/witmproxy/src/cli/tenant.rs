use anyhow::Result;
use conf::{Conf, Subcommands};

use super::GlobalArgs;
use crate::cli::api_client::{ApiClient, DaemonArgs, DaemonAuthArgs, LocalDaemon};
use crate::config::Instance;

#[derive(Subcommands)]
#[conf(serde)]
pub enum TenantCommands {
    /// List all tenants
    List(DaemonArgs),
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
    #[conf(flatten)]
    pub auth: DaemonAuthArgs,

    /// Display name
    #[arg(pos)]
    pub display_name: String,
    /// Tenant ID (generated when omitted)
    #[arg(long)]
    pub id: Option<String>,
    /// Email address
    #[arg(long)]
    pub email: Option<String>,
}

#[derive(Conf)]
#[conf(serde)]
pub struct TenantIdArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,
    #[conf(flatten)]
    pub auth: DaemonAuthArgs,

    /// Tenant ID
    #[arg(pos)]
    pub id: String,
}

#[derive(Conf)]
#[conf(serde)]
pub struct TenantMapIpArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,
    #[conf(flatten)]
    pub auth: DaemonAuthArgs,

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
    #[conf(flatten)]
    pub auth: DaemonAuthArgs,

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
    #[conf(flatten)]
    pub auth: DaemonAuthArgs,

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
            TenantCommands::List(a) => &a.globals,
            TenantCommands::Create(a) => &a.globals,
            TenantCommands::Enable(a) | TenantCommands::Disable(a) => &a.globals,
            TenantCommands::MapIp(a) => &a.globals,
            TenantCommands::EnablePlugin(a) | TenantCommands::DisablePlugin(a) => &a.globals,
            TenantCommands::SetPluginConfig(a) => &a.globals,
        }
    }

    pub(crate) fn auth(&self) -> &DaemonAuthArgs {
        match self {
            TenantCommands::List(a) => &a.auth,
            TenantCommands::Create(a) => &a.auth,
            TenantCommands::Enable(a) | TenantCommands::Disable(a) => &a.auth,
            TenantCommands::MapIp(a) => &a.auth,
            TenantCommands::EnablePlugin(a) | TenantCommands::DisablePlugin(a) => &a.auth,
            TenantCommands::SetPluginConfig(a) => &a.auth,
        }
    }
}

/// Talks to one instance's daemon (or the server logged in to for it).
pub struct TenantHandler {
    instance: Instance,
}

impl TenantHandler {
    pub fn new(instance: Instance) -> Self {
        Self { instance }
    }

    pub async fn handle(&self, command: &TenantCommands) -> Result<()> {
        let client =
            ApiClient::resolve_required(command.auth(), LocalDaemon::for_instance(&self.instance))?;

        match command {
            TenantCommands::List(_) => {
                let resp = client.get("/api/manage/tenants").await?;
                let body = client.body(resp).await?;
                println!("{}", body);
            }
            TenantCommands::Create(a) => {
                let resp = client
                    .post_json(
                        "/api/manage/tenants",
                        &serde_json::json!({
                            "id": a.id,
                            "display_name": a.display_name,
                            "email": a.email,
                        }),
                    )
                    .await?;
                println!("{}", client.body(resp).await?);
            }
            TenantCommands::Enable(a) => {
                let resp = client
                    .put_json(
                        &format!("/api/manage/tenants/{}", a.id),
                        &serde_json::json!({"enabled": true}),
                    )
                    .await?;
                println!("{}", client.body(resp).await?);
            }
            TenantCommands::Disable(a) => {
                let resp = client
                    .put_json(
                        &format!("/api/manage/tenants/{}", a.id),
                        &serde_json::json!({"enabled": false}),
                    )
                    .await?;
                println!("{}", client.body(resp).await?);
            }
            TenantCommands::MapIp(a) => {
                let resp = client
                    .post_json(
                        &format!("/api/manage/tenants/{}/ip-mappings", a.tenant_id),
                        &serde_json::json!({"ip_address": a.ip}),
                    )
                    .await?;
                println!("{}", client.body(resp).await?);
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
                println!("{}", client.body(resp).await?);
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
                println!("{}", client.body(resp).await?);
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
                println!("{}", client.body(resp).await?);
            }
        }
        Ok(())
    }
}

fn parse_plugin_id(plugin: &str) -> Result<(&str, &str)> {
    // Match the shape rather than checking a length and then indexing: one
    // statement the compiler verifies instead of two that have to agree.
    match plugin.splitn(2, '/').collect::<Vec<_>>().as_slice() {
        [namespace, name] => Ok((namespace, name)),
        _ => anyhow::bail!("Plugin must be in 'namespace/name' format, got: {}", plugin),
    }
}
