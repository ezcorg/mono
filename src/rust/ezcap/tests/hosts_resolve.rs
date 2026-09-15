//! Hosts carry `ezco:ezcap` under `wit/deps` (witmproxy commits its copy;
//! icanhaz fetches it with `wkg wit fetch`). Copies must stay byte-identical
//! to the crate's own package and resolve beside each host's world.

use std::path::PathBuf;
use wit_parser::Resolve;

fn mono(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(rel)
}

fn has_ezcap_types(dir: &str) -> bool {
    let mut r = Resolve::default();
    if let Err(e) = r.push_dir(mono(dir)) {
        // Test helpers panic on setup failure by design.
        #[allow(clippy::panic)]
        {
            panic!("resolve {dir}: {e:#}")
        }
    }
    ezcap::env::find_interface(&r, "ezco:ezcap", "types", Some("0.1.0")).is_some()
}

#[test]
fn witmproxy_vendors_the_crate_package_byte_for_byte() {
    let canonical = std::fs::read(mono("src/rust/ezcap/wit/ezcap.wit")).unwrap_or_default();
    let copy = std::fs::read(mono(
        "src/apps/witmproxy/wit/deps/ezco-ezcap-0.1.0/package.wit",
    ))
    .unwrap_or_default();
    assert!(!canonical.is_empty(), "crate package missing");
    assert!(
        copy == canonical,
        "witmproxy's vendored ezco:ezcap differs from the crate's wit/ezcap.wit"
    );
    assert!(has_ezcap_types("src/apps/witmproxy/wit"));
}

/// icanhaz's `wit/deps` is git-ignored and populated by `wkg wit fetch` through
/// the path override in its `wkg.toml`, so the copy only exists on a machine
/// that has run the fetch. When it does, it must match too.
#[test]
fn icanhaz_fetched_copy_matches_when_present() {
    let vendored = mono("src/apps/icanhaz/wit/deps/ezco-ezcap-0.1.0/package.wit");
    if !vendored.exists() {
        return;
    }
    let canonical = std::fs::read(mono("src/rust/ezcap/wit/ezcap.wit")).unwrap_or_default();
    let copy = std::fs::read(&vendored).unwrap_or_default();
    assert!(
        copy == canonical,
        "icanhaz's fetched ezco:ezcap differs from the crate's wit/ezcap.wit"
    );
    assert!(has_ezcap_types("src/apps/icanhaz/wit"));
}
