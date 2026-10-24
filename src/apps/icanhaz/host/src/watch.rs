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

use futures::Stream;
use notify::{EventKind, RecursiveMode, Watcher};
use tokio_stream::wrappers::UnboundedReceiverStream;
use wit_bindgen_wrpc::bytes::Bytes;

use crate::broker::GrantStore;

pub(crate) mod bindings {
    wit_bindgen_wrpc::generate!({
        world: "watch-client",
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

    /// The raw watch (`icanhaz:nocap/notify`): for any live filesystem grant,
    /// or a component grant one was lent to.
    pub fn native_for_grants(&self) -> crate::raw::NativeWatch {
        let root = self.root.clone();
        let grants = self.grants.clone();
        Arc::new(move |token, path, recursive| {
            let root = root.clone();
            let grants = grants.clone();
            Box::pin(async move {
                let token = grants
                    .lock()
                    .unwrap()
                    .delegated_for(&token, "filesystem")
                    .ok_or_else(|| "watch denied: no filesystem grant for this call".to_string())?;
                open_native(&root, &grants, &token, &path, recursive)
            })
        })
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

/// Watch `path` under the grant's jail for a live filesystem grant and return
/// its events bound to the grant's life. Re-checks the grant and re-admits the
/// path so a wrapper's rewrite still meets the grant's clauses.
fn open_native(
    root: &std::path::Path,
    grants: &Arc<Mutex<GrantStore>>,
    grant: &str,
    path: &str,
    recursive: bool,
) -> Result<Pin<Box<dyn Stream<Item = Bytes> + Send>>, String> {
    let scope = {
        let mut g = grants.lock().unwrap();
        let scope = match g.validate_filesystem(grant) {
            Ok(paths) => root.join(
                paths
                    .into_iter()
                    .next()
                    .unwrap_or_default()
                    .trim_matches('/'),
            ),
            Err(denied) => return Err(format!("watch denied: {denied:?}")),
        };
        let admit = crate::broker::AdmitCall::new("open")
            .arg("path", path.to_string())
            .arg("recursive", recursive);
        if let Err(denied) = g.admit(grant, admit) {
            return Err(format!(
                "watch denied: {}",
                crate::broker::denied_text(&denied)
            ));
        }
        scope
    };
    // Canonicalise the jail + target; the target must stay under the jail (a
    // canonicalised prefix check defeats `..` and symlink escapes).
    let scope = match scope.canonicalize() {
        Ok(s) => s,
        Err(e) => return Err(format!("watch: jail unavailable: {e}")),
    };
    let target = match scope.join(path.trim_start_matches('/')).canonicalize() {
        Ok(t) if t.starts_with(&scope) => t,
        Ok(_) => return Err("watch: path escapes the grant".to_string()),
        Err(e) => return Err(format!("watch: path unavailable: {e}")),
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
            Err(e) => return Err(format!("watch: {e}")),
        };
    let mode = if recursive {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };
    if let Err(e) = watcher.watch(&target, mode) {
        return Err(format!("watch: {e}"));
    }

    // Bound to the grant: on revoke/expiry the stream ends and the watcher (the
    // guard) is dropped, so watching stops. Also stops on client disconnect.
    let revocation = grants.lock().unwrap().revocation(grant);
    let out = UnboundedReceiverStream::new(rx);
    Ok(crate::session::grant_scoped(
        Box::pin(out),
        revocation,
        watcher,
    ))
}
