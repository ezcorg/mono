//! The **workspace** capability — host metadata for a consented filesystem grant.
//! `root-path(grant) -> result<string, string>` returns the host absolute path the
//! grant is jailed to, so a browser client can form real `file://` URIs for a
//! native language server (rust-analyzer speaks host paths, not the client's
//! grant-relative VFS paths). Gated: the path is disclosed only for a live
//! filesystem grant the caller holds.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use wasmtime_wasi::FsPerms;

use crate::broker::{FsRights, GrantStore};

pub(crate) mod bindings {
    wit_bindgen_wrpc::generate!({
        world: "workspace-client",
        path: "../wit",
    });
}

/// The generated wRPC **client** stub for the workspace capability (`root-path`).
pub use bindings::icanhaz::nocap::workspace as client;

/// Workspace provider — resolves a filesystem grant to its root under the
/// daemon's jail. Holds the jail `root` and the shared [`GrantStore`], so it
/// can gate on the grant and join its scope under the root: as a host path
/// (`jail.root`, what a language server is told) and as the directory the
/// filesystem capability opens (`jail.open`).
#[derive(Clone)]
pub struct WorkspaceProvider {
    root: PathBuf,
    grants: Arc<Mutex<GrantStore>>,
}

impl WorkspaceProvider {
    pub fn new(root: PathBuf, grants: Arc<Mutex<GrantStore>>) -> Self {
        Self { root, grants }
    }

    /// The granted root under the jail, and the rights it was granted with:
    /// for any live filesystem grant, or a component grant one was lent to.
    /// `method` names the operation admitted against the grant's scope.
    fn granted_root(&self, token: &str, method: &str) -> Result<(PathBuf, FsPerms), String> {
        let mut g = self.grants.lock().unwrap();
        let token = g
            .delegated_for(token, "filesystem")
            .ok_or_else(|| "filesystem denied: no filesystem grant for this call".to_string())?;
        let paths = g
            .validate_filesystem(&token)
            .map_err(|d| format!("filesystem denied: {d:?}"))?;
        g.admit(&token, crate::broker::AdmitCall::new(method))
            .map_err(|d| format!("filesystem denied: {}", crate::broker::denied_text(&d)))?;
        let rights = match g.kind_of(&token) {
            Some(crate::broker::CapabilityKind::Filesystem(req)) => req
                .roots
                .iter()
                .fold(FsRights::empty(), |acc, r| acc | r.rights),
            _ => FsRights::empty(),
        };
        let perms = if rights.intersects(FsRights::WRITE | FsRights::CREATE | FsRights::DELETE) {
            FsPerms::ReadWrite
        } else {
            FsPerms::ReadOnly
        };
        let scope = paths.into_iter().next().unwrap_or_default();
        Ok((self.root.join(scope.trim_matches('/')), perms))
    }

    /// The raw root path (`icanhaz:nocap/jail.root`).
    pub fn native_for_grants(&self) -> crate::raw::NativeRoot {
        let me = self.clone();
        Arc::new(move |token| {
            me.granted_root(&token, "root-path")
                .map(|(path, _)| path.to_string_lossy().into_owned())
        })
    }

    /// The raw root directory (`icanhaz:nocap/jail.open`): what the
    /// filesystem capability opens for a grant.
    pub fn native_open_root(&self) -> crate::raw::NativeOpenRoot {
        let me = self.clone();
        Arc::new(move |token| me.granted_root(&token, "open"))
    }
}
