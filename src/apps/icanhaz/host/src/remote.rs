//! Other brokers, over iroh. A **locator** names one:
//! `iroh:<identity>?addr=<ip:port>&addr=…`, the identity being the Ed25519
//! key that signs its certificates and authenticates its QUIC handshake.
//! [`Remotes`] keeps one connection per locator and is the daemon's
//! [`RemoteBroker`]: redeeming a certificate there as this daemon, then
//! describing the grant so the local store can hold a proxy for it.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Context as _;
use futures::future::BoxFuture;
use futures::FutureExt as _;
use tokio::sync::Mutex;
use wrpc_transport_iroh::Client;

use crate::broker::{self, scope_from_wire, RemoteBroker, RemoteDetail};
use crate::iroh::IROH_ALPN;
use icanhaz_broker::broker::bindings::icanhaz::nocap::types::Denied;

/// The locator of `endpoint`, with its direct addresses.
pub fn locator_of(endpoint: &iroh::Endpoint, identity: &ezcap::PublicKey) -> String {
    let addrs: Vec<String> = endpoint
        .addr()
        .ip_addrs()
        .map(|a| format!("addr={a}"))
        .collect();
    if addrs.is_empty() {
        format!("iroh:{identity}")
    } else {
        format!("iroh:{identity}?{}", addrs.join("&"))
    }
}

/// Parse a locator into an iroh address.
pub fn parse_locator(locator: &str) -> anyhow::Result<iroh::EndpointAddr> {
    let rest = locator
        .strip_prefix("iroh:")
        .with_context(|| format!("locator `{locator}` is not `iroh:…`"))?;
    let (id, query) = rest.split_once('?').unwrap_or((rest, ""));
    let key: ezcap::PublicKey = id
        .parse()
        .with_context(|| format!("locator `{locator}`: bad identity"))?;
    let endpoint_id = iroh::EndpointId::from_bytes(key.as_bytes())
        .with_context(|| format!("locator `{locator}`: identity is not a valid key"))?;
    let addrs = query
        .split('&')
        .filter_map(|kv| kv.strip_prefix("addr="))
        .filter_map(|a| a.parse::<std::net::SocketAddr>().ok())
        .map(iroh::TransportAddr::Ip);
    Ok(iroh::EndpointAddr::from_parts(endpoint_id, addrs))
}

/// Connections to other brokers, one per locator, made as this daemon.
/// Cheap to clone; every clone shares the connections.
#[derive(Clone)]
pub struct Remotes {
    inner: Arc<Inner>,
}

struct Inner {
    endpoint: iroh::Endpoint,
    conns: Mutex<HashMap<String, Client>>,
}

impl Remotes {
    pub fn new(endpoint: iroh::Endpoint) -> Self {
        Self {
            inner: Arc::new(Inner {
                endpoint,
                conns: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// A client for `locator`, connecting on first use (and again after the
    /// connection closed).
    pub async fn client(&self, locator: &str) -> anyhow::Result<Client> {
        let mut conns = self.inner.conns.lock().await;
        if let Some(c) = conns.get(locator) {
            if c.connection().close_reason().is_none() {
                return Ok(c.clone());
            }
            conns.remove(locator);
        }
        let addr = parse_locator(locator)?;
        let conn = self
            .inner
            .endpoint
            .connect(addr, IROH_ALPN)
            .await
            .with_context(|| format!("connecting to {locator}"))?;
        let client = Client::from(conn);
        conns.insert(locator.to_string(), client.clone());
        Ok(client)
    }
}

impl RemoteBroker for Remotes {
    fn redeem_at(
        &self,
        locator: String,
        cert: String,
    ) -> BoxFuture<'static, anyhow::Result<Result<(String, RemoteDetail), Denied>>> {
        let remotes = self.clone();
        async move {
            let client = remotes.client(&locator).await?;
            let token = match broker::client::redeem(&client, (), &cert).await? {
                Ok(grant) => grant.token,
                Err(denied) => return Ok(Err(denied)),
            };
            let detail = match broker::client::inspect(&client, (), &token).await? {
                Ok(d) => d,
                Err(denied) => return Ok(Err(denied)),
            };
            Ok(Ok((
                token,
                RemoteDetail {
                    kind: detail.kind,
                    scope: scope_from_wire(&detail.scope),
                    expires_in: std::time::Duration::from_secs(detail.expires_in_secs),
                    summary: detail.summary,
                },
            )))
        }
        .boxed()
    }
}
