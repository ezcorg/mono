//! Serve a wasmtime **component's exports** over wRPC — resources and all.
//!
//! Unlike [`provider`](crate::provider) (a hand-written `wit-bindgen-wrpc` server
//! for the flat `fs` interface), this drives `wrpc-wasmtime`'s generic
//! [`ServeExt::serve_function_shared`]: it introspects the component type and
//! wires *every* exported function to wRPC, bridging guest-exported resources
//! (e.g. a `wasi:filesystem` descriptor) through a [`SharedResourceTable`] and
//! `wasi:io` streams to native wRPC streams. The component is instantiated **once**
//! into a shared `Store`, so resource handles persist across calls.
//!
//! This is the serving path for real `wasi:filesystem@0.2`. It's proven first on
//! the tiny `counter` component (a 3-method resource), then reused for the
//! filesystem passthrough.
//!
//! Modeled on `wrpc-wasmtime-cli`'s `serve_shared`.

use core::future::Future;
use core::ops::Bound;
use core::pin::{pin, Pin};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use anyhow::Context as _;
use bytes::Bytes;
use futures::StreamExt as _;
use tokio::sync::Mutex;
use tokio::task::JoinSet;
use uuid::Uuid;
use wasmtime::component::{types, Component, Func, Instance, Linker, ResourceTable, ResourceType};
use wasmtime::{Engine, Store};

use crate::broker::GrantStore;
use crate::components::ComponentStore;
use crate::AsOrigin;
use wasmtime_wasi::p2::bindings::io;
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};
use wrpc_transport::{Invoke, Serve, ServeExt as _}; // ServeExt: serve_values (the drop meta-op)
use wrpc_wasmtime::{
    collect_component_resource_exports, collect_component_resource_imports, RemoteResource,
    ServeExt as _, SharedResourceTable, WrpcCtxView, WrpcView,
}; // ServeExt: serve_function_shared (component exports)

/// Per-invocation wRPC state. `client` satisfies *polyfilled* imports (imports a
/// component makes that are themselves served over wRPC); our components import
/// only host-satisfied WASI, so it is never invoked — but the type is required.
/// `shared` is the table that maps wRPC resource handles (UUIDs) ⇄ the live
/// `ResourceAny` the component exported.
struct Rpc<C: Invoke> {
    client: C,
    cx: C::Context,
    shared: SharedResourceTable,
}

impl<C: Invoke> wrpc_wasmtime::WrpcCtx<C> for Rpc<C>
where
    C::Context: Clone,
{
    fn context(&self) -> C::Context {
        self.cx.clone()
    }
    fn client(&self) -> &C {
        &self.client
    }
    fn shared_resources(&mut self) -> &mut SharedResourceTable {
        &mut self.shared
    }
}

/// Store state for serving a component: a `WasiCtx` (its host-satisfied imports,
/// incl. the preopened filesystem the grant scopes) plus the wRPC view.
pub struct CompState<C: Invoke> {
    table: ResourceTable,
    wasi: WasiCtx,
    rpc: Rpc<C>,
}

impl<C: Invoke> WasiView for CompState<C> {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl<C: Invoke> WrpcView for CompState<C>
where
    C::Context: Clone,
{
    type Invoke = C;
    fn wrpc(&mut self) -> WrpcCtxView<'_, C> {
        WrpcCtxView {
            ctx: &mut self.rpc,
            table: &mut self.table,
        }
    }
}

/// The wasi:io resource types of an instance, by interface-version range + name
/// (e.g. `input-stream` across all `wasi:io/streams@0.2.x`).
fn io_resources(
    m: &BTreeMap<Box<str>, HashMap<Box<str>, ResourceType>>,
    lo: &str,
    hi: &str,
    res: &str,
) -> Vec<ResourceType> {
    m.range::<str, _>((Bound::Included(lo), Bound::Excluded(hi)))
        .flat_map(|(_, inst)| inst.get(res))
        .copied()
        .collect()
}

/// Map each imported resource type to the host type the wRPC bridge backs it
/// with: real `wasi:io` host types for streams/errors/pollables, an opaque
/// [`RemoteResource`] otherwise. (Copied from `wrpc-wasmtime-cli`.)
fn map_host_resources(
    imports: BTreeMap<Box<str>, HashMap<Box<str>, ResourceType>>,
) -> Arc<HashMap<Box<str>, HashMap<Box<str>, (ResourceType, ResourceType)>>> {
    let io_err = io_resources(&imports, "wasi:io/error@0.2", "wasi:io/error@0.3", "error");
    let io_pollable = io_resources(&imports, "wasi:io/poll@0.2", "wasi:io/poll@0.3", "pollable");
    let io_in = io_resources(
        &imports,
        "wasi:io/streams@0.2",
        "wasi:io/streams@0.3",
        "input-stream",
    );
    let io_out = io_resources(
        &imports,
        "wasi:io/streams@0.2",
        "wasi:io/streams@0.3",
        "output-stream",
    );
    let mapped = imports
        .into_iter()
        .map(|(name, inst)| {
            let inst = inst
                .into_iter()
                .map(|(n, ty)| {
                    let host_ty = if io_err.contains(&ty) {
                        ResourceType::host::<io::error::Error>()
                    } else if io_in.contains(&ty) {
                        ResourceType::host::<io::streams::InputStream>()
                    } else if io_out.contains(&ty) {
                        ResourceType::host::<io::streams::OutputStream>()
                    } else if io_pollable.contains(&ty) {
                        ResourceType::host::<io::poll::Pollable>()
                    } else {
                        ResourceType::host::<RemoteResource>()
                    };
                    (n, (ty, host_ty))
                })
                .collect();
            (name, inst)
        })
        .collect();
    Arc::new(mapped)
}

/// A wasmtime engine configured for async component instantiation.
fn engine() -> anyhow::Result<Engine> {
    let mut config = wasmtime::Config::new();
    config.wasm_component_model(true);
    Engine::new(&config).map_err(anyhow::Error::from)
}

/// Compile + link `component_bytes`, instantiate once into a shared store with
/// `wasi` as the host state, and register every exported function on `srv`.
/// Returns a [`JoinSet`] draining the invocation streams — keep it alive to keep
/// serving. `client`/`cx` satisfy polyfilled imports (unused for WASI-only
/// components).
pub async fn serve_component<C, S>(
    srv: &S,
    component_bytes: &[u8],
    client: C,
    cx: C::Context,
    wasi: WasiCtx,
) -> anyhow::Result<JoinSet<()>>
where
    C: Invoke + 'static,
    C::Context: Clone,
    S: Serve,
{
    let engine = engine()?;
    let component = Component::new(&engine, component_bytes)
        .map_err(anyhow::Error::from)
        .context("compile component")?;
    let mut linker = Linker::<CompState<C>>::new(&engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)
        .map_err(anyhow::Error::from)
        .context("link WASI")?;

    let ty = component.component_type();
    let mut imports = BTreeMap::default();
    let mut guest_resources = Vec::new();
    collect_component_resource_imports(&engine, &ty, &mut imports);
    collect_component_resource_exports(&engine, &ty, &mut guest_resources);
    let host_resources = map_host_resources(imports);
    let guest_resources: Arc<[ResourceType]> = Arc::from(guest_resources);

    let pre = linker
        .instantiate_pre(&component)
        .map_err(anyhow::Error::from)
        .context("pre-instantiate component")?;
    let mut store = Store::new(
        &engine,
        CompState {
            table: ResourceTable::new(),
            wasi,
            rpc: Rpc {
                client,
                cx,
                shared: SharedResourceTable::default(),
            },
        },
    );
    let instance = pre
        .instantiate_async(&mut store)
        .await
        .map_err(anyhow::Error::from)
        .context("instantiate component")?;
    let io_streams: Arc<[ResourceType]> =
        wrpc_wasmtime::paths::wasi_io_stream_resources(&engine, &component.component_type()).into();
    let store = Arc::new(Mutex::new(store));
    drive_exports(
        srv,
        store,
        instance,
        &component.component_type(),
        &engine,
        guest_resources,
        host_resources,
        io_streams,
    )
    .await
}

/// Register every exported function of `instance` on `srv` (spawning a drain task
/// per function) and return the `JoinSet` of those tasks. Shared by the generic
/// [`serve_component`] and the gated [`serve_filesystem`].
async fn drive_exports<T, S>(
    srv: &S,
    store: Arc<Mutex<Store<T>>>,
    instance: Instance,
    component_ty: &types::Component,
    engine: &Engine,
    guest_resources: Arc<[ResourceType]>,
    host_resources: Arc<HashMap<Box<str>, HashMap<Box<str>, (ResourceType, ResourceType)>>>,
    io_streams: Arc<[ResourceType]>,
) -> anyhow::Result<JoinSet<()>>
where
    T: WasiView + WrpcView + 'static,
    S: Serve,
{
    let mut handlers = JoinSet::new();
    // Each exported interface is a `ComponentInstance`; serve each of its functions.
    for (instance_name, types::ComponentExtern { ty: item, .. }) in component_ty.exports(engine) {
        let types::ComponentItem::ComponentInstance(inst_ty) = item else {
            continue;
        };
        for (name, types::ComponentExtern { ty: fitem, .. }) in inst_ty.exports(engine) {
            let types::ComponentItem::ComponentFunc(func_ty) = fitem else {
                continue;
            };
            let invocations = srv
                .serve_function_shared(
                    Arc::clone(&store),
                    instance,
                    Arc::clone(&guest_resources),
                    Arc::clone(&host_resources),
                    Arc::clone(&io_streams),
                    func_ty,
                    instance_name,
                    name,
                )
                .await
                .with_context(|| format!("failed to serve `{instance_name}#{name}`"))?;
            handlers.spawn(async move {
                let mut invocations = pin!(invocations);
                while let Some(inv) = invocations.next().await {
                    match inv {
                        Ok((_cx, fut)) => {
                            if let Err(err) = fut.await {
                                let chain: Vec<String> =
                                    err.chain().map(|e| e.to_string()).collect();
                                tracing::warn!("invocation failed: {}", chain.join(" <- "));
                            }
                        }
                        Err(err) => tracing::warn!(?err, "failed to accept invocation"),
                    }
                }
            });
        }
    }
    Ok(handlers)
}

/// Store state for the **gated** filesystem serving: like [`CompState`] plus the
/// grant store the consent `gate` host import validates against.
pub struct FsState<C: Invoke> {
    table: ResourceTable,
    wasi: WasiCtx,
    rpc: Rpc<C>,
    grants: Arc<std::sync::Mutex<GrantStore>>,
}

impl<C: Invoke> WasiView for FsState<C> {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl<C: Invoke> WrpcView for FsState<C>
where
    C::Context: Clone,
{
    type Invoke = C;
    fn wrpc(&mut self) -> WrpcCtxView<'_, C> {
        WrpcCtxView {
            ctx: &mut self.rpc,
            table: &mut self.table,
        }
    }
}

/// Max live `wasi:filesystem` handles the fs component holds before refusing new ones
/// — a backstop against a client that opens descriptors without dropping them (this
/// wRPC build doesn't relay handle-drops). Exhaustion surfaces as an op error, not an
/// OOM. Override with `ICANHAZ_MAX_FS_HANDLES` (0 = unbounded).
fn max_fs_handles() -> usize {
    std::env::var("ICANHAZ_MAX_FS_HANDLES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4096)
}

/// Where the bytes of a grant's filesystem chain come from: given the chain's
/// component ids (outermost first) it composes them in front of the shipped
/// passthrough and returns the composition (see `components::filesystem_chain`).
pub type ChainSource = Arc<
    dyn Fn(Vec<String>) -> Pin<Box<dyn Future<Output = anyhow::Result<Vec<u8>>> + Send>>
        + Send
        + Sync,
>;

/// A fresh WASI context for one chain's store: the preopened root (the jail).
/// Each chain gets its own, built from the same recipe.
pub type WasiRecipe = Arc<dyn Fn() -> anyhow::Result<WasiCtx> + Send + Sync>;

/// One instantiated chain: its own store (so its own lock, host tables,
/// limits and lifetime), the resource types it exports, its exports.
struct Chain<C: Invoke + 'static> {
    id: u64,
    /// The chain's component ids joined by `,`; empty for the default chain.
    key: String,
    store: Mutex<Store<FsState<C>>>,
    /// The resource types this chain's instance exports, in both identities
    /// (declared by the component type, minted by the live instance).
    resources: Vec<ResourceType>,
    /// Its exported functions by `(interface, function)`.
    funcs: HashMap<(Box<str>, Box<str>), Func>,
    /// The live grants mounted on this chain. When the last ends (revoked or
    /// expired) the chain is dropped, store and all; the default chain stays.
    grants: std::sync::Mutex<HashSet<String>>,
}

impl<C: Invoke + 'static> Chain<C> {
    fn func(&self, iface: &str, name: &str) -> anyhow::Result<Func> {
        self.funcs
            .get(&(Box::from(iface), Box::from(name)))
            .copied()
            .with_context(|| format!("chain [{}] does not export `{iface}#{name}`", self.key))
    }
}

/// Is `(interface, function)` a call whose first argument is a grant token?
pub type TokenCalls = Arc<dyn Fn(&str, &str) -> bool + Send + Sync>;
/// Given `(interface, function, token)`, the chain the call runs on (component
/// ids, outermost first; empty for the default), after whatever validation
/// and admission the kind requires.
pub type ResolveToken = Arc<dyn Fn(&str, &str, &str) -> anyhow::Result<Vec<String>> + Send + Sync>;

/// What a [`Router`] routes: the linker its chains instantiate with, where
/// chain bytes come from, which calls carry a token and how a token names a
/// chain.
pub struct RouterSpec<C: Invoke + 'static> {
    pub linker: Linker<FsState<C>>,
    pub source: Option<ChainSource>,
    pub token_calls: TokenCalls,
    pub resolve_token: ResolveToken,
}

/// The chains one served interface set fronts, each in its own store. Calls
/// are routed here before anything is decoded: a method to the chain that
/// minted its handle (a registry from handle to chain, fed by what each store
/// mints), a token-carrying call to the chain the grant names (composed and
/// instantiated on first use, outside every store's lock), anything else to
/// the default chain when there is one. A chain lives while a live grant
/// names it: each grant mounted on it is watched, and when the last is
/// revoked or expires the chain is dropped.
pub struct Router<C: Invoke + 'static> {
    engine: Engine,
    spec: RouterSpec<C>,
    state: Box<dyn Fn() -> anyhow::Result<FsState<C>> + Send + Sync>,
    grants: Arc<std::sync::Mutex<GrantStore>>,
    chains: std::sync::RwLock<Vec<Arc<Chain<C>>>>,
    next_id: std::sync::atomic::AtomicU64,
    /// Handle → id of the chain whose store holds it.
    handles: std::sync::Mutex<HashMap<Uuid, u64>>,
    /// Every chain's resource types: what the codec checks a declared
    /// parameter or result type against before it reads or mints a handle.
    union: std::sync::Mutex<Arc<[ResourceType]>>,
    /// Serializes chain creation, so two first mounts of one chain build it once.
    building: Mutex<()>,
}

impl<C> Router<C>
where
    C: Invoke + Clone + 'static,
    C::Context: Clone,
{
    /// A router whose chains' stores hold `wasi` (built fresh per chain) and
    /// see `grants` through the gate.
    pub fn new(
        spec: RouterSpec<C>,
        client: C,
        cx: C::Context,
        wasi: WasiRecipe,
        grants: Arc<std::sync::Mutex<GrantStore>>,
    ) -> anyhow::Result<Arc<Self>> {
        let engine = spec.linker.engine().clone();
        let state = {
            let grants = Arc::clone(&grants);
            Box::new(move || {
                Ok(FsState {
                    table: ResourceTable::new(),
                    wasi: wasi()?,
                    rpc: Rpc {
                        client: client.clone(),
                        cx: cx.clone(),
                        shared: SharedResourceTable::with_capacity(max_fs_handles()),
                    },
                    grants: Arc::clone(&grants),
                })
            })
        };
        Ok(Arc::new(Self {
            engine,
            spec,
            state,
            grants,
            chains: std::sync::RwLock::new(Vec::new()),
            next_id: std::sync::atomic::AtomicU64::new(0),
            handles: std::sync::Mutex::new(HashMap::new()),
            union: std::sync::Mutex::new(Arc::from(Vec::new())),
            building: Mutex::new(()),
        }))
    }

    /// The engine this router's chains compile for.
    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    fn union(&self) -> Arc<[ResourceType]> {
        Arc::clone(&self.union.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn chain_by_id(&self, id: u64) -> Option<Arc<Chain<C>>> {
        self.chains
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|c| c.id == id)
            .cloned()
    }

    fn chain_by_key(&self, key: &str) -> Option<Arc<Chain<C>>> {
        self.chains
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|c| c.key == key)
            .cloned()
    }

    /// The default chain (key empty), never dropped, if this router has one.
    fn default_chain(&self) -> Option<Arc<Chain<C>>> {
        self.chain_by_key("")
    }

    /// Instantiate `component` into a fresh store and register it as a chain;
    /// an empty `key` makes it the default.
    async fn add_chain(&self, key: String, component: &Component) -> anyhow::Result<Arc<Chain<C>>> {
        let ty = component.component_type();
        // A resource type has two identities: the one the component type
        // declares (what a function's parameter and result types name) and the
        // one the live instance mints (what a `ResourceAny` reports). The codec
        // checks declared types, so the union carries both.
        let mut resources = Vec::new();
        collect_component_resource_exports(&self.engine, &ty, &mut resources);
        let mut store = Store::new(&self.engine, (self.state)()?);
        let instance = self
            .spec
            .linker
            .instantiate_pre(component)
            .map_err(anyhow::Error::from)?
            .instantiate_async(&mut store)
            .await
            .map_err(anyhow::Error::from)?;
        let mut funcs = HashMap::new();
        for (iface, types::ComponentExtern { ty: item, .. }) in ty.exports(&self.engine) {
            let types::ComponentItem::ComponentInstance(inst_ty) = item else {
                continue;
            };
            let Some(iface_idx) = instance.get_export_index(&mut store, None, iface) else {
                continue;
            };
            for (name, types::ComponentExtern { ty: fitem, .. }) in inst_ty.exports(&self.engine) {
                let Some(idx) = instance.get_export_index(&mut store, Some(&iface_idx), name)
                else {
                    continue;
                };
                match fitem {
                    types::ComponentItem::ComponentFunc(_) => {
                        if let Some(func) = instance.get_func(&mut store, idx) {
                            funcs.insert((Box::from(iface), Box::from(name)), func);
                        }
                    }
                    types::ComponentItem::Resource(_) => {
                        if let Some(live) = instance.get_resource(&mut store, idx) {
                            resources.push(live);
                        }
                    }
                    _ => {}
                }
            }
        }
        let chain = Arc::new(Chain {
            id: self
                .next_id
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            key,
            store: Mutex::new(store),
            resources,
            funcs,
            grants: std::sync::Mutex::new(HashSet::new()),
        });
        let mut chains = self.chains.write().unwrap_or_else(|e| e.into_inner());
        chains.push(Arc::clone(&chain));
        Self::recompute_union(&chains, &self.union);
        Ok(chain)
    }

    fn recompute_union(chains: &[Arc<Chain<C>>], union: &std::sync::Mutex<Arc<[ResourceType]>>) {
        let all: Vec<ResourceType> = chains
            .iter()
            .flat_map(|c| c.resources.iter().copied())
            .collect();
        *union.lock().unwrap_or_else(|e| e.into_inner()) = Arc::from(all);
    }

    /// Count `token` among `chain`'s live grants and watch for its end. Checks
    /// under the chains lock that the chain is still registered, so a mount
    /// cannot land on a chain a concurrent release just dropped: when it did,
    /// the caller mounts again.
    fn track(self: &Arc<Self>, chain: &Arc<Chain<C>>, token: &str) -> bool {
        if chain.key.is_empty() {
            return true;
        }
        let Some(revocation) = self
            .grants
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .revocation(token)
        else {
            // Not a live grant: the gate refuses the call, nothing to watch.
            return true;
        };
        let chains = self.chains.read().unwrap_or_else(|e| e.into_inner());
        if !chains.iter().any(|c| c.id == chain.id) {
            return false;
        }
        let fresh = chain
            .grants
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(token.to_string());
        drop(chains);
        if fresh {
            let router = Arc::downgrade(self);
            let chain_id = chain.id;
            let token = token.to_string();
            tokio::spawn(async move {
                revocation.cancelled().await;
                if let Some(router) = router.upgrade() {
                    router.release(chain_id, &token);
                }
            });
        }
        true
    }

    /// A grant mounted on chain `chain_id` has ended. When it was the last, the
    /// chain goes: out of the registry, its handles forgotten, its store dropped
    /// once no call still holds it. Its descriptors all belonged to grants that
    /// are gone, so nothing live is lost.
    fn release(&self, chain_id: u64, token: &str) {
        let mut chains = self.chains.write().unwrap_or_else(|e| e.into_inner());
        let Some(pos) = chains.iter().position(|c| c.id == chain_id) else {
            return;
        };
        let remaining = {
            let mut grants = chains[pos].grants.lock().unwrap_or_else(|e| e.into_inner());
            grants.remove(token);
            grants.len()
        };
        if remaining > 0 || chains[pos].key.is_empty() {
            return;
        }
        let chain = chains.remove(pos);
        self.handles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, id| *id != chain_id);
        Self::recompute_union(&chains, &self.union);
        tracing::info!(chain = %chain.key, "chain dropped: no live grant names it");
    }

    /// The chain for `via` (outermost first): the default when empty, an
    /// existing one by key, else composed through the source, compiled and
    /// instantiated, all without holding any chain's store.
    async fn chain_for(&self, via: Vec<String>) -> anyhow::Result<Arc<Chain<C>>> {
        let key = via.join(",");
        if let Some(chain) = self.chain_by_key(&key) {
            return Ok(chain);
        }
        if key.is_empty() {
            anyhow::bail!("nothing provides this call: the grant names no chain");
        }
        let _building = self.building.lock().await;
        if let Some(chain) = self.chain_by_key(&key) {
            return Ok(chain);
        }
        let Some(source) = &self.spec.source else {
            anyhow::bail!("the grant names a chain [{key}] but this serving has no chain source");
        };
        let bytes = source(via)
            .await
            .with_context(|| format!("compose chain [{key}]"))?;
        let engine = self.engine.clone();
        let component = tokio::task::spawn_blocking(move || Component::new(&engine, &bytes))
            .await
            .context("compile chain")?
            .map_err(anyhow::Error::from)?;
        let chain = self.add_chain(key.clone(), &component).await?;
        tracing::info!(chain = %key, "chain instantiated");
        Ok(chain)
    }

    /// Route one call before it is decoded, by looking at its first argument
    /// on the wire: a guest resource handle names the chain that minted it; a
    /// token names the grant, whose chain the spec resolves.
    async fn route(
        self: &Arc<Self>,
        iface: &str,
        name: &str,
        params_ty: &[types::Type],
        rx: &mut wrpc_transport::frame::Incoming,
    ) -> anyhow::Result<Arc<Chain<C>>> {
        match params_ty.first() {
            Some(types::Type::Own(ty) | types::Type::Borrow(ty)) if self.union().contains(ty) => {
                // `own`/`borrow` of a guest resource: a 16-byte handle, length-prefixed.
                let head = rx.peek(17).await.context("peek resource handle")?;
                anyhow::ensure!(head[0] == 16, "resource handle is not 16 bytes");
                let id = Uuid::from_bytes_le(head[1..17].try_into()?);
                let chain_id = self
                    .handles
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&id)
                    .copied()
                    .context("unknown resource handle")?;
                self.chain_by_id(chain_id)
                    .context("handle names a chain that is gone")
            }
            Some(types::Type::String) if (self.spec.token_calls)(iface, name) => {
                let token = peek_string(rx).await.context("peek grant token")?;
                let via = (self.spec.resolve_token)(iface, name, &token)?;
                loop {
                    let chain = self.chain_for(via.clone()).await?;
                    if self.track(&chain, &token) {
                        return Ok(chain);
                    }
                }
            }
            _ => self.default_chain().context("nothing provides this call"),
        }
    }

    /// Record which chain minted `ids`.
    fn minted(&self, chain: u64, ids: Vec<Uuid>) {
        if ids.is_empty() {
            return;
        }
        let mut handles = self.handles.lock().unwrap_or_else(|e| e.into_inner());
        for id in ids {
            handles.insert(id, chain);
        }
    }
}

/// Peek a wRPC `string` at the head of `rx`: a LEB128 length then its bytes.
async fn peek_string(rx: &mut wrpc_transport::frame::Incoming) -> anyhow::Result<String> {
    let mut len: u32 = 0;
    let mut shift = 0;
    let mut prefix = 0;
    loop {
        let head = rx.peek(prefix + 1).await?;
        let byte = head[prefix];
        len |= u32::from(byte & 0x7f) << shift;
        prefix += 1;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
        anyhow::ensure!(shift < 35, "string length prefix too long");
    }
    let len = usize::try_from(len)?;
    let all = rx.peek(prefix + len).await?;
    Ok(String::from_utf8(all[prefix..].to_vec())?)
}

/// The interface `open-root` lives on; the token-carrying call routing keys on.
const MOUNT_INSTANCE: &str = "icanhaz:fspass/mount@0.1.0";

/// A linker for the gated filesystem: WASI plus the consent `gate` the
/// passthrough imports, host-validated against the store's grants.
fn fs_linker<C>(engine: &Engine) -> anyhow::Result<Linker<FsState<C>>>
where
    C: Invoke + 'static,
    C::Context: Clone,
{
    let mut linker = Linker::<FsState<C>>::new(engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)
        .map_err(anyhow::Error::from)
        .context("link WASI")?;
    // Hand-wire the consent gate the component's `mount` imports.
    linker
        .instance("icanhaz:fspass/gate@0.1.0")
        .map_err(anyhow::Error::from)
        .context("gate instance")?
        .func_wrap_async(
            "authorize",
            |store: wasmtime::StoreContextMut<'_, FsState<C>>, (grant,): (String,)| {
                let grants = store.data().grants.clone();
                Box::new(async move {
                    // The gate carries only the token (not the method or path),
                    // so admission here is grant-level: live, and the scope's
                    // `when` holds. Per-op `allow` for descriptor methods lands
                    // when `gate.authorize` gains (method, path) arguments.
                    let res = {
                        let store = grants.lock().unwrap();
                        store
                            .validate_filesystem(&grant)
                            .and_then(|paths| store.admit_grant(&grant).map(|()| paths))
                            // Hand the component the granted root path to scope the descriptor to.
                            .map(|paths| paths.into_iter().next().unwrap_or_default())
                            .map_err(|d| {
                                format!(
                                    "filesystem grant denied: {}",
                                    crate::broker::denied_text(&d)
                                )
                            })
                    };
                    Ok((res,))
                })
            },
        )
        .map_err(anyhow::Error::from)
        .context("link gate.authorize")?;
    // Per-operation admission: the component reports the descriptor method and its
    // string arguments; the grant's `allow` clause decides. Names arrive kebab-case
    // as in WIT and bind as `call.args.<cel_ident>` (`old-path` → `old_path`).
    linker
        .instance("icanhaz:fspass/gate@0.1.0")
        .map_err(anyhow::Error::from)
        .context("gate instance")?
        .func_wrap_async(
            "admit",
            |store: wasmtime::StoreContextMut<'_, FsState<C>>,
             (grant, method, args): (String, String, Vec<(String, String)>)| {
                let grants = store.data().grants.clone();
                Box::new(async move {
                    let mut call = crate::broker::AdmitCall::new(&method);
                    for (name, value) in args {
                        call = call.arg(&ezcap::shape::cel_ident(&name), value);
                    }
                    let res = grants.lock().unwrap().admit(&grant, call).map_err(|d| {
                        format!("filesystem denied: {}", crate::broker::denied_text(&d))
                    });
                    Ok((res,))
                })
            },
        )
        .map_err(anyhow::Error::from)
        .context("link gate.admit")?;
    Ok(linker)
}

/// Serve the gated `wasi:filesystem` over wRPC. `component_bytes` is the default
/// chain (the shipped passthrough): linked with WASI + the consent `gate`
/// (host-validated against `grants`), instantiated once, its exports
/// (`wasi:filesystem/types` + `mount`) registered on `srv`. `mount.open-root`
/// calls the gate, so it refuses any token that isn't a live `filesystem` grant:
/// an ungated peer never receives a descriptor. `wasi` builds the preopened
/// root (the jail) for each chain's store.
///
/// A grant provided through a chain (`via`, chosen at consent) mounts on that
/// chain instead: `chains` composes it, and it is instantiated into its own
/// store the first time a grant names it (see [`Router`]).
pub async fn serve_filesystem<C, S>(
    srv: &S,
    component_bytes: &[u8],
    client: C,
    cx: C::Context,
    wasi: WasiRecipe,
    grants: Arc<std::sync::Mutex<GrantStore>>,
    chains: Option<ChainSource>,
) -> anyhow::Result<JoinSet<()>>
where
    C: Invoke + Clone + 'static,
    C::Context: Clone,
    S: Serve,
    S::Context: AsOrigin,
{
    let engine = engine()?;
    let component = Component::new(&engine, component_bytes)
        .map_err(anyhow::Error::from)
        .context("compile component")?;
    let spec = RouterSpec {
        linker: fs_linker::<C>(&engine)?,
        source: chains,
        // Only the mount carries a token; the passthrough's own gate validates
        // it, so resolving is just reading the grant's chain.
        token_calls: Arc::new(|iface, name| iface == MOUNT_INSTANCE && name == "open-root"),
        resolve_token: {
            let grants = Arc::clone(&grants);
            Arc::new(move |_, _, token| {
                Ok(grants
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .via_of(token))
            })
        },
    };
    let router = Router::new(spec, client, cx, wasi, grants)?;
    router
        .add_chain(String::new(), &component)
        .await
        .context("instantiate the default filesystem chain")?;
    let mut handlers = JoinSet::new();
    register_exports(
        srv,
        &router,
        &component.component_type(),
        None,
        &mut handlers,
    )
    .await?;
    serve_resource_drop(srv, router, &mut handlers).await?;
    Ok(handlers)
}

/// A router for a novel interface a store component provides. Its chains are
/// compositions of store components alone (no native base): the grant's
/// `via`, or the `provider` the requester suggested. Every function's first
/// argument is the grant token: it must be a live `component` grant for this
/// interface, and the call is admitted by name against the grant's scope.
pub fn component_router<C>(
    interface: &str,
    components: Arc<ComponentStore>,
    client: C,
    cx: C::Context,
    wasi: WasiRecipe,
    grants: Arc<std::sync::Mutex<GrantStore>>,
) -> anyhow::Result<Arc<Router<C>>>
where
    C: Invoke + Clone + 'static,
    C::Context: Clone,
{
    let engine = engine()?;
    let mut linker = Linker::<FsState<C>>::new(&engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)
        .map_err(anyhow::Error::from)
        .context("link WASI")?;
    let provides = interface.to_string();
    let source: ChainSource = {
        let provides = provides.clone();
        Arc::new(move |via: Vec<String>| {
            let components = Arc::clone(&components);
            let provides = provides.clone();
            Box::pin(async move {
                tokio::task::spawn_blocking(move || {
                    let mut parts = Vec::new();
                    for hash in via.iter().rev() {
                        parts.push(
                            components
                                .get(hash)
                                .with_context(|| format!("chain component {hash}"))?,
                        );
                    }
                    let bytes = if parts.len() == 1 {
                        parts.remove(0)
                    } else {
                        crate::components::compose(&parts)?
                    };
                    let info = crate::components::validate(&bytes)?;
                    anyhow::ensure!(
                        info.exports.contains(&provides),
                        "the chain must export {provides}; it exports {:?}",
                        info.exports
                    );
                    Ok(bytes)
                })
                .await
                .context("compose chain")?
            })
        })
    };
    let spec = RouterSpec {
        linker,
        source: Some(source),
        token_calls: Arc::new(|_, _| true),
        resolve_token: {
            let grants = Arc::clone(&grants);
            let provides = provides.clone();
            Arc::new(move |_iface, name, token| {
                let mut g = grants.lock().unwrap_or_else(|e| e.into_inner());
                g.validate(token, |k| {
                    matches!(k, crate::broker::CapabilityKind::Component(c) if c.provides == provides)
                })
                .map_err(|d| anyhow::anyhow!("{provides} denied: {d:?}"))?;
                // Admitted by method name: the call's other arguments are not
                // decoded at routing time, so a clause over `call.args.*`
                // fails closed here.
                g.admit(token, crate::broker::AdmitCall::new(name))
                    .map_err(|d| {
                        anyhow::anyhow!("{provides} denied: {}", crate::broker::denied_text(&d))
                    })?;
                let via = g.via_of(token);
                if !via.is_empty() {
                    return Ok(via);
                }
                match g.kind_of(token) {
                    Some(crate::broker::CapabilityKind::Component(c)) => c
                        .provider
                        .map(|p| vec![p])
                        .context("the grant names no component to provide it"),
                    _ => anyhow::bail!("not a component grant"),
                }
            })
        },
    };
    Router::new(spec, client, cx, wasi, grants)
}

/// Serve `interface` on `srv` through `router`: the functions the component
/// type `ty` exports under that interface, each routed per call, plus the
/// resource-drop meta-op. `ty` may be any component exporting the interface;
/// every chain must export the same surface (checked when composed).
pub async fn serve_interface<C, S>(
    srv: &S,
    router: &Arc<Router<C>>,
    ty: &types::Component,
    interface: &str,
) -> anyhow::Result<JoinSet<()>>
where
    C: Invoke + Clone + 'static,
    C::Context: Clone,
    S: Serve,
    S::Context: AsOrigin,
{
    let mut handlers = JoinSet::new();
    register_exports(srv, router, ty, Some(interface), &mut handlers).await?;
    Ok(handlers)
}

/// Register every exported function of `ty` (or only `only`'s) on `srv`, each
/// invocation routed through `router`.
async fn register_exports<C, S>(
    srv: &S,
    router: &Arc<Router<C>>,
    ty: &types::Component,
    only: Option<&str>,
    handlers: &mut JoinSet<()>,
) -> anyhow::Result<()>
where
    C: Invoke + Clone + 'static,
    C::Context: Clone,
    S: Serve,
    S::Context: AsOrigin,
{
    let engine = router.engine().clone();
    let mut imports = BTreeMap::default();
    collect_component_resource_imports(&engine, ty, &mut imports);
    let host_resources = map_host_resources(imports);
    let io_streams: Arc<[ResourceType]> =
        wrpc_wasmtime::paths::wasi_io_stream_resources(&engine, ty).into();
    for (instance_name, types::ComponentExtern { ty: item, .. }) in ty.exports(&engine) {
        if only.is_some_and(|o| o != instance_name) {
            continue;
        }
        let types::ComponentItem::ComponentInstance(inst_ty) = item else {
            continue;
        };
        for (name, types::ComponentExtern { ty: fitem, .. }) in inst_ty.exports(&engine) {
            let types::ComponentItem::ComponentFunc(func_ty) = fitem else {
                continue;
            };
            let params_ty: Arc<[types::Type]> = func_ty.params().map(|(_, t)| t).collect();
            let results_ty: Arc<[types::Type]> = func_ty.results().collect();
            let paths = wrpc_wasmtime::paths::params_async_paths(params_ty.iter(), &io_streams);
            let invocations = srv
                .serve(instance_name, wrpc_wasmtime::rpc_func_name(name), paths)
                .await
                .with_context(|| format!("failed to serve `{instance_name}#{name}`"))?;
            let iface: Arc<str> = Arc::from(instance_name);
            let name: Arc<str> = Arc::from(name);
            let router = Arc::clone(router);
            let host_resources = Arc::clone(&host_resources);
            let io_streams = Arc::clone(&io_streams);
            handlers.spawn(async move {
                let mut invocations = pin!(invocations);
                while let Some(inv) = invocations.next().await {
                    let (cx, tx, rx) = match inv {
                        Ok(inv) => inv,
                        Err(err) => {
                            tracing::warn!(?err, "failed to accept invocation");
                            continue;
                        }
                    };
                    let conn = cx.connection();
                    let res = serve_one(
                        &router,
                        &iface,
                        &name,
                        &params_ty,
                        &results_ty,
                        &host_resources,
                        &io_streams,
                        conn,
                        tx,
                        rx,
                    )
                    .await;
                    if let Err(err) = res {
                        let chain: Vec<String> = err.chain().map(|e| e.to_string()).collect();
                        tracing::warn!(
                            iface = %iface, func = %name, conn,
                            "invocation failed: {}", chain.join(" <- ")
                        );
                    }
                }
            });
        }
    }
    Ok(())
}

/// One routed invocation: pick the chain from the wire, lock only its store,
/// scope its handle table to the connection, run the call, and record what it
/// minted.
#[allow(clippy::too_many_arguments)]
async fn serve_one<C>(
    router: &Arc<Router<C>>,
    iface: &str,
    name: &str,
    params_ty: &[types::Type],
    results_ty: &[types::Type],
    host_resources: &HashMap<Box<str>, HashMap<Box<str>, (ResourceType, ResourceType)>>,
    io_streams: &[ResourceType],
    conn: Option<u64>,
    tx: wrpc_transport::frame::Outgoing,
    mut rx: wrpc_transport::frame::Incoming,
) -> anyhow::Result<()>
where
    C: Invoke + Clone + 'static,
    C::Context: Clone,
{
    let chain = router.route(iface, name, params_ty, &mut rx).await?;
    let func = chain.func(iface, name)?;
    let union = router.union();
    let mut store = chain.store.lock().await;
    store.data_mut().rpc.shared.set_scope(conn);
    let res = wrpc_wasmtime::call(
        &mut *store,
        rx,
        tx,
        &union,
        host_resources,
        io_streams,
        params_ty.iter(),
        results_ty,
        func,
    )
    .await;
    // Whatever the call minted (even on a failed encode) belongs to this chain.
    router.minted(chain.id, store.data_mut().rpc.shared.take_minted());
    res.map_err(anyhow::Error::from)
}

/// The wRPC instance the resource-drop meta-op is served on. It is **not** a component
/// export — the host handles it directly, the component never sees it — so it gets its
/// own `icanhaz:fspass/resources` namespace next to the served filesystem.
const RESOURCES_INSTANCE: &str = "icanhaz:fspass/resources@0.1.0";

/// Serve `drop(handle: list<u8>)` on [`RESOURCES_INSTANCE`], draining it on a task
/// spawned into `handlers`. Each call evicts the guest-exported resource the opaque
/// `handle` names from its chain's [`SharedResourceTable`] and runs its destructor —
/// closing the underlying fd (or releasing the directory-entry stream). Only the
/// connection that minted the handle can drop it.
///
/// This is the descriptor-drop wRPC can't relay on its own: `own<T>`/`borrow<T>` carry
/// no lifetime over the wire, and the client's Component-Model handle-drop never reaches
/// the host — so without this a client that keeps opening descriptors leaks them for the
/// whole connection (the capacity cap is only a backstop). Framing the handle as a plain
/// `list<u8>` (not `own<descriptor>`) keeps it a single uniform op over *any* shared
/// handle and sidesteps the resource codec entirely.
pub async fn serve_resource_drop<C, S>(
    srv: &S,
    router: Arc<Router<C>>,
    handlers: &mut JoinSet<()>,
) -> anyhow::Result<()>
where
    C: Invoke + Clone + 'static,
    C::Context: Clone,
    S: Serve,
    S::Context: AsOrigin,
{
    // A flat `(list<u8>) -> bool` carries no async (stream) params, so no subscription
    // paths. It returns whether a live handle was released, so a caller/test gets a
    // definite acknowledgement (reading a released handle back gives no clean signal).
    let paths: Arc<[Box<[Option<usize>]>]> = Arc::from(Vec::new());
    let invocations = srv
        .serve_values::<(Bytes,), (bool,)>(RESOURCES_INSTANCE, "drop", paths)
        .await
        .context("serve resources.drop")?;
    handlers.spawn(async move {
        let mut invocations = pin!(invocations);
        while let Some(inv) = invocations.next().await {
            let (cx, (handle,), _deferred, reply) = match inv {
                Ok(inv) => inv,
                Err(err) => {
                    tracing::warn!(?err, "failed to accept resource-drop invocation");
                    continue;
                }
            };
            let removed = match drop_shared_handle(&router, &handle, cx.connection()).await {
                Ok(removed) => removed,
                Err(err) => {
                    tracing::warn!(?err, "resource drop failed");
                    false
                }
            };
            // Always complete the invocation so the client's call resolves.
            if let Err(err) = reply((removed,)).await {
                tracing::warn!(?err, "failed to reply to resource-drop");
            }
        }
    });
    Ok(())
}

/// Evict the shared resource the 16-byte UUID `handle` names, in the scope of
/// connection `conn`, and run its guest destructor. Returns whether a live handle
/// was actually removed — a handle that isn't a valid UUID errors; one already
/// gone (double-drop, never ours, or minted on another connection) returns
/// `Ok(false)`, so dropping is idempotent.
async fn drop_shared_handle<C>(
    router: &Router<C>,
    handle: &[u8],
    conn: Option<u64>,
) -> anyhow::Result<bool>
where
    C: Invoke + Clone + 'static,
    C::Context: Clone,
{
    // Handles are minted little-endian on the wire (`codec.rs` `id.to_bytes_le()` /
    // `Uuid::from_bytes_le`), so reconstruct the same way — a big-endian `from_slice`
    // would yield a different UUID that never matches the table key (a silent no-op).
    let bytes: [u8; 16] = handle
        .try_into()
        .context("resource handle is not 16 bytes")?;
    let id = Uuid::from_bytes_le(bytes);
    let chain_id = router
        .handles
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .copied();
    let Some(chain) = chain_id.and_then(|i| router.chain_by_id(i)) else {
        tracing::debug!(%id, "resource-drop: handle already released");
        return Ok(false);
    };
    let mut store = chain.store.lock().await;
    // Mirror the codec's access path to the shared table, then release the entry.
    let removed = {
        let shared = store.data_mut().wrpc().ctx.shared_resources();
        shared.set_scope(conn);
        shared.remove(&id)
    };
    match removed {
        Some(resource) => {
            router
                .handles
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            // Runs the guest resource destructor (the fs-passthrough `Desc`/`DirStream`
            // Drop), which drops the inner host descriptor and closes the fd.
            resource
                .resource_drop_async(&mut *store)
                .await
                .map_err(|e| anyhow::anyhow!("resource_drop_async failed: {e}"))?;
            tracing::debug!(%id, "dropped shared resource");
            Ok(true)
        }
        None => {
            tracing::debug!(%id, "resource-drop: handle not released (not this connection's)");
            Ok(false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Duration;
    use tokio::net::TcpListener;
    use wasmtime_wasi::WasiCtxBuilder;

    // A wRPC client for what the host serves (the mirror `counter-client` world).
    mod counter_client {
        wit_bindgen_wrpc::generate!({
            world: "counter-client",
            path: "../policies/counter-demo/wit",
        });
    }
    use counter_client::demo::res::counter::Counter;

    fn counter_wasm() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../policies/counter-demo/target/wasm32-wasip2/debug/counter_demo.wasm")
    }

    /// The whole resource-serving vertical on a 3-method surface: serve a
    /// guest-exported `counter` resource over wRPC and drive it from a client.
    /// The handle persists in the shared store, so the two increments accumulate —
    /// proving `SharedResourceTable` round-trips a real guest resource.
    #[tokio::test]
    async fn serves_a_guest_resource_over_wrpc() {
        let wasm = std::fs::read(counter_wasm()).expect(
            "build counter-demo first: cargo build --target wasm32-wasip2 \
             --manifest-path src/apps/icanhaz/policies/counter-demo/Cargo.toml",
        );

        let srv = Arc::new(wrpc_transport::Server::default());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let accept = {
            let srv = Arc::clone(&srv);
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let (rx, tx) = stream.into_split();
                    let _ = srv.accept((), tx, rx).await;
                }
            })
        };

        let _handlers = serve_component(
            srv.as_ref(),
            &wasm,
            wrpc_transport::tcp::Client::from(addr.clone()), // owned: stored 'static (never invoked — no polyfill)
            (),
            WasiCtxBuilder::new().build(),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;

        let wrpc = wrpc_transport::tcp::Client::from(&addr);
        let c = Counter::new(&wrpc, (), 10).await.unwrap();
        let b = c.as_borrow();
        assert_eq!(Counter::increment(&wrpc, (), &b, 5).await.unwrap(), 15);
        assert_eq!(Counter::increment(&wrpc, (), &b, 5).await.unwrap(), 20);
        assert_eq!(Counter::value(&wrpc, (), &b).await.unwrap(), 20);

        accept.abort();
    }

    // A wRPC client for the served wasi:filesystem (the mirror `fs-client` world).
    mod fs_client {
        wit_bindgen_wrpc::generate!({
            world: "fs-client",
            path: "../policies/fs-passthrough/wit",
            with: {
                "wasi:filesystem/types@0.2.12": generate,
                "icanhaz:fspass/mount@0.1.0": generate,
                "wasi:io/error@0.2.12": generate,
                "wasi:io/streams@0.2.12": generate,
                "wasi:io/poll@0.2.12": generate,
                "wasi:clocks/wall-clock@0.2.12": generate,
            },
        });
    }

    /// A WASI recipe that preopens `dir` at `/` with `perms`, one fresh context per chain.
    fn jail(dir: &std::path::Path, perms: wasmtime_wasi::FsPerms) -> WasiRecipe {
        let dir = dir.to_path_buf();
        Arc::new(move || {
            let mut builder = WasiCtxBuilder::new();
            builder
                .preopened_dir(&dir, "/", perms)
                .map_err(anyhow::Error::from)?;
            Ok(builder.build())
        })
    }

    fn fs_passthrough_wasm() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../policies/fs-passthrough/target/wasm32-wasip2/debug/fs_passthrough.wasm")
    }

    /// Two grants on one connection, one provided through the `fs_wrap`
    /// chain and one through none: each mounts on its own chain, their
    /// descriptors coexist in one handle table, and every later call is routed
    /// by the descriptor it names, so the wrapped grant's rule holds only for
    /// the wrapped grant. The chain is composed and instantiated the first
    /// time a grant names it.
    #[tokio::test]
    async fn grants_on_one_connection_mount_on_their_own_chains() {
        use crate::broker::{CapabilityKind, FsRequest, FsRights, PathGrant};
        use fs_client::icanhaz::fspass::mount;
        use fs_client::wasi::filesystem::types::{
            Descriptor, DescriptorFlags, ErrorCode, OpenFlags, PathFlags,
        };
        use wasmtime_wasi::FsPerms;

        let passthrough = std::fs::read(fs_passthrough_wasm()).expect("build fs-passthrough first");
        let wrapper = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/fs_wrap.wasm"
        ))
        .expect("fs_wrap.wasm fixture");
        // The source composes `wrap` in front of the passthrough; anything
        // else is unknown, as an unregistered component would be.
        let composed = std::sync::atomic::AtomicUsize::new(0);
        let composed = Arc::new(composed);
        let source: ChainSource = {
            let passthrough = passthrough.clone();
            let composed = Arc::clone(&composed);
            Arc::new(move |via: Vec<String>| {
                let passthrough = passthrough.clone();
                let wrapper = wrapper.clone();
                let composed = Arc::clone(&composed);
                Box::pin(async move {
                    anyhow::ensure!(via == ["wrap"], "unknown chain {via:?}");
                    composed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    crate::components::compose(&[passthrough, wrapper])
                })
            })
        };

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), b"hello\n").unwrap();
        std::fs::write(dir.path().join("forbidden.txt"), b"secret\n").unwrap();
        let wasi = jail(dir.path(), FsPerms::ReadWrite);
        let grants = GrantStore::shared();
        let kind = || {
            CapabilityKind::Filesystem(FsRequest {
                roots: vec![PathGrant {
                    path: "/".to_string(),
                    rights: FsRights::READ | FsRights::WRITE,
                }],
            })
        };
        let (wrapped, plain, wrapped_again) = {
            let mut g = grants.lock().unwrap();
            let wrapped = g
                .issue_scoped_via(
                    kind(),
                    ezcap::Scope::unrestricted(),
                    "filesystem (/) via wrap".to_string(),
                    Duration::from_secs(60),
                    crate::broker::anonymous_principal(),
                    vec!["wrap".to_string()],
                )
                .unwrap();
            let plain = g.issue(
                kind(),
                "filesystem (/)".to_string(),
                Duration::from_secs(60),
                crate::broker::anonymous_principal(),
            );
            let wrapped_again = g
                .issue_scoped_via(
                    kind(),
                    ezcap::Scope::unrestricted(),
                    "filesystem (/) via wrap, again".to_string(),
                    Duration::from_secs(60),
                    crate::broker::anonymous_principal(),
                    vec!["wrap".to_string()],
                )
                .unwrap();
            (wrapped, plain, wrapped_again)
        };

        let srv = Arc::new(wrpc_transport::Server::default());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let accept = {
            let srv = Arc::clone(&srv);
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let (rx, tx) = stream.into_split();
                    let _ = srv.accept((), tx, rx).await;
                }
            })
        };
        let _handlers = serve_filesystem(
            srv.as_ref(),
            &passthrough,
            wrpc_transport::tcp::Client::from(addr.clone()),
            (),
            wasi,
            grants.clone(),
            Some(source),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        let open = |root: &wrpc_transport::ResourceOwn<Descriptor>, path: &'static str| {
            let root = root.as_borrow();
            let wrpc = wrpc.clone();
            async move {
                Descriptor::open_at(
                    &wrpc,
                    (),
                    &root,
                    &PathFlags::empty(),
                    path,
                    &OpenFlags::empty(),
                    &DescriptorFlags::READ,
                )
                .await
                .unwrap()
            }
        };

        // The wrapped grant mounts on the chain: its rule applies.
        let wrapped_root = mount::open_root(&wrpc, (), &wrapped)
            .await
            .unwrap()
            .expect("mount through the chain");
        assert!(matches!(
            open(&wrapped_root, "forbidden.txt").await,
            Err(ErrorCode::Access)
        ));
        let file = open(&wrapped_root, "hello.txt")
            .await
            .expect("hello through the chain");
        let (bytes, _) = Descriptor::read(&wrpc, (), &file.as_borrow(), 1024, 0)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&bytes[..], b"hello\n");

        // The plain grant, on the same connection, mounts on the passthrough:
        // no rule, and its descriptors route to its own instance.
        let plain_root = mount::open_root(&wrpc, (), &plain)
            .await
            .unwrap()
            .expect("mount on the passthrough");
        let secret = open(&plain_root, "forbidden.txt")
            .await
            .expect("no rule on the plain grant");
        let (bytes, _) = Descriptor::read(&wrpc, (), &secret.as_borrow(), 1024, 0)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&bytes[..], b"secret\n");

        // Interleaved: the wrapped root still answers, still refuses.
        assert!(matches!(
            open(&wrapped_root, "forbidden.txt").await,
            Err(ErrorCode::Access)
        ));
        // A second grant naming the same chain shares the instance: composed once.
        let again = mount::open_root(&wrpc, (), &wrapped_again)
            .await
            .unwrap()
            .expect("mount on the existing chain");
        assert!(matches!(
            open(&again, "forbidden.txt").await,
            Err(ErrorCode::Access)
        ));
        assert_eq!(composed.load(std::sync::atomic::Ordering::SeqCst), 1);
        accept.abort();
    }

    /// A chain lives while a live grant names it. Two grants share one
    /// instance (composed once); revoking one keeps it for the other; once
    /// every grant on it is gone the chain is dropped, its handles with it, and
    /// the next grant naming the chain builds it again (composed twice).
    #[tokio::test]
    async fn a_chain_is_dropped_with_its_last_grant() {
        use crate::broker::{CapabilityKind, FsRequest, FsRights, PathGrant};
        use fs_client::icanhaz::fspass::mount;
        use fs_client::wasi::filesystem::types::Descriptor;
        use wasmtime_wasi::FsPerms;

        let passthrough = std::fs::read(fs_passthrough_wasm()).expect("build fs-passthrough first");
        let wrapper = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/fs_wrap.wasm"
        ))
        .expect("fs_wrap.wasm fixture");
        let composed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let source: ChainSource = {
            let passthrough = passthrough.clone();
            let composed = Arc::clone(&composed);
            Arc::new(move |_via: Vec<String>| {
                let passthrough = passthrough.clone();
                let wrapper = wrapper.clone();
                let composed = Arc::clone(&composed);
                Box::pin(async move {
                    composed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    crate::components::compose(&[passthrough, wrapper])
                })
            })
        };
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), b"hello\n").unwrap();
        let wasi = jail(dir.path(), FsPerms::ReadWrite);
        let grants = GrantStore::shared();
        let issue = |g: &mut GrantStore| {
            g.issue_scoped_via(
                CapabilityKind::Filesystem(FsRequest {
                    roots: vec![PathGrant {
                        path: "/".to_string(),
                        rights: FsRights::READ,
                    }],
                }),
                ezcap::Scope::unrestricted(),
                "filesystem (/) via wrap".to_string(),
                Duration::from_secs(60),
                crate::broker::anonymous_principal(),
                vec!["wrap".to_string()],
            )
            .unwrap()
        };
        let (a, b) = {
            let mut g = grants.lock().unwrap();
            (issue(&mut g), issue(&mut g))
        };

        let srv = Arc::new(wrpc_transport::Server::default());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let accept = {
            let srv = Arc::clone(&srv);
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let (rx, tx) = stream.into_split();
                    let _ = srv.accept((), tx, rx).await;
                }
            })
        };
        let _handlers = serve_filesystem(
            srv.as_ref(),
            &passthrough,
            wrpc_transport::tcp::Client::from(addr.clone()),
            (),
            wasi,
            grants.clone(),
            Some(source),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);
        let count = || composed.load(std::sync::atomic::Ordering::SeqCst);

        let root_a = mount::open_root(&wrpc, (), &a).await.unwrap().unwrap();
        let root_b = mount::open_root(&wrpc, (), &b).await.unwrap().unwrap();
        assert_eq!(count(), 1, "both grants share one instance");

        // One grant gone: the other keeps the chain, and its handle still works.
        assert!(grants.lock().unwrap().revoke(&a));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(Descriptor::read_directory(&wrpc, (), &root_b.as_borrow())
            .await
            .is_ok());
        let c = issue(&mut grants.lock().unwrap());
        let _root_c = mount::open_root(&wrpc, (), &c).await.unwrap().unwrap();
        assert_eq!(count(), 1, "a live grant kept the chain");

        // The last grants gone: the chain is dropped, its handles unknown.
        assert!(grants.lock().unwrap().revoke(&b));
        assert!(grants.lock().unwrap().revoke(&c));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            Descriptor::read_directory(&wrpc, (), &root_b.as_borrow())
                .await
                .is_err(),
            "a dropped chain's handle resolves nowhere"
        );
        let _ = root_a;

        // A new grant naming the chain builds it again.
        let d = issue(&mut grants.lock().unwrap());
        let root_d = mount::open_root(&wrpc, (), &d).await.unwrap().unwrap();
        assert_eq!(count(), 2, "the chain was rebuilt");
        assert!(Descriptor::read_directory(&wrpc, (), &root_d.as_borrow())
            .await
            .is_ok());
        accept.abort();
    }

    /// A novel capability: nothing native provides `example:greeter/greeter`;
    /// the store does. A `component` grant naming the greeter as provider is
    /// served through a router of its own: the token is validated and the call
    /// admitted before the component runs, and scopes over the interface type-
    /// check against the environment built from the component's own WIT.
    #[tokio::test]
    async fn a_store_component_provides_a_novel_capability() {
        use crate::broker::{
            AdmitCall, CapabilityKind, ComponentRequest, FsRequest, FsRights, PathGrant,
        };
        use crate::store::Store as Db;
        use wrpc_transport::InvokeExt as _;

        const IFACE: &str = "example:greeter/greeter@0.1.0";
        let greeter = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/greeter.wasm"
        ))
        .expect("greeter.wasm fixture");
        let dir = tempfile::tempdir().unwrap();
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let db = Db::open_with(dir.path().join("icanhaz.db"), &source)
            .await
            .unwrap();
        let components = Arc::new(crate::components::ComponentStore::new(
            dir.path().join("components"),
            Some(db),
        ));
        let info = components
            .add(&greeter, None)
            .await
            .expect("a novel export is a capability");
        assert!(
            info.exports.iter().any(|e| e == IFACE),
            "{:?}",
            info.exports
        );
        assert!(!crate::components::is_native_interface(IFACE));

        // The interface's environment comes from the component itself.
        let grants = GrantStore::shared();
        let env =
            crate::components::env_for(&greeter, IFACE).expect("env from the component's WIT");
        grants.lock().unwrap().add_environment(IFACE, env).unwrap();
        let kind = || {
            CapabilityKind::Component(ComponentRequest {
                provides: IFACE.to_string(),
                provider: Some(info.hash.clone()),
            })
        };
        let (token, scoped, wrong) = {
            let mut g = grants.lock().unwrap();
            let token = g.issue(
                kind(),
                "greeter".to_string(),
                Duration::from_secs(60),
                crate::broker::anonymous_principal(),
            );
            // A clause over the novel interface type-checks and admits by method.
            assert!(g
                .check_scope(&kind(), &ezcap::Scope::allow("call.args.name != \"\""))
                .is_ok());
            assert!(g
                .check_scope(&kind(), &ezcap::Scope::allow("call.args.nope == 1"))
                .is_err());
            let scoped = g
                .issue_scoped(
                    kind(),
                    ezcap::Scope::allow("call.method == \"greet\""),
                    "greeter, greet only".to_string(),
                    Duration::from_secs(60),
                    crate::broker::anonymous_principal(),
                )
                .unwrap();
            assert!(g.admit(&scoped, AdmitCall::new("greet")).is_ok());
            assert!(g.admit(&scoped, AdmitCall::new("other")).is_err());
            let wrong = g.issue(
                CapabilityKind::Filesystem(FsRequest {
                    roots: vec![PathGrant {
                        path: "/".to_string(),
                        rights: FsRights::READ,
                    }],
                }),
                "filesystem".to_string(),
                Duration::from_secs(60),
                crate::broker::anonymous_principal(),
            );
            (token, scoped, wrong)
        };

        let srv = Arc::new(wrpc_transport::Server::default());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let accept = {
            let srv = Arc::clone(&srv);
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let (rx, tx) = stream.into_split();
                    let _ = srv.accept((), tx, rx).await;
                }
            })
        };
        let wasi: WasiRecipe = Arc::new(|| Ok(WasiCtxBuilder::new().build()));
        let router = component_router(
            IFACE,
            Arc::clone(&components),
            wrpc_transport::tcp::Client::from(addr.clone()),
            (),
            wasi,
            grants.clone(),
        )
        .unwrap();
        let ty = Component::new(router.engine(), &greeter)
            .unwrap()
            .component_type();
        let _handlers = serve_interface(srv.as_ref(), &router, &ty, IFACE)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);
        let no_paths: [&[Option<usize>]; 0] = [];
        let greet = |token: String, name: &'static str| {
            let wrpc = wrpc.clone();
            async move {
                wrpc.invoke_values::<_, (String, String), (Result<String, String>,), _>(
                    (),
                    IFACE,
                    "greet",
                    (token, name.to_string()),
                    no_paths,
                )
                .await
                .map(|((r,), _)| r)
            }
        };

        let reply = greet(token.clone(), "world").await.expect("served");
        assert_eq!(
            reply.unwrap(),
            format!("hello, world (grant {}…)", &token[..4])
        );
        // The component's own refusal comes through as its error.
        let refused = greet(token.clone(), "").await.expect("served");
        assert_eq!(refused.unwrap_err(), "greeter: who?");
        // The scoped grant admits `greet` too.
        assert!(greet(scoped, "again").await.expect("served").is_ok());
        // Not a grant for this interface, and not a grant at all: refused
        // before the component runs (the invocation fails).
        assert!(greet(wrong, "x").await.is_err());
        assert!(greet("bogus".to_string(), "x").await.is_err());
        accept.abort();
    }

    /// A handle is bound to the connection that minted it. Two listeners feed
    /// one server, each tagging its connections with its own id: a descriptor
    /// mounted through the first is unknown on the second (its methods fail,
    /// its drop reports nothing released) and still live on the first.
    #[tokio::test]
    async fn handles_are_bound_to_the_connection_that_minted_them() {
        use crate::broker::{CapabilityKind, FsRequest, FsRights, PathGrant};
        use crate::ReqCtx;
        use fs_client::icanhaz::fspass::mount;
        use fs_client::wasi::filesystem::types::Descriptor;
        use wasmtime_wasi::FsPerms;
        use wrpc_transport::InvokeExt as _;

        let wasm = std::fs::read(fs_passthrough_wasm()).expect("build fs-passthrough first");
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), b"mine\n").unwrap();
        let wasi = jail(dir.path(), FsPerms::ReadWrite);
        let grants = GrantStore::shared();
        let grant = grants.lock().unwrap().issue(
            CapabilityKind::Filesystem(FsRequest {
                roots: vec![PathGrant {
                    path: "/".to_string(),
                    rights: FsRights::READ,
                }],
            }),
            "filesystem (/)".to_string(),
            Duration::from_secs(60),
            crate::broker::anonymous_principal(),
        );

        let srv = Arc::new(wrpc_transport::Server::<
            ReqCtx,
            tokio::net::tcp::OwnedReadHalf,
            tokio::net::tcp::OwnedWriteHalf,
        >::default());
        // One listener per "connection": every stream accepted on it carries
        // that connection's id, the way one WebSocket's mux frames do.
        let mut addrs = Vec::new();
        let mut accepts = Vec::new();
        for conn in [1u64, 2u64] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            addrs.push(listener.local_addr().unwrap().to_string());
            let srv = Arc::clone(&srv);
            accepts.push(tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let (rx, tx) = stream.into_split();
                    let cx = ReqCtx {
                        origin: None,
                        peer: None,
                        conn: Some(conn),
                    };
                    let _ = srv.accept(cx, tx, rx).await;
                }
            }));
        }
        let _handlers = serve_filesystem(
            srv.as_ref(),
            &wasm,
            wrpc_transport::tcp::Client::from(addrs[0].clone()),
            (),
            wasi,
            grants.clone(),
            None,
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let first = wrpc_transport::tcp::Client::from(&addrs[0]);
        let second = wrpc_transport::tcp::Client::from(&addrs[1]);

        let root = mount::open_root(&first, (), &grant)
            .await
            .unwrap()
            .expect("mount on the first connection");
        let ok = Descriptor::read_directory(&first, (), &root.as_borrow()).await;
        assert!(ok.is_ok(), "the minting connection uses its handle: {ok:?}");

        // The same handle bytes from the other connection: unknown.
        let other = Descriptor::read_directory(&second, (), &root.as_borrow()).await;
        assert!(
            other.is_err(),
            "a handle must not resolve on another connection, got {other:?}"
        );
        let handle: Bytes = AsRef::<Bytes>::as_ref(&root).clone();
        let no_paths: [&[Option<usize>]; 0] = [];
        let ((removed,), _) = second
            .invoke_values::<_, (Bytes,), (bool,), _>(
                (),
                RESOURCES_INSTANCE,
                "drop",
                (handle.clone(),),
                no_paths,
            )
            .await
            .expect("drop invocation");
        assert!(!removed, "another connection cannot drop the handle");

        // Still live where it was minted, and droppable there.
        let still = Descriptor::read_directory(&first, (), &root.as_borrow()).await;
        assert!(still.is_ok(), "{still:?}");
        let ((removed,), _) = first
            .invoke_values::<_, (Bytes,), (bool,), _>(
                (),
                RESOURCES_INSTANCE,
                "drop",
                (handle,),
                no_paths,
            )
            .await
            .expect("drop invocation");
        assert!(removed);
        for a in accepts {
            a.abort();
        }
    }

    /// A filesystem chain end to end: the `fs_wrap` fixture composed in front
    /// of the passthrough and served as the default chain, so every operation
    /// passes the wrapper first: it refuses paths naming `forbidden`,
    /// everything else reaches the real filesystem.
    #[tokio::test]
    async fn a_filesystem_chain_interposes_on_every_operation() {
        use crate::broker::{CapabilityKind, FsRequest, FsRights, PathGrant};
        use fs_client::icanhaz::fspass::mount;
        use fs_client::wasi::filesystem::types::{
            Descriptor, DescriptorFlags, ErrorCode, OpenFlags, PathFlags,
        };
        use wasmtime_wasi::FsPerms;

        let passthrough = std::fs::read(fs_passthrough_wasm()).expect("build fs-passthrough first");
        let wrapper = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/fs_wrap.wasm"
        ))
        .expect("fs_wrap.wasm fixture");
        let chain = crate::components::compose(&[passthrough, wrapper]).expect("composes");

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), b"through the chain\n").unwrap();
        std::fs::write(dir.path().join("forbidden.txt"), b"never\n").unwrap();
        let wasi = jail(dir.path(), FsPerms::ReadWrite);
        let grants = GrantStore::shared();
        let grant = grants.lock().unwrap().issue(
            CapabilityKind::Filesystem(FsRequest {
                roots: vec![PathGrant {
                    path: "/".to_string(),
                    rights: FsRights::READ | FsRights::WRITE,
                }],
            }),
            "filesystem (/)".to_string(),
            Duration::from_secs(60),
            crate::broker::anonymous_principal(),
        );

        let srv = Arc::new(wrpc_transport::Server::default());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let accept = {
            let srv = Arc::clone(&srv);
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let (rx, tx) = stream.into_split();
                    let _ = srv.accept((), tx, rx).await;
                }
            })
        };
        let _handlers = serve_filesystem(
            srv.as_ref(),
            &chain,
            wrpc_transport::tcp::Client::from(addr.clone()),
            (),
            wasi,
            grants.clone(),
            None,
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        // The passthrough behind the wrapper still gates: a bogus token is refused.
        assert!(mount::open_root(&wrpc, (), "bogus").await.unwrap().is_err());
        let root = mount::open_root(&wrpc, (), &grant)
            .await
            .unwrap()
            .expect("mount through the chain");
        let file = Descriptor::open_at(
            &wrpc,
            (),
            &root.as_borrow(),
            &PathFlags::empty(),
            "hello.txt",
            &OpenFlags::empty(),
            &DescriptorFlags::READ,
        )
        .await
        .unwrap()
        .expect("open hello.txt through the chain");
        let (bytes, _eof) = Descriptor::read(&wrpc, (), &file.as_borrow(), 1024, 0)
            .await
            .unwrap()
            .expect("read through the chain");
        assert_eq!(&bytes[..], &b"through the chain\n"[..]);
        // The wrapper's rule, before the passthrough ever sees the path.
        let refused = Descriptor::open_at(
            &wrpc,
            (),
            &root.as_borrow(),
            &PathFlags::empty(),
            "forbidden.txt",
            &OpenFlags::empty(),
            &DescriptorFlags::READ,
        )
        .await
        .unwrap();
        assert!(matches!(refused, Err(ErrorCode::Access)), "{refused:?}");
        accept.abort();
    }

    /// Serve REAL `wasi:filesystem@0.2` over wRPC, **grant-gated**: a bogus token is
    /// refused by the consent gate; a live filesystem grant exchanges (via
    /// `mount.open-root`) for the root descriptor, which then drives native
    /// `wasi:filesystem` (open-at, read) across the wire. `preopens` isn't served,
    /// so the descriptor is the only way in — the grant is the gate, the descriptor
    /// is the capability.
    #[tokio::test]
    async fn serves_grant_gated_wasi_filesystem_over_wrpc() {
        use crate::broker::{CapabilityKind, FsRequest, FsRights, PathGrant};
        use fs_client::icanhaz::fspass::mount;
        use fs_client::wasi::filesystem::types::{
            Descriptor, DescriptorFlags, OpenFlags, PathFlags,
        };
        use wasmtime_wasi::FsPerms;

        let wasm = std::fs::read(fs_passthrough_wasm()).expect(
            "build fs-passthrough first: cargo build --target wasm32-wasip2 \
             --manifest-path src/apps/icanhaz/policies/fs-passthrough/Cargo.toml",
        );

        // A temp dir with one file is the (preopen-jailed) raw authority.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), b"hello from real wasi-fs\n").unwrap();
        let wasi = jail(dir.path(), FsPerms::ReadWrite);

        // A live filesystem grant, as the broker would mint after consent.
        let grants = GrantStore::shared();
        let grant = grants.lock().unwrap().issue(
            CapabilityKind::Filesystem(FsRequest {
                roots: vec![PathGrant {
                    path: "/".to_string(),
                    rights: FsRights::READ | FsRights::WRITE,
                }],
            }),
            "filesystem (/)".to_string(),
            Duration::from_secs(60),
            crate::broker::anonymous_principal(),
        );

        let srv = Arc::new(wrpc_transport::Server::default());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let accept = {
            let srv = Arc::clone(&srv);
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let (rx, tx) = stream.into_split();
                    let _ = srv.accept((), tx, rx).await;
                }
            })
        };

        let _handlers = serve_filesystem(
            srv.as_ref(),
            &wasm,
            wrpc_transport::tcp::Client::from(addr.clone()),
            (),
            wasi,
            grants.clone(),
            None,
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;

        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        // The gate: a bogus token yields no descriptor.
        let denied = mount::open_root(&wrpc, (), "bogus-token").await.unwrap();
        assert!(
            denied.is_err(),
            "ungated mount must be refused, got {denied:?}"
        );

        // A valid grant exchanges for the root descriptor; then it's native wasi:filesystem.
        let root = mount::open_root(&wrpc, (), &grant)
            .await
            .unwrap()
            .expect("mount with a valid grant");
        let file = Descriptor::open_at(
            &wrpc,
            (),
            &root.as_borrow(),
            &PathFlags::empty(),
            "hello.txt",
            &OpenFlags::empty(),
            &DescriptorFlags::READ,
        )
        .await
        .unwrap()
        .expect("open hello.txt");
        let (bytes, _eof) = Descriptor::read(&wrpc, (), &file.as_borrow(), 1024, 0)
            .await
            .unwrap()
            .expect("read hello.txt");
        assert_eq!(&bytes[..], &b"hello from real wasi-fs\n"[..]);

        accept.abort();
    }

    /// The MEDIATING policy: a grant scoped to a subtree confines the descriptor to
    /// it. `mount` opens the grant's path as a directory and wasi:filesystem
    /// sandboxes that descriptor, so in-scope opens succeed but escaping it (`../`)
    /// is denied — per-grant path scoping enforced by the capability itself.
    #[tokio::test]
    async fn mount_scopes_the_descriptor_to_the_grant_subtree() {
        use crate::broker::{CapabilityKind, FsRequest, FsRights, PathGrant};
        use fs_client::icanhaz::fspass::mount;
        use fs_client::wasi::filesystem::types::{
            Descriptor, DescriptorFlags, OpenFlags, PathFlags,
        };
        use wasmtime_wasi::FsPerms;

        let wasm = std::fs::read(fs_passthrough_wasm()).expect("build fs-passthrough first");
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("notes")).unwrap();
        std::fs::write(dir.path().join("notes/ok.txt"), b"inside the grant\n").unwrap();
        std::fs::write(dir.path().join("secret.txt"), b"OUTSIDE the grant\n").unwrap();
        let wasi = jail(dir.path(), FsPerms::ReadWrite);

        // A grant scoped to /notes/ — NOT the whole preopen.
        let grants = GrantStore::shared();
        let grant = grants.lock().unwrap().issue(
            CapabilityKind::Filesystem(FsRequest {
                roots: vec![PathGrant {
                    path: "/notes/".to_string(),
                    rights: FsRights::READ | FsRights::WRITE,
                }],
            }),
            "filesystem (/notes/)".to_string(),
            Duration::from_secs(60),
            crate::broker::anonymous_principal(),
        );

        let srv = Arc::new(wrpc_transport::Server::default());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let accept = {
            let srv = Arc::clone(&srv);
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let (rx, tx) = stream.into_split();
                    let _ = srv.accept((), tx, rx).await;
                }
            })
        };
        let _handlers = serve_filesystem(
            srv.as_ref(),
            &wasm,
            wrpc_transport::tcp::Client::from(addr.clone()),
            (),
            wasi,
            grants.clone(),
            None,
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        // mount → a descriptor confined to the /notes/ subtree.
        let root = mount::open_root(&wrpc, (), &grant)
            .await
            .unwrap()
            .expect("mount with the scoped grant");

        // In scope: notes/ok.txt opens.
        let in_scope = Descriptor::open_at(
            &wrpc,
            (),
            &root.as_borrow(),
            &PathFlags::empty(),
            "ok.txt",
            &OpenFlags::empty(),
            &DescriptorFlags::READ,
        )
        .await
        .unwrap();
        assert!(
            in_scope.is_ok(),
            "in-scope open must succeed, got {in_scope:?}"
        );

        // Out of scope: ../secret.txt escapes the granted subtree → denied by the sandbox.
        let escape = Descriptor::open_at(
            &wrpc,
            (),
            &root.as_borrow(),
            &PathFlags::empty(),
            "../secret.txt",
            &OpenFlags::empty(),
            &DescriptorFlags::READ,
        )
        .await
        .unwrap();
        assert!(
            escape.is_err(),
            "escaping the granted subtree must be denied, got {escape:?}"
        );

        accept.abort();
    }

    /// Revocation is **retroactive**: a client holding a live root descriptor loses
    /// access the instant its grant is revoked, because every descriptor op
    /// re-authorizes through the gate (the grant is checked per op, not just at mount).
    /// This also covers derived descriptors + expiry, which a mount-time-only gate can't.
    #[tokio::test]
    async fn revoking_a_grant_denies_further_filesystem_ops() {
        use crate::broker::{CapabilityKind, FsRequest, FsRights, PathGrant};
        use fs_client::icanhaz::fspass::mount;
        use fs_client::wasi::filesystem::types::{
            Descriptor, DescriptorFlags, OpenFlags, PathFlags,
        };
        use wasmtime_wasi::FsPerms;

        let wasm = std::fs::read(fs_passthrough_wasm()).expect("build fs-passthrough first");
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), b"live\n").unwrap();
        let wasi = jail(dir.path(), FsPerms::ReadWrite);

        let grants = GrantStore::shared();
        let grant = grants.lock().unwrap().issue(
            CapabilityKind::Filesystem(FsRequest {
                roots: vec![PathGrant {
                    path: "/".to_string(),
                    rights: FsRights::READ | FsRights::WRITE,
                }],
            }),
            "filesystem (/)".to_string(),
            Duration::from_secs(60),
            crate::broker::anonymous_principal(),
        );

        let srv = Arc::new(wrpc_transport::Server::default());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let accept = {
            let srv = Arc::clone(&srv);
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let (rx, tx) = stream.into_split();
                    let _ = srv.accept((), tx, rx).await;
                }
            })
        };
        let _handlers = serve_filesystem(
            srv.as_ref(),
            &wasm,
            wrpc_transport::tcp::Client::from(addr.clone()),
            (),
            wasi,
            grants.clone(),
            None,
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        // Mount, and confirm the held descriptor works while the grant is live.
        let root = mount::open_root(&wrpc, (), &grant)
            .await
            .unwrap()
            .expect("mount with a valid grant");
        let before = Descriptor::open_at(
            &wrpc,
            (),
            &root.as_borrow(),
            &PathFlags::empty(),
            "hello.txt",
            &OpenFlags::empty(),
            &DescriptorFlags::READ,
        )
        .await
        .unwrap();
        assert!(
            before.is_ok(),
            "open must succeed while the grant is live, got {before:?}"
        );

        // Revoke — the client still holds the very same root descriptor handle.
        assert!(
            grants.lock().unwrap().revoke(&grant),
            "grant should have been live"
        );

        // The next op on that descriptor is refused: revocation reaches the live handle.
        let after = Descriptor::open_at(
            &wrpc,
            (),
            &root.as_borrow(),
            &PathFlags::empty(),
            "hello.txt",
            &OpenFlags::empty(),
            &DescriptorFlags::READ,
        )
        .await
        .unwrap();
        assert!(
            after.is_err(),
            "after revoke, ops on the held descriptor must be denied, got {after:?}"
        );
        // And a fresh mount is refused too.
        assert!(
            mount::open_root(&wrpc, (), &grant).await.unwrap().is_err(),
            "a revoked grant can't re-mount"
        );

        accept.abort();
    }

    /// Dropping a descriptor over the `resources` meta-op **releases** it: the handle
    /// is evicted from the shared table and its guest destructor runs (closing the fd),
    /// so the client's next op on that very handle fails at the host (the handle is no
    /// longer known). This is the descriptor-drop that keeps a long-lived client from
    /// leaking a handle per filesystem op.
    /// Per-operation scope through the real component: a grant whose `allow`
    /// clause restricts `open-at` to paths under `ok` admits `ok.txt` and refuses
    /// `hello.txt` with `access`, while methods the clause does not mention
    /// (`read`) stay admitted. The component reports `(method, path)` through
    /// `gate.admit`; the host evaluates the grant's membrane.
    #[tokio::test]
    async fn scoped_grant_confines_descriptor_ops_by_path() {
        use crate::broker::{CapabilityKind, FsRequest, FsRights, PathGrant};
        use fs_client::icanhaz::fspass::mount;
        use fs_client::wasi::filesystem::types::{
            Descriptor, DescriptorFlags, ErrorCode, OpenFlags, PathFlags,
        };
        use wasmtime_wasi::FsPerms;

        let wasm = std::fs::read(fs_passthrough_wasm()).expect("build fs-passthrough first");
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("ok.txt"), b"in scope\n").unwrap();
        std::fs::write(dir.path().join("hello.txt"), b"out of scope\n").unwrap();
        let wasi = jail(dir.path(), FsPerms::ReadWrite);

        let grants = GrantStore::shared();
        let grant = grants
            .lock()
            .unwrap()
            .issue_scoped(
                CapabilityKind::Filesystem(FsRequest {
                    roots: vec![PathGrant {
                        path: "/".to_string(),
                        rights: FsRights::READ | FsRights::WRITE,
                    }],
                }),
                ezcap::Scope::allow(
                    r#"call.method != "open-at" || call.args.path.startsWith("ok")"#,
                ),
                "filesystem (/) scoped".to_string(),
                Duration::from_secs(60),
                crate::broker::anonymous_principal(),
            )
            .expect("scope compiles against the filesystem environment");

        let srv = Arc::new(wrpc_transport::Server::default());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let accept = {
            let srv = Arc::clone(&srv);
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let (rx, tx) = stream.into_split();
                    let _ = srv.accept((), tx, rx).await;
                }
            })
        };
        let _handlers = serve_filesystem(
            srv.as_ref(),
            &wasm,
            wrpc_transport::tcp::Client::from(addr.clone()),
            (),
            wasi,
            grants.clone(),
            None,
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        let root = mount::open_root(&wrpc, (), &grant)
            .await
            .unwrap()
            .expect("mount with a valid grant");
        let open = |path: &'static str| {
            let wrpc = wrpc.clone();
            let root = root.as_borrow();
            async move {
                Descriptor::open_at(
                    &wrpc,
                    (),
                    &root,
                    &PathFlags::empty(),
                    path,
                    &OpenFlags::empty(),
                    &DescriptorFlags::READ,
                )
                .await
                .unwrap()
            }
        };

        let file = open("ok.txt").await.expect("ok.txt is in scope");
        let (bytes, _eof) = Descriptor::read(&wrpc, (), &file.as_borrow(), 1024, 0)
            .await
            .unwrap()
            .expect("read is not restricted by the clause");
        assert_eq!(&bytes[..], &b"in scope\n"[..]);

        let denied = open("hello.txt").await;
        assert!(
            matches!(denied, Err(ErrorCode::Access)),
            "hello.txt must be refused by the scope, got {denied:?}"
        );

        // The instance's counters advanced for the admitted ops only.
        // (open-root, the admitted open-at, and the read: three admitted calls;
        // the refused open-at does not count.)
        accept.abort();
    }

    #[tokio::test]
    async fn dropping_a_descriptor_releases_the_handle() {
        use crate::broker::{CapabilityKind, FsRequest, FsRights, PathGrant};
        use fs_client::icanhaz::fspass::mount;
        use fs_client::wasi::filesystem::types::{
            Descriptor, DescriptorFlags, OpenFlags, PathFlags,
        };
        use wasmtime_wasi::FsPerms;
        use wrpc_transport::InvokeExt as _;

        let wasm = std::fs::read(fs_passthrough_wasm()).expect("build fs-passthrough first");
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), b"drop me\n").unwrap();
        let wasi = jail(dir.path(), FsPerms::ReadWrite);

        let grants = GrantStore::shared();
        let grant = grants.lock().unwrap().issue(
            CapabilityKind::Filesystem(FsRequest {
                roots: vec![PathGrant {
                    path: "/".to_string(),
                    rights: FsRights::READ | FsRights::WRITE,
                }],
            }),
            "filesystem (/)".to_string(),
            Duration::from_secs(60),
            crate::broker::anonymous_principal(),
        );

        let srv = Arc::new(wrpc_transport::Server::default());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let accept = {
            let srv = Arc::clone(&srv);
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let (rx, tx) = stream.into_split();
                    let _ = srv.accept((), tx, rx).await;
                }
            })
        };
        let _handlers = serve_filesystem(
            srv.as_ref(),
            &wasm,
            wrpc_transport::tcp::Client::from(addr.clone()),
            (),
            wasi,
            grants.clone(),
            None,
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        let root = mount::open_root(&wrpc, (), &grant)
            .await
            .unwrap()
            .expect("mount with a valid grant");
        let file = Descriptor::open_at(
            &wrpc,
            (),
            &root.as_borrow(),
            &PathFlags::empty(),
            "hello.txt",
            &OpenFlags::empty(),
            &DescriptorFlags::READ,
        )
        .await
        .unwrap()
        .expect("open hello.txt");

        // The handle works while it's live.
        let before = Descriptor::read(&wrpc, (), &file.as_borrow(), 1024, 0)
            .await
            .unwrap();
        assert!(
            before.is_ok(),
            "read must succeed before drop, got {before:?}"
        );

        // Drop the descriptor handle over the resources meta-op (its raw 16-byte handle).
        // The op reports back that it released a live handle.
        let handle: Bytes = AsRef::<Bytes>::as_ref(&file).clone();
        let no_paths: [&[Option<usize>]; 0] = [];
        let ((removed,), _tx) = wrpc
            .invoke_values::<_, (Bytes,), (bool,), _>(
                (),
                RESOURCES_INSTANCE,
                "drop",
                (handle,),
                no_paths,
            )
            .await
            .expect("drop invocation");
        assert!(removed, "drop should report it released a live handle");

        // The dropped handle no longer resolves: the host can't find it, so a read on
        // the very same descriptor now fails (proving it was evicted, not just closed).
        let after = Descriptor::read(&wrpc, (), &file.as_borrow(), 1024, 0).await;
        assert!(
            after.is_err(),
            "read after drop must fail (handle released), got {after:?}"
        );

        accept.abort();
    }
}
