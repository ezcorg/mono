//! The daemon's own capability implementations, as the host layer a shipped
//! capability component imports (`wit/host.wit`): the consent gate, and the
//! raw operations behind process, terminal, watch, inference and workspace.
//! Linked into every capability store; never served on the wire. Every
//! operation takes the grant token it runs under and validates it itself,
//! resolving a component grant to the grant of the right kind lent to it, so
//! importing this layer is safe for any component.
//!
//! The natives are asynchronous closures the providers supply (a grant held
//! at another broker is forwarded there), and the raw functions bridge their
//! streams into the guest's `stream<u8>`.

use std::future::Future;
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use wasmtime::component::{Accessor, Linker, StreamReader};
use wasmtime::AsContextMut as _;
use wrpc_wasmtime::stream::{drain, BoxStream, BytesProducer};

use crate::broker::{denied_text, AdmitCall, CapabilityKind, GrantStore};

mod bindings {
    wasmtime::component::bindgen!({
        world: "capability-host",
        path: "../wit",
        imports: { default: async | store | trappable },
    });
}

pub use bindings::icanhaz::nocap::inference::{
    CompletionRequest as ClientRequest, Message as ClientMessage, ModelInfo, Tool as ClientTool,
    ToolCall as ClientToolCall,
};
use bindings::icanhaz::nocap::types as wire;

/// `process-raw.spawn`: (grant, argv, stdin) → stdout, under the grant.
pub type NativeSpawn = Arc<
    dyn Fn(String, Vec<String>, BoxStream) -> BoxFuture<'static, Result<BoxStream, String>>
        + Send
        + Sync,
>;
/// `pty.open`: (grant, stdin, control, cols, rows) → output.
pub type NativeTerminal = Arc<
    dyn Fn(String, BoxStream, BoxStream, u16, u16) -> BoxFuture<'static, Result<BoxStream, String>>
        + Send
        + Sync,
>;
/// `notify.watch`: (grant, path, recursive) → events.
pub type NativeWatch = Arc<
    dyn Fn(String, String, bool) -> BoxFuture<'static, Result<BoxStream, String>> + Send + Sync,
>;
/// `jail.root`: grant → the jail's host path.
pub type NativeRoot = Arc<dyn Fn(String) -> Result<String, String> + Send + Sync>;
/// `providers.complete`: (grant, request) → frames.
pub type NativeComplete = Arc<
    dyn Fn(String, ClientRequest) -> BoxFuture<'static, Result<BoxStream, String>> + Send + Sync,
>;
/// `providers.models`: grant → what it may use.
pub type NativeModels =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<Vec<ModelInfo>, String>> + Send + Sync>;

/// The raw layer: the gate over the grant store, and whichever natives the
/// daemon's providers registered. A missing native refuses its calls.
pub struct Raw {
    pub grants: Arc<Mutex<GrantStore>>,
    pub spawn: Option<NativeSpawn>,
    pub terminal: Option<NativeTerminal>,
    pub watch: Option<NativeWatch>,
    pub root: Option<NativeRoot>,
    pub complete: Option<NativeComplete>,
    pub models: Option<NativeModels>,
}

impl Raw {
    /// The gate alone: what a test or a store with no native providers links.
    pub fn new(grants: Arc<Mutex<GrantStore>>) -> Self {
        Self {
            grants,
            spawn: None,
            terminal: None,
            watch: None,
            root: None,
            complete: None,
            models: None,
        }
    }
}

/// The store data the raw layer reaches: its [`Raw`].
pub struct RawState {
    pub raw: Arc<Raw>,
}

/// A store state carrying a [`RawState`].
pub trait HasRaw {
    fn raw(&mut self) -> &mut RawState;
}

struct RawData;
impl wasmtime::component::HasData for RawData {
    type Data<'a> = &'a mut RawState;
}

/// Link the whole raw layer into `linker`: each interface the daemon
/// implements, one by one (the world also names the type-only interfaces the
/// raw ones `use`, and WASI's clock, which wasmtime-wasi provides).
pub fn link<T: HasRaw + Send + 'static>(linker: &mut Linker<T>) -> anyhow::Result<()> {
    use bindings::icanhaz::nocap as n;
    fn get<T: HasRaw>(s: &mut T) -> &mut RawState {
        s.raw()
    }
    n::gate_filesystem::add_to_linker::<_, RawData>(linker, get::<T>)
        .map_err(anyhow::Error::from)?;
    n::gate_process::add_to_linker::<_, RawData>(linker, get::<T>).map_err(anyhow::Error::from)?;
    n::gate_terminal::add_to_linker::<_, RawData>(linker, get::<T>).map_err(anyhow::Error::from)?;
    n::gate_inference::add_to_linker::<_, RawData>(linker, get::<T>)
        .map_err(anyhow::Error::from)?;
    n::process_raw::add_to_linker::<_, RawData>(linker, get::<T>).map_err(anyhow::Error::from)?;
    n::pty::add_to_linker::<_, RawData>(linker, get::<T>).map_err(anyhow::Error::from)?;
    n::notify::add_to_linker::<_, RawData>(linker, get::<T>).map_err(anyhow::Error::from)?;
    n::providers::add_to_linker::<_, RawData>(linker, get::<T>).map_err(anyhow::Error::from)?;
    n::jail::add_to_linker::<_, RawData>(linker, get::<T>).map_err(anyhow::Error::from)?;
    Ok(())
}

fn missing(what: &str) -> String {
    format!("{what}: this daemon has no native provider for it")
}

/// Admit one operation under the grant of kind `tag` that `grant` resolves
/// to: itself when it is of that kind, else the grant of that kind delegated
/// to it (a component's). The delegated grant's scope and life decide, so a
/// clause on it holds per operation and revoking it stops the component.
fn admit_under(
    grants: &Arc<Mutex<GrantStore>>,
    grant: &str,
    tag: &str,
    method: &str,
    args: Vec<(String, String)>,
) -> Result<(), String> {
    let mut call = AdmitCall::new(method);
    for (name, value) in args {
        call = call.arg(&ezcap::shape::cel_ident(&name), value);
    }
    let mut g = grants.lock().unwrap();
    let under = g
        .delegated_for(grant, tag)
        .ok_or_else(|| format!("{tag} denied: not authorized"))?;
    g.admit(&under, call)
        .map_err(|d| format!("{tag} denied: {}", denied_text(&d)))
}

impl bindings::icanhaz::nocap::gate_filesystem::Host for &mut RawState {}

impl<T> bindings::icanhaz::nocap::gate_filesystem::HostWithStore<T> for RawData {
    fn validate(
        mut access: wasmtime::component::Access<'_, T, Self>,
        grant: String,
    ) -> impl Future<Output = wasmtime::Result<Result<String, String>>> + Send {
        let grants = access.get().raw.grants.clone();
        let out = {
            let g = grants.lock().unwrap();
            g.delegated_for(&grant, "filesystem")
                .ok_or_else(|| "filesystem grant denied: not authorized".to_string())
                .and_then(|token| {
                    g.validate_filesystem(&token)
                        .and_then(|paths| g.admit_grant(&token).map(|()| paths))
                        .map(|paths| paths.into_iter().next().unwrap_or_default())
                        .map_err(|d| format!("filesystem grant denied: {}", denied_text(&d)))
                })
        };
        std::future::ready(Ok(out))
    }

    fn admit(
        mut access: wasmtime::component::Access<'_, T, Self>,
        grant: String,
        method: String,
        args: Vec<(String, String)>,
    ) -> impl Future<Output = wasmtime::Result<Result<(), String>>> + Send {
        let grants = access.get().raw.grants.clone();
        std::future::ready(Ok(admit_under(
            &grants,
            &grant,
            "filesystem",
            &method,
            args,
        )))
    }
}

impl bindings::icanhaz::nocap::gate_process::Host for &mut RawState {}

impl<T> bindings::icanhaz::nocap::gate_process::HostWithStore<T> for RawData {
    fn validate(
        mut access: wasmtime::component::Access<'_, T, Self>,
        grant: String,
    ) -> impl Future<Output = wasmtime::Result<Result<wire::ProcessRequest, String>>> + Send {
        let grants = access.get().raw.grants.clone();
        let out = {
            let g = grants.lock().unwrap();
            g.delegated_for(&grant, "process")
                .ok_or_else(|| "process denied: not authorized".to_string())
                .and_then(|token| {
                    g.validate_process(&token)
                        .map(|p| wire::ProcessRequest {
                            image: p.image,
                            args: p.args,
                            guest_chooses_argv: p.guest_chooses_argv,
                        })
                        .map_err(|d| format!("process denied: {d:?}"))
                })
        };
        std::future::ready(Ok(out))
    }

    fn admit(
        mut access: wasmtime::component::Access<'_, T, Self>,
        grant: String,
        method: String,
        args: Vec<(String, String)>,
    ) -> impl Future<Output = wasmtime::Result<Result<(), String>>> + Send {
        let grants = access.get().raw.grants.clone();
        std::future::ready(Ok(admit_under(&grants, &grant, "process", &method, args)))
    }
}

impl bindings::icanhaz::nocap::gate_terminal::Host for &mut RawState {}

impl<T> bindings::icanhaz::nocap::gate_terminal::HostWithStore<T> for RawData {
    fn validate(
        mut access: wasmtime::component::Access<'_, T, Self>,
        grant: String,
    ) -> impl Future<Output = wasmtime::Result<Result<wire::TerminalRequest, String>>> + Send {
        let grants = access.get().raw.grants.clone();
        let out = {
            let g = grants.lock().unwrap();
            g.delegated_for(&grant, "terminal")
                .ok_or_else(|| "terminal denied: not authorized".to_string())
                .and_then(|token| {
                    g.validate(&token, |k| matches!(k, CapabilityKind::Terminal(_)))
                        .map_err(|d| format!("terminal denied: {d:?}"))?;
                    match g.kind_of(&token) {
                        Some(CapabilityKind::Terminal(t)) => Ok(wire::TerminalRequest {
                            shell: t.shell,
                            jailed: t.jailed,
                        }),
                        _ => Err("terminal denied: not a terminal grant".to_string()),
                    }
                })
        };
        std::future::ready(Ok(out))
    }

    fn admit(
        mut access: wasmtime::component::Access<'_, T, Self>,
        grant: String,
        method: String,
        args: Vec<(String, String)>,
    ) -> impl Future<Output = wasmtime::Result<Result<(), String>>> + Send {
        let grants = access.get().raw.grants.clone();
        std::future::ready(Ok(admit_under(&grants, &grant, "terminal", &method, args)))
    }
}

impl bindings::icanhaz::nocap::gate_inference::Host for &mut RawState {}

impl<T> bindings::icanhaz::nocap::gate_inference::HostWithStore<T> for RawData {
    fn validate(
        mut access: wasmtime::component::Access<'_, T, Self>,
        grant: String,
    ) -> impl Future<Output = wasmtime::Result<Result<wire::InferenceRequest, String>>> + Send {
        let grants = access.get().raw.grants.clone();
        let out = {
            let g = grants.lock().unwrap();
            g.delegated_for(&grant, "inference")
                .ok_or_else(|| "inference denied: not authorized".to_string())
                .and_then(|token| {
                    g.validate_inference(&token)
                        .map(|i| wire::InferenceRequest { models: i.models })
                        .map_err(|d| format!("inference denied: {d:?}"))
                })
        };
        std::future::ready(Ok(out))
    }

    fn admit(
        mut access: wasmtime::component::Access<'_, T, Self>,
        grant: String,
        method: String,
        args: Vec<(String, String)>,
    ) -> impl Future<Output = wasmtime::Result<Result<(), String>>> + Send {
        let grants = access.get().raw.grants.clone();
        std::future::ready(Ok(admit_under(&grants, &grant, "inference", &method, args)))
    }
}

/// Read a guest stream as a wRPC byte stream (see `drain`).
fn guest_stream<T, D: wasmtime::component::HasData + ?Sized>(
    accessor: &Accessor<T, D>,
    reader: StreamReader<u8>,
) -> wasmtime::Result<BoxStream> {
    accessor.with(|mut a| drain(a.as_context_mut(), reader).map(|(s, _)| s))
}

/// Hand a wRPC byte stream to the guest as a `stream<u8>`.
fn host_stream<T, D: wasmtime::component::HasData + ?Sized>(
    accessor: &Accessor<T, D>,
    stream: BoxStream,
) -> wasmtime::Result<StreamReader<u8>> {
    accessor.with(|mut a| StreamReader::new(a.as_context_mut(), BytesProducer::new(stream)))
}

impl bindings::icanhaz::nocap::process_raw::Host for &mut RawState {}

impl<T> bindings::icanhaz::nocap::process_raw::HostWithStore<T> for RawData {
    async fn spawn(
        accessor: &Accessor<T, Self>,
        grant: String,
        args: Vec<String>,
        stdin: StreamReader<u8>,
    ) -> wasmtime::Result<Result<StreamReader<u8>, String>> {
        let native = accessor.with(|mut a| a.get().raw.spawn.clone());
        let Some(native) = native else {
            return Ok(Err(missing("process")));
        };
        let stdin = guest_stream(accessor, stdin)?;
        match native(grant, args, stdin).await {
            Ok(stdout) => Ok(Ok(host_stream(accessor, stdout)?)),
            Err(e) => Ok(Err(e)),
        }
    }
}

impl bindings::icanhaz::nocap::pty::Host for &mut RawState {}

impl<T> bindings::icanhaz::nocap::pty::HostWithStore<T> for RawData {
    async fn open(
        accessor: &Accessor<T, Self>,
        grant: String,
        stdin: StreamReader<u8>,
        control: StreamReader<u8>,
        cols: u16,
        rows: u16,
    ) -> wasmtime::Result<Result<StreamReader<u8>, String>> {
        let native = accessor.with(|mut a| a.get().raw.terminal.clone());
        let Some(native) = native else {
            return Ok(Err(missing("terminal")));
        };
        let stdin = guest_stream(accessor, stdin)?;
        let control = guest_stream(accessor, control)?;
        match native(grant, stdin, control, cols, rows).await {
            Ok(out) => Ok(Ok(host_stream(accessor, out)?)),
            Err(e) => Ok(Err(e)),
        }
    }
}

impl bindings::icanhaz::nocap::notify::Host for &mut RawState {}

impl<T> bindings::icanhaz::nocap::notify::HostWithStore<T> for RawData {
    async fn watch(
        accessor: &Accessor<T, Self>,
        grant: String,
        path: String,
        recursive: bool,
    ) -> wasmtime::Result<Result<StreamReader<u8>, String>> {
        let native = accessor.with(|mut a| a.get().raw.watch.clone());
        let Some(native) = native else {
            return Ok(Err(missing("watch")));
        };
        match native(grant, path, recursive).await {
            Ok(out) => Ok(Ok(host_stream(accessor, out)?)),
            Err(e) => Ok(Err(e)),
        }
    }
}

impl bindings::icanhaz::nocap::providers::Host for &mut RawState {}

impl<T> bindings::icanhaz::nocap::providers::HostWithStore<T> for RawData {
    async fn complete(
        accessor: &Accessor<T, Self>,
        grant: String,
        request: ClientRequest,
    ) -> wasmtime::Result<Result<StreamReader<u8>, String>> {
        let native = accessor.with(|mut a| a.get().raw.complete.clone());
        let Some(native) = native else {
            return Ok(Err(missing("inference")));
        };
        match native(grant, request).await {
            Ok(out) => Ok(Ok(host_stream(accessor, out)?)),
            Err(e) => Ok(Err(e)),
        }
    }

    async fn models(
        accessor: &Accessor<T, Self>,
        grant: String,
    ) -> wasmtime::Result<Result<Vec<ModelInfo>, String>> {
        let native = accessor.with(|mut a| a.get().raw.models.clone());
        let Some(native) = native else {
            return Ok(Err(missing("inference")));
        };
        Ok(native(grant).await)
    }
}

impl bindings::icanhaz::nocap::jail::Host for &mut RawState {}

impl<T> bindings::icanhaz::nocap::jail::HostWithStore<T> for RawData {
    fn root(
        mut access: wasmtime::component::Access<'_, T, Self>,
        grant: String,
    ) -> impl Future<Output = wasmtime::Result<Result<String, String>>> + Send {
        let native = access.get().raw.root.clone();
        let out = match native {
            Some(native) => native(grant),
            None => Err(missing("workspace")),
        };
        std::future::ready(Ok(out))
    }
}
