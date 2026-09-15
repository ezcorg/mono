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
        }));
    assert!((store.lock().unwrap().admit(&token, from_origin)).is_ok());
    let anonymous = AdmitCall::new("spawn").arg("args", Vec::<String>::new());
    assert!(store.lock().unwrap().admit(&token, anonymous).is_err());
}
