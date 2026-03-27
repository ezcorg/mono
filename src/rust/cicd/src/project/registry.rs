use crate::project::rust::RustProject;
use crate::project::wasm::WasmComponentProject;
use crate::project::{Project, ProjectKind};
use crate::types::{BuildTarget, ProjectId};
use std::path::Path;

/// Returns all registered projects in the monorepo.
pub fn all_projects(repo_root: &Path) -> Vec<Box<dyn Project>> {
    vec![
        Box::new(RustProject {
            id: ProjectId::new("witmproxy"),
            kind: ProjectKind::RustCrate,
            root: repo_root.join("src/apps/witmproxy"),
            package_name: "witmproxy".into(),
            bin_name: Some("witm".into()),
            build_targets: BuildTarget::ALL.to_vec(),
            tag_prefix: "witmproxy-v".into(),
        }),
        Box::new(WasmComponentProject {
            id: ProjectId::new("witmproxy-plugin-noshorts"),
            root: repo_root.join("src/rust/witmproxy-plugin-noshorts"),
            package_name: "witmproxy-plugin-noshorts".into(),
            tag_prefix: "witmproxy-plugin-noshorts-v".into(),
        }),
    ]
}
