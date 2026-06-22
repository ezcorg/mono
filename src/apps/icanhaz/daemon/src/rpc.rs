//! The per-connection RPC handler: consent (PIN), then a multiplexed capability
//! session — `request` → `grant` → `claim` → streamed terminal(s) over one WS.

use crate::protocol::{
    frame_channel, parse_channel, CapabilityKind, ClientMsg, ServerMsg, TerminalRequest,
};
use crate::pty::{Pty, PtyControl};
use crate::server::Config;
use anyhow::Result;
use futures_util::stream::{SplitStream, StreamExt};
use futures_util::SinkExt;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;
use tracing::info;

/// An item to write to the WebSocket. A single writer task owns the sink so any
/// number of per-terminal forwarders can emit without sharing it.
enum Out {
    Text(String),
    Binary(Vec<u8>),
}

/// A granted-but-not-yet-claimed capability.
enum Grant {
    Terminal(TerminalRequest),
}

/// A live terminal the session can steer.
struct Term {
    control: PtyControl,
}

pub async fn serve(stream: TcpStream, peer: String, cfg: Arc<Config>) -> Result<()> {
    let ws = tokio_tungstenite::accept_async(stream).await?;
    let (mut sink, rx) = ws.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Out>();

    // The sole owner of the sink.
    let writer = tokio::spawn(async move {
        while let Some(item) = out_rx.recv().await {
            let msg = match item {
                Out::Text(t) => Message::Text(t),
                Out::Binary(b) => Message::Binary(b),
            };
            if sink.send(msg).await.is_err() {
                break;
            }
        }
        let _ = sink.send(Message::Close(None)).await;
    });

    let result = session(rx, out_tx, peer, cfg).await;
    writer.abort();
    result
}

fn send(out_tx: &mpsc::UnboundedSender<Out>, msg: ServerMsg) {
    if let Ok(json) = serde_json::to_string(&msg) {
        let _ = out_tx.send(Out::Text(json));
    }
}

async fn session(
    mut rx: SplitStream<WebSocketStream<TcpStream>>,
    out_tx: mpsc::UnboundedSender<Out>,
    peer: String,
    cfg: Arc<Config>,
) -> Result<()> {
    // 1. Hello / consent.
    match rx.next().await {
        Some(Ok(Message::Text(t))) => match serde_json::from_str::<ClientMsg>(&t) {
            Ok(ClientMsg::Hello { pin }) if constant_eq(&pin, &cfg.pin) => send(&out_tx, ServerMsg::HelloOk),
            Ok(ClientMsg::Hello { .. }) => {
                send(&out_tx, ServerMsg::Denied { id: None, reason: "invalid pin".into() });
                return Ok(());
            }
            _ => {
                send(&out_tx, ServerMsg::Denied { id: None, reason: "expected hello".into() });
                return Ok(());
            }
        },
        _ => return Ok(()),
    }

    let mut grants: HashMap<u32, Grant> = HashMap::new();
    let mut terms: HashMap<u32, Term> = HashMap::new();
    let mut channel_to_term: HashMap<u32, u32> = HashMap::new();
    let mut next: u32 = 1;

    // 2. Capability session.
    loop {
        match rx.next().await {
            Some(Ok(Message::Text(t))) => {
                let Ok(msg) = serde_json::from_str::<ClientMsg>(&t) else { continue };
                match msg {
                    ClientMsg::Request { id, want, reason } => match want {
                        CapabilityKind::Terminal(req) => {
                            if !req.jailed && !cfg.allow_host_shell {
                                send(&out_tx, ServerMsg::Denied {
                                    id: Some(id),
                                    reason: "host shell not allowed (restart icanhazd with --allow-host-shell)".into(),
                                });
                            } else {
                                let grant = next;
                                next += 1;
                                info!("{peer}: granted terminal capability — {reason:?}");
                                grants.insert(grant, Grant::Terminal(req));
                                send(&out_tx, ServerMsg::Granted { id, grant, summary: "terminal".into() });
                            }
                        }
                    },
                    ClientMsg::Claim { id, grant } => match grants.get(&grant) {
                        Some(Grant::Terminal(req)) => {
                            let shell = req.shell.clone().unwrap_or_else(|| cfg.shell.clone());
                            match Pty::spawn(&shell, req.cols, req.rows) {
                                Ok(Pty { control, mut output, exited }) => {
                                    let terminal = next;
                                    let in_channel = next + 1;
                                    let out_channel = next + 2;
                                    next += 3;

                                    terms.insert(terminal, Term { control });
                                    channel_to_term.insert(in_channel, terminal);

                                    // Forward PTY output → its out channel.
                                    let otx = out_tx.clone();
                                    tokio::spawn(async move {
                                        while let Some(bytes) = output.recv().await {
                                            if otx.send(Out::Binary(frame_channel(out_channel, &bytes))).is_err() {
                                                break;
                                            }
                                        }
                                    });
                                    // Announce exit.
                                    let otx = out_tx.clone();
                                    tokio::spawn(async move {
                                        let code = exited.await.unwrap_or(-1);
                                        send(&otx, ServerMsg::Exit { terminal, code });
                                    });

                                    info!("{peer}: terminal {terminal} ({shell}, {}x{})", req.cols, req.rows);
                                    send(&out_tx, ServerMsg::Claimed { id, terminal, in_channel, out_channel });
                                }
                                Err(e) => send(&out_tx, ServerMsg::Error {
                                    id: Some(id),
                                    message: format!("failed to start shell: {e}"),
                                }),
                            }
                        }
                        None => send(&out_tx, ServerMsg::Error { id: Some(id), message: "unknown grant".into() }),
                    },
                    ClientMsg::Resize { terminal, cols, rows } => {
                        if let Some(term) = terms.get(&terminal) {
                            term.control.resize(cols, rows);
                        }
                    }
                    ClientMsg::Signal { terminal, signal } => {
                        if let (Some(term), Some(byte)) = (terms.get(&terminal), sig_byte(&signal)) {
                            term.control.write_stdin(vec![byte]);
                        }
                    }
                    ClientMsg::Close { terminal } => {
                        terms.remove(&terminal);
                        channel_to_term.retain(|_, v| *v != terminal);
                    }
                    ClientMsg::Hello { .. } => {} // ignore a duplicate hello
                }
            }
            Some(Ok(Message::Binary(data))) => {
                if let Some((channel, bytes)) = parse_channel(&data) {
                    if let Some(terminal) = channel_to_term.get(&channel) {
                        if let Some(term) = terms.get(terminal) {
                            term.control.write_stdin(bytes.to_vec());
                        }
                    }
                }
            }
            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
            Some(Ok(_)) => {} // ping / pong / other
        }
    }
    // Dropping `terms` closes every PTY master → the shells get SIGHUP.
    Ok(())
}

/// The control byte a terminal sends for a given signal name.
fn sig_byte(signal: &str) -> Option<u8> {
    match signal {
        "INT" => Some(0x03),  // ^C
        "EOF" => Some(0x04),  // ^D
        "QUIT" => Some(0x1c), // ^\
        "SUSP" => Some(0x1a), // ^Z
        _ => None,
    }
}

fn constant_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}
