//! The component store (Tier 3 of authoring, §14 of the RFC): capability
//! components a user brings, validated and kept by hash. Code is fetched and
//! stored freely; authority is granted separately, when a component is
//! linked to a provider.
//!
//! Bytes live on disk beside the daemon's database (`components/<hash>.wasm`);
//! their metadata in the generic state table under the `components` owner.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{bail, Context as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use wit_bindgen_wrpc::bytes::Bytes;

use crate::broker::GrantKind as _;
use crate::store::Store;
use crate::AsOrigin;

pub mod bindings {
    wit_bindgen_wrpc::generate!({
        world: "components-wrpc",
        path: "../wit",
    });
}

use bindings::exports::icanhaz::nocap::components::{
    ComponentInfo as InfoWire, Provenance as ProvenanceWire, Publication as PublishedWire,
};
pub use bindings::icanhaz::nocap::components as client;

/// The packages whose interfaces a capability component may import or
/// export. Anything else is a library and must be composed in.
pub const CAPABILITY_PACKAGES: &[&str] = &[
    "wasi:filesystem",
    "wasi:io",
    "wasi:clocks",
    "wasi:random",
    "wasi:cli",
    "icanhaz:nocap",
    "ezco:ezcap",
];

/// Where a component came from, as its author states it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Provenance {
    pub source: String,
    pub revision: Option<String>,
    pub build: Option<String>,
    pub builder: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComponentInfo {
    pub hash: String,
    pub name: Option<String>,
    pub size: u64,
    pub imports: Vec<String>,
    pub exports: Vec<String>,
    pub added: u64,
    #[serde(default)]
    pub provenance: Option<Provenance>,
    /// True only once a rebuild from `provenance` matched `hash`.
    #[serde(default)]
    pub reproducible: bool,
}

fn package_of(interface: &str) -> &str {
    interface.split('/').next().unwrap_or(interface)
}

fn is_capability_package(interface: &str) -> bool {
    let pkg = package_of(interface);
    let pkg = pkg.split('@').next().unwrap_or(pkg);
    CAPABILITY_PACKAGES.contains(&pkg)
}

/// The Tier 3 rule over a component's interfaces, by name.
pub fn check_interfaces(imports: &[String], exports: &[String]) -> anyhow::Result<()> {
    for import in imports {
        if !is_capability_package(import) {
            bail!(
                "import `{import}` is not a capability interface: compose your libraries in at build time (wac), the daemon links only capabilities"
            );
        }
    }
    if exports.is_empty() {
        bail!("the component exports nothing a capability could be served from");
    }
    // An export is a capability interface: one of the daemon's own, or a
    // novel one an author brings. WASI's own interfaces are the host's to
    // provide, not a component's to offer, except the filesystem the
    // passthrough re-exports.
    if !exports.iter().any(|e| is_servable_export(e)) {
        bail!("the component exports only WASI interfaces; a capability component exports the interface it provides");
    }
    Ok(())
}

fn is_servable_export(interface: &str) -> bool {
    let pkg = package_of(interface);
    !pkg.starts_with("wasi:") || pkg.starts_with("wasi:filesystem")
}

/// Whether `interface` is one the daemon provides natively (served by its own
/// providers), as opposed to a novel one only a store component can serve.
pub fn is_native_interface(interface: &str) -> bool {
    is_capability_package(interface)
}

/// The `ezco:ezcap` admission environment for `interface`, from the WIT the
/// component itself carries: what lets a scope over a novel interface be
/// type-checked and admitted like a native kind's.
pub fn env_for(bytes: &[u8], interface: &str) -> anyhow::Result<ezcap::CallEnv> {
    // ezcap resolves the WIT with its own wit-parser, so the environment is
    // built against the version its evaluator was compiled with.
    let resolve = ezcap::env::resolve_component(bytes).map_err(|e| anyhow::anyhow!(e))?;
    ezcap::CallEnv::for_kind(&resolve, &ezcap::Kind::new(interface))
        .map_err(|e| anyhow::anyhow!("environment for `{interface}`: {e}"))
}

/// Decode a component's world: its name and qualified import/export names.
pub fn inspect(bytes: &[u8]) -> anyhow::Result<(Option<String>, Vec<String>, Vec<String>)> {
    let decoded = wit_parser::decoding::decode(bytes).context("not a WebAssembly component")?;
    let (resolve, world) = match decoded {
        wit_parser::decoding::DecodedWasm::Component(resolve, world) => (resolve, world),
        wit_parser::decoding::DecodedWasm::WitPackage(..) => {
            bail!("a WIT package, not a component")
        }
    };
    let world = &resolve.worlds[world];
    let name = |key: &wit_parser::WorldKey| -> String {
        match key {
            wit_parser::WorldKey::Name(n) => n.clone(),
            wit_parser::WorldKey::Interface(id) => resolve
                .id_of(*id)
                .unwrap_or_else(|| format!("<anonymous {id:?}>")),
        }
    };
    let imports = world.imports.keys().map(name).collect();
    let exports = world.exports.keys().map(name).collect();
    Ok((Some(world.name.clone()), imports, exports))
}

/// Validate and describe `bytes` without storing them.
pub fn validate(bytes: &[u8]) -> anyhow::Result<ComponentInfo> {
    let (name, imports, exports) = inspect(bytes)?;
    check_interfaces(&imports, &exports)?;
    Ok(ComponentInfo {
        hash: format!("sha256:{:x}", Sha256::digest(bytes)),
        name,
        size: bytes.len() as u64,
        imports,
        exports,
        added: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        provenance: None,
        reproducible: false,
    })
}

/// Compose components with wac: each later component's imports are
/// satisfied by earlier ones' exports (so `parts` runs inner to outer),
/// what remains is imported, and the last component's exports are exported.
/// Returns the composition's bytes.
pub fn compose(parts: &[Vec<u8>]) -> anyhow::Result<Vec<u8>> {
    use wac_graph::{CompositionGraph, EncodeOptions};
    use wac_types::Package;
    if parts.is_empty() {
        bail!("nothing to compose");
    }
    let mut graph = CompositionGraph::new();
    let mut instances: Vec<(wac_graph::NodeId, Vec<String>)> = Vec::new();
    for (i, bytes) in parts.iter().enumerate() {
        validate(bytes).with_context(|| format!("component {i} is not a capability component"))?;
        let package = Package::from_bytes(
            &format!("compose:c{i}"),
            None,
            bytes.clone(),
            graph.types_mut(),
        )
        .with_context(|| format!("parse component {i}"))?;
        let world = &graph.types()[package.ty()];
        let imports: Vec<String> = world.imports.keys().cloned().collect();
        let exports: Vec<String> = world.exports.keys().cloned().collect();
        let pid = graph.register_package(package)?;
        let inst = graph.instantiate(pid);
        for import in &imports {
            if let Some((src, _)) = instances.iter().rev().find(|(_, ex)| ex.contains(import)) {
                let alias = graph.alias_instance_export(*src, import)?;
                graph.set_instantiation_argument(inst, import, alias)?;
            }
        }
        instances.push((inst, exports));
    }
    let Some((last, exports)) = instances.last() else {
        bail!("nothing to compose");
    };
    for e in exports {
        let alias = graph.alias_instance_export(*last, e)?;
        graph.export(alias, e.as_str())?;
    }
    let bytes = graph.encode(EncodeOptions::default())?;
    validate(&bytes).context("the composition is not a capability component")?;
    Ok(bytes)
}

/// The composition a grant's chain names: `via` (outermost first), composed
/// in front of the shipped component providing the interface the outermost
/// wrapper exports, with any native capability imports satisfied the same
/// way (see [`ComponentStore::provide_imports`]).
impl ComponentStore {
    pub fn capability_chain(&self, via: &[String]) -> anyhow::Result<Vec<u8>> {
        let mut parts = Vec::new();
        for hash in via.iter().rev() {
            parts.push(
                self.get(hash)
                    .with_context(|| format!("chain component {hash}"))?,
            );
        }
        let bytes = if parts.len() == 1 {
            parts.remove(0)
        } else {
            compose(&parts)?
        };
        let bytes = self.provide_imports(bytes)?;
        let info = validate(&bytes)?;
        tracing::info!(hash = %info.hash, ?via, "capability chain composed");
        Ok(bytes)
    }
}

const OWNER: &str = "components";

/// Components on disk, by hash, with metadata in the store.
pub struct ComponentStore {
    dir: PathBuf,
    store: Option<Store>,
    /// The shipped component providing each native capability interface
    /// (by qualified interface name → hash): what satisfies a component's
    /// import of one.
    shipped: std::sync::Mutex<HashMap<String, String>>,
}

impl ComponentStore {
    pub fn new(dir: PathBuf, store: Option<Store>) -> Self {
        Self {
            dir,
            store,
            shipped: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Note that the component `hash` is the daemon's provider of every
    /// capability interface it exports.
    pub fn register_shipped(&self, info: &ComponentInfo) {
        let mut shipped = self.shipped.lock().unwrap_or_else(|e| e.into_inner());
        for e in &info.exports {
            if is_native_interface(e) {
                shipped.insert(e.clone(), info.hash.clone());
            }
        }
    }

    /// The shipped component providing `interface`, if any.
    pub fn shipped(&self, interface: &str) -> Option<String> {
        self.shipped
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(interface)
            .cloned()
    }

    /// Satisfy a component's imports of native capability interfaces by
    /// composing the shipped components providing them in front of it, so
    /// what remains imported is only the raw host layer and WASI. A component
    /// that builds on inference imports `icanhaz:nocap/inference`; the
    /// shipped inference component exports it and imports the raw layer.
    pub fn provide_imports(&self, bytes: Vec<u8>) -> anyhow::Result<Vec<u8>> {
        let info = validate(&bytes)?;
        let mut providers = Vec::new();
        for import in &info.imports {
            if let Some(hash) = self.shipped(import) {
                if !providers.contains(&hash) {
                    providers.push(hash);
                }
            }
        }
        if providers.is_empty() {
            return Ok(bytes);
        }
        let mut parts = Vec::new();
        for hash in providers {
            parts.push(
                self.get(&hash)
                    .with_context(|| format!("shipped provider {hash}"))?,
            );
        }
        parts.push(bytes);
        compose(&parts)
    }

    pub fn path(&self, hash: &str) -> PathBuf {
        self.dir
            .join(hash.trim_start_matches("sha256:"))
            .with_extension("wasm")
    }

    /// Validate, hash and keep `bytes`. Adding what is already there keeps
    /// its info, taking a newly supplied provenance over none.
    pub async fn add(
        &self,
        bytes: &[u8],
        provenance: Option<Provenance>,
    ) -> anyhow::Result<ComponentInfo> {
        let mut info = validate(bytes)?;
        if let Some(existing) = self.find(&info.hash).await {
            info.added = existing.added;
            info.reproducible = existing.reproducible;
            info.provenance = provenance.or(existing.provenance);
        } else {
            info.provenance = provenance;
        }
        std::fs::create_dir_all(&self.dir)
            .with_context(|| format!("create {}", self.dir.display()))?;
        let path = self.path(&info.hash);
        if !path.exists() {
            std::fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))?;
        }
        if let Some(store) = &self.store {
            store
                .state_set(OWNER, &info.hash, &serde_json::to_vec(&info)?)
                .await?;
        }
        Ok(info)
    }

    pub async fn find(&self, hash: &str) -> Option<ComponentInfo> {
        self.list().await.into_iter().find(|c| c.hash == hash)
    }

    pub async fn list(&self) -> Vec<ComponentInfo> {
        let Some(store) = &self.store else {
            return Vec::new();
        };
        match store.state_list(OWNER, "sha256:").await {
            Ok(rows) => rows
                .into_iter()
                .filter_map(|(_, bytes)| serde_json::from_slice(&bytes).ok())
                .collect(),
            Err(err) => {
                tracing::warn!(?err, "could not list components");
                Vec::new()
            }
        }
    }

    pub fn get(&self, hash: &str) -> anyhow::Result<Vec<u8>> {
        let path = self.path(hash);
        std::fs::read(&path).with_context(|| format!("no component {hash}"))
    }

    pub async fn remove(&self, hash: &str) -> anyhow::Result<bool> {
        let path = self.path(hash);
        let existed = path.exists();
        if existed {
            std::fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
        }
        if let Some(store) = &self.store {
            store.state_delete(OWNER, hash).await?;
        }
        Ok(existed)
    }
}

fn to_wire(i: ComponentInfo) -> InfoWire {
    InfoWire {
        hash: i.hash,
        name: i.name,
        size: i.size,
        imports: i.imports,
        exports: i.exports,
        added: i.added,
        provenance: i.provenance.map(|p| ProvenanceWire {
            source: p.source,
            revision: p.revision,
            build: p.build,
            builder: p.builder,
        }),
        reproducible: i.reproducible,
    }
}

pub fn provenance_from_wire(p: ProvenanceWire) -> Provenance {
    Provenance {
        source: p.source,
        revision: p.revision,
        build: p.build,
        builder: p.builder,
    }
}

/// What runs once a component has landed, before `add` replies: the daemon
/// registers the interfaces it brings (their admission environments, their
/// serving on every transport), so a page that adds a component can use it
/// the moment the call returns.
pub type AfterAdd = Arc<
    dyn Fn(ComponentInfo) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        + Send
        + Sync,
>;

/// Who may put code in the store: decides for the requesting principal.
/// Adding grants nothing, but it takes disk and a name on the offers list,
/// so it is for the local user and the hosts the human approved.
pub type InstallGate = Arc<dyn Fn(&crate::broker::Principal) -> Result<(), String> + Send + Sync>;

#[derive(Clone)]
pub struct ComponentsProvider {
    components: Arc<ComponentStore>,
    after_add: Option<AfterAdd>,
    fetcher: Option<Arc<crate::fetch::Fetcher>>,
    install: Option<InstallGate>,
    /// The daemon's registry index, for `publish`; without one, publishing is refused.
    registry: Option<Arc<crate::registry::RegistryIndex>>,
}

impl ComponentsProvider {
    pub fn new(components: Arc<ComponentStore>) -> Self {
        Self {
            components,
            after_add: None,
            fetcher: None,
            install: None,
            registry: None,
        }
    }

    /// Where `publish` puts tags: the served registry's index.
    pub fn with_registry(mut self, registry: Arc<crate::registry::RegistryIndex>) -> Self {
        self.registry = Some(registry);
        self
    }

    /// Gate `add` and `fetch` by requester; without one, anyone may install.
    pub fn with_install_gate(mut self, gate: InstallGate) -> Self {
        self.install = Some(gate);
        self
    }

    fn may_install(&self, cx: &impl AsOrigin) -> Result<(), String> {
        match &self.install {
            Some(gate) => gate(&crate::broker::principal_of(cx)),
            None => Ok(()),
        }
    }

    /// Make sure `hash` is held, fetching it from `source` when not; what
    /// lands must hash to `hash`, whatever the source served.
    pub async fn ensure(
        &self,
        hash: &str,
        source: Option<&str>,
    ) -> Result<crate::broker::ComponentSummary, String> {
        if let Some(info) = self.components.find(hash).await {
            return Ok(summary(&info));
        }
        let Some(source) = source else {
            return Err(format!(
                "this daemon does not hold {hash} and the request names no source"
            ));
        };
        let Some(fetcher) = &self.fetcher else {
            return Err("this daemon fetches nothing: no OCI or peer client".to_string());
        };
        let source = crate::fetch::ComponentSource::parse(source).map_err(|e| format!("{e:#}"))?;
        let (bytes, provenance) = fetcher.fetch(&source).await.map_err(|e| format!("{e:#}"))?;
        let fetched = validate(&bytes).map_err(|e| format!("{e:#}"))?;
        if fetched.hash != hash {
            return Err(format!(
                "{source} serves {}, not the {hash} the request names",
                fetched.hash
            ));
        }
        let info = self.land(&bytes, Some(provenance)).await?;
        Ok(crate::broker::ComponentSummary {
            hash: info.hash,
            name: info.name,
            source: info.provenance.as_ref().map(|p| p.source.clone()),
            revision: info.provenance.as_ref().and_then(|p| p.revision.clone()),
            reproducible: info.reproducible,
        })
    }

    pub fn with_after_add(mut self, hook: AfterAdd) -> Self {
        self.after_add = Some(hook);
        self
    }

    /// What `fetch` pulls with; without it, `fetch` refuses.
    pub fn with_fetcher(mut self, fetcher: Arc<crate::fetch::Fetcher>) -> Self {
        self.fetcher = Some(fetcher);
        self
    }

    /// Keep `bytes` with `provenance` and tell the daemon it landed.
    async fn land(&self, bytes: &[u8], provenance: Option<Provenance>) -> Result<InfoWire, String> {
        let info = self
            .components
            .add(bytes, provenance)
            .await
            .map_err(|e| format!("{e:#}"))?;
        if let Some(hook) = &self.after_add {
            hook(info.clone()).await;
        }
        Ok(to_wire(info))
    }
}

fn summary(info: &ComponentInfo) -> crate::broker::ComponentSummary {
    crate::broker::ComponentSummary {
        hash: info.hash.clone(),
        name: info.name.clone(),
        source: info.provenance.as_ref().map(|p| p.source.clone()),
        revision: info.provenance.as_ref().and_then(|p| p.revision.clone()),
        reproducible: info.reproducible,
    }
}

impl crate::broker::ComponentResolver for ComponentsProvider {
    fn ensure(
        &self,
        hash: String,
        source: Option<String>,
    ) -> futures::future::BoxFuture<'static, Result<crate::broker::ComponentSummary, String>> {
        let me = self.clone();
        Box::pin(async move { me.ensure(&hash, source.as_deref()).await })
    }
}

impl<C: AsOrigin + Send + Sync + 'static> bindings::exports::icanhaz::nocap::components::Handler<C>
    for ComponentsProvider
{
    async fn add(
        &self,
        cx: C,
        bytes: Bytes,
        provenance: Option<ProvenanceWire>,
    ) -> anyhow::Result<Result<InfoWire, String>> {
        if let Err(e) = self.may_install(&cx) {
            return Ok(Err(e));
        }
        Ok(self
            .land(&bytes, provenance.map(provenance_from_wire))
            .await)
    }

    async fn fetch(&self, cx: C, source: String) -> anyhow::Result<Result<InfoWire, String>> {
        if let Err(e) = self.may_install(&cx) {
            return Ok(Err(e));
        }
        let Some(fetcher) = &self.fetcher else {
            return Ok(Err(
                "this daemon fetches nothing: no OCI or peer client".to_string()
            ));
        };
        let source = match crate::fetch::ComponentSource::parse(&source) {
            Ok(s) => s,
            Err(e) => return Ok(Err(format!("{e:#}"))),
        };
        let (bytes, provenance) = match fetcher.fetch(&source).await {
            Ok(fetched) => fetched,
            Err(e) => return Ok(Err(format!("{e:#}"))),
        };
        Ok(self.land(&bytes, Some(provenance)).await)
    }

    async fn all(&self, _cx: C) -> anyhow::Result<Vec<InfoWire>> {
        Ok(self
            .components
            .list()
            .await
            .into_iter()
            .map(to_wire)
            .collect())
    }

    async fn get(&self, _cx: C, hash: String) -> anyhow::Result<Result<Bytes, String>> {
        Ok(self
            .components
            .get(&hash)
            .map(Bytes::from)
            .map_err(|e| format!("{e:#}")))
    }

    async fn remove(&self, cx: C, hash: String) -> anyhow::Result<Result<bool, String>> {
        if let Some(o) = cx.origin() {
            return Ok(Err(format!(
                "removing components is for local hosts, not pages ({o})"
            )));
        }
        Ok(self
            .components
            .remove(&hash)
            .await
            .map_err(|e| format!("{e:#}")))
    }

    async fn publish(
        &self,
        cx: C,
        hash: String,
        reference: String,
    ) -> anyhow::Result<Result<PublishedWire, String>> {
        if let Some(o) = cx.origin() {
            return Ok(Err(format!(
                "publishing is for local hosts, not pages ({o})"
            )));
        }
        let Some(registry) = &self.registry else {
            return Ok(Err(
                "this daemon serves no registry (set ICANHAZ_REGISTRY_BIND)".to_string(),
            ));
        };
        Ok(registry
            .publish(&hash, &reference)
            .await
            .map(published_to_wire)
            .map_err(|e| format!("{e:#}")))
    }

    async fn unpublish(&self, cx: C, reference: String) -> anyhow::Result<Result<bool, String>> {
        if let Some(o) = cx.origin() {
            return Ok(Err(format!(
                "publishing is for local hosts, not pages ({o})"
            )));
        }
        let Some(registry) = &self.registry else {
            return Ok(Err("this daemon serves no registry".to_string()));
        };
        Ok(registry
            .unpublish(&reference)
            .await
            .map_err(|e| format!("{e:#}")))
    }

    async fn published(&self, _cx: C) -> anyhow::Result<Vec<PublishedWire>> {
        Ok(match &self.registry {
            Some(registry) => registry
                .published()
                .await
                .into_iter()
                .map(published_to_wire)
                .collect(),
            None => Vec::new(),
        })
    }
}

fn published_to_wire(p: crate::registry::Published) -> PublishedWire {
    PublishedWire {
        reference: p.reference,
        digest: p.digest,
        hash: p.hash,
    }
}

/// The gate interface a component imports to consume a grant of `kind`
/// (`icanhaz:nocap/gate-<kind>@…`): how a component names the kind it serves.
fn gate_for(kind: &str) -> String {
    format!("icanhaz:nocap/gate-{kind}@")
}

impl ComponentStore {
    /// The interfaces a grant of `kind` is used through: whatever the
    /// registered components consuming that kind's gate export, wrappers
    /// included (a wrapper exports the interface it wraps). Derived from the
    /// store, so a capability's identity lives in its component, not here.
    pub async fn interfaces_of(&self, kind: &str) -> Vec<String> {
        let gate = gate_for(kind);
        let mut out = Vec::new();
        for info in self.list().await {
            if info.imports.iter().any(|i| i.starts_with(&gate)) {
                for e in &info.exports {
                    if !out.contains(e) {
                        out.push(e.clone());
                    }
                }
            }
        }
        out
    }

    /// Whether `component` can provide a grant of `kind`: for a native kind,
    /// it exports an interface the kind is used through; for a component
    /// kind, it exports the interface itself.
    pub async fn offers(
        &self,
        kind: &crate::broker::CapabilityKind,
        component: &ComponentInfo,
    ) -> bool {
        match kind {
            crate::broker::CapabilityKind::Component(c) => component.exports.contains(&c.provides),
            other => {
                let used_through = self.interfaces_of(other.tag()).await;
                component.exports.iter().any(|e| used_through.contains(e))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn passthrough() -> Option<Vec<u8>> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../capabilities/filesystem/target/wasm32-wasip2/release/filesystem_capability.wasm"
        );
        std::fs::read(path).ok()
    }

    #[test]
    fn the_tier_3_rule_names_the_stray_import() {
        let ok = check_interfaces(
            &[
                "wasi:filesystem/types@0.2.12".into(),
                "icanhaz:nocap/gate-filesystem@0.1.0".into(),
            ],
            &[
                "wasi:filesystem/types@0.2.12".into(),
                "icanhaz:nocap/filesystem@0.1.0".into(),
            ],
        );
        assert!(ok.is_ok());
        let err = check_interfaces(
            &[
                "wasi:io/streams@0.2.12".into(),
                "acme:regex/engine@1.0.0".into(),
            ],
            &["icanhaz:nocap/inference@0.1.0".into()],
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("acme:regex/engine@1.0.0"), "{err}");
        assert!(err.contains("compose"), "{err}");
        assert!(check_interfaces(&[], &[]).is_err());
        // A novel interface is a capability an author brings; WASI alone is not.
        assert!(check_interfaces(&[], &["acme:thing/x".into()]).is_ok());
        assert!(check_interfaces(&[], &["wasi:cli/run@0.2.12".into()]).is_err());
        assert!(!is_native_interface("acme:thing/x@1.0.0"));
        assert!(is_native_interface("icanhaz:nocap/process@0.1.0"));
        assert!(!is_capability_package("acme:regex/engine@1.0.0"));
        assert!(is_capability_package("wasi:clocks/wall-clock@0.2.0"));
    }

    #[test]
    fn a_filesystem_wrapper_composes_in_front_of_the_passthrough() {
        let Some(bytes) = passthrough() else {
            eprintln!("filesystem_capability.wasm not built; skipping");
            return;
        };
        let wrapper = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/fs_wrap.wasm"
        ))
        .expect("fs_wrap.wasm fixture");
        // The wrapper imports types and mount from the passthrough and
        // re-exports both; the passthrough's own roots stay the composition's.
        // This is what `filesystem_chain` builds for a grant naming the wrapper.
        let composed = compose(&[bytes, wrapper]).expect("composes");
        let info = validate(&composed).expect("a capability component");
        assert!(
            info.exports
                .iter()
                .any(|e| e.starts_with("wasi:filesystem/types@")),
            "{:?}",
            info.exports
        );
        assert!(
            info.exports
                .iter()
                .any(|e| e.starts_with("icanhaz:nocap/filesystem@")),
            "{:?}",
            info.exports
        );
        assert!(
            info.imports
                .iter()
                .any(|i| i.starts_with("icanhaz:nocap/gate-filesystem@")),
            "{:?}",
            info.imports
        );
        assert!(
            info.imports
                .iter()
                .any(|i| i.starts_with("icanhaz:nocap/jail@")),
            "{:?}",
            info.imports
        );
        assert!(
            !info
                .imports
                .iter()
                .any(|i| i.starts_with("icanhaz:nocap/filesystem@")),
            "the inner mount is wired, not imported: {:?}",
            info.imports
        );
    }

    /// A request naming a provider this daemon lacks, with a source: the
    /// provider resolves through the store, fetching and keeping the bytes
    /// with their provenance; bytes that do not hash as the request names
    /// are refused and never kept.
    #[tokio::test]
    async fn a_missing_provider_is_fetched_from_its_source_and_checked_against_its_hash() {
        let greeter = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/greeter.wasm"
        ))
        .expect("greeter.wasm fixture");
        let hash = validate(&greeter).unwrap().hash;
        let (addr, manifest_digest) =
            crate::fetch::tests::registry("acme/greeter", &greeter, greeter.clone()).await;
        let dir = tempfile::tempdir().unwrap();
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let db = Store::open_with(dir.path().join("icanhaz.db"), &source)
            .await
            .unwrap();
        let store = Arc::new(ComponentStore::new(dir.path().join("components"), Some(db)));
        let provider = ComponentsProvider::new(Arc::clone(&store)).with_fetcher(Arc::new(
            crate::fetch::Fetcher::with_protocol(
                crate::fetch::tests::plain_http(),
                None,
                crate::fetch::Credentials::shared(),
            ),
        ));
        let oci = format!("oci://{addr}/acme/greeter:latest");

        // Not held, no source: refused.
        let err = provider.ensure(&hash, None).await.unwrap_err();
        assert!(err.contains("names no source"), "{err}");
        // Wrong hash for what the source serves: refused, nothing kept.
        let other = format!("sha256:{}", "11".repeat(32));
        let err = provider.ensure(&other, Some(&oci)).await.unwrap_err();
        assert!(err.contains(&hash) && err.contains(&other), "{err}");
        assert!(store.find(&other).await.is_none());
        assert!(store.find(&hash).await.is_none());
        // The right hash: fetched, kept with its provenance, described.
        let summary = provider.ensure(&hash, Some(&oci)).await.expect("resolved");
        assert_eq!(summary.hash, hash);
        assert_eq!(summary.source.as_deref(), Some(oci.as_str()));
        assert_eq!(summary.revision.as_deref(), Some(manifest_digest.as_str()));
        assert!(!summary.reproducible);
        assert_eq!(
            store.find(&hash).await.unwrap().provenance.unwrap().source,
            oci
        );
        // Held now: resolved without a source, and through the broker's trait.
        assert_eq!(provider.ensure(&hash, None).await.unwrap().hash, hash);
        assert_eq!(
            crate::broker::ComponentResolver::ensure(&provider, hash.clone(), None)
                .await
                .unwrap()
                .hash,
            hash
        );
    }

    /// Installing is for the local user and approved hosts: a page from an
    /// unapproved origin cannot add or fetch, and a local caller can.
    #[tokio::test]
    async fn installing_is_gated_by_requester() {
        use bindings::exports::icanhaz::nocap::components::Handler as _;

        let greeter = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/greeter.wasm"
        ))
        .expect("greeter.wasm fixture");
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(ComponentStore::new(dir.path().join("components"), None));
        let provider = ComponentsProvider::new(store).with_install_gate(Arc::new(|p| {
            if p.id == "https://stranger.example" {
                Err(format!("{} is not an approved host", p.id))
            } else {
                Ok(())
            }
        }));
        let page = crate::ReqCtx {
            origin: Some("https://stranger.example".to_string()),
            peer: None,
            conn: None,
        };
        let refused = provider
            .add(page.clone(), greeter.clone().into(), None)
            .await
            .unwrap()
            .unwrap_err();
        assert!(refused.contains("not an approved host"), "{refused}");
        let refused = provider
            .fetch(page, "oci://ghcr.io/acme/greeter:latest".to_string())
            .await
            .unwrap()
            .unwrap_err();
        assert!(refused.contains("not an approved host"), "{refused}");
        let added = provider
            .add(crate::ReqCtx::default(), greeter.into(), None)
            .await
            .unwrap()
            .expect("the local user may add");
        assert!(added.hash.starts_with("sha256:"));
    }

    #[test]
    fn garbage_is_not_a_component() {
        assert!(validate(b"not wasm").is_err());
    }

    #[tokio::test]
    async fn the_shipped_passthrough_validates_and_round_trips_through_the_store() {
        let Some(bytes) = passthrough() else {
            eprintln!("filesystem_capability.wasm not built; skipping");
            return;
        };
        let info = validate(&bytes).expect("a capability component");
        assert!(info.hash.starts_with("sha256:"));
        assert!(
            info.imports
                .iter()
                .any(|i| i.starts_with("icanhaz:nocap/gate-filesystem")),
            "{:?}",
            info.imports
        );
        assert!(
            info.exports
                .iter()
                .any(|e| e.starts_with("icanhaz:nocap/filesystem")),
            "{:?}",
            info.exports
        );

        let dir = tempfile::tempdir().unwrap();
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let store = Store::open_with(dir.path().join("icanhaz.db"), &source)
            .await
            .unwrap();
        let components = ComponentStore::new(dir.path().join("components"), Some(store));
        let added = components.add(&bytes, None).await.unwrap();
        assert_eq!(added.hash, info.hash);
        assert_eq!(components.list().await.len(), 1);
        assert_eq!(components.get(&info.hash).unwrap().len(), bytes.len());
        // Adding again is idempotent; provenance is kept once supplied.
        components.add(&bytes, None).await.unwrap();
        assert_eq!(components.list().await.len(), 1);
        let with = components
            .add(
                &bytes,
                Some(Provenance {
                    source: "https://github.com/ezco/mono".into(),
                    revision: Some("abc123".into()),
                    build: Some("cargo build --target wasm32-wasip2".into()),
                    builder: None,
                }),
            )
            .await
            .unwrap();
        assert_eq!(
            with.provenance.as_ref().map(|p| p.source.as_str()),
            Some("https://github.com/ezco/mono")
        );
        assert!(!with.reproducible);
        let again = components.add(&bytes, None).await.unwrap();
        assert_eq!(again.provenance, with.provenance);
        assert_eq!(components.list().await.len(), 1);
        assert!(components.remove(&info.hash).await.unwrap());
        assert!(components.get(&info.hash).is_err());
        assert!(components.list().await.is_empty());
    }
}
