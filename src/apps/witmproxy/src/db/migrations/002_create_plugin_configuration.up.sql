-- Create plugin_configuration table for storing user-supplied plugin config values
CREATE TABLE IF NOT EXISTS plugin_configuration (
    namespace TEXT NOT NULL,
    name TEXT NOT NULL,
    input_name TEXT NOT NULL,
    input_value TEXT NOT NULL,
    PRIMARY KEY (namespace, name, input_name),
    FOREIGN KEY (namespace, name) REFERENCES plugins(namespace, name) ON DELETE CASCADE
);
