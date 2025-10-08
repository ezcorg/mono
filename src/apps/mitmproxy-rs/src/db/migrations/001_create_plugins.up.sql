-- Create plugins table
CREATE TABLE plugins (
    namespace TEXT NOT NULL,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    author TEXT NOT NULL,
    description TEXT NOT NULL,
    license TEXT NOT NULL,
    url TEXT NOT NULL,
    publickey TEXT NOT NULL,
    enabled BOOLEAN NOT NULL,
    component BLOB NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (namespace, name)
);

-- Create plugin_capabilities table
CREATE TABLE plugin_capabilities (
    plugin_id TEXT NOT NULL references plugins(id),
    capability TEXT NOT NULL,
    granted BOOLEAN NOT NULL,
    PRIMARY KEY (plugin_id, capability)
);

-- Create plugin_metadata table
CREATE TABLE plugin_metadata (
    plugin_id TEXT NOT NULL references plugins(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (plugin_id, key)
);

-- Create indexes
CREATE INDEX idx_plugin_capabilities_plugin_id ON plugin_capabilities(plugin_id);
CREATE INDEX idx_plugin_capabilities_capability ON plugin_capabilities(capability);
CREATE INDEX idx_plugin_metadata_plugin_id ON plugin_metadata(plugin_id);
CREATE INDEX idx_plugin_metadata_key ON plugin_metadata(key);