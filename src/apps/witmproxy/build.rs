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

    // Rerun when git HEAD changes
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/refs");
}
