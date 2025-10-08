use std::collections::HashMap;

use anyhow::Result;
use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full};
use hyper::{body::Incoming, Request, Response};
use tracing::warn;
use wasmtime::{component::{Resource}, Store};
use wasmtime_wasi_http::p3::{
    bindings::http::{handler::ErrorCode}, Request as WasiRequest,
    WasiHttpView,
};

use crate::{
    db::{Db, Insert},
    plugins::{Capability, MitmPlugin},
    wasm::{generated::{exports::host::plugin::event_handler::{HandleRequestResult, RequestOrResponse}, Plugin}, CapabilityProvider, Host, Runtime},
};

pub struct PluginRegistry {
    pub plugins: HashMap<String, MitmPlugin>,
    pub db: Db,
    pub runtime: Runtime,
}

/// Result of handling a request through the plugin chain.
/// Omits any internal WASI types, only exposes HTTP types.
pub enum HostHandleRequestResult {
    Drop,
    Noop(Request<Incoming>),
    Request(Request<BoxBody<Bytes, ErrorCode>>),
    Response(Response<BoxBody<Bytes, ErrorCode>>),
}

pub enum HostHandleResponseResult {
    Response(Response<Full<Bytes>>),
}


impl PluginRegistry {
    pub fn new(db: Db, runtime: Runtime) -> Self {
        Self {
            plugins: HashMap::new(),
            db,
            runtime,
        }
    }

    pub async fn load_plugins(&mut self) -> Result<()> {
        // TODO: select plugins from DB, verify signatures, compile WASM components
        let plugins = MitmPlugin::all(&mut self.db, &self.runtime.engine).await?;
        for plugin in plugins.into_iter() {
            self.plugins.insert(plugin.id(), plugin);
        }
        Ok(())
    }

    pub async fn register_plugin(&mut self, plugin: MitmPlugin) -> Result<()> {
        // Upsert the given plugin into the database
        plugin.insert(&mut self.db).await?;
        // Add it to the registry
        self.plugins.insert(plugin.id(), plugin);
        Ok(())
    }

    fn new_store(&self) -> Store<Host> {
        Store::new(&self.runtime.engine, Host::default())
    }

    /// Handle an incoming HTTP request by passing it through all registered plugins
    /// that have the `Request` capability.
    pub async fn handle_request(&self, original_req: Request<Incoming>) -> HostHandleRequestResult {
        let plugins = self
            .plugins
            .values()
            .filter(|p| p.granted.contains(&Capability::Request))
            .collect::<Vec<&MitmPlugin>>();

        if plugins.is_empty() {
            return HostHandleRequestResult::Noop(original_req);
        }

        let (req, body) = original_req.into_parts();
        let body = body.map_err(ErrorCode::from_hyper_request_error);
        let req = Request::from_parts(req, body);
        let (mut current_req, _io) = WasiRequest::from_http(req);
        let mut store = self.new_store();

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
                    event_type = "request",
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
                    event_type = "request",
                    error = %e,
                    "Failed to access plugin event handler; skipping"
                );
                continue;
            }

            let plugin_instance = plugin_instance.unwrap();

            // Push the current request and capability provider into the table
            // The request is moved here, so we can't recover it if the plugin fails
            let req_resource: Resource<WasiRequest> = store.data_mut().http().table.push(current_req).unwrap();
            // TODO: the behavior of the capability provider should be configured based on the plugin's granted capabilities
            let provider = CapabilityProvider::new();
            let cap_resource = store.data_mut().http().table.push(provider).unwrap();
            // Call the plugin's handle_request function
            let guest_result = store
                .run_concurrent(
                    async move |store| -> Result<HandleRequestResult, ErrorCode> {

                        let (result, task) = match plugin_instance
                            .host_plugin_event_handler()
                            .call_handle_request(store, req_resource, cap_resource)
                            .await
                        {
                            Ok(ok) => ok,
                            Err(e) => {
                                warn!(
                                    target: "plugins",
                                    event_type = "request",
                                    error = %e,
                                    "Error calling handle_request"
                                );
                                return Err(ErrorCode::DestinationUnavailable);
                            }
                        };
                        task.block(store).await;
                        Ok(result)
                    },
                )
                .await;

            let inner = match guest_result {
                Ok(Ok(res)) => res,
                _ => {
                    // If plugin execution failed, we currently can't recover the request since it was moved
                    // Return Drop to indicate the request processing should stop
                    // TODO: fix this, despite whatever overhead it might add, it's
                    // probably worth it to duplicate the request before passing to each plugin
                    // such that we can recover from individual plugin failures
                    return HostHandleRequestResult::Drop;
                }
            };
            match inner {
                HandleRequestResult::Done(req_or_res) => {
                    match req_or_res {
                        RequestOrResponse::Request(r) => {
                            let r = store
                                .data_mut()
                                .http()
                                .table
                                .delete(r)
                                .expect("failed to delete request from table");
                            let req_result = r.into_http(&mut store, async { Ok(()) });
                            match req_result {
                                Ok(req) => return HostHandleRequestResult::Request(req),
                                Err(_) => return HostHandleRequestResult::Drop,
                            }
                        }
                        RequestOrResponse::Response(r) => {
                            let r = store
                                .data_mut()
                                .http()
                                .table
                                .delete(r)
                                .expect("failed to delete response from table");
                            let r = r.into_http(&mut store, async { Ok(()) });
                            match r {
                                Err(_) => return HostHandleRequestResult::Drop,
                                Ok(r) => {
                                    return HostHandleRequestResult::Response(r);
                                }
                            }
                        }
                    }
                },
                HandleRequestResult::Next(new_req) => {
                    // Extract the updated request from the table for the next iteration
                    current_req = store
                        .data_mut()
                        .http()
                        .table
                        .delete(new_req)
                        .expect("failed to retrieve new request from table");
                }
            };
        }
        match current_req.into_http(store, async { Ok(()) }) {
            Ok(req) => HostHandleRequestResult::Request(req),
            Err(_) => HostHandleRequestResult::Drop,
        }
    }

    /// Handle an incoming HTTP response by passing it through all registered plugins
    /// that have the `Response` capability.
    pub async fn handle_response(
        &self,
        original_res: Response<Full<Bytes>>,
    ) -> HostHandleResponseResult {
        // TODO:
        HostHandleResponseResult::Response(original_res)
    }
}
