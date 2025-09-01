use std::path::PathBuf;

use anyhow::Result;
use sqlx::{migrate::Migrator, SqlitePool};

pub struct Db {
    pub pool: SqlitePool,
}

/// A trait which allows inserting a struct into the database
pub trait Insert: Send + Sync {
    fn insert(&self, db: &mut Db) -> impl std::future::Future<Output = Result<()>>;
}

impl Db {
    pub async fn new(pool: SqlitePool) -> Self {
        Db { pool }
    }

    /// Apply any pending database migrations stored in the specified directory
    pub async fn migrate(&mut self, dir: PathBuf) -> Result<()> {
        let m = Migrator::new(dir).await?;
        m.run(&self.pool).await.map_err(anyhow::Error::from)
    }
}
