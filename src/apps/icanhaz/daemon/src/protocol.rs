//! v1 wire protocol — a multiplexed, capability-oriented RPC modelled on wRPC.
//!
//! One WebSocket carries the whole session. Control messages are JSON **text**
//! frames (invocations + replies + events). Async byte-streams (a terminal's
//! stdin/stdout) are **binary** frames on indexed *channels*: a 4-byte
//! big-endian channel id followed by raw bytes — the same shape wRPC gives an
//! indexed sub-stream over a multiplexed transport (one QUIC stream there, one
//! channel id here). Resources (`grant`, `terminal`) are u32 handle ids.
//!
//! The message set maps 1:1 onto `icanhaz:nocap` (`../wit`): `session.request`,
//! `capability.claim-*`, `terminal.{resize,signal}`. Swapping this for
//! wire-compatible wRPC is then a codec/transport change, not a redesign.

use serde::{Deserialize, Serialize};

/// Browser → daemon control frames.
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum ClientMsg {
    /// Must be first: presents the consent PIN.
    Hello { pin: String },
    /// `session.request` — ask for a capability. `id` correlates the reply.
    Request {
        id: u32,
        want: CapabilityKind,
        #[serde(default)]
        reason: String,
    },
    /// `capability.claim-*` — turn a granted capability into a live resource.
    Claim { id: u32, grant: u32 },
    /// `terminal.resize`
    Resize { terminal: u32, cols: u16, rows: u16 },
    /// `terminal.signal`
    Signal { terminal: u32, signal: String },
    /// Drop a terminal (closes its streams; the shell gets SIGHUP).
    Close { terminal: u32 },
}

/// Maps to `icanhaz:nocap/types.capability-kind`. (filesystem / sockets /
/// process are v1 follow-ups behind the same shape.)
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CapabilityKind {
    Terminal(TerminalRequest),
}

#[derive(Debug, Clone, Deserialize)]
pub struct TerminalRequest {
    #[serde(default)]
    pub jailed: bool,
    pub shell: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}

/// Daemon → browser control frames.
#[derive(Debug, Serialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum ServerMsg {
    /// PIN accepted; the session is live.
    HelloOk,
    /// Reply to `Request`: a capability handle the client can `Claim`.
    Granted { id: u32, grant: u32, summary: String },
    /// Reply to `Claim`: a live terminal + the channel ids for its streams.
    Claimed {
        id: u32,
        terminal: u32,
        in_channel: u32,
        out_channel: u32,
    },
    /// A request/claim/hello was refused. `id` is absent for the hello refusal.
    Denied {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<u32>,
        reason: String,
    },
    /// A terminal ended.
    Exit { terminal: u32, code: i32 },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<u32>,
        message: String,
    },
}

/// Prefix `data` with its 4-byte big-endian channel id for a binary frame.
pub fn frame_channel(channel: u32, data: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(4 + data.len());
    v.extend_from_slice(&channel.to_be_bytes());
    v.extend_from_slice(data);
    v
}

/// Split a binary frame into its channel id and payload.
pub fn parse_channel(data: &[u8]) -> Option<(u32, &[u8])> {
    if data.len() < 4 {
        return None;
    }
    let channel = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
    Some((channel, &data[4..]))
}
