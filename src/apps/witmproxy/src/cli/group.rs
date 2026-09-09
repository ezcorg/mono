use anyhow::Result;
use conf::{Conf, Subcommands};

use super::GlobalArgs;
use crate::cli::api_client::ApiClient;

#[derive(Subcommands)]
#[conf(serde)]
pub enum GroupCommands {
    /// List all groups
    List(GlobalArgs),
    /// Create a new group
    Create(GroupCreateArgs),
    /// Delete a group
    Delete(GroupIdArgs),
    /// Add a member to a group
    AddMember(GroupMemberArgs),
    /// Remove a member from a group
    RemoveMember(GroupMemberArgs),
    /// Add a permission to a group
    AddPermission(GroupAddPermArgs),
    /// Remove a permission from a group
    RemovePermission(GroupRemovePermArgs),
}

#[derive(Conf)]
#[conf(serde)]
pub struct GroupCreateArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,

    /// Group name
    #[arg(pos)]
    pub name: String,
}

#[derive(Conf)]
#[conf(serde)]
pub struct GroupIdArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,

    /// Group ID
    #[arg(pos)]
    pub id: String,
}

#[derive(Conf)]
#[conf(serde)]
pub struct GroupMemberArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,

    /// Group ID
    #[arg(pos)]
    pub group_id: String,
    /// Tenant ID
    #[arg(pos)]
    pub tenant_id: String,
}

#[derive(Conf)]
#[conf(serde)]
pub struct GroupAddPermArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,

    /// Group ID
    #[arg(pos)]
    pub group_id: String,
    /// Effect: grant or deny
    #[arg(pos)]
    pub effect: String,
    /// Resource pattern (e.g., plugins:*:read)
    #[arg(pos)]
    pub resource: String,
}

#[derive(Conf)]
#[conf(serde)]
pub struct GroupRemovePermArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,

    /// Group ID
    #[arg(pos)]
    pub group_id: String,
    /// Permission ID
    #[arg(pos)]
    pub permission_id: String,
}

impl GroupCommands {
    pub(crate) fn globals(&self) -> &GlobalArgs {
        match self {
            GroupCommands::List(g) => g,
            GroupCommands::Create(a) => &a.globals,
            GroupCommands::Delete(a) => &a.globals,
            GroupCommands::AddMember(a) | GroupCommands::RemoveMember(a) => &a.globals,
            GroupCommands::AddPermission(a) => &a.globals,
            GroupCommands::RemovePermission(a) => &a.globals,
        }
    }
}

pub struct GroupHandler;

impl GroupHandler {
    pub async fn handle(&self, command: &GroupCommands) -> Result<()> {
        let client = ApiClient::from_auth_store()?
            .ok_or_else(|| anyhow::anyhow!("Not authenticated. Run 'witm auth login' first."))?;

        match command {
            GroupCommands::List(_) => {
                let resp = client.get("/api/manage/groups").await?;
                println!("{}", resp.text().await?);
            }
            GroupCommands::Create(a) => {
                let resp = client
                    .post_json(
                        "/api/manage/groups",
                        &serde_json::json!({"name": a.name, "description": ""}),
                    )
                    .await?;
                println!("{}", resp.text().await?);
            }
            GroupCommands::Delete(a) => {
                let resp = client
                    .delete(&format!("/api/manage/groups/{}", a.id))
                    .await?;
                println!("{}", resp.text().await?);
            }
            GroupCommands::AddMember(a) => {
                let resp = client
                    .post_json(
                        &format!("/api/manage/groups/{}/members", a.group_id),
                        &serde_json::json!({"tenant_id": a.tenant_id}),
                    )
                    .await?;
                println!("{}", resp.text().await?);
            }
            GroupCommands::RemoveMember(a) => {
                let resp = client
                    .delete_json(
                        &format!("/api/manage/groups/{}/members", a.group_id),
                        &serde_json::json!({"tenant_id": a.tenant_id}),
                    )
                    .await?;
                println!("{}", resp.text().await?);
            }
            GroupCommands::AddPermission(a) => {
                let resp = client
                    .post_json(
                        &format!("/api/manage/groups/{}/permissions", a.group_id),
                        &serde_json::json!({"effect": a.effect, "resource": a.resource}),
                    )
                    .await?;
                println!("{}", resp.text().await?);
            }
            GroupCommands::RemovePermission(a) => {
                let resp = client
                    .delete(&format!(
                        "/api/manage/groups/{}/permissions/{}",
                        a.group_id, a.permission_id
                    ))
                    .await?;
                println!("{}", resp.text().await?);
            }
        }
        Ok(())
    }
}
