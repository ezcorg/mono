use std::{collections::HashMap, path::PathBuf, sync::Arc};

use anyhow::Result;
use sqlx::{Pool, Sqlite};

use crate::{
    config::PluginConfig,
    db::{Db, Insert},
    plugins::{capability::Capability, Plugin},
};

pub struct PluginRegistry {
    pub plugins: HashMap<String, Plugin>,
    pub db: Db,
}

impl PluginRegistry {
    pub fn new(config: PluginConfig, db: Db) -> Self {
        Self {
            plugins: HashMap::new(),
            db,
        }
    }

    pub async fn load_plugins(
        &mut self,
        path: PathBuf,
        key: String,
    ) -> Result<HashMap<String, Plugin>> {
        // select all enabled plugins from the database
        // for each plugin, verify its integrity
        // if any plugin is invalid, disable it and update its status
        // otherwise, load up their wasm event handlers
        Ok(HashMap::new())
    }

    pub async fn register_plugin(&mut self, plugin: Plugin) -> Result<()> {
        // Upsert the given plugin into the database
        plugin.insert(&mut self.db).await?;
        // Add it to the registry
        self.plugins.insert(plugin.id(), plugin);
        Ok(())
    }
}
