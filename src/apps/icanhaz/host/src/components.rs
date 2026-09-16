//! The component store (Tier 3 of authoring, §14 of the RFC): capability
//! components a user brings, validated and kept by hash. Code is fetched and
//! stored freely; authority is granted separately, when a component is
//! linked to a provider.
//!
//! Bytes live on disk beside the daemon's database (`components/<hash>.wasm`);
//! their metadata in the generic state table under the `components` owner.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{bail, Context as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use wit_bindgen_wrpc::bytes::Bytes;

use crate::store::Store;
use crate::AsOrigin;

pub mod bindings {
    wit_bindgen_wrpc::generate!({
        world: "components-wrpc",
        path: "../wit",
    });
}

use bindings::exports::icanhaz::nocap::components::ComponentInfo as InfoWire;
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
    "icanhaz:fspass",
    "ezco:ezcap",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComponentInfo {
    pub hash: String,
    pub name: Option<String>,
    pub size: u64,
    pub imports: Vec<String>,
    pub exports: Vec<String>,
    pub added: u64,
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
    for export in exports {
        if !is_capability_package(export) {
            bail!("export `{export}` is not a capability interface; a capability component exports the interface it provides");
        }
    }
    Ok(())
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
    })
}

const OWNER: &str = "components";

/// Components on disk, by hash, with metadata in the store.
pub struct ComponentStore {
    dir: PathBuf,
    store: Option<Store>,
}

impl ComponentStore {
    pub fn new(dir: PathBuf, store: Option<Store>) -> Self {
        Self { dir, store }
    }

    pub fn path(&self, hash: &str) -> PathBuf {
        self.dir
            .join(hash.trim_start_matches("sha256:"))
            .with_extension("wasm")
    }

    /// Validate, hash and keep `bytes`. Adding what is already there returns
    /// the same info.
    pub async fn add(&self, bytes: &[u8]) -> anyhow::Result<ComponentInfo> {
        let info = validate(bytes)?;
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
    }
}

#[derive(Clone)]
pub struct ComponentsProvider {
    components: Arc<ComponentStore>,
}

impl ComponentsProvider {
    pub fn new(components: Arc<ComponentStore>) -> Self {
        Self { components }
    }
}

impl<C: AsOrigin + Send + Sync + 'static> bindings::exports::icanhaz::nocap::components::Handler<C>
    for ComponentsProvider
{
    async fn add(&self, _cx: C, bytes: Bytes) -> anyhow::Result<Result<InfoWire, String>> {
        Ok(self
            .components
            .add(&bytes)
            .await
            .map(to_wire)
            .map_err(|e| format!("{e:#}")))
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn passthrough() -> Option<Vec<u8>> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../policies/fs-passthrough/target/wasm32-wasip2/debug/fs_passthrough.wasm"
        );
        std::fs::read(path).ok()
    }

    #[test]
    fn the_tier_3_rule_names_the_stray_import() {
        let ok = check_interfaces(
            &[
                "wasi:filesystem/types@0.2.12".into(),
                "icanhaz:fspass/gate@0.1.0".into(),
            ],
            &[
                "wasi:filesystem/types@0.2.12".into(),
                "icanhaz:fspass/mount@0.1.0".into(),
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
        assert!(check_interfaces(&[], &["acme:thing/x".into()]).is_err());
        assert!(!is_capability_package("acme:regex/engine@1.0.0"));
        assert!(is_capability_package("wasi:clocks/wall-clock@0.2.0"));
    }

    #[test]
    fn garbage_is_not_a_component() {
        assert!(validate(b"not wasm").is_err());
    }

    #[tokio::test]
    async fn the_shipped_passthrough_validates_and_round_trips_through_the_store() {
        let Some(bytes) = passthrough() else {
            eprintln!("fs_passthrough.wasm not built; skipping");
            return;
        };
        let info = validate(&bytes).expect("a capability component");
        assert!(info.hash.starts_with("sha256:"));
        assert!(
            info.imports
                .iter()
                .any(|i| i.starts_with("icanhaz:fspass/gate")),
            "{:?}",
            info.imports
        );
        assert!(
            info.exports
                .iter()
                .any(|e| e.starts_with("icanhaz:fspass/mount")),
            "{:?}",
            info.exports
        );

        let dir = tempfile::tempdir().unwrap();
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let store = Store::open_with(dir.path().join("icanhaz.db"), &source)
            .await
            .unwrap();
        let components = ComponentStore::new(dir.path().join("components"), Some(store));
        let added = components.add(&bytes).await.unwrap();
        assert_eq!(added.hash, info.hash);
        assert_eq!(components.list().await.len(), 1);
        assert_eq!(components.get(&info.hash).unwrap().len(), bytes.len());
        // Adding again is idempotent.
        components.add(&bytes).await.unwrap();
        assert_eq!(components.list().await.len(), 1);
        assert!(components.remove(&info.hash).await.unwrap());
        assert!(components.get(&info.hash).is_err());
        assert!(components.list().await.is_empty());
    }
}
