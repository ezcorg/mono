//! Each shipped capability, served on its own the way the daemon serves it
//! (`serve_capability` over the raw layer built from its provider) and driven
//! from its generated wRPC client: the smallest test that localizes a
//! regression to one component.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures::StreamExt as _;
use tokio::net::TcpListener;
use tokio::task::JoinSet;
use wasmtime_wasi::{FsPerms, WasiCtxBuilder};

use crate::broker::{
    anonymous_principal, CapabilityKind, FsRequest, FsRights, GrantStore, InferenceRequest,
    PathGrant, ProcessRequest, TerminalRequest,
};
use crate::component_serve::{serve_capability, serve_resource_drop, Handles, WasiRecipe};
use crate::raw::Raw;

type Client = wrpc_transport::tcp::Client<String>;

/// A shipped capability component, as the daemon finds it.
fn shipped(name: &str) -> Vec<u8> {
    let path = format!(
        "{}/../capabilities/{name}/target/wasm32-wasip2/release/{name}_capability.wasm",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|e| panic!("build capabilities/{name} first ({path}): {e}"))
}

/// One capability on its own server: its component over `raw`, the jail at
/// `root` preopened for its chain, the drop op beside it. Returns a client
/// and what keeps the server alive.
async fn serve(
    name: &str,
    raw: Raw,
    grants: Arc<std::sync::Mutex<GrantStore>>,
    root: &Path,
) -> (Client, Served) {
    let srv = Arc::new(wrpc_transport::Server::default());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let accept = {
        let srv = Arc::clone(&srv);
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (rx, tx) = stream.into_split();
                let _ = srv.accept((), tx, rx).await;
            }
        })
    };
    let root = root.to_path_buf();
    let wasi: WasiRecipe = Arc::new(move || {
        let mut builder = WasiCtxBuilder::new();
        builder
            .preopened_dir(&root, "/", FsPerms::ReadWrite)
            .map_err(anyhow::Error::from)?;
        Ok(builder.build())
    });
    let handles = Handles::new();
    let mut handlers = serve_capability(
        srv.as_ref(),
        &shipped(name),
        Client::from(addr.clone()),
        (),
        wasi,
        grants,
        None,
        Arc::new(raw),
        Arc::clone(&handles),
    )
    .await
    .unwrap_or_else(|e| panic!("serve the {name} capability: {e:#}"));
    serve_resource_drop(srv.as_ref(), handles, &mut handlers)
        .await
        .expect("serve resources.drop");
    tokio::time::sleep(Duration::from_millis(100)).await;
    (
        Client::from(addr),
        Served {
            _accept: accept,
            _handlers: handlers,
        },
    )
}

struct Served {
    _accept: tokio::task::JoinHandle<()>,
    _handlers: JoinSet<()>,
}

impl Drop for Served {
    fn drop(&mut self) {
        self._accept.abort();
    }
}

fn filesystem_grant(grants: &Arc<std::sync::Mutex<GrantStore>>) -> String {
    grants.lock().unwrap().issue(
        CapabilityKind::Filesystem(FsRequest {
            roots: vec![PathGrant {
                path: "/".to_string(),
                rights: FsRights::READ | FsRights::WRITE | FsRights::WATCH,
            }],
        }),
        "filesystem (/)".to_string(),
        Duration::from_secs(60),
        anonymous_principal(),
    )
}

/// Everything a byte stream carries until it ends, within `secs`.
async fn collect(stream: crate::session::ByteStream, secs: u64) -> Vec<u8> {
    tokio::time::timeout(Duration::from_secs(secs), async {
        let chunks: Vec<Bytes> = stream.collect().await;
        chunks.concat()
    })
    .await
    .expect("the stream ended in time")
}

/// The next bytes of a stream that satisfy `done`, within `secs`.
async fn read_until(
    mut stream: crate::session::ByteStream,
    secs: u64,
    done: impl Fn(&[u8]) -> bool,
) -> Vec<u8> {
    tokio::time::timeout(Duration::from_secs(secs), async {
        let mut out = Vec::new();
        while let Some(chunk) = stream.next().await {
            out.extend_from_slice(&chunk);
            if done(&out) {
                break;
            }
        }
        out
    })
    .await
    .expect("the stream produced what was expected in time")
}

#[tokio::test]
async fn process_runs_the_pinned_program_with_piped_stdio() {
    use crate::process::client::{self as process, Process};

    let dir = tempfile::tempdir().unwrap();
    let grants = GrantStore::shared();
    let provider = crate::process::ProcessProvider::new(grants.clone());
    let mut raw = Raw::new(grants.clone());
    raw.spawn = Some(provider.native_for_grants());
    let (client, _served) = serve("process", raw, grants.clone(), dir.path()).await;

    let grant = grants.lock().unwrap().issue(
        CapabilityKind::Process(ProcessRequest {
            image: "cat".to_string(),
            args: vec![],
            guest_chooses_argv: false,
        }),
        "process (cat)".to_string(),
        Duration::from_secs(60),
        anonymous_principal(),
    );
    let opened = process::open(&client, (), &grant)
        .await
        .unwrap()
        .expect("the token once, at open");
    let stdin = futures::stream::iter(vec![
        Bytes::from_static(b"piped "),
        Bytes::from_static(b"through\n"),
    ]);
    let (res, io) = Process::spawn(&client, (), &opened.as_borrow(), &[], Box::pin(stdin))
        .await
        .unwrap();
    if let Some(io) = io {
        tokio::spawn(async move {
            let _ = io.await;
        });
    }
    let stdout = res.expect("spawned");
    assert_eq!(collect(stdout, 20).await, b"piped through\n");

    // The grant pins the argv: anything else is refused before the spawn.
    let stdin = futures::stream::iter(Vec::<Bytes>::new());
    let (res, _) = Process::spawn(&client, (), &opened.as_borrow(), &["-n"], Box::pin(stdin))
        .await
        .unwrap();
    let err = res.err().expect("refused");
    assert!(err.contains("denied"), "{err}");

    // A token of another kind never yields an object.
    let refused = process::open(&client, (), &filesystem_grant(&grants))
        .await
        .unwrap();
    assert!(refused.unwrap_err().contains("denied"));
}

#[tokio::test]
async fn terminal_attaches_the_login_shell_in_a_pty() {
    use crate::terminal::client::{self as terminal, Terminal};

    let dir = tempfile::tempdir().unwrap();
    let grants = GrantStore::shared();
    let provider = crate::terminal::TerminalProvider::new(grants.clone());
    let mut raw = Raw::new(grants.clone());
    raw.terminal = Some(provider.native_for_grants());
    let (client, _served) = serve("terminal", raw, grants.clone(), dir.path()).await;

    let grant = grants.lock().unwrap().issue(
        CapabilityKind::Terminal(TerminalRequest {
            shell: None,
            jailed: false,
        }),
        "terminal".to_string(),
        Duration::from_secs(60),
        anonymous_principal(),
    );
    let opened = terminal::open(&client, (), &grant)
        .await
        .unwrap()
        .expect("opened");
    // Keystrokes arrive a little after the shell starts, as from a person.
    let stdin = futures::stream::unfold(0u8, |step| async move {
        match step {
            0 => {
                tokio::time::sleep(Duration::from_millis(800)).await;
                Some((Bytes::from_static(b"echo pty-attached\n"), 1))
            }
            1 => {
                tokio::time::sleep(Duration::from_millis(300)).await;
                Some((Bytes::from_static(b"exit\n"), 2))
            }
            _ => None,
        }
    });
    let control = futures::stream::pending::<Bytes>();
    let (res, io) = Terminal::attach(
        &client,
        (),
        &opened.as_borrow(),
        Box::pin(stdin),
        Box::pin(control),
        80,
        24,
    )
    .await
    .unwrap();
    if let Some(io) = io {
        tokio::spawn(async move {
            let _ = io.await;
        });
    }
    let output = res.expect("attached");
    let seen = read_until(output, 20, |b| {
        String::from_utf8_lossy(b).matches("pty-attached").count() >= 2
    })
    .await;
    // Echoed by the tty as typed, then printed by the shell.
    assert!(
        String::from_utf8_lossy(&seen)
            .matches("pty-attached")
            .count()
            >= 2,
        "{}",
        String::from_utf8_lossy(&seen)
    );
}

#[tokio::test]
async fn watch_streams_a_change_under_the_grant() {
    use crate::watch::client::{self as watch, Watcher};

    let dir = tempfile::tempdir().unwrap();
    let grants = GrantStore::shared();
    let provider = crate::watch::WatchProvider::new(dir.path().to_path_buf(), grants.clone());
    let mut raw = Raw::new(grants.clone());
    raw.watch = Some(provider.native_for_grants());
    let (client, _served) = serve("watch", raw, grants.clone(), dir.path()).await;

    let grant = filesystem_grant(&grants);
    let opened = watch::open(&client, (), &grant)
        .await
        .unwrap()
        .expect("opened");
    let (res, io) = Watcher::watch(&client, (), &opened.as_borrow(), ".", true)
        .await
        .unwrap();
    if let Some(io) = io {
        tokio::spawn(async move {
            let _ = io.await;
        });
    }
    let events = res.expect("watching");
    // Arm, then change something under the jail.
    let writer = {
        let path = dir.path().join("changed.txt");
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            std::fs::write(path, "hello watcher").unwrap();
        })
    };
    let seen = read_until(events, 15, |b| {
        String::from_utf8_lossy(b).contains("changed.txt")
    })
    .await;
    writer.await.unwrap();
    // Frames are `[kind u8][len u16 BE][path]`: a rename (create) or a change.
    assert!(seen.len() >= 3, "{seen:?}");
    assert!(seen[0] == 0 || seen[0] == 1, "kind {}", seen[0]);
    assert!(String::from_utf8_lossy(&seen).contains("changed.txt"));
}

#[tokio::test]
async fn workspace_reports_the_grant_root_on_the_host() {
    use crate::workspace::client::{self as workspace, Workspace};

    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("project")).unwrap();
    let grants = GrantStore::shared();
    let provider =
        crate::workspace::WorkspaceProvider::new(dir.path().to_path_buf(), grants.clone());
    let mut raw = Raw::new(grants.clone());
    raw.root = Some(provider.native_for_grants());
    let (client, _served) = serve("workspace", raw, grants.clone(), dir.path()).await;

    let grant = grants.lock().unwrap().issue(
        CapabilityKind::Filesystem(FsRequest {
            roots: vec![PathGrant {
                path: "/project".to_string(),
                rights: FsRights::READ,
            }],
        }),
        "filesystem (/project)".to_string(),
        Duration::from_secs(60),
        anonymous_principal(),
    );
    let opened = workspace::open(&client, (), &grant)
        .await
        .unwrap()
        .expect("opened");
    let root = Workspace::root_path(&client, (), &opened.as_borrow())
        .await
        .unwrap()
        .expect("a host path");
    assert_eq!(
        Path::new(&root),
        dir.path().join("project"),
        "the grant's root on the host"
    );
    // Released through the drop op, the object answers no more.
    use wrpc_transport::InvokeExt as _;
    let handle: Bytes = AsRef::<Bytes>::as_ref(&opened).clone();
    let no_paths: [&[Option<usize>]; 0] = [];
    let ((removed,), _) = client
        .invoke_values::<_, (Bytes,), (bool,), _>(
            (),
            crate::component_serve::RESOURCES_INSTANCE,
            "drop",
            (handle,),
            no_paths,
        )
        .await
        .expect("drop invocation");
    assert!(removed);
    assert!(Workspace::root_path(&client, (), &opened.as_borrow())
        .await
        .is_err());
}

#[tokio::test]
async fn inference_lists_models_and_streams_a_completion() {
    use crate::inference::client::{self as inference, CompletionRequest, Message, Session};

    let dir = tempfile::tempdir().unwrap();
    let grants = GrantStore::shared();
    let providers = Arc::new(crate::providers::Providers::new(
        vec![crate::providers::ProviderConfig {
            name: "echo".to_string(),
            kind: crate::providers::ProviderKind::Echo,
            base_url: String::new(),
            api_key: String::new(),
            models: vec!["echo".to_string()],
        }],
        None,
    ));
    let provider = crate::inference::InferenceProvider::new(grants.clone(), providers);
    let (complete, models) = provider.native_for_grants();
    let mut raw = Raw::new(grants.clone());
    raw.complete = Some(complete);
    raw.models = Some(models);
    let (client, _served) = serve("inference", raw, grants.clone(), dir.path()).await;

    let grant = grants.lock().unwrap().issue(
        CapabilityKind::Inference(InferenceRequest {
            models: vec!["echo".to_string()],
        }),
        "inference (echo)".to_string(),
        Duration::from_secs(60),
        anonymous_principal(),
    );
    let opened = inference::open(&client, (), &grant)
        .await
        .unwrap()
        .expect("opened");
    let listed = Session::models(&client, (), &opened.as_borrow())
        .await
        .unwrap()
        .expect("models");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].model, "echo");

    let request = CompletionRequest {
        model: "echo".to_string(),
        messages: vec![Message {
            role: "user".to_string(),
            content: "hello component".to_string(),
            tool_calls: vec![],
            tool_call_id: None,
        }],
        tools: vec![],
        max_tokens: 0,
        temperature: None,
        system: None,
    };
    let (res, io) = Session::complete(&client, (), &opened.as_borrow(), &request)
        .await
        .unwrap();
    if let Some(io) = io {
        tokio::spawn(async move {
            let _ = io.await;
        });
    }
    let frames = collect(res.expect("admitted"), 20).await;
    // `[kind u8][len u32 BE][payload]`: the echo's text deltas, then usage.
    let mut text = String::new();
    let mut usage = false;
    let mut i = 0;
    while i + 5 <= frames.len() {
        let kind = frames[i];
        let len = u32::from_be_bytes([frames[i + 1], frames[i + 2], frames[i + 3], frames[i + 4]])
            as usize;
        let payload = &frames[i + 5..i + 5 + len];
        match kind {
            0 => text.push_str(&String::from_utf8_lossy(payload)),
            1 => usage = true,
            _ => {}
        }
        i += 5 + len;
    }
    assert_eq!(text, "hello component");
    assert!(usage, "a usage frame ends the completion");
    // A model outside the grant is refused by the raw layer.
    let other = CompletionRequest {
        model: "nope".to_string(),
        ..request
    };
    let (res, _) = Session::complete(&client, (), &opened.as_borrow(), &other)
        .await
        .unwrap();
    let err = res.err().expect("refused");
    assert!(err.contains("denied"), "{err}");
}
