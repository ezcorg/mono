//! The **workspace** capability — host metadata for a consented filesystem grant.
//! `root-path(grant) -> result<string, string>` returns the host absolute path the
//! grant is jailed to, so a browser client can form real `file://` URIs for a
//! native language server (rust-analyzer speaks host paths, not the client's
//! grant-relative VFS paths). Gated: the path is disclosed only for a live
//! filesystem grant the caller holds.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::broker::GrantStore;

pub(crate) mod bindings {
    wit_bindgen_wrpc::generate!({
        world: "workspace-client",
        path: "../wit",
    });
}

/// The generated wRPC **client** stub for the workspace capability (`root-path`).
pub use bindings::icanhaz::nocap::workspace as client;

/// Workspace provider — resolves a filesystem grant's jail to a host absolute path.
/// Holds the daemon's preopen `root` (the filesystem capability's base) + the shared
/// [`GrantStore`] so it can gate on the grant and join its scope under the root.
#[derive(Clone)]
pub struct WorkspaceProvider {
    root: PathBuf,
    grants: Arc<Mutex<GrantStore>>,
}

impl WorkspaceProvider {
    pub fn new(root: PathBuf, grants: Arc<Mutex<GrantStore>>) -> Self {
        Self { root, grants }
    }

    /// The raw root path (`icanhaz:nocap/jail`): for any live filesystem
    /// grant, or a component grant one was lent to.
    pub fn native_for_grants(&self) -> crate::raw::NativeRoot {
        let root = self.root.clone();
        let grants = self.grants.clone();
        Arc::new(move |token| {
            let mut g = grants.lock().unwrap();
            let token = g
                .delegated_for(&token, "filesystem")
                .ok_or_else(|| "workspace denied: no filesystem grant for this call".to_string())?;
            let paths = g
                .validate_filesystem(&token)
                .map_err(|d| format!("workspace denied: {d:?}"))?;
            g.admit(&token, crate::broker::AdmitCall::new("root-path"))
                .map_err(|d| format!("workspace denied: {}", crate::broker::denied_text(&d)))?;
            let scope = paths.into_iter().next().unwrap_or_default();
            Ok(root
                .join(scope.trim_matches('/'))
                .to_string_lossy()
                .into_owned())
        })
    }
}
