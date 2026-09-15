//! Generate the `ezco:ezcap` CEL environments for icanhaz's capability kinds
//! from `../wit` at build time and embed them as JSON, so the daemon type-checks
//! and evaluates scopes without any WIT on disk at runtime.
//!
//! One environment per grant *kind* (the `capability-kind` tag): a grant is
//! used through every interface its kind serves, so the environment is the
//! union of those interfaces. A conflict (same argument, different shape) fails
//! the build here rather than surprising anyone at consent time.

use ezcap::{CallEnv, Kind};
use std::path::PathBuf;

fn main() {
    let wit = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../wit");
    println!("cargo:rerun-if-changed={}", wit.display());

    let mut resolve = wit_parser::Resolve::default();
    if let Err(e) = resolve.push_dir(&wit) {
        panic!("ezcap: resolving {}: {e:#}", wit.display());
    }

    let env = |kind: &str| match CallEnv::for_kind(&resolve, &Kind::new(kind)) {
        Ok(e) => e,
        Err(e) => panic!("ezcap: environment for `{kind}`: {e}"),
    };
    let union = |tag: &str, parts: Vec<CallEnv>| match CallEnv::union(Kind::new(tag), parts) {
        Ok(e) => e,
        Err(e) => panic!("ezcap: union for `{tag}`: {e}"),
    };

    // Keyed by the grant kind tag used across the host (`kind_tag` in broker.rs).
    let envs: Vec<(String, CallEnv)> = vec![
        (
            "filesystem".to_string(),
            union(
                "icanhaz:nocap/filesystem",
                vec![
                    env("wasi:filesystem/types@0.2.0.descriptor"),
                    env("icanhaz:nocap/watch"),
                    env("icanhaz:nocap/workspace"),
                ],
            ),
        ),
        ("process".to_string(), env("icanhaz:nocap/process")),
        ("terminal".to_string(), env("icanhaz:nocap/terminal")),
    ];

    let out =
        PathBuf::from(std::env::var_os("OUT_DIR").unwrap_or_default()).join("ezcap-envs.json");
    let json = serde_json::to_string(&envs).unwrap_or_else(|e| panic!("ezcap: serialising: {e}"));
    if let Err(e) = std::fs::write(&out, json) {
        panic!("ezcap: writing {}: {e}", out.display());
    }
}
