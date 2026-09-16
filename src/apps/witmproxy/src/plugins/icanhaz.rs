//! icanhaz, as witmproxy uses it: install-time consent and plugin
//! configuration, both decided and edited at the tray app.
//!
//! **Consent.**
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
//!
//! **Configuration.** A plugin's manifest declares its settings as an
//! `ezco:ezcap/forms` schema. With a broker configured, witmproxy declares
//! that schema at the daemon (`icanhaz:nocap/configuration`), the tray app
//! renders the form beside every other capability's, the values land in the
//! daemon's store, and witmproxy reads them back, polling the revision so an
//! edit reaches the plugin on its next event. Without a broker, the values
//! come from witmproxy's own database as before.

use anyhow::{Context as _, Result};
use icanhaz_broker::broker::bindings::ezco::ezcap::types::{Capability, Scope};
use icanhaz_broker::broker::client;
use icanhaz_broker::broker::denied_text;
use icanhaz_broker::configuration_serve::client as configuration;
use tracing::info;

use crate::plugins::capabilities::Capability as PluginCapability;
use crate::wasm::bindgen::witmproxy::plugin::capabilities::CapabilityKind;
use crate::wasm::bindgen::{ActualInput, InputSchema, InputType, UserInput};

/// How witmproxy reaches the broker.
pub enum Icanhaz {
    /// The tray app (or a headless daemon) over WebSocket.
    Ws(wrpc_websockets::Client<'static>),
    /// A loopback broker over TCP (tests).
    Tcp(wrpc_transport::tcp::Client<std::net::SocketAddr>),
}

/// The configuration prefix a plugin's settings live under in the store.
pub fn owner_prefix(plugin_id: &str) -> String {
    format!("witmproxy/{plugin_id}/")
}

/// What the tray shows a plugin's settings as.
pub fn capability_name(plugin_id: &str) -> String {
    format!("witmproxy:{plugin_id}")
}

/// A plugin's settings, as the daemon reads them back.
#[derive(Debug, Clone)]
pub struct Settings {
    pub revision: u64,
    /// `None` until the user set them up in the tray app.
    pub values: Option<Vec<UserInput>>,
}

impl Icanhaz {
    /// `ws://host:port`, the daemon's WebSocket endpoint.
    pub fn connect(url: &str) -> Result<Self> {
        let builder = tokio_websockets::ClientBuilder::new()
            .uri(url)
            .with_context(|| format!("icanhaz url `{url}`"))?;
        Ok(Icanhaz::Ws(wrpc_websockets::Client::from_builder(builder)))
    }

    pub fn tcp(addr: std::net::SocketAddr) -> Self {
        Icanhaz::Tcp(wrpc_transport::tcp::Client::from(addr))
    }

    async fn ask(
        &self,
        capability: &Capability,
        summary: &str,
        reason: &str,
        requester: &str,
    ) -> Result<Result<client::Approval, client::Denied>> {
        match self {
            Icanhaz::Ws(c) => client::consent(c, (), capability, summary, reason, requester).await,
            Icanhaz::Tcp(c) => client::consent(c, (), capability, summary, reason, requester).await,
        }
    }

    /// Declare a plugin's settings schema at the daemon, so the tray app
    /// renders it. Idempotent; re-declaring refreshes the schema.
    pub async fn declare(
        &self,
        plugin_id: &str,
        description: &str,
        schema: &[InputSchema],
    ) -> Result<()> {
        let declared = configuration::Declared {
            capability: capability_name(plugin_id),
            instance_noun: "configuration".to_string(),
            owner_prefix: owner_prefix(plugin_id),
            single: true,
            fields: schema.iter().map(schema_to_wire).collect(),
            description: (!description.is_empty()).then(|| description.to_string()),
        };
        let res = match self {
            Icanhaz::Ws(c) => configuration::declare(c, (), &declared).await,
            Icanhaz::Tcp(c) => configuration::declare(c, (), &declared).await,
        }
        .with_context(|| format!("declaring {plugin_id}'s configuration at icanhaz"))?;
        res.map_err(|e| anyhow::anyhow!("icanhaz refused the declaration: {e}"))
    }

    /// Withdraw a plugin's schema (when it is deleted).
    pub async fn undeclare(&self, plugin_id: &str) -> Result<()> {
        let name = capability_name(plugin_id);
        let res = match self {
            Icanhaz::Ws(c) => configuration::undeclare(c, (), &name).await,
            Icanhaz::Tcp(c) => configuration::undeclare(c, (), &name).await,
        }
        .with_context(|| format!("withdrawing {plugin_id}'s configuration at icanhaz"))?;
        res.map(|_| ())
            .map_err(|e| anyhow::anyhow!("icanhaz refused: {e}"))
    }

    /// A plugin's settings as the user last saved them, with the revision.
    pub async fn settings(&self, plugin_id: &str) -> Result<Settings> {
        let prefix = owner_prefix(plugin_id);
        let res = match self {
            Icanhaz::Ws(c) => configuration::configured(c, (), &prefix).await,
            Icanhaz::Tcp(c) => configuration::configured(c, (), &prefix).await,
        }
        .with_context(|| format!("reading {plugin_id}'s configuration from icanhaz"))?;
        let snapshot = res.map_err(|e| anyhow::anyhow!("icanhaz refused: {e}"))?;
        let values = snapshot
            .instances
            .into_iter()
            .find(|i| i.name == "default")
            .map(|i| i.values.into_iter().map(input_from_wire).collect());
        Ok(Settings {
            revision: snapshot.revision,
            values,
        })
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

type WireSchema = icanhaz_broker::configuration_serve::bindings::ezco::ezcap::forms::InputSchema;
type WireType = icanhaz_broker::configuration_serve::bindings::ezco::ezcap::forms::InputType;
type WireInput = icanhaz_broker::configuration_serve::bindings::ezco::ezcap::forms::ActualInput;
type WireUserInput = icanhaz_broker::configuration_serve::bindings::ezco::ezcap::forms::UserInput;
type WireFile = icanhaz_broker::configuration_serve::bindings::ezco::ezcap::forms::FileInput;

fn type_to_wire(t: &InputType) -> WireType {
    match t {
        InputType::Str => WireType::Str,
        InputType::Boolean => WireType::Boolean,
        InputType::Number => WireType::Number,
        InputType::Select(options) => WireType::Select(options.clone()),
        InputType::Datetime => WireType::Datetime,
        InputType::Daterange => WireType::Daterange,
        InputType::File => WireType::File,
        InputType::Binary => WireType::Binary,
        InputType::Secret => WireType::Secret,
    }
}

fn input_to_wire(v: &ActualInput) -> WireInput {
    match v {
        ActualInput::Str(s) => WireInput::Str(s.clone()),
        ActualInput::Boolean(b) => WireInput::Boolean(*b),
        ActualInput::Number(n) => WireInput::Number(*n),
        ActualInput::Select(s) => WireInput::Select(s.clone()),
        ActualInput::Datetime(s) => WireInput::Datetime(s.clone()),
        ActualInput::Daterange((a, b)) => WireInput::Daterange((a.clone(), b.clone())),
        ActualInput::File(f) => WireInput::File(WireFile {
            name: f.name.clone(),
            content_type: f.content_type.clone(),
            data: f.data.clone().into(),
        }),
        ActualInput::Binary(b) => WireInput::Binary(b.clone().into()),
        ActualInput::Secret(s) => WireInput::Secret(s.clone()),
    }
}

fn input_from_wire(u: WireUserInput) -> UserInput {
    use crate::wasm::bindgen::ezco::ezcap::forms::FileInput;
    let value = match u.value {
        WireInput::Str(s) => ActualInput::Str(s),
        WireInput::Boolean(b) => ActualInput::Boolean(b),
        WireInput::Number(n) => ActualInput::Number(n),
        WireInput::Select(s) => ActualInput::Select(s),
        WireInput::Datetime(s) => ActualInput::Datetime(s),
        WireInput::Daterange((a, b)) => ActualInput::Daterange((a, b)),
        WireInput::File(f) => ActualInput::File(FileInput {
            name: f.name,
            content_type: f.content_type,
            data: f.data.to_vec(),
        }),
        WireInput::Binary(b) => ActualInput::Binary(b.to_vec()),
        WireInput::Secret(s) => ActualInput::Secret(s),
    };
    UserInput {
        name: u.name,
        value,
    }
}

fn schema_to_wire(s: &InputSchema) -> WireSchema {
    WireSchema {
        name: s.name.clone(),
        input_type: type_to_wire(&s.input_type),
        optional: s.optional,
        default: s.default.as_ref().map(input_to_wire),
        description: s.description.clone(),
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
    use icanhaz_broker::configuration::{Registry, Value};
    use icanhaz_broker::configuration_serve::{ConfigurationProvider, serve_tcp_all};
    use icanhaz_broker::store::Store;
    use std::sync::Arc;
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
        let consent = Icanhaz::tcp(addr);
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
        Icanhaz::tcp(addr)
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
            Icanhaz::tcp(dead)
                .decide("@ezco/noop", "log", &mut caps)
                .await
                .is_err()
        );
        assert!(
            !caps[0].granted,
            "nothing granted when the broker is unreachable"
        );
    }

    #[tokio::test]
    async fn a_plugin_declares_its_settings_and_reads_back_what_the_tray_saved() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let store = Store::open_with(dir.path().join("icanhaz.db"), &source)
            .await
            .expect("store");
        let registry = Arc::new(Registry::new(Some(store), Vec::new()));
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let provider = BrokerProvider::new(
            GrantStore::shared(),
            Consent::AutoApprove,
            Pairings::shared(),
        );
        let server = tokio::spawn(serve_tcp_all(
            listener,
            provider,
            ConfigurationProvider::new(Arc::clone(&registry)),
        ));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let icanhaz = Icanhaz::tcp(addr);
        let schema = vec![
            InputSchema {
                name: "limit".to_string(),
                input_type: InputType::Number,
                optional: false,
                default: Some(ActualInput::Number(5.0)),
                description: Some("how many".to_string()),
            },
            InputSchema {
                name: "token".to_string(),
                input_type: InputType::Secret,
                optional: true,
                default: None,
                description: None,
            },
        ];
        icanhaz
            .declare("@ezco/noshorts", "Hides shorts", &schema)
            .await
            .expect("declared");
        // Nothing saved yet.
        let before = icanhaz.settings("@ezco/noshorts").await.expect("settings");
        assert!(before.values.is_none());

        // The tray saves the form (a single declaration ignores the name).
        registry
            .configure(
                "witmproxy:@ezco/noshorts",
                "",
                &[
                    icanhaz_broker::configuration::UserInput {
                        name: "limit".into(),
                        value: Value::Number(3.0),
                    },
                    icanhaz_broker::configuration::UserInput {
                        name: "token".into(),
                        value: Value::Secret("hunter2".into()),
                    },
                ],
            )
            .await
            .expect("saved");
        let after = icanhaz.settings("@ezco/noshorts").await.expect("settings");
        assert!(after.revision > before.revision);
        let values = after.values.expect("set up");
        assert!(values.iter().any(|v| v.name == "limit"
            && matches!(v.value, ActualInput::Number(n) if (n - 3.0).abs() < f64::EPSILON)));
        assert!(
            values.iter().any(|v| v.name == "token"
                && matches!(&v.value, ActualInput::Secret(s) if s == "hunter2"))
        );

        icanhaz
            .undeclare("@ezco/noshorts")
            .await
            .expect("withdrawn");
        assert!(icanhaz.settings("@ezco/noshorts").await.is_err());
        server.abort();
    }
}
