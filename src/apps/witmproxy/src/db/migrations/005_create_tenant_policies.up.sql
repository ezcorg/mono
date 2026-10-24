-- A tenant's egress policy, as written at PUT /api/manage/tenants/{id}/policy:
-- the JSON document (`crate::policy::PolicyDoc`), compiled and validated
-- against the instance's floor when it is set and again when the daemon
-- starts. One per tenant; none means the tenant is judged by the floor alone.
CREATE TABLE tenant_policies (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    policy TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
