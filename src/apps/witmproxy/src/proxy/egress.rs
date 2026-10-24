//! Where the proxy may connect on a client's behalf: the policy stack,
//! applied at the dial.
//!
//! A forward proxy reaches whatever its host reaches. When the clients in
//! front of it may reach less than that (an isolated VM whose only way out is
//! this proxy, a device on a tailnet), the proxy is the hole in their
//! isolation unless it declines, itself, to go where they may not: a CONNECT
//! to the gateway, a request for a LAN address, a name that resolves to one.
//!
//! The decision is made on the address actually dialed, after resolution, so
//! a name pointed at a private address (by its owner, or by rebinding between
//! two lookups) is refused at the moment it would matter. Every path out of
//! the proxy asks here before it dials: the CONNECT tunnel, each intercepted
//! request's upstream connection (through the upstream client's resolver),
//! and the transparent proxy's passthrough. What the rules are is
//! [`crate::policy`]'s business; this module is where they meet a socket.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, RwLock};

use anyhow::{Context, Result};
use tokio::net::TcpStream;
use tracing::info;

use crate::cert::CertificateAuthority;
use crate::config::ProxyConfig;
use crate::policy::{self, Decision, Dial, Origin, Policy};
use crate::proxy::tenant::TenantContext;
use crate::proxy::utils::{ProxyError, ProxyResult};

/// Who is asking: the two things the rules can say about a source.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Client {
    pub tenant: Option<String>,
    pub ip: Option<IpAddr>,
}

impl From<&TenantContext> for Client {
    fn from(ctx: &TenantContext) -> Self {
        Client {
            tenant: ctx.tenant_id.clone(),
            ip: ctx.peer,
        }
    }
}

/// Why a destination was refused. Its text is for the client's error and the
/// log; it names the host, the address and the rule, nothing the client did
/// not already know or the policy's author did not mean to be read.
#[derive(Debug, thiserror::Error)]
pub enum EgressError {
    #[error("{host}{} on port {port} is not permitted for this client: {decision}", match .addr { Some(a) => format!(" ({a})"), None => String::new() })]
    Denied {
        host: String,
        addr: Option<IpAddr>,
        port: u16,
        decision: Decision,
    },
    #[error(
        "{host} resolves only to addresses this proxy may not connect to for this client: {decision}"
    )]
    AllDenied {
        host: String,
        port: u16,
        decision: Decision,
    },
    #[error("{host} could not be resolved: {source}")]
    Resolve {
        host: String,
        #[source]
        source: std::io::Error,
    },
}

/// The instance's policy and every tenant's, judged together for each dial.
pub struct Egress {
    floor: Arc<Policy>,
    tenants: RwLock<HashMap<String, Arc<Policy>>>,
}

impl Default for Egress {
    fn default() -> Self {
        Egress::permissive()
    }
}

impl Egress {
    /// An instance with no policy: every dial permitted, which is what a
    /// witmproxy fronting only its own host's traffic wants.
    pub fn permissive() -> Egress {
        Egress::new(Policy::empty(Origin::Instance))
    }

    pub fn new(floor: Policy) -> Egress {
        Egress {
            floor: Arc::new(floor),
            tenants: RwLock::new(HashMap::new()),
        }
    }

    /// The instance's floor from its configuration: the policy file
    /// (`--policy-file`, or `policy.toml` in the instance's root when one is
    /// there, which [`ProxyConfig::resolve_paths`] fills in) merged with the
    /// `--upstream-deny` shorthand. The floor's own checks are run here; a
    /// policy that fails them refuses to start the daemon.
    pub fn from_config(config: &ProxyConfig) -> Result<Egress> {
        let mut floor = Policy::empty(Origin::Instance);
        if let Some(path) = &config.policy_file {
            let text = std::fs::read_to_string(path)
                .with_context(|| format!("reading policy file {}", path.display()))?;
            let file = Policy::from_toml(&text, Origin::Instance)
                .with_context(|| format!("policy file {}", path.display()))?;
            floor = floor.merged_with(file);
        }
        if let Some(spec) = config.upstream_deny.as_deref() {
            let deny = Policy::upstream_deny(spec).context("--upstream-deny")?;
            floor = floor.merged_with(deny);
        }
        floor.validate(None).context("policy")?;
        if !floor.is_empty() {
            info!(
                "Egress policy: {} rule(s), default {}",
                floor.rules().len(),
                floor
                    .default_effect()
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "permit".into())
            );
        }
        Ok(Egress::new(floor))
    }

    pub fn floor(&self) -> &Policy {
        &self.floor
    }

    /// Whether no policy at all is in force: nothing at the instance, no
    /// tenant with one. The proxy then skips the resolution it would do
    /// before answering a CONNECT, which is today's behaviour exactly.
    pub fn is_permissive(&self) -> bool {
        self.floor.is_empty() && self.lock_tenants().is_empty()
    }

    fn lock_tenants(&self) -> std::sync::RwLockReadGuard<'_, HashMap<String, Arc<Policy>>> {
        self.tenants.read().unwrap_or_else(|e| e.into_inner())
    }

    /// Install a tenant's policy, already validated against the floor.
    pub fn set_tenant(&self, tenant_id: &str, policy: Policy) {
        self.tenants
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(tenant_id.to_string(), Arc::new(policy));
    }

    pub fn remove_tenant(&self, tenant_id: &str) {
        self.tenants
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(tenant_id);
    }

    pub fn tenant(&self, tenant_id: &str) -> Option<Arc<Policy>> {
        self.lock_tenants().get(tenant_id).cloned()
    }

    /// Judge one dial: the floor and, for a known tenant, its own policy.
    pub fn decide(
        &self,
        client: &Client,
        name: Option<&str>,
        addr: Option<IpAddr>,
        port: u16,
    ) -> Decision {
        let tenant_policy = client.tenant.as_deref().and_then(|t| self.tenant(t));
        let mut stack: Vec<&Policy> = vec![&self.floor];
        if let Some(p) = &tenant_policy {
            stack.push(p);
        }
        let normalized = name.map(policy::normalize_name);
        let dial = Dial {
            tenant: client.tenant.as_deref(),
            src_ip: client.ip,
            name: normalized.as_deref(),
            addr,
            port,
        };
        let decision = policy::decide(&stack, &dial);
        if !decision.is_permit() {
            info!(
                tenant = ?client.tenant,
                client = ?client.ip,
                name = ?name,
                addr = ?addr,
                port,
                "policy: {decision}"
            );
        }
        decision
    }

    /// Refuses a host that is itself a forbidden address literal. A name is
    /// not judged here; it is judged by what it resolves to, in
    /// [`Egress::resolve`] or the upstream client's resolver.
    pub fn check_literal(&self, client: &Client, host: &str, port: u16) -> Result<(), EgressError> {
        if let Some(ip) = policy::parse_literal(host) {
            let decision = self.decide(client, None, Some(ip), port);
            if !decision.is_permit() {
                return Err(EgressError::Denied {
                    host: host.to_string(),
                    addr: Some(ip),
                    port,
                    decision,
                });
            }
        }
        Ok(())
    }

    /// Resolves `host:port` to the addresses this proxy may dial for
    /// `client`, in resolver order. Forbidden addresses are dropped; none
    /// left is an error that names the rule.
    pub async fn resolve(
        &self,
        client: &Client,
        host: &str,
        port: u16,
    ) -> Result<Vec<SocketAddr>, EgressError> {
        self.check_literal(client, host, port)?;
        let literal = policy::parse_literal(host);
        let name = if literal.is_none() { Some(host) } else { None };
        let addrs = tokio::net::lookup_host((host, port))
            .await
            .map_err(|source| EgressError::Resolve {
                host: host.to_string(),
                source,
            })?;
        let mut allowed = Vec::new();
        let mut first_denial = None;
        for addr in addrs {
            let decision = self.decide(client, name, Some(addr.ip()), port);
            if decision.is_permit() {
                allowed.push(addr);
            } else if first_denial.is_none() {
                first_denial = Some(decision);
            }
        }
        if allowed.is_empty() {
            let decision = first_denial.unwrap_or_else(|| self.decide(client, name, None, port));
            return Err(EgressError::AllDenied {
                host: host.to_string(),
                port,
                decision,
            });
        }
        Ok(allowed)
    }

    /// Connects to `host:port` for `client` by an address this proxy may
    /// dial: the first that answers.
    pub async fn connect(
        &self,
        client: &Client,
        host: &str,
        port: u16,
    ) -> std::io::Result<TcpStream> {
        let addrs = self
            .resolve(client, host, port)
            .await
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::PermissionDenied, e))?;
        connect_any(&addrs).await
    }
}

/// Dial the first of `addrs` that answers.
pub async fn connect_any(addrs: &[SocketAddr]) -> std::io::Result<TcpStream> {
    let mut last = None;
    for addr in addrs {
        match TcpStream::connect(addr).await {
            Ok(stream) => return Ok(stream),
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("no address to connect to")))
}

/// The upstream client's resolver: the system's, with the addresses the
/// policy forbids for this client and port taken out of every answer. A name
/// that resolves only to forbidden addresses fails to resolve, which reqwest
/// reports as a connection error.
pub struct FilteringResolver {
    egress: Arc<Egress>,
    client: Client,
    port: u16,
}

impl reqwest::dns::Resolve for FilteringResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let egress = Arc::clone(&self.egress);
        let client = self.client.clone();
        let port = self.port;
        Box::pin(async move {
            let host = name.as_str().to_string();
            match egress.resolve(&client, &host, port).await {
                Ok(addrs) => {
                    let iter: reqwest::dns::Addrs = Box::new(addrs.into_iter());
                    Ok(iter)
                }
                Err(e) => Err(Box::new(e) as Box<dyn std::error::Error + Send + Sync>),
            }
        })
    }
}

/// The proxy's upstream HTTP clients. A reqwest client's resolver sees names
/// and nothing else, so a client that applies the policy for one source on
/// one port is built for each (tenant, client address, port) that appears,
/// and kept: the connection pool behind it is then also that source's own,
/// never shared with another tenant's requests.
pub struct UpstreamClients {
    ca: CertificateAuthority,
    egress: Arc<Egress>,
    clients: Mutex<HashMap<(Client, u16), reqwest::Client>>,
}

impl UpstreamClients {
    /// How many (source, port) clients to keep before starting over. Each
    /// holds a connection pool; a proxy fronting a few tenants on a few
    /// ports never gets near this.
    const MAX: usize = 256;

    pub fn new(ca: CertificateAuthority, egress: Arc<Egress>) -> Self {
        UpstreamClients {
            ca,
            egress,
            clients: Mutex::new(HashMap::new()),
        }
    }

    pub fn egress(&self) -> &Arc<Egress> {
        &self.egress
    }

    /// The client for requests `tenant` makes to `port`.
    pub fn client_for(&self, tenant: &TenantContext, port: u16) -> ProxyResult<reqwest::Client> {
        let key = (Client::from(tenant), port);
        let mut clients = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(c) = clients.get(&key) {
            return Ok(c.clone());
        }
        let resolver = FilteringResolver {
            egress: Arc::clone(&self.egress),
            client: key.0.clone(),
            port,
        };
        let client =
            crate::proxy::utils::build_upstream_client(&self.ca, Some(Arc::new(resolver)))?;
        if clients.len() >= Self::MAX {
            clients.clear();
        }
        clients.insert(key, client.clone());
        Ok(client)
    }
}

impl From<EgressError> for ProxyError {
    fn from(e: EgressError) -> Self {
        ProxyError::Io(std::io::Error::new(std::io::ErrorKind::PermissionDenied, e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn floor() -> Egress {
        Egress::new(
            Policy::from_toml(
                r#"
[sets]
private = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16",
           "100.64.0.0/10", "127.0.0.0/8", "[::1]/128", "[fc00::]/7"]
[[rules]]
effect = "forbid"
dst = ["@private:*"]
comment = "this host's networks"
"#,
                Origin::Instance,
            )
            .unwrap(),
        )
    }

    fn anon() -> Client {
        Client::default()
    }

    #[test]
    fn denies_what_the_floor_lists_and_nothing_else() {
        let e = floor();
        for denied in [
            "10.187.156.1",
            "172.17.0.1",
            "192.168.18.34",
            "169.254.169.254",
            "100.74.124.13",
            "127.0.0.1",
            "::1",
            "fd7a:115c:a1e0::1",
            "::ffff:10.0.0.1",
        ] {
            let ip: IpAddr = denied.parse().unwrap();
            assert!(
                !e.decide(&anon(), None, Some(ip), 443).is_permit(),
                "{denied}"
            );
        }
        for allowed in [
            "1.1.1.1",
            "93.184.216.34",
            "172.32.0.1",
            "100.128.0.1",
            "2606:4700::1111",
            "::ffff:1.1.1.1",
        ] {
            let ip: IpAddr = allowed.parse().unwrap();
            assert!(
                e.decide(&anon(), None, Some(ip), 443).is_permit(),
                "{allowed}"
            );
        }
    }

    #[test]
    fn literals_are_judged_before_any_lookup() {
        let e = floor();
        assert!(matches!(
            e.check_literal(&anon(), "10.0.0.1", 443),
            Err(EgressError::Denied { .. })
        ));
        assert!(matches!(
            e.check_literal(&anon(), "[::1]", 443),
            Err(EgressError::Denied { .. })
        ));
        assert!(e.check_literal(&anon(), "1.1.1.1", 443).is_ok());
        assert!(
            e.check_literal(&anon(), "example.com", 443).is_ok(),
            "a name is judged by what it resolves to"
        );
    }

    #[tokio::test]
    async fn resolution_drops_forbidden_addresses() {
        let e = floor();
        // "localhost" resolves to loopback, all of which the floor forbids.
        match e.resolve(&anon(), "localhost", 80).await {
            Err(EgressError::AllDenied { host, decision, .. }) => {
                assert_eq!(host, "localhost");
                assert!(
                    decision.to_string().contains("this host's networks"),
                    "{decision}"
                );
            }
            other => panic!("expected every address refused, got {other:?}"),
        }
        assert!(matches!(
            e.connect(&anon(), "127.0.0.1", 1).await,
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied
        ));
        // A permissive instance refuses nothing.
        let none = Egress::permissive();
        assert!(none.is_permissive());
        let addrs = none.resolve(&anon(), "localhost", 80).await.unwrap();
        assert!(addrs.iter().all(|a| a.ip().is_loopback()));
    }

    #[tokio::test]
    async fn a_tenant_policy_applies_to_that_tenant_only() {
        let e = floor();
        let doc: policy::PolicyDoc = serde_json::from_str(
            r#"{"default": "forbid", "rules": [{"effect": "permit", "dst": ["localhost:80"]}]}"#,
        )
        .unwrap();
        let p = Policy::compile(&doc, Origin::Tenant("vm".into())).unwrap();
        p.validate(Some(e.floor())).unwrap();
        e.set_tenant("vm", p);
        assert!(!e.is_permissive());
        let vm = Client {
            tenant: Some("vm".into()),
            ip: None,
        };
        // Permitted by name for the tenant, but the floor still forbids the
        // loopback it resolves to.
        assert!(matches!(
            e.resolve(&vm, "localhost", 80).await,
            Err(EgressError::AllDenied { .. })
        ));
        // Anything else: the tenant's default.
        let d = e.decide(
            &vm,
            Some("example.com"),
            Some("93.184.216.34".parse().unwrap()),
            443,
        );
        assert_eq!((d.effect, d.rule), (policy::Effect::Forbid, None));
        // Someone else is judged by the floor alone.
        assert!(
            e.decide(
                &anon(),
                Some("example.com"),
                Some("93.184.216.34".parse().unwrap()),
                443
            )
            .is_permit()
        );
        e.remove_tenant("vm");
        assert!(
            e.decide(
                &vm,
                Some("example.com"),
                Some("93.184.216.34".parse().unwrap()),
                443
            )
            .is_permit()
        );
    }

    #[test]
    fn errors_name_the_host_the_address_and_the_rule() {
        let e = floor();
        let err = e
            .check_literal(&anon(), "192.168.1.1", 22)
            .unwrap_err()
            .to_string();
        assert_eq!(
            err,
            "192.168.1.1 (192.168.1.1) on port 22 is not permitted for this client: \
             forbid by instance rule `forbid * -> @private:* (this host's networks)`"
        );
    }
}
