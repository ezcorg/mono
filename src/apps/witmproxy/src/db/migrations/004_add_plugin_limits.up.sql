-- Per-plugin resource limit overrides, stored as a JSON object of
-- `crate::plugins::limits::LimitOverrides`. An empty object means "inherit
-- every dimension from the global configuration".
--
-- Kept as a column on `plugins` rather than a side table so it travels with the
-- row and cannot be orphaned; note that `WitmPlugin::insert_tx` deliberately
-- preserves an existing value across a plugin upgrade, so an operator's
-- overrides survive `witm plugin add` of a new version.
ALTER TABLE plugins ADD COLUMN limits TEXT NOT NULL DEFAULT '{}';
