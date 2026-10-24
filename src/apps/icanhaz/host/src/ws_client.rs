//! A wRPC client for the daemon's WebSocket port from a native program (the
//! `icanhaz` command line). The daemon multiplexes every invocation over one
//! socket (`serve::serve_ws_mux`: frames of `[id: u32 LE][kind: u8][payload]`,
//! kind `0` data and `1` end), which is what the browser speaks too, and not
//! the one-connection-per-invocation form `wrpc-websockets` implements. This
//! is that framing's client: one socket, an id per invocation, each
//! invocation a virtual duplex the frame codec runs over.

use std::collections::HashMap;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use anyhow::Context as _;
use bytes::Bytes;
use futures::{SinkExt as _, StreamExt as _};
use tokio::io::AsyncWrite;
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_util::io::StreamReader;
use wrpc_transport::Invoke;
use wrpc_websockets::tokio_websockets::{ClientBuilder, Message};

const MUX_DATA: u8 = 0;
const MUX_END: u8 = 1;

type Feeder = mpsc::UnboundedSender<io::Result<Bytes>>;

/// One multiplexed WebSocket to a daemon.
#[derive(Clone)]
pub struct MuxClient {
    out: mpsc::UnboundedSender<Message>,
    feeders: Arc<Mutex<HashMap<u32, Feeder>>>,
    next_id: Arc<AtomicU32>,
}

impl MuxClient {
    /// Connect to the daemon at `url` (`ws://127.0.0.1:7777`).
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        let builder = ClientBuilder::new()
            .uri(url)
            .with_context(|| format!("daemon url `{url}`"))?;
        let (ws, _response) = builder
            .connect()
            .await
            .with_context(|| format!("connect to the daemon at {url}"))?;
        let (mut sink, mut stream) = ws.split();
        let (out, mut out_rx) = mpsc::unbounded_channel::<Message>();
        let feeders: Arc<Mutex<HashMap<u32, Feeder>>> = Arc::new(Mutex::new(HashMap::new()));
        tokio::spawn(async move {
            while let Some(msg) = out_rx.recv().await {
                if sink.send(msg).await.is_err() {
                    break;
                }
            }
        });
        tokio::spawn({
            let feeders = Arc::clone(&feeders);
            async move {
                while let Some(Ok(msg)) = stream.next().await {
                    if !msg.is_binary() {
                        continue;
                    }
                    let payload = Bytes::from(msg.into_payload());
                    if payload.len() < 5 {
                        continue;
                    }
                    let id = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
                    let kind = payload[4];
                    let mut feeders = feeders.lock().unwrap_or_else(|e| e.into_inner());
                    match kind {
                        MUX_DATA => {
                            if let Some(feed) = feeders.get(&id) {
                                let _ = feed.send(Ok(payload.slice(5..)));
                            }
                        }
                        MUX_END => {
                            // The daemon's end of output: dropping the sender is EOF.
                            feeders.remove(&id);
                        }
                        _ => {}
                    }
                }
                // The socket closed: every open invocation sees EOF.
                feeders.lock().unwrap_or_else(|e| e.into_inner()).clear();
            }
        });
        Ok(Self {
            out,
            feeders,
            next_id: Arc::new(AtomicU32::new(1)),
        })
    }
}

/// The write half of one invocation: each write is a data frame for its id;
/// shutdown (or drop) is the end frame, the daemon's end-of-input signal.
struct MuxTx {
    id: u32,
    sink: mpsc::UnboundedSender<Message>,
    ended: bool,
}

impl MuxTx {
    fn frame(&self, kind: u8, payload: &[u8]) -> Message {
        let mut buf = Vec::with_capacity(5 + payload.len());
        buf.extend_from_slice(&self.id.to_le_bytes());
        buf.push(kind);
        buf.extend_from_slice(payload);
        Message::binary(Bytes::from(buf))
    }

    fn end(&mut self) {
        if !self.ended {
            self.ended = true;
            let _ = self.sink.send(self.frame(MUX_END, &[]));
        }
    }
}

impl AsyncWrite for MuxTx {
    fn poll_write(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if this.sink.send(this.frame(MUX_DATA, buf)).is_err() {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "websocket closed",
            )));
        }
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.get_mut().end();
        Poll::Ready(Ok(()))
    }
}

impl Drop for MuxTx {
    fn drop(&mut self) {
        self.end();
    }
}

impl Invoke for MuxClient {
    type Context = ();

    async fn invoke<P>(
        &self,
        (): Self::Context,
        instance: &str,
        func: &str,
        params: Bytes,
        paths: impl AsRef<[P]> + Send,
    ) -> anyhow::Result<(
        wrpc_transport::frame::Outgoing,
        wrpc_transport::frame::Incoming,
    )>
    where
        P: AsRef<[Option<usize>]> + Send + Sync,
    {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (feed, feed_rx) = mpsc::unbounded_channel::<io::Result<Bytes>>();
        self.feeders
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, feed);
        let rx = StreamReader::new(UnboundedReceiverStream::new(feed_rx));
        let tx = MuxTx {
            id,
            sink: self.out.clone(),
            ended: false,
        };
        wrpc_transport::frame::invoke(tx, rx, instance, func, params, paths).await
    }
}
