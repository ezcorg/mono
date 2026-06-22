//! A spawned PTY with async-friendly I/O.
//!
//! `portable-pty` is blocking, so reads/writes/wait run on dedicated threads and
//! bridge to async via channels: PTY output → a tokio mpsc, stdin → a std mpsc
//! consumed by a writer thread, and child-exit → a tokio oneshot.

use anyhow::Result;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

/// Write-side + resize control for a running PTY (cheap to hold across the
/// select loop, separately from the receive halves).
pub struct PtyControl {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    stdin: std::sync::mpsc::Sender<Vec<u8>>,
}

impl PtyControl {
    pub fn write_stdin(&self, bytes: Vec<u8>) {
        let _ = self.stdin.send(bytes);
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        if let Ok(master) = self.master.lock() {
            let _ = master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }
}

pub struct Pty {
    pub control: PtyControl,
    /// PTY output (stdout/stderr merged by the pty).
    pub output: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    /// Resolves with the child's exit code.
    pub exited: tokio::sync::oneshot::Receiver<i32>,
}

impl Pty {
    pub fn spawn(shell: &str, cols: u16, rows: u16) -> Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
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
        // We don't need the slave handle; dropping it lets EOF propagate when
        // the child exits.
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        let master = Arc::new(Mutex::new(pair.master));

        // PTY output → tokio channel.
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

        // stdin channel → PTY writer.
        let (stdin, stdin_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            while let Ok(bytes) = stdin_rx.recv() {
                if writer.write_all(&bytes).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
        });

        // Child exit → oneshot.
        let (exit_tx, exited) = tokio::sync::oneshot::channel::<i32>();
        std::thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
            let _ = exit_tx.send(code);
        });

        Ok(Self {
            control: PtyControl { master, stdin },
            output,
            exited,
        })
    }
}
