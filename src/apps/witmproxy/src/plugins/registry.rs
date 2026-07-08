use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::Result;
use cel_cxx::Env;
use tracing::{debug, info, warn};
use wasmtime::Store;
use wasmtime::component::Resource;
use wasmtime_wasi_http::p3::{Request as WasiRequest, WasiHttpView};

use crate::{
    db::{Db, Insert},
    events::{Event, connect::Connect, content::InboundContent, response::ContextualResponse},
    plugins::WitmPlugin,
    wasm::{
        CapabilityProvider, Host, LocalStorageClient, PluginLimits, Runtime,
        bindgen::{
            Plugin, UserInput,
            witmproxy::plugin::capabilities::{
                ContextualResponse as WasiContextualResponse, Event as WasmEvent, EventKind,
                RequestContext, TimerContext,
            },
        },
    },
};

pub struct PluginRegistry {
    plugins: HashMap<String, WitmPlugin>,
    pub db: Db,
    pub runtime: Runtime,
    env: &'static Env<'static>,
    /// One persistent local-storage client per plugin id, so `set` survives
    /// across events (a fresh `Store` is created per event for isolation).
    /// Guarded by a `Mutex` for lazy get-or-create behind a shared `&self`.
    local_storage: Mutex<HashMap<String, LocalStorageClient>>,
}

impl WasmEvent {
    pub fn register<'a>(env: cel_cxx::EnvBuilder<'a>) -> Result<cel_cxx::EnvBuilder<'a>> {
        // TODO: do this better
        let env = WasiRequest::register_cel_env(env)?;
        let env = ContextualResponse::register_cel_env(env)?;
        let env = InboundContent::register_cel_env(env)?;
        let env = Connect::register_cel_env(env)?;
        let env = crate::events::timer::TimerEvent::register_cel_env(env)?;
        let env = crate::plugins::cel::CelTime::register_cel_env(env)?;
        Ok(env)
    }
}

/// Signals how the plugin chain should proceed after one plugin runs.
enum GuestStep {
    /// Continue the chain with this event (guest-produced or recovered).
    Next(Box<dyn Event>),
    /// A timer plugin returned None (side-effect only); stop the chain.
    StopTimer,
}

/// A lightweight snapshot of the in-flight event, captured BEFORE handing it to
/// the guest, so the *unmodified* event can be rebuilt from the store if the
/// guest fails (fail-open recovery). Holds only resource reps + non-resource
/// aux data.
enum EventRecovery {
    Request(u32),
    Response { rep: u32, request: RequestContext },
    InboundContent(u32),
    Timer(u64),
}

impl EventRecovery {
    fn capture(ev: &WasmEvent) -> Self {
        match ev {
            WasmEvent::Request(r) => EventRecovery::Request(r.rep()),
            WasmEvent::Response(r) => EventRecovery::Response {
                rep: r.response.rep(),
                request: r.request.clone(),
            },
            WasmEvent::InboundContent(c) => EventRecovery::InboundContent(c.rep()),
            WasmEvent::Timer(ctx) => EventRecovery::Timer(ctx.timestamp),
        }
    }

    fn rebuild(self, store: &mut Store<Host>) -> Result<Box<dyn Event>> {
        let ev = match self {
            EventRecovery::Request(rep) => WasmEvent::Request(Resource::new_own(rep)),
            EventRecovery::Response { rep, request } => {
                WasmEvent::Response(WasiContextualResponse {
                    request,
                    response: Resource::new_own(rep),
                })
            }
            EventRecovery::InboundContent(rep) => {
                WasmEvent::InboundContent(Resource::new_own(rep))
            }
            EventRecovery::Timer(ts) => WasmEvent::Timer(TimerContext { timestamp: ts }),
        };
        PluginRegistry::wasm_event_into_boxed(store, ev)
    }
}

impl PluginRegistry {
    pub fn new(db: Db, runtime: Runtime) -> Result<Self> {
        let env = WasmEvent::register(Env::builder().with_standard(true))?.build()?;
        // Leak the env to get a static reference since it contains only static data
        // and we want it to live for the program duration
        // TODO: fix this with proper lifetime management
        let env: &'static Env<'static> = Box::leak(Box::new(env));
        Ok(Self {
            plugins: HashMap::new(),
            db,
            runtime,
            env,
            local_storage: Mutex::new(HashMap::new()),
        })
    }

    /// Set the per-plugin resource limits enforced during guest execution.
    /// A value of `0` for any limit disables that dimension (unlimited).
    pub fn set_limits(&mut self, max_fuel: u64, max_memory_mb: u64, timeout_ms: u64) {
        self.runtime.limits = PluginLimits {
            max_fuel,
            max_memory_mb,
            timeout_ms,
        };
    }

    /// Get (or lazily create) the persistent local-storage client for a plugin.
    fn local_storage_for(&self, plugin_id: &str) -> LocalStorageClient {
        let mut map = self
            .local_storage
            .lock()
            .expect("local_storage mutex poisoned");
        map.entry(plugin_id.to_string())
            .or_insert_with(LocalStorageClient::new)
            .clone()
    }

    pub fn plugins(&self) -> &HashMap<String, WitmPlugin> {
        &self.plugins
    }

    pub fn plugins_mut(&mut self) -> &mut HashMap<String, WitmPlugin> {
        &mut self.plugins
    }

    pub async fn load_plugins(&mut self) -> Result<()> {
        let plugins = WitmPlugin::all(&mut self.db, &self.runtime.engine, self.env).await?;
        for plugin in plugins.into_iter() {
            self.plugins.insert(plugin.id(), plugin);
        }
        Ok(())
    }

    pub async fn plugin_from_component(&self, component_bytes: Vec<u8>) -> Result<WitmPlugin> {
        self.plugin_from_component_with_key(component_bytes, None)
            .await
    }

    /// Load and verify a plugin from WASM bytes.
    ///
    /// If `expected_public_key` is provided, the plugin's embedded public key
    /// must match it exactly — this lets callers pin trust to a known author
    /// rather than accepting any self-signed component.
    pub async fn plugin_from_component_with_key(
        &self,
        component_bytes: Vec<u8>,
        expected_public_key: Option<&[u8]>,
    ) -> Result<WitmPlugin> {
        let component =
            wasmtime::component::Component::from_binary(&self.runtime.engine, &component_bytes)?;
        let (plugin_instance, mut store) =
            self.runtime.instantiate_plugin_component(&component).await?;
        let guest_result = store
            .run_concurrent(async move |store| {
                let manifest = match plugin_instance
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

                Ok(manifest)
            })
            .await??;

        // Verify the WASM component signature using wasmsign2
        let public_key_bytes = &guest_result.publickey;
        if !public_key_bytes.is_empty() {
            // If the caller provided an expected public key, verify it matches
            if let Some(expected) = expected_public_key
                && public_key_bytes != expected
            {
                anyhow::bail!(
                    "Plugin '{}' public key does not match the expected key.\n  \
                     expected: {}\n  \
                     got:      {}",
                    guest_result.name,
                    hex::encode(expected),
                    hex::encode(public_key_bytes),
                );
            }

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
        self.runtime.new_store()
    }

    /// Run one plugin's `create` + `handle` against `store`, enforcing the
    /// configured fuel/timeout limits and FAILING OPEN: on any create/handle
    /// error, fuel/memory exhaustion, or timeout the plugin is skipped and the
    /// (unmodified) event continues down the chain.
    #[allow(clippy::too_many_arguments)]
    async fn run_plugin_in_store(
        &self,
        plugin_id: &str,
        plugin_instance: Plugin,
        mut store: Store<Host>,
        event_data: WasmEvent,
        cap_resource: Resource<CapabilityProvider>,
        config: Vec<UserInput>,
        kind: EventKind,
    ) -> Result<(GuestStep, Store<Host>)> {
        // Apply the per-call fuel budget (the memory cap, if any, is already
        // installed on the store). A `0` limit means unbounded.
        self.runtime.apply_call_limits(&mut store);
        let timeout_ms = self.runtime.limits.timeout_ms;

        // Snapshot enough to rebuild the *unmodified* event from the store if the
        // guest fails, so the chain can continue (fail open).
        let recovery = EventRecovery::capture(&event_data);

        let guest = store.run_concurrent(async move |store| {
            // Create the plugin resource with the user-supplied configuration.
            let plugin_resource = match plugin_instance
                .witmproxy_plugin_witm_plugin()
                .plugin()
                .call_create(store, config)
                .await?
            {
                Ok(resource) => resource,
                Err(e) => {
                    // A configure error is a plugin-level failure: surface it as
                    // an error so the caller fails open. (Previously this
                    // silently returned None and aborted the whole request.)
                    return Err(anyhow::anyhow!(
                        "plugin create returned configure error: {e:?}"
                    ));
                }
            };

            // Handle the event using the plugin resource.
            let result = plugin_instance
                .witmproxy_plugin_witm_plugin()
                .plugin()
                .call_handle(store, plugin_resource, event_data, cap_resource)
                .await?;
            Ok::<Option<WasmEvent>, anyhow::Error>(result)
        });

        // Enforce the wall-clock timeout (`0` == no timeout).
        let outcome: Result<Option<WasmEvent>> = if timeout_ms > 0 {
            match tokio::time::timeout(Duration::from_millis(timeout_ms), guest).await {
                Ok(Ok(inner)) => inner,
                Ok(Err(e)) => Err(e.into()),
                Err(_elapsed) => Err(anyhow::anyhow!(
                    "plugin execution exceeded timeout of {timeout_ms}ms"
                )),
            }
        } else {
            match guest.await {
                Ok(inner) => inner,
                Err(e) => Err(e.into()),
            }
        };

        match outcome {
            Ok(Some(new_event_data)) => {
                let event = Self::wasm_event_into_boxed(&mut store, new_event_data)?;
                Ok((GuestStep::Next(event), store))
            }
            // Timer events may legitimately return None (side-effect only).
            Ok(None) if kind == EventKind::Timer => Ok((GuestStep::StopTimer, store)),
            Ok(None) => {
                warn!(
                    target: "plugins",
                    plugin_id = %plugin_id,
                    event_kind = kind.to_string(),
                    "Plugin returned no event data; failing open and continuing with the unmodified event"
                );
                let event = recovery.rebuild(&mut store)?;
                Ok((GuestStep::Next(event), store))
            }
            Err(e) => {
                warn!(
                    target: "plugins",
                    plugin_id = %plugin_id,
                    event_kind = kind.to_string(),
                    error = %e,
                    "Plugin execution failed (error/limit/timeout); failing open and continuing with the unmodified event"
                );
                let event = recovery.rebuild(&mut store)?;
                Ok((GuestStep::Next(event), store))
            }
        }
    }

    /// Extract a returned guest [`WasmEvent`] back into an owned, store-independent
    /// [`Event`] for the next iteration of the plugin chain.
    fn wasm_event_into_boxed(store: &mut Store<Host>, ev: WasmEvent) -> Result<Box<dyn Event>> {
        Ok(match ev {
            WasmEvent::Request(r) => {
                let req = store.data_mut().http().table.delete(r)?;
                Box::new(req)
            }
            WasmEvent::Response(r) => {
                let response = store.data_mut().http().table.delete(r.response)?;
                Box::new(ContextualResponse {
                    request: r.request,
                    response,
                })
            }
            WasmEvent::InboundContent(c) => {
                let content = store.data_mut().table.delete(c)?;
                Box::new(content)
            }
            WasmEvent::Timer(ctx) => Box::new(crate::events::timer::TimerEvent {
                timestamp: ctx.timestamp,
            }),
        })
    }

    pub fn find_first_unexecuted_plugin(
        &self,
        event: &dyn Event,
        executed_plugins: &HashSet<String>,
    ) -> Option<&WitmPlugin> {
        self.plugins
            .values()
            .find(|p| !executed_plugins.contains(&p.id()) && p.can_handle(event))
    }

    /// Find first unexecuted plugin from a pre-filtered effective set.
    fn find_first_unexecuted_in_set<'a>(
        &'a self,
        event: &dyn Event,
        executed_plugins: &HashSet<String>,
        effective_set: &HashSet<String>,
    ) -> Option<&'a WitmPlugin> {
        self.plugins.values().find(|p| {
            effective_set.contains(&p.id())
                && !executed_plugins.contains(&p.id())
                && p.can_handle(event)
        })
    }

    /// Check if any plugins can handle an event
    pub fn can_handle(&self, event: &dyn Event) -> bool {
        self.plugins.values().any(|p| p.can_handle(event))
    }

    /// Returns the set of plugin IDs that are effective for a given tenant.
    /// Applies per-tenant enable/disable overrides on top of global enabled state.
    pub fn effective_plugins_for_tenant(
        &self,
        overrides: &[crate::db::tenants::TenantPluginOverride],
    ) -> HashSet<String> {
        let mut effective = HashSet::new();
        for (id, plugin) in &self.plugins {
            let mut enabled = plugin.enabled;
            // Check for tenant-specific override
            for ov in overrides {
                if ov.plugin_namespace == plugin.namespace
                    && ov.plugin_name == plugin.name
                    && let Some(ov_enabled) = ov.enabled
                {
                    enabled = ov_enabled;
                }
            }
            if enabled {
                effective.insert(id.clone());
            }
        }
        effective
    }

    /// Resolve configuration for a plugin, merging tenant-specific config over global defaults.
    /// Tenant config values are stored as JSON strings in the database.
    pub fn resolve_config(
        &self,
        plugin: &WitmPlugin,
        tenant_config: &[crate::db::tenants::TenantPluginConfig],
    ) -> Vec<UserInput> {
        use crate::wasm::bindgen::exports::witmproxy::plugin::witm_plugin::ActualInput;

        let mut config = plugin.configuration.clone();
        for tc in tenant_config {
            if tc.plugin_namespace == plugin.namespace && tc.plugin_name == plugin.name {
                // Try to deserialize the JSON value into ActualInput
                let value = match serde_json::from_str::<ActualInput>(&tc.input_value) {
                    Ok(v) => v,
                    Err(e) => {
                        warn!(
                            "Failed to deserialize tenant config value for {}/{} input '{}': {}. Falling back to string.",
                            tc.plugin_namespace, tc.plugin_name, tc.input_name, e
                        );
                        ActualInput::Str(tc.input_value.clone())
                    }
                };

                if let Some(existing) = config.iter_mut().find(|c| c.name == tc.input_name) {
                    existing.value = value;
                } else {
                    config.push(UserInput {
                        name: tc.input_name.clone(),
                        value,
                    });
                }
            }
        }
        config
    }

    /// Handle a generic event, passing it through all registered plugins, and returning the final [Event] (whose inner contents implement [Event]) and [Store] (for resolving any resource handles on the host side)
    /// Validates that the final [Event] matches the expected output type for its event kind, returning an error if not
    #[tracing::instrument(skip(self, event), fields(event_kind = ?event.kind()))]
    pub async fn handle_event(&self, event: Box<dyn Event>) -> Result<(WasmEvent, Store<Host>)> {
        let any_plugins = self.plugins.values().any(|p| p.can_handle(&*event));
        if !any_plugins {
            debug!(
                "No plugins with matching capability and scope; skipping plugin processing for event of kind: {:?}",
                event.kind()
            );
            let mut store = self.new_store();
            let event_data = event.into_event_data(&mut store)?;
            return Ok((event_data, store));
        }

        debug!(
            "Found plugins with matching capability and scope; processing event of kind: {:?} through plugin chain",
            event.kind()
        );

        let mut current_event = event;
        let mut store = self.new_store();
        let mut executed_plugins = HashSet::new();

        while let Some(plugin) =
            { self.find_first_unexecuted_plugin(&*current_event, &executed_plugins) }
        {
            tracing::info!(
                plugin.id = %plugin.id(),
                plugin.namespace = %plugin.namespace,
                plugin.name = %plugin.name,
                plugin.version = %plugin.version,
                "Executing plugin"
            );

            let plugin_id = plugin.id();
            executed_plugins.insert(plugin_id.clone());
            let kind = current_event.kind();
            let component = if let Some(c) = &plugin.component {
                c
            } else {
                warn!(
                    target: "plugins",
                    plugin_id = %plugin.id(),
                    event_kind = kind.to_string(),
                    "Plugin component missing; skipping"
                );
                continue;
            };

            let (plugin_instance, component_store) =
                match self.runtime.instantiate_plugin_component(component).await {
                    Ok(pi) => pi,
                    Err(e) => {
                        warn!(
                            target: "plugins",
                            plugin_id = %plugin.id(),
                            event_kind = kind.to_string(),
                            error = %e,
                            "Failed to instantiate plugin component; skipping"
                        );
                        continue;
                    }
                };

            store = component_store;
            let event_data = current_event.into_event_data(&mut store)?;

            // Build the capability provider, handing the plugin its PERSISTENT
            // local-storage client so writes survive across events.
            let provider = CapabilityProvider::build(
                &plugin.capabilities,
                Some(self.local_storage_for(&plugin_id)),
            );
            let cap_resource = store.data_mut().table.push(provider)?;
            let config = plugin.configuration.clone();

            let (step, next_store) = self
                .run_plugin_in_store(
                    &plugin_id,
                    plugin_instance,
                    store,
                    event_data,
                    cap_resource,
                    config,
                    kind,
                )
                .await?;
            store = next_store;
            match step {
                GuestStep::Next(event) => current_event = event,
                GuestStep::StopTimer => {
                    debug!("Timer plugin returned None; stopping timer chain");
                    let timer_event = crate::events::timer::TimerEvent::now();
                    let event_data = Box::new(timer_event).into_event_data(&mut store)?;
                    return Ok((event_data, store));
                }
            }
        }

        let kind = current_event.kind();
        let event_data = current_event.into_event_data(&mut store)?;
        kind.validate_output(&event_data)?;
        Ok((event_data, store))
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::{create_plugin_registry, test_component_path};
    use crate::wasm::bindgen::witmproxy::plugin::capabilities::{
        CapabilityKind, CapabilityScope, EventKind,
    };
    use crate::{
        plugins::{WitmPlugin, capabilities::Capability},
        wasm::bindgen::witmproxy::plugin::capabilities::Capability as WitCapability,
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

        let capabilities = vec![
            Capability {
                granted: true,
                inner: WitCapability {
                    kind: CapabilityKind::HandleEvent(EventKind::Connect),
                    scope: CapabilityScope {
                        expression: cel_expression.into(),
                    },
                },
                cel: None,
            },
            Capability {
                granted: true,
                inner: WitCapability {
                    kind: CapabilityKind::HandleEvent(EventKind::Request),
                    scope: CapabilityScope {
                        expression: cel_expression.into(),
                    },
                },
                cel: None,
            },
            Capability {
                granted: true,
                inner: WitCapability {
                    kind: CapabilityKind::HandleEvent(EventKind::Response),
                    scope: CapabilityScope {
                        expression: cel_expression.into(),
                    },
                },
                cel: None,
            },
        ];

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
            configuration: vec![],
            metadata: std::collections::HashMap::new(),
            component,
        }
        .compile_capability_scope_expressions(registry.env)?;
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
        let event: Box<dyn Event> = Box::new(wasi_req);
        let matching_plugin = registry.find_first_unexecuted_plugin(&*event, &executed_plugins);
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
        let event: Box<dyn Event> = Box::new(wasi_req);
        let matching_plugin = registry.find_first_unexecuted_plugin(&*event, &executed_plugins);
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
        let event: Box<dyn Event> = Box::new(wasi_req);
        let matching_plugin = registry.find_first_unexecuted_plugin(&*event, &executed_plugins);
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
        let event: Box<dyn Event> = Box::new(wasi_req);
        let matching_plugin = registry.find_first_unexecuted_plugin(&*event, &executed_plugins);
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
        let event: Box<dyn Event> = Box::new(wasi_req);
        let matching_plugin = registry.find_first_unexecuted_plugin(&*event, &executed_plugins);
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
        let event: Box<dyn Event> = Box::new(wasi_req);
        let matching_plugin = registry.find_first_unexecuted_plugin(&*event, &executed_plugins);
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
        let event: Box<dyn Event> = Box::new(wasi_req);
        let matching_plugin = registry.find_first_unexecuted_plugin(&*event, &executed_plugins);
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

        let capabilities = vec![
            Capability {
                granted: true,
                inner: WitCapability {
                    kind: CapabilityKind::HandleEvent(EventKind::Connect),
                    scope: CapabilityScope {
                        expression: "true".into(),
                    },
                },
                cel: None,
            },
            Capability {
                granted: true,
                inner: WitCapability {
                    kind: CapabilityKind::HandleEvent(EventKind::Response),
                    scope: CapabilityScope {
                        expression: "true".to_string(),
                    },
                },
                cel: None,
            },
        ];

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
            configuration: vec![],
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

        let event: Box<dyn Event> = Box::new(wasi_req);
        let matching_plugin = registry.find_first_unexecuted_plugin(&*event, &executed_plugins);
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
        let capabilities = vec![
            Capability {
                granted: true,
                inner: WitCapability {
                    kind: CapabilityKind::HandleEvent(EventKind::Connect),
                    scope: CapabilityScope {
                        expression: "true".into(),
                    },
                },
                cel: None,
            },
            Capability {
                granted: true,
                inner: WitCapability {
                    kind: CapabilityKind::HandleEvent(EventKind::Request),
                    scope: CapabilityScope {
                        expression: "true".to_string(),
                    },
                },
                cel: None,
            },
            Capability {
                granted: true,
                inner: WitCapability {
                    kind: CapabilityKind::HandleEvent(EventKind::Response),
                    scope: CapabilityScope {
                        expression: "true".to_string(),
                    },
                },
                cel: None,
            },
        ];

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
            configuration: vec![],
            metadata: std::collections::HashMap::new(),
            component,
        }
        .compile_capability_scope_expressions(registry.env)?;
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
        let event: Box<dyn Event> = Box::new(wasi_req);
        let first_plugin = registry.find_first_unexecuted_plugin(&*event, &executed_plugins);
        assert!(
            first_plugin.is_some(),
            "Should find a plugin when none are executed"
        );

        // Add the first plugin to executed set
        executed_plugins.insert(first_plugin.unwrap().id());

        // Second call should return a different plugin (if there are multiple)
        let second_plugin = registry.find_first_unexecuted_plugin(&*event, &executed_plugins);
        if let Some(second_plugin) = second_plugin {
            assert_ne!(
                first_plugin.unwrap().id(),
                second_plugin.id(),
                "Should return a different plugin"
            );

            // Add the second plugin to executed set
            executed_plugins.insert(second_plugin.id());

            // Third call should return None since all plugins are executed
            let third_plugin = registry.find_first_unexecuted_plugin(&*event, &executed_plugins);
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

            let capabilities = vec![
                Capability {
                    granted: true,
                    inner: WitCapability {
                        kind: CapabilityKind::HandleEvent(EventKind::Connect),
                        scope: CapabilityScope {
                            expression: "true".into(),
                        },
                    },
                    cel: None,
                },
                Capability {
                    granted: true,
                    inner: WitCapability {
                        kind: CapabilityKind::HandleEvent(EventKind::Request),
                        scope: CapabilityScope {
                            expression: "true".into(),
                        },
                    },
                    cel: None,
                },
            ];

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
                configuration: vec![],
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
