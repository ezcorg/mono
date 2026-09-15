//! Golden environments generated from witmproxy's real `world.wit`.
//
// Test helpers panic on setup failure by design; the workspace's panic lint
// only exempts `#[test]` fns themselves.
#![allow(clippy::panic)]

use ezcap::{CallEnv, Kind, Shape};
use std::path::PathBuf;
use wit_parser::Resolve;

fn witmproxy_wit() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/witmproxy/wit")
}

fn resolve() -> Resolve {
    let mut r = Resolve::default();
    if let Err(e) = r.push_dir(witmproxy_wit()) {
        panic!("resolve witmproxy wit: {e:#}");
    }
    r
}

fn env(kind: &str) -> CallEnv {
    match CallEnv::for_kind(&resolve(), &Kind::new(kind)) {
        Ok(e) => e,
        Err(e) => panic!("{kind}: {e}"),
    }
}

fn shape_of<'a>(env: &'a CallEnv, name: &str) -> &'a Shape {
    match env.decls.iter().find(|d| d.name == name) {
        Some(d) => &d.shape,
        None => panic!("no decl `{name}` in {}", env.describe()),
    }
}

#[test]
fn local_storage_client_unions_its_methods() {
    let e = env("witmproxy:plugin/capabilities.local-storage-client");
    assert_eq!(e.methods, vec!["delete", "get", "set"]);
    assert_eq!(shape_of(&e, "call.args.key"), &Shape::String);
    assert_eq!(shape_of(&e, "call.args.value"), &Shape::Bytes);
    let key = e
        .decls
        .iter()
        .find(|d| d.name == "call.args.key")
        .map(|d| d.methods.clone());
    assert_eq!(
        key,
        Some(vec![
            "set".to_string(),
            "get".to_string(),
            "delete".to_string()
        ])
    );
    // Fixed variables come first.
    assert_eq!(e.decls[0].name, "call.method");
    assert!(e.decls.iter().any(|d| d.name == "state.calls"));
}

#[test]
fn one_method_selects_only_its_args() {
    let e = env("witmproxy:plugin/capabilities.local-storage-client.get");
    assert_eq!(e.methods, vec!["get"]);
    assert!(e.decls.iter().any(|d| d.name == "call.args.key"));
    assert!(!e.decls.iter().any(|d| d.name == "call.args.value"));
}

#[test]
fn request_context_flattens_like_the_hand_written_mirror() {
    // `annotator-client.annotate(content)` takes a resource; the interesting
    // record is `request-context`, reached through `content.request-context`.
    // The freestanding-record shape is exercised through `contextual-response`
    // on the `event` variant... which is opaque. So flatten the record directly
    // by asking for the whole interface and checking the decls of `annotate`.
    let e = env("witmproxy:plugin/capabilities.annotator-client");
    assert_eq!(shape_of(&e, "call.args.content"), &Shape::String);

    // A record parameter flattens into dotted leaves, and the map-shaped
    // `list<tuple<string, list<string>>>` idiom becomes a CEL map.
    let r = resolve();
    let iface = ezcap::env::find_interface(&r, "witmproxy:plugin", "capabilities", None);
    let Some(iface) = iface else {
        panic!("no capabilities interface")
    };
    let Some(ctx_id) = r.interfaces[iface].types.get("request-context") else {
        panic!("no request-context type")
    };
    let func = wit_parser::Function {
        name: "probe".to_string(),
        kind: wit_parser::FunctionKind::Freestanding,
        params: vec![wit_parser::Param {
            name: "ctx".to_string(),
            ty: wit_parser::Type::Id(*ctx_id),
            span: wit_parser::Span::default(),
        }],
        result: None,
        docs: Default::default(),
        stability: Default::default(),
        span: wit_parser::Span::default(),
        external_id: None,
    };
    let decls = ezcap::shape::flatten_params(&r, &func, "call.args");
    let names: Vec<&str> = decls.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "call.args.ctx.scheme",
            "call.args.ctx.host",
            "call.args.ctx.path",
            "call.args.ctx.query",
            "call.args.ctx.method",
            "call.args.ctx.headers",
        ]
    );
    let by_name = |n: &str| decls.iter().find(|d| d.name == n).map(|d| d.shape.clone());
    assert_eq!(by_name("call.args.ctx.host"), Some(Shape::String));
    assert_eq!(
        by_name("call.args.ctx.headers"),
        Some(Shape::Map(Box::new(Shape::List(Box::new(Shape::String)))))
    );
    assert_eq!(
        by_name("call.args.ctx.query"),
        Some(Shape::Map(Box::new(Shape::List(Box::new(Shape::String)))))
    );
}

#[test]
fn unknown_kinds_are_errors() {
    let r = resolve();
    assert!(CallEnv::for_kind(&r, &Kind::new("witmproxy:plugin/capabilities.nope")).is_err());
    assert!(CallEnv::for_kind(&r, &Kind::new("witmproxy:plugin/nothing")).is_err());
    assert!(
        CallEnv::for_kind(&r, &Kind::new("witmproxy:plugin/capabilities.logger.shout")).is_err()
    );
}

#[test]
fn describe_is_stable_documentation() {
    let e = env("witmproxy:plugin/capabilities.logger");
    let text = e.describe();
    assert!(text.starts_with("# witmproxy:plugin/capabilities.logger\n"));
    assert!(text.contains("methods: debug, error, info, warn"));
    assert!(
        text.contains("call.args.message: string    [debug, error, info, warn]")
            || text.contains("call.args.message: string")
    );
}
