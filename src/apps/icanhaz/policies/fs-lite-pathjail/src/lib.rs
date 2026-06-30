//! Walking-skeleton policy component — a **path jail** over the `fs-lite`
//! stand-in capability.
//!
//! Implements `world fs-lite-policy`: it imports the raw host `fs-lite` (the real
//! authority) plus a policy `context`, and exports a *mediated* `fs-lite` that
//! only permits paths under the grant's negotiated subtrees — the `only-paths`
//! caveats the host attached at grant time — writes every access to the audit
//! trail, and escalates to the human on a write outside them. This is the whole
//! point of icanhaz in miniature: the membrane is a wasm **component**
//! (capability as code), not a config flag — and it can only ever *narrow* the
//! authority it was handed. The jail is driven by the **grant's caveats**, not a
//! hard-coded subtree.

wit_bindgen::generate!({
    world: "fs-lite-policy",
    path: "../../wit",
    // The world pulls in wasi:clocks/wall-clock transitively (via the `caveat`
    // type); generate bindings for all deps rather than hand-mapping each.
    generate_all,
});

use exports::icanhaz::nocap::fs_lite::Guest;
// The raw host capability we delegate to, attenuated:
use icanhaz::nocap::fs_lite as raw;
// The policy context (principal / caveats / audit / escalate), bound by the host:
use icanhaz::nocap::policy;
// The caveat vocabulary — the grant's negotiated narrowing:
use icanhaz::nocap::types::Caveat;

struct Component;

/// The path prefixes this grant permits, taken from its `only-paths` caveats. No
/// caveat ⇒ no prefixes ⇒ nothing is permitted (fail-closed): a grant must say
/// what it covers.
fn allowed_prefixes(ctx: &policy::Context) -> Vec<String> {
    ctx.caveats()
        .into_iter()
        .flat_map(|c| match c {
            Caveat::OnlyPaths(paths) => paths,
            _ => Vec::new(),
        })
        .collect()
}

/// Confined to a granted prefix, with no `..` escape.
fn permitted(path: &str, prefixes: &[String]) -> bool {
    !path.split('/').any(|seg| seg == "..") && prefixes.iter().any(|p| path.starts_with(p.as_str()))
}

impl Guest for Component {
    fn read(path: String) -> Result<Vec<u8>, String> {
        let ctx = policy::get_context();
        ctx.audit(&format!("read {path}"));
        let prefixes = allowed_prefixes(&ctx);
        if !permitted(&path, &prefixes) {
            return Err(format!("denied: {path} is outside the granted paths {prefixes:?}"));
        }
        raw::read(&path)
    }

    fn write(path: String, data: Vec<u8>) -> Result<(), String> {
        let ctx = policy::get_context();
        ctx.audit(&format!("write {} ({} bytes)", path, data.len()));
        let prefixes = allowed_prefixes(&ctx);
        // A write outside the granted paths isn't a hard no — it's a runtime escalation.
        if !permitted(&path, &prefixes)
            && !ctx.escalate(&format!("allow write outside the granted paths to {path}?"))
        {
            return Err(format!("denied: write to {path} outside granted paths {prefixes:?}"));
        }
        raw::write(&path, &data)
    }

    fn read_dir(dir: String) -> Result<Vec<String>, String> {
        let ctx = policy::get_context();
        ctx.audit(&format!("read-dir {dir}"));
        let prefixes = allowed_prefixes(&ctx);
        if !permitted(&dir, &prefixes) {
            return Err(format!("denied: {dir} is outside the granted paths {prefixes:?}"));
        }
        raw::read_dir(&dir)
    }
}

export!(Component);
