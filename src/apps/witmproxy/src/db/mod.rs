pub mod tenants;

#[cfg(test)]
mod tenant_tests;

use anyhow::Result;

pub use ezdb::{Db, Insert};

/// witmproxy's embedded schema migrations.
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("src/db/migrations");

/// `db.migrate()`: run witmproxy's migrations on an [`ezdb::Db`].
pub trait Migrate {
    fn migrate(&self) -> impl std::future::Future<Output = Result<()>> + Send;
}

impl Migrate for Db {
    // Written as `-> impl Future` rather than `async fn` so the trait's `Send`
    // bound is stated once, on the trait, and holds for every caller.
    #[allow(clippy::manual_async_fn)]
    fn migrate(&self) -> impl std::future::Future<Output = Result<()>> + Send {
        async move { self.migrate_with(&MIGRATOR).await }
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

    /// A password may contain any character a user (or a prompt) supplies —
    /// hyphens, spaces, single quotes. These must survive being handed to
    /// `PRAGMA key` (which requires a properly quoted SQL string literal), both
    /// when creating the database and when reopening it.
    #[tokio::test]
    async fn test_password_with_special_characters() {
        let temp_dir = tempdir().expect("Failed to create temp directory");
        let db_path = temp_dir.path().join("test.db");
        // Hyphen breaks a bare `PRAGMA key = value`; a single quote breaks a
        // naively single-quoted one.
        let password = "p-a s'sw\"ord-123";

        {
            let db = Db::from_path(db_path.clone(), password)
                .await
                .expect("create with special-character password");
            db.migrate().await.expect("migrate");
        }

        // Reopen with the same password: must succeed and be queryable.
        let db = Db::from_path(db_path.clone(), password)
            .await
            .expect("reopen with special-character password");
        sqlx::query("SELECT COUNT(*) FROM sqlite_master")
            .fetch_one(&db.pool)
            .await
            .expect("query after reopen with special-character password");
    }
}
