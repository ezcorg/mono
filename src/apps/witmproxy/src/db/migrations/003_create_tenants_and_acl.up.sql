CREATE TABLE tenants (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT,
    oidc_provider TEXT,
    oidc_subject TEXT,
    enabled BOOLEAN NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(oidc_provider, oidc_subject)
);

CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE tenant_groups (
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (tenant_id, group_id)
);

CREATE TABLE permissions (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    effect TEXT NOT NULL CHECK (effect IN ('grant', 'deny')),
    resource TEXT NOT NULL
);

CREATE TABLE tenant_plugin_overrides (
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    plugin_namespace TEXT NOT NULL,
    plugin_name TEXT NOT NULL,
    enabled BOOLEAN,
    PRIMARY KEY (tenant_id, plugin_namespace, plugin_name),
    FOREIGN KEY (plugin_namespace, plugin_name) REFERENCES plugins(namespace, name) ON DELETE CASCADE
);

CREATE TABLE tenant_plugin_configuration (
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    plugin_namespace TEXT NOT NULL,
    plugin_name TEXT NOT NULL,
    input_name TEXT NOT NULL,
    input_value TEXT NOT NULL,
    PRIMARY KEY (tenant_id, plugin_namespace, plugin_name, input_name),
    FOREIGN KEY (plugin_namespace, plugin_name) REFERENCES plugins(namespace, name) ON DELETE CASCADE
);

CREATE TABLE tenant_ip_mappings (
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    ip_address TEXT NOT NULL,
    PRIMARY KEY (tenant_id, ip_address)
);
CREATE INDEX idx_tenant_ip ON tenant_ip_mappings(ip_address);
