use std::collections::{HashMap, HashSet};

use anyhow::Result;
use bytes::Bytes;
use cel::Value;
use http_body::Body;
use http_body_util::{BodyExt, Full, combinators::UnsyncBoxBody};
use hyper::{Request, Response, body::Incoming};
use tracing::{info, warn, debug};
use wasmtime::{Store, component::Resource};
use wasmtime_wasi_http::p3::{
    Request as WasiRequest, Response as WasiResponse, WasiHttpView,
    bindings::http::handler::ErrorCode,
};

use crate::{
    db::{Db, Insert},
    plugins::{
        Capability, WitmPlugin,
        cel::{CelRequest, CelResponse},
    },
    wasm::{
        CapabilityProvider, Host, Runtime,
        generated::{
            Plugin,
            exports::witmproxy::plugin::witm_plugin::{
                HandleRequestResult, HandleResponseResult, RequestOrResponse,
            },
        },
    },
};

pub struct PluginRegistry {
    plugins: HashMap<String, WitmPlugin>,
    pub db: Db,
    pub runtime: Runtime,
}

/// Result of handling a request through the plugin chain.
/// Omits any internal WASI types, only exposes HTTP types.
pub enum HostHandleRequestResult<T = Incoming>
where
    T: Body<Data = Bytes> + Send + Sync + 'static,
    T::Error: Into<ErrorCode>,
{
    None,
    Noop(Request<T>),
    Request(Request<UnsyncBoxBody<Bytes, ErrorCode>>),
    Response(Response<UnsyncBoxBody<Bytes, ErrorCode>>),
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

    pub fn plugins(&self) -> &HashMap<String, WitmPlugin> {
        &self.plugins
    }

    pub async fn load_plugins(&mut self) -> Result<()> {
        // TODO: select plugins from DB, verify signatures, compile WASM components
        let plugins = WitmPlugin::all(&mut self.db, &self.runtime.engine).await?;
        for plugin in plugins.into_iter() {
            self.plugins.insert(plugin.id(), plugin);
        }
        Ok(())
    }

    pub async fn plugin_from_component(&self, component_bytes: Vec<u8>) -> Result<WitmPlugin> {
        let component =
            wasmtime::component::Component::from_binary(&self.runtime.engine, &component_bytes)?;
        let mut store = wasmtime::Store::new(&self.runtime.engine, Host::default());
        let instance = self
            .runtime
            .linker
            .instantiate_async(&mut store, &component)
            .await?;
        let plugin_instance = Plugin::new(&mut store, &instance)?;
        let guest_result = store
            .run_concurrent(async move |store| {
                let (manifest, task) = match plugin_instance
                    .witmproxy_plugin_witm_plugin()
                    .call_manifest(store)
                    .await
                {
                    Ok(ok) => ok,
                    Err(e) => {
                        warn!("Error calling manifest: {}", e);
                        return Err(e);
                    }
                };
                task.block(store).await;

                Ok(manifest)
            })
            .await??;

        // Verify the WASM component signature using wasmsign2
        let public_key_bytes = &guest_result.publickey;
        if !public_key_bytes.is_empty() {
            let public_key = wasmsign2::PublicKey::from_bytes(&public_key_bytes)
                .map_err(|e| anyhow::anyhow!("Failed to parse public key: {}", e))?;

            let mut reader = std::io::Cursor::new(&component_bytes);
            match public_key.verify(&mut reader, None) {
                Ok(()) => {
                    info!(
                        "WASM component signature verified successfully for plugin: {}",
                        guest_result.name
                    );
                }
                Err(e) => {
                    anyhow::bail!(
                        "WASM component signature verification failed for plugin {}: {}",
                        guest_result.name,
                        e
                    );
                }
            }
        } else {
            anyhow::bail!(
                "Plugin {} does not have a public key for signature verification",
                guest_result.name
            );
        }

        let plugin = WitmPlugin::from(guest_result).with_component(component, component_bytes);
        Ok(plugin)
    }

    pub async fn register_plugin(&mut self, plugin: WitmPlugin) -> Result<()> {
        // Upsert the given plugin into the database
        plugin.insert(&mut self.db).await?;
        // Add it to the registry
        self.plugins.insert(plugin.id(), plugin);
        Ok(())
    }

    pub async fn remove_plugin(&mut self, name: &str, namespace: Option<&str>) -> Result<Vec<String>> {
        // Delete from database and get the deleted records using RETURNING
        let deleted_plugins: Vec<(String, String)> = if let Some(namespace) = namespace {
            // Delete specific plugin with namespace
            sqlx::query_as("DELETE FROM plugins WHERE namespace = ? AND name = ? RETURNING namespace, name")
                .bind(namespace)
                .bind(name)
                .fetch_all(&self.db.pool)
                .await?
        } else {
            // Delete all plugins with this name regardless of namespace
            sqlx::query_as("DELETE FROM plugins WHERE name = ? RETURNING namespace, name")
                .bind(name)
                .fetch_all(&self.db.pool)
                .await?
        };

        // Build list of plugin IDs that were removed and remove from in-memory registry
        let mut removed_plugin_ids = Vec::new();
        for (ns, n) in deleted_plugins {
            let plugin_id = WitmPlugin::make_id(&ns, &n);
            if self.plugins.remove(&plugin_id).is_some() {
                removed_plugin_ids.push(plugin_id);
            }
        }

        Ok(removed_plugin_ids)
    }

    fn new_store(&self) -> Store<Host> {
        Store::new(&self.runtime.engine, Host::default())
    }

    pub fn find_first_unexecuted_plugin(
        &self,
        cel_request: CelRequest,
        cel_response: Option<CelResponse>,
        executed_plugins: &HashSet<String>,
    ) -> Option<&WitmPlugin> {
        // Determine which capability we need based on whether we have a response
        let required_capability = match cel_response {
            None => Capability::Request,
            Some(_) => Capability::Response,
        };

        self.plugins
            .values()
            .find(|p| {
                p.granted.contains(&required_capability) && !executed_plugins.contains(&p.id())
            })
            .filter(|p| {
                if let Some(cel_selector) = &p.cel_filter {
                    let mut ctx = cel::Context::empty();

                    // Always add the CelRequest as "request"
                    let context_result =
                        ctx.add_variable("request", cel_request.clone())
                            .and_then(|_| {
                                // Add CelResponse as "response" if it's Some(), otherwise cel::Value::Null
                                match &cel_response {
                                    Some(cel_resp) => {
                                        _ = ctx.add_variable("response", cel_resp);
                                    }
                                    None => {
                                        _ = ctx.add_variable("response", cel::Value::Null);
                                    }
                                };
                                Ok(())
                            });

                    if let Err(e) = context_result {
                        warn!(
                            target: "plugins",
                            plugin_id = %p.id(),
                            error = %e,
                            "Failed to add variables to CEL context; skipping plugin"
                        );
                        return false;
                    }

                    let result = match cel_selector.execute(&ctx) {
                        Ok(v) => v,
                        Err(e) => {
                            warn!(
                                target: "plugins",
                                plugin_id = %p.id(),
                                error = %e,
                                "Failed to execute CEL filter; skipping plugin"
                            );
                            Value::Bool(false)
                        }
                    };
                    match result {
                        Value::Bool(b) => b,
                        _ => false,
                    }
                } else {
                    false
                }
            })
    }

    /// Handle an incoming HTTP request by passing it through all registered plugins
    /// that have the `Request` capability.
    pub async fn handle_request<T>(&self, original_req: Request<T>) -> HostHandleRequestResult<T>
    where
        T: Body<Data = Bytes> + Send + Sync + 'static,
        T::Error: Into<ErrorCode>,
    {
        let any_plugins = self
            .plugins
            .values()
            .any(|p| p.granted.contains(&Capability::Request));
        if !any_plugins {
            info!("No plugins with request capability and matching CEL expression; skipping plugin processing");
            return HostHandleRequestResult::Noop(original_req);
        }

        let (req, body) = original_req.into_parts();
        let body = body.map_err(Into::into);
        let req = Request::from_parts(req, body);
        let (mut current_req, _io) = WasiRequest::from_http(req);
        let mut store = self.new_store();
        let mut executed_plugins = HashSet::new();

        debug!("Starting plugin request processing loop for request: {:?}/{:?}", current_req.authority, current_req.path_with_query);

        while let Some(plugin) = {
            let cel_request = CelRequest::from(&current_req);
            self.find_first_unexecuted_plugin(cel_request, None, &executed_plugins)
        } {
            executed_plugins.insert(plugin.id());
            debug!("Executing handle_request for plugin: {} against: {:?}/{:?}", plugin.id(), current_req.authority, current_req.path_with_query);

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
            let req_resource: Resource<WasiRequest> =
                store.data_mut().http().table.push(current_req).unwrap();
            // TODO: the behavior of the capability provider should be configured based on the plugin's granted capabilities
            let provider = CapabilityProvider::new();
            let cap_resource = store.data_mut().http().table.push(provider).unwrap();
            // Call the plugin's handle_request function
            let guest_result = store
                .run_concurrent(
                    async move |store| -> Result<HandleRequestResult, ErrorCode> {
                        let (result, task) = match plugin_instance
                            .witmproxy_plugin_witm_plugin()
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
                HandleRequestResult::Done(req_or_res) => match req_or_res {
                    RequestOrResponse::Request(r) => {
                        let r = store
                            .data_mut()
                            .http()
                            .table
                            .delete(r)
                            .expect("failed to delete request from table");
                        let req_result = r.into_http(&mut store, async { Ok(()) });
                        match req_result {
                            Ok((req, _)) => return HostHandleRequestResult::Request(req),
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
            Ok((req, _)) => HostHandleRequestResult::Request(req),
            Err(_) => HostHandleRequestResult::None,
        }
    }

    /// Handle an incoming HTTP response by passing it through all registered plugins
    /// that have the `Response` capability.
    pub async fn handle_response(
        &self,
        original_res: Response<Full<Bytes>>,
        request_ctx: CelRequest,
    ) -> HostHandleResponseResult {
        let any_plugins = self
            .plugins
            .values()
            .any(|p| p.granted.contains(&Capability::Response));

        if !any_plugins {
            return HostHandleResponseResult::Response(original_res);
        }

        let (res, body) = original_res.into_parts();
        let res = Response::from_parts(res, body);
        let (mut current_res, _io) = WasiResponse::from_http(res);
        let mut store = self.new_store();
        let mut executed_plugins = HashSet::new();

        while let Some(plugin) = {
            let cel_response = CelResponse::from(&current_res);
            self.find_first_unexecuted_plugin(
                request_ctx.clone(),
                Some(cel_response),
                &executed_plugins,
            )
        } {
            executed_plugins.insert(plugin.id());

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

            let plugin_instance = match Plugin::new(&mut store, &instance) {
                Ok(pi) => pi,
                Err(e) => {
                    warn!(
                        target: "plugins",
                        plugin_id = %plugin.id(),
                        event_type = "response",
                        error = %e,
                        "Failed to access plugin event handler; skipping"
                    );
                    continue;
                }
            };

            // Push the current response and capability provider into the table
            // The response is moved here, so we can't recover it if the plugin fails
            let res_resource: Resource<WasiResponse> =
                store.data_mut().http().table.push(current_res).unwrap();
            // TODO: the behavior of the capability provider should be configured based on the plugin's granted capabilities
            let provider = CapabilityProvider::new();
            let cap_resource = store.data_mut().http().table.push(provider).unwrap();
            // Call the plugin's handle_response function
            let guest_result = store
                .run_concurrent(async move |store| {
                    let (result, task) = match plugin_instance
                        .witmproxy_plugin_witm_plugin()
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
                })
                .await;

            let inner = match guest_result {
                Ok(Ok(res)) => res,
                Ok(Err(e)) => {
                    warn!(
                        target: "plugins",
                        plugin_id = %plugin.id(),
                        event_type = "response",
                        error = ?e,
                        "Guest function returned error during response handling"
                    );
                    return HostHandleResponseResult::None;
                }
                Err(e) => {
                    warn!(
                        target: "plugins",
                        plugin_id = %plugin.id(),
                        event_type = "response",
                        error = %e,
                        "Failed to run plugin response handler"
                    );
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
                        }
                        Err(_) => return HostHandleResponseResult::None,
                    }
                }

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
            }
            Err(e) => {
                warn!("Failed to convert response to HTTP: {}", e);
                HostHandleResponseResult::None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::{Capability, CapabilitySet, WitmPlugin};
    use crate::test_utils::{create_plugin_registry, test_component_path};
    use bytes::Bytes;
    use http_body_util::Full;
    use hyper::{Method, Request};

    /// Create a test plugin with the specific CEL expression for filtering
    async fn register_test_plugin_with_cel_filter(
        registry: &mut PluginRegistry,
        cel_expression: &str,
    ) -> Result<(), anyhow::Error> {
        let wasm_path = test_component_path();
        let component_bytes = std::fs::read(&wasm_path).unwrap();
        let mut granted = CapabilitySet::new();
        granted.insert(Capability::Request);
        granted.insert(Capability::Response);
        let requested = granted.clone();

        // Compile the component from bytes using the registry's runtime engine
        let component = Some(wasmtime::component::Component::from_binary(
            &registry.runtime.engine,
            &component_bytes,
        )?);

        // Use the provided CEL expression
        let cel_source = cel_expression.to_string();
        let cel_filter = Some(cel::Program::compile(&cel_source)?);

        let plugin = WitmPlugin {
            name: "test_plugin_with_filter".into(),
            component_bytes,
            namespace: "test".into(),
            version: "0.0.0".into(),
            author: "author".into(),
            description: "description".into(),
            license: "mit".into(),
            enabled: true,
            url: "https://example.com".into(),
            publickey: "todo".into(),
            granted,
            requested,
            metadata: std::collections::HashMap::new(),
            component,
            cel_filter,
            cel_source,
        };
        registry.register_plugin(plugin).await
    }

    #[tokio::test]
    async fn test_find_first_unexecuted_plugin_with_cel_filter() {
        let (mut registry, _temp_dir) = create_plugin_registry().await;

        // Register a plugin with the specific CEL expression
        let cel_expression = "request.host != 'donotprocess.com' && !('skipthis' in request.headers && 'true' in request.headers['skipthis'])";
        register_test_plugin_with_cel_filter(&mut registry, cel_expression)
            .await
            .unwrap();

        let executed_plugins = HashSet::new();

        // Test case 1: Request to normal host without skipthis header - should match
        let req = Request::builder()
            .method(Method::GET)
            .uri("https://example.com/test")
            .header("host", "example.com")
            .body(Full::new(Bytes::from("test body")))
            .unwrap();
        let (wasi_req, _io) = WasiRequest::from_http(req);

        let cel_request = CelRequest::from(&wasi_req);
        let matching_plugin =
            registry.find_first_unexecuted_plugin(cel_request, None, &executed_plugins);
        assert!(
            matching_plugin.is_some(),
            "Request to example.com should return one plugin"
        );

        // Test case 2: Request to normal host with skipthis header set to 'false' - should match
        let req = Request::builder()
            .method(Method::GET)
            .uri("https://example.com/test")
            .header("host", "example.com")
            .header("skipthis", "false")
            .body(Full::new(Bytes::from("test body")))
            .unwrap();
        let (wasi_req, _io) = WasiRequest::from_http(req);

        let cel_request = CelRequest::from(&wasi_req);
        let matching_plugin =
            registry.find_first_unexecuted_plugin(cel_request, None, &executed_plugins);
        assert!(
            matching_plugin.is_some(),
            "Request to example.com with skipthis=false should return one plugin"
        );

        // Test case 3: Request to normal host with skipthis header set to 'true' - should not match
        let req = Request::builder()
            .method(Method::GET)
            .uri("https://example.com/test")
            .header("host", "example.com")
            .header("skipthis", "true")
            .body(Full::new(Bytes::from("test body")))
            .unwrap();
        let (wasi_req, _io) = WasiRequest::from_http(req);

        let cel_request = CelRequest::from(&wasi_req);
        let matching_plugin =
            registry.find_first_unexecuted_plugin(cel_request, None, &executed_plugins);
        assert!(
            matching_plugin.is_none(),
            "Request to example.com with skipthis=true should not match"
        );

        // Test case 4: Request to 'donotprocess.com' without skipthis header - should not match
        let req = Request::builder()
            .method(Method::GET)
            .uri("https://donotprocess.com/test")
            .header("host", "donotprocess.com")
            .body(Full::new(Bytes::from("test body")))
            .unwrap();
        let (wasi_req, _io) = WasiRequest::from_http(req);

        let cel_request = CelRequest::from(&wasi_req);
        let matching_plugin =
            registry.find_first_unexecuted_plugin(cel_request, None, &executed_plugins);
        assert!(
            matching_plugin.is_none(),
            "Request to donotprocess.com should not match"
        );

        // Test case 5: Request to 'donotprocess.com' with skipthis header set to 'false' - should not match
        let req = Request::builder()
            .method(Method::GET)
            .uri("https://donotprocess.com/test")
            .header("host", "donotprocess.com")
            .header("skipthis", "false")
            .body(Full::new(Bytes::from("test body")))
            .unwrap();
        let (wasi_req, _io) = WasiRequest::from_http(req);

        let cel_request = CelRequest::from(&wasi_req);
        let matching_plugin =
            registry.find_first_unexecuted_plugin(cel_request, None, &executed_plugins);
        assert!(
            matching_plugin.is_none(),
            "Request to donotprocess.com with skipthis=false should not match"
        );

        // Test case 6: Request to 'donotprocess.com' with skipthis header set to 'true' - should NOT match
        let req = Request::builder()
            .method(Method::GET)
            .uri("https://donotprocess.com/test")
            .header("host", "donotprocess.com")
            .header("skipthis", "true")
            .body(Full::new(Bytes::from("test body")))
            .unwrap();
        let (wasi_req, _io) = WasiRequest::from_http(req);

        let cel_request = CelRequest::from(&wasi_req);
        let matching_plugin =
            registry.find_first_unexecuted_plugin(cel_request, None, &executed_plugins);
        assert!(
            matching_plugin.is_none(),
            "Request to donotprocess.com with skipthis=true should not match"
        );
    }

    #[tokio::test]
    async fn test_find_first_unexecuted_plugin_no_plugins() {
        let (registry, _temp_dir) = create_plugin_registry().await;

        let req = Request::builder()
            .method(Method::GET)
            .uri("https://example.com/test")
            .header("host", "example.com")
            .body(Full::new(Bytes::from("test body")))
            .unwrap();
        let (wasi_req, _io) = WasiRequest::from_http(req);
        let executed_plugins = HashSet::new();

        let cel_request = CelRequest::from(&wasi_req);
        let matching_plugin =
            registry.find_first_unexecuted_plugin(cel_request, None, &executed_plugins);
        assert!(
            matching_plugin.is_none(),
            "Should return no plugins when none are registered"
        );
    }

    #[tokio::test]
    async fn test_find_first_unexecuted_plugin_no_request_capability() {
        let (mut registry, _temp_dir) = create_plugin_registry().await;

        // Register a plugin without Request capability
        let wasm_path = test_component_path();
        let component_bytes = std::fs::read(&wasm_path).unwrap();
        let mut granted = CapabilitySet::new();
        granted.insert(Capability::Response); // Only Response capability, not Request
        let requested = granted.clone();

        let component = Some(
            wasmtime::component::Component::from_binary(&registry.runtime.engine, &component_bytes)
                .unwrap(),
        );
        let cel_source = "true".to_string();
        let cel_filter = Some(cel::Program::compile(&cel_source).unwrap());

        let plugin = WitmPlugin {
            name: "response_only_plugin".into(),
            component_bytes,
            namespace: "test".into(),
            version: "0.0.0".into(),
            author: "author".into(),
            description: "description".into(),
            license: "mit".into(),
            enabled: true,
            url: "https://example.com".into(),
            publickey: "todo".into(),
            granted,
            requested,
            metadata: std::collections::HashMap::new(),
            component,
            cel_filter,
            cel_source,
        };
        registry.register_plugin(plugin).await.unwrap();

        let req = Request::builder()
            .method(Method::GET)
            .uri("https://example.com/test")
            .header("host", "example.com")
            .body(Full::new(Bytes::from("test body")))
            .unwrap();
        let (wasi_req, _io) = WasiRequest::from_http(req);
        let executed_plugins = HashSet::new();

        let cel_request = CelRequest::from(&wasi_req);
        let matching_plugin =
            registry.find_first_unexecuted_plugin(cel_request, None, &executed_plugins);
        assert!(
            matching_plugin.is_none(),
            "Should return no plugins when plugin doesn't have Request capability"
        );
    }

    #[tokio::test]
    async fn test_find_first_unexecuted_plugin_excludes_executed_plugins() {
        let (mut registry, _temp_dir) = create_plugin_registry().await;

        // Register first plugin that matches all requests
        let cel_expression1 = "true";
        register_test_plugin_with_cel_filter(&mut registry, cel_expression1)
            .await
            .unwrap();

        // Create another plugin with a different name to test multiple plugins
        let wasm_path = test_component_path();
        let component_bytes = std::fs::read(&wasm_path).unwrap();
        let mut granted = CapabilitySet::new();
        granted.insert(Capability::Request);
        granted.insert(Capability::Response);
        let requested = granted.clone();

        let component = Some(
            wasmtime::component::Component::from_binary(&registry.runtime.engine, &component_bytes)
                .unwrap(),
        );
        let cel_source = "true".to_string();
        let cel_filter = Some(cel::Program::compile(&cel_source).unwrap());

        let plugin2 = WitmPlugin {
            name: "second_test_plugin".into(),
            component_bytes,
            namespace: "test".into(),
            version: "0.0.0".into(),
            author: "author".into(),
            description: "description".into(),
            license: "mit".into(),
            enabled: true,
            url: "https://example.com".into(),
            publickey: "todo".into(),
            granted,
            requested,
            metadata: std::collections::HashMap::new(),
            component,
            cel_filter,
            cel_source,
        };
        registry.register_plugin(plugin2).await.unwrap();

        // Test with a request that should match both plugins initially
        let req = Request::builder()
            .method(Method::GET)
            .uri("https://example.com/test")
            .header("host", "example.com")
            .body(Full::new(Bytes::from("test body")))
            .unwrap();
        let (wasi_req, _io) = WasiRequest::from_http(req);

        let mut executed_plugins = HashSet::new();

        // First call should return a plugin
        let cel_request = CelRequest::from(&wasi_req);
        let first_plugin =
            registry.find_first_unexecuted_plugin(cel_request.clone(), None, &executed_plugins);
        assert!(
            first_plugin.is_some(),
            "Should find a plugin when none are executed"
        );

        // Add the first plugin to executed set
        executed_plugins.insert(first_plugin.unwrap().id());

        // Second call should return a different plugin (if there are multiple)
        let second_plugin =
            registry.find_first_unexecuted_plugin(cel_request.clone(), None, &executed_plugins);
        if let Some(second_plugin) = second_plugin {
            assert_ne!(
                first_plugin.unwrap().id(),
                second_plugin.id(),
                "Should return a different plugin"
            );

            // Add the second plugin to executed set
            executed_plugins.insert(second_plugin.id());

            // Third call should return None since all plugins are executed
            let third_plugin =
                registry.find_first_unexecuted_plugin(cel_request, None, &executed_plugins);
            assert!(
                third_plugin.is_none(),
                "Should return None when all plugins have been executed"
            );
        }
    }

    #[tokio::test]
    async fn test_remove_plugin_with_namespace() {
        let (mut registry, _temp_dir) = create_plugin_registry().await;

        // Register a plugin
        let cel_expression = "true";
        register_test_plugin_with_cel_filter(&mut registry, cel_expression)
            .await
            .unwrap();

        // Verify plugin is registered
        assert_eq!(registry.plugins().len(), 1);
        assert!(registry.plugins().contains_key("test/test_plugin_with_filter"));

        // Remove plugin with specific namespace
        let removed = registry.remove_plugin("test_plugin_with_filter", Some("test"))
            .await
            .unwrap();
        
        // Verify plugin was removed
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0], "test/test_plugin_with_filter");
        assert_eq!(registry.plugins().len(), 0);
    }

    #[tokio::test]
    async fn test_remove_plugin_without_namespace() {
        let (mut registry, _temp_dir) = create_plugin_registry().await;

        // Register multiple plugins with same name but different namespaces
        let wasm_path = test_component_path();
        let component_bytes = std::fs::read(&wasm_path).unwrap();
        
        for (namespace, name) in [("ns1", "common_plugin"), ("ns2", "common_plugin")] {
            let mut granted = CapabilitySet::new();
            granted.insert(Capability::Request);
            let requested = granted.clone();

            let component = Some(wasmtime::component::Component::from_binary(
                &registry.runtime.engine,
                &component_bytes,
            ).unwrap());

            let cel_source = "true".to_string();
            let cel_filter = Some(cel::Program::compile(&cel_source).unwrap());

            let plugin = WitmPlugin {
                name: name.to_string(),
                component_bytes: component_bytes.clone(),
                namespace: namespace.to_string(),
                version: "0.0.0".into(),
                author: "author".into(),
                description: "description".into(),
                license: "mit".into(),
                enabled: true,
                url: "https://example.com".into(),
                publickey: vec![],
                granted,
                requested,
                metadata: std::collections::HashMap::new(),
                component,
                cel_filter,
                cel_source,
            };
            registry.register_plugin(plugin).await.unwrap();
        }

        // Verify both plugins are registered
        assert_eq!(registry.plugins().len(), 2);
        assert!(registry.plugins().contains_key("ns1/common_plugin"));
        assert!(registry.plugins().contains_key("ns2/common_plugin"));

        // Remove all plugins with name "common_plugin" regardless of namespace
        let removed = registry.remove_plugin("common_plugin", None)
            .await
            .unwrap();
        
        // Verify both plugins were removed
        assert_eq!(removed.len(), 2);
        assert!(removed.contains(&"ns1/common_plugin".to_string()));
        assert!(removed.contains(&"ns2/common_plugin".to_string()));
        assert_eq!(registry.plugins().len(), 0);
    }

    #[tokio::test]
    async fn test_remove_nonexistent_plugin() {
        let (mut registry, _temp_dir) = create_plugin_registry().await;

        // Try to remove a plugin that doesn't exist
        let removed = registry.remove_plugin("nonexistent_plugin", Some("test"))
            .await
            .unwrap();
        
        // Verify nothing was removed
        assert_eq!(removed.len(), 0);
        assert_eq!(registry.plugins().len(), 0);
    }
}
