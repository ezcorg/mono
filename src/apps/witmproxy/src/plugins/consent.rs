//! Install-time consent through icanhaz.
//!
//! A plugin's manifest says what it *wants* (its capabilities and the scopes
//! it proposes); whether it *gets* them is a human's decision. With an
//! icanhaz broker configured (`--plugins-icanhaz ws://127.0.0.1:7777`, the
//! tray app), every wanted capability is put to the human there, where every
//! other grant on the machine is decided: the kind by path, the scope as
//! sentences, the reason from the manifest. The human may append clauses.
//! icanhaz issues nothing; the approved scope comes back and witmproxy
//! enforces it in its own grant store, type-checking it against the
//! capability's interface as it does any scope.
//!
//! Without a broker configured, every wanted capability is granted as
//! proposed: a single-user proxy that trusts what it installs.

use anyhow::{Context as _, Result};
use icanhaz_broker::broker::bindings::ezco::ezcap::types::{Capability, Scope};
use icanhaz_broker::broker::client;
use icanhaz_broker::broker::denied_text;
use tracing::info;

use crate::plugins::capabilities::Capability as PluginCapability;
use crate::wasm::bindgen::witmproxy::plugin::capabilities::CapabilityKind;

/// How witmproxy reaches the broker.
pub enum IcanhazConsent {
    /// The tray app (or a headless daemon) over WebSocket.
    Ws(wrpc_websockets::Client<'static>),
    /// A loopback broker over TCP (tests).
    Tcp(wrpc_transport::tcp::Client<std::net::SocketAddr>),
}

impl IcanhazConsent {
    /// `ws://host:port`, the daemon's WebSocket endpoint.
    pub fn connect(url: &str) -> Result<Self> {
        let builder = tokio_websockets::ClientBuilder::new()
            .uri(url)
            .with_context(|| format!("icanhaz url `{url}`"))?;
        Ok(IcanhazConsent::Ws(wrpc_websockets::Client::from_builder(
            builder,
        )))
    }

    pub fn tcp(addr: std::net::SocketAddr) -> Self {
        IcanhazConsent::Tcp(wrpc_transport::tcp::Client::from(addr))
    }

    async fn ask(
        &self,
        capability: &Capability,
        summary: &str,
        reason: &str,
        requester: &str,
    ) -> Result<Result<client::Approval, client::Denied>> {
        match self {
            IcanhazConsent::Ws(c) => {
                client::consent(c, (), capability, summary, reason, requester).await
            }
            IcanhazConsent::Tcp(c) => {
                client::consent(c, (), capability, summary, reason, requester).await
            }
        }
    }

    /// Put every capability `plugin_id` wants to the human, one by one. An
    /// approval grants it with the (possibly narrowed) scope the human
    /// returned; a denial leaves it ungranted. A broker that cannot be
    /// reached is an error: nothing is granted by accident.
    pub async fn decide(
        &self,
        plugin_id: &str,
        reason: &str,
        capabilities: &mut [PluginCapability],
    ) -> Result<()> {
        for cap in capabilities.iter_mut() {
            let capability = Capability {
                kind: kind_path(&cap.inner.kind),
                scope: Scope {
                    when: cap.inner.scope.when.clone(),
                    allow: cap.inner.scope.allow.clone(),
                },
            };
            let summary = format!("{} for {plugin_id}", describe(&cap.inner.kind));
            match self
                .ask(&capability, &summary, reason, "witmproxy")
                .await
                .with_context(|| format!("asking icanhaz about {}", capability.kind))?
            {
                Ok(approval) => {
                    info!(plugin = plugin_id, kind = %capability.kind, "capability approved");
                    cap.granted = true;
                    cap.inner.scope.when = approval.scope.when;
                    cap.inner.scope.allow = approval.scope.allow;
                }
                Err(denied) => {
                    info!(plugin = plugin_id, kind = %capability.kind, why = %denied_text(&denied), "capability refused");
                    cap.granted = false;
                }
            }
        }
        Ok(())
    }
}

/// The WIT path of a plugin capability kind, as the broker names it.
pub fn kind_path(kind: &CapabilityKind) -> String {
    match kind {
        CapabilityKind::Logger => "witmproxy:plugin/capabilities.logger".to_string(),
        CapabilityKind::Annotator => "witmproxy:plugin/capabilities.annotator-client".to_string(),
        CapabilityKind::LocalStorage => {
            "witmproxy:plugin/capabilities.local-storage-client".to_string()
        }
        CapabilityKind::Clock => "witmproxy:plugin/capabilities.clock-client".to_string(),
        CapabilityKind::HandleEvent(event) => {
            format!("witmproxy:plugin/capabilities.handle-event.{event}")
        }
    }
}

fn describe(kind: &CapabilityKind) -> &'static str {
    match kind {
        CapabilityKind::Logger => "logging",
        CapabilityKind::Annotator => "content annotation",
        CapabilityKind::LocalStorage => "local storage",
        CapabilityKind::Clock => "the clock",
        CapabilityKind::HandleEvent(_) => "handling proxy events",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wasm::bindgen::ezco::ezcap::types::Scope as ScopeWire;
    use crate::wasm::bindgen::witmproxy::plugin::capabilities::{
        Capability as WitCapability, EventKind,
    };
    use icanhaz_broker::approve::{Approval, PendingConsent};
    use icanhaz_broker::broker::{BrokerProvider, Consent, GrantStore, Pairings, Want, serve_tcp};
    use tokio::net::TcpListener;

    fn cap(kind: CapabilityKind, allow: &str) -> PluginCapability {
        PluginCapability {
            inner: WitCapability {
                kind,
                scope: ScopeWire {
                    when: "true".to_string(),
                    allow: allow.to_string(),
                },
            },
            granted: false,
            when: None,
            token: None,
        }
    }

    async fn broker(consent: Consent) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let provider = BrokerProvider::new(GrantStore::shared(), consent, Pairings::shared());
        let task = tokio::spawn(async move {
            let _ = serve_tcp(listener, provider).await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        (addr, task)
    }

    #[tokio::test]
    async fn the_human_approves_narrows_or_refuses_each_wanted_capability() {
        let pending = PendingConsent::with_notifier(|_| {});
        let (addr, server) = broker(Consent::Surface(pending.clone())).await;
        // The human: approve storage with an extra clause, refuse the clock.
        let human = {
            let pending = pending.clone();
            tokio::spawn(async move {
                let mut seen = 0;
                while seen < 2 {
                    let Some(req) = pending.list().pop() else {
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                        continue;
                    };
                    seen += 1;
                    let Want::Foreign { kind, summary } = &req.want else {
                        panic!("expected a foreign want")
                    };
                    assert_eq!(req.requester, "witmproxy");
                    assert!(summary.ends_with("for @ezco/noshorts"), "{summary}");
                    let decision = if kind.ends_with("local-storage-client") {
                        Some(Approval {
                            grant: None,
                            narrowing: Some(ezcap::Narrowing::allow("size(call.args.key) < 64")),
                            remember: false,
                            ttl_secs: 60,
                        })
                    } else {
                        None
                    };
                    pending.resolve(&req.id, decision);
                }
            })
        };
        let consent = IcanhazConsent::tcp(addr);
        let mut caps = vec![
            cap(
                CapabilityKind::LocalStorage,
                r#"call.args.key.startsWith("seen/")"#,
            ),
            cap(CapabilityKind::Clock, "true"),
        ];
        consent
            .decide("@ezco/noshorts", "remember seen posts", &mut caps)
            .await
            .expect("broker reachable");
        human.await.expect("human task");
        assert!(caps[0].granted);
        assert_eq!(
            caps[0].inner.scope.allow,
            r#"(call.args.key.startsWith("seen/")) && (size(call.args.key) < 64)"#
        );
        assert!(!caps[1].granted);
        server.abort();
    }

    #[tokio::test]
    async fn an_auto_approving_broker_grants_as_proposed_and_an_unreachable_one_is_an_error() {
        let (addr, server) = broker(Consent::AutoApprove).await;
        let mut caps = vec![cap(CapabilityKind::HandleEvent(EventKind::Request), "true")];
        IcanhazConsent::tcp(addr)
            .decide("@ezco/noop", "see requests", &mut caps)
            .await
            .expect("reachable");
        assert!(caps[0].granted);
        server.abort();
        assert_eq!(
            kind_path(&caps[0].inner.kind),
            "witmproxy:plugin/capabilities.handle-event.request"
        );

        let dead: std::net::SocketAddr = "127.0.0.1:1".parse().expect("addr");
        let mut caps = vec![cap(CapabilityKind::Logger, "true")];
        assert!(
            IcanhazConsent::tcp(dead)
                .decide("@ezco/noop", "log", &mut caps)
                .await
                .is_err()
        );
        assert!(
            !caps[0].granted,
            "nothing granted when the broker is unreachable"
        );
    }
}
