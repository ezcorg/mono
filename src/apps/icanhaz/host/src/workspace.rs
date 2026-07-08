//! The **workspace** capability — host metadata for a consented filesystem grant.
//! `root-path(grant) -> result<string, string>` returns the host absolute path the
//! grant is jailed to, so a browser client can form real `file://` URIs for a
//! native language server (rust-analyzer speaks host paths, not the client's
//! grant-relative VFS paths). Gated: the path is disclosed only for a live
//! filesystem grant the caller holds.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::Context as _;
use futures::stream::select_all;
use futures::StreamExt as _;
use tokio::net::TcpListener;

use crate::broker::GrantStore;

pub(crate) mod bindings {
    wit_bindgen_wrpc::generate!({
        world: "workspace-wrpc",
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
}

impl<C: Send + Sync + 'static> bindings::exports::icanhaz::nocap::workspace::Handler<C>
    for WorkspaceProvider
{
    async fn root_path(&self, _cx: C, grant: String) -> anyhow::Result<Result<String, String>> {
        // Consent gate: only a live filesystem grant discloses its jail path.
        let paths = match self.grants.lock().unwrap().validate_filesystem(&grant) {
            Ok(paths) => paths,
            Err(denied) => return Ok(Err(format!("workspace denied: {denied:?}"))),
        };
        // The grant's first root (e.g. "/jail/") joined under the preopen — the same
        // host directory `mount.open-root` scopes the descriptor to.
        let scope = paths.into_iter().next().unwrap_or_default();
        let abs = self.root.join(scope.trim_matches('/'));
        Ok(Ok(abs.to_string_lossy().into_owned()))
    }
}

/// Serve the workspace capability over wRPC/TCP on `listener` until cancelled. (The
/// daemon serves it over WebSocket + WebTransport beside the other capabilities;
/// this is the minimal serve used by the roundtrip test.)
pub async fn serve_tcp(listener: TcpListener, provider: WorkspaceProvider) -> anyhow::Result<()> {
    let srv = Arc::new(wrpc_transport::Server::default());
    let accept = tokio::spawn({
        let srv = Arc::clone(&srv);
        async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _addr)) => {
                        let (rx, tx) = stream.into_split();
                        if let Err(err) = srv.accept((), tx, rx).await {
                            tracing::error!(?err, "failed to serve TCP connection");
                        }
                    }
                    Err(err) => tracing::error!(?err, "failed to accept TCP connection"),
                }
            }
        }
    });

    let invocations = bindings::serve(srv.as_ref(), provider)
        .await
        .context("failed to serve workspace")?;
    let mut invocations = select_all(
        invocations
            .into_iter()
            .map(|(instance, name, invocations)| invocations.map(move |res| (instance, name, res))),
    );
    while let Some((instance, name, res)) = invocations.next().await {
        match res {
            Ok(fut) => {
                tokio::spawn(async move {
                    if let Err(err) = fut.await {
                        tracing::warn!(?err, instance, name, "invocation failed");
                    }
                });
            }
            Err(err) => tracing::warn!(?err, instance, name, "failed to accept invocation"),
        }
    }
    accept.abort();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::{anonymous_principal, CapabilityKind, FsRequest, FsRights, PathGrant};
    use core::time::Duration;

    fn filesystem_grant(store: &Arc<Mutex<GrantStore>>, path: &str) -> String {
        store.lock().unwrap().issue(
            CapabilityKind::Filesystem(FsRequest {
                roots: vec![PathGrant { path: path.to_string(), rights: FsRights::empty() }],
            }),
            format!("filesystem: {path}"),
            Duration::from_secs(60),
            anonymous_principal(),
        )
    }

    #[tokio::test]
    async fn root_path_joins_the_grant_scope_under_the_preopen() {
        let store = GrantStore::shared();
        let grant = filesystem_grant(&store, "/jail/");

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let provider = WorkspaceProvider::new(PathBuf::from("/demo/root"), store);
        let server = tokio::spawn(serve_tcp(listener, provider));
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        let result = client::root_path(&wrpc, (), &grant).await.expect("invoke root-path");
        assert_eq!(result.expect("path"), "/demo/root/jail");

        server.abort();
    }

    #[tokio::test]
    async fn root_path_refused_without_grant() {
        let store = GrantStore::shared();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let provider = WorkspaceProvider::new(PathBuf::from("/demo/root"), store);
        let server = tokio::spawn(serve_tcp(listener, provider));
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        let result = client::root_path(&wrpc, (), "bogus-token").await.expect("invoke root-path");
        match result {
            Err(msg) => assert!(msg.contains("denied"), "unexpected message: {msg}"),
            Ok(_) => panic!("an ungranted root-path must be refused"),
        }

        server.abort();
    }
}
