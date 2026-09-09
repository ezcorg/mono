//! The **watch** capability — native filesystem change events streamed over wRPC.
//! `open(grant, path, recursive) -> result<stream<u8>, string>`: the `notify` crate
//! (FSEvents / inotify / …) watches a path under a consented filesystem grant's
//! jail, and each change is framed onto the returned byte stream. This is the
//! efficient native alternative to a client polling `stat` / `read-directory`
//! (`wasi:filesystem@0.2` has no change-notification interface).
//!
//! `open` is **consent-gated + scoped**: it needs a live *filesystem* grant, and the
//! watch is confined to that grant's jail — the target path is canonicalised and must
//! stay under the jail (no `..` / symlink escape). The host `notify::Watcher` is owned
//! by the returned stream, so when the client drops the stream the watcher stops.

use core::pin::Pin;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::Context as _;
use futures::stream::select_all;
use futures::{Stream, StreamExt as _};
use notify::{EventKind, RecursiveMode, Watcher};
use tokio::net::TcpListener;
use tokio_stream::wrappers::UnboundedReceiverStream;
use wit_bindgen_wrpc::bytes::Bytes;

use crate::broker::GrantStore;

pub(crate) mod bindings {
    wit_bindgen_wrpc::generate!({
        world: "watch-wrpc",
        path: "../wit",
    });
}

/// The generated wRPC **client** stub for the watch capability (`open`).
pub use bindings::icanhaz::nocap::watch as client;

/// Watch provider — starts a native filesystem watcher per consented `open`. Holds
/// the daemon's preopen `root` (the filesystem base) + the shared [`GrantStore`] to
/// gate on the grant and confine the watch to its jail.
#[derive(Clone)]
pub struct WatchProvider {
    root: PathBuf,
    grants: Arc<Mutex<GrantStore>>,
}

impl WatchProvider {
    pub fn new(root: PathBuf, grants: Arc<Mutex<GrantStore>>) -> Self {
        Self { root, grants }
    }
}

/// Map a `notify` event kind to our wire kind: `0` = rename (create/remove/move),
/// `1` = change (content/metadata); `None` skips (e.g. access-only events).
fn wire_kind(kind: EventKind) -> Option<u8> {
    use notify::event::ModifyKind;
    match kind {
        EventKind::Create(_) | EventKind::Remove(_) => Some(0),
        EventKind::Modify(ModifyKind::Name(_)) => Some(0),
        EventKind::Modify(_) => Some(1),
        _ => None,
    }
}

/// Frame one event: `[kind: u8] [path-len: u16 BE] [path: utf-8]`.
fn frame_event(kind: u8, rel: &str) -> Bytes {
    let path = rel.as_bytes();
    let len = path.len().min(u16::MAX as usize);
    let mut buf = Vec::with_capacity(3 + len);
    buf.push(kind);
    buf.extend_from_slice(&(len as u16).to_be_bytes());
    buf.extend_from_slice(&path[..len]);
    Bytes::from(buf)
}

impl<C: Send + Sync + 'static> bindings::exports::icanhaz::nocap::watch::Handler<C>
    for WatchProvider
{
    async fn open(
        &self,
        _cx: C,
        grant: String,
        path: String,
        recursive: bool,
    ) -> anyhow::Result<Result<Pin<Box<dyn Stream<Item = Bytes> + Send>>, String>> {
        // Consent gate: a live filesystem grant, whose jail we confine the watch to.
        let scope = match self.grants.lock().unwrap().validate_filesystem(&grant) {
            Ok(paths) => self.root.join(
                paths
                    .into_iter()
                    .next()
                    .unwrap_or_default()
                    .trim_matches('/'),
            ),
            Err(denied) => return Ok(Err(format!("watch denied: {denied:?}"))),
        };
        // Canonicalise the jail + target; the target must stay under the jail (a
        // canonicalised prefix check defeats `..` and symlink escapes).
        let scope = match scope.canonicalize() {
            Ok(s) => s,
            Err(e) => return Ok(Err(format!("watch: jail unavailable: {e}"))),
        };
        let target = match scope.join(path.trim_start_matches('/')).canonicalize() {
            Ok(t) if t.starts_with(&scope) => t,
            Ok(_) => return Ok(Err("watch: path escapes the grant".to_string())),
            Err(e) => return Ok(Err(format!("watch: path unavailable: {e}"))),
        };

        // notify → a tokio channel; the closure runs on notify's own thread. Paths are
        // reported relative to the jail (the client's grant-relative coordinate space).
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
        let strip = scope.clone();
        let mut watcher =
            match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res {
                    if let Some(kind) = wire_kind(event.kind) {
                        for p in event.paths {
                            let rel = p.strip_prefix(&strip).unwrap_or(&p).to_string_lossy();
                            if tx.send(frame_event(kind, &rel)).is_err() {
                                break;
                            }
                        }
                    }
                }
            }) {
                Ok(w) => w,
                Err(e) => return Ok(Err(format!("watch: {e}"))),
            };
        let mode = if recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        if let Err(e) = watcher.watch(&target, mode) {
            return Ok(Err(format!("watch: {e}")));
        }

        // Bound to the grant: on revoke/expiry the stream ends and the watcher (the
        // guard) is dropped, so watching stops. Also stops on client disconnect.
        let revocation = self.grants.lock().unwrap().revocation(&grant);
        let out = UnboundedReceiverStream::new(rx);
        Ok(Ok(crate::session::grant_scoped(
            Box::pin(out),
            revocation,
            watcher,
        )))
    }
}

/// Serve the watch capability over wRPC/TCP on `listener` until cancelled. (The
/// daemon serves it over WebSocket + WebTransport beside the other capabilities;
/// this is the minimal serve used by the roundtrip test.)
pub async fn serve_tcp(listener: TcpListener, provider: WatchProvider) -> anyhow::Result<()> {
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
        .context("failed to serve watch")?;
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

    #[tokio::test]
    async fn watch_streams_a_change_within_the_grant() {
        // A throwaway dir stands in for the jail; the grant scopes to it.
        let dir = std::env::temp_dir().join(format!("icanhaz-watch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.parent().unwrap().to_path_buf();
        let jail = dir.file_name().unwrap().to_string_lossy().into_owned();

        let store = GrantStore::shared();
        let grant = store.lock().unwrap().issue(
            CapabilityKind::Filesystem(FsRequest {
                roots: vec![PathGrant {
                    path: format!("/{jail}/"),
                    rights: FsRights::empty(),
                }],
            }),
            "filesystem".to_string(),
            Duration::from_secs(60),
            anonymous_principal(),
        );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(serve_tcp(listener, WatchProvider::new(root, store)));
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        let (result, io) = client::open(&wrpc, (), &grant, "", true)
            .await
            .expect("invoke watch.open");
        let mut output = result.expect("watch open");
        if let Some(io) = io {
            tokio::spawn(async move {
                let _ = io.await;
            });
        }

        // Give the watcher a moment to arm, then create a file under the jail.
        let dir2 = dir.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            let _ = std::fs::write(dir2.join("new.txt"), b"hi");
        });

        let frame = tokio::time::timeout(Duration::from_secs(15), output.next())
            .await
            .expect("watch timed out")
            .expect("stream ended without an event");

        assert!(frame.len() >= 3, "short frame: {frame:?}");
        let len = u16::from_be_bytes([frame[1], frame[2]]) as usize;
        let path = String::from_utf8_lossy(&frame[3..3 + len]);
        assert!(path.contains("new.txt"), "unexpected watched path: {path}");

        server.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn watch_refused_without_grant() {
        let store = GrantStore::shared();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(serve_tcp(
            listener,
            WatchProvider::new(PathBuf::from("/tmp"), store),
        ));
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        let (result, _io) = client::open(&wrpc, (), "bogus-token", "", true)
            .await
            .expect("invoke watch.open");
        match result {
            Err(msg) => assert!(msg.contains("denied"), "unexpected message: {msg}"),
            Ok(_) => panic!("an ungranted watch must be refused"),
        }

        server.abort();
    }
}
