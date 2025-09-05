use std::collections::HashMap;

use anyhow::Result;

use crate::{
    db::{Db, Insert},
    plugins::Plugin,
};

pub struct PluginRegistry {
    pub plugins: HashMap<String, Plugin>,
    pub db: Db,
}

impl PluginRegistry {
    pub fn new(db: Db) -> Self {
        Self {
            plugins: HashMap::new(),
            db,
        }
    }

    pub async fn load_plugins(&mut self) -> Result<HashMap<String, Plugin>> {
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
