//! Scoped grants end to end: `request-scoped` type-checks a scope at grant
//! time, native handlers admit calls through the grant's membrane, `narrow`
//! only ever conjoins, and revoking a parent takes its children with it.

use crate::broker::bindings::exports::icanhaz::nocap::broker::Handler as _;
use crate::broker::bindings::ezco::ezcap::types::Scope as ScopeWire;
use crate::broker::bindings::icanhaz::nocap::types::{
    Denied, FsRequest, FsRights, PathGrant, SocketRequest,
};
use crate::broker::{
    AdmitCall, BrokerProvider, CapabilityKind, Consent, GrantStore, Pairings, ProcessRequest,
};
use crate::ReqCtx;

fn scope(allow: &str) -> ScopeWire {
    ScopeWire {
        when: "true".to_string(),
        allow: allow.to_string(),
    }
}

fn echo_want() -> CapabilityKind {
    CapabilityKind::Process(ProcessRequest {
        image: "echo".to_string(),
        args: vec![],
        guest_chooses_argv: true,
    })
}

fn fs_want() -> CapabilityKind {
    CapabilityKind::Filesystem(FsRequest {
        roots: vec![PathGrant {
            path: "/jail".to_string(),
            rights: FsRights::READ | FsRights::WRITE,
        }],
    })
}

async fn provider() -> (BrokerProvider, std::sync::Arc<std::sync::Mutex<GrantStore>>) {
    let store = GrantStore::shared();
    let provider = BrokerProvider::new(store.clone(), Consent::AutoApprove, Pairings::shared());
    (provider, store)
}

async fn grant(
    provider: &BrokerProvider,
    want: CapabilityKind,
    allow: &str,
) -> Result<String, Denied> {
    provider
        .request_scoped(
            ReqCtx::default(),
            want,
            scope(allow),
            "test".to_string(),
            None,
        )
        .await
        .expect("wrpc ok")
        .map(|g| g.token)
}

#[tokio::test]
async fn scoped_process_grant_admits_matching_argv_and_denies_otherwise() {
    let (provider, store) = provider().await;
    let token = grant(&provider, echo_want(), r#""hello" in call.args.args"#)
        .await
        .expect("scope compiles");

    let ok = AdmitCall::new("spawn").arg("args", vec!["hello".to_string()]);
    assert!((store.lock().unwrap().admit(&token, ok)).is_ok());

    let bad = AdmitCall::new("spawn").arg("args", vec!["rm".to_string(), "-rf".to_string()]);
    match store.lock().unwrap().admit(&token, bad) {
        Err(Denied::OutOfScope(sentences)) => {
            assert!(sentences.contains("call.args.args"), "{sentences}")
        }
        other => panic!("expected out-of-scope, got {other:?}"),
    }

    // The audit summary carries the scope.
    let infos = provider.granted(ReqCtx::default()).await.expect("wrpc ok");
    assert!(
        infos.iter().any(|i| i.summary.contains("allow:")),
        "{infos:?}"
    );
}

#[tokio::test]
async fn scope_is_type_checked_at_grant_time() {
    let (provider, store) = provider().await;
    match grant(&provider, echo_want(), "call.args.nope == 1").await {
        Err(Denied::InvalidScope(msg)) => assert!(!msg.is_empty()),
        other => panic!("expected invalid-scope, got {other:?}"),
    }
    // A plain `request` is the unrestricted scope and always works.
    let g = provider
        .request(ReqCtx::default(), echo_want(), "test".to_string(), None)
        .await
        .expect("wrpc ok")
        .expect("granted");
    assert!((store.lock().unwrap().admit(
        &g.token,
        AdmitCall::new("spawn").arg("args", Vec::<String>::new())
    ))
    .is_ok());
}

#[tokio::test]
async fn narrow_conjoins_and_parent_revoke_cascades() {
    let (provider, store) = provider().await;
    let parent = grant(&provider, echo_want(), "true")
        .await
        .expect("granted");
    let child = provider
        .narrow(
            ReqCtx::default(),
            parent.clone(),
            scope(r#""hello" in call.args.args"#),
        )
        .await
        .expect("wrpc ok")
        .expect("narrowed")
        .token;

    let hello = || AdmitCall::new("spawn").arg("args", vec!["hello".to_string()]);
    let other = || AdmitCall::new("spawn").arg("args", vec!["other".to_string()]);
    assert!((store.lock().unwrap().admit(&child, hello())).is_ok());
    assert!(store.lock().unwrap().admit(&child, other()).is_err());
    // The parent is untouched by the child's narrowing.
    assert!((store.lock().unwrap().admit(&parent, other())).is_ok());

    // A child can only narrow further, never widen: `narrow` with `true` is a no-op
    // clone, and the widened clause still sits under the parent's conjunction.
    let grandchild = provider
        .narrow(ReqCtx::default(), child.clone(), scope("true"))
        .await
        .expect("wrpc ok")
        .expect("narrowed")
        .token;
    assert!(store.lock().unwrap().admit(&grandchild, other()).is_err());

    provider
        .revoke(ReqCtx::default(), parent.clone())
        .await
        .expect("wrpc ok");
    assert!(store.lock().unwrap().admit(&child, hello()).is_err());
    assert!(store.lock().unwrap().admit(&grandchild, hello()).is_err());
    assert!(store.lock().unwrap().validate_process(&child).is_err());
}

#[tokio::test]
async fn filesystem_scope_covers_watch_and_workspace_calls() {
    let (provider, store) = provider().await;
    let token = grant(
        &provider,
        fs_want(),
        r#"call.method == "root-path" || call.args.recursive == false"#,
    )
    .await
    .expect("scope compiles against the filesystem union");

    let root = AdmitCall::new("root-path");
    assert!((store.lock().unwrap().admit(&token, root)).is_ok());
    let shallow = AdmitCall::new("open")
        .arg("path", "src")
        .arg("recursive", false);
    assert!((store.lock().unwrap().admit(&token, shallow)).is_ok());
    let deep = AdmitCall::new("open")
        .arg("path", "src")
        .arg("recursive", true);
    assert!(matches!(
        store.lock().unwrap().admit(&token, deep),
        Err(Denied::OutOfScope(_))
    ));
    // The grant-level check used by the fs gate passes for a `when` of `true`.
    assert!((store.lock().unwrap().admit_grant(&token)).is_ok());
}

#[tokio::test]
async fn kinds_without_an_environment_only_take_unrestricted_scopes() {
    let (provider, _) = provider().await;
    let sockets = CapabilityKind::Sockets(SocketRequest {
        allow: vec![],
        may_listen: false,
    });
    assert!(grant(&provider, sockets.clone(), "true").await.is_ok());
    assert!(matches!(
        grant(&provider, sockets, "call.method == \"x\"").await,
        Err(Denied::InvalidScope(_))
    ));
}

#[tokio::test]
async fn caller_origin_is_bound_from_the_transport() {
    let (provider, store) = provider().await;
    let cx = ReqCtx {
        origin: Some("https://notes.example".to_string()),
        peer: None,
    };
    let token = provider
        .request_scoped(
            cx,
            echo_want(),
            scope(r#"caller.origin == "https://notes.example""#),
            "test".to_string(),
            None,
        )
        .await
        .expect("wrpc ok")
        .expect("granted")
        .token;
    let from_origin = AdmitCall::new("spawn")
        .arg("args", Vec::<String>::new())
        .caller(crate::broker::caller_of(&ReqCtx {
            origin: Some("https://notes.example".to_string()),
            peer: None,
        }));
    assert!((store.lock().unwrap().admit(&token, from_origin)).is_ok());
    let anonymous = AdmitCall::new("spawn").arg("args", Vec::<String>::new());
    assert!(store.lock().unwrap().admit(&token, anonymous).is_err());
}

/// The consent surface sees the requested scope as sentences and may append
/// clauses; the broker conjoins them, so the human can only ever tighten.
#[tokio::test]
async fn surface_narrowing_conjoins_onto_the_requested_scope() {
    use crate::approve::{Approval, PendingConsent};
    use crate::broker::ScopeText;

    let store = GrantStore::shared();
    let pending = PendingConsent::with_notifier(|_| {});
    let provider = BrokerProvider::new(
        store.clone(),
        Consent::Surface(pending.clone()),
        Pairings::shared(),
    );

    // The human's side: wait for the request, read its sentences, append a
    // clause, approve.
    let surface = {
        let pending = pending.clone();
        let store = store.clone();
        tokio::spawn(async move {
            let req = loop {
                if let Some(r) = pending.list().pop() {
                    break r;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            };
            let text = ScopeText::of(&req.scope);
            assert!(text.when.is_empty());
            assert_eq!(text.allow.len(), 1, "{text:?}");
            // A bad clause is refused before it is applied; a good one renders.
            let extra = ezcap::Narrowing::allow("size(call.args.args) < 3");
            let bad = ezcap::Narrowing::allow("call.args.nope == 1");
            {
                let s = store.lock().unwrap();
                assert!(s.check_scope(&req.want, &req.scope.narrowed(&bad)).is_err());
                assert!(s.check_scope(&req.want, &req.scope.narrowed(&extra)).is_ok());
            }
            assert!(pending.resolve(
                &req.id,
                Some(Approval {
                    grant: None,
                    narrowing: Some(extra),
                    remember: false,
                    ttl_secs: 60,
                })
            ));
        })
    };

    let token = grant(&provider, echo_want(), r#""hello" in call.args.args"#)
        .await
        .expect("approved with a narrowing");
    surface.await.expect("surface task");

    let short = AdmitCall::new("spawn").arg("args", vec!["hello".to_string()]);
    assert!(store.lock().unwrap().admit(&token, short).is_ok());
    // Within the request's clause, outside the human's.
    let long = AdmitCall::new("spawn").arg(
        "args",
        vec!["hello".to_string(), "a".to_string(), "b".to_string()],
    );
    let outcome = store.lock().unwrap().admit(&token, long);
    match outcome {
        Err(Denied::OutOfScope(sentences)) => {
            assert!(sentences.contains("call.args.args"), "{sentences}")
        }
        other => panic!("expected out-of-scope, got {other:?}"),
    }
}

/// Certificates: a grant travels as a signed sturdy reference, redeemed by
/// its audience for a narrowed grant; wrong audience, tampering, expiry and
/// revocation of the source all refuse.
#[tokio::test]
async fn certificates_redeem_for_their_audience_only() {
    use crate::broker::bindings::exports::icanhaz::nocap::broker::Audience;

    let (provider, store) = provider().await;
    let token = grant(&provider, echo_want(), r#""hello" in call.args.args"#)
        .await
        .expect("granted");
    let notes = crate::ReqCtx {
        origin: Some("https://notes.example".to_string()),
        peer: None,
    };
    let other = crate::ReqCtx {
        origin: Some("https://evil.example".to_string()),
        peer: None,
    };

    // A clause that does not compile is refused at certify time.
    let bad = provider
        .certify(
            notes.clone(),
            token.clone(),
            Audience::Origin("https://notes.example".to_string()),
            60,
            scope("call.args.nope == 1"),
        )
        .await
        .expect("wrpc ok");
    assert!(matches!(bad, Err(Denied::InvalidScope(_))), "{bad:?}");

    let cert = provider
        .certify(
            notes.clone(),
            token.clone(),
            Audience::Origin("https://notes.example".to_string()),
            60,
            scope("size(call.args.args) < 3"),
        )
        .await
        .expect("wrpc ok")
        .expect("certified");
    assert!(cert.starts_with("ezcap1."));
    // Anyone can read the chain: it names the instance, not the bearer token.
    let parsed = ezcap::Certificate::decode(&cert).expect("decodes");
    assert_ne!(parsed.instance(), token);
    assert_eq!(
        parsed.issuer().to_string(),
        provider.identity(notes.clone()).await.expect("wrpc ok")
    );

    // The wrong origin, and no origin at all, are refused.
    let refused = provider
        .redeem(other.clone(), cert.clone())
        .await
        .expect("wrpc ok");
    assert!(matches!(refused, Err(Denied::NotAuthorized)), "{refused:?}");
    let refused = provider
        .redeem(ReqCtx::default(), cert.clone())
        .await
        .expect("wrpc ok");
    assert!(matches!(refused, Err(Denied::NotAuthorized)), "{refused:?}");

    // The audience redeems: a grant narrowed by the chain, bound to it.
    let redeemed = provider
        .redeem(notes.clone(), cert.clone())
        .await
        .expect("wrpc ok")
        .expect("redeemed")
        .token;
    let short = AdmitCall::new("spawn").arg("args", vec!["hello".to_string()]);
    assert!(store.lock().unwrap().admit(&redeemed, short).is_ok());
    let long = AdmitCall::new("spawn").arg(
        "args",
        vec!["hello".to_string(), "a".to_string(), "b".to_string()],
    );
    let outcome = store.lock().unwrap().admit(&redeemed, long);
    assert!(matches!(outcome, Err(Denied::OutOfScope(_))), "{outcome:?}");
    let infos = provider.granted(ReqCtx::default()).await.expect("wrpc ok");
    assert!(
        infos.iter().any(|i| i.holder.id == "https://notes.example"),
        "{infos:?}"
    );

    // A holder may append clauses offline; a tampered chain is refused.
    let holder = ezcap::Keypair::generate().expect("key");
    let tighter = parsed
        .attenuate(&holder, ezcap::Narrowing::allow("size(call.args.args) < 2"))
        .encode();
    let redeemed2 = provider
        .redeem(notes.clone(), tighter)
        .await
        .expect("wrpc ok")
        .expect("redeemed");
    let two = AdmitCall::new("spawn").arg("args", vec!["hello".to_string(), "x".to_string()]);
    let outcome = store.lock().unwrap().admit(&redeemed2.token, two);
    assert!(matches!(outcome, Err(Denied::OutOfScope(_))), "{outcome:?}");
    let mut tampered = cert.clone();
    tampered.replace_range(cert.len() - 4.., "AAAA");
    let refused = provider.redeem(notes.clone(), tampered).await.expect("wrpc ok");
    assert!(matches!(refused, Err(Denied::NotAuthorized)), "{refused:?}");

    // An expired certificate is `revoked`; so is one whose source was revoked.
    let expired = ezcap::Certificate::issue(
        &holder,
        parsed.instance(),
        ezcap::Audience::Any,
        1,
        ezcap::Narrowing::default(),
    )
    .encode();
    let refused = provider.redeem(notes.clone(), expired).await.expect("wrpc ok");
    // (Also the wrong issuer, but expiry is checked first.)
    assert!(matches!(refused, Err(Denied::Revoked)), "{refused:?}");
    provider.revoke(ReqCtx::default(), token).await.expect("wrpc ok");
    let refused = provider.redeem(notes, cert).await.expect("wrpc ok");
    assert!(matches!(refused, Err(Denied::Revoked)), "{refused:?}");
}
