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
/// from `./wit` and embed them, keyed by the capability-kind tag (`logger`,
/// `annotator`, `local_storage`, `clock`). A scope clause is type-checked
/// against these at registration time.
fn ezcap_envs() {
    let wit = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("wit");
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap_or_default())
        .join("ezcap-envs.json");
    ezcap::build::write_envs(
        &wit,
        &out,
        &[
            ("logger", &["witmproxy:plugin/capabilities.logger"]),
            (
                "annotator",
                &["witmproxy:plugin/capabilities.annotator-client"],
            ),
            (
                "local_storage",
                &["witmproxy:plugin/capabilities.local-storage-client"],
            ),
            ("clock", &["witmproxy:plugin/capabilities.clock-client"]),
        ],
    );
}
