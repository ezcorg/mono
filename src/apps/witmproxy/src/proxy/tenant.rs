/// Context identifying the tenant for a given connection/request.
#[derive(Debug, Clone)]
pub struct TenantContext {
    pub tenant_id: Option<String>,
    /// The address the connection came from, for policy rules that name a
    /// source by address rather than by tenant.
    pub peer: Option<std::net::IpAddr>,
}

impl TenantContext {
    /// Create an anonymous tenant context (no tenant identified).
    /// Used for backward compatibility and unauthenticated connections.
    pub fn anonymous() -> Self {
        Self {
            tenant_id: None,
            peer: None,
        }
    }

    /// Create a tenant context for a specific tenant.
    pub fn new(tenant_id: String) -> Self {
        Self {
            tenant_id: Some(tenant_id),
            peer: None,
        }
    }

    /// This context with the connection's peer address recorded.
    pub fn with_peer(mut self, peer: std::net::IpAddr) -> Self {
        self.peer = Some(peer);
        self
    }

    /// Returns true if this is an anonymous (unidentified) tenant.
    pub fn is_anonymous(&self) -> bool {
        self.tenant_id.is_none()
    }
}
