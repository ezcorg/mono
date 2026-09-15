//! `ezdb`: an encrypted SQLite store shared by the ezco hosts.
//!
//! The database is SQLCipher (via `libsqlite3-sys`'s bundled build), so the
//! file is encrypted at rest. What makes that worth anything is where the key
//! lives: [`KeySource`] resolves it from the OS keychain when one is available
//! and otherwise from a key file beside the database with `0600` permissions,
//! creating either on first use. A caller that already holds a passphrase
//! (witmproxy's `--db-password`) passes it directly.
//!
//! Migrations stay with each application: `sqlx::migrate!` needs a path
//! relative to the calling crate, so apps hold the `Migrator` and hand it to
//! [`Db::migrate_with`].

pub mod key;

use std::path::Path;
use std::str::FromStr;

use anyhow::{Context as _, Result};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Sqlite, SqlitePool, Transaction};

pub use key::{Key, KeyError, KeySource};

/// A pool over one encrypted SQLite file.
#[derive(Clone)]
pub struct Db {
    pub pool: SqlitePool,
}

/// A row type that knows how to insert itself.
pub trait Insert: Send + Sync {
    fn insert_tx(
        &self,
        db: &mut Db,
    ) -> impl std::future::Future<Output = Result<Transaction<'_, Sqlite>>> + Send;

    fn insert(&self, db: &mut Db) -> impl std::future::Future<Output = Result<()>> + Send {
        async move {
            let tx = self.insert_tx(db).await?;
            tx.commit().await?;
            Ok(())
        }
    }
}

impl Db {
    pub fn new(pool: SqlitePool) -> Self {
        Db { pool }
    }

    /// Open (creating if missing) the database at `db_path` with `key` as the
    /// SQLCipher passphrase. Accepts a plain path or a `sqlite://` URL.
    pub async fn from_path(db_path: impl AsRef<Path>, key: &str) -> Result<Self> {
        let db_path_str = db_path.as_ref().to_string_lossy();
        let url = if db_path_str.starts_with("sqlite://") {
            db_path_str.to_string()
        } else {
            format!("sqlite://{db_path_str}")
        };
        // SQLCipher wants `PRAGMA key = '<passphrase>'` — a SQL string literal.
        // sqlx emits the pragma value verbatim, so quote it here and double any
        // embedded single quotes; otherwise a passphrase containing a hyphen,
        // space, or quote produces a syntax error or the wrong key.
        let quoted_key = format!("'{}'", key.replace('\'', "''"));
        let options = SqliteConnectOptions::from_str(&url)
            .with_context(|| format!("database url {url}"))?
            .pragma("key", quoted_key)
            .create_if_missing(true);
        let pool = SqlitePool::connect_with(options)
            .await
            .with_context(|| format!("open database {db_path_str}"))?;
        Ok(Db { pool })
    }

    /// Open the database at `db_path`, resolving (and on first use creating)
    /// its key through `source`.
    pub async fn open(db_path: impl AsRef<Path>, source: &KeySource) -> Result<Self> {
        let key = source.resolve()?;
        Self::from_path(db_path, key.expose()).await
    }

    /// Run an application's embedded migrations.
    pub async fn migrate_with(&self, migrator: &sqlx::migrate::Migrator) -> Result<()> {
        migrator
            .run(&self.pool)
            .await
            .map_err(|e| anyhow::anyhow!("database migration failed: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn count(db: &Db) -> Result<i64> {
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM t")
            .fetch_one(&db.pool)
            .await?;
        Ok(n)
    }

    #[tokio::test]
    async fn a_file_key_is_created_once_and_reopens_the_database() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let db_path = dir.path().join("store.db");
        let source = KeySource::File(dir.path().join("store.key"));

        let db = Db::open(&db_path, &source).await?;
        sqlx::query("CREATE TABLE t (v TEXT)")
            .execute(&db.pool)
            .await?;
        sqlx::query("INSERT INTO t VALUES ('x')")
            .execute(&db.pool)
            .await?;
        assert_eq!(count(&db).await?, 1);
        drop(db);

        // Same source, same key: the data is there.
        let db = Db::open(&db_path, &source).await?;
        assert_eq!(count(&db).await?, 1);
        drop(db);

        // A different key does not open it (the header is ciphertext).
        let wrong = Db::from_path(&db_path, "not-the-key").await?;
        assert!(count(&wrong).await.is_err());
        Ok(())
    }

    #[tokio::test]
    async fn a_chain_falls_through_to_the_first_source_that_works() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let file = dir.path().join("k");
        let source = KeySource::Chain(vec![
            KeySource::Env("EZDB_TEST_KEY_THAT_IS_NOT_SET".to_string()),
            KeySource::File(file.clone()),
        ]);
        let a = source.resolve()?;
        let b = source.resolve()?;
        assert_eq!(a.expose(), b.expose(), "the file key is stable");
        assert!(file.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file)?.permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        Ok(())
    }

    #[test]
    fn a_provided_key_is_used_verbatim_and_never_printed() {
        let source = KeySource::Provided(Key::from("s3cret"));
        let key = source.resolve().map(|k| k.expose().to_string());
        assert_eq!(key.ok().as_deref(), Some("s3cret"));
        assert_eq!(format!("{:?}", Key::from("s3cret")), "[REDACTED]");
    }
}
