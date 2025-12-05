use std::{collections::{HashMap, HashSet}};

use anyhow::Result;
use bytes::Bytes;
use cel_cxx::{Env};
use http_body::Body;
use http_body_util::{BodyExt, Full, combinators::UnsyncBoxBody};
use hyper::{Request, Response, body::Incoming};
use tracing::{debug, info, warn};
use wasmtime::{Store, component::Resource};
use wasmtime_wasi_http::p3::{
    Request as WasiRequest, Response as WasiResponse, WasiHttpView,
    bindings::http::handler::ErrorCode,
};

use crate::{
    db::{Db, Insert}, events::{Event, response::{ResponseEnum, ResponseWithRequestContext}}, plugins::{WitmPlugin, cel::CelRequest
    }, wasm::{
        CapabilityProvider, Host, Runtime, bindgen::{Plugin, witmproxy::plugin::capabilities::EventData}
    }
};

pub struct PluginRegistry {
    plugins: HashMap<String, WitmPlugin>,
    pub db: Db,
    pub runtime: Runtime,
    env: &'static Env<'static>,
}

pub enum HostHandleResult {
    None,
    Noop(EventData),
    Event(EventData),
}

/// Result of handling a request through the plugin chain.
/// Omits any internal WASI types, only exposes HTTP types.
pub enum HostHandleRequestResult<T = Incoming>
where
    T: Body<Data = Bytes> + Send + Sync + 'static,
{
    None,
    Noop(Request<T>),
    Request(Request<UnsyncBoxBody<Bytes, ErrorCode>>),
    Response(Response<UnsyncBoxBody<Bytes, ErrorCode>>),
}

pub enum HostHandleResponseResult<T = Full<Bytes>>
where
    T: Body<Data = Bytes> + Send + Sync + 'static,
{
    None,
    Noop(Response<T>),
    Response(Response<UnsyncBoxBody<Bytes, ErrorCode>>),
}

impl EventData {
    pub fn register<'a>(env: cel_cxx::EnvBuilder<'a>) -> Result<cel_cxx::EnvBuilder<'a>> {
        // TODO: do this better
        let env = WasiRequest::register_in_cel_env(env)?;
        let env = ResponseWithRequestContext::<http_body_util::Full<bytes::Bytes>>::register_in_cel_env(env)?;

        Ok(env)
    }
}

impl PluginRegistry {
    pub fn new(db: Db, runtime: Runtime) -> Result<Self> {
        let env = EventData::register(
            Env::builder()
            .with_standard(true)
        )?.build()?;
        // Leak the env to get a static reference since it contains only static data
        // and we want it to live for the program duration
        // TODO: fix this with proper lifetime management
        let env: &'static Env<'static> = Box::leak(Box::new(env));
        Ok(Self {
            plugins: HashMap::new(),
            db,
            runtime,
            env,
        })
    }

    pub fn plugins(&self) -> &HashMap<String, WitmPlugin> {
        &self.plugins
    }

    pub async fn load_plugins(&mut self) -> Result<()> {
        // TODO: select plugins from DB, verify signatures, compile WASM components
        let plugins = WitmPlugin::all(&mut self.db, &self.runtime.engine, self.env).await?;
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
            let public_key = wasmsign2::PublicKey::from_bytes(public_key_bytes)
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

        let plugin = WitmPlugin::from(guest_result)
            .with_component(component, component_bytes)
            .compile_capability_scope_expressions(self.env)?;
        Ok(plugin)
    }

    pub async fn register_plugin(&mut self, plugin: WitmPlugin) -> Result<()> {
        // Upsert the given plugin into the database
        plugin.insert(&mut self.db).await?;
        // Add it to the registry
        self.plugins.insert(plugin.id(), plugin);
        Ok(())
    }

    pub async fn remove_plugin(
        &mut self,
        name: &str,
        namespace: Option<&str>,
    ) -> Result<Vec<String>> {
        // Delete from database and get the deleted records using RETURNING
        let deleted_plugins: Vec<(String, String)> = if let Some(namespace) = namespace {
            // Delete specific plugin with namespace
            sqlx::query_as(
                "DELETE FROM plugins WHERE namespace = ? AND name = ? RETURNING namespace, name",
            )
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
        // TODO: This is where we need to pass actual context
        Store::new(&self.runtime.engine, Host::default())
    }

    pub fn find_first_unexecuted_plugin(
        &self,
        event: &impl Event,
        executed_plugins: &HashSet<String>,
    ) -> Option<&WitmPlugin> {
        self.plugins.values().find(|p| {
            !executed_plugins.contains(&p.id())
                && p.can_handle(event)
        })
    }

    /// Check if any plugins can handle an event
    pub fn can_handle<E: Event>(&self, event: &E) -> bool {
        self.plugins
            .values()
            .any(|p| p.can_handle(event))
    }

    pub async fn handle_event(&self, event: impl Event) -> HostHandleResult {
        todo!()
        // HostHandleResult::Noop(event.data(&mut self.runtime.new_store()).unwrap())
    }

    /// Handle an incoming HTTP request by passing it through all registered plugins
    /// that have the `Request` capability.
    pub async fn handle_request<T>(&self, original_req: Request<T>) -> HostHandleRequestResult<T>
    where
        T: Body<Data = Bytes> + Send + Sync + 'static,
    {
        let any_plugins = self
            .plugins
            .values()
            .any(|p| p.can_handle(&original_req));
        if !any_plugins {
            debug!(
                "No plugins with request capability and matching CEL expression; skipping plugin processing"
            );
            return HostHandleRequestResult::Noop(original_req);
        }

        let (req, body) = original_req.into_parts();
        let body = body.map_err(|_| ErrorCode::HttpProtocolError);
        let req = Request::from_parts(req, body);
        let (mut current_req, _io) = WasiRequest::from_http(req);
        let mut current_store: Option<Store<Host>> = None;
        let mut executed_plugins = HashSet::new();

        debug!(
            "Starting plugin request processing loop for request: {:?}/{:?}",
            current_req.authority, current_req.path_with_query
        );

        while let Some(plugin) = {
            let cel_request = CelRequest::from(&current_req);
            self.find_first_unexecuted_plugin(&current_req, &executed_plugins)
        } {
            executed_plugins.insert(plugin.id());
            debug!(
                "Executing handle_request for plugin: {} against: {:?}/{:?}",
                plugin.id(),
                current_req.authority,
                current_req.path_with_query
            );

            let component = if let Some(c) = &plugin.component {
                c
            } else {
                continue;
            };

            let (plugin_instance, store) = match self.runtime.instantiate_plugin_component(component).await {
                Ok(pi) => pi,
                Err(e) => {
                    warn!(
                        target: "plugins",
                        plugin_id = %plugin.id(),
                        event_type = "request",
                        error = %e,
                        "Failed to instantiate plugin component; skipping"
                    );
                    continue;
                }
            };
            current_store = Some(store);
            let req_resource: Resource<WasiRequest> = current_store.as_mut().unwrap().data_mut().table.push(current_req).unwrap();
            let event_data = EventData::Request(req_resource);
            // TODO: the behavior of the capability provider should be configured based on the plugin's granted capabilities
            let provider = CapabilityProvider::new();
            let cap_resource = current_store.as_mut().unwrap().data_mut().table.push(provider).unwrap();
            // Call the plugin's `handle` function
            let guest_result = current_store.as_mut().unwrap()
                .run_concurrent(async move |store| {
                    let (result, task) = match plugin_instance
                        .witmproxy_plugin_witm_plugin()
                        .call_handle(store, event_data, cap_resource)
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
                })
                .await;

            let inner = match guest_result {
                Ok(Ok(Some(res))) => res,
                _ => {
                    // If plugin execution failed, we currently can't recover the request since it was moved
                    // Return Drop to indicate the request processing should stop
                    // TODO: consider a fix of some kind for this
                    return HostHandleRequestResult::None;
                }
            };
            match inner {
                EventData::Request(r) => {
                    let r = current_store.as_mut().unwrap().data_mut().table.delete(r)
                        .expect("failed to delete request from table");
                    current_req = r;
                }
                EventData::Response(r) => {
                    let r = current_store.as_mut().unwrap().data_mut().table.delete(r)
                        .expect("failed to delete response from table");
                    let r = r.into_http(&mut current_store.as_mut().unwrap(), async { Ok(()) });
                    match r {
                        Err(_) => return HostHandleRequestResult::None,
                        Ok(r) => {
                            return HostHandleRequestResult::Response(r);
                        }
                    }
                }
                EventData::InboundContent(_) => return HostHandleRequestResult::None,
            };
        }

        match current_req.into_http(current_store.unwrap(), async { Ok(()) }) {
            Ok((req, _)) => HostHandleRequestResult::Request(req),
            Err(_) => HostHandleRequestResult::None,
        }
    }

    /// Handle an incoming HTTP response by passing it through all registered plugins
    /// that have the `Response` capability.
    pub async fn handle_response<T>(
        &self,
        original_res: Response<T>,
        request_ctx: CelRequest,
    ) -> HostHandleResponseResult<T>
    where
        T: Body<Data = Bytes> + Send + Sync + 'static,
    {
        let event = ResponseWithRequestContext {
            request_ctx: request_ctx.clone(),
            response: ResponseEnum::HyperResponse(original_res),
        };
        let any_plugins = self
            .plugins
            .values()
            .any(|p| p.can_handle(&event));

        if !any_plugins {
            match event.response {
                ResponseEnum::HyperResponse(res) => {
                    return HostHandleResponseResult::Noop(res);
                },
                _ => { unreachable!() },
            }
        }

        let (res, body) = original_res.into_parts();
        let body = body.map_err(|_| ErrorCode::HttpProtocolError);
        let res = Response::from_parts(res, body);
        let (mut current_res, _io) = WasiResponse::from_http(res);
        let mut response_event: ResponseWithRequestContext<T> = ResponseWithRequestContext {
            request_ctx,
            response: ResponseEnum::WasiResponse(current_res),
        };
        let mut store = self.new_store();
        let mut executed_plugins = HashSet::new();

        while let Some(plugin) = {
            self.find_first_unexecuted_plugin(
                &response_event,
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
                .instantiate_async(&mut store, component)
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
            let event_data = EventData::Response(res_resource);
            // TODO: the behavior of the capability provider should be configured based on the plugin's granted capabilities
            let provider = CapabilityProvider::new();
            let cap_resource = store.data_mut().http().table.push(provider).unwrap();
            // Call the plugin's handle_response function
            let guest_result = store
                .run_concurrent(async move |store| {
                    let (result, task) = match plugin_instance
                        .witmproxy_plugin_witm_plugin()
                        .call_handle(store, event_data, cap_resource)
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
                Ok(Ok(Some(res))) => res,
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
                _ => {
                    return HostHandleResponseResult::None;
                }
            };
            match inner {
                EventData::Response(new_res) => {
                    // Extract the updated response from the table for the next iteration
                    current_res = store
                        .data_mut()
                        .http()
                        .table
                        .delete(new_res)
                        .expect("failed to retrieve new response from table");
                }
                _ => {
                    return HostHandleResponseResult::None;
                }
            };
        }

        match current_res.into_http(store, async { Ok(()) }) {
            Ok(res) => HostHandleResponseResult::Response(res),
            Err(e) => {
                warn!("Failed to convert response to HTTP: {}", e);
                HostHandleResponseResult::None
            }
        }
    }

    pub async fn handle_response_content<T>(&self, res: Response<T>) -> Response<T>
    where
        T: Body<Data = Bytes> + Send + Sync + 'static, 
    {
        res
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::{create_plugin_registry, test_component_path};
    use crate::wasm::bindgen::witmproxy::plugin::capabilities::{CapabilityKind, CapabilityScope, EventKind};
    use crate::{
        plugins::{WitmPlugin, capabilities::Capability},
        wasm::bindgen::witmproxy::plugin::capabilities::{
            Capability as WitCapability,
        },
    };
    use bytes::Bytes;
    use http_body_util::Full;
    use hyper::{Method, Request};

    /// Create a test plugin with the specific CEL expression for filtering
    async fn register_test_plugin_with_cel_filter(
        registry: &mut PluginRegistry,
        cel_expression: &str,
    ) -> Result<(), anyhow::Error> {
        let wasm_path = test_component_path()?;
        let component_bytes = std::fs::read(&wasm_path)?;

        // Compile the component from bytes using the registry's runtime engine
        let component = Some(wasmtime::component::Component::from_binary(
            &registry.runtime.engine,
            &component_bytes,
        )?);

        let mut capabilities = Vec::new();
        capabilities.push(Capability {
            granted: true,
            inner: WitCapability {
                kind: CapabilityKind::HandleEvent(EventKind::Request),
                scope: CapabilityScope {
                    expression: cel_expression.into(),
                },
            },
            cel: None,
        });
        capabilities.push(Capability {
            granted: true,
            inner: WitCapability {
                kind: CapabilityKind::HandleEvent(EventKind::Request),
                scope: CapabilityScope {
                    expression: cel_expression.into(),
                },
            },
            cel: None,
        });
        capabilities.push(Capability {
            granted: true,
            inner: WitCapability {
                kind: CapabilityKind::HandleEvent(EventKind::Request),
                scope: CapabilityScope {
                    expression: cel_expression.into(),
                },
            },
            cel: None,
        });

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
            publickey: vec![],
            capabilities,
            metadata: std::collections::HashMap::new(),
            component,
        }
        .compile_capability_scope_expressions(&registry.env)?;
        registry.register_plugin(plugin).await
    }

    #[tokio::test]
    async fn test_find_first_unexecuted_plugin_with_cel_filter() -> Result<(), anyhow::Error> {
        let (mut registry, _temp_dir) = create_plugin_registry().await?;

        // Register a plugin with the specific CEL expression
        let cel_expression = "request.host() != 'donotprocess.com' && !('skipthis' in request.headers() && 'true' in request.headers()['skipthis'])";
        register_test_plugin_with_cel_filter(&mut registry, cel_expression).await?;

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
            registry.find_first_unexecuted_plugin(&wasi_req, &executed_plugins);
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
            registry.find_first_unexecuted_plugin(&wasi_req, &executed_plugins);
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
            registry.find_first_unexecuted_plugin(&wasi_req, &executed_plugins);
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
            registry.find_first_unexecuted_plugin(&wasi_req, &executed_plugins);
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
            registry.find_first_unexecuted_plugin(&wasi_req, &executed_plugins);
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
            registry.find_first_unexecuted_plugin(&wasi_req, &executed_plugins);
        assert!(
            matching_plugin.is_none(),
            "Request to donotprocess.com with skipthis=true should not match"
        );
        Ok(())
    }

    #[tokio::test]
    async fn test_find_first_unexecuted_plugin_no_plugins() -> Result<(), anyhow::Error> {
        let (registry, _temp_dir) = create_plugin_registry().await?;

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
            registry.find_first_unexecuted_plugin(&wasi_req, &executed_plugins);
        assert!(
            matching_plugin.is_none(),
            "Should return no plugins when none are registered"
        );
        Ok(())
    }

    #[tokio::test]
    async fn test_find_first_unexecuted_plugin_no_request_capability() -> Result<(), anyhow::Error>
    {
        let (mut registry, _temp_dir) = create_plugin_registry().await?;

        // Register a plugin without Request capability
        let wasm_path = test_component_path()?;
        let component_bytes = std::fs::read(&wasm_path)?;

        let component = Some(
            wasmtime::component::Component::from_binary(&registry.runtime.engine, &component_bytes)
                .unwrap(),
        );

        let mut capabilities = Vec::new();
        capabilities.push(Capability {
            granted: true,
            inner: WitCapability {
                kind: CapabilityKind::HandleEvent(EventKind::Connect),
                scope: CapabilityScope {
                    expression: "true".
into(),
                }
            },
            cel: None,
        });
        capabilities.push(Capability {
            granted: true,
            inner: WitCapability {
                kind: CapabilityKind::HandleEvent(EventKind::Response),
                scope: CapabilityScope {
                    expression: "true".to_string(),
                }
            },
            cel: None,
        });

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
            publickey: vec![],
            capabilities,
            metadata: std::collections::HashMap::new(),
            component,
        };
        registry.register_plugin(plugin).await?;

        let req = Request::builder()
            .method(Method::GET)
            .uri("https://example.com/test")
            .header("host", "example.com")
            .body(Full::new(Bytes::from("test body")))
            .unwrap();
        let (wasi_req, _io) = WasiRequest::from_http(req);
        let executed_plugins = HashSet::new();

        let matching_plugin =
            registry.find_first_unexecuted_plugin(&wasi_req, &executed_plugins);
        assert!(
            matching_plugin.is_none(),
            "Should return no plugins when plugin doesn't have Request capability"
        );
        Ok(())
    }

    #[tokio::test]
    async fn test_find_first_unexecuted_plugin_excludes_executed_plugins()
    -> Result<(), anyhow::Error> {
        let (mut registry, _temp_dir) = create_plugin_registry().await?;

        // Register first plugin that matches all requests
        let cel_expression1 = "true";
        register_test_plugin_with_cel_filter(&mut registry, cel_expression1).await?;

        // Create another plugin with a different name to test multiple plugins
        let wasm_path = test_component_path()?;
        let component_bytes = std::fs::read(&wasm_path)?;

        let component = Some(
            wasmtime::component::Component::from_binary(&registry.runtime.engine, &component_bytes)
                .unwrap(),
        );
        let mut capabilities = Vec::new();
        capabilities.push(Capability {
            granted: true,
            inner: WitCapability{

                kind: CapabilityKind::HandleEvent(EventKind::Connect),
                scope: CapabilityScope {
                    expression: "true".
into(),

                }
                
            },
            cel: None,
        });
        capabilities.push(Capability {
            granted: true,
            inner: WitCapability {
                kind: CapabilityKind::HandleEvent(EventKind::Request),
                scope: CapabilityScope {
                    expression: "true".to_string(),
                }
            },
            cel: None,
        });
        capabilities.push(Capability {
            granted: true,
            inner: WitCapability {
                kind: CapabilityKind::HandleEvent(EventKind::Response),
                scope: CapabilityScope {
                    expression: "true".to_string(),
                }
            },
            cel: None,
        });

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
            publickey: vec![],
            capabilities,
            metadata: std::collections::HashMap::new(),
            component,
        }
        .compile_capability_scope_expressions(&registry.env)?;
        registry.register_plugin(plugin2).await?;

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
            registry.find_first_unexecuted_plugin(&wasi_req, &executed_plugins);
        assert!(
            first_plugin.is_some(),
            "Should find a plugin when none are executed"
        );

        // Add the first plugin to executed set
        executed_plugins.insert(first_plugin.unwrap().id());

        // Second call should return a different plugin (if there are multiple)
        let second_plugin =
            registry.find_first_unexecuted_plugin(&wasi_req, &executed_plugins);
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
                registry.find_first_unexecuted_plugin(&wasi_req, &executed_plugins);
            assert!(
                third_plugin.is_none(),
                "Should return None when all plugins have been executed"
            );
        }
        Ok(())
    }

    #[tokio::test]
    async fn test_remove_plugin_with_namespace() -> Result<(), anyhow::Error> {
        let (mut registry, _temp_dir) = create_plugin_registry().await?;

        // Register a plugin
        let cel_expression = "true";
        register_test_plugin_with_cel_filter(&mut registry, cel_expression).await?;

        // Verify plugin is registered
        assert_eq!(registry.plugins().len(), 1);
        assert!(
            registry
                .plugins()
                .contains_key("test/test_plugin_with_filter")
        );

        // Remove plugin with specific namespace
        let removed = registry
            .remove_plugin("test_plugin_with_filter", Some("test"))
            .await?;

        // Verify plugin was removed
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0], "test/test_plugin_with_filter");
        assert_eq!(registry.plugins().len(), 0);
        Ok(())
    }

    #[tokio::test]
    async fn test_remove_plugin_without_namespace() -> Result<(), anyhow::Error> {
        let (mut registry, _temp_dir) = create_plugin_registry().await?;

        // Register multiple plugins with same name but different namespaces
        let wasm_path = test_component_path()?;
        let component_bytes = std::fs::read(&wasm_path)?;

        for (namespace, name) in [("ns1", "common_plugin"), ("ns2", "common_plugin")] {
            let component = Some(
                wasmtime::component::Component::from_binary(
                    &registry.runtime.engine,
                    &component_bytes,
                )
                .unwrap(),
            );

            let mut capabilities = Vec::new();
            capabilities.push(Capability {
                granted: true,
                inner: WitCapability {
                    kind: CapabilityKind::HandleEvent(EventKind::Connect),
                    scope: CapabilityScope {
                        expression: "true".into(),
                    },
                },
                cel: None,
            });
            capabilities.push(Capability {
                granted: true,
                inner: WitCapability {
                    kind: CapabilityKind::HandleEvent(EventKind::Request),
                    scope: CapabilityScope {
                        expression: "true".into(),
                    },
                },
                cel: None,
        });

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
                capabilities,
                metadata: std::collections::HashMap::new(),
                component,
            };
            registry.register_plugin(plugin).await?;
        }

        // Verify both plugins are registered
        assert_eq!(registry.plugins().len(), 2);
        assert!(registry.plugins().contains_key("ns1/common_plugin"));
        assert!(registry.plugins().contains_key("ns2/common_plugin"));

        // Remove all plugins with name "common_plugin" regardless of namespace
        let removed = registry.remove_plugin("common_plugin", None).await?;

        // Verify both plugins were removed
        assert_eq!(removed.len(), 2);
        assert!(removed.contains(&"ns1/common_plugin".to_string()));
        assert!(removed.contains(&"ns2/common_plugin".to_string()));
        assert_eq!(registry.plugins().len(), 0);
        Ok(())
    }

    #[tokio::test]
    async fn test_remove_nonexistent_plugin() -> Result<(), anyhow::Error> {
        let (mut registry, _temp_dir) = create_plugin_registry().await?;

        // Try to remove a plugin that doesn't exist
        let removed = registry
            .remove_plugin("nonexistent_plugin", Some("test"))
            .await?;

        // Verify nothing was removed
        assert_eq!(removed.len(), 0);
        assert_eq!(registry.plugins().len(), 0);
        Ok(())
    }
}
