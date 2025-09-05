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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (namespace, name)
);

-- Create plugin_event_handlers table
CREATE TABLE plugin_event_handlers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plugin_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    wasm BLOB NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(plugin_id, event_type, wasm)
);

-- Create plugin_capabilities table
CREATE TABLE plugin_capabilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plugin_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    granted BOOLEAN NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(plugin_id, capability, granted)
);

-- Create plugin_metadata table
CREATE TABLE plugin_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plugin_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(plugin_id, key)
);

-- Create indexes for better query performance
CREATE INDEX idx_plugin_event_handlers_plugin_id ON plugin_event_handlers(plugin_id);
CREATE INDEX idx_plugin_event_handlers_event_type ON plugin_event_handlers(event_type);
CREATE INDEX idx_plugin_capabilities_plugin_id ON plugin_capabilities(plugin_id);
CREATE INDEX idx_plugin_capabilities_capability ON plugin_capabilities(capability);
CREATE INDEX idx_plugin_metadata_plugin_id ON plugin_metadata(plugin_id);
CREATE INDEX idx_plugin_metadata_key ON plugin_metadata(key);