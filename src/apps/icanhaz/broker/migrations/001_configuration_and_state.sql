-- Two generic tables serve every capability; none owns its own.
--
-- `configuration`: declared configuration (the icanhaz analogue of witmproxy's
-- plugin_configuration). `owner` names what the value configures, e.g.
-- `inference/anthropic` (capability id / instance name); `value` is a
-- `forms.actual-input` as JSON. Secrets are ordinary rows: the whole file is
-- encrypted (SQLCipher, key in the keychain), and the daemon's APIs never
-- echo a `secret`-typed value.
CREATE TABLE IF NOT EXISTS configuration (
    owner TEXT NOT NULL,
    name  TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (owner, name)
);

-- `state`: per-owner persistent key/value, the host-side equivalent of a
-- plugin's local-storage. A capability keeps whatever it needs here (the
-- inference capability keeps per-provider per-day token counts).
CREATE TABLE IF NOT EXISTS state (
    owner TEXT NOT NULL,
    key   TEXT NOT NULL,
    value BLOB NOT NULL,
    PRIMARY KEY (owner, key)
);
