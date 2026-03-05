/// Context identifying the tenant for a given connection/request.
#[derive(Debug, Clone)]
pub struct TenantContext {
    pub tenant_id: Option<String>,
}

impl TenantContext {
    /// Create an anonymous tenant context (no tenant identified).
    /// Used for backward compatibility and unauthenticated connections.
    pub fn anonymous() -> Self {
        Self { tenant_id: None }
    }

    /// Create a tenant context for a specific tenant.
    pub fn new(tenant_id: String) -> Self {
        Self {
            tenant_id: Some(tenant_id),
        }
    }

    /// Returns true if this is an anonymous (unidentified) tenant.
    pub fn is_anonymous(&self) -> bool {
        self.tenant_id.is_none()
    }
}
