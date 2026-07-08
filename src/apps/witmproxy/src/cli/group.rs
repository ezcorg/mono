use anyhow::Result;
use conf::{Conf, Subcommands};

use crate::cli::api_client::ApiClient;

#[derive(Subcommands)]
#[conf(serde)]
pub enum GroupCommands {
    /// List all groups
    List,
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
    /// Group name
    #[arg(pos)]
    pub name: String,
}

#[derive(Conf)]
#[conf(serde)]
pub struct GroupIdArgs {
    /// Group ID
    #[arg(pos)]
    pub id: String,
}

#[derive(Conf)]
#[conf(serde)]
pub struct GroupMemberArgs {
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
    /// Group ID
    #[arg(pos)]
    pub group_id: String,
    /// Permission ID
    #[arg(pos)]
    pub permission_id: String,
}

pub struct GroupHandler;

impl GroupHandler {
    pub async fn handle(&self, command: &GroupCommands) -> Result<()> {
        let client = ApiClient::from_auth_store()?
            .ok_or_else(|| anyhow::anyhow!("Not authenticated. Run 'witm auth login' first."))?;

        match command {
            GroupCommands::List => {
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
