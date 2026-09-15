//! The membrane end to end: dotted declarations type-check, admission binds
//! and evaluates, narrowing never widens, unbound variables deny, counters
//! advance only on admission, revocation cascades.
//
// Test helpers panic on setup failure by design; the workspace's panic lint
// only exempts `#[test]` fns themselves.
#![allow(clippy::panic)]

use ezcap::{Call, CallEnv, Caller, Capability, CapabilityError, Kind, Membrane, Narrowing, Scope};
use std::path::PathBuf;
use wit_parser::Resolve;

fn local_storage() -> Membrane {
    let mut r = Resolve::default();
    let wit = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/witmproxy/wit");
    if let Err(e) = r.push_dir(wit) {
        panic!("resolve: {e:#}");
    }
    let kind = Kind::new("witmproxy:plugin/capabilities.local-storage-client");
    let env = match CallEnv::for_kind(&r, &kind) {
        Ok(e) => e,
        Err(e) => panic!("env: {e}"),
    };
    match Membrane::new(env, &["tokens"]) {
        Ok(m) => m,
        Err(e) => panic!("membrane: {e}"),
    }
}

fn cap(allow: &str) -> Capability {
    Capability::new(
        "witmproxy:plugin/capabilities.local-storage-client",
        Scope::allow(allow),
    )
}

fn mint(m: &mut Membrane, allow: &str) -> ezcap::InstanceId {
    match m.mint(&cap(allow)) {
        Ok(id) => id,
        Err(e) => panic!("mint `{allow}`: {e}"),
    }
}

#[test]
fn dotted_variables_type_check_at_load_time() {
    let m = local_storage();
    assert!(
        m.check(&Scope::allow(r#"call.args.key.startsWith("seen/")"#))
            .is_ok()
    );
    assert!(
        m.check(&Scope::allow(
            r#"call.method == "get" || size(call.args.value) < 1024"#
        ))
        .is_ok()
    );
    // An argument the interface does not have.
    let err = m
        .check(&Scope::allow("call.args.ttl > 0"))
        .err()
        .map(|e| e.to_string());
    assert!(err.is_some(), "expected a compile error");
    // A type error: string compared with int.
    assert!(m.check(&Scope::allow("call.args.key > 3")).is_err());
    // `when` is checked too.
    assert!(
        m.check(&Scope {
            when: "nonsense(".into(),
            allow: "true".into()
        })
        .is_err()
    );
}

#[test]
fn admission_binds_arguments_and_denies_with_a_sentence() {
    let mut m = local_storage();
    let id = mint(&mut m, r#"call.args.key.startsWith("seen/")"#);

    let ok = Call::new("set")
        .arg("key", "seen/abc")
        .arg("value", vec![1u8, 2, 3])
        .bytes(3);
    assert_eq!(m.admit(&id, &ok), Ok(()));

    let bad = Call::new("set")
        .arg("key", "other/abc")
        .arg("value", Vec::<u8>::new());
    assert_eq!(
        m.admit(&id, &bad),
        Err(CapabilityError::Denied(
            "key starts with “seen/”".to_string()
        ))
    );

    // Counters advanced once, for the admitted call only.
    let inst = m.get(&id).map(|i| (i.counter("calls"), i.counter("bytes")));
    assert_eq!(inst, Some((1, 3)));
}

#[test]
fn unrestricted_scope_is_a_plain_grant() {
    let mut m = local_storage();
    let id = match m.mint(&Capability::new(
        "witmproxy:plugin/capabilities.local-storage-client",
        Scope::unrestricted(),
    )) {
        Ok(id) => id,
        Err(e) => panic!("{e}"),
    };
    assert_eq!(
        m.admit(&id, &Call::new("delete").arg("key", "anything")),
        Ok(())
    );
}

#[test]
fn narrowing_never_widens() {
    let mut m = local_storage();
    let parent = mint(&mut m, r#"call.args.key.startsWith("seen/")"#);
    let child = match m.narrow(&parent, &Narrowing::allow("size(call.args.key) < 12")) {
        Ok(id) => id,
        Err(e) => panic!("narrow: {e}"),
    };
    let scope = m.get(&child).map(|i| i.scope.allow.clone());
    assert_eq!(
        scope.as_deref(),
        Some(r#"(call.args.key.startsWith("seen/")) && (size(call.args.key) < 12)"#)
    );

    let keys = [
        "seen/a",
        "seen/abcdefghijklmnop",
        "other/a",
        "",
        "seen/",
        "unseen/short",
    ];
    for key in keys {
        let call = Call::new("get").arg("key", key);
        let child_ok = m.admit(&child, &call).is_ok();
        let parent_ok = m.admit(&parent, &call).is_ok();
        assert!(
            !child_ok || parent_ok,
            "child admitted `{key}` but parent did not"
        );
    }
    // And the child is genuinely narrower somewhere.
    let long = Call::new("get").arg("key", "seen/abcdefghijklmnop");
    assert!(m.admit(&parent, &long).is_ok());
    assert!(m.admit(&child, &long).is_err());
}

#[test]
fn absent_caller_fields_fail_closed() {
    let mut m = local_storage();
    let id = mint(&mut m, r#"caller.plugin == "@ezco/noshorts""#);
    let anonymous = Call::new("get").arg("key", "k");
    assert!(matches!(
        m.admit(&id, &anonymous),
        Err(CapabilityError::Denied(_))
    ));

    let named = Call::new("get").arg("key", "k").caller(Caller {
        plugin: Some("@ezco/noshorts".to_string()),
        ..Default::default()
    });
    assert_eq!(m.admit(&id, &named), Ok(()));

    let other = Call::new("get").arg("key", "k").caller(Caller {
        plugin: Some("@someone/else".to_string()),
        ..Default::default()
    });
    assert!(m.admit(&id, &other).is_err());
}

#[test]
fn state_counters_and_host_charges_are_visible_to_clauses() {
    let mut m = local_storage();
    let id = mint(&mut m, "state.calls < 2 && state.tokens <= 10");
    let call = Call::new("get").arg("key", "k");
    assert!(m.admit(&id, &call).is_ok());
    assert!(m.admit(&id, &call).is_ok());
    assert!(
        m.admit(&id, &call).is_err(),
        "third call exceeds state.calls < 2"
    );

    let id2 = mint(&mut m, "state.tokens + 5 <= 10");
    assert!(m.admit(&id2, &call).is_ok());
    m.charge(&id2, "tokens", 6);
    assert!(m.admit(&id2, &call).is_err(), "budget exhausted");
}

#[test]
fn method_specific_clauses_short_circuit_across_methods() {
    let mut m = local_storage();
    // `value` is only bound on `set`; CEL's absorbing `||` keeps `get` admitted.
    let id = mint(
        &mut m,
        r#"call.method != "set" || size(call.args.value) <= 2"#,
    );
    assert!(m.admit(&id, &Call::new("get").arg("key", "k")).is_ok());
    assert!(
        m.admit(
            &id,
            &Call::new("set").arg("key", "k").arg("value", vec![1u8, 2])
        )
        .is_ok()
    );
    assert!(
        m.admit(
            &id,
            &Call::new("set")
                .arg("key", "k")
                .arg("value", vec![1u8, 2, 3])
        )
        .is_err()
    );
}

#[test]
fn revocation_cascades_to_children() {
    let mut m = local_storage();
    let parent = mint(&mut m, "true");
    let child = match m.narrow(&parent, &Narrowing::allow("true")) {
        Ok(id) => id,
        Err(e) => panic!("{e}"),
    };
    let call = Call::new("get").arg("key", "k");
    assert!(m.admit(&child, &call).is_ok());
    m.revoke(&parent);
    assert_eq!(m.admit(&child, &call), Err(CapabilityError::Unavailable));
    assert_eq!(m.admit(&parent, &call), Err(CapabilityError::Unavailable));
}

#[test]
fn kind_mismatch_is_refused_at_mint() {
    let mut m = local_storage();
    let other = Capability::new(
        "witmproxy:plugin/capabilities.logger",
        Scope::unrestricted(),
    );
    assert!(m.mint(&other).is_err());
}
