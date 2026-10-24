//! Sharing across machines: a certificate issued by one daemon is redeemed
//! at it by another over iroh, which then holds the grant and forwards its
//! caller's calls there. The remote serves its capabilities the way the
//! daemon does: the shipped components over the raw layer; the local side
//! is the raw layer's natives, which forward a grant held elsewhere.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures::StreamExt as _;
use iroh::endpoint::presets::Minimal;
use iroh::Endpoint;
use tokio::task::JoinSet;

use crate::broker::bindings::exports::icanhaz::nocap::broker::Handler as _;
use crate::broker::bindings::icanhaz::nocap::types::Denied;
use crate::broker::{
    anonymous_principal, BrokerProvider, CapabilityKind, Consent, GrantStore, InferenceRequest,
    Pairings, ProcessRequest,
};
use crate::component_serve::{serve_capability, serve_resource_drop, Handles};
use crate::inference::InferenceProvider;
use crate::iroh::{accept_iroh, IROH_ALPN};
use crate::process::ProcessProvider;
use crate::providers::{ProviderConfig, ProviderKind, Providers};
use crate::raw::{ClientMessage, ClientRequest, Raw};
use crate::remote::{locator_of, parse_locator, Remotes};
use crate::ReqCtx;

fn echo() -> Arc<Providers> {
    Arc::new(Providers::new(
        vec![ProviderConfig {
            name: "echo".to_string(),
            kind: ProviderKind::Echo,
            base_url: String::new(),
            api_key: String::new(),
            models: vec!["echo".to_string()],
        }],
        None,
    ))
}

/// A shipped capability component, as the daemon finds it.
fn shipped(name: &str) -> Vec<u8> {
    let path = format!(
        "{}/../capabilities/{name}/target/wasm32-wasip2/release/{name}_capability.wasm",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|e| panic!("build capabilities/{name} first ({path}): {e}"))
}

/// The remote daemon over `endpoint`: the broker, and the process and
/// inference capabilities served as shipped components over `raw`, with the
/// resource-drop op beside them.
fn serve(
    endpoint: Endpoint,
    broker: BrokerProvider,
    store: Arc<std::sync::Mutex<GrantStore>>,
    raw: Arc<Raw>,
) {
    use futures::FutureExt as _;
    tokio::spawn(async move {
        let srv = Arc::new(wrpc_transport_iroh::Server::<ReqCtx>::new());
        let handles = Handles::new();
        let accept = tokio::spawn(accept_iroh::<()>(
            endpoint,
            Arc::clone(&srv),
            Arc::clone(&handles),
        ));
        let b = crate::broker::bindings::serve(srv.as_ref(), broker)
            .await
            .expect("serve broker");
        let mut capability_handlers = Vec::new();
        for name in ["process", "inference"] {
            let set = serve_capability(
                srv.as_ref(),
                &shipped(name),
                wrpc_transport::tcp::Client::from("127.0.0.1:1".to_string()),
                (),
                Arc::clone(&store),
                None,
                Arc::clone(&raw),
                Arc::clone(&handles),
            )
            .await
            .unwrap_or_else(|e| panic!("serve the {name} capability: {e:#}"));
            capability_handlers.push(set);
        }
        let mut drops = JoinSet::new();
        serve_resource_drop(srv.as_ref(), handles, &mut drops)
            .await
            .expect("serve resources.drop");
        let mut invs = futures::stream::select_all(
            b.into_iter()
                .map(|(_, _, s)| s.map(|r| r.map(|f| f.boxed())).boxed()),
        );
        while let Some(res) = invs.next().await {
            if let Ok(fut) = res {
                tokio::spawn(async move {
                    let _ = fut.await;
                });
            }
        }
        accept.abort();
        drop(capability_handlers);
        drop(drops);
    });
}

fn request(text: &str) -> ClientRequest {
    ClientRequest {
        model: "echo".to_string(),
        messages: vec![ClientMessage {
            role: "user".to_string(),
            content: text.to_string(),
            tool_calls: vec![],
            tool_call_id: None,
        }],
        tools: vec![],
        max_tokens: 0,
        temperature: None,
        system: None,
    }
}

fn decode(bytes: &[u8]) -> Vec<(u8, String)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 5 <= bytes.len() {
        let kind = bytes[i];
        let len =
            u32::from_be_bytes([bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]]) as usize;
        out.push((
            kind,
            String::from_utf8_lossy(&bytes[i + 5..i + 5 + len]).into_owned(),
        ));
        i += 5 + len;
    }
    out
}

#[test]
fn locators_round_trip() {
    let key = ezcap::Keypair::generate().unwrap();
    let loc = format!(
        "iroh:{}?addr=127.0.0.1:4433&addr=192.168.1.2:4433",
        key.public()
    );
    let addr = parse_locator(&loc).expect("parses");
    assert_eq!(addr.id.as_bytes(), key.public().as_bytes());
    assert_eq!(addr.ip_addrs().count(), 2);
    assert!(parse_locator("http://x").is_err());
    assert!(parse_locator("iroh:notakey").is_err());
}

#[tokio::test]
async fn a_certificate_from_another_daemon_redeems_over_iroh_and_forwards_calls() {
    tokio::time::timeout(Duration::from_secs(90), async {
        // The owner's daemon: identity R, an echo model, serving over iroh.
        let r = ezcap::Keypair::generate().unwrap();
        let store_r = GrantStore::shared();
        store_r.lock().unwrap().set_identity(r.clone());
        let ep_r = Endpoint::builder(Minimal)
            .secret_key(iroh::SecretKey::from_bytes(&r.to_bytes()))
            .alpns(vec![IROH_ALPN.to_vec()])
            .bind()
            .await
            .expect("bind R");
        let locator = locator_of(&ep_r, &r.public());
        store_r.lock().unwrap().set_locator(locator.clone());
        let broker_r =
            BrokerProvider::new(store_r.clone(), Consent::AutoApprove, Pairings::shared());
        let inference_r = InferenceProvider::new(store_r.clone(), echo());
        let process_r = ProcessProvider::new(store_r.clone());
        let (complete_r, models_r) = inference_r.native_for_grants();
        let raw_r = Arc::new(Raw {
            grants: store_r.clone(),
            spawn: Some(process_r.native_for_grants()),
            terminal: None,
            watch: None,
            root: None,
            open_root: None,
            complete: Some(complete_r),
            models: Some(models_r),
        });
        serve(ep_r, broker_r, store_r.clone(), raw_r);

        // The recipient's daemon: identity L, no models of its own, reaches peers.
        let l = ezcap::Keypair::generate().unwrap();
        let store_l = GrantStore::shared();
        store_l.lock().unwrap().set_identity(l.clone());
        let ep_l = Endpoint::builder(Minimal)
            .secret_key(iroh::SecretKey::from_bytes(&l.to_bytes()))
            .bind()
            .await
            .expect("bind L");
        let remotes = Remotes::new(ep_l);
        let broker_l =
            BrokerProvider::new(store_l.clone(), Consent::AutoApprove, Pairings::shared())
                .with_remote(Arc::new(remotes.clone()));
        let inference_l =
            InferenceProvider::new(store_l.clone(), Arc::new(Providers::new(vec![], None)))
                .with_remotes(remotes.clone());
        let process_l = ProcessProvider::new(store_l.clone()).with_remotes(remotes);
        // What L's shipped components would call: the raw layer's natives.
        let (complete_l, models_l) = inference_l.native_for_grants();
        let spawn_l = process_l.native_for_grants();

        // The owner shares: a grant on R, certified for L's identity.
        let source = store_r.lock().unwrap().issue(
            CapabilityKind::Inference(InferenceRequest {
                models: vec!["echo".into()],
            }),
            "inference (echo)".into(),
            Duration::from_secs(600),
            anonymous_principal(),
        );
        let for_l = store_r
            .lock()
            .unwrap()
            .certify(
                &source,
                ezcap::Audience::Peer(l.public()),
                Duration::from_secs(300),
                ezcap::Narrowing::allow("state.tokens < 100"),
            )
            .unwrap();
        let for_other = store_r
            .lock()
            .unwrap()
            .certify(
                &source,
                ezcap::Audience::Peer(ezcap::Keypair::generate().unwrap().public()),
                Duration::from_secs(300),
                ezcap::Narrowing::default(),
            )
            .unwrap();

        // Without a peer transport, redeem-at is unsupported.
        let plain = BrokerProvider::new(
            GrantStore::shared(),
            Consent::AutoApprove,
            Pairings::shared(),
        );
        let refused = plain
            .redeem_at(ReqCtx::default(), locator.clone(), for_l.clone())
            .await
            .unwrap();
        assert!(
            matches!(refused, Err(Denied::Unsupported(_))),
            "{refused:?}"
        );

        // The wrong audience is refused by R; L's own redeems.
        let refused = broker_l
            .redeem_at(ReqCtx::default(), locator.clone(), for_other)
            .await
            .unwrap();
        assert!(matches!(refused, Err(Denied::NotAuthorized)), "{refused:?}");
        let proxied = broker_l
            .redeem_at(ReqCtx::default(), locator.clone(), for_l)
            .await
            .unwrap()
            .expect("redeemed at R")
            .token;
        // L holds a grant of its own that names the remote.
        let (kind, scope, _, summary) = store_l.lock().unwrap().inspect(&proxied).unwrap();
        assert!(matches!(kind, CapabilityKind::Inference(_)));
        assert_eq!(scope.allow, "state.tokens < 100");
        assert!(summary.contains(&locator), "{summary}");

        // Calls on it reach R's echo model, through R's shipped inference
        // component: a session is opened there with the grant R issued to L.
        let listed = models_l(proxied.clone()).await.expect("models");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].model, "echo");
        let stream = complete_l(proxied.clone(), request("hello there"))
            .await
            .expect("admitted");
        let chunks: Vec<Bytes> = stream.collect().await;
        let frames = decode(&chunks.concat());
        assert_eq!(frames[0], (0, "hello ".to_string()));
        assert_eq!(frames[1], (0, "there".to_string()));
        assert_eq!(frames[2].0, 1);
        // Usage is charged at both ends: R's source grant and L's proxy.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(store_l.lock().unwrap().counter(&proxied, "tokens"), Some(4));
        // R charged the grant it issued to L (the source's child), so its own
        // budget clauses see the spend too.
        let r_children: i64 = {
            let r = store_r.lock().unwrap();
            r.active_grants()
                .iter()
                .filter(|g| g.id != source)
                .filter_map(|g| r.counter(&g.id, "tokens"))
                .sum()
        };
        assert_eq!(r_children, 4);

        // A program pinned by a grant on R runs on R, its stdio forwarded: `cat`.
        let cat = store_r.lock().unwrap().issue(
            CapabilityKind::Process(ProcessRequest {
                image: "cat".into(),
                args: vec![],
                guest_chooses_argv: false,
            }),
            "process (cat)".into(),
            Duration::from_secs(600),
            anonymous_principal(),
        );
        let cat_cert = store_r
            .lock()
            .unwrap()
            .certify(
                &cat,
                ezcap::Audience::Peer(l.public()),
                Duration::from_secs(300),
                ezcap::Narrowing::default(),
            )
            .unwrap();
        let cat_l = broker_l
            .redeem_at(ReqCtx::default(), locator.clone(), cat_cert)
            .await
            .unwrap()
            .expect("cat redeemed")
            .token;
        let stdin = futures::stream::iter(vec![
            Bytes::from_static(b"over "),
            Bytes::from_static(b"iroh\n"),
        ]);
        let stdout = spawn_l(cat_l, vec![], Box::pin(stdin))
            .await
            .expect("spawned at R");
        let echoed: Vec<Bytes> = stdout.collect().await;
        assert_eq!(String::from_utf8_lossy(&echoed.concat()), "over iroh\n");

        // Revoking the source at R voids the proxy's calls.
        assert!(store_r.lock().unwrap().revoke(&source));
        let dead = complete_l(proxied, request("again")).await;
        let refused = match dead {
            Err(e) => e,
            Ok(stream) => {
                let chunks: Vec<Bytes> = stream.collect().await;
                decode(&chunks.concat())
                    .into_iter()
                    .find(|(k, _)| *k == 2)
                    .map(|(_, e)| e)
                    .expect("an error frame")
            }
        };
        assert!(
            refused.contains("denied") || refused.contains("revoked"),
            "{refused}"
        );
    })
    .await
    .expect("test timed out");
}

/// A component another daemon holds is fetched by hash over the peer path,
/// through its `components` interface, and lands with that daemon as its
/// provenance. Bytes that do not hash as asked are refused.
#[tokio::test]
async fn a_component_is_fetched_from_a_peer_by_hash() {
    use futures::FutureExt as _;

    tokio::time::timeout(Duration::from_secs(60), async {
        let greeter = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/greeter.wasm"
        ))
        .expect("greeter.wasm fixture");
        // R: a store with the greeter, served over iroh.
        let r = ezcap::Keypair::generate().unwrap();
        let ep_r = Endpoint::builder(Minimal)
            .secret_key(iroh::SecretKey::from_bytes(&r.to_bytes()))
            .alpns(vec![IROH_ALPN.to_vec()])
            .bind()
            .await
            .expect("bind R");
        let locator = locator_of(&ep_r, &r.public());
        let dir = tempfile::tempdir().unwrap();
        let store_r = Arc::new(crate::components::ComponentStore::new(
            dir.path().join("components"),
            None,
        ));
        let info = store_r.add(&greeter, None).await.expect("stored at R");
        let provider = crate::components::ComponentsProvider::new(Arc::clone(&store_r));
        tokio::spawn(async move {
            let srv = Arc::new(wrpc_transport_iroh::Server::<ReqCtx>::new());
            let accept = tokio::spawn(accept_iroh::<()>(ep_r, Arc::clone(&srv), Handles::new()));
            let c = crate::components::bindings::serve(srv.as_ref(), provider)
                .await
                .expect("serve components");
            let mut invs = futures::stream::select_all(
                c.into_iter()
                    .map(|(_, _, s)| s.map(|r| r.map(|f| f.boxed())).boxed()),
            );
            while let Some(res) = invs.next().await {
                if let Ok(fut) = res {
                    tokio::spawn(async move {
                        let _ = fut.await;
                    });
                }
            }
            accept.abort();
        });

        // L: reaches peers, holds nothing.
        let l = ezcap::Keypair::generate().unwrap();
        let ep_l = Endpoint::builder(Minimal)
            .secret_key(iroh::SecretKey::from_bytes(&l.to_bytes()))
            .bind()
            .await
            .expect("bind L");
        let fetcher = crate::fetch::Fetcher::new(
            Some(Remotes::new(ep_l)),
            crate::fetch::Credentials::shared(),
        );
        let source = crate::fetch::ComponentSource::parse(&format!("{locator}#{}", info.hash))
            .expect("a peer source");
        let (bytes, provenance) = fetcher.fetch(&source).await.expect("fetched from R");
        assert_eq!(bytes, greeter);
        assert_eq!(provenance.source, locator);
        assert_eq!(provenance.revision.as_deref(), Some(info.hash.as_str()));

        // A hash R does not hold is refused, as is one whose bytes would not match.
        let missing = format!("{locator}#sha256:{}", "00".repeat(32));
        let err = fetcher
            .fetch(&crate::fetch::ComponentSource::parse(&missing).unwrap())
            .await
            .expect_err("refused");
        assert!(format!("{err:#}").contains("no component"), "{err:#}");
    })
    .await
    .expect("test timed out");
}
