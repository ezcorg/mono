use std::collections::HashMap;

use anyhow::Result;
use http_body_util::BodyExt;
use hyper::{body::Incoming, Request};
use tracing::warn;
use wasmtime::{component::Resource, Store};
use wasmtime_wasi_http::p3::{
    bindings::http::types::ErrorCode, Request as WasiRequest, Response as WasiResponse,
    WasiHttpView,
};

use crate::{
    db::{Db, Insert},
    plugins::{Capability, ProxyPlugin},
    wasm::{generated::Plugin, CapabilityProvider, Host, Runtime},
};

pub struct PluginRegistry {
    pub plugins: HashMap<String, ProxyPlugin>,
    pub db: Db,
    pub runtime: Runtime,
}

pub enum HostHandleRequestResult {
    Noop(Request<Incoming>),
    Request(WasiRequest),
    Response(WasiResponse),
}

impl PluginRegistry {
    pub fn new(db: Db, runtime: Runtime) -> Self {
        Self {
            plugins: HashMap::new(),
            db,
            runtime,
        }
    }

    pub async fn load_plugins(&mut self) -> Result<HashMap<String, ProxyPlugin>> {
        // TODO: select enabled plugins from DB, verify signatures, compile WASM components,
        // and populate self.plugins with handlers containing compiled invokers.
        Ok(HashMap::new())
    }

    pub async fn register_plugin(&mut self, plugin: ProxyPlugin) -> Result<()> {
        // Upsert the given plugin into the database
        plugin.insert(&mut self.db).await?;
        // Add it to the registry
        self.plugins.insert(plugin.id(), plugin);
        Ok(())
    }

    fn new_store(&self) -> Store<Host> {
        Store::new(&self.runtime.engine, Host::default())
    }

    pub async fn handle_request(&self, original_req: Request<Incoming>) -> HostHandleRequestResult {
        let plugins = self
            .plugins
            .values()
            .filter(|p| p.granted.contains(&Capability::Request))
            .collect::<Vec<&ProxyPlugin>>();

        if plugins.is_empty() {
            return HostHandleRequestResult::Noop(original_req);
        }

        let mut store = Store::new(&self.runtime.engine, Host::default());
        let (req, body) = original_req.into_parts();
        let body = body.map_err(ErrorCode::from_hyper_request_error);
        let req = Request::from_parts(req, body);
        let (req, io) = WasiRequest::from_http(req);
        let mut req: Resource<WasiRequest> = store.data_mut().http().table.push(req).unwrap();

        let provider = CapabilityProvider::new();
        let cap_res = store.data_mut().http().table.push(provider).unwrap();

        for plugin in plugins.iter() {
            let instance = self
                .runtime
                .linker
                .instantiate_async(&mut store, &plugin.component)
                .await;

            if let Err(e) = instance {
                warn!(
                    target: "plugins",
                    plugin_id = %plugin.id(),
                    event_type = %EventType::Request.as_str(),
                    error = %e,
                    "Failed to instantiate plugin; skipping"
                );
                continue;
            }
            let instance = instance.unwrap();

            let plugin_instance = Plugin::new(&mut store, &instance);

            if let Err(e) = plugin_instance {
                warn!(
                    target: "plugins",
                    plugin_id = %plugin.id(),
                    event_type = %EventType::Request.as_str(),
                    error = %e,
                    "Failed to access plugin event handler; skipping"
                );
                continue;
            }

            let plugin_instance = plugin_instance.unwrap();

            // Hyper request -> HTTP request -> WASI request -> our WASI handler

            let (tx, rx) = tokio::sync::oneshot::channel();

            tokio::task::spawn(async move {
                let guest_result = instance
                    .run_concurrent(
                        &mut store,
                        async move |store| -> Result<(), anyhow::Error> {
                            // Invoke the component's handler with the event type, data, and capability provider resource
                            let (result, task) = plugin_instance
                                .host_plugin_event_handler()
                                .call_handle_request(store, req, cap_res)
                                .await?;
                            task.block(store).await;
                            Ok(())
                        },
                    )
                    .await;
                let _ = tx.send(guest_result);
            });
            let result = rx.await;
        }
    }
}
