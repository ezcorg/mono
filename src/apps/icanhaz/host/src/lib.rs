//! icanhaz policy engine — embeds wasmtime to run capability **policy
//! components** (the membrane) and expose their *mediated* exports.
//!
//! This is the core of icanhaz's "capability as code": a grant is never the raw
//! capability, it's the raw capability wrapped by a wasm component that
//! re-exports a capability interface and implements it by delegating —
//! *attenuated* — to the raw one it imports, plus a `policy/context` (who is
//! asking, the caveats, an audit sink, a runtime `escalate` hook).
//!
//! Walking skeleton: composes `world fs-lite-policy` (a tiny `fs-lite` stand-in
//! for `wasi:filesystem`) so the whole mechanism — link the raw host capability
//! + a native context, instantiate the policy component, call its mediated
//! export — is proven before swapping in the real `wasi:filesystem@0.2`. wRPC
//! serving of the mediated export is the next layer up (the daemon).
//!
//! WASI **Preview 2** (`wrpc-wasmtime` / `wasmtime-wasi` are p2-only).
//!
//! Modeled on `wrpc-wasmtime-cli`
//! (`src/rust/wrpc/crates/wasmtime-cli/src/lib.rs`) and the wasmtime-wasi 46
//! `add_to_linker` convention.

use std::path::{Path, PathBuf};

use wasmtime::component::{Component, HasSelf, Linker, Resource, ResourceTable};
use wasmtime::error::Context as _;
use wasmtime::Store;
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

/// Host representation of the `policy/context` resource. The interesting state
/// (audit trail, escalation policy, principal, caveats) lives on [`Host`] so it
/// is shared across every `get-context` the policy makes; this is just the
/// table handle.
pub struct GrantContext;

mod bindings {
    wasmtime::component::bindgen!({
        world: "fs-lite-policy",
        path: "../wit",
        imports: { default: async },
        exports: { default: async },
        // The host's real WASI satisfies the std-runtime imports (io/cli/clocks);
        // map them onto wasmtime-wasi's bindings instead of regenerating.
        with: {
            "wasi": wasmtime_wasi::p2::bindings,
            "icanhaz:nocap/policy.context": crate::GrantContext,
        },
        require_store_data_send: true,
    });
}

use bindings::icanhaz::nocap::{fs_lite, policy, types};

/// wRPC serving of the mediated capability — the remote edge of the engine.
pub mod provider;

/// Generic serving of a wasmtime **component's** exports over wRPC (resources +
/// streams), via `wrpc-wasmtime`'s `ServeExt`. The path for real `wasi:filesystem`.
pub mod component_serve;

/// A native interactive PTY exposed over wRPC streams (the terminal capability).
pub mod terminal;

/// The `process` capability — spawn a caller-named host program with piped stdio
/// (the language-server / build-tool sibling of `terminal`). Served natively.
pub mod process;

/// The daemon's serving layer — every capability on one wRPC server per transport.
pub mod serve;

/// The consent broker — the NoCap gate (request → consent → scoped grant token).
pub mod broker;

/// The consent **surface** — notification + the daemon's loopback approval page
/// (how a backgrounded daemon collects a decision).
pub mod approve;

/// Per-connection request context the transports attach at accept time and every
/// handler receives per invocation. Today it carries the browser-attested
/// `Origin` (which web app is asking). **Trust caveat:** the `Origin` header is
/// faithful *only because a browser sets it* (page JS can't forge it) — it labels
/// the requester, it does not authenticate that the peer is a browser. It feeds
/// the consent decision; it is not itself the gate. Grows a verified peer
/// identity for the tailnet path later.
#[derive(Clone, Debug, Default)]
pub struct ReqCtx {
    pub origin: Option<String>,
}

/// Lets a handler read the requesting origin out of whatever context a given
/// transport supplies — `ReqCtx` on the origin-bearing WebSocket path, `()`
/// elsewhere (the loopback test serves, and WebTransport until it carries one).
pub trait AsOrigin {
    fn origin(&self) -> Option<&str>;
}
impl AsOrigin for () {
    fn origin(&self) -> Option<&str> {
        None
    }
}
impl AsOrigin for ReqCtx {
    fn origin(&self) -> Option<&str> {
        self.origin.as_deref()
    }
}

/// Per-composition host state: the raw filesystem root the policy mediates, the
/// grant identity/caveats the context reports, the audit trail it accumulates,
/// and whether a runtime `escalate` is auto-approved.
pub struct Host {
    table: ResourceTable,
    wasi: WasiCtx,
    /// The raw `fs-lite` is rooted here — the *full* authority the policy narrows.
    root: PathBuf,
    principal: types::Principal,
    caveats: Vec<types::Caveat>,
    /// Skeleton stand-in for a human at the escalation dialog.
    allow_escalation: bool,
    /// Everything the policy wrote to its audit sink, in order.
    pub audit_log: Vec<String>,
}

impl Host {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            table: ResourceTable::new(),
            wasi: WasiCtxBuilder::new().build(),
            root: root.into(),
            principal: types::Principal {
                kind: types::PrincipalKind::WebOrigin,
                id: "https://notes.local".into(),
                display_name: Some("notes (skeleton)".into()),
            },
            caveats: vec![types::Caveat::OnlyPaths(vec!["/jail/".into()])],
            allow_escalation: false,
            audit_log: Vec::new(),
        }
    }

    /// Resolve a policy-supplied path under the raw root, stripping the leading
    /// `/` so it's always confined to `root` (the raw authority's own floor; the
    /// policy component adds the *jail* on top of this).
    fn resolve(&self, path: &str) -> PathBuf {
        self.root.join(path.trim_start_matches('/'))
    }
}

impl WasiView for Host {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView { ctx: &mut self.wasi, table: &mut self.table }
    }
}

/// The **raw** `fs-lite` capability — real files under `root`. This is the
/// unattenuated authority; the policy component is what narrows it.
impl fs_lite::Host for Host {
    async fn read(&mut self, path: String) -> Result<Vec<u8>, String> {
        std::fs::read(self.resolve(&path)).map_err(|e| e.to_string())
    }

    async fn write(&mut self, path: String, data: Vec<u8>) -> Result<(), String> {
        let full = self.resolve(&path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(full, data).map_err(|e| e.to_string())
    }

    async fn read_dir(&mut self, dir: String) -> Result<Vec<String>, String> {
        let mut names = Vec::new();
        for entry in std::fs::read_dir(self.resolve(&dir)).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        Ok(names)
    }
}

/// The `policy` interface — hands the policy component its grant context.
impl policy::Host for Host {
    async fn get_context(&mut self) -> Resource<GrantContext> {
        // Authority stays unambient: the policy can only obtain the context the
        // host chooses to hand it.
        self.table.push(GrantContext).expect("resource table push")
    }
}

/// The `context` resource methods. State lives on `Host`, so the audit trail is
/// unified across every `get-context` the policy makes.
impl policy::HostContext for Host {
    async fn principal(&mut self, _self: Resource<GrantContext>) -> types::Principal {
        self.principal.clone()
    }

    async fn caveats(&mut self, _self: Resource<GrantContext>) -> Vec<types::Caveat> {
        self.caveats.clone()
    }

    async fn audit(&mut self, _self: Resource<GrantContext>, event: String) {
        self.audit_log.push(event);
    }

    async fn escalate(&mut self, _self: Resource<GrantContext>, prompt: String) -> bool {
        self.audit_log.push(format!("escalate? {prompt}"));
        self.allow_escalation
    }

    async fn drop(&mut self, rep: Resource<GrantContext>) -> wasmtime::Result<()> {
        self.table.delete(rep)?;
        Ok(())
    }
}

/// A wasmtime [`Engine`](wasmtime::Engine) configured for async component
/// instantiation — the foundation every policy composition is built on.
pub fn engine() -> wasmtime::Result<wasmtime::Engine> {
    let mut config = wasmtime::Config::new();
    config.wasm_component_model(true);
    // (wasmtime 46: async is always available; `async_support` is now a no-op.)
    wasmtime::Engine::new(&config)
}

/// A live composition: the policy component instantiated over the raw host
/// capability, exposing the *mediated* `fs-lite` the requestor actually sees.
pub struct Composed {
    store: Store<Host>,
    bindings: bindings::FsLitePolicy,
}

impl Composed {
    /// Compose `component` (a `world fs-lite-policy` policy) over a raw filesystem
    /// rooted at `root`: link the raw `fs-lite` + native `policy/context` + WASI,
    /// then instantiate. The returned handle's `fs-lite` calls go *through* the
    /// policy membrane.
    pub async fn load(component_path: &Path, root: &Path) -> wasmtime::Result<Self> {
        let engine = engine()?;
        let component = Component::from_file(&engine, component_path)
            .context("failed to load policy component")?;

        let mut linker = Linker::<Host>::new(&engine);
        // WASI provides the component's std-runtime imports (io/cli/clocks).
        wasmtime_wasi::p2::add_to_linker_async(&mut linker).context("link WASI")?;
        // The raw capability + the policy context are satisfied natively by us —
        // this is the membrane's inner edge.
        fs_lite::add_to_linker::<Host, HasSelf<Host>>(&mut linker, |h| h).context("link fs-lite")?;
        policy::add_to_linker::<Host, HasSelf<Host>>(&mut linker, |h| h).context("link policy")?;

        let mut store = Store::new(&engine, Host::new(root));
        let bindings = bindings::FsLitePolicy::instantiate_async(&mut store, &component, &linker)
            .await
            .context("failed to instantiate policy component")?;
        Ok(Self { store, bindings })
    }

    /// The mediated `fs-lite` (every call routes through the policy).
    pub async fn read(&mut self, path: &str) -> wasmtime::Result<Result<Vec<u8>, String>> {
        self.bindings
            .icanhaz_nocap_fs_lite()
            .call_read(&mut self.store, path)
            .await
    }

    pub async fn write(&mut self, path: &str, data: &[u8]) -> wasmtime::Result<Result<(), String>> {
        self.bindings
            .icanhaz_nocap_fs_lite()
            .call_write(&mut self.store, path, data)
            .await
    }

    pub async fn read_dir(&mut self, dir: &str) -> wasmtime::Result<Result<Vec<String>, String>> {
        self.bindings
            .icanhaz_nocap_fs_lite()
            .call_read_dir(&mut self.store, dir)
            .await
    }

    /// Set the path prefixes the policy sees (as its `only-paths` caveat). The
    /// daemon calls this per request from the presented grant, so the membrane
    /// jails to exactly what was granted. Empty ⇒ the policy permits nothing.
    pub fn set_only_paths(&mut self, paths: Vec<String>) {
        self.store.data_mut().caveats = if paths.is_empty() {
            Vec::new()
        } else {
            vec![types::Caveat::OnlyPaths(paths)]
        };
    }

    /// The audit trail the policy accumulated.
    pub fn audit_log(&self) -> &[String] {
        &self.store.data().audit_log
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn component_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../policies/fs-lite-pathjail/target/wasm32-wasip2/debug/fs_lite_pathjail.wasm")
    }

    #[tokio::test]
    async fn membrane_jails_and_audits() {
        let wasm = component_path();
        assert!(
            wasm.exists(),
            "build the component first: cargo build --target wasm32-wasip2 \
             --manifest-path src/apps/icanhaz/policies/fs-lite-pathjail/Cargo.toml\n  (looked for {})",
            wasm.display()
        );
        let root = tempfile::tempdir().unwrap();
        let mut c = Composed::load(&wasm, root.path()).await.unwrap();

        // Inside the jail: write then read round-trips through the membrane.
        assert!(c.write("/jail/notes/a.txt", b"hello").await.unwrap().is_ok());
        assert_eq!(c.read("/jail/notes/a.txt").await.unwrap().unwrap(), b"hello");

        // Outside the jail: the policy denies the read (it never reaches raw fs).
        assert!(c.read("/etc/passwd").await.unwrap().is_err());

        // Outside-jail write with escalation declined → denied.
        assert!(c.write("/outside.txt", b"x").await.unwrap().is_err());
        assert!(!root.path().join("outside.txt").exists());

        // Every access was audited.
        let audit = c.audit_log();
        assert!(audit.iter().any(|e| e.contains("write /jail/notes/a.txt")));
        assert!(audit.iter().any(|e| e.contains("read /etc/passwd")));
        assert!(audit.iter().any(|e| e.starts_with("escalate?")));
    }
}
