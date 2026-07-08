//! The **terminal** capability — a native interactive PTY exposed over wRPC
//! streams. `open(grant, stdin, cols, rows) -> result<stream<u8>, string>`:
//! `stdin` carries keystrokes (client→host), the returned stream carries merged
//! stdout+stderr (host→client). Spawning a process is host-native, so this is
//! served directly — not mediated by a wasm policy component.
//!
//! `open` is **consent-gated**: it requires a live `terminal` grant from the
//! broker ([`crate::broker`]) and refuses unknown / expired / wrong-kind tokens
//! before spawning anything.
//!
//! `portable-pty` is blocking, so the PTY's reads/writes run on dedicated
//! threads bridged to async via channels (mirroring the v0 daemon's `pty.rs`).

use core::pin::Pin;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use anyhow::Context as _;
use futures::stream::select_all;
use futures::{Stream, StreamExt as _};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::net::TcpListener;
use tokio_stream::wrappers::UnboundedReceiverStream;
use wit_bindgen_wrpc::bytes::Bytes;

use crate::broker::{CapabilityKind, GrantStore};

pub(crate) mod bindings {
    wit_bindgen_wrpc::generate!({
        world: "terminal-wrpc",
        path: "../wit",
    });
}

/// The generated wRPC **client** stub for the terminal (`open`).
pub use bindings::icanhaz::nocap::terminal as client;

/// Terminal provider — spawns a fresh PTY per consented `open`. Holds the shared
/// [`GrantStore`] so it can enforce the consent gate before spawning.
#[derive(Clone)]
pub struct TerminalProvider {
    store: Arc<Mutex<GrantStore>>,
}

impl TerminalProvider {
    pub fn new(store: Arc<Mutex<GrantStore>>) -> Self {
        Self { store }
    }
}

/// The user's configured login shell. `$SHELL` reflects it on a normal login; a
/// hardened daemon would fall back to the passwd entry (getpwuid) before
/// `/bin/sh`. It is the *host's* choice — never the requestor's.
fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
}

/// The async-friendly halves of a spawned PTY: a stdin sender (→ shell), a
/// stdout/stderr receiver (← shell), and a resize sender (→ the tty).
struct PtyIo {
    stdin: std::sync::mpsc::Sender<Vec<u8>>,
    output: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    resize: std::sync::mpsc::Sender<(u16, u16)>,
    /// Kills the shell independently of the reaper thread's blocking `wait()` — used
    /// to tear the session down when the grant is revoked or expires.
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}

fn spawn_pty(shell: &str, cols: u16, rows: u16) -> anyhow::Result<PtyIo> {
    let pair = native_pty_system().openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut cmd = CommandBuilder::new(shell);
    if let Some(home) = std::env::var_os("HOME") {
        cmd.cwd(home);
    }
    cmd.env("TERM", "xterm-256color");

    let mut child = pair.slave.spawn_command(cmd)?;
    // A kill handle that works while the reaper thread is blocked in `wait()`.
    let killer = child.clone_killer();
    drop(pair.slave); // let EOF propagate when the child exits

    // Share the master so the resize thread can reshape the tty while the reaper
    // keeps it alive for the session (its methods take `&self`).
    let master = Arc::new(Mutex::new(pair.master));
    let mut reader = master.lock().unwrap().try_clone_reader()?;
    let mut writer = master.lock().unwrap().take_writer()?;

    // PTY output → tokio channel (blocking reads on a dedicated thread).
    let (out_tx, output) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    // stdin channel → PTY writer (blocking writes on a dedicated thread).
    let (stdin, stdin_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(bytes) = stdin_rx.recv() {
            if writer.write_all(&bytes).is_err() {
                break;
            }
            let _ = writer.flush();
        }
    });

    // Resize channel → the tty (the kernel then sends the shell SIGWINCH).
    let (resize, resize_rx) = std::sync::mpsc::channel::<(u16, u16)>();
    {
        let master = Arc::clone(&master);
        std::thread::spawn(move || {
            while let Ok((cols, rows)) = resize_rx.recv() {
                let _ = master.lock().unwrap().resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
        });
    }

    // Reap the child; keep `master` alive for the session.
    std::thread::spawn(move || {
        let _ = child.wait();
        drop(master);
    });

    Ok(PtyIo { stdin, output, resize, killer })
}

/// Teardown for a terminal session: kills the shell (via the independent killer) and
/// aborts the stdin/control pumps on drop. Dropped when the output stream is (revoke,
/// expiry, client disconnect, or the shell exiting on its own).
struct PtyGuard {
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    handles: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for PtyGuard {
    fn drop(&mut self) {
        let _ = self.killer.kill();
        for h in &self.handles {
            h.abort();
        }
    }
}

impl<C: Send + Sync + 'static> bindings::exports::icanhaz::nocap::terminal::Handler<C>
    for TerminalProvider
{
    async fn open(
        &self,
        _cx: C,
        grant: String,
        stdin: Pin<Box<dyn Stream<Item = Bytes> + Send>>,
        control: Pin<Box<dyn Stream<Item = Bytes> + Send>>,
        cols: u16,
        rows: u16,
    ) -> anyhow::Result<Result<Pin<Box<dyn Stream<Item = Bytes> + Send>>, String>> {
        // Consent gate: a live `terminal` grant is required — the broker issues
        // one only after the human approves. Unknown / expired / wrong-kind ⇒
        // refused here, before any process is spawned.
        if let Err(denied) = self
            .store
            .lock()
            .unwrap()
            .validate(&grant, |k| matches!(k, CapabilityKind::Terminal(_)))
        {
            return Ok(Err(format!("terminal denied: {denied:?}")));
        }

        // The shell is the host's, not the requestor's: a terminal grant means
        // "a shell as *you* are configured", never "run a program the caller
        // names" (that is a broader, separately-consented capability).
        let shell = default_shell();
        let pty = match spawn_pty(&shell, cols.max(1), rows.max(1)) {
            Ok(p) => p,
            Err(e) => return Ok(Err(format!("failed to spawn `{shell}`: {e}"))),
        };
        let PtyIo { stdin: pty_stdin, output, resize, killer } = pty;

        // Forward the wRPC stdin stream → the PTY until the client closes it.
        let stdin_h = tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(chunk) = stdin.next().await {
                if pty_stdin.send(chunk.to_vec()).is_err() {
                    break;
                }
            }
        });

        // Control sub-channel: each 4-byte frame `[cols u16 BE][rows u16 BE]`
        // reshapes the tty (the kernel then SIGWINCHes the shell).
        let control_h = tokio::spawn(async move {
            let mut control = control;
            let mut buf: Vec<u8> = Vec::new();
            while let Some(chunk) = control.next().await {
                buf.extend_from_slice(&chunk);
                while buf.len() >= 4 {
                    let cols = u16::from_be_bytes([buf[0], buf[1]]);
                    let rows = u16::from_be_bytes([buf[2], buf[3]]);
                    buf.drain(..4);
                    if resize.send((cols.max(1), rows.max(1))).is_err() {
                        return;
                    }
                }
            }
        });

        // The PTY's output becomes the returned wRPC stream; it ends when the shell
        // exits — or, bound to the grant, when it's revoked/expires (the guard then
        // kills the shell and aborts the pumps).
        let revocation = self.store.lock().unwrap().revocation(&grant);
        let out = UnboundedReceiverStream::new(output).map(Bytes::from);
        Ok(Ok(crate::session::grant_scoped(
            Box::pin(out),
            revocation,
            PtyGuard { killer, handles: vec![stdin_h, control_h] },
        )))
    }
}

/// Serve the terminal over wRPC/TCP on `listener` until cancelled. (The daemon
/// serves it over WebSocket + WebTransport beside the other capabilities; this
/// is the minimal serve used by the roundtrip test.)
pub async fn serve_tcp(listener: TcpListener, provider: TerminalProvider) -> anyhow::Result<()> {
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
        .context("failed to serve terminal")?;
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
    use crate::broker::TerminalRequest;
    use core::time::Duration;
    use futures::stream;

    fn terminal_grant(store: &Arc<Mutex<GrantStore>>) -> String {
        store.lock().unwrap().issue(
            CapabilityKind::Terminal(TerminalRequest { shell: None, jailed: false }),
            "terminal".to_string(),
            Duration::from_secs(60),
            crate::broker::anonymous_principal(),
        )
    }

    #[tokio::test]
    async fn terminal_echo_roundtrip() {
        // Stand in for a prior consented request: mint a terminal grant.
        let store = GrantStore::shared();
        let grant = terminal_grant(&store);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(serve_tcp(listener, TerminalProvider::new(store.clone())));
        tokio::time::sleep(Duration::from_millis(150)).await;

        let wrpc = wrpc_transport::tcp::Client::from(&addr);

        // Type a command, then exit — the shell echoes the marker back to us.
        let stdin: Pin<Box<dyn Stream<Item = Bytes> + Send>> = Box::pin(stream::iter([
            Bytes::from_static(b"echo wrpc-terminal-works\n"),
            Bytes::from_static(b"exit\n"),
        ]));

        let control: Pin<Box<dyn Stream<Item = Bytes> + Send>> = Box::pin(stream::iter(Vec::<Bytes>::new()));
        let (result, io) = client::open(&wrpc, (), &grant, stdin, control, 80, 24)
            .await
            .expect("invoke terminal.open");
        let mut output = result.expect("open shell");

        // Drive the wRPC I/O and drain the output concurrently (with a timeout
        // so a misbehaving shell fails fast instead of hanging).
        let collected: Vec<u8> = tokio::time::timeout(Duration::from_secs(15), async {
            let (_, buf) = tokio::try_join!(
                async move {
                    if let Some(io) = io {
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
        .expect("terminal test timed out")
        .expect("terminal I/O failed");

        let text = String::from_utf8_lossy(&collected);
        assert!(text.contains("wrpc-terminal-works"), "shell output missing marker:\n{text}");

        server.abort();
    }

    #[tokio::test]
    async fn terminal_refused_without_grant() {
        // Empty store — no grant was ever issued. The gate must refuse.
        let store = GrantStore::shared();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(serve_tcp(listener, TerminalProvider::new(store)));
        tokio::time::sleep(Duration::from_millis(150)).await;

        let wrpc = wrpc_transport::tcp::Client::from(&addr);
        let stdin: Pin<Box<dyn Stream<Item = Bytes> + Send>> = Box::pin(stream::iter([]));
        let control: Pin<Box<dyn Stream<Item = Bytes> + Send>> = Box::pin(stream::iter([]));
        let (result, _io) = client::open(&wrpc, (), "bogus-token", stdin, control, 80, 24)
            .await
            .expect("invoke terminal.open");
        match result {
            Err(msg) => assert!(msg.contains("denied"), "unexpected refusal message: {msg}"),
            Ok(_) => panic!("an ungranted open must be refused"),
        }

        server.abort();
    }
}
