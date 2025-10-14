use std::collections::HashMap;

use anyhow::Result;
use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full};
use hyper::{body::Incoming, Request, Response};
use tracing::{info, warn};
use wasmtime::{component::{Resource}, Store};
use wasmtime_wasi_http::p3::{
    bindings::http::{handler::ErrorCode}, Request as WasiRequest, Response as WasiResponse,
    WasiHttpView,
};

use crate::{
    db::{Db, Insert},
    plugins::{Capability, WitmPlugin},
    wasm::{generated::{exports::host::plugin::event_handler::{HandleRequestResult, HandleResponseResult, RequestOrResponse}, Plugin}, CapabilityProvider, Host, Runtime},
};

pub struct PluginRegistry {
    pub plugins: HashMap<String, WitmPlugin>,
    pub db: Db,
    pub runtime: Runtime,
}

/// Result of handling a request through the plugin chain.
/// Omits any internal WASI types, only exposes HTTP types.
pub enum HostHandleRequestResult {
    None,
    Noop(Request<Incoming>),
    Request(Request<BoxBody<Bytes, ErrorCode>>),
    Response(Response<BoxBody<Bytes, ErrorCode>>),
}

pub enum HostHandleResponseResult {
    None,
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
        let plugins = WitmPlugin::all(&mut self.db, &self.runtime.engine).await?;
        for plugin in plugins.into_iter() {
            self.plugins.insert(plugin.id(), plugin);
        }
        Ok(())
    }

    pub async fn register_plugin(&mut self, plugin: WitmPlugin) -> Result<()> {
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
            .collect::<Vec<&WitmPlugin>>();

        if plugins.is_empty() {
            return HostHandleRequestResult::Noop(original_req);
        }

        let (req, body) = original_req.into_parts();
        let body = body.map_err(ErrorCode::from_hyper_request_error);
        let req = Request::from_parts(req, body);
        let (mut current_req, _io) = WasiRequest::from_http(req);
        let mut store = self.new_store();

        for plugin in plugins.iter() {

            let component = if let Some(c) = &plugin.component {
                c
            } else {
                continue;
            };
            
            let instance = self
                .runtime
                .linker
                .instantiate_async(&mut store, &component)
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
                    return HostHandleRequestResult::None;
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
                                Err(_) => return HostHandleRequestResult::None,
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
                                Err(_) => return HostHandleRequestResult::None,
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

        current_req.headers.iter().for_each(|(k, v)| {
            info!(target: "plugins", "Final request header: {}: {:?}", k, v);
        });

        match current_req.into_http(store, async { Ok(()) }) {
            Ok(req) => HostHandleRequestResult::Request(req),
            Err(_) => HostHandleRequestResult::None,
        }
    }

    /// Handle an incoming HTTP response by passing it through all registered plugins
    /// that have the `Response` capability.
    pub async fn handle_response(
        &self,
        original_res: Response<Full<Bytes>>,
    ) -> HostHandleResponseResult {
        let plugins = self
            .plugins
            .values()
            .filter(|p| p.granted.contains(&Capability::Response))
            .collect::<Vec<&WitmPlugin>>();

        if plugins.is_empty() {
            return HostHandleResponseResult::Response(original_res);
        }

        let (res, body) = original_res.into_parts();
        let res = Response::from_parts(res, body);
        let (mut current_res, _io) = WasiResponse::from_http(res);
        let mut store = self.new_store();

        for plugin in plugins.iter() {
            let component = if let Some(c) = &plugin.component {
                c
            } else {
                continue;
            };
            
            let instance = self
                .runtime
                .linker
                .instantiate_async(&mut store, &component)
                .await;

            if let Err(e) = instance {
                warn!(
                    target: "plugins",
                    plugin_id = %plugin.id(),
                    event_type = "response",
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
                    event_type = "response",
                    error = %e,
                    "Failed to access plugin event handler; skipping"
                );
                continue;
            }

            let plugin_instance = plugin_instance.unwrap();

            // Push the current response and capability provider into the table
            // The response is moved here, so we can't recover it if the plugin fails
            let res_resource: Resource<WasiResponse> = store.data_mut().http().table.push(current_res).unwrap();
            // TODO: the behavior of the capability provider should be configured based on the plugin's granted capabilities
            let provider = CapabilityProvider::new();
            let cap_resource = store.data_mut().http().table.push(provider).unwrap();
            // Call the plugin's handle_response function
            let guest_result = store
                .run_concurrent(
                    async move |store| -> Result<HandleResponseResult, ErrorCode> {

                        let (result, task) = match plugin_instance
                            .host_plugin_event_handler()
                            .call_handle_response(store, res_resource, cap_resource)
                            .await
                        {
                            Ok(ok) => ok,
                            Err(e) => {
                                warn!(
                                    target: "plugins",
                                    event_type = "response",
                                    error = %e,
                                    "Error calling handle_response"
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
                    // If plugin execution failed, we currently can't recover the response since it was moved
                    // Return None to indicate the response processing should stop
                    // TODO: fix this, despite whatever overhead it might add, it's
                    // probably worth it to duplicate the response before passing to each plugin
                    // such that we can recover from individual plugin failures
                    return HostHandleResponseResult::None;
                }
            };
            match inner {
                HandleResponseResult::Done(res) => {
                    let res = store
                        .data_mut()
                        .http()
                        .table
                        .delete(res)
                        .expect("failed to delete response from table");
                    let res_result = res.into_http(&mut store, async { Ok(()) });
                    match res_result {
                        Ok(res) => {
                            // Convert BoxBody to Full<Bytes>
                            let (parts, body) = res.into_parts();
                            // Collect the body asynchronously
                            let collected = match body.collect().await {
                                Ok(collected) => collected.to_bytes(),
                                Err(_) => return HostHandleResponseResult::None,
                            };
                            let body = Full::new(collected);
                            let res = Response::from_parts(parts, body);
                            return HostHandleResponseResult::Response(res);
                        },
                        Err(_) => return HostHandleResponseResult::None,
                    }
                },
                HandleResponseResult::Next(new_res) => {
                    // Extract the updated response from the table for the next iteration
                    current_res = store
                        .data_mut()
                        .http()
                        .table
                        .delete(new_res)
                        .expect("failed to retrieve new response from table");
                }
            };
        }

        current_res.headers.iter().for_each(|(k, v)| {
            info!(target: "plugins", "Final response header: {}: {:?}", k, v);
        });

        match current_res.into_http(store, async { Ok(()) }) {
            Ok(res) => {
                // Convert BoxBody to Full<Bytes>
                let (parts, body) = res.into_parts();
                // Collect the body asynchronously
                let collected = match body.collect().await {
                    Ok(collected) => collected.to_bytes(),
                    Err(_) => return HostHandleResponseResult::None,
                };
                let body = Full::new(collected);
                let res = Response::from_parts(parts, body);
                HostHandleResponseResult::Response(res)
            },
            Err(_) => HostHandleResponseResult::None,
        }
    }
}
