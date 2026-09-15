//! Build-script support: generate a host's CEL environments from its WIT and
//! write them where `include_str!` can embed them, so the daemon needs no WIT
//! on disk at runtime. Call from `build.rs`:
//!
//! ```ignore
//! ezcap::build::write_envs(
//!     &wit_dir,
//!     &out_dir.join("ezcap-envs.json"),
//!     &[
//!         ("process", &["icanhaz:nocap/process"]),
//!         ("filesystem", &["wasi:filesystem/types@0.2.0.descriptor", "icanhaz:nocap/watch"]),
//!     ],
//! );
//! ```
//!
//! Each entry is a tag and the kinds whose environments are unioned under it
//! (one kind is the common case). Failures panic, which is how a build script
//! fails a build; the message names the tag and kind.

// A build script reports failure by panicking and talks to cargo on stdout.
#![allow(clippy::panic, clippy::print_stdout)]

use std::path::Path;

use crate::env::CallEnv;
use crate::types::Kind;

/// Generate and write the environments; prints `cargo:rerun-if-changed` for
/// the WIT directory.
pub fn write_envs(wit_dir: &Path, out: &Path, tags: &[(&str, &[&str])]) {
    println!("cargo:rerun-if-changed={}", wit_dir.display());
    let mut resolve = wit_parser::Resolve::default();
    if let Err(e) = resolve.push_dir(wit_dir) {
        panic!("ezcap: resolving {}: {e:#}", wit_dir.display());
    }
    let envs: Vec<(String, CallEnv)> = tags
        .iter()
        .map(|(tag, kinds)| {
            let mut parts: Vec<CallEnv> = kinds
                .iter()
                .map(
                    |kind| match CallEnv::for_kind(&resolve, &Kind::new(*kind)) {
                        Ok(e) => e,
                        Err(e) => panic!("ezcap: environment for `{kind}` (tag `{tag}`): {e}"),
                    },
                )
                .collect();
            let env = if parts.len() == 1 {
                parts
                    .pop()
                    .unwrap_or_else(|| panic!("ezcap: tag `{tag}` names no kinds"))
            } else {
                match CallEnv::union(Kind::new(format!("union:{tag}")), parts) {
                    Ok(e) => e,
                    Err(e) => panic!("ezcap: union for tag `{tag}`: {e}"),
                }
            };
            (tag.to_string(), env)
        })
        .collect();
    let json = serde_json::to_string(&envs).unwrap_or_else(|e| panic!("ezcap: serialising: {e}"));
    if let Err(e) = std::fs::write(out, json) {
        panic!("ezcap: writing {}: {e}", out.display());
    }
}
