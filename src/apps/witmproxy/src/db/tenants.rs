use anyhow::Result;
use sqlx::SqlitePool;

use crate::acl::{Effect, Permission};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Tenant {
    pub id: String,
    pub display_name: String,
    pub email: Option<String>,
    pub password_hash: Option<String>,
    pub oidc_provider: Option<String>,
    pub oidc_subject: Option<String>,
    pub enabled: bool,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TenantPluginOverride {
    pub tenant_id: String,
    pub plugin_namespace: String,
    pub plugin_name: String,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TenantPluginConfig {
    pub tenant_id: String,
    pub plugin_namespace: String,
    pub plugin_name: String,
    pub input_name: String,
    pub input_value: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TenantIpMapping {
    pub tenant_id: String,
    pub ip_address: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
#[allow(dead_code)]
struct DbPermission {
    id: String,
    group_id: String,
    effect: String,
    resource: String,
}

impl Tenant {
    pub async fn by_id(pool: &SqlitePool, id: &str) -> Result<Option<Self>> {
        let tenant = sqlx::query_as::<_, Tenant>("SELECT * FROM tenants WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await?;
        Ok(tenant)
    }

    pub async fn by_email(pool: &SqlitePool, email: &str) -> Result<Option<Self>> {
        let tenant = sqlx::query_as::<_, Tenant>("SELECT * FROM tenants WHERE email = ?")
            .bind(email)
            .fetch_optional(pool)
            .await?;
        Ok(tenant)
    }

    pub async fn by_oidc(pool: &SqlitePool, provider: &str, subject: &str) -> Result<Option<Self>> {
        let tenant = sqlx::query_as::<_, Tenant>(
            "SELECT * FROM tenants WHERE oidc_provider = ? AND oidc_subject = ?",
        )
        .bind(provider)
        .bind(subject)
        .fetch_optional(pool)
        .await?;
        Ok(tenant)
    }

    pub async fn by_ip(pool: &SqlitePool, ip: &str) -> Result<Option<Self>> {
        let tenant = sqlx::query_as::<_, Tenant>(
            "SELECT t.* FROM tenants t
             JOIN tenant_ip_mappings m ON t.id = m.tenant_id
             WHERE m.ip_address = ?",
        )
        .bind(ip)
        .fetch_optional(pool)
        .await?;
        Ok(tenant)
    }

    pub async fn all(pool: &SqlitePool) -> Result<Vec<Self>> {
        let tenants = sqlx::query_as::<_, Tenant>("SELECT * FROM tenants")
            .fetch_all(pool)
            .await?;
        Ok(tenants)
    }

    pub async fn create(
        pool: &SqlitePool,
        id: &str,
        display_name: &str,
        email: Option<&str>,
        password_hash: Option<&str>,
        oidc_provider: Option<&str>,
        oidc_subject: Option<&str>,
    ) -> Result<Self> {
        sqlx::query(
            "INSERT INTO tenants (id, display_name, email, password_hash, oidc_provider, oidc_subject)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(display_name)
        .bind(email)
        .bind(password_hash)
        .bind(oidc_provider)
        .bind(oidc_subject)
        .execute(pool)
        .await?;

        Tenant::by_id(pool, id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Failed to retrieve created tenant"))
    }

    pub async fn update_enabled(pool: &SqlitePool, id: &str, enabled: bool) -> Result<()> {
        sqlx::query("UPDATE tenants SET enabled = ? WHERE id = ?")
            .bind(enabled)
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn delete(pool: &SqlitePool, id: &str) -> Result<bool> {
        let result = sqlx::query("DELETE FROM tenants WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn groups(&self, pool: &SqlitePool) -> Result<Vec<Group>> {
        let groups = sqlx::query_as::<_, Group>(
            "SELECT g.* FROM groups g
             JOIN tenant_groups tg ON g.id = tg.group_id
             WHERE tg.tenant_id = ?",
        )
        .bind(&self.id)
        .fetch_all(pool)
        .await?;
        Ok(groups)
    }

    /// Get all permissions for this tenant (aggregated from all groups).
    pub async fn permissions(&self, pool: &SqlitePool) -> Result<Vec<Permission>> {
        let db_perms = sqlx::query_as::<_, DbPermission>(
            "SELECT p.* FROM permissions p
             JOIN tenant_groups tg ON p.group_id = tg.group_id
             WHERE tg.tenant_id = ?",
        )
        .bind(&self.id)
        .fetch_all(pool)
        .await?;

        db_perms
            .into_iter()
            .map(|p| {
                let effect: Effect = p.effect.parse()?;
                Ok(Permission::new(effect, &p.resource))
            })
            .collect()
    }

    pub async fn plugin_overrides(&self, pool: &SqlitePool) -> Result<Vec<TenantPluginOverride>> {
        let overrides = sqlx::query_as::<_, TenantPluginOverride>(
            "SELECT * FROM tenant_plugin_overrides WHERE tenant_id = ?",
        )
        .bind(&self.id)
        .fetch_all(pool)
        .await?;
        Ok(overrides)
    }

    pub async fn plugin_config(&self, pool: &SqlitePool) -> Result<Vec<TenantPluginConfig>> {
        let config = sqlx::query_as::<_, TenantPluginConfig>(
            "SELECT * FROM tenant_plugin_configuration WHERE tenant_id = ?",
        )
        .bind(&self.id)
        .fetch_all(pool)
        .await?;
        Ok(config)
    }

    pub async fn ip_mappings(&self, pool: &SqlitePool) -> Result<Vec<TenantIpMapping>> {
        let mappings = sqlx::query_as::<_, TenantIpMapping>(
            "SELECT * FROM tenant_ip_mappings WHERE tenant_id = ?",
        )
        .bind(&self.id)
        .fetch_all(pool)
        .await?;
        Ok(mappings)
    }
}

impl Group {
    pub async fn by_id(pool: &SqlitePool, id: &str) -> Result<Option<Self>> {
        let group = sqlx::query_as::<_, Group>("SELECT * FROM groups WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await?;
        Ok(group)
    }

    pub async fn by_name(pool: &SqlitePool, name: &str) -> Result<Option<Self>> {
        let group = sqlx::query_as::<_, Group>("SELECT * FROM groups WHERE name = ?")
            .bind(name)
            .fetch_optional(pool)
            .await?;
        Ok(group)
    }

    pub async fn all(pool: &SqlitePool) -> Result<Vec<Self>> {
        let groups = sqlx::query_as::<_, Group>("SELECT * FROM groups")
            .fetch_all(pool)
            .await?;
        Ok(groups)
    }

    pub async fn create(
        pool: &SqlitePool,
        id: &str,
        name: &str,
        description: &str,
    ) -> Result<Self> {
        sqlx::query("INSERT INTO groups (id, name, description) VALUES (?, ?, ?)")
            .bind(id)
            .bind(name)
            .bind(description)
            .execute(pool)
            .await?;

        Group::by_id(pool, id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Failed to retrieve created group"))
    }

    pub async fn delete(pool: &SqlitePool, id: &str) -> Result<bool> {
        let result = sqlx::query("DELETE FROM groups WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn add_member(pool: &SqlitePool, group_id: &str, tenant_id: &str) -> Result<()> {
        sqlx::query("INSERT OR IGNORE INTO tenant_groups (tenant_id, group_id) VALUES (?, ?)")
            .bind(tenant_id)
            .bind(group_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn remove_member(pool: &SqlitePool, group_id: &str, tenant_id: &str) -> Result<()> {
        sqlx::query("DELETE FROM tenant_groups WHERE tenant_id = ? AND group_id = ?")
            .bind(tenant_id)
            .bind(group_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn add_permission(
        pool: &SqlitePool,
        id: &str,
        group_id: &str,
        effect: &str,
        resource: &str,
    ) -> Result<()> {
        sqlx::query("INSERT INTO permissions (id, group_id, effect, resource) VALUES (?, ?, ?, ?)")
            .bind(id)
            .bind(group_id)
            .bind(effect)
            .bind(resource)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn remove_permission(pool: &SqlitePool, permission_id: &str) -> Result<bool> {
        let result = sqlx::query("DELETE FROM permissions WHERE id = ?")
            .bind(permission_id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn permissions(pool: &SqlitePool, group_id: &str) -> Result<Vec<Permission>> {
        let db_perms =
            sqlx::query_as::<_, DbPermission>("SELECT * FROM permissions WHERE group_id = ?")
                .bind(group_id)
                .fetch_all(pool)
                .await?;

        db_perms
            .into_iter()
            .map(|p| {
                let effect: Effect = p.effect.parse()?;
                Ok(Permission::new(effect, &p.resource))
            })
            .collect()
    }
}

pub async fn set_plugin_override(
    pool: &SqlitePool,
    tenant_id: &str,
    plugin_namespace: &str,
    plugin_name: &str,
    enabled: Option<bool>,
) -> Result<()> {
    sqlx::query(
        "INSERT OR REPLACE INTO tenant_plugin_overrides (tenant_id, plugin_namespace, plugin_name, enabled)
         VALUES (?, ?, ?, ?)",
    )
    .bind(tenant_id)
    .bind(plugin_namespace)
    .bind(plugin_name)
    .bind(enabled)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn set_plugin_config(
    pool: &SqlitePool,
    tenant_id: &str,
    plugin_namespace: &str,
    plugin_name: &str,
    input_name: &str,
    input_value: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT OR REPLACE INTO tenant_plugin_configuration
         (tenant_id, plugin_namespace, plugin_name, input_name, input_value)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(tenant_id)
    .bind(plugin_namespace)
    .bind(plugin_name)
    .bind(input_name)
    .bind(input_value)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn add_ip_mapping(pool: &SqlitePool, tenant_id: &str, ip_address: &str) -> Result<()> {
    sqlx::query("INSERT OR IGNORE INTO tenant_ip_mappings (tenant_id, ip_address) VALUES (?, ?)")
        .bind(tenant_id)
        .bind(ip_address)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn remove_ip_mapping(pool: &SqlitePool, tenant_id: &str, ip_address: &str) -> Result<()> {
    sqlx::query("DELETE FROM tenant_ip_mappings WHERE tenant_id = ? AND ip_address = ?")
        .bind(tenant_id)
        .bind(ip_address)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn tenant_by_ip(pool: &SqlitePool, ip: &str) -> Result<Option<Tenant>> {
    Tenant::by_ip(pool, ip).await
}
