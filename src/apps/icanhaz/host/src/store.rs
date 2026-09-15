//! The daemon's durable store: an encrypted SQLite file (`ezdb`) keyed from the
//! OS keychain, or a `0600` key file beside it where there is no keychain.
//!
//! Two generic tables serve every capability, so no capability owns a table:
//! [`Store::configuration`] / [`Store::set_configuration`] hold declared
//! configuration (typed by a `forms` schema, the analogue of witmproxy's
//! plugin configuration), and [`Store::state_get`] / [`Store::state_set`] /
//! [`Store::state_add`] are a per-owner key/value store, the host-side
//! analogue of a plugin's local-storage. Pairings and hosts still live in
//! their JSON files and move here with M3's durable grants.

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use sqlx::Row as _;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[derive(Clone)]
pub struct Store {
    db: ezdb::Db,
}

impl Store {
    /// The default location: `$ICANHAZ_DB`, else `~/.icanhaz/icanhaz.db`.
    pub fn default_path() -> PathBuf {
        std::env::var("ICANHAZ_DB")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string()))
                    .join(".icanhaz")
                    .join("icanhaz.db")
            })
    }

    /// Open (creating and migrating if needed) the store at `path`. The key is
    /// `$ICANHAZ_DB_KEY` when set (tests, headless boxes), else the machine's
    /// keychain, else a `0600` key file beside the database.
    pub async fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
        }
        let source = match std::env::var("ICANHAZ_DB_KEY") {
            Ok(key) if !key.is_empty() => ezdb::KeySource::Provided(ezdb::Key::from(key)),
            _ => ezdb::KeySource::default_for("icanhaz", dir),
        };
        Self::open_with(path, &source).await
    }

    pub async fn open_with(path: impl AsRef<Path>, source: &ezdb::KeySource) -> Result<Self> {
        let db = ezdb::Db::open(path, source).await?;
        db.migrate_with(&MIGRATOR).await?;
        Ok(Self { db })
    }

    // --- declared configuration -------------------------------------------

    /// Every `(name, value)` configured for `owner`; `value` is a
    /// `forms.actual-input` as JSON.
    pub async fn configuration(&self, owner: &str) -> Result<Vec<(String, serde_json::Value)>> {
        let rows =
            sqlx::query("SELECT name, value FROM configuration WHERE owner = ? ORDER BY name")
                .bind(owner)
                .fetch_all(&self.db.pool)
                .await?;
        rows.into_iter()
            .map(|row| {
                let name: String = row.try_get("name")?;
                let value: String = row.try_get("value")?;
                Ok((name, serde_json::from_str(&value)?))
            })
            .collect()
    }

    /// Owners whose name starts with `prefix` (e.g. `inference/`), so a
    /// capability can enumerate its configured instances.
    pub async fn owners(&self, prefix: &str) -> Result<Vec<String>> {
        let rows = sqlx::query(
            "SELECT DISTINCT owner FROM configuration WHERE owner LIKE ? ORDER BY owner",
        )
        .bind(format!("{}%", prefix.replace('%', "\\%")))
        .fetch_all(&self.db.pool)
        .await?;
        rows.into_iter().map(|r| Ok(r.try_get("owner")?)).collect()
    }

    pub async fn set_configuration(
        &self,
        owner: &str,
        name: &str,
        value: &serde_json::Value,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO configuration (owner, name, value) VALUES (?, ?, ?)
             ON CONFLICT(owner, name) DO UPDATE SET value = excluded.value",
        )
        .bind(owner)
        .bind(name)
        .bind(serde_json::to_string(value)?)
        .execute(&self.db.pool)
        .await?;
        Ok(())
    }

    /// Remove every configured value for `owner`.
    pub async fn clear_configuration(&self, owner: &str) -> Result<bool> {
        let done = sqlx::query("DELETE FROM configuration WHERE owner = ?")
            .bind(owner)
            .execute(&self.db.pool)
            .await?;
        Ok(done.rows_affected() > 0)
    }

    // --- per-owner state --------------------------------------------------

    pub async fn state_get(&self, owner: &str, key: &str) -> Result<Option<Vec<u8>>> {
        let row = sqlx::query("SELECT value FROM state WHERE owner = ? AND key = ?")
            .bind(owner)
            .bind(key)
            .fetch_optional(&self.db.pool)
            .await?;
        row.map(|r| r.try_get::<Vec<u8>, _>("value").map_err(Into::into))
            .transpose()
    }

    pub async fn state_set(&self, owner: &str, key: &str, value: &[u8]) -> Result<()> {
        sqlx::query(
            "INSERT INTO state (owner, key, value) VALUES (?, ?, ?)
             ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value",
        )
        .bind(owner)
        .bind(key)
        .bind(value)
        .execute(&self.db.pool)
        .await?;
        Ok(())
    }

    pub async fn state_delete(&self, owner: &str, key: &str) -> Result<bool> {
        let done = sqlx::query("DELETE FROM state WHERE owner = ? AND key = ?")
            .bind(owner)
            .bind(key)
            .execute(&self.db.pool)
            .await?;
        Ok(done.rows_affected() > 0)
    }

    /// Treat the value as a decimal integer counter: add `delta` atomically
    /// and return the new total. A missing or non-numeric value counts as 0.
    pub async fn state_add(&self, owner: &str, key: &str, delta: i64) -> Result<i64> {
        let mut tx = self.db.pool.begin().await?;
        let current: i64 = sqlx::query("SELECT value FROM state WHERE owner = ? AND key = ?")
            .bind(owner)
            .bind(key)
            .fetch_optional(&mut *tx)
            .await?
            .and_then(|r| r.try_get::<Vec<u8>, _>("value").ok())
            .and_then(|v| String::from_utf8(v).ok())
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0);
        let next = current.saturating_add(delta);
        sqlx::query(
            "INSERT INTO state (owner, key, value) VALUES (?, ?, ?)
             ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value",
        )
        .bind(owner)
        .bind(key)
        .bind(next.to_string().into_bytes())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(next)
    }

    /// The integer counter at `key`, or 0.
    pub async fn state_counter(&self, owner: &str, key: &str) -> Result<i64> {
        Ok(self
            .state_get(owner, key)
            .await?
            .and_then(|v| String::from_utf8(v).ok())
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0))
    }
}

/// Today as days since the Unix epoch (UTC): a stable key for per-day counters.
pub fn today() -> i64 {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (secs / 86_400) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn configuration_and_state_are_generic_per_owner_tables() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let store = Store::open_with(dir.path().join("icanhaz.db"), &source).await?;
        assert!(store.configuration("inference/local").await?.is_empty());

        store
            .set_configuration(
                "inference/local",
                "base_url",
                &serde_json::json!({"str": "http://127.0.0.1:11434/v1"}),
            )
            .await?;
        store
            .set_configuration(
                "inference/local",
                "api_key",
                &serde_json::json!({"secret": "k"}),
            )
            .await?;
        store
            .set_configuration(
                "watch/defaults",
                "recursive",
                &serde_json::json!({"boolean": true}),
            )
            .await?;
        let cfg = store.configuration("inference/local").await?;
        assert_eq!(cfg.len(), 2);
        assert_eq!(cfg[0].0, "api_key");
        assert_eq!(store.owners("inference/").await?, vec!["inference/local"]);

        assert_eq!(store.state_get("inference", "budget:local:1").await?, None);
        assert_eq!(
            store.state_add("inference", "budget:local:1", 40).await?,
            40
        );
        assert_eq!(store.state_add("inference", "budget:local:1", 2).await?, 42);
        assert_eq!(
            store.state_counter("inference", "budget:local:1").await?,
            42
        );
        assert_eq!(store.state_counter("inference", "budget:local:2").await?, 0);
        store.state_set("inference", "blob", b"\x00\x01").await?;
        assert_eq!(
            store.state_get("inference", "blob").await?,
            Some(vec![0, 1])
        );

        // Reopening with the same key sees the same rows.
        drop(store);
        let store = Store::open_with(dir.path().join("icanhaz.db"), &source).await?;
        assert_eq!(
            store.state_counter("inference", "budget:local:1").await?,
            42
        );
        assert!(store.clear_configuration("inference/local").await?);
        assert!(store.state_delete("inference", "blob").await?);
        Ok(())
    }
}
