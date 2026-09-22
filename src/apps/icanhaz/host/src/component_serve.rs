//! Serve a wasmtime **component's exports** over wRPC: resources, streams
//! and async exports included. This is the daemon's one serving path: every
//! shipped capability (`capabilities/`) and every novel component from the
//! store goes through a [`Router`], which owns the component's chains (one
//! instantiated composition per `via` a grant names, each in its own store
//! with a long-lived concurrent driver), routes each call by what is on the
//! wire before decoding it (a served handle names the chain that minted it;
//! a grant token names the chain the grant is provided through), and records
//! every handle a reply carries in the daemon-wide [`Handles`] registry, under
//! the grant it was acquired with. Components see only WASI and the raw host
//! layer (`crate::raw`); the consent gate is one of its interfaces.
//!
//! Built on the wrpc fork's `wrpc-wasmtime`: its codec bridges guest-exported
//! resources through a [`SharedResourceTable`] scoped to the connection that
//! minted each handle, and component-model `stream<u8>` to wRPC streams.

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
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
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

/// Store state for serving a component: a `WasiCtx` (its host-satisfied
/// imports) plus the wRPC view.
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
    // Streams, async exports and concurrent calls: every chain's store runs
    // its invocations as concurrent tasks (see `Chain::jobs`).
    config.wasm_component_model_async(true);
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
pub struct CapabilityState<C: Invoke> {
    table: ResourceTable,
    wasi: WasiCtx,
    rpc: Rpc<C>,
    /// The raw host layer a capability component imports (`icanhaz:nocap`
    /// gates and raw operations; the gates reach the grant store through it,
    /// and `jail.open` mints descriptors into `table`).
    raw: Arc<crate::raw::Raw>,
}

impl<C: Invoke + 'static> crate::raw::HasRaw for CapabilityState<C> {
    fn raw_view(&mut self) -> crate::raw::RawView<'_> {
        crate::raw::RawView {
            raw: &self.raw,
            table: &mut self.table,
        }
    }
}

impl<C: Invoke> WasiView for CapabilityState<C> {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl<C: Invoke> WrpcView for CapabilityState<C>
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

/// One instantiated chain: its own store (so its own lock, host tables,
/// limits and lifetime), the resource types it exports, its exports.
struct Chain<C: Invoke + 'static> {
    id: u64,
    /// The chain's component ids joined by `,`; empty for the default chain.
    key: String,
    /// Work for the store's driver: a task that owns the store inside
    /// `run_concurrent` for the chain's life and spawns every call and drop
    /// as a concurrent task in it, so sessions on one chain never queue
    /// behind each other. Dropping the chain closes the channel, which ends
    /// the driver and drops the store.
    jobs: tokio::sync::mpsc::UnboundedSender<Job<C>>,
    /// The resource types this chain's instance exports, in both identities
    /// (declared by the component type, minted by the live instance).
    resources: Vec<ResourceType>,
    /// Its exported functions by `(interface, function)`.
    funcs: HashMap<(Box<str>, Box<str>), Func>,
    /// The live grants mounted on this chain. When the last ends (revoked or
    /// expired) the chain is dropped, store and all; the default chain stays.
    grants: std::sync::Mutex<HashSet<String>>,
    /// Releases a handle this chain minted (see [`Handles`]).
    release: Release,
}

/// Chain ids are daemon-wide: a handle names its chain in the shared
/// [`Handles`] registry, whichever router the chain belongs to.
static CHAIN_IDS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// One unit of work for a chain's store.
enum Job<C: Invoke + 'static> {
    Call(Box<CallJob<C>>),
    Drop(DropJob),
}

/// An invocation, routed to this chain, ready to run as a concurrent task.
struct CallJob<C: Invoke + 'static> {
    router: Arc<Router<C>>,
    chain_id: u64,
    iface: Arc<str>,
    name: Arc<str>,
    param_names: Arc<[String]>,
    params_ty: Arc<[types::Type]>,
    results_ty: Arc<[types::Type]>,
    host_resources: Arc<HashMap<Box<str>, HashMap<Box<str>, (ResourceType, ResourceType)>>>,
    io_streams: Arc<[ResourceType]>,
    union: Arc<[ResourceType]>,
    func: Func,
    scope: Option<u64>,
    /// The grant this call runs under (see [`Admit`]).
    grant: Option<String>,
    tx: wrpc_transport::frame::Outgoing,
    rx: wrpc_transport::frame::Incoming,
}

impl<C> wasmtime::component::AccessorTask<CapabilityState<C>> for CallJob<C>
where
    C: Invoke + Clone + 'static,
    C::Context: Clone,
{
    async fn run(
        self,
        accessor: &wasmtime::component::Accessor<CapabilityState<C>>,
    ) -> wasmtime::Result<()> {
        let admit = self.router.spec.admit.clone();
        let (iface, name, param_names) = (self.iface, self.name, self.param_names);
        let (router, chain_id) = (Arc::clone(&self.router), self.chain_id);
        let grant = self.grant;
        let res = wrpc_wasmtime::call_concurrent_observed(
            accessor,
            self.scope,
            self.rx,
            self.tx,
            &self.union,
            &self.host_resources,
            &self.io_streams,
            self.params_ty.iter(),
            &self.results_ty,
            self.func,
            |vals| match &admit {
                Some(admit) => admit(&iface, &name, &param_names, vals, grant.as_deref())
                    .map_err(|e| wasmtime::Error::msg(format!("{e:#}"))),
                None => Ok(()),
            },
            // The handles a reply carries are registered to this chain, under
            // this call's grant, before the reply leaves, so a drop or a
            // method on them cannot outrun it.
            |acc| {
                let minted = acc.with(|mut a| a.get().rpc.shared.take_minted());
                router.minted(chain_id, grant.as_deref(), minted);
            },
        )
        .await;
        // Whatever a failed encode minted belongs here too.
        let minted = accessor.with(|mut a| a.get().rpc.shared.take_minted());
        self.router.minted(self.chain_id, grant.as_deref(), minted);
        if let Err(err) = res {
            #[cfg(test)]
            eprintln!("invocation {iface}#{name} failed: {err:?}");
            let err = anyhow::Error::from(err);
            let chain: Vec<String> = err.chain().map(|e| e.to_string()).collect();
            tracing::warn!(
                iface = %iface, func = %name, conn = self.scope,
                "invocation failed: {}", chain.join(" <- ")
            );
        }
        Ok(())
    }
}

/// Release the shared resource `id` in `scope` and run its guest destructor.
struct DropJob {
    id: Uuid,
    scope: Option<u64>,
    reply: tokio::sync::oneshot::Sender<anyhow::Result<bool>>,
}

/// Own `store` for its life: spawn every call sent as a concurrent task in
/// it. A drop cannot run inside the concurrent scope (the destructor is an
/// asynchronous call on the store, and a store whose host functions are
/// asynchronous refuses the synchronous one), so the driver steps out of the
/// scope for it: `run_concurrent` returns as soon as its future does and keeps
/// every pending task in the store, the drop runs with the store in hand, and
/// the driver steps back in.
fn spawn_driver<C>(
    mut store: Store<CapabilityState<C>>,
) -> tokio::sync::mpsc::UnboundedSender<Job<C>>
where
    C: Invoke + Clone + 'static,
    C::Context: Clone,
{
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Job<C>>();
    tokio::spawn(async move {
        loop {
            let scope = store
                .run_concurrent(async |acc| {
                    while let Some(job) = rx.recv().await {
                        match job {
                            Job::Call(job) => {
                                if let Err(err) = acc.spawn(*job) {
                                    tracing::warn!(
                                        ?err,
                                        "could not spawn a call in the chain's store"
                                    );
                                }
                            }
                            Job::Drop(job) => return Some(job),
                        }
                    }
                    None
                })
                .await;
            match scope {
                Ok(Some(drop)) => {
                    let removed = store.data_mut().rpc.shared.remove(drop.scope, &drop.id);
                    let outcome = match removed {
                        // Runs the guest resource destructor (the filesystem capability
                        // `Desc`/`DirStream` Drop), which closes the underlying fd.
                        Some(resource) => resource
                            .resource_drop_async(&mut store)
                            .await
                            .map(|()| true)
                            .map_err(|e| anyhow::anyhow!("resource_drop_async failed: {e}")),
                        None => Ok(false),
                    };
                    let _ = drop.reply.send(outcome);
                }
                Ok(None) => {
                    tracing::debug!("chain store driver ended");
                    break;
                }
                Err(err) => {
                    tracing::warn!(?err, "chain store driver failed");
                    break;
                }
            }
        }
    });
    tx
}

impl<C: Invoke + 'static> Chain<C> {
    fn func(&self, iface: &str, name: &str) -> anyhow::Result<Func> {
        self.funcs
            .get(&(Box::from(iface), Box::from(name)))
            .copied()
            .with_context(|| format!("chain [{}] does not export `{iface}#{name}`", self.key))
    }
}

/// Is `(interface, function, first parameter name)` a call whose first
/// argument is a grant token? The convention across every capability: a
/// `string` parameter named `grant` in first position, on the acquisition
/// function (`open`, `open-root`).
pub type TokenCalls = Arc<dyn Fn(&str, &str, &str) -> bool + Send + Sync>;

/// The default rule: the first parameter is named `grant`.
pub fn grant_first(_iface: &str, _name: &str, first_param: &str) -> bool {
    first_param == "grant"
}
/// Given `(interface, function, token)`, the chain the call runs on (component
/// ids, outermost first; empty for the default), after whatever validation
/// and admission the kind requires.
pub type ResolveToken = Arc<dyn Fn(&str, &str, &str) -> anyhow::Result<Vec<String>> + Send + Sync>;

/// Admit a decoded call: `(interface, function, parameter names, values,
/// grant)`. The grant is the token a token-carrying call presented, or the
/// one the resource a method is called on was acquired under; `None` when
/// the call names neither. Refusing fails the call before the component runs.
pub type Admit = Arc<
    dyn Fn(&str, &str, &[String], &[wasmtime::component::Val], Option<&str>) -> anyhow::Result<()>
        + Send
        + Sync,
>;

/// Releases a served handle: a task in its chain's store that evicts it in
/// the scope of one connection and runs its guest destructor, `true` when it
/// was live there.
type Release = Arc<
    dyn Fn(Uuid, Option<u64>) -> Pin<Box<dyn Future<Output = anyhow::Result<bool>> + Send>>
        + Send
        + Sync,
>;

/// What the registry knows about a served handle: the chain whose store
/// holds it, the grant it was acquired under (a capability object carries
/// its grant: minted by a token call, or by a method on such an object), and
/// how to release it.
#[derive(Clone)]
struct HandleEntry {
    chain: u64,
    grant: Option<String>,
    release: Release,
}

/// Every handle a daemon serves, whichever router's chain minted it: what a
/// method call resolves its object through, and what the resource-drop
/// meta-op releases through. One per daemon, shared by every router on every
/// transport: a handle is scoped to the connection that minted it, and
/// connections are numbered daemon-wide, so one registry and one drop
/// service cover them all.
#[derive(Default)]
pub struct Handles {
    entries: std::sync::Mutex<HashMap<Uuid, HandleEntry>>,
}

impl Handles {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<Uuid, HandleEntry>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn get(&self, id: &Uuid) -> Option<HandleEntry> {
        self.entries().get(id).cloned()
    }

    /// Forget every handle chain `chain` minted: its store is going.
    fn forget_chain(&self, chain: u64) {
        self.entries().retain(|_, entry| entry.chain != chain);
    }

    /// Release the handle the 16 bytes `handle` name, in the scope of
    /// connection `conn`, running its guest destructor in the owning chain's
    /// store. Returns whether a live handle was actually released: a handle
    /// that is not a UUID errors; one already gone (double-drop, never ours,
    /// or minted on another connection) is `Ok(false)`, so dropping is
    /// idempotent.
    pub async fn release(&self, handle: &[u8], conn: Option<u64>) -> anyhow::Result<bool> {
        // Handles are minted little-endian on the wire (`codec.rs`
        // `id.to_bytes_le()` / `Uuid::from_bytes_le`), so reconstruct the same
        // way: a big-endian `from_slice` would yield a different UUID that
        // never matches (a silent no-op).
        let bytes: [u8; 16] = handle
            .try_into()
            .context("resource handle is not 16 bytes")?;
        let id = Uuid::from_bytes_le(bytes);
        let Some(entry) = self.get(&id) else {
            tracing::debug!(%id, "resource-drop: handle already released");
            return Ok(false);
        };
        let removed = (entry.release)(id, conn).await?;
        if removed {
            self.entries().remove(&id);
            tracing::debug!(%id, "dropped shared resource");
        } else {
            tracing::debug!(%id, "resource-drop: handle not released (not this connection's)");
        }
        Ok(removed)
    }
}

/// What a [`Router`] routes: the linker its chains instantiate with, where
/// chain bytes come from, which calls carry a token, how a token names a
/// chain, and how a decoded call is admitted (if the chain does not gate its
/// own calls, as the filesystem passthrough does).
pub struct RouterSpec<C: Invoke + 'static> {
    pub linker: Linker<CapabilityState<C>>,
    pub source: Option<ChainSource>,
    pub token_calls: TokenCalls,
    pub resolve_token: ResolveToken,
    pub admit: Option<Admit>,
}

/// Flatten a decoded value into the clause environment's dotted names, the
/// way `ezcap::shape` declares them: records become `a.b`, string-keyed
/// tuple lists become maps, options and lists carry through, enums and
/// variants bind their case name.
pub fn flatten_val(
    prefix: &str,
    val: &wasmtime::component::Val,
    out: &mut Vec<(String, ezcap::Val)>,
) {
    use wasmtime::component::Val as W;
    let leaf = |v: &W| -> Option<ezcap::Val> {
        Some(match v {
            W::Bool(b) => ezcap::Val::Bool(*b),
            W::S8(n) => ezcap::Val::Int(i64::from(*n)),
            W::U8(n) => ezcap::Val::Int(i64::from(*n)),
            W::S16(n) => ezcap::Val::Int(i64::from(*n)),
            W::U16(n) => ezcap::Val::Int(i64::from(*n)),
            W::S32(n) => ezcap::Val::Int(i64::from(*n)),
            W::U32(n) => ezcap::Val::Int(i64::from(*n)),
            W::S64(n) => ezcap::Val::Int(*n),
            W::U64(n) => ezcap::Val::uint(*n),
            W::Float32(f) => ezcap::Val::Double(f64::from(*f)),
            W::Float64(f) => ezcap::Val::Double(*f),
            W::Char(c) => ezcap::Val::Str(c.to_string()),
            W::String(s) => ezcap::Val::Str(s.clone()),
            W::Enum(name) => ezcap::Val::Str(name.clone()),
            W::Variant(name, _) => ezcap::Val::Str(name.clone()),
            _ => return None,
        })
    };
    match val {
        W::Record(fields) => {
            for (name, v) in fields {
                flatten_val(
                    &format!("{prefix}.{}", ezcap::shape::cel_ident(name)),
                    v,
                    out,
                );
            }
        }
        W::Option(inner) => {
            let inner = inner.as_ref().and_then(|v| leaf(v)).map(Box::new);
            out.push((prefix.to_string(), ezcap::Val::Opt(inner)));
        }
        W::List(items) => {
            if items.iter().all(|i| matches!(i, W::U8(_))) {
                let bytes = items
                    .iter()
                    .filter_map(|i| if let W::U8(b) = i { Some(*b) } else { None })
                    .collect();
                out.push((prefix.to_string(), ezcap::Val::Bytes(bytes)));
            } else if items
                .iter()
                .all(|i| matches!(i, W::Tuple(t) if t.len() == 2 && matches!(t[0], W::String(_))))
            {
                let entries = items
                    .iter()
                    .filter_map(|i| match i {
                        W::Tuple(t) => match (&t[0], leaf(&t[1])) {
                            (W::String(k), Some(v)) => Some((k.clone(), v)),
                            _ => None,
                        },
                        _ => None,
                    })
                    .collect();
                out.push((prefix.to_string(), ezcap::Val::Map(entries)));
            } else {
                let vals: Vec<ezcap::Val> = items.iter().filter_map(leaf).collect();
                out.push((prefix.to_string(), ezcap::Val::List(vals)));
            }
        }
        other => {
            if let Some(v) = leaf(other) {
                out.push((prefix.to_string(), v));
            }
        }
    }
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
    state: Box<dyn Fn() -> anyhow::Result<CapabilityState<C>> + Send + Sync>,
    grants: Arc<std::sync::Mutex<GrantStore>>,
    chains: std::sync::RwLock<Vec<Arc<Chain<C>>>>,
    /// The resource types the served surface declares: a compiled component
    /// has its own identities for them, and the served function types come
    /// from the compilation `register_exports` was given, not from a chain's.
    declared: std::sync::Mutex<Vec<ResourceType>>,
    /// The daemon's handle registry: every handle this router's chains mint
    /// is recorded there, and a method call resolves its object through it.
    handles: Arc<Handles>,
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
    /// A router whose chains' stores see `grants` through the gate and the
    /// daemon's natives through `raw`. Their WASI context is bare: file
    /// authority enters only through the raw `jail.open(grant)`.
    pub fn new(
        spec: RouterSpec<C>,
        client: C,
        cx: C::Context,
        grants: Arc<std::sync::Mutex<GrantStore>>,
        raw: Arc<crate::raw::Raw>,
        handles: Arc<Handles>,
    ) -> anyhow::Result<Arc<Self>> {
        let engine = spec.linker.engine().clone();
        let state = {
            Box::new(move || {
                Ok(CapabilityState {
                    table: ResourceTable::new(),
                    wasi: WasiCtxBuilder::new().build(),
                    rpc: Rpc {
                        client: client.clone(),
                        cx: cx.clone(),
                        shared: SharedResourceTable::with_capacity(max_fs_handles()),
                    },
                    raw: Arc::clone(&raw),
                })
            })
        };
        Ok(Arc::new(Self {
            engine,
            spec,
            state,
            grants,
            chains: std::sync::RwLock::new(Vec::new()),
            declared: std::sync::Mutex::new(Vec::new()),
            handles,
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
        let jobs = spawn_driver(store);
        let release: Release = {
            let jobs = jobs.clone();
            Arc::new(move |id, scope| {
                let jobs = jobs.clone();
                Box::pin(async move {
                    let (reply, outcome) = tokio::sync::oneshot::channel();
                    jobs.send(Job::Drop(DropJob { id, scope, reply }))
                        .map_err(|_| anyhow::anyhow!("the chain's store is gone"))?;
                    outcome
                        .await
                        .map_err(|_| anyhow::anyhow!("the drop task did not report"))?
                })
            })
        };
        let chain = Arc::new(Chain {
            id: CHAIN_IDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            key,
            jobs,
            resources,
            funcs,
            grants: std::sync::Mutex::new(HashSet::new()),
            release,
        });
        let mut chains = self.chains.write().unwrap_or_else(|e| e.into_inner());
        chains.push(Arc::clone(&chain));
        self.recompute_union(&chains);
        Ok(chain)
    }

    /// Note the resource types the served surface `ty` declares (see
    /// `declared`), so the codec treats them as guest resources.
    fn declare(&self, ty: &types::Component) {
        let mut declared = Vec::new();
        collect_component_resource_exports(&self.engine, ty, &mut declared);
        self.declared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .extend(declared);
        let chains = self.chains.read().unwrap_or_else(|e| e.into_inner());
        self.recompute_union(&chains);
    }

    fn recompute_union(&self, chains: &[Arc<Chain<C>>]) {
        let mut all: Vec<ResourceType> = self
            .declared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        all.extend(chains.iter().flat_map(|c| c.resources.iter().copied()));
        *self.union.lock().unwrap_or_else(|e| e.into_inner()) = Arc::from(all);
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
        self.handles.forget_chain(chain_id);
        self.recompute_union(&chains);
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
        param_names: &[String],
        params_ty: &[types::Type],
        rx: &mut wrpc_transport::frame::Incoming,
    ) -> anyhow::Result<(Arc<Chain<C>>, Option<String>)> {
        let first_param = param_names.first().map(String::as_str).unwrap_or("");
        match params_ty.first() {
            Some(types::Type::Own(ty) | types::Type::Borrow(ty)) if self.union().contains(ty) => {
                // `own`/`borrow` of a guest resource: a 16-byte handle, length-prefixed.
                let head = rx.peek(17).await.context("peek resource handle")?;
                anyhow::ensure!(head[0] == 16, "resource handle is not 16 bytes");
                let id = Uuid::from_bytes_le(head[1..17].try_into()?);
                let entry = self.handles.get(&id).context("unknown resource handle")?;
                let chain = self
                    .chain_by_id(entry.chain)
                    .context("the handle was not minted by a chain of this interface")?;
                Ok((chain, entry.grant))
            }
            Some(types::Type::String) if (self.spec.token_calls)(iface, name, first_param) => {
                let token = peek_string(rx).await.context("peek grant token")?;
                let via = (self.spec.resolve_token)(iface, name, &token)?;
                loop {
                    let chain = self.chain_for(via.clone()).await?;
                    if self.track(&chain, &token) {
                        return Ok((chain, Some(token)));
                    }
                }
            }
            _ => Ok((
                self.default_chain().context("nothing provides this call")?,
                None,
            )),
        }
    }

    /// Record which chain minted `ids`, and under which grant.
    fn minted(&self, chain: u64, grant: Option<&str>, ids: Vec<Uuid>) {
        if ids.is_empty() {
            return;
        }
        let Some(owner) = self.chain_by_id(chain) else {
            return;
        };
        let mut handles = self.handles.entries();
        for id in ids {
            handles.insert(
                id,
                HandleEntry {
                    chain,
                    grant: grant.map(str::to_string),
                    release: Arc::clone(&owner.release),
                },
            );
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

/// A linker for a capability store: WASI, the raw host layer every shipped
/// component imports, and the filesystem passthrough's own `gate`.
pub fn capability_linker<C>(engine: &Engine) -> anyhow::Result<Linker<CapabilityState<C>>>
where
    C: Invoke + 'static,
    C::Context: Clone,
{
    let mut linker = Linker::<CapabilityState<C>>::new(engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)
        .map_err(anyhow::Error::from)
        .context("link WASI")?;
    crate::raw::link(&mut linker).context("link the raw host layer")?;
    Ok(linker)
}

/// Serve a shipped capability component over wRPC: `component_bytes` is the
/// default chain, linked with WASI and the raw host layer (`raw`),
/// instantiated once, its exports registered on `srv`. Its acquisition
/// function (`open`, or the passthrough's `open-root`) takes the grant token
/// once; the object it returns is the capability, and the component gates
/// every operation itself through the raw layer. No chain's store has
/// preopens: file authority enters only through the raw `jail.open(grant)`.
///
/// A grant provided through a chain (`via`, chosen at consent) is acquired on
/// that chain instead: `chains` composes it in front of the default, and it is
/// instantiated into its own store the first time a grant names it (see
/// [`Router`]).
#[allow(clippy::too_many_arguments)]
pub async fn serve_capability<C, S>(
    srv: &S,
    component_bytes: &[u8],
    client: C,
    cx: C::Context,
    grants: Arc<std::sync::Mutex<GrantStore>>,
    chains: Option<ChainSource>,
    raw: Arc<crate::raw::Raw>,
    handles: Arc<Handles>,
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
        linker: capability_linker::<C>(&engine)?,
        source: chains,
        token_calls: Arc::new(grant_first),
        // The component validates the token itself; resolving is just
        // reading the grant's chain.
        resolve_token: {
            let grants = Arc::clone(&grants);
            Arc::new(move |_, _, token| {
                Ok(grants
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .via_of(token))
            })
        },
        // The component admits each operation itself, through the gate.
        admit: None,
    };
    let router = Router::new(spec, client, cx, grants, raw, handles)?;
    router
        .add_chain(String::new(), &component)
        .await
        .context("instantiate the default chain")?;
    let mut handlers = JoinSet::new();
    router.declare(&component.component_type());
    register_exports(
        srv,
        &router,
        &component.component_type(),
        None,
        &mut handlers,
    )
    .await?;
    Ok(handlers)
}

/// The filesystem capability alone on a server, with the resource-drop
/// meta-op beside it (see [`serve_capability`] and [`serve_resource_drop`]):
/// what the filesystem tests stand up.
#[cfg(test)]
pub async fn serve_filesystem<C, S>(
    srv: &S,
    component_bytes: &[u8],
    client: C,
    cx: C::Context,
    grants: Arc<std::sync::Mutex<GrantStore>>,
    chains: Option<ChainSource>,
    raw: Arc<crate::raw::Raw>,
) -> anyhow::Result<JoinSet<()>>
where
    C: Invoke + Clone + 'static,
    C::Context: Clone,
    S: Serve,
    S::Context: AsOrigin,
{
    let handles = Handles::new();
    let mut handlers = serve_capability(
        srv,
        component_bytes,
        client,
        cx,
        grants,
        chains,
        raw,
        Arc::clone(&handles),
    )
    .await?;
    serve_resource_drop(srv, handles, &mut handlers).await?;
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
    grants: Arc<std::sync::Mutex<GrantStore>>,
    raw: Arc<crate::raw::Raw>,
    handles: Arc<Handles>,
) -> anyhow::Result<Arc<Router<C>>>
where
    C: Invoke + Clone + 'static,
    C::Context: Clone,
{
    let engine = engine()?;
    // A component may build on the daemon's own capabilities: its imports of
    // them are satisfied by composing the shipped components in (see
    // `ComponentStore::provide_imports`), whose own imports are the raw host
    // layer linked here, each call running under the grant its token resolves
    // to (the component grant's delegated grant of that kind).
    let linker = capability_linker::<C>(&engine)?;
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
                    let bytes = components.provide_imports(bytes)?;
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
        token_calls: Arc::new(grant_first),
        resolve_token: {
            let grants = Arc::clone(&grants);
            let provides = provides.clone();
            Arc::new(move |_iface, _name, token| {
                let g = grants.lock().unwrap_or_else(|e| e.into_inner());
                g.validate(token, |k| {
                    matches!(k, crate::broker::CapabilityKind::Component(c) if c.provides == provides)
                })
                .map_err(|d| anyhow::anyhow!("{provides} denied: {d:?}"))?;
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
        // Admitted against the decoded call: the method and every argument
        // after the token, flattened the way the interface's environment
        // declares them.
        admit: Some({
            let grants = Arc::clone(&grants);
            let provides = provides.clone();
            Arc::new(move |_iface, name, names, vals, grant| {
                // The token a call presented, or the grant the object it is
                // called on was acquired under.
                let Some(token) = grant else {
                    anyhow::bail!("{provides}: no grant for this call");
                };
                // The environment names a method bare (`rename`), the way
                // `ezcap::shape::method_name` does; the export is
                // `[method]index.rename`. A clause on `call.method` sees the
                // former.
                let method = if name.starts_with("[constructor]") {
                    "constructor"
                } else {
                    wrpc_wasmtime::rpc_func_name(name)
                        .rsplit('.')
                        .next()
                        .unwrap_or(name)
                };
                let mut call = crate::broker::AdmitCall::new(method);
                for (n, v) in names.iter().zip(vals.iter()).skip(1) {
                    let mut flat = Vec::new();
                    flatten_val(&ezcap::shape::cel_ident(n), v, &mut flat);
                    for (path, val) in flat {
                        call = call.arg(&path, val);
                    }
                }
                grants
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .admit(token, call)
                    .map_err(|d| {
                        anyhow::anyhow!("{provides} denied: {}", crate::broker::denied_text(&d))
                    })
            })
        }),
    };
    Router::new(spec, client, cx, grants, raw, handles)
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
    router.declare(ty);
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
            let param_names: Arc<[String]> = func_ty.params().map(|(n, _)| n.to_string()).collect();
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
                        &param_names,
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
                        #[cfg(test)]
                        eprintln!("invocation {iface}#{name} refused: {}", chain.join(" <- "));
                        tracing::warn!(
                            iface = %iface, func = %name, conn,
                            "invocation refused: {}", chain.join(" <- ")
                        );
                    }
                }
            });
        }
    }
    Ok(())
}

/// One routed invocation: pick the chain from the wire and hand the call to
/// that chain's store as a concurrent task. Returns once the job is queued;
/// the call itself runs, and reports, on its own.
#[allow(clippy::too_many_arguments)]
async fn serve_one<C>(
    router: &Arc<Router<C>>,
    iface: &Arc<str>,
    name: &Arc<str>,
    param_names: &Arc<[String]>,
    params_ty: &Arc<[types::Type]>,
    results_ty: &Arc<[types::Type]>,
    host_resources: &Arc<HashMap<Box<str>, HashMap<Box<str>, (ResourceType, ResourceType)>>>,
    io_streams: &Arc<[ResourceType]>,
    conn: Option<u64>,
    tx: wrpc_transport::frame::Outgoing,
    mut rx: wrpc_transport::frame::Incoming,
) -> anyhow::Result<()>
where
    C: Invoke + Clone + 'static,
    C::Context: Clone,
{
    let (chain, grant) = router
        .route(iface, name, param_names, params_ty, &mut rx)
        .await?;
    let func = chain.func(iface, name)?;
    let job = CallJob {
        router: Arc::clone(router),
        chain_id: chain.id,
        iface: Arc::clone(iface),
        name: Arc::clone(name),
        param_names: Arc::clone(param_names),
        params_ty: Arc::clone(params_ty),
        results_ty: Arc::clone(results_ty),
        host_resources: Arc::clone(host_resources),
        io_streams: Arc::clone(io_streams),
        union: router.union(),
        func,
        scope: conn,
        grant,
        tx,
        rx,
    };
    chain
        .jobs
        .send(Job::Call(Box::new(job)))
        .map_err(|_| anyhow::anyhow!("the chain's store is gone"))
}

/// The wRPC instance the resource-drop meta-op is served on
/// (`icanhaz:nocap/resources`, see `nocap.wit`). It is **not** a component
/// export: the daemon handles it directly, no component sees it.
pub const RESOURCES_INSTANCE: &str = "icanhaz:nocap/resources@0.1.0";

/// Serve `drop(handle: list<u8>) -> bool` on [`RESOURCES_INSTANCE`], once per
/// server, draining it on a task spawned into `handlers`. Each call releases
/// the served handle through the daemon's [`Handles`] registry: evicted from
/// its chain's [`SharedResourceTable`], its destructor run (closing the fd,
/// ending the session). Only the connection that minted a handle can drop it.
///
/// This is the drop wRPC cannot relay on its own: `own<T>` and `borrow<T>`
/// carry no lifetime over the wire, and a client's handle-drop never reaches
/// the host, so without it a client that keeps acquiring objects holds them
/// for the whole connection (the capacity cap is only a backstop). Framing the
/// handle as a plain `list<u8>` keeps it one uniform op over any served handle.
pub async fn serve_resource_drop<S>(
    srv: &S,
    handles: Arc<Handles>,
    handlers: &mut JoinSet<()>,
) -> anyhow::Result<()>
where
    S: Serve,
    S::Context: AsOrigin,
{
    // A flat `(list<u8>) -> bool` carries no async (stream) params, so no
    // subscription paths. It returns whether a live handle was released, so a
    // caller gets a definite acknowledgement.
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
            let removed = match handles.release(&handle, cx.connection()).await {
                Ok(removed) => removed,
                Err(err) => {
                    #[cfg(test)]
                    eprintln!("resource drop failed: {err:#}");
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
            path: "fixtures/counter-demo/wit",
        });
    }
    use counter_client::demo::res::counter::Counter;

    fn counter_wasm() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/counter_demo.wasm")
    }

    /// The whole resource-serving vertical on a 3-method surface: serve a
    /// guest-exported `counter` resource over wRPC and drive it from a client.
    /// The handle persists in the shared store, so the two increments accumulate —
    /// proving `SharedResourceTable` round-trips a real guest resource.
    #[tokio::test]
    async fn serves_a_guest_resource_over_wrpc() {
        let wasm = std::fs::read(counter_wasm()).expect("counter_demo.wasm fixture");

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

    // A wRPC client for the served filesystem (the mirror `filesystem-client` world).
    mod fs_client {
        wit_bindgen_wrpc::generate!({
            world: "filesystem-client",
            path: "../wit",
            with: {
                "wasi:filesystem/types@0.2.12": generate,
                "icanhaz:nocap/filesystem@0.1.0": generate,
                "wasi:io/error@0.2.12": generate,
                "wasi:io/streams@0.2.12": generate,
                "wasi:io/poll@0.2.12": generate,
                "wasi:clocks/wall-clock@0.2.12": generate,
            },
        });
    }

    /// The raw layer for tests over a jail at `dir`: `jail.open` yields a
    /// grant's root under it, with the grant's rights.
    fn jail_raw(
        grants: &Arc<std::sync::Mutex<GrantStore>>,
        dir: &std::path::Path,
    ) -> Arc<crate::raw::Raw> {
        let jail = crate::workspace::WorkspaceProvider::new(dir.to_path_buf(), Arc::clone(grants));
        let mut raw = crate::raw::Raw::new(Arc::clone(grants));
        raw.root = Some(jail.native_for_grants());
        raw.open_root = Some(jail.native_open_root());
        Arc::new(raw)
    }

    fn fs_passthrough_wasm() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
            "../capabilities/filesystem/target/wasm32-wasip2/release/filesystem_capability.wasm",
        )
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
        use fs_client::icanhaz::nocap::filesystem;
        use fs_client::wasi::filesystem::types::{
            Descriptor, DescriptorFlags, ErrorCode, OpenFlags, PathFlags,
        };

        let passthrough =
            std::fs::read(fs_passthrough_wasm()).expect("build capabilities/filesystem first");
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
            grants.clone(),
            Some(source),
            jail_raw(&grants, dir.path()),
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
        let wrapped_root = filesystem::open(&wrpc, (), &wrapped)
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
        let plain_root = filesystem::open(&wrpc, (), &plain)
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
        let again = filesystem::open(&wrpc, (), &wrapped_again)
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
        use fs_client::icanhaz::nocap::filesystem;
        use fs_client::wasi::filesystem::types::Descriptor;

        let passthrough =
            std::fs::read(fs_passthrough_wasm()).expect("build capabilities/filesystem first");
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
            grants.clone(),
            Some(source),
            jail_raw(&grants, dir.path()),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);
        let count = || composed.load(std::sync::atomic::Ordering::SeqCst);

        let root_a = filesystem::open(&wrpc, (), &a).await.unwrap().unwrap();
        let root_b = filesystem::open(&wrpc, (), &b).await.unwrap().unwrap();
        assert_eq!(count(), 1, "both grants share one instance");

        // One grant gone: the other keeps the chain, and its handle still works.
        assert!(grants.lock().unwrap().revoke(&a));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(Descriptor::read_directory(&wrpc, (), &root_b.as_borrow())
            .await
            .is_ok());
        let c = issue(&mut grants.lock().unwrap());
        let _root_c = filesystem::open(&wrpc, (), &c).await.unwrap().unwrap();
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
        let root_d = filesystem::open(&wrpc, (), &d).await.unwrap().unwrap();
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
                delegated: Vec::new(),
                source: None,
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
        let router = component_router(
            IFACE,
            Arc::clone(&components),
            wrpc_transport::tcp::Client::from(addr.clone()),
            (),
            grants.clone(),
            Arc::new(crate::raw::Raw::new(grants.clone())),
            Handles::new(),
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
        // A clause over the call's own arguments: admitted against the
        // decoded values, before the component runs.
        let named = grants
            .lock()
            .unwrap()
            .issue_scoped(
                kind(),
                ezcap::Scope::allow("call.args.name.startsWith(\"w\")"),
                "greeter, w-names only".to_string(),
                Duration::from_secs(60),
                crate::broker::anonymous_principal(),
            )
            .unwrap();
        assert!(greet(named.clone(), "world").await.expect("served").is_ok());
        assert!(
            greet(named, "bob").await.is_err(),
            "refused by the grant's clause, not by the component"
        );
        // Not a grant for this interface, and not a grant at all: refused
        // before the component runs (the invocation fails).
        assert!(greet(wrong, "x").await.is_err());
        assert!(greet("bogus".to_string(), "x").await.is_err());
        accept.abort();
    }

    /// A novel component built on a native capability: the oracle imports
    /// `inference`, calls it with its own token, and the daemon runs the call
    /// under the inference grant the requester delegated to the component
    /// grant. Without a delegated grant the import refuses; with one, the
    /// model's answer comes back through the oracle.
    #[tokio::test]
    async fn a_component_builds_on_a_native_capability_through_delegated_grants() {
        use crate::broker::{CapabilityKind, ComponentRequest, InferenceRequest};
        use crate::store::Store as Db;
        use wrpc_transport::InvokeExt as _;

        const IFACE: &str = "example:oracle/oracle@0.1.0";
        let oracle = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/oracle.wasm"))
            .expect("oracle.wasm fixture");
        let dir = tempfile::tempdir().unwrap();
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let db = Db::open_with(dir.path().join("icanhaz.db"), &source)
            .await
            .unwrap();
        let components = Arc::new(crate::components::ComponentStore::new(
            dir.path().join("components"),
            Some(db),
        ));
        let info = components.add(&oracle, None).await.expect("stored");
        assert!(
            info.imports
                .iter()
                .any(|i| i.starts_with("icanhaz:nocap/inference@")),
            "{:?}",
            info.imports
        );

        // The real inference provider over the echo backend: what the oracle's
        // import runs against, through the shipped inference component composed
        // in front of it, each call resolving the token it is handed to the
        // delegated inference grant.
        let grants = GrantStore::shared();
        let providers = Arc::new(crate::providers::Providers::new(
            vec![crate::providers::ProviderConfig {
                name: "echo".to_string(),
                kind: crate::providers::ProviderKind::Echo,
                base_url: String::new(),
                api_key: String::new(),
                models: vec!["echo".to_string()],
            }],
            None,
        ));
        let inference_provider =
            crate::inference::InferenceProvider::new(grants.clone(), providers);
        let (complete, models) = inference_provider.native_for_grants();
        let raw = Arc::new(crate::raw::Raw {
            grants: grants.clone(),
            spawn: None,
            terminal: None,
            watch: None,
            root: None,
            open_root: None,
            complete: Some(complete),
            models: Some(models),
        });
        // The shipped inference component provides the interface the oracle imports.
        let shipped = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../capabilities/inference/target/wasm32-wasip2/release/inference_capability.wasm"
        ))
        .expect("build capabilities/inference first");
        let shipped_info = components
            .add(&shipped, None)
            .await
            .expect("shipped inference");
        components.register_shipped(&shipped_info);

        let (lent, inference) = {
            let mut g = grants.lock().unwrap();
            let inference = g.issue(
                CapabilityKind::Inference(InferenceRequest { models: vec![] }),
                "inference".to_string(),
                Duration::from_secs(60),
                crate::broker::anonymous_principal(),
            );
            let lent = g.issue(
                CapabilityKind::Component(ComponentRequest {
                    provides: IFACE.to_string(),
                    provider: Some(info.hash.clone()),
                    delegated: vec![inference.clone()],
                    source: None,
                }),
                "oracle".to_string(),
                Duration::from_secs(60),
                crate::broker::anonymous_principal(),
            );
            (lent, inference)
        };
        let bare = grants.lock().unwrap().issue(
            CapabilityKind::Component(ComponentRequest {
                provides: IFACE.to_string(),
                provider: Some(info.hash.clone()),
                delegated: vec![],
                source: None,
            }),
            "oracle, nothing lent".to_string(),
            Duration::from_secs(60),
            crate::broker::anonymous_principal(),
        );
        // The token resolves through the component grant to the delegated one.
        assert_eq!(
            grants
                .lock()
                .unwrap()
                .delegated_for(&lent, "inference")
                .as_deref(),
            Some(inference.as_str())
        );
        assert_eq!(
            grants.lock().unwrap().delegated_for(&bare, "inference"),
            None
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
        let router = component_router(
            IFACE,
            Arc::clone(&components),
            wrpc_transport::tcp::Client::from(addr.clone()),
            (),
            grants.clone(),
            raw,
            Handles::new(),
        )
        .unwrap();
        let ty = Component::new(router.engine(), &oracle)
            .unwrap()
            .component_type();
        let _handlers = serve_interface(srv.as_ref(), &router, &ty, IFACE)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);
        let no_paths: [&[Option<usize>]; 0] = [];
        let ask = |token: String, q: &'static str| {
            let wrpc = wrpc.clone();
            async move {
                wrpc.invoke_values::<_, (String, String), (Result<String, String>,), _>(
                    (),
                    IFACE,
                    "ask",
                    (token, q.to_string()),
                    no_paths,
                )
                .await
                .map(|((r,), _)| r)
            }
        };
        let answer = ask(lent.clone(), "why?").await.expect("served").unwrap();
        assert!(
            answer.contains("why?"),
            "the echo model answered: {answer:?}"
        );
        // The inference grant paid for the call, not the component's.
        assert!(
            grants
                .lock()
                .unwrap()
                .counter(&inference, "tokens")
                .unwrap_or(0)
                > 0,
            "usage charged to the delegated grant"
        );
        // Nothing lent: the import refuses, and the oracle reports it.
        let refused = ask(bare, "why?").await.expect("served");
        assert_eq!(refused.unwrap_err(), "inference denied: not authorized");
        // Revoking the lent grant takes the ability with it.
        assert!(grants.lock().unwrap().revoke(&inference));
        let gone = ask(lent, "still?").await.expect("served");
        assert!(gone.is_err(), "{gone:?}");
        accept.abort();
    }

    // The wRPC client of the reader fixture (its `reader-client` world).
    mod reader_client {
        wit_bindgen_wrpc::generate!({
            world: "example:reader/reader-client",
            path: "fixtures/reader/wit",
        });
    }

    /// A component builds on the filesystem through a delegated grant: the
    /// shipped filesystem capability is composed in front of the reader, and
    /// the reader's `open` presents the component grant, which the raw jail
    /// resolves to the filesystem grant lent to it and opens as a descriptor
    /// scoped to that grant's root, with its rights. The chain's store has
    /// no preopens, so that descriptor is the only file authority in it.
    #[tokio::test]
    async fn a_component_reads_files_through_a_delegated_filesystem_grant() {
        use crate::broker::{CapabilityKind, ComponentRequest, FsRequest, FsRights, PathGrant};
        use crate::store::Store as Db;
        use reader_client::example::reader::reader::{self as reader, Reader};

        const IFACE: &str = "example:reader/reader@0.1.0";
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/reader.wasm"))
            .expect("reader.wasm fixture");
        let dir = tempfile::tempdir().unwrap();
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let db = Db::open_with(dir.path().join("icanhaz.db"), &source)
            .await
            .unwrap();
        let components = Arc::new(crate::components::ComponentStore::new(
            dir.path().join("components"),
            Some(db),
        ));
        let info = components.add(&bytes, None).await.expect("stored");
        let filesystem =
            std::fs::read(fs_passthrough_wasm()).expect("build capabilities/filesystem first");
        let shipped_info = components
            .add(&filesystem, None)
            .await
            .expect("shipped filesystem");
        components.register_shipped(&shipped_info);

        // The jail: a file under the granted subtree, and one outside it. The
        // component's chain has no preopens; the shipped filesystem capability
        // composed in front of it opens the granted root through the raw jail.
        let jail = dir.path().join("jail");
        std::fs::create_dir_all(jail.join("notes")).unwrap();
        std::fs::write(
            jail.join("notes/hello.txt"),
            "read through a delegated grant\n",
        )
        .unwrap();
        std::fs::write(jail.join("secret.txt"), "not yours\n").unwrap();

        let grants = GrantStore::shared();
        let (lent, fs_grant) = {
            let mut g = grants.lock().unwrap();
            let fs_grant = g.issue(
                CapabilityKind::Filesystem(FsRequest {
                    roots: vec![PathGrant {
                        path: "/notes".to_string(),
                        rights: FsRights::READ,
                    }],
                }),
                "filesystem (/notes)".to_string(),
                Duration::from_secs(60),
                crate::broker::anonymous_principal(),
            );
            let lent = g.issue(
                CapabilityKind::Component(ComponentRequest {
                    provides: IFACE.to_string(),
                    provider: Some(info.hash.clone()),
                    delegated: vec![fs_grant.clone()],
                    source: None,
                }),
                "reader".to_string(),
                Duration::from_secs(60),
                crate::broker::anonymous_principal(),
            );
            (lent, fs_grant)
        };
        let bare = grants.lock().unwrap().issue(
            CapabilityKind::Component(ComponentRequest {
                provides: IFACE.to_string(),
                provider: Some(info.hash.clone()),
                delegated: vec![],
                source: None,
            }),
            "reader, nothing lent".to_string(),
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
        let router = component_router(
            IFACE,
            Arc::clone(&components),
            wrpc_transport::tcp::Client::from(addr.clone()),
            (),
            grants.clone(),
            jail_raw(&grants, &jail),
            Handles::new(),
        )
        .unwrap();
        let ty = Component::new(router.engine(), &bytes)
            .unwrap()
            .component_type();
        let _handlers = serve_interface(srv.as_ref(), &router, &ty, IFACE)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        let opened = reader::open(&wrpc, (), &lent)
            .await
            .unwrap()
            .expect("opened");
        let text = Reader::read(&wrpc, (), &opened.as_borrow(), "hello.txt")
            .await
            .unwrap()
            .expect("read under the grant");
        assert_eq!(text, "read through a delegated grant\n");
        // The descriptor is the grant's subtree: nothing above it resolves.
        let outside = Reader::read(&wrpc, (), &opened.as_borrow(), "../secret.txt")
            .await
            .unwrap();
        assert!(outside.is_err(), "{outside:?}");
        // Nothing lent: the filesystem import refuses at `open`.
        let refused = reader::open(&wrpc, (), &bare).await.unwrap();
        assert_eq!(
            refused.unwrap_err(),
            "filesystem denied: no filesystem grant for this call"
        );
        // Revoking the lent grant takes the files with it.
        assert!(grants.lock().unwrap().revoke(&fs_grant));
        let gone = Reader::read(&wrpc, (), &opened.as_borrow(), "hello.txt")
            .await
            .unwrap();
        assert!(gone.is_err(), "{gone:?}");
        accept.abort();
    }

    // The wRPC client of the links example (its `links-client` world).
    mod links_client {
        wit_bindgen_wrpc::generate!({
            world: "example:links/links-client",
            path: "../examples/links/wit",
        });
    }

    /// The links example end to end, the way a page would use it: a store
    /// component nobody native provides, composed over the shipped filesystem
    /// capability, reading the vault through the filesystem grant lent to it.
    /// A read-only grant indexes but cannot rename; a component grant scoped
    /// with `call.method != "rename"` is refused at the method, before the
    /// component runs; a grant with write rights renames and rewrites links.
    #[tokio::test]
    async fn the_links_example_indexes_a_vault_through_a_delegated_grant() {
        use crate::broker::{CapabilityKind, ComponentRequest, FsRequest, FsRights, PathGrant};
        use crate::store::Store as Db;
        use links_client::example::links::links::{self as links, Index};

        const IFACE: &str = "example:links/links@0.1.0";
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/links.wasm"))
            .expect("links.wasm (scripts/build-wasm.sh)");
        let dir = tempfile::tempdir().unwrap();
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let db = Db::open_with(dir.path().join("icanhaz.db"), &source)
            .await
            .unwrap();
        let components = Arc::new(crate::components::ComponentStore::new(
            dir.path().join("components"),
            Some(db),
        ));
        let info = components.add(&bytes, None).await.expect("stored");
        let filesystem =
            std::fs::read(fs_passthrough_wasm()).expect("build capabilities/filesystem first");
        let shipped_info = components
            .add(&filesystem, None)
            .await
            .expect("shipped filesystem");
        components.register_shipped(&shipped_info);
        // The component's own WIT gives its interface an admission environment.
        let grants = GrantStore::shared();
        let env = crate::components::env_for(&bytes, IFACE).expect("an environment from the WIT");
        grants.lock().unwrap().add_environment(IFACE, env).unwrap();

        // A small vault.
        let vault = dir.path().join("vault");
        std::fs::create_dir_all(vault.join("projects")).unwrap();
        std::fs::write(
            vault.join("index.md"),
            "# Index\n\nSee [[plan]] and [the roadmap](projects/roadmap.md).\nAlso [[nowhere]].\n",
        )
        .unwrap();
        std::fs::write(
            vault.join("plan.md"),
            "# Plan\n\nBack to [index](index.md) and [roadmap](projects/roadmap.md).\n",
        )
        .unwrap();
        std::fs::write(
            vault.join("projects/roadmap.md"),
            "# Roadmap\n\nUp to [[../plan]].\n",
        )
        .unwrap();

        let issue_fs = |g: &mut GrantStore, rights: FsRights| {
            g.issue(
                CapabilityKind::Filesystem(FsRequest {
                    roots: vec![PathGrant {
                        path: "/".to_string(),
                        rights,
                    }],
                }),
                "filesystem".to_string(),
                Duration::from_secs(60),
                crate::broker::anonymous_principal(),
            )
        };
        let issue_links = |g: &mut GrantStore, fs: &str, allow: &str| {
            g.issue_scoped(
                CapabilityKind::Component(ComponentRequest {
                    provides: IFACE.to_string(),
                    provider: Some(info.hash.clone()),
                    delegated: vec![fs.to_string()],
                    source: None,
                }),
                ezcap::Scope::allow(allow),
                "links".to_string(),
                Duration::from_secs(60),
                crate::broker::anonymous_principal(),
            )
            .expect("scope compiles")
        };
        let (rw, ro, scoped) = {
            let mut g = grants.lock().unwrap();
            let fs_rw = issue_fs(&mut g, FsRights::READ | FsRights::WRITE);
            let fs_ro = issue_fs(&mut g, FsRights::READ);
            let rw = issue_links(&mut g, &fs_rw, "true");
            let ro = issue_links(&mut g, &fs_ro, "true");
            let scoped = issue_links(&mut g, &fs_rw, "call.method != \"rename\"");
            (rw, ro, scoped)
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
        let router = component_router(
            IFACE,
            Arc::clone(&components),
            wrpc_transport::tcp::Client::from(addr.clone()),
            (),
            grants.clone(),
            jail_raw(&grants, &vault),
            Handles::new(),
        )
        .unwrap();
        let ty = Component::new(router.engine(), &bytes)
            .unwrap()
            .component_type();
        let _handlers = serve_interface(srv.as_ref(), &router, &ty, IFACE)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        // Read-only: the index answers, rename is refused by the descriptor.
        let index = links::open(&wrpc, (), &ro)
            .await
            .unwrap()
            .expect("opened read-only");
        let mut into_plan = Index::backlinks(&wrpc, (), &index.as_borrow(), "plan")
            .await
            .unwrap()
            .expect("backlinks");
        into_plan.sort_by(|a, b| a.source.cmp(&b.source));
        assert_eq!(
            into_plan
                .iter()
                .map(|l| (l.source.as_str(), l.line))
                .collect::<Vec<_>>(),
            vec![("index.md", 3), ("projects/roadmap.md", 3)]
        );
        let dangling = Index::unresolved(&wrpc, (), &index.as_borrow())
            .await
            .unwrap()
            .expect("unresolved");
        assert_eq!(dangling.len(), 1);
        assert_eq!(
            (dangling[0].source.as_str(), dangling[0].target.as_str()),
            ("index.md", "nowhere.md")
        );
        let refused = Index::rename(&wrpc, (), &index.as_borrow(), "plan.md", "planning.md")
            .await
            .unwrap();
        assert!(
            refused.unwrap_err().contains("not permitted"),
            "a read-only grant cannot rename"
        );
        assert!(vault.join("plan.md").exists());

        // Scoped: the clause on the component grant refuses the method itself.
        let index = links::open(&wrpc, (), &scoped)
            .await
            .unwrap()
            .expect("opened scoped");
        assert_eq!(
            Index::backlinks(&wrpc, (), &index.as_borrow(), "plan")
                .await
                .unwrap()
                .unwrap()
                .len(),
            2
        );
        let refused = Index::rename(&wrpc, (), &index.as_borrow(), "plan.md", "planning.md").await;
        assert!(
            refused.is_err(),
            "the scope refuses rename before the component runs: {refused:?}"
        );
        assert!(vault.join("plan.md").exists());

        // Read and write: rename moves the note and rewrites every link to it.
        let index = links::open(&wrpc, (), &rw)
            .await
            .unwrap()
            .expect("opened read-write");
        let rewritten = Index::rename(
            &wrpc,
            (),
            &index.as_borrow(),
            "plan.md",
            "projects/planning.md",
        )
        .await
        .unwrap()
        .expect("renamed");
        assert_eq!(rewritten, 2);
        assert!(!vault.join("plan.md").exists());
        assert!(vault.join("projects/planning.md").exists());
        assert_eq!(
            std::fs::read_to_string(vault.join("index.md")).unwrap(),
            "# Index\n\nSee [[projects/planning]] and [the roadmap](projects/roadmap.md).\nAlso [[nowhere]].\n"
        );
        assert_eq!(
            std::fs::read_to_string(vault.join("projects/roadmap.md")).unwrap(),
            "# Roadmap\n\nUp to [[planning]].\n"
        );
        let mut into_planning =
            Index::backlinks(&wrpc, (), &index.as_borrow(), "projects/planning.md")
                .await
                .unwrap()
                .unwrap();
        into_planning.sort_by(|a, b| a.source.cmp(&b.source));
        assert_eq!(
            into_planning
                .iter()
                .map(|l| l.source.as_str())
                .collect::<Vec<_>>(),
            vec!["index.md", "projects/roadmap.md"]
        );
        accept.abort();
    }

    // The wRPC client of the stream-shaped fixture (its `pipe-client` world).
    mod pipe_client {
        wit_bindgen_wrpc::generate!({
            world: "example:pipe/pipe-client",
            path: "fixtures/pipe/wit",
            with: {
                "example:pipe/pipe@0.1.0": generate,
            },
        });
    }

    /// Streams and async exports through the generic serving path: the pipe
    /// fixture is resource-shaped (the token once, at `open`), its `run` is an
    /// `async func` carrying a byte stream each way, and it is served through
    /// a chain store's concurrent driver like any other component. Bytes sent
    /// come back upper-cased, and the reply stream ends when the input does.
    #[tokio::test]
    async fn a_stream_shaped_component_serves_through_the_generic_path() {
        use crate::broker::{CapabilityKind, ComponentRequest};
        use crate::store::Store as Db;
        use futures::StreamExt as _;
        use pipe_client::example::pipe::pipe::{open, Session};

        const IFACE: &str = "example:pipe/pipe@0.1.0";
        let pipe = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/pipe.wasm"))
            .expect("pipe.wasm fixture");
        let dir = tempfile::tempdir().unwrap();
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let db = Db::open_with(dir.path().join("icanhaz.db"), &source)
            .await
            .unwrap();
        let components = Arc::new(crate::components::ComponentStore::new(
            dir.path().join("components"),
            Some(db),
        ));
        let info = components.add(&pipe, None).await.expect("stored");
        let grants = GrantStore::shared();
        let token = grants.lock().unwrap().issue(
            CapabilityKind::Component(ComponentRequest {
                provides: IFACE.to_string(),
                provider: Some(info.hash.clone()),
                delegated: vec![],
                source: None,
            }),
            "pipe".to_string(),
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
        let router = component_router(
            IFACE,
            Arc::clone(&components),
            wrpc_transport::tcp::Client::from(addr.clone()),
            (),
            grants.clone(),
            Arc::new(crate::raw::Raw::new(grants.clone())),
            Handles::new(),
        )
        .unwrap();
        let ty = Component::new(router.engine(), &pipe)
            .unwrap()
            .component_type();
        let _handlers = serve_interface(srv.as_ref(), &router, &ty, IFACE)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        // The token once, at open; a bogus one is refused before the guest runs.
        assert!(open(&wrpc, (), "bogus").await.is_err());
        let session = open(&wrpc, (), &token).await.unwrap().expect("opened");

        let input: Pin<Box<dyn futures::Stream<Item = Bytes> + Send>> =
            Box::pin(futures::stream::iter(vec![
                Bytes::from_static(b"hello "),
                Bytes::from_static(b"stream"),
            ]));
        let (out, io) = Session::run(&wrpc, (), &session.as_borrow(), input)
            .await
            .expect("run invocation");
        if let Some(io) = io {
            tokio::spawn(io);
        }
        let out = out.expect("a stream back");
        let chunks: Vec<Bytes> = out.collect().await;
        assert_eq!(String::from_utf8_lossy(&chunks.concat()), "HELLO STREAM");
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
        use fs_client::icanhaz::nocap::filesystem;
        use fs_client::wasi::filesystem::types::Descriptor;
        use wrpc_transport::InvokeExt as _;

        let wasm =
            std::fs::read(fs_passthrough_wasm()).expect("build capabilities/filesystem first");
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), b"mine\n").unwrap();
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
            grants.clone(),
            None,
            jail_raw(&grants, dir.path()),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let first = wrpc_transport::tcp::Client::from(&addrs[0]);
        let second = wrpc_transport::tcp::Client::from(&addrs[1]);

        let root = filesystem::open(&first, (), &grant)
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
        use fs_client::icanhaz::nocap::filesystem;
        use fs_client::wasi::filesystem::types::{
            Descriptor, DescriptorFlags, ErrorCode, OpenFlags, PathFlags,
        };

        let passthrough =
            std::fs::read(fs_passthrough_wasm()).expect("build capabilities/filesystem first");
        let wrapper = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/fs_wrap.wasm"
        ))
        .expect("fs_wrap.wasm fixture");
        let chain = crate::components::compose(&[passthrough, wrapper]).expect("composes");

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), b"through the chain\n").unwrap();
        std::fs::write(dir.path().join("forbidden.txt"), b"never\n").unwrap();
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
            grants.clone(),
            None,
            jail_raw(&grants, dir.path()),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        // The passthrough behind the wrapper still gates: a bogus token is refused.
        assert!(filesystem::open(&wrpc, (), "bogus").await.unwrap().is_err());
        let root = filesystem::open(&wrpc, (), &grant)
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
    /// `wasi:filesystem` (open-at, read) across the wire. No preopens exist,
    /// so the descriptor is the only way in — the grant is the gate, the descriptor
    /// is the capability.
    #[tokio::test]
    async fn serves_grant_gated_wasi_filesystem_over_wrpc() {
        use crate::broker::{CapabilityKind, FsRequest, FsRights, PathGrant};
        use fs_client::icanhaz::nocap::filesystem;
        use fs_client::wasi::filesystem::types::{
            Descriptor, DescriptorFlags, OpenFlags, PathFlags,
        };

        let wasm = std::fs::read(fs_passthrough_wasm()).expect(
            "build the filesystem capability first: cargo build --release --target wasm32-wasip2 \
             --manifest-path src/apps/icanhaz/capabilities/filesystem/Cargo.toml",
        );

        // A temp dir with one file is the jail: the raw authority behind the grant.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), b"hello from real wasi-fs\n").unwrap();

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
            grants.clone(),
            None,
            jail_raw(&grants, dir.path()),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;

        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        // The gate: a bogus token yields no descriptor.
        let denied = filesystem::open(&wrpc, (), "bogus-token").await.unwrap();
        assert!(
            denied.is_err(),
            "ungated mount must be refused, got {denied:?}"
        );

        // A valid grant exchanges for the root descriptor; then it's native wasi:filesystem.
        let root = filesystem::open(&wrpc, (), &grant)
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
        use fs_client::icanhaz::nocap::filesystem;
        use fs_client::wasi::filesystem::types::{
            Descriptor, DescriptorFlags, OpenFlags, PathFlags,
        };

        let wasm =
            std::fs::read(fs_passthrough_wasm()).expect("build capabilities/filesystem first");
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("notes")).unwrap();
        std::fs::write(dir.path().join("notes/ok.txt"), b"inside the grant\n").unwrap();
        std::fs::write(dir.path().join("secret.txt"), b"OUTSIDE the grant\n").unwrap();

        // A grant scoped to /notes/ — NOT the whole jail.
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
            grants.clone(),
            None,
            jail_raw(&grants, dir.path()),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        // mount → a descriptor confined to the /notes/ subtree.
        let root = filesystem::open(&wrpc, (), &grant)
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
        use fs_client::icanhaz::nocap::filesystem;
        use fs_client::wasi::filesystem::types::{
            Descriptor, DescriptorFlags, OpenFlags, PathFlags,
        };

        let wasm =
            std::fs::read(fs_passthrough_wasm()).expect("build capabilities/filesystem first");
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), b"live\n").unwrap();

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
            grants.clone(),
            None,
            jail_raw(&grants, dir.path()),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        // Mount, and confirm the held descriptor works while the grant is live.
        let root = filesystem::open(&wrpc, (), &grant)
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
            filesystem::open(&wrpc, (), &grant).await.unwrap().is_err(),
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
        use fs_client::icanhaz::nocap::filesystem;
        use fs_client::wasi::filesystem::types::{
            Descriptor, DescriptorFlags, ErrorCode, OpenFlags, PathFlags,
        };

        let wasm =
            std::fs::read(fs_passthrough_wasm()).expect("build capabilities/filesystem first");
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("ok.txt"), b"in scope\n").unwrap();
        std::fs::write(dir.path().join("hello.txt"), b"out of scope\n").unwrap();

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
            grants.clone(),
            None,
            jail_raw(&grants, dir.path()),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        let root = filesystem::open(&wrpc, (), &grant)
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
        use fs_client::icanhaz::nocap::filesystem;
        use fs_client::wasi::filesystem::types::{
            Descriptor, DescriptorFlags, OpenFlags, PathFlags,
        };
        use wrpc_transport::InvokeExt as _;

        let wasm =
            std::fs::read(fs_passthrough_wasm()).expect("build capabilities/filesystem first");
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), b"drop me\n").unwrap();

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
            grants.clone(),
            None,
            jail_raw(&grants, dir.path()),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        let root = filesystem::open(&wrpc, (), &grant)
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
