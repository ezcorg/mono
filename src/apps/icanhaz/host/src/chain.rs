//! The resolver's runtime: a grant provided *through* store components. The
//! human chose them in the consent window (`GrantStore::via_of`, outermost
//! first); at the first call the daemon composes the ones that export the
//! provider's interface with wac into one component, instantiates it with the
//! native implementation as its import, and calls its export. Composition
//! and compilation are cached per chain.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Context as _;
use tokio::sync::Mutex;
use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{AsContextMut as _, Engine, Store};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

use crate::broker::GrantKind as _;
use crate::components::ComponentStore;

mod workspace_chain {
    wasmtime::component::bindgen!({
        world: "workspace-chain",
        path: "../wit",
        imports: { default: async | trappable },
        exports: { default: async },
    });
}

mod process_chain {
    wasmtime::component::bindgen!({
        world: "process-chain",
        path: "../wit",
        imports: { default: async | store | trappable },
        exports: { default: async | store },
    });
}

mod inference_chain {
    wasmtime::component::bindgen!({
        world: "inference-chain",
        path: "../wit",
        imports: { default: async | store | trappable },
        exports: { default: async | store },
    });
}

mod terminal_chain {
    wasmtime::component::bindgen!({
        world: "terminal-chain",
        path: "../wit",
        imports: { default: async | store | trappable },
        exports: { default: async | store },
    });
}

mod watch_chain {
    wasmtime::component::bindgen!({
        world: "watch-chain",
        path: "../wit",
        imports: { default: async | store | trappable },
        exports: { default: async | store },
    });
}

/// A byte stream as wRPC carries it.
pub type BoxStream = std::pin::Pin<Box<dyn futures::Stream<Item = bytes::Bytes> + Send>>;

/// What a provider hands the chain to run in front of: the native
/// implementation of one call, as a closure.
/// Each is synchronous: the native providers construct their streams without
/// awaiting, and wasmtime hands stream-carrying imports a synchronous store
/// access (the streams themselves are what is asynchronous).
pub type NativeSpawn =
    Arc<dyn Fn(String, Vec<String>, BoxStream) -> Result<BoxStream, String> + Send + Sync>;
pub type NativeComplete =
    Arc<dyn Fn(String, ClientRequest) -> Result<BoxStream, String> + Send + Sync>;
pub type NativeModels = Arc<dyn Fn(String) -> Result<Vec<(String, String)>, String> + Send + Sync>;
/// `terminal.open`: (grant, stdin, control, cols, rows) → output.
pub type NativeTerminal =
    Arc<dyn Fn(String, BoxStream, BoxStream, u16, u16) -> Result<BoxStream, String> + Send + Sync>;
/// `watch.open`: (grant, path, recursive) → events.
pub type NativeWatch = Arc<dyn Fn(String, String, bool) -> Result<BoxStream, String> + Send + Sync>;
/// `workspace.root-path`: grant → the jail's host path.
pub type NativeRoot = Arc<dyn Fn(String) -> Result<String, String> + Send + Sync>;

/// The native implementations a component's imports are satisfied from: what
/// a store component that builds on the daemon's own capabilities calls, each
/// resolving the token it is handed (the component's grant, whose delegated
/// grant of the right kind then applies).
#[derive(Clone)]
pub struct Natives {
    pub spawn: NativeSpawn,
    pub complete: NativeComplete,
    pub models: NativeModels,
    pub terminal: NativeTerminal,
    pub watch: NativeWatch,
    pub root: NativeRoot,
}

/// The import-side state of one store: every native interface linkable into
/// a component, each backed by its native implementation.
pub struct Imports {
    process: ProcessState,
    inference: InferenceState,
    terminal: TerminalState,
    watch: WatchState,
    workspace: ChainState,
}

impl Natives {
    /// Fresh import state for a store.
    pub fn imports(&self) -> Imports {
        Imports {
            process: ProcessState {
                table: ResourceTable::new(),
                wasi: WasiCtxBuilder::new().build(),
                native: self.spawn.clone(),
            },
            inference: InferenceState {
                table: ResourceTable::new(),
                wasi: WasiCtxBuilder::new().build(),
                complete: self.complete.clone(),
                models: self.models.clone(),
            },
            terminal: TerminalState {
                table: ResourceTable::new(),
                wasi: WasiCtxBuilder::new().build(),
                native: self.terminal.clone(),
            },
            watch: WatchState {
                table: ResourceTable::new(),
                wasi: WasiCtxBuilder::new().build(),
                native: self.watch.clone(),
            },
            workspace: ChainState {
                table: ResourceTable::new(),
                wasi: WasiCtxBuilder::new().build(),
                native_root: self.root.clone(),
            },
        }
    }
}

/// A store state that carries [`Imports`].
pub trait HasImports {
    fn imports(&mut self) -> &mut Imports;
}

/// Link every native capability interface into `linker`, so a component that
/// imports any of them instantiates.
pub fn link_imports<T: HasImports + Send + 'static>(linker: &mut Linker<T>) -> anyhow::Result<()> {
    process_chain::ProcessChain::add_to_linker::<_, ProcessData>(linker, |s: &mut T| {
        &mut s.imports().process
    })
    .map_err(anyhow::Error::from)
    .context("link process import")?;
    inference_chain::InferenceChain::add_to_linker::<_, InferenceData>(linker, |s: &mut T| {
        &mut s.imports().inference
    })
    .map_err(anyhow::Error::from)
    .context("link inference import")?;
    terminal_chain::TerminalChain::add_to_linker::<_, TerminalData>(linker, |s: &mut T| {
        &mut s.imports().terminal
    })
    .map_err(anyhow::Error::from)
    .context("link terminal import")?;
    watch_chain::WatchChain::add_to_linker::<_, WatchData>(linker, |s: &mut T| {
        &mut s.imports().watch
    })
    .map_err(anyhow::Error::from)
    .context("link watch import")?;
    workspace_chain::WorkspaceChain::add_to_linker::<_, WorkspaceData>(linker, |s: &mut T| {
        &mut s.imports().workspace
    })
    .map_err(anyhow::Error::from)
    .context("link workspace import")?;
    Ok(())
}
/// The inference request as the chain's import side sees it.
pub use inference_chain::icanhaz::nocap::inference::CompletionRequest as ClientRequest;

/// A wRPC byte stream as a wasmtime stream producer: what the guest reads.
struct BytesProducer {
    stream: BoxStream,
    pending: Option<bytes::Bytes>,
}

impl BytesProducer {
    fn emit<D>(
        &mut self,
        store: wasmtime::StoreContextMut<'_, D>,
        dst: wasmtime::component::Destination<'_, u8, bytes::Bytes>,
        mut data: bytes::Bytes,
        cap: usize,
    ) {
        let n = data.len().min(cap);
        if data.len() > n {
            self.pending = Some(data.split_off(n));
        }
        let mut direct = dst.as_direct(store, n);
        if let Some(slice) = direct.remaining().get_mut(..n) {
            slice.copy_from_slice(&data);
        }
        direct.mark_written(n);
    }
}

impl<D: 'static> wasmtime::component::StreamProducer<D> for BytesProducer {
    type Item = u8;
    type Buffer = bytes::Bytes;

    fn poll_produce<'a>(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        mut store: wasmtime::StoreContextMut<'a, D>,
        mut dst: wasmtime::component::Destination<'a, u8, bytes::Bytes>,
        finish: bool,
    ) -> std::task::Poll<wasmtime::Result<wasmtime::component::StreamResult>> {
        use std::task::Poll;
        use wasmtime::component::StreamResult;
        let cap = dst.remaining(&mut store);
        if let Some(pending) = self.pending.take() {
            match cap {
                Some(0) => {
                    self.pending = Some(pending);
                    return Poll::Ready(Ok(StreamResult::Completed));
                }
                Some(cap) => {
                    self.emit(store, dst, pending, cap);
                    return Poll::Ready(Ok(StreamResult::Completed));
                }
                None => {
                    dst.set_buffer(pending);
                    return Poll::Ready(Ok(StreamResult::Completed));
                }
            }
        }
        match self.stream.as_mut().poll_next(cx) {
            Poll::Ready(Some(chunk)) => {
                match cap {
                    Some(0) => {
                        self.pending = Some(chunk);
                    }
                    Some(cap) => self.emit(store, dst, chunk, cap),
                    None => dst.set_buffer(chunk),
                }
                Poll::Ready(Ok(StreamResult::Completed))
            }
            Poll::Ready(None) => Poll::Ready(Ok(StreamResult::Dropped)),
            Poll::Pending if finish => Poll::Ready(Ok(StreamResult::Cancelled)),
            Poll::Pending => Poll::Pending,
        }
    }
}

/// A wasmtime stream consumer that forwards to a channel: what the host reads
/// from a guest-produced stream, ending the channel when the guest drops it.
struct ChannelConsumer {
    tx: Option<tokio::sync::mpsc::UnboundedSender<bytes::Bytes>>,
    /// Fired when the guest's end is gone (the consumer is dropped), so the
    /// session driving the store knows the output is complete.
    done: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Drop for ChannelConsumer {
    fn drop(&mut self) {
        if let Some(done) = self.done.take() {
            let _ = done.send(());
        }
    }
}

impl<D> wasmtime::component::StreamConsumer<D> for ChannelConsumer {
    type Item = u8;

    fn poll_consume(
        mut self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        store: wasmtime::StoreContextMut<D>,
        source: wasmtime::component::Source<u8>,
        _finish: bool,
    ) -> std::task::Poll<wasmtime::Result<wasmtime::component::StreamResult>> {
        use std::task::Poll;
        use wasmtime::component::StreamResult;
        let mut src = source.as_direct(store);
        let buf = src.remaining();
        let n = buf.len();
        if n > 0 {
            let chunk = bytes::Bytes::copy_from_slice(buf);
            src.mark_read(n);
            if let Some(tx) = &self.tx {
                if tx.send(chunk).is_err() {
                    self.tx = None;
                    return Poll::Ready(Ok(StreamResult::Dropped));
                }
            }
        } else if _finish {
            // Nothing left and the stream is closing: the channel ends with us.
            self.tx = None;
            return Poll::Ready(Ok(StreamResult::Dropped));
        }
        Poll::Ready(Ok(StreamResult::Completed))
    }
}

/// Turn a guest stream into a wRPC byte stream: piped through a channel
/// that closes when the guest's side does.
fn drain(
    store: impl wasmtime::AsContextMut,
    reader: wasmtime::component::StreamReader<u8>,
) -> wasmtime::Result<(BoxStream, tokio::sync::oneshot::Receiver<()>)> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<bytes::Bytes>();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    reader.pipe(
        store,
        ChannelConsumer {
            tx: Some(tx),
            done: Some(done_tx),
        },
    )?;
    Ok((
        Box::pin(tokio_stream::wrappers::UnboundedReceiverStream::new(rx)),
        done_rx,
    ))
}

/// The interfaces a grant of `kind` is used through, as prefixes of the
/// qualified names a component exports (`icanhaz:nocap/workspace@0.1.0`).
pub fn interfaces_of(kind: &str) -> &'static [&'static str] {
    match kind {
        "filesystem" => &[
            "wasi:filesystem/types@",
            "icanhaz:nocap/watch@",
            "icanhaz:nocap/workspace@",
        ],
        "process" => &["icanhaz:nocap/process@"],
        "terminal" => &["icanhaz:nocap/terminal@"],
        "inference" => &["icanhaz:nocap/inference@"],
        _ => &[],
    }
}

/// Whether a component (by its exports) can provide a grant of `kind`: for a
/// native kind, sit in front of an interface it is used through; for a
/// component kind, export the interface itself.
pub fn offers_kind(kind: &crate::broker::CapabilityKind, exports: &[String]) -> bool {
    match kind {
        crate::broker::CapabilityKind::Component(c) => exports.contains(&c.provides),
        other => offers(other.tag(), exports),
    }
}

/// Whether a component (by its exports) can sit in front of a grant of `kind`.
pub fn offers(kind: &str, exports: &[String]) -> bool {
    interfaces_of(kind)
        .iter()
        .any(|prefix| exports.iter().any(|e| e.starts_with(prefix)))
}

/// Store state for a running chain: WASI for the wrapper's own needs, and
/// what the native implementation answered, handed to the wrapper as its import.
struct ChainState {
    table: ResourceTable,
    wasi: WasiCtx,
    native_root: NativeRoot,
}

/// The `HasData` carrier for a workspace import: its data is the state.
struct WorkspaceData;
impl wasmtime::component::HasData for WorkspaceData {
    type Data<'a> = &'a mut ChainState;
}

impl WasiView for ChainState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl workspace_chain::icanhaz::nocap::workspace::Host for &mut ChainState {
    async fn root_path(&mut self, grant: String) -> wasmtime::Result<Result<String, String>> {
        Ok((self.native_root)(grant))
    }
}

/// Store state for a process chain: WASI plus the native spawn.
struct ProcessState {
    table: ResourceTable,
    wasi: WasiCtx,
    native: NativeSpawn,
}

impl WasiView for ProcessState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

/// The `HasData` carrier for a process chain's store: its data is the state.
struct ProcessData;
impl wasmtime::component::HasData for ProcessData {
    type Data<'a> = &'a mut ProcessState;
}

impl process_chain::icanhaz::nocap::process::Host for &mut ProcessState {}

impl<T> process_chain::icanhaz::nocap::process::HostWithStore<T> for ProcessData {
    // `spawn` is an `async func` in the WIT (it carries streams), so the
    // import is accessor-style; the work inside is synchronous.
    async fn spawn(
        accessor: &wasmtime::component::Accessor<T, Self>,
        grant: String,
        args: Vec<String>,
        stdin: wasmtime::component::StreamReader<u8>,
    ) -> wasmtime::Result<Result<wasmtime::component::StreamReader<u8>, String>> {
        // The wrapper's stdin becomes the native child's; the native stdout
        // becomes the wrapper's import result.
        accessor.with(|mut access| {
            let native = access.get().native.clone();
            let (stdin_stream, _done) = drain(access.as_context_mut(), stdin)?;
            match native(grant, args, stdin_stream) {
                Ok(stdout) => {
                    let reader = wasmtime::component::StreamReader::new(
                        access.as_context_mut(),
                        BytesProducer {
                            stream: stdout,
                            pending: None,
                        },
                    )?;
                    Ok(Ok(reader))
                }
                Err(e) => Ok(Err(e)),
            }
        })
    }
}

/// Store state for a terminal chain: WASI plus the native open.
struct TerminalState {
    table: ResourceTable,
    wasi: WasiCtx,
    native: NativeTerminal,
}

impl WasiView for TerminalState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

struct TerminalData;
impl wasmtime::component::HasData for TerminalData {
    type Data<'a> = &'a mut TerminalState;
}

impl terminal_chain::icanhaz::nocap::terminal::Host for &mut TerminalState {}

impl<T> terminal_chain::icanhaz::nocap::terminal::HostWithStore<T> for TerminalData {
    async fn open(
        accessor: &wasmtime::component::Accessor<T, Self>,
        grant: String,
        stdin: wasmtime::component::StreamReader<u8>,
        control: wasmtime::component::StreamReader<u8>,
        cols: u16,
        rows: u16,
    ) -> wasmtime::Result<Result<wasmtime::component::StreamReader<u8>, String>> {
        accessor.with(|mut access| {
            let native = access.get().native.clone();
            let (stdin_stream, _stdin_done) = drain(access.as_context_mut(), stdin)?;
            let (control_stream, _control_done) = drain(access.as_context_mut(), control)?;
            match native(grant, stdin_stream, control_stream, cols, rows) {
                Ok(output) => {
                    let reader = wasmtime::component::StreamReader::new(
                        access.as_context_mut(),
                        BytesProducer {
                            stream: output,
                            pending: None,
                        },
                    )?;
                    Ok(Ok(reader))
                }
                Err(e) => Ok(Err(e)),
            }
        })
    }
}

/// Store state for a watch chain: WASI plus the native open.
struct WatchState {
    table: ResourceTable,
    wasi: WasiCtx,
    native: NativeWatch,
}

impl WasiView for WatchState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

struct WatchData;
impl wasmtime::component::HasData for WatchData {
    type Data<'a> = &'a mut WatchState;
}

impl watch_chain::icanhaz::nocap::watch::Host for &mut WatchState {}

impl<T> watch_chain::icanhaz::nocap::watch::HostWithStore<T> for WatchData {
    async fn open(
        accessor: &wasmtime::component::Accessor<T, Self>,
        grant: String,
        path: String,
        recursive: bool,
    ) -> wasmtime::Result<Result<wasmtime::component::StreamReader<u8>, String>> {
        accessor.with(|mut access| {
            let native = access.get().native.clone();
            match native(grant, path, recursive) {
                Ok(events) => {
                    let reader = wasmtime::component::StreamReader::new(
                        access.as_context_mut(),
                        BytesProducer {
                            stream: events,
                            pending: None,
                        },
                    )?;
                    Ok(Ok(reader))
                }
                Err(e) => Ok(Err(e)),
            }
        })
    }
}

/// Store state for an inference chain: WASI plus the native calls.
struct InferenceState {
    table: ResourceTable,
    wasi: WasiCtx,
    complete: NativeComplete,
    models: NativeModels,
}

impl WasiView for InferenceState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

struct InferenceData;
impl wasmtime::component::HasData for InferenceData {
    type Data<'a> = &'a mut InferenceState;
}

impl inference_chain::icanhaz::nocap::inference::Host for &mut InferenceState {}

impl<T> inference_chain::icanhaz::nocap::inference::HostWithStore<T> for InferenceData {
    async fn complete(
        accessor: &wasmtime::component::Accessor<T, Self>,
        grant: String,
        request: ClientRequest,
    ) -> wasmtime::Result<Result<wasmtime::component::StreamReader<u8>, String>> {
        accessor.with(|mut access| {
            let native = access.get().complete.clone();
            match native(grant, request) {
                Ok(frames) => {
                    let reader = wasmtime::component::StreamReader::new(
                        access.as_context_mut(),
                        BytesProducer {
                            stream: frames,
                            pending: None,
                        },
                    )?;
                    Ok(Ok(reader))
                }
                Err(e) => Ok(Err(e)),
            }
        })
    }

    fn models(
        mut access: wasmtime::component::Access<'_, T, Self>,
        grant: String,
    ) -> impl std::future::Future<
        Output = wasmtime::Result<
            Result<Vec<inference_chain::icanhaz::nocap::inference::ModelInfo>, String>,
        >,
    > + Send {
        let native = access.get().models.clone();
        let out =
            Ok(native(grant).map(|list| {
                list.into_iter()
                    .map(|(provider, model)| {
                        inference_chain::icanhaz::nocap::inference::ModelInfo { provider, model }
                    })
                    .collect()
            }));
        std::future::ready(out)
    }
}

/// The inference request as the chain's export side takes it.
pub use inference_chain::exports::icanhaz::nocap::inference::CompletionRequest as ExportRequest;

/// Build the export-side request from plain parts: `(role, content,
/// tool-calls as (id, name, arguments), tool-call-id)` per message and
/// `(name, description, parameters)` per tool.
#[allow(clippy::type_complexity)]
pub fn export_to_client_request_from_wire(
    model: String,
    messages: Vec<(
        String,
        String,
        Vec<(String, String, String)>,
        Option<String>,
    )>,
    tools: Vec<(String, String, String)>,
    max_tokens: u32,
    temperature: Option<f32>,
    system: Option<String>,
) -> ExportRequest {
    use inference_chain::exports::icanhaz::nocap::inference as e;
    ExportRequest {
        model,
        messages: messages
            .into_iter()
            .map(|(role, content, calls, tool_call_id)| e::Message {
                role,
                content,
                tool_calls: calls
                    .into_iter()
                    .map(|(id, name, arguments)| e::ToolCall {
                        id,
                        name,
                        arguments,
                    })
                    .collect(),
                tool_call_id,
            })
            .collect(),
        tools: tools
            .into_iter()
            .map(|(name, description, parameters)| e::Tool {
                name,
                description,
                parameters,
            })
            .collect(),
        max_tokens,
        temperature,
        system,
    }
}

/// The export-side request as the import-side type (what a wrapper sees when
/// it forwards), for providers converting a wRPC request into the chain.
pub fn export_to_client_request(r: ExportRequest) -> ClientRequest {
    use inference_chain::icanhaz::nocap::inference as c;
    ClientRequest {
        model: r.model,
        messages: r
            .messages
            .into_iter()
            .map(|m| c::Message {
                role: m.role,
                content: m.content,
                tool_calls: m
                    .tool_calls
                    .into_iter()
                    .map(|t| c::ToolCall {
                        id: t.id,
                        name: t.name,
                        arguments: t.arguments,
                    })
                    .collect(),
                tool_call_id: m.tool_call_id,
            })
            .collect(),
        tools: r
            .tools
            .into_iter()
            .map(|t| c::Tool {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            })
            .collect(),
        max_tokens: r.max_tokens,
        temperature: r.temperature,
        system: r.system,
    }
}

pub struct Chain {
    engine: Engine,
    components: Arc<ComponentStore>,
    compiled: Mutex<HashMap<String, Component>>,
}

impl Chain {
    pub fn new(components: Arc<ComponentStore>) -> anyhow::Result<Arc<Self>> {
        let mut config = wasmtime::Config::new();
        config.wasm_component_model(true);
        config.wasm_component_model_async(true);
        Ok(Arc::new(Self {
            engine: Engine::new(&config)?,
            components,
            compiled: Mutex::new(HashMap::new()),
        }))
    }

    /// The components in `via` (outermost first) that export something with
    /// `interface` prefix, composed inner→outer and compiled; `None` when
    /// none applies.
    async fn composed(&self, via: &[String], interface: &str) -> anyhow::Result<Option<Component>> {
        let mut applicable = Vec::new();
        for hash in via {
            let Some(info) = self.components.find(hash).await else {
                anyhow::bail!("component {hash} is not in the store");
            };
            if info.exports.iter().any(|e| e.starts_with(interface)) {
                applicable.push(hash.clone());
            }
        }
        if applicable.is_empty() {
            return Ok(None);
        }
        let key = applicable.join("+");
        if let Some(c) = self.compiled.lock().await.get(&key) {
            return Ok(Some(c.clone()));
        }
        // wac wires later parts' imports from earlier parts' exports, so the
        // innermost (nearest the host) goes first.
        let mut parts = Vec::new();
        for hash in applicable.iter().rev() {
            parts.push(self.components.get(hash)?);
        }
        let bytes = if parts.len() == 1 {
            parts.remove(0)
        } else {
            crate::components::compose(&parts)?
        };
        let component = Component::new(&self.engine, &bytes)
            .map_err(anyhow::Error::from)
            .context("compile chain")?;
        self.compiled.lock().await.insert(key, component.clone());
        Ok(Some(component))
    }

    /// `workspace.root-path` through the grant's chain: `None` when no
    /// component in `via` exports workspace, so the native answer stands.
    pub async fn workspace_root_path(
        &self,
        via: &[String],
        grant: &str,
        native: Result<String, String>,
    ) -> anyhow::Result<Option<Result<String, String>>> {
        let Some(component) = self.composed(via, "icanhaz:nocap/workspace@").await? else {
            return Ok(None);
        };
        let mut linker = Linker::<ChainState>::new(&self.engine);
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)
            .map_err(anyhow::Error::from)
            .context("link WASI")?;
        workspace_chain::WorkspaceChain::add_to_linker::<_, WorkspaceData>(&mut linker, |s| s)
            .map_err(anyhow::Error::from)
            .context("link workspace import")?;
        let mut store = Store::new(
            &self.engine,
            ChainState {
                table: ResourceTable::new(),
                wasi: WasiCtxBuilder::new().build(),
                native_root: Arc::new(move |_| native.clone()),
            },
        );
        let bindings =
            workspace_chain::WorkspaceChain::instantiate_async(&mut store, &component, &linker)
                .await
                .map_err(anyhow::Error::from)
                .context("instantiate chain")?;
        let out = bindings
            .icanhaz_nocap_workspace()
            .call_root_path(&mut store, grant)
            .await
            .map_err(anyhow::Error::from)
            .context("call chain")?;
        Ok(Some(out))
    }
}

impl Chain {
    /// `process.spawn` through the grant's chain: the wrapper runs inside a
    /// task that owns the store for the session's life, its stdin fed from
    /// the caller's stream and its stdout returned as one. `None` when no
    /// component in `via` exports process.
    pub async fn process_spawn(
        &self,
        via: &[String],
        grant: &str,
        args: Vec<String>,
        stdin: BoxStream,
        native: NativeSpawn,
    ) -> anyhow::Result<Option<Result<BoxStream, String>>> {
        let Some(component) = self.composed(via, "icanhaz:nocap/process@").await? else {
            return Ok(None);
        };
        let mut linker = Linker::<ProcessState>::new(&self.engine);
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)
            .map_err(anyhow::Error::from)
            .context("link WASI")?;
        process_chain::ProcessChain::add_to_linker::<_, ProcessData>(&mut linker, |s| s)
            .map_err(anyhow::Error::from)
            .context("link process import")?;
        let mut store = Store::new(
            &self.engine,
            ProcessState {
                table: ResourceTable::new(),
                wasi: WasiCtxBuilder::new().build(),
                native,
            },
        );
        let bindings =
            process_chain::ProcessChain::instantiate_async(&mut store, &component, &linker)
                .await
                .map_err(anyhow::Error::from)
                .context("instantiate chain")?;
        let (result_tx, result_rx) =
            tokio::sync::oneshot::channel::<anyhow::Result<Result<BoxStream, String>>>();
        let grant = grant.to_string();
        tokio::spawn(async move {
            let outcome = store
                .run_concurrent(async move |acc| {
                    let stdin_reader = acc.with(|mut a| {
                        wasmtime::component::StreamReader::new(
                            a.as_context_mut(),
                            BytesProducer {
                                stream: stdin,
                                pending: None,
                            },
                        )
                    })?;
                    let out = bindings
                        .icanhaz_nocap_process()
                        .call_spawn(acc, grant, args, stdin_reader)
                        .await?;
                    match out {
                        Ok(reader) => {
                            let (stream, done) =
                                acc.with(|mut a| drain(a.as_context_mut(), reader))?;
                            let _ = result_tx.send(Ok(Ok(stream)));
                            // Keep the store running until the guest's output ends.
                            let _ = done.await;
                        }
                        Err(e) => {
                            let _ = result_tx.send(Ok(Err(e)));
                        }
                    }
                    Ok::<(), wasmtime::Error>(())
                })
                .await;
            match outcome {
                Ok(Ok(())) => {}
                Ok(Err(err)) | Err(err) => tracing::debug!(?err, "process chain ended"),
            }
        });
        match result_rx.await {
            Ok(r) => r.map(Some),
            Err(_) => anyhow::bail!("process chain ended before answering"),
        }
    }

    /// `terminal.open` through the grant's chain (see `process_spawn`): the
    /// caller's stdin and control go in, the wrapper calls its import, the
    /// native PTY answers, and the wrapper's output comes back.
    pub async fn terminal_open(
        &self,
        via: &[String],
        grant: &str,
        stdin: BoxStream,
        control: BoxStream,
        cols: u16,
        rows: u16,
        native: NativeTerminal,
    ) -> anyhow::Result<Option<Result<BoxStream, String>>> {
        let Some(component) = self.composed(via, "icanhaz:nocap/terminal@").await? else {
            return Ok(None);
        };
        let mut linker = Linker::<TerminalState>::new(&self.engine);
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)
            .map_err(anyhow::Error::from)
            .context("link WASI")?;
        terminal_chain::TerminalChain::add_to_linker::<_, TerminalData>(&mut linker, |s| s)
            .map_err(anyhow::Error::from)
            .context("link terminal import")?;
        let mut store = Store::new(
            &self.engine,
            TerminalState {
                table: ResourceTable::new(),
                wasi: WasiCtxBuilder::new().build(),
                native,
            },
        );
        let bindings =
            terminal_chain::TerminalChain::instantiate_async(&mut store, &component, &linker)
                .await
                .map_err(anyhow::Error::from)
                .context("instantiate chain")?;
        let (result_tx, result_rx) =
            tokio::sync::oneshot::channel::<anyhow::Result<Result<BoxStream, String>>>();
        let grant = grant.to_string();
        tokio::spawn(async move {
            let outcome = store
                .run_concurrent(async move |acc| {
                    let (stdin_reader, control_reader) = acc.with(|mut a| {
                        let stdin = wasmtime::component::StreamReader::new(
                            a.as_context_mut(),
                            BytesProducer {
                                stream: stdin,
                                pending: None,
                            },
                        )?;
                        let control = wasmtime::component::StreamReader::new(
                            a.as_context_mut(),
                            BytesProducer {
                                stream: control,
                                pending: None,
                            },
                        )?;
                        Ok::<_, wasmtime::Error>((stdin, control))
                    })?;
                    let out = bindings
                        .icanhaz_nocap_terminal()
                        .call_open(acc, grant, stdin_reader, control_reader, cols, rows)
                        .await?;
                    match out {
                        Ok(reader) => {
                            let (stream, done) =
                                acc.with(|mut a| drain(a.as_context_mut(), reader))?;
                            let _ = result_tx.send(Ok(Ok(stream)));
                            let _ = done.await;
                        }
                        Err(e) => {
                            let _ = result_tx.send(Ok(Err(e)));
                        }
                    }
                    Ok::<(), wasmtime::Error>(())
                })
                .await;
            match outcome {
                Ok(Ok(())) => {}
                Ok(Err(err)) | Err(err) => tracing::debug!(?err, "terminal chain ended"),
            }
        });
        match result_rx.await {
            Ok(r) => r.map(Some),
            Err(_) => anyhow::bail!("terminal chain ended before answering"),
        }
    }

    /// `watch.open` through the grant's chain (see `process_spawn`).
    pub async fn watch_open(
        &self,
        via: &[String],
        grant: &str,
        path: String,
        recursive: bool,
        native: NativeWatch,
    ) -> anyhow::Result<Option<Result<BoxStream, String>>> {
        let Some(component) = self.composed(via, "icanhaz:nocap/watch@").await? else {
            return Ok(None);
        };
        let mut linker = Linker::<WatchState>::new(&self.engine);
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)
            .map_err(anyhow::Error::from)
            .context("link WASI")?;
        watch_chain::WatchChain::add_to_linker::<_, WatchData>(&mut linker, |s| s)
            .map_err(anyhow::Error::from)
            .context("link watch import")?;
        let mut store = Store::new(
            &self.engine,
            WatchState {
                table: ResourceTable::new(),
                wasi: WasiCtxBuilder::new().build(),
                native,
            },
        );
        let bindings = watch_chain::WatchChain::instantiate_async(&mut store, &component, &linker)
            .await
            .map_err(anyhow::Error::from)
            .context("instantiate chain")?;
        let (result_tx, result_rx) =
            tokio::sync::oneshot::channel::<anyhow::Result<Result<BoxStream, String>>>();
        let grant = grant.to_string();
        tokio::spawn(async move {
            let outcome = store
                .run_concurrent(async move |acc| {
                    let out = bindings
                        .icanhaz_nocap_watch()
                        .call_open(acc, grant, path, recursive)
                        .await?;
                    match out {
                        Ok(reader) => {
                            let (stream, done) =
                                acc.with(|mut a| drain(a.as_context_mut(), reader))?;
                            let _ = result_tx.send(Ok(Ok(stream)));
                            let _ = done.await;
                        }
                        Err(e) => {
                            let _ = result_tx.send(Ok(Err(e)));
                        }
                    }
                    Ok::<(), wasmtime::Error>(())
                })
                .await;
            match outcome {
                Ok(Ok(())) => {}
                Ok(Err(err)) | Err(err) => tracing::debug!(?err, "watch chain ended"),
            }
        });
        match result_rx.await {
            Ok(r) => r.map(Some),
            Err(_) => anyhow::bail!("watch chain ended before answering"),
        }
    }

    /// `inference.complete` through the grant's chain (see `process_spawn`).
    pub async fn inference_complete(
        &self,
        via: &[String],
        grant: &str,
        request: ExportRequest,
        complete: NativeComplete,
        models: NativeModels,
    ) -> anyhow::Result<Option<Result<BoxStream, String>>> {
        let Some(component) = self.composed(via, "icanhaz:nocap/inference@").await? else {
            return Ok(None);
        };
        let mut store = self.inference_store(complete, models)?;
        let bindings = inference_chain::InferenceChain::instantiate_async(
            &mut store,
            &component,
            &self.inference_linker()?,
        )
        .await
        .map_err(anyhow::Error::from)
        .context("instantiate chain")?;
        let (result_tx, result_rx) =
            tokio::sync::oneshot::channel::<anyhow::Result<Result<BoxStream, String>>>();
        let grant = grant.to_string();
        tokio::spawn(async move {
            let outcome = store
                .run_concurrent(async move |acc| {
                    let out = bindings
                        .icanhaz_nocap_inference()
                        .call_complete(acc, grant, request)
                        .await?;
                    match out {
                        Ok(reader) => {
                            let (stream, done) =
                                acc.with(|mut a| drain(a.as_context_mut(), reader))?;
                            let _ = result_tx.send(Ok(Ok(stream)));
                            let _ = done.await;
                        }
                        Err(e) => {
                            let _ = result_tx.send(Ok(Err(e)));
                        }
                    }
                    Ok::<(), wasmtime::Error>(())
                })
                .await;
            match outcome {
                Ok(Ok(())) => {}
                Ok(Err(err)) | Err(err) => tracing::debug!(?err, "inference chain ended"),
            }
        });
        match result_rx.await {
            Ok(r) => r.map(Some),
            Err(_) => anyhow::bail!("inference chain ended before answering"),
        }
    }

    /// `inference.models` through the grant's chain.
    pub async fn inference_models(
        &self,
        via: &[String],
        grant: &str,
        complete: NativeComplete,
        models: NativeModels,
    ) -> anyhow::Result<Option<Result<Vec<(String, String)>, String>>> {
        let Some(component) = self.composed(via, "icanhaz:nocap/inference@").await? else {
            return Ok(None);
        };
        let mut store = self.inference_store(complete, models)?;
        let bindings = inference_chain::InferenceChain::instantiate_async(
            &mut store,
            &component,
            &self.inference_linker()?,
        )
        .await
        .map_err(anyhow::Error::from)
        .context("instantiate chain")?;
        let grant = grant.to_string();
        let out = store
            .run_concurrent(async move |acc| {
                bindings
                    .icanhaz_nocap_inference()
                    .call_models(acc, grant)
                    .await
            })
            .await
            .map_err(anyhow::Error::from)
            .context("run chain")?
            .map_err(anyhow::Error::from)
            .context("call chain")?;
        Ok(Some(out.map(|list| {
            list.into_iter().map(|m| (m.provider, m.model)).collect()
        })))
    }

    fn inference_linker(&self) -> anyhow::Result<Linker<InferenceState>> {
        let mut linker = Linker::<InferenceState>::new(&self.engine);
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)
            .map_err(anyhow::Error::from)
            .context("link WASI")?;
        inference_chain::InferenceChain::add_to_linker::<_, InferenceData>(&mut linker, |s| s)
            .map_err(anyhow::Error::from)
            .context("link inference import")?;
        Ok(linker)
    }

    fn inference_store(
        &self,
        complete: NativeComplete,
        models: NativeModels,
    ) -> anyhow::Result<Store<InferenceState>> {
        Ok(Store::new(
            &self.engine,
            InferenceState {
                table: ResourceTable::new(),
                wasi: WasiCtxBuilder::new().build(),
                complete,
                models,
            },
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store as Db;

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))).expect("fixture")
    }

    #[test]
    fn kinds_map_to_the_interfaces_they_are_used_through() {
        assert!(offers(
            "filesystem",
            &["icanhaz:nocap/workspace@0.1.0".into()]
        ));
        assert!(!offers(
            "process",
            &["icanhaz:nocap/workspace@0.1.0".into()]
        ));
        assert!(offers(
            "inference",
            &["icanhaz:nocap/inference@0.1.0".into()]
        ));
    }

    #[tokio::test]
    async fn a_chosen_wrapper_sits_between_the_caller_and_the_native_answer() {
        let dir = tempfile::tempdir().unwrap();
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let db = Db::open_with(dir.path().join("icanhaz.db"), &source)
            .await
            .unwrap();
        let components = Arc::new(ComponentStore::new(dir.path().join("components"), Some(db)));
        let wrap = components
            .add(&fixture("ws_wrap.wasm"), None)
            .await
            .unwrap()
            .hash;
        let rewrite = components
            .add(&fixture("ws_rewrite.wasm"), None)
            .await
            .unwrap()
            .hash;
        let chain = Chain::new(components).unwrap();
        let native = Ok("/demo/root/jail".to_string());

        // No applicable component: the native answer stands.
        assert_eq!(
            chain
                .workspace_root_path(&[], "g", native.clone())
                .await
                .unwrap(),
            None
        );
        // The passthrough forwards; the rewriting wrapper rewrites.
        assert_eq!(
            chain
                .workspace_root_path(std::slice::from_ref(&wrap), "g", native.clone())
                .await
                .unwrap(),
            Some(Ok("/demo/root/jail".to_string()))
        );
        assert_eq!(
            chain
                .workspace_root_path(std::slice::from_ref(&rewrite), "g", native.clone())
                .await
                .unwrap(),
            Some(Ok("/demo/root/jail/wrapped".to_string()))
        );
        // Two of them compose (outermost first): the passthrough in front of the rewriter, and the reverse.
        assert_eq!(
            chain
                .workspace_root_path(&[wrap.clone(), rewrite.clone()], "g", native.clone())
                .await
                .unwrap(),
            Some(Ok("/demo/root/jail/wrapped".to_string()))
        );
        assert_eq!(
            chain
                .workspace_root_path(&[rewrite.clone(), rewrite], "g", native)
                .await
                .unwrap(),
            Some(Ok("/demo/root/jail/wrapped/wrapped".to_string()))
        );
        // A hash not in the store is an error, not a silent native answer.
        assert!(chain
            .workspace_root_path(&["sha256:nope".into()], "g", Ok(String::new()))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn a_process_wrapper_guards_arguments_and_proxies_stdio() {
        use futures::StreamExt as _;
        let dir = tempfile::tempdir().unwrap();
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let db = Db::open_with(dir.path().join("icanhaz.db"), &source)
            .await
            .unwrap();
        let components = Arc::new(ComponentStore::new(dir.path().join("components"), Some(db)));
        let guard = components
            .add(&fixture("proc_guard.wasm"), None)
            .await
            .unwrap()
            .hash;
        let chain = Chain::new(components).unwrap();

        // The native side: echo stdin back, and record that it ran.
        let ran = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let ran_c = ran.clone();
        let native: NativeSpawn = Arc::new(move |_grant, args, stdin| {
            ran_c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<bytes::Bytes>();
            tokio::spawn(async move {
                let mut stdin = stdin;
                let _ = tx.send(bytes::Bytes::from(format!("args={} ", args.join(","))));
                while let Some(chunk) = stdin.next().await {
                    if tx.send(chunk).is_err() {
                        break;
                    }
                }
            });
            Ok(Box::pin(tokio_stream::wrappers::UnboundedReceiverStream::new(rx)) as BoxStream)
        });

        let stdin: BoxStream = Box::pin(futures::stream::iter(vec![
            bytes::Bytes::from_static(b"hello "),
            bytes::Bytes::from_static(b"world"),
        ]));
        let out = chain
            .process_spawn(
                std::slice::from_ref(&guard),
                "g",
                vec!["a".into(), "b".into()],
                stdin,
                native.clone(),
            )
            .await
            .unwrap()
            .expect("the wrapper exports process")
            .expect("spawned");
        let bytes: Vec<bytes::Bytes> = out.collect().await;
        assert_eq!(
            String::from_utf8_lossy(&bytes.concat()),
            "args=a,b hello world"
        );
        assert_eq!(ran.load(std::sync::atomic::Ordering::SeqCst), 1);

        // The wrapper refuses an argument before the host ever sees it.
        let stdin: BoxStream = Box::pin(futures::stream::empty());
        let refused = chain
            .process_spawn(
                std::slice::from_ref(&guard),
                "g",
                vec!["--forbidden".into()],
                stdin,
                native,
            )
            .await
            .unwrap()
            .expect("the wrapper exports process");
        assert_eq!(
            refused.err().as_deref(),
            Some("proc-guard: `--forbidden` is refused by the wrapper")
        );
        assert_eq!(ran.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_terminal_wrapper_guards_the_window_and_proxies_streams() {
        use futures::StreamExt as _;
        let dir = tempfile::tempdir().unwrap();
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let db = Db::open_with(dir.path().join("icanhaz.db"), &source)
            .await
            .unwrap();
        let components = Arc::new(ComponentStore::new(dir.path().join("components"), Some(db)));
        let guard = components
            .add(&fixture("term_guard.wasm"), None)
            .await
            .unwrap()
            .hash;
        let chain = Chain::new(components).unwrap();

        // The native side: report the window it was asked for, then echo stdin
        // and every control frame it receives.
        let seen = Arc::new(std::sync::Mutex::new(Vec::<(u16, u16)>::new()));
        let seen_c = seen.clone();
        let native: NativeTerminal = Arc::new(move |_grant, stdin, control, cols, rows| {
            seen_c.lock().unwrap().push((cols, rows));
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<bytes::Bytes>();
            tokio::spawn(async move {
                let mut stdin = stdin;
                let mut control = control;
                let _ = tx.send(bytes::Bytes::from(format!("{cols}x{rows} ")));
                while let Some(chunk) = stdin.next().await {
                    if tx.send(chunk).is_err() {
                        return;
                    }
                }
                while let Some(frame) = control.next().await {
                    let _ = tx.send(bytes::Bytes::from(format!(" resize:{}", frame.len())));
                }
            });
            Ok(Box::pin(tokio_stream::wrappers::UnboundedReceiverStream::new(rx)) as BoxStream)
        });

        let stdin: BoxStream = Box::pin(futures::stream::iter(vec![
            bytes::Bytes::from_static(b"ls"),
            bytes::Bytes::from_static(b"\n"),
        ]));
        let control: BoxStream =
            Box::pin(futures::stream::iter(vec![bytes::Bytes::from_static(&[
                0, 80, 0, 24,
            ])]));
        let out = chain
            .terminal_open(
                std::slice::from_ref(&guard),
                "g",
                stdin,
                control,
                500,
                24,
                native.clone(),
            )
            .await
            .unwrap()
            .expect("the wrapper exports terminal")
            .expect("opened");
        let bytes: Vec<bytes::Bytes> = out.collect().await;
        // The wrapper capped the width at 200 before the host saw it.
        assert_eq!(
            String::from_utf8_lossy(&bytes.concat()),
            "200x24 ls\n resize:4"
        );
        assert_eq!(seen.lock().unwrap().as_slice(), &[(200, 24)]);

        // Too few rows: refused by the wrapper, the host never opens a PTY.
        let stdin: BoxStream = Box::pin(futures::stream::empty());
        let control: BoxStream = Box::pin(futures::stream::empty());
        let refused = chain
            .terminal_open(
                std::slice::from_ref(&guard),
                "g",
                stdin,
                control,
                80,
                1,
                native,
            )
            .await
            .unwrap()
            .expect("the wrapper exports terminal");
        assert_eq!(
            refused.err().as_deref(),
            Some("term-guard: a terminal needs at least two rows")
        );
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_watch_wrapper_refuses_paths_before_the_host() {
        use futures::StreamExt as _;
        let dir = tempfile::tempdir().unwrap();
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let db = Db::open_with(dir.path().join("icanhaz.db"), &source)
            .await
            .unwrap();
        let components = Arc::new(ComponentStore::new(dir.path().join("components"), Some(db)));
        let guard = components
            .add(&fixture("watch_guard.wasm"), None)
            .await
            .unwrap()
            .hash;
        let chain = Chain::new(components).unwrap();

        let opened = Arc::new(std::sync::Mutex::new(Vec::<(String, bool)>::new()));
        let opened_c = opened.clone();
        let native: NativeWatch = Arc::new(move |_grant, path, recursive| {
            opened_c.lock().unwrap().push((path.clone(), recursive));
            Ok(
                Box::pin(futures::stream::iter(vec![bytes::Bytes::from(format!(
                    "event:{path}"
                ))])) as BoxStream,
            )
        });

        let out = chain
            .watch_open(
                std::slice::from_ref(&guard),
                "g",
                "notes".to_string(),
                true,
                native.clone(),
            )
            .await
            .unwrap()
            .expect("the wrapper exports watch")
            .expect("opened");
        let bytes: Vec<bytes::Bytes> = out.collect().await;
        assert_eq!(String::from_utf8_lossy(&bytes.concat()), "event:notes");
        assert_eq!(
            opened.lock().unwrap().as_slice(),
            &[("notes".to_string(), true)]
        );

        let refused = chain
            .watch_open(
                std::slice::from_ref(&guard),
                "g",
                "forbidden/keys".to_string(),
                false,
                native,
            )
            .await
            .unwrap()
            .expect("the wrapper exports watch");
        assert_eq!(
            refused.err().as_deref(),
            Some("watch-guard: that path is not watched")
        );
        assert_eq!(opened.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn an_inference_wrapper_forwards_requests_and_frames() {
        use futures::StreamExt as _;
        let dir = tempfile::tempdir().unwrap();
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let db = Db::open_with(dir.path().join("icanhaz.db"), &source)
            .await
            .unwrap();
        let components = Arc::new(ComponentStore::new(dir.path().join("components"), Some(db)));
        let wrap = components
            .add(&fixture("inf_wrap.wasm"), None)
            .await
            .unwrap()
            .hash;
        let chain = Chain::new(components).unwrap();

        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen_c = seen.clone();
        let complete: NativeComplete = Arc::new(move |_grant, request| {
            seen_c
                .lock()
                .unwrap()
                .push(format!("{}:{}", request.model, request.messages.len()));
            let frames = vec![
                crate::providers::Frame::Text("hi".into()).encode(),
                crate::providers::Frame::Usage {
                    input_tokens: 1,
                    output_tokens: 1,
                }
                .encode(),
            ];
            Ok(Box::pin(futures::stream::iter(frames)) as BoxStream)
        });
        let models: NativeModels =
            Arc::new(|_grant| Ok(vec![("echo".to_string(), "echo".to_string())]));

        let request = export_to_client_request_from_wire(
            "echo".into(),
            vec![("user".into(), "hello".into(), vec![], None)],
            vec![],
            0,
            None,
            None,
        );
        let out = chain
            .inference_complete(
                std::slice::from_ref(&wrap),
                "g",
                request,
                complete.clone(),
                models.clone(),
            )
            .await
            .unwrap()
            .expect("the wrapper exports inference")
            .expect("completed");
        let bytes: Vec<bytes::Bytes> = out.collect().await;
        let all = bytes.concat();
        assert_eq!(all[0], 0, "a text frame first");
        assert!(all.len() > 5 + 2, "text then usage");
        assert_eq!(seen.lock().unwrap().as_slice(), &["echo:1".to_string()]);

        let listed = chain
            .inference_models(std::slice::from_ref(&wrap), "g", complete, models)
            .await
            .unwrap()
            .expect("exports inference")
            .expect("listed");
        assert_eq!(listed, vec![("echo".to_string(), "echo".to_string())]);
    }
}
