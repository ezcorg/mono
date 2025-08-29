use std::collections::HashSet;

use crate::{config::PluginConfig, plugins::Plugin};

pub struct PluginRegistry {
    plugins: HashSet<Plugin>,
}

impl PluginRegistry {
    pub fn new(config: PluginConfig) -> Self {
        Self {
            plugins: HashSet::new(),
        }
    }
}
