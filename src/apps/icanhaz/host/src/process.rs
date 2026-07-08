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

use anyhow::Context as _;
use futures::stream::select_all;
use futures::{Stream, StreamExt as _};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;
use tokio::process::Command;
use tokio_stream::wrappers::UnboundedReceiverStream;
use wit_bindgen_wrpc::bytes::Bytes;

use crate::broker::GrantStore;

pub(crate) mod bindings {
    wit_bindgen_wrpc::generate!({
        world: "process-wrpc",
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
}

impl ProcessProvider {
    pub fn new(store: Arc<Mutex<GrantStore>>) -> Self {
        Self { store }
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

impl<C: Send + Sync + 'static> bindings::exports::icanhaz::nocap::process::Handler<C>
    for ProcessProvider
{
    async fn spawn(
        &self,
        _cx: C,
        grant: String,
        args: Vec<String>,
        stdin: Pin<Box<dyn Stream<Item = Bytes> + Send>>,
    ) -> anyhow::Result<Result<Pin<Box<dyn Stream<Item = Bytes> + Send>>, String>> {
        // Consent gate: a live `process` grant is required; it pins which program
        // runs. Unknown / expired / wrong-kind ⇒ refused before any spawn.
        let req = match self.store.lock().unwrap().validate_process(&grant) {
            Ok(req) => req,
            Err(denied) => return Ok(Err(format!("process denied: {denied:?}"))),
        };

        // The grant pins the image and — unless it negotiated `guest-chooses-argv` —
        // its argv. When the guest may choose, the caller's `args` run; otherwise the
        // grant's pinned `args` do, and a caller passing anything other than those
        // (empty, or exactly the pinned set) is refused. So a grant for
        // `rust-analyzer --stdio` can't be turned into `rust-analyzer --rm-rf`.
        let effective_args = if req.guest_chooses_argv {
            args
        } else if args.is_empty() || args == req.args {
            req.args.clone()
        } else {
            return Ok(Err(
                "process denied: this grant pins its arguments; the requested argv isn't permitted".to_string(),
            ));
        };

        let mut child = match Command::new(&req.image)
            .args(&effective_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(e) => return Ok(Err(format!("failed to spawn `{}`: {e}", req.image))),
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
        let revocation = self.store.lock().unwrap().revocation(&grant);
        let out = UnboundedReceiverStream::new(output);
        Ok(Ok(crate::session::grant_scoped(
            Box::pin(out),
            revocation,
            ProcGuard { handles: vec![stdin_h, stderr_h, stdout_h] },
        )))
    }
}

/// Serve the process capability over wRPC/TCP on `listener` until cancelled. (The
/// daemon serves it over WebSocket + WebTransport beside the other capabilities;
/// this is the minimal serve used by the roundtrip test.)
pub async fn serve_tcp(listener: TcpListener, provider: ProcessProvider) -> anyhow::Result<()> {
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
        .context("failed to serve process")?;
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
    use crate::broker::{anonymous_principal, CapabilityKind, ProcessRequest};
    use core::time::Duration;
    use futures::stream;

    /// Mint a `process` grant pinning `image` (optionally allowing caller argv).
    fn process_grant(store: &Arc<Mutex<GrantStore>>, image: &str, guest_chooses_argv: bool) -> String {
        store.lock().unwrap().issue(
            CapabilityKind::Process(ProcessRequest { image: image.to_string(), args: vec![], guest_chooses_argv }),
            format!("process: {image}"),
            Duration::from_secs(60),
            anonymous_principal(),
        )
    }

    /// Drive the wRPC I/O future + drain the output stream concurrently, with a
    /// timeout so a misbehaving child fails fast instead of hanging. (A macro, not a
    /// fn, so it stays agnostic to the generated `io` future's concrete type.)
    macro_rules! collect_output {
        ($io:expr, $output:expr) => {{
            let mut output = $output;
            let collected: Vec<u8> = tokio::time::timeout(Duration::from_secs(15), async {
                let (_, buf) = tokio::try_join!(
                    async move {
                        if let Some(io) = $io {
                            io.await.context("async I/O failed")?;
                        }
                        Ok::<(), anyhow::Error>(())
                    },
                    async move {
                        let mut buf = Vec::new();
                        while let Some(chunk) = output.next().await {
                            buf.extend_from_slice(&chunk);
                        }
                        Ok::<Vec<u8>, anyhow::Error>(buf)
                    },
                )?;
                Ok::<Vec<u8>, anyhow::Error>(buf)
            })
            .await
            .expect("process test timed out")
            .expect("process I/O failed");
            String::from_utf8_lossy(&collected).into_owned()
        }};
    }

    #[tokio::test]
    async fn process_echo_roundtrip() {
        // `cat` echoes stdin → stdout, exiting when stdin closes — the simplest
        // proof that the wRPC stdin stream reaches the child and its stdout streams
        // back. (This is the shape every stdio LSP server uses.)
        let store = GrantStore::shared();
        let grant = process_grant(&store, "cat", false);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(serve_tcp(listener, ProcessProvider::new(store)));
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        // One stdin chunk; closing the stream sends EOF so `cat` exits.
        let stdin: Pin<Box<dyn Stream<Item = Bytes> + Send>> =
            Box::pin(stream::iter([Bytes::from_static(b"hello over wrpc\n")]));
        let (result, io) = client::spawn(&wrpc, (), &grant, &[], stdin)
            .await
            .expect("invoke process.spawn");
        let output = result.expect("spawn cat");

        let text = collect_output!(io, output);
        assert!(text.contains("hello over wrpc"), "process output missing echo:\n{text}");

        server.abort();
    }

    #[tokio::test]
    async fn revoking_a_grant_tears_down_the_running_process() {
        // `cat` with a never-closing stdin runs forever — until the grant is revoked,
        // which must end the output stream and kill the child (the generic session
        // teardown, shared by terminal + watch).
        let store = GrantStore::shared();
        let grant = process_grant(&store, "cat", false);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(serve_tcp(listener, ProcessProvider::new(store.clone())));
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        // stdin never ends ⇒ `cat` never sees EOF ⇒ it only stops when killed.
        let stdin: Pin<Box<dyn Stream<Item = Bytes> + Send>> = Box::pin(stream::pending());
        let (result, io) = client::spawn(&wrpc, (), &grant, &[], stdin).await.expect("invoke process.spawn");
        let mut output = result.expect("spawn cat");

        // Drive the client I/O so the stream can advance + close.
        let io_task = tokio::spawn(async move {
            if let Some(io) = io {
                let _ = io.await;
            }
        });

        // Revoke — the running `cat` must be torn down and its output stream ended.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(store.lock().unwrap().revoke(&grant), "grant should have been live");

        let drained = tokio::time::timeout(Duration::from_secs(5), async {
            while output.next().await.is_some() {}
        })
        .await;
        assert!(drained.is_ok(), "revoke must end the process's output stream (session torn down)");

        io_task.abort();
        server.abort();
    }

    #[tokio::test]
    async fn process_honours_permitted_argv() {
        // A grant that negotiated `guest-chooses-argv` lets the caller pass argv:
        // `echo hello-args` writes it to stdout (ignoring stdin) and exits.
        let store = GrantStore::shared();
        let grant = process_grant(&store, "echo", true);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(serve_tcp(listener, ProcessProvider::new(store)));
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        let stdin: Pin<Box<dyn Stream<Item = Bytes> + Send>> = Box::pin(stream::iter(Vec::<Bytes>::new()));
        let args = ["hello-args"];
        let (result, io) = client::spawn(&wrpc, (), &grant, &args, stdin)
            .await
            .expect("invoke process.spawn");
        let output = result.expect("spawn echo");

        let text = collect_output!(io, output);
        assert!(text.contains("hello-args"), "echo output missing argv:\n{text}");

        server.abort();
    }

    #[tokio::test]
    async fn process_refuses_unpermitted_argv() {
        // The same `echo`, but the grant did NOT negotiate caller argv: passing args
        // is refused before any spawn (the consented program runs as the host fixed
        // it, not as the caller re-specifies).
        let store = GrantStore::shared();
        let grant = process_grant(&store, "echo", false);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(serve_tcp(listener, ProcessProvider::new(store)));
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        let stdin: Pin<Box<dyn Stream<Item = Bytes> + Send>> = Box::pin(stream::iter(Vec::<Bytes>::new()));
        let args = ["should-be-rejected"];
        let (result, _io) = client::spawn(&wrpc, (), &grant, &args, stdin)
            .await
            .expect("invoke process.spawn");
        match result {
            Err(msg) => assert!(msg.contains("arguments"), "unexpected refusal message: {msg}"),
            Ok(_) => panic!("argv on a grant that didn't permit it must be refused"),
        }

        server.abort();
    }

    #[tokio::test]
    async fn process_refused_without_grant() {
        // Empty store — no grant was ever issued. The gate must refuse before spawn.
        let store = GrantStore::shared();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(serve_tcp(listener, ProcessProvider::new(store)));
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        let stdin: Pin<Box<dyn Stream<Item = Bytes> + Send>> = Box::pin(stream::iter(Vec::<Bytes>::new()));
        let (result, _io) = client::spawn(&wrpc, (), "bogus-token", &[], stdin)
            .await
            .expect("invoke process.spawn");
        match result {
            Err(msg) => assert!(msg.contains("denied"), "unexpected refusal message: {msg}"),
            Ok(_) => panic!("an ungranted spawn must be refused"),
        }

        server.abort();
    }
}
