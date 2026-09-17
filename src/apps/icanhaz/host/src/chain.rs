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
use wasmtime::{Engine, Store};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

use crate::components::ComponentStore;

mod workspace_chain {
    wasmtime::component::bindgen!({
        world: "workspace-chain",
        path: "../wit",
        imports: { default: async | trappable },
        exports: { default: async },
    });
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
    native_root_path: Result<String, String>,
}

impl WasiView for ChainState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl workspace_chain::icanhaz::nocap::workspace::Host for ChainState {
    async fn root_path(&mut self, _grant: String) -> wasmtime::Result<Result<String, String>> {
        Ok(self.native_root_path.clone())
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
        workspace_chain::WorkspaceChain::add_to_linker::<_, wasmtime::component::HasSelf<_>>(
            &mut linker,
            |s| s,
        )
        .map_err(anyhow::Error::from)
        .context("link workspace import")?;
        let mut store = Store::new(
            &self.engine,
            ChainState {
                table: ResourceTable::new(),
                wasi: WasiCtxBuilder::new().build(),
                native_root_path: native,
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
}
