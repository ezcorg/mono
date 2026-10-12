use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::Deserialize;
use sqlx::SqlitePool;
use tokio::sync::RwLock;
use tracing::{debug, warn};

use crate::db::tenants;
use crate::proxy::tenant::TenantContext;

/// Pluggable trait for determining tenant identity from a TCP peer address.
/// No auth logic belongs here -- just identity resolution.
#[async_trait]
pub trait TenantResolver: Send + Sync {
    async fn resolve(&self, peer_addr: &SocketAddr) -> TenantContext;

    /// Drop whatever this resolver remembers about `ip`, so the next
    /// connection from it is looked up afresh. Called when a mapping for the
    /// address is added or removed at the management API; a resolver that
    /// caches nothing has nothing to do.
    async fn forget_ip(&self, _ip: IpAddr) {}

    /// Drop whatever this resolver remembers about `tenant_id`, every
    /// address of it. Called when the tenant is deleted or disabled.
    async fn forget_tenant(&self, _tenant_id: &str) {}
}

// ---------------------------------------------------------------------------
// AnonymousResolver -- no tenant database to ask
// ---------------------------------------------------------------------------

/// Resolves every connection to anonymous. The resolver of a proxy with no
/// tenant database (tests, embedding), and what a [`crate::ProxyServer`]
/// starts with until given one.
pub struct AnonymousResolver;

#[async_trait]
impl TenantResolver for AnonymousResolver {
    async fn resolve(&self, _peer_addr: &SocketAddr) -> TenantContext {
        TenantContext::anonymous()
    }
}

// ---------------------------------------------------------------------------
// IpMappingResolver -- looks up tenant_ip_mappings table
// ---------------------------------------------------------------------------

struct CacheEntry {
    context: TenantContext,
    expires_at: Instant,
}

pub struct IpMappingResolver {
    pool: SqlitePool,
    cache: RwLock<HashMap<IpAddr, CacheEntry>>,
    /// How long a mapped address keeps its tenant before the table is read
    /// again. Short, so removing a mapping cuts a client off promptly.
    hit_ttl: Duration,
    /// How long an unmapped address stays anonymous. Shorter still, so a
    /// mapping added at the management API applies to the client's next
    /// connection rather than a minute later.
    miss_ttl: Duration,
}

impl IpMappingResolver {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            pool,
            cache: RwLock::new(HashMap::new()),
            hit_ttl: Duration::from_secs(5),
            miss_ttl: Duration::from_secs(1),
        }
    }
}

#[async_trait]
impl TenantResolver for IpMappingResolver {
    async fn forget_ip(&self, ip: IpAddr) {
        self.cache.write().await.remove(&ip);
    }

    async fn forget_tenant(&self, tenant_id: &str) {
        self.cache
            .write()
            .await
            .retain(|_, entry| entry.context.tenant_id.as_deref() != Some(tenant_id));
    }

    async fn resolve(&self, peer_addr: &SocketAddr) -> TenantContext {
        let ip = peer_addr.ip();

        // Check cache
        {
            let cache = self.cache.read().await;
            if let Some(entry) = cache.get(&ip)
                && entry.expires_at > Instant::now()
            {
                return entry.context.clone();
            }
        }

        // DB lookup
        let ip_str = ip.to_string();
        let ctx = match tenants::tenant_by_ip(&self.pool, &ip_str).await {
            Ok(Some(tenant)) if tenant.enabled => TenantContext::new(tenant.id),
            Ok(_) => TenantContext::anonymous(),
            Err(e) => {
                warn!("IP mapping lookup failed for {}: {}", ip, e);
                TenantContext::anonymous()
            }
        };

        // Update cache
        {
            let ttl = if ctx.is_anonymous() {
                self.miss_ttl
            } else {
                self.hit_ttl
            };
            let mut cache = self.cache.write().await;
            cache.insert(
                ip,
                CacheEntry {
                    context: ctx.clone(),
                    expires_at: Instant::now() + ttl,
                },
            );
        }

        ctx
    }
}

// ---------------------------------------------------------------------------
// TailscaleResolver -- calls Tailscale local API whois endpoint
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct TailscaleWhoisResponse {
    user_profile: Option<TailscaleUserProfile>,
    node: Option<TailscaleNode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct TailscaleUserProfile {
    login_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct TailscaleNode {
    computed_name: Option<String>,
}

pub struct TailscaleResolver {
    pool: SqlitePool,
    cache: RwLock<HashMap<IpAddr, CacheEntry>>,
    ttl: Duration,
    http_client: reqwest::Client,
}

impl TailscaleResolver {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            pool,
            cache: RwLock::new(HashMap::new()),
            ttl: Duration::from_secs(300),
            http_client: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl TenantResolver for TailscaleResolver {
    async fn forget_ip(&self, ip: IpAddr) {
        self.cache.write().await.remove(&ip);
    }

    async fn forget_tenant(&self, tenant_id: &str) {
        self.cache
            .write()
            .await
            .retain(|_, entry| entry.context.tenant_id.as_deref() != Some(tenant_id));
    }

    async fn resolve(&self, peer_addr: &SocketAddr) -> TenantContext {
        let ip = peer_addr.ip();

        // Check cache
        {
            let cache = self.cache.read().await;
            if let Some(entry) = cache.get(&ip)
                && entry.expires_at > Instant::now()
            {
                return entry.context.clone();
            }
        }

        // Call Tailscale whois API
        let url = format!("http://127.0.0.1/localapi/v0/whois?addr={}", peer_addr);
        let ctx = match self.http_client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<TailscaleWhoisResponse>().await {
                    Ok(whois) => {
                        let login = whois
                            .user_profile
                            .as_ref()
                            .map(|u| u.login_name.clone())
                            .unwrap_or_default();
                        let node_name = whois
                            .node
                            .as_ref()
                            .and_then(|n| n.computed_name.clone())
                            .unwrap_or_default();

                        let tenant_id = if !login.is_empty() {
                            format!("ts:{}:{}", login, node_name)
                        } else {
                            String::new()
                        };

                        if tenant_id.is_empty() {
                            debug!("Tailscale whois returned no identity for {}", peer_addr);
                            TenantContext::anonymous()
                        } else {
                            // Auto-create tenant and IP mapping if not exists
                            let ip_str = ip.to_string();
                            if let Ok(None) = tenants::tenant_by_ip(&self.pool, &ip_str).await {
                                let display = format!("{} ({})", node_name, login);
                                match tenants::Tenant::create(
                                    &self.pool, &tenant_id, &display, None, None, None, None,
                                )
                                .await
                                {
                                    Ok(_) => {
                                        let _ = tenants::add_ip_mapping(
                                            &self.pool, &tenant_id, &ip_str,
                                        )
                                        .await;
                                        debug!("Auto-created tenant {} for {}", tenant_id, ip);
                                    }
                                    Err(e) => {
                                        // Might already exist from a different IP
                                        debug!(
                                            "Tenant creation skipped (may already exist): {}",
                                            e
                                        );
                                        let _ = tenants::add_ip_mapping(
                                            &self.pool, &tenant_id, &ip_str,
                                        )
                                        .await;
                                    }
                                }
                            }
                            TenantContext::new(tenant_id)
                        }
                    }
                    Err(e) => {
                        warn!("Failed to parse Tailscale whois response: {}", e);
                        TenantContext::anonymous()
                    }
                }
            }
            Ok(resp) => {
                debug!(
                    "Tailscale whois returned non-success status {} for {}",
                    resp.status(),
                    peer_addr
                );
                TenantContext::anonymous()
            }
            Err(e) => {
                debug!("Tailscale whois API unreachable for {}: {}", peer_addr, e);
                TenantContext::anonymous()
            }
        };

        // Update cache
        {
            let mut cache = self.cache.write().await;
            cache.insert(
                ip,
                CacheEntry {
                    context: ctx.clone(),
                    expires_at: Instant::now() + self.ttl,
                },
            );
        }

        ctx
    }
}

// ---------------------------------------------------------------------------
// HeaderResolver -- reads a trusted header for reverse proxy deployments
// ---------------------------------------------------------------------------

pub struct HeaderResolver {
    header_name: String,
}

impl HeaderResolver {
    pub fn new(header_name: String) -> Self {
        Self { header_name }
    }

    /// Resolve tenant from an HTTP header value (called by the proxy after parsing request).
    pub fn resolve_from_header(&self, headers: &hyper::HeaderMap) -> TenantContext {
        match headers.get(&self.header_name) {
            Some(value) => match value.to_str() {
                Ok(tenant_id) if !tenant_id.is_empty() => TenantContext::new(tenant_id.to_string()),
                _ => TenantContext::anonymous(),
            },
            None => TenantContext::anonymous(),
        }
    }
}

#[async_trait]
impl TenantResolver for HeaderResolver {
    async fn resolve(&self, _peer_addr: &SocketAddr) -> TenantContext {
        // Header-based resolution happens at the HTTP layer, not the connection layer.
        // This returns anonymous; the actual resolution is done via resolve_from_header().
        TenantContext::anonymous()
    }
}

// ---------------------------------------------------------------------------
// Config & factory
// ---------------------------------------------------------------------------

/// Which tenant resolver to use.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, clap::ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum TenantResolverKind {
    /// Look up tenant_ip_mappings table (works with any VPN or manual config).
    #[default]
    IpMapping,
    /// Call Tailscale local API for identity. Auto-creates tenants.
    Tailscale,
    /// Read a trusted HTTP header (for reverse proxy deployments).
    Header,
}

impl std::fmt::Display for TenantResolverKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TenantResolverKind::IpMapping => write!(f, "ip-mapping"),
            TenantResolverKind::Tailscale => write!(f, "tailscale"),
            TenantResolverKind::Header => write!(f, "header"),
        }
    }
}

impl std::str::FromStr for TenantResolverKind {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "ip-mapping" => Ok(TenantResolverKind::IpMapping),
            "tailscale" => Ok(TenantResolverKind::Tailscale),
            "header" => Ok(TenantResolverKind::Header),
            other => Err(format!(
                "unknown tenant resolver '{other}' (expected ip-mapping, tailscale, or header)"
            )),
        }
    }
}

/// Build a boxed TenantResolver from config.
pub fn build_resolver(
    kind: &TenantResolverKind,
    pool: SqlitePool,
    header_name: Option<String>,
) -> Arc<dyn TenantResolver> {
    match kind {
        TenantResolverKind::IpMapping => Arc::new(IpMappingResolver::new(pool)),
        TenantResolverKind::Tailscale => Arc::new(TailscaleResolver::new(pool)),
        TenantResolverKind::Header => {
            let header = header_name.unwrap_or_else(|| "X-Tenant-Id".to_string());
            Arc::new(HeaderResolver::new(header))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, SocketAddrV4};

    #[tokio::test]
    async fn test_ip_mapping_resolver_unmapped_returns_anonymous() {
        let (db, _tmp) = crate::test_utils::create_db().await;
        let resolver = IpMappingResolver::new(db.pool);
        let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(10, 0, 0, 1), 12345));
        let ctx = resolver.resolve(&addr).await;
        assert!(ctx.is_anonymous());
    }

    #[tokio::test]
    async fn test_ip_mapping_resolver_mapped_returns_tenant() {
        let (db, _tmp) = crate::test_utils::create_db().await;
        // Create tenant and mapping
        tenants::Tenant::create(&db.pool, "t1", "Test User", None, None, None, None)
            .await
            .unwrap();
        tenants::add_ip_mapping(&db.pool, "t1", "10.0.0.1")
            .await
            .unwrap();

        let resolver = IpMappingResolver::new(db.pool);
        let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(10, 0, 0, 1), 12345));
        let ctx = resolver.resolve(&addr).await;
        assert_eq!(ctx.tenant_id.as_deref(), Some("t1"));
    }

    #[tokio::test]
    async fn test_ip_mapping_resolver_multiple_ips_same_tenant() {
        let (db, _tmp) = crate::test_utils::create_db().await;
        tenants::Tenant::create(&db.pool, "t1", "Test User", None, None, None, None)
            .await
            .unwrap();
        tenants::add_ip_mapping(&db.pool, "t1", "10.0.0.1")
            .await
            .unwrap();
        tenants::add_ip_mapping(&db.pool, "t1", "10.0.0.2")
            .await
            .unwrap();

        let resolver = IpMappingResolver::new(db.pool);

        let addr1 = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(10, 0, 0, 1), 1));
        let addr2 = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(10, 0, 0, 2), 1));
        assert_eq!(
            resolver.resolve(&addr1).await.tenant_id.as_deref(),
            Some("t1")
        );
        assert_eq!(
            resolver.resolve(&addr2).await.tenant_id.as_deref(),
            Some("t1")
        );
    }

    #[test]
    fn test_header_resolver_present() {
        let resolver = HeaderResolver::new("X-Tenant-Id".to_string());
        let mut headers = hyper::HeaderMap::new();
        headers.insert("X-Tenant-Id", "tenant-abc".parse().unwrap());
        let ctx = resolver.resolve_from_header(&headers);
        assert_eq!(ctx.tenant_id.as_deref(), Some("tenant-abc"));
    }

    #[test]
    fn test_header_resolver_missing() {
        let resolver = HeaderResolver::new("X-Tenant-Id".to_string());
        let headers = hyper::HeaderMap::new();
        let ctx = resolver.resolve_from_header(&headers);
        assert!(ctx.is_anonymous());
    }

    /// A mapping removed at the management API must not keep answering from
    /// the cache: the next guest to get that address would be dispatched as
    /// the tenant that used to have it.
    #[tokio::test]
    async fn forgetting_an_ip_drops_its_cached_tenant() {
        let (db, _tmp) = crate::test_utils::create_db().await;
        tenants::Tenant::create(&db.pool, "t1", "Test User", None, None, None, None)
            .await
            .unwrap();
        tenants::add_ip_mapping(&db.pool, "t1", "10.0.0.1")
            .await
            .unwrap();
        let resolver = IpMappingResolver::new(db.pool.clone());
        let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(10, 0, 0, 1), 1));
        assert_eq!(
            resolver.resolve(&addr).await.tenant_id.as_deref(),
            Some("t1")
        );

        tenants::remove_ip_mapping(&db.pool, "t1", "10.0.0.1")
            .await
            .unwrap();
        // Still cached: the hit TTL has not passed.
        assert_eq!(
            resolver.resolve(&addr).await.tenant_id.as_deref(),
            Some("t1")
        );
        resolver.forget_ip(addr.ip()).await;
        assert!(resolver.resolve(&addr).await.is_anonymous());
    }

    #[tokio::test]
    async fn forgetting_a_tenant_drops_every_address_of_it_and_no_other() {
        let (db, _tmp) = crate::test_utils::create_db().await;
        for (tenant, ip) in [("t1", "10.0.0.1"), ("t1", "10.0.0.2"), ("t2", "10.0.0.3")] {
            if tenants::Tenant::by_id(&db.pool, tenant)
                .await
                .unwrap()
                .is_none()
            {
                tenants::Tenant::create(&db.pool, tenant, tenant, None, None, None, None)
                    .await
                    .unwrap();
            }
            tenants::add_ip_mapping(&db.pool, tenant, ip).await.unwrap();
        }
        let resolver = IpMappingResolver::new(db.pool.clone());
        let a1 = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(10, 0, 0, 1), 1));
        let a2 = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(10, 0, 0, 2), 1));
        let a3 = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(10, 0, 0, 3), 1));
        for a in [&a1, &a2, &a3] {
            resolver.resolve(a).await;
        }
        tenants::Tenant::delete(&db.pool, "t1").await.unwrap();
        resolver.forget_tenant("t1").await;
        assert!(resolver.resolve(&a1).await.is_anonymous());
        assert!(resolver.resolve(&a2).await.is_anonymous());
        assert_eq!(resolver.resolve(&a3).await.tenant_id.as_deref(), Some("t2"));
    }
}
