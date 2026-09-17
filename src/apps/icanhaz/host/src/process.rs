//! The **process** capability — spawn a host program the requestor *names* (its
//! `image` pinned by the grant) over wRPC, with piped stdio and no PTY. `spawn(
//! grant, args, stdin) -> result<stream<u8>, string>`: `stdin` carries bytes to
//! the child (client→host), the returned stream carries the child's stdout
//! (host→client). Built for language servers + build tools — spawn `rust-analyzer`
//! / `typescript-language-server --stdio` and pipe LSP JSON-RPC across it.
//!
//! `spawn` is **consent-gated**: it requires a live `process` grant from the
//! broker ([`crate::broker`]). The grant *pins the image* — the caller never names
//! the binary here, so a grant for one program can't be turned into another — and
//! caller-chosen argv is honoured only when the grant negotiated it.
//!
//! Unlike [`crate::terminal`] (a blocking PTY bridged via threads), pipes are
//! async-native: `tokio::process` gives `AsyncRead`/`AsyncWrite` stdio, so the
//! forwarding is plain tasks. stderr is logged host-side — merging it into stdout
//! would corrupt the caller's byte protocol (LSP's `Content-Length` framing).

use core::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use futures::{Stream, StreamExt as _};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::process::Command;
use tokio_stream::wrappers::UnboundedReceiverStream;
use wit_bindgen_wrpc::bytes::Bytes;

use crate::broker::{denied_text, AdmitCall, GrantStore};

pub(crate) mod bindings {
    wit_bindgen_wrpc::generate!({
        world: "process-client",
        path: "../wit",
    });
}

/// The generated wRPC **client** stub for the process capability (`spawn`).
pub use bindings::icanhaz::nocap::process as client;

/// Process provider — spawns a fresh child per consented `spawn`. Holds the shared
/// [`GrantStore`] so it can enforce the consent gate (and read the pinned image)
/// before spawning.
#[derive(Clone)]
pub struct ProcessProvider {
    store: Arc<Mutex<GrantStore>>,
    /// Other brokers, for grants that proxy a remote one.
    remotes: Option<crate::remote::Remotes>,
}

impl ProcessProvider {
    pub fn new(store: Arc<Mutex<GrantStore>>) -> Self {
        Self {
            store,
            remotes: None,
        }
    }

    pub fn with_remotes(mut self, remotes: crate::remote::Remotes) -> Self {
        self.remotes = Some(remotes);
        self
    }

    /// The raw spawn (`icanhaz:nocap/process-raw`): for any live `process`
    /// grant, or a component grant one was lent to. The token is resolved,
    /// the grant's pins applied, the argv that will run admitted, and a grant
    /// held at another broker forwarded there.
    pub fn native_for_grants(&self) -> crate::raw::NativeSpawn {
        let me = self.clone();
        Arc::new(move |token, args, stdin| {
            let me = me.clone();
            Box::pin(async move {
                let (token, req) = {
                    let g = me.store.lock().unwrap();
                    let token = g.delegated_for(&token, "process").ok_or_else(|| {
                        "process denied: no process grant for this call".to_string()
                    })?;
                    let req = g
                        .validate_process(&token)
                        .map_err(|d| format!("process denied: {d:?}"))?;
                    (token, req)
                };
                // The grant pins the image and, unless it negotiated
                // `guest-chooses-argv`, its argv: the caller's `args` run only
                // then; otherwise the pinned ones do, and anything else is
                // refused. A grant for `rust-analyzer --stdio` cannot become
                // `rust-analyzer --rm-rf`.
                let effective = if req.guest_chooses_argv {
                    args
                } else if args.is_empty() || args == req.args {
                    req.args.clone()
                } else {
                    return Err(
                        "process denied: this grant pins its arguments; the requested argv isn't permitted"
                            .to_string(),
                    );
                };
                let admit = AdmitCall::new("spawn").arg("args", effective.clone());
                me.store
                    .lock()
                    .unwrap()
                    .admit(&token, admit)
                    .map_err(|d| format!("process denied: {}", denied_text(&d)))?;
                let remote = me.store.lock().unwrap().remote_of(&token);
                if let Some(remote) = remote {
                    return me.spawn_remote(&token, remote, effective, stdin).await;
                }
                spawn_native(&req, &effective, stdin, &me.store, &token)
            })
        })
    }

    /// Spawn at the broker that holds the real grant: stdin is forwarded
    /// there, its stdout comes back, and the session ends with this grant.
    async fn spawn_remote(
        &self,
        grant: &str,
        remote: crate::broker::Remote,
        args: Vec<String>,
        stdin: Pin<Box<dyn Stream<Item = Bytes> + Send>>,
    ) -> Result<Pin<Box<dyn Stream<Item = Bytes> + Send>>, String> {
        let Some(remotes) = &self.remotes else {
            return Err("process: no peer transport for a remote grant".to_string());
        };
        let client = remotes
            .client(&remote.locator)
            .await
            .map_err(|e| format!("process: {}: {e:#}", remote.locator))?;
        let process = client::open(&client, (), &remote.token)
            .await
            .map_err(|e| format!("process: {}: {e:#}", remote.locator))??;
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let (res, io) = client::Process::spawn(&client, (), &process.as_borrow(), &argv, stdin)
            .await
            .map_err(|e| format!("process: {}: {e:#}", remote.locator))?;
        // The object served one spawn; the session lives on its own streams.
        crate::remote::release(&client, AsRef::<Bytes>::as_ref(&process).clone()).await;
        if let Some(io) = io {
            tokio::spawn(async move {
                if let Err(err) = io.await {
                    tracing::debug!(?err, "remote process io driver ended");
                }
            });
        }
        let output = res?;
        let revocation = self.store.lock().unwrap().revocation(grant);
        Ok(crate::session::grant_scoped(output, revocation, ()))
    }
}

/// Teardown for a process session: aborts its pump tasks on drop. The stdout task
/// owns the `Child`, so aborting it drops the child — `kill_on_drop` then kills the
/// process. Dropped when the output stream is (revoke, expiry, disconnect, exit).
struct ProcGuard {
    handles: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for ProcGuard {
    fn drop(&mut self) {
        for h in &self.handles {
            h.abort();
        }
    }
}

/// Spawn the grant's pinned image with `args`, feeding it `stdin` and
/// returning its stdout as a stream bound to the grant's life.
fn spawn_native(
    req: &crate::broker::ProcessRequest,
    effective_args: &[String],
    stdin: Pin<Box<dyn Stream<Item = Bytes> + Send>>,
    store: &Arc<Mutex<GrantStore>>,
    grant: &str,
) -> Result<Pin<Box<dyn Stream<Item = Bytes> + Send>>, String> {
    let mut child = match Command::new(&req.image)
        .args(effective_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(e) => return Err(format!("failed to spawn `{}`: {e}", req.image)),
    };

    let mut child_stdin = child.stdin.take().expect("piped stdin");
    let mut child_stdout = child.stdout.take().expect("piped stdout");
    let mut child_stderr = child.stderr.take().expect("piped stderr");
    // Telemetry: makes a "spawned but silent / crashed" child visible in the log
    // (`RUST_LOG=icanhaz_host=info`). Pairs with the browser's setLspTrace to place
    // the break — no `first stdout` here + no `recv` in the browser ⇒ the child never
    // produced output (crashed / wrong PATH); `exited` right after ⇒ startup failure.
    tracing::info!(image = %req.image, pid = ?child.id(), args = ?effective_args, "process spawned");

    // Forward the wRPC stdin stream → the child until the client closes it;
    // dropping `child_stdin` then sends EOF (the LSP `exit` convention).
    let stdin_h = tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(chunk) = stdin.next().await {
            if child_stdin.write_all(&chunk).await.is_err() {
                break;
            }
            let _ = child_stdin.flush().await;
        }
    });

    // The child's stderr is logged, never streamed: folding it into stdout would
    // corrupt a length-framed protocol on the wire (LSP, DAP, …).
    let image = req.image.clone();
    let stderr_h = tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        loop {
            match child_stderr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    tracing::debug!(image = %image, "process stderr: {}", String::from_utf8_lossy(&buf[..n]))
                }
            }
        }
    });

    // The child's stdout becomes the returned wRPC stream; it ends when the
    // child closes stdout (it has exited or is exiting). Drain to EOF *then*
    // reap, so a full pipe buffer can never deadlock `wait()`.
    let (out_tx, output) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
    let image_out = req.image.clone();
    let stdout_h = tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        let mut total = 0usize;
        loop {
            match child_stdout.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if total == 0 {
                        tracing::info!(image = %image_out, bytes = n, "process: first stdout");
                    }
                    total += n;
                    if out_tx.send(Bytes::copy_from_slice(&buf[..n])).is_err() {
                        break;
                    }
                }
            }
        }
        let status = child.wait().await;
        tracing::info!(image = %image_out, total_stdout = total, ?status, "process exited");
    });

    // Bind the session to the grant: on revoke/expiry the output stream ends and
    // the guard aborts the pump tasks — dropping `child`, which `kill_on_drop`
    // then kills. Also releases on client disconnect / natural exit.
    let revocation = store.lock().unwrap().revocation(grant);
    let out = UnboundedReceiverStream::new(output);
    Ok(crate::session::grant_scoped(
        Box::pin(out),
        revocation,
        ProcGuard {
            handles: vec![stdin_h, stderr_h, stdout_h],
        },
    ))
}
