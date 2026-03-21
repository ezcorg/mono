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
use crate::tenant::TenantContext;

/// Pluggable trait for determining tenant identity from a TCP peer address.
/// No auth logic belongs here -- just identity resolution.
#[async_trait]
pub trait TenantResolver: Send + Sync {
    async fn resolve(&self, peer_addr: &SocketAddr) -> TenantContext;
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
    ttl: Duration,
}

impl IpMappingResolver {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            pool,
            cache: RwLock::new(HashMap::new()),
            ttl: Duration::from_secs(60),
        }
    }

    pub fn invalidate_cache(&self) {
        if let Ok(mut cache) = self.cache.try_write() {
            cache.clear();
        }
    }
}

#[async_trait]
impl TenantResolver for IpMappingResolver {
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
}
