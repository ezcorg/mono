//! Loopback invoke/serve over real iroh
//! endpoints — toy interface roundtrip, concurrent invocations, ≥4 MiB
//! payloads, and clean errors on peer disconnect mid-call.

// Test helpers panic on setup failure by design.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures::StreamExt;
use iroh::Endpoint;
use iroh::endpoint::presets;
use wrpc_transport::{InvokeExt as _, ServeExt as _};
use wrpc_transport_iroh::{Client, Server, serve_connection};

const ALPN: &[u8] = b"dij-test/0";
const NO_PATHS: [Box<[Option<usize>]>; 0] = [];

/// A connected loopback pair. The returned guard owns the endpoints and the
/// accept task; keep it alive for the duration of the test.
struct Loopback {
    client: Client,
    server: Arc<Server>,
    _client_ep: Endpoint,
    _server_task: tokio::task::JoinHandle<()>,
}

async fn loopback() -> Loopback {
    let server_ep = Endpoint::builder(presets::Minimal)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .expect("bind server endpoint");
    let client_ep = Endpoint::builder(presets::Minimal)
        .bind()
        .await
        .expect("bind client endpoint");
    let server_addr = server_ep.addr();

    let server = Arc::new(Server::new());
    let accept_server = Arc::clone(&server);
    let server_task = tokio::spawn(async move {
        while let Some(incoming) = server_ep.accept().await {
            let Ok(conn) = incoming.await else { continue };
            let server = Arc::clone(&accept_server);
            tokio::spawn(async move {
                let _ = serve_connection(&server, &conn).await;
            });
        }
    });

    let conn = client_ep
        .connect(server_addr, ALPN)
        .await
        .expect("connect to loopback server");
    Loopback {
        client: Client::from(conn),
        server,
        _client_ep: client_ep,
        _server_task: server_task,
    }
}

/// Serve the toy `dij-test/echo.echo: func(s: string) -> string` endlessly.
async fn spawn_echo(server: &Arc<Server>) {
    let invocations = server
        .serve_values::<(String,), (String,)>("dij-test/echo", "echo", Arc::from(NO_PATHS))
        .await
        .expect("serve echo");
    tokio::spawn(async move {
        let mut invocations = std::pin::pin!(invocations);
        while let Some(invocation) = invocations.next().await {
            let Ok(((), (param,), _deferred, respond)) = invocation else {
                continue;
            };
            tokio::spawn(async move {
                let _ = respond((format!("echo: {param}"),)).await;
            });
        }
    });
}

#[tokio::test]
async fn loopback_invoke_serve_roundtrip() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let lb = loopback().await;
        spawn_echo(&lb.server).await;
        let client = &lb.client;

        let ((reply,), io) = client
            .invoke_values::<Box<[Option<usize>]>, (String,), (String,), _>(
                (),
                "dij-test/echo",
                "echo",
                ("hello world".to_string(),),
                &NO_PATHS,
            )
            .await
            .expect("invoke echo");
        assert_eq!(reply, "echo: hello world");
        if let Some(io) = io {
            io.await.expect("io driver");
        }
    })
    .await
    .expect("test timed out");
}

#[tokio::test]
async fn concurrent_invocations_all_complete() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let lb = loopback().await;
        spawn_echo(&lb.server).await;
        let client = Arc::new(lb.client.clone());
        let _lb = &lb;

        let mut joins = Vec::new();
        for i in 0..16 {
            let client = Arc::clone(&client);
            joins.push(tokio::spawn(async move {
                let ((reply,), io) = client
                    .invoke_values::<Box<[Option<usize>]>, (String,), (String,), _>(
                        (),
                        "dij-test/echo",
                        "echo",
                        (format!("msg-{i}"),),
                        &NO_PATHS,
                    )
                    .await
                    .expect("invoke");
                if let Some(io) = io {
                    io.await.expect("io driver");
                }
                (i, reply)
            }));
        }
        for join in joins {
            let (i, reply) = join.await.expect("join");
            assert_eq!(reply, format!("echo: msg-{i}"));
        }
    })
    .await
    .expect("test timed out");
}

#[tokio::test]
async fn large_payload_over_4mib_frames_correctly() {
    tokio::time::timeout(Duration::from_secs(120), async {
        let lb = loopback().await;
        let client = &lb.client;

        // Byte-echo service.
        let invocations = lb
            .server
            .serve_values::<(Bytes,), (Bytes,)>("dij-test/blob", "echo", Arc::from(NO_PATHS))
            .await
            .expect("serve blob echo");
        tokio::spawn(async move {
            let mut invocations = std::pin::pin!(invocations);
            while let Some(invocation) = invocations.next().await {
                let Ok(((), (payload,), _deferred, respond)) = invocation else {
                    continue;
                };
                tokio::spawn(async move {
                    let _ = respond((payload,)).await;
                });
            }
        });

        // 5 MiB deterministic payload (> the 4 MiB requirement).
        let payload: Bytes = (0..5 * 1024 * 1024_u32)
            .map(|i| (i % 251) as u8)
            .collect::<Vec<u8>>()
            .into();
        let ((reply,), io) = client
            .invoke_values::<Box<[Option<usize>]>, (Bytes,), (Bytes,), _>(
                (),
                "dij-test/blob",
                "echo",
                (payload.clone(),),
                &NO_PATHS,
            )
            .await
            .expect("invoke blob echo");
        if let Some(io) = io {
            io.await.expect("io driver");
        }
        assert_eq!(reply.len(), payload.len());
        assert_eq!(reply, payload, "5 MiB payload roundtrips bit-exact");
    })
    .await
    .expect("test timed out");
}

#[tokio::test]
async fn peer_disconnect_mid_call_is_a_clean_error_not_a_hang() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let server_ep = Endpoint::builder(presets::Minimal)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .expect("bind server endpoint");
        let client_ep = Endpoint::builder(presets::Minimal)
            .bind()
            .await
            .expect("bind client endpoint");
        let server_addr = server_ep.addr();

        // A server that accepts the connection and stream, then slams the
        // connection shut without ever responding.
        let server_task = tokio::spawn(async move {
            let incoming = server_ep.accept().await.expect("incoming");
            let conn = incoming.await.expect("accept connection");
            let _stream = conn.accept_bi().await.expect("accept stream");
            tokio::time::sleep(Duration::from_millis(100)).await;
            conn.close(0u32.into(), b"gone");
            // Keep the endpoint alive long enough for the close to transmit.
            tokio::time::sleep(Duration::from_secs(1)).await;
        });

        let conn = client_ep.connect(server_addr, ALPN).await.expect("connect");
        let client = Client::from(conn);
        let result = client
            .invoke_values::<Box<[Option<usize>]>, (String,), (String,), _>(
                (),
                "dij-test/echo",
                "echo",
                ("doomed".to_string(),),
                &NO_PATHS,
            )
            .await;
        assert!(
            result.is_err(),
            "mid-call disconnect must surface an error, got success"
        );
        server_task.await.expect("server task");
    })
    .await
    .expect("disconnect surfaced no error within the timeout (hang)");
}
