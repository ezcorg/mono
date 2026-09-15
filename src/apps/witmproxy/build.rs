// A build script's only way to fail the build is to panic; the workspace's
// production-code lints do not apply to it.
#![allow(clippy::panic)]

fn main() {
    // Capture git commit hash at compile time
    if let Ok(output) = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        && output.status.success()
    {
        let hash = String::from_utf8_lossy(&output.stdout);
        println!("cargo:rustc-env=GIT_COMMIT_HASH={}", hash.trim());
    }

    // Capture build timestamp
    if let Ok(output) = std::process::Command::new("date")
        .args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .output()
        && output.status.success()
    {
        let date = String::from_utf8_lossy(&output.stdout);
        println!("cargo:rustc-env=BUILD_TIMESTAMP={}", date.trim());
    }

    ezcap_envs();

    // Rerun when git HEAD changes
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/refs");
}

/// Generate the `ezco:ezcap` CEL environments for the four provider resources
/// from `./wit` and embed them (`OUT_DIR/ezcap-envs.json`), keyed by the
/// capability-kind tag (`logger`, `annotator`, `local_storage`, `clock`). A
/// scope clause is type-checked against these at registration time.
fn ezcap_envs() {
    let wit = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("wit");
    println!("cargo:rerun-if-changed={}", wit.display());
    let mut resolve = wit_parser::Resolve::default();
    if let Err(e) = resolve.push_dir(&wit) {
        panic!("ezcap: resolving {}: {e:#}", wit.display());
    }
    let env = |kind: &str| match ezcap::CallEnv::for_kind(&resolve, &ezcap::Kind::new(kind)) {
        Ok(e) => e,
        Err(e) => panic!("ezcap: environment for `{kind}`: {e}"),
    };
    let envs: Vec<(String, ezcap::CallEnv)> = vec![
        (
            "logger".to_string(),
            env("witmproxy:plugin/capabilities.logger"),
        ),
        (
            "annotator".to_string(),
            env("witmproxy:plugin/capabilities.annotator-client"),
        ),
        (
            "local_storage".to_string(),
            env("witmproxy:plugin/capabilities.local-storage-client"),
        ),
        (
            "clock".to_string(),
            env("witmproxy:plugin/capabilities.clock-client"),
        ),
    ];
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap_or_default())
        .join("ezcap-envs.json");
    let json = serde_json::to_string(&envs).unwrap_or_else(|e| panic!("ezcap: serialising: {e}"));
    if let Err(e) = std::fs::write(&out, json) {
        panic!("ezcap: writing {}: {e}", out.display());
    }
}
