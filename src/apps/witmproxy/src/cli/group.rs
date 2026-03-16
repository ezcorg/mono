use anyhow::Result;
use clap::Subcommand;

use crate::cli::api_client::ApiClient;

#[derive(Subcommand)]
pub enum GroupCommands {
    /// List all groups
    List,
    /// Create a new group
    Create {
        /// Group name
        name: String,
    },
    /// Delete a group
    Delete {
        /// Group ID
        id: String,
    },
    /// Add a member to a group
    AddMember {
        /// Group ID
        group_id: String,
        /// Tenant ID
        tenant_id: String,
    },
    /// Remove a member from a group
    RemoveMember {
        /// Group ID
        group_id: String,
        /// Tenant ID
        tenant_id: String,
    },
    /// Add a permission to a group
    AddPermission {
        /// Group ID
        group_id: String,
        /// Effect: grant or deny
        effect: String,
        /// Resource pattern (e.g., plugins:*:read)
        resource: String,
    },
    /// Remove a permission from a group
    RemovePermission {
        /// Group ID
        group_id: String,
        /// Permission ID
        permission_id: String,
    },
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
            GroupCommands::Create { name } => {
                let resp = client
                    .post_json(
                        "/api/manage/groups",
                        &serde_json::json!({"name": name, "description": ""}),
                    )
                    .await?;
                println!("{}", resp.text().await?);
            }
            GroupCommands::Delete { id } => {
                let resp = client.delete(&format!("/api/manage/groups/{}", id)).await?;
                println!("{}", resp.text().await?);
            }
            GroupCommands::AddMember {
                group_id,
                tenant_id,
            } => {
                let resp = client
                    .post_json(
                        &format!("/api/manage/groups/{}/members", group_id),
                        &serde_json::json!({"tenant_id": tenant_id}),
                    )
                    .await?;
                println!("{}", resp.text().await?);
            }
            GroupCommands::RemoveMember {
                group_id,
                tenant_id,
            } => {
                let resp = client
                    .delete_json(
                        &format!("/api/manage/groups/{}/members", group_id),
                        &serde_json::json!({"tenant_id": tenant_id}),
                    )
                    .await?;
                println!("{}", resp.text().await?);
            }
            GroupCommands::AddPermission {
                group_id,
                effect,
                resource,
            } => {
                let resp = client
                    .post_json(
                        &format!("/api/manage/groups/{}/permissions", group_id),
                        &serde_json::json!({"effect": effect, "resource": resource}),
                    )
                    .await?;
                println!("{}", resp.text().await?);
            }
            GroupCommands::RemovePermission {
                group_id,
                permission_id,
            } => {
                let resp = client
                    .delete(&format!(
                        "/api/manage/groups/{}/permissions/{}",
                        group_id, permission_id
                    ))
                    .await?;
                println!("{}", resp.text().await?);
            }
        }
        Ok(())
    }
}
