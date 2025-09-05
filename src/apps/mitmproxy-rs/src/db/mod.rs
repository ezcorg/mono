use anyhow::Result;
use sqlx::{sqlite::SqliteConnectOptions, SqlitePool};
use std::str::FromStr;

pub struct Db {
    pub pool: SqlitePool,
}

/// A trait which allows inserting a struct into the database
pub trait Insert: Send + Sync {
    fn insert(&self, db: &mut Db) -> impl std::future::Future<Output = Result<()>>;
}

impl Db {
    pub fn new(pool: SqlitePool) -> Self {
        Db { pool }
    }

    pub async fn from_path(db_path: &str, password: &str) -> Result<Self> {
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
        let db_path_str = format!(
            "sqlite://{}",
            db_path.to_str().expect("Failed to convert path to string")
        );

        let password = "test_password";

        let db = Db::from_path(&db_path_str, password)
            .await
            .expect("Failed to create database");

        // Run migrations
        db.migrate().await.expect("Failed to run migrations");
    }

    #[tokio::test]
    async fn test_password_mismatch() {
        let temp_dir = tempdir().expect("Failed to create temp directory");
        let db_path = temp_dir.path().join("test.db");
        let db_path_str = format!(
            "sqlite://{}",
            db_path.to_str().expect("Failed to convert path to string")
        );

        let original_password = "correct_password";
        let wrong_password = "wrong_password";

        // Create database with original password
        {
            let db = Db::from_path(&db_path_str, original_password)
                .await
                .expect("Failed to create database with original password");

            // Run migrations to create tables and ensure the database is actually used
            db.migrate().await.expect("Failed to run migrations");
        } // Database connection is dropped here

        // Try to open the same database with a different password
        let wrong_db_result = Db::from_path(&db_path_str, wrong_password).await;

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
        let _correct_db = Db::from_path(&db_path_str, original_password)
            .await
            .expect("Database should open successfully with correct password");
    }
}
