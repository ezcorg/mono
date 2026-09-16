//! `icanhaz:nocap/configuration` over wRPC: another local host declares a
//! `forms` schema, the tray app renders it, the values land in the store and
//! the declaring host reads them back. Browser origins are refused every
//! call: this is for processes on the machine, which already share its
//! trust, not for pages.

use std::sync::Arc;

use anyhow::Context as _;
use futures::stream::select_all;
use futures::StreamExt as _;
use tokio::net::TcpListener;

use crate::configuration::{Declared, Field, InputType, Registry, UserInput, Value};
use crate::AsOrigin;

pub mod bindings {
    wit_bindgen_wrpc::generate!({
        world: "configuration-wrpc",
        path: "../wit",
        with: {
            "ezco:ezcap/forms@0.1.0": generate,
        },
    });
}

/// The generated wRPC **client** stubs (`declare`/`undeclare`/`configured`).
pub use bindings::icanhaz::nocap::configuration as client;

use bindings::exports::icanhaz::nocap::configuration::{
    Declared as DeclaredWire, Instance as InstanceWire, Snapshot as SnapshotWire,
};
use bindings::ezco::ezcap::forms::{
    ActualInput as ActualWire, InputSchema as SchemaWire, InputType as TypeWire,
    UserInput as UserInputWire,
};

#[derive(Clone)]
pub struct ConfigurationProvider {
    registry: Arc<Registry>,
}

impl ConfigurationProvider {
    pub fn new(registry: Arc<Registry>) -> Self {
        Self { registry }
    }
}

fn type_from_wire(t: TypeWire) -> InputType {
    match t {
        TypeWire::Str => InputType::Str,
        TypeWire::Boolean => InputType::Boolean,
        TypeWire::Number => InputType::Number,
        TypeWire::Select(options) => InputType::Select(options),
        TypeWire::Datetime => InputType::Datetime,
        TypeWire::Daterange => InputType::Daterange,
        TypeWire::File => InputType::File,
        TypeWire::Binary => InputType::Binary,
        TypeWire::Secret => InputType::Secret,
    }
}

pub fn value_from_wire(v: ActualWire) -> Value {
    match v {
        ActualWire::Str(s) => Value::Str(s),
        ActualWire::Boolean(b) => Value::Boolean(b),
        ActualWire::Number(n) => Value::Number(n),
        ActualWire::Select(s) => Value::Select(s),
        ActualWire::Datetime(s) => Value::Datetime(s),
        ActualWire::Daterange((a, b)) => Value::Daterange((a, b)),
        ActualWire::File(f) => Value::File(crate::configuration::FileInput {
            name: f.name,
            content_type: f.content_type,
            data: f.data.to_vec(),
        }),
        ActualWire::Binary(b) => Value::Binary(b.to_vec()),
        ActualWire::Secret(s) => Value::Secret(s),
    }
}

pub fn value_to_wire(v: Value) -> ActualWire {
    match v {
        Value::Str(s) => ActualWire::Str(s),
        Value::Boolean(b) => ActualWire::Boolean(b),
        Value::Number(n) => ActualWire::Number(n),
        Value::Select(s) => ActualWire::Select(s),
        Value::Datetime(s) => ActualWire::Datetime(s),
        Value::Daterange((a, b)) => ActualWire::Daterange((a, b)),
        Value::File(f) => ActualWire::File(bindings::ezco::ezcap::forms::FileInput {
            name: f.name,
            content_type: f.content_type,
            data: f.data.into(),
        }),
        Value::Binary(b) => ActualWire::Binary(b.into()),
        Value::Secret(s) => ActualWire::Secret(s),
    }
}

fn field_from_wire(s: SchemaWire) -> Field {
    Field {
        name: s.name,
        input_type: type_from_wire(s.input_type),
        optional: s.optional,
        default: s.default.map(value_from_wire),
        description: s.description,
    }
}

fn declared_from_wire(d: DeclaredWire) -> Declared {
    Declared {
        capability: d.capability,
        instance_noun: d.instance_noun,
        owner_prefix: d.owner_prefix,
        single: d.single,
        fields: d.fields.into_iter().map(field_from_wire).collect(),
        description: d.description,
    }
}

fn user_input_to_wire(u: UserInput) -> UserInputWire {
    UserInputWire {
        name: u.name,
        value: value_to_wire(u.value),
    }
}

fn local_only(cx: &impl AsOrigin) -> Result<(), String> {
    match cx.origin() {
        Some(o) => Err(format!("configuration is for local hosts, not pages ({o})")),
        None => Ok(()),
    }
}

impl<C: AsOrigin + Send + Sync + 'static>
    bindings::exports::icanhaz::nocap::configuration::Handler<C> for ConfigurationProvider
{
    async fn declare(&self, cx: C, declared: DeclaredWire) -> anyhow::Result<Result<(), String>> {
        if let Err(e) = local_only(&cx) {
            return Ok(Err(e));
        }
        let declared = declared_from_wire(declared);
        tracing::info!(capability = %declared.capability, "configuration declared");
        Ok(self
            .registry
            .declare(&declared)
            .await
            .map_err(|e| e.to_string()))
    }

    async fn undeclare(&self, cx: C, capability: String) -> anyhow::Result<Result<bool, String>> {
        if let Err(e) = local_only(&cx) {
            return Ok(Err(e));
        }
        Ok(self
            .registry
            .undeclare(&capability)
            .await
            .map_err(|e| e.to_string()))
    }

    async fn configured(
        &self,
        cx: C,
        owner_prefix: String,
    ) -> anyhow::Result<Result<SnapshotWire, String>> {
        if let Err(e) = local_only(&cx) {
            return Ok(Err(e));
        }
        Ok(self
            .registry
            .configured(&owner_prefix)
            .await
            .map(|snap| SnapshotWire {
                revision: snap.revision,
                instances: snap
                    .instances
                    .into_iter()
                    .map(|(name, values)| InstanceWire {
                        name,
                        values: values.into_iter().map(user_input_to_wire).collect(),
                    })
                    .collect(),
            })
            .map_err(|e| e.to_string()))
    }
}

/// Serve the configuration interface alone over wRPC/TCP on `listener`
/// (tests; the daemon serves it beside everything else).
pub async fn serve_tcp(
    listener: TcpListener,
    provider: ConfigurationProvider,
) -> anyhow::Result<()> {
    let srv = Arc::new(wrpc_transport::Server::default());
    let accept = tokio::spawn({
        let srv = Arc::clone(&srv);
        async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _addr)) => {
                        let (rx, tx) = stream.into_split();
                        if let Err(err) = srv.accept((), tx, rx).await {
                            tracing::error!(?err, "failed to serve TCP connection");
                        }
                    }
                    Err(err) => tracing::error!(?err, "failed to accept TCP connection"),
                }
            }
        }
    });
    let invocations = bindings::serve(srv.as_ref(), provider)
        .await
        .context("failed to serve configuration")?;
    let mut invocations = select_all(
        invocations
            .into_iter()
            .map(|(instance, name, invocations)| invocations.map(move |res| (instance, name, res))),
    );
    while let Some((instance, name, res)) = invocations.next().await {
        match res {
            Ok(fut) => {
                tokio::spawn(async move {
                    if let Err(err) = fut.await {
                        tracing::warn!(?err, instance, name, "invocation failed");
                    }
                });
            }
            Err(err) => tracing::warn!(?err, instance, name, "failed to accept invocation"),
        }
    }
    accept.abort();
    Ok(())
}

/// Serve the broker and the configuration interface together over
/// wRPC/TCP on `listener`: what an embedding host's tests talk to, since the
/// daemon serves both on one endpoint.
pub async fn serve_tcp_all(
    listener: TcpListener,
    broker_p: crate::broker::BrokerProvider,
    cfg_p: ConfigurationProvider,
) -> anyhow::Result<()> {
    use futures::FutureExt as _;
    let srv = Arc::new(wrpc_transport::Server::default());
    let accept = tokio::spawn({
        let srv = Arc::clone(&srv);
        async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _addr)) => {
                        let (rx, tx) = stream.into_split();
                        if let Err(err) = srv.accept((), tx, rx).await {
                            tracing::error!(?err, "failed to serve TCP connection");
                        }
                    }
                    Err(err) => tracing::error!(?err, "failed to accept TCP connection"),
                }
            }
        }
    });
    let broker_invs = crate::broker::bindings::serve(srv.as_ref(), broker_p)
        .await
        .context("failed to serve broker")?;
    let cfg_invs = bindings::serve(srv.as_ref(), cfg_p)
        .await
        .context("failed to serve configuration")?;
    let mut invocations = select_all(
        broker_invs
            .into_iter()
            .map(|(i, n, s)| s.map(move |r| (i, n, r.map(|f| f.boxed()))).boxed())
            .chain(
                cfg_invs
                    .into_iter()
                    .map(|(i, n, s)| s.map(move |r| (i, n, r.map(|f| f.boxed()))).boxed()),
            ),
    );
    while let Some((instance, name, res)) = invocations.next().await {
        match res {
            Ok(fut) => {
                tokio::spawn(async move {
                    if let Err(err) = fut.await {
                        tracing::warn!(?err, instance, name, "invocation failed");
                    }
                });
            }
            Err(err) => tracing::warn!(?err, instance, name, "failed to accept invocation"),
        }
    }
    accept.abort();
    Ok(())
}
