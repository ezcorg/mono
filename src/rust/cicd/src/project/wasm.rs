use crate::context::MonoContext;
use crate::error::MonoError;
use crate::project::{Project, ProjectKind, read_cargo_version, write_cargo_version};
use crate::types::{BuildTarget, ProjectId, Version};
use std::path::{Path, PathBuf};
use xshell::cmd;

/// A WASM component project built with `cargo build --target wasm32-wasip2`
/// and signed with wasmsign2.
pub struct WasmComponentProject {
    pub id: ProjectId,
    pub root: PathBuf,
    /// The Cargo package name (used with `--package`).
    pub package_name: String,
    /// Git tag prefix (e.g., "witmproxy-plugin-noshorts-v").
    pub tag_prefix: String,
}

impl WasmComponentProject {
    /// The crate name with hyphens replaced by underscores (cargo output convention).
    fn crate_file_name(&self) -> String {
        self.package_name.replace('-', "_")
    }

    /// Path to the unsigned WASM artifact after a release build.
    fn unsigned_wasm_path(&self, repo_root: &Path) -> PathBuf {
        repo_root
            .join("target/wasm32-wasip2/release")
            .join(format!("{}.wasm", self.crate_file_name()))
    }

    /// Path to the signed WASM artifact.
    fn signed_wasm_path(&self, repo_root: &Path) -> PathBuf {
        repo_root
            .join("target/wasm32-wasip2/release")
            .join(format!("{}.signed.wasm", self.crate_file_name()))
    }

    /// Path to the wasmsign2 secret key.
    fn secret_key_path(&self) -> PathBuf {
        self.root.join("key.secret")
    }
}

impl Project for WasmComponentProject {
    fn id(&self) -> &ProjectId {
        &self.id
    }

    fn kind(&self) -> ProjectKind {
        ProjectKind::WasmComponent
    }

    fn root(&self) -> &Path {
        &self.root
    }

    fn version(&self) -> Result<Version, MonoError> {
        read_cargo_version(&self.root.join("Cargo.toml"))
    }

    fn tag_prefix(&self) -> &str {
        &self.tag_prefix
    }

    fn build_targets(&self) -> &[BuildTarget] {
        &[] // WASM components are platform-independent
    }

    fn check(&self, ctx: &MonoContext) -> Result<(), MonoError> {
        let sh = ctx.shell.inner();
        let pkg = &self.package_name;

        eprintln!("checking formatting for {pkg}...");
        ctx.shell
            .run(&cmd!(sh, "cargo fmt --package {pkg} --check"))?;

        eprintln!("running clippy for {pkg}...");
        ctx.shell.run(&cmd!(
            sh,
            "cargo clippy --package {pkg} --all-targets -- -D warnings"
        ))?;

        Ok(())
    }

    fn test(&self, ctx: &MonoContext) -> Result<(), MonoError> {
        let sh = ctx.shell.inner();
        let pkg = &self.package_name;

        eprintln!("testing {pkg}...");
        ctx.shell
            .run(&cmd!(sh, "cargo test --package {pkg} --lib"))?;

        Ok(())
    }

    fn build(
        &self,
        ctx: &MonoContext,
        release: bool,
        _target: Option<&BuildTarget>,
    ) -> Result<(), MonoError> {
        let sh = ctx.shell.inner();
        let pkg = &self.package_name;
        let target = "wasm32-wasip2";

        let mode = if release { "release" } else { "debug" };
        eprintln!("building WASM component {pkg} ({mode})...");

        if release {
            ctx.shell.run(&cmd!(
                sh,
                "cargo build --package {pkg} --release --target {target}"
            ))?;
        } else {
            ctx.shell
                .run(&cmd!(sh, "cargo build --package {pkg} --target {target}"))?;
        }

        // Sign with wasmsign2 if building release and key exists
        if release && self.secret_key_path().exists() {
            let input = self.unsigned_wasm_path(&ctx.repo_root);
            let output = self.signed_wasm_path(&ctx.repo_root);
            let key = self.secret_key_path();
            eprintln!("signing WASM component with wasmsign2...");
            ctx.shell
                .run(&cmd!(sh, "wasmsign2 sign -i {input} -o {output} -k {key}"))?;
        }

        Ok(())
    }

    fn bump(&self, ctx: &MonoContext, version: &Version) -> Result<(), MonoError> {
        let cargo_toml = self.root.join("Cargo.toml");
        eprintln!("bumping {} to {version}...", self.package_name);
        write_cargo_version(&cargo_toml, version)?;

        // Update Cargo.lock
        let sh = ctx.shell.inner();
        let pkg = &self.package_name;
        ctx.shell.run(&cmd!(sh, "cargo check --package {pkg}"))?;

        Ok(())
    }

    fn publish(&self, _ctx: &MonoContext) -> Result<(), MonoError> {
        eprintln!(
            "WASM component '{}' is distributed via GitHub releases, not a package registry.",
            self.package_name
        );
        eprintln!("Use `mono gh-release` to create a release with the built .wasm artifact.");
        Ok(())
    }
}
