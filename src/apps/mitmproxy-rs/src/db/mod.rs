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
}
