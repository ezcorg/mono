use anyhow::Result;
use sqlx::{Sqlite, SqlitePool, Transaction, sqlite::SqliteConnectOptions};
use std::path::PathBuf;
use std::str::FromStr;

pub struct Db {
    pub pool: SqlitePool,
}

/// A trait which allows inserting a struct into the database
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

    pub async fn from_path(db_path: PathBuf, password: &str) -> Result<Self> {
        let db_path_str = db_path.to_string_lossy();
        let db_path = if !db_path_str.starts_with("sqlite://") {
            format!("sqlite://{}", db_path_str)
        } else {
            db_path_str.to_string()
        };

        let options = SqliteConnectOptions::from_str(&db_path)?
            .pragma("key", password.to_owned())
            .create_if_missing(true);

        // TODO: configure pool
        let pool = sqlx::SqlitePool::connect_with(options).await?;
        Ok(Db { pool })
    }

    /// Run embedded application database migrations
    pub async fn migrate(&self) -> Result<()> {
        sqlx::migrate!("src/db/migrations")
            .run(&self.pool)
            .await
            .map_err(|e| anyhow::anyhow!("Database migration failed: {}", e))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_migrations() {
        let temp_dir = tempdir().expect("Failed to create temp directory");
        let db_path = temp_dir.path().join("test.db");
        let password = "test_password";

        let db = Db::from_path(db_path, password)
            .await
            .expect("Failed to create database");

        // Run migrations
        db.migrate().await.expect("Failed to run migrations");

        // Check we have the expected tables
        let tables: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM
            sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';",
        )
        .fetch_all(&db.pool)
        .await
        .expect("Failed to query tables");
        let table_names: Vec<String> = tables.into_iter().map(|t| t.0).collect();
        let expected_tables = vec!["plugins", "plugin_capabilities", "plugin_metadata"];
        for table in expected_tables {
            assert!(
                table_names.contains(&table.to_string()),
                "Expected table '{}' not found in database",
                table
            );
        }
    }

    #[tokio::test]
    async fn test_password_mismatch() {
        let temp_dir = tempdir().expect("Failed to create temp directory");
        let db_path = temp_dir.path().join("test.db");
        let original_password = "correct_password";
        let wrong_password = "wrong_password";

        // Create database with original password
        {
            let db = Db::from_path(db_path.clone(), original_password)
                .await
                .expect("Failed to create database with original password");

            // Run migrations to create tables and ensure the database is actually used
            db.migrate().await.expect("Failed to run migrations");
        } // Database connection is dropped here

        // Try to open the same database with a different password
        let wrong_db_result = Db::from_path(db_path.clone(), wrong_password).await;

        // The database should either fail to open or fail when we try to query it
        match wrong_db_result {
            Err(_) => {
                // Good! The database failed to open with wrong password
            }
            Ok(wrong_db) => {
                // If it opens, it should fail when we try to query the encrypted data
                let query_result = sqlx::query("SELECT COUNT(*) FROM sqlite_master")
                    .fetch_one(&wrong_db.pool)
                    .await;

                assert!(
                    query_result.is_err(),
                    "Database query should fail with wrong password, but it succeeded"
                );
            }
        }

        // Verify we can still open with the correct password
        let _correct_db = Db::from_path(db_path, original_password)
            .await
            .expect("Database should open successfully with correct password");
    }
}
