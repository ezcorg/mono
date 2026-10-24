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

use futures::{Stream, StreamExt as _};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio_stream::wrappers::UnboundedReceiverStream;
use wit_bindgen_wrpc::bytes::Bytes;

use crate::broker::{CapabilityKind, GrantStore};

pub(crate) mod bindings {
    wit_bindgen_wrpc::generate!({
        world: "terminal-client",
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

    /// The raw open (`icanhaz:nocap/pty`): for any live `terminal` grant, or
    /// a component grant one was lent to.
    pub fn native_for_grants(&self) -> crate::raw::NativeTerminal {
        let store = self.store.clone();
        Arc::new(move |token, stdin, control, cols, rows| {
            let store = store.clone();
            Box::pin(async move {
                let token = store
                    .lock()
                    .unwrap()
                    .delegated_for(&token, "terminal")
                    .ok_or_else(|| {
                        "terminal denied: no terminal grant for this call".to_string()
                    })?;
                open_native(&store, &token, stdin, control, cols, rows)
            })
        })
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

    Ok(PtyIo {
        stdin,
        output,
        resize,
        killer,
    })
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

/// Spawn the host's login shell in a PTY for a live `terminal` grant, wire
/// `stdin` and `control` to it, and return its output bound to the grant's
/// life. Re-checks the grant and re-admits the window so a wrapper's rewrite
/// still meets the grant's clauses.
fn open_native(
    store: &Arc<Mutex<GrantStore>>,
    grant: &str,
    stdin: Pin<Box<dyn Stream<Item = Bytes> + Send>>,
    control: Pin<Box<dyn Stream<Item = Bytes> + Send>>,
    cols: u16,
    rows: u16,
) -> Result<Pin<Box<dyn Stream<Item = Bytes> + Send>>, String> {
    {
        let mut g = store.lock().unwrap();
        if let Err(denied) = g.validate(grant, |k| matches!(k, CapabilityKind::Terminal(_))) {
            return Err(format!("terminal denied: {denied:?}"));
        }
        let admit = crate::broker::AdmitCall::new("open")
            .arg("cols", i64::from(cols))
            .arg("rows", i64::from(rows));
        if let Err(denied) = g.admit(grant, admit) {
            return Err(format!(
                "terminal denied: {}",
                crate::broker::denied_text(&denied)
            ));
        }
    }
    // The shell is the host's, not the requestor's: a terminal grant means
    // "a shell as *you* are configured", never "run a program the caller
    // names" (that is a broader, separately-consented capability).
    let shell = default_shell();
    let pty = match spawn_pty(&shell, cols.max(1), rows.max(1)) {
        Ok(p) => p,
        Err(e) => return Err(format!("failed to spawn `{shell}`: {e}")),
    };
    let PtyIo {
        stdin: pty_stdin,
        output,
        resize,
        killer,
    } = pty;

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
    let revocation = store.lock().unwrap().revocation(grant);
    let out = UnboundedReceiverStream::new(output).map(Bytes::from);
    Ok(crate::session::grant_scoped(
        Box::pin(out),
        revocation,
        PtyGuard {
            killer,
            handles: vec![stdin_h, control_h],
        },
    ))
}
