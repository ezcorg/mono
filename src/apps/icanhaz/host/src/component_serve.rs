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

use core::ops::Bound;
use core::pin::pin;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use anyhow::Context as _;
use futures::StreamExt as _;
use tokio::sync::Mutex;
use tokio::task::JoinSet;
use wasmtime::component::{Component, Instance, Linker, ResourceTable, ResourceType, types};
use wasmtime::{Engine, Store};

use crate::broker::GrantStore;
use wasmtime_wasi::p2::bindings::io;
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};
use wrpc_transport::{Invoke, Serve};
use wrpc_wasmtime::{
    RemoteResource, ServeExt as _, SharedResourceTable, WrpcCtxView, WrpcView,
    collect_component_resource_exports, collect_component_resource_imports,
};

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
        WasiCtxView { ctx: &mut self.wasi, table: &mut self.table }
    }
}

impl<C: Invoke> WrpcView for CompState<C>
where
    C::Context: Clone,
{
    type Invoke = C;
    fn wrpc(&mut self) -> WrpcCtxView<'_, C> {
        WrpcCtxView { ctx: &mut self.rpc, table: &mut self.table }
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
    let io_in = io_resources(&imports, "wasi:io/streams@0.2", "wasi:io/streams@0.3", "input-stream");
    let io_out = io_resources(&imports, "wasi:io/streams@0.2", "wasi:io/streams@0.3", "output-stream");
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
            rpc: Rpc { client, cx, shared: SharedResourceTable::default() },
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
    drive_exports(srv, store, instance, &component.component_type(), &engine, guest_resources, host_resources, io_streams).await
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
        let types::ComponentItem::ComponentInstance(inst_ty) = item else { continue };
        for (name, types::ComponentExtern { ty: fitem, .. }) in inst_ty.exports(engine) {
            let types::ComponentItem::ComponentFunc(func_ty) = fitem else { continue };
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
                                let chain: Vec<String> = err.chain().map(|e| e.to_string()).collect();
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
        WasiCtxView { ctx: &mut self.wasi, table: &mut self.table }
    }
}

impl<C: Invoke> WrpcView for FsState<C>
where
    C::Context: Clone,
{
    type Invoke = C;
    fn wrpc(&mut self) -> WrpcCtxView<'_, C> {
        WrpcCtxView { ctx: &mut self.rpc, table: &mut self.table }
    }
}

/// Serve the gated `wasi:filesystem` passthrough over wRPC: link WASI + the consent
/// `gate` (host-validated against `grants`), instantiate the component once, and
/// serve its exports (`wasi:filesystem/types` + `mount`). `mount.open-root` calls
/// the gate, so it refuses any token that isn't a live `filesystem` grant — an
/// ungated peer never receives a descriptor. `wasi` carries the preopened root
/// (the jail).
/// Max live `wasi:filesystem` handles the fs component holds before refusing new ones
/// — a backstop against a client that opens descriptors without dropping them (this
/// wRPC build doesn't relay handle-drops). Exhaustion surfaces as an op error, not an
/// OOM. Override with `ICANHAZ_MAX_FS_HANDLES` (0 = unbounded).
fn max_fs_handles() -> usize {
    std::env::var("ICANHAZ_MAX_FS_HANDLES").ok().and_then(|v| v.parse().ok()).unwrap_or(4096)
}

pub async fn serve_filesystem<C, S>(
    srv: &S,
    component_bytes: &[u8],
    client: C,
    cx: C::Context,
    wasi: WasiCtx,
    grants: Arc<std::sync::Mutex<GrantStore>>,
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
    let mut linker = Linker::<FsState<C>>::new(&engine);
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
                    let res = grants
                        .lock()
                        .unwrap()
                        .validate_filesystem(&grant)
                        // Hand the component the granted root path to scope the descriptor to.
                        .map(|paths| paths.into_iter().next().unwrap_or_default())
                        .map_err(|d| format!("filesystem grant denied: {d:?}"));
                    Ok((res,))
                })
            },
        )
        .map_err(anyhow::Error::from)
        .context("link gate.authorize")?;

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
        FsState {
            table: ResourceTable::new(),
            wasi,
            rpc: Rpc { client, cx, shared: SharedResourceTable::with_capacity(max_fs_handles()) },
            grants,
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
    drive_exports(srv, store, instance, &component.component_type(), &engine, guest_resources, host_resources, io_streams).await
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

    fn fs_passthrough_wasm() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../policies/fs-passthrough/target/wasm32-wasip2/debug/fs_passthrough.wasm")
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
        use fs_client::wasi::filesystem::types::{Descriptor, DescriptorFlags, OpenFlags, PathFlags};
        use wasmtime_wasi::{DirPerms, FilePerms};

        let wasm = std::fs::read(fs_passthrough_wasm()).expect(
            "build fs-passthrough first: cargo build --target wasm32-wasip2 \
             --manifest-path src/apps/icanhaz/policies/fs-passthrough/Cargo.toml",
        );

        // A temp dir with one file is the (preopen-jailed) raw authority.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), b"hello from real wasi-fs\n").unwrap();
        let mut builder = WasiCtxBuilder::new();
        builder
            .preopened_dir(dir.path(), "/", DirPerms::all(), FilePerms::all())
            .unwrap();
        let wasi = builder.build();

        // A live filesystem grant, as the broker would mint after consent.
        let grants = GrantStore::shared();
        let grant = grants.lock().unwrap().issue(
            CapabilityKind::Filesystem(FsRequest {
                roots: vec![PathGrant { path: "/".to_string(), rights: FsRights::READ | FsRights::WRITE }],
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
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;

        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        // The gate: a bogus token yields no descriptor.
        let denied = mount::open_root(&wrpc, (), "bogus-token").await.unwrap();
        assert!(denied.is_err(), "ungated mount must be refused, got {denied:?}");

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
        use fs_client::wasi::filesystem::types::{Descriptor, DescriptorFlags, OpenFlags, PathFlags};
        use wasmtime_wasi::{DirPerms, FilePerms};

        let wasm = std::fs::read(fs_passthrough_wasm()).expect("build fs-passthrough first");
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("notes")).unwrap();
        std::fs::write(dir.path().join("notes/ok.txt"), b"inside the grant\n").unwrap();
        std::fs::write(dir.path().join("secret.txt"), b"OUTSIDE the grant\n").unwrap();
        let mut builder = WasiCtxBuilder::new();
        builder.preopened_dir(dir.path(), "/", DirPerms::all(), FilePerms::all()).unwrap();
        let wasi = builder.build();

        // A grant scoped to /notes/ — NOT the whole preopen.
        let grants = GrantStore::shared();
        let grant = grants.lock().unwrap().issue(
            CapabilityKind::Filesystem(FsRequest {
                roots: vec![PathGrant { path: "/notes/".to_string(), rights: FsRights::READ | FsRights::WRITE }],
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
        let in_scope = Descriptor::open_at(&wrpc, (), &root.as_borrow(), &PathFlags::empty(), "ok.txt", &OpenFlags::empty(), &DescriptorFlags::READ)
            .await
            .unwrap();
        assert!(in_scope.is_ok(), "in-scope open must succeed, got {in_scope:?}");

        // Out of scope: ../secret.txt escapes the granted subtree → denied by the sandbox.
        let escape = Descriptor::open_at(&wrpc, (), &root.as_borrow(), &PathFlags::empty(), "../secret.txt", &OpenFlags::empty(), &DescriptorFlags::READ)
            .await
            .unwrap();
        assert!(escape.is_err(), "escaping the granted subtree must be denied, got {escape:?}");

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
        use fs_client::wasi::filesystem::types::{Descriptor, DescriptorFlags, OpenFlags, PathFlags};
        use wasmtime_wasi::{DirPerms, FilePerms};

        let wasm = std::fs::read(fs_passthrough_wasm()).expect("build fs-passthrough first");
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), b"live\n").unwrap();
        let mut builder = WasiCtxBuilder::new();
        builder.preopened_dir(dir.path(), "/", DirPerms::all(), FilePerms::all()).unwrap();
        let wasi = builder.build();

        let grants = GrantStore::shared();
        let grant = grants.lock().unwrap().issue(
            CapabilityKind::Filesystem(FsRequest {
                roots: vec![PathGrant { path: "/".to_string(), rights: FsRights::READ | FsRights::WRITE }],
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
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        // Mount, and confirm the held descriptor works while the grant is live.
        let root = mount::open_root(&wrpc, (), &grant).await.unwrap().expect("mount with a valid grant");
        let before = Descriptor::open_at(&wrpc, (), &root.as_borrow(), &PathFlags::empty(), "hello.txt", &OpenFlags::empty(), &DescriptorFlags::READ)
            .await
            .unwrap();
        assert!(before.is_ok(), "open must succeed while the grant is live, got {before:?}");

        // Revoke — the client still holds the very same root descriptor handle.
        assert!(grants.lock().unwrap().revoke(&grant), "grant should have been live");

        // The next op on that descriptor is refused: revocation reaches the live handle.
        let after = Descriptor::open_at(&wrpc, (), &root.as_borrow(), &PathFlags::empty(), "hello.txt", &OpenFlags::empty(), &DescriptorFlags::READ)
            .await
            .unwrap();
        assert!(after.is_err(), "after revoke, ops on the held descriptor must be denied, got {after:?}");
        // And a fresh mount is refused too.
        assert!(mount::open_root(&wrpc, (), &grant).await.unwrap().is_err(), "a revoked grant can't re-mount");

        accept.abort();
    }
}
