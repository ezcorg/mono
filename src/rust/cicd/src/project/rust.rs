use crate::context::MonoContext;
use crate::error::MonoError;
use crate::project::{Project, ProjectKind, read_cargo_version, write_cargo_version};
use crate::types::{BuildTarget, ProjectId, Version};
use std::path::{Path, PathBuf};
use xshell::cmd;

impl RustProject {
    /// Path to the built binary for a given target (or native build if None).
    fn binary_path(&self, repo_root: &Path, target: Option<&BuildTarget>) -> Option<PathBuf> {
        let bin = self.bin_name.as_ref()?;
        let base = match target {
            Some(t) => repo_root.join("target").join(t.triple()).join("release"),
            None => repo_root.join("target/release"),
        };
        Some(base.join(bin))
    }
}

/// A Rust project built with Cargo.
pub struct RustProject {
    pub id: ProjectId,
    pub kind: ProjectKind,
    pub root: PathBuf,
    /// The Cargo package name (used with `--package`).
    pub package_name: String,
    /// The binary name, if this project produces a binary.
    pub bin_name: Option<String>,
    /// Release build targets.
    #[allow(dead_code)]
    pub build_targets: Vec<BuildTarget>,
    /// Git tag prefix (e.g., "witmproxy-v").
    pub tag_prefix: String,
}

impl Project for RustProject {
    fn id(&self) -> &ProjectId {
        &self.id
    }

    fn kind(&self) -> ProjectKind {
        self.kind
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

    fn bin_name(&self) -> Option<&str> {
        self.bin_name.as_deref()
    }

    fn build_targets(&self) -> &[BuildTarget] {
        &self.build_targets
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
        target: Option<&BuildTarget>,
    ) -> Result<(), MonoError> {
        let sh = ctx.shell.inner();
        let pkg = &self.package_name;

        let mut args: Vec<String> = vec!["build".into(), "--package".into(), pkg.clone()];

        if let Some(bin) = &self.bin_name {
            args.push("--bin".into());
            args.push(bin.clone());
        }

        if release {
            args.push("--release".into());
        }

        if let Some(t) = target {
            args.push("--target".into());
            args.push(t.triple().to_string());
        }

        let target_desc = target.map(|t| format!(" for {t}")).unwrap_or_default();
        let mode = if release { "release" } else { "debug" };
        eprintln!("building {pkg} ({mode}){target_desc}...");

        ctx.shell.run(&cmd!(sh, "cargo {args...}"))?;

        Ok(())
    }

    fn bump(&self, ctx: &MonoContext, version: &Version) -> Result<(), MonoError> {
        let cargo_toml = self.root.join("Cargo.toml");
        eprintln!("bumping {} to {version}...", self.package_name);
        write_cargo_version(&cargo_toml, version)?;

        // Update Cargo.lock by running cargo check
        let sh = ctx.shell.inner();
        let pkg = &self.package_name;
        ctx.shell.run(&cmd!(sh, "cargo check --package {pkg}"))?;

        Ok(())
    }

    fn publish(&self, ctx: &MonoContext) -> Result<(), MonoError> {
        let sh = ctx.shell.inner();
        let pkg = &self.package_name;

        // Check for token
        if std::env::var("CARGO_REGISTRY_TOKEN").is_err() {
            return Err(MonoError::MissingEnv(
                "CARGO_REGISTRY_TOKEN (required for cargo publish)".to_string(),
            ));
        }

        eprintln!("publishing {pkg} to crates.io...");
        ctx.shell
            .run_destructive(&cmd!(sh, "cargo publish --package {pkg}"))?;

        Ok(())
    }

    fn release_assets(
        &self,
        ctx: &MonoContext,
        target: Option<&BuildTarget>,
    ) -> Result<Vec<PathBuf>, MonoError> {
        let bin_path = match self.binary_path(&ctx.repo_root, target) {
            Some(p) => p,
            None => return Ok(vec![]),
        };

        if !bin_path.exists() {
            return Err(MonoError::Other(anyhow::anyhow!(
                "Built binary not found at {}",
                bin_path.display()
            )));
        }

        // Determine the platform-specific artifact name
        let bin = self.bin_name.as_ref().unwrap();
        let t = match target {
            Some(t) => *t,
            None => BuildTarget::current().ok_or_else(|| {
                MonoError::Other(anyhow::anyhow!(
                    "Cannot determine current platform. Pass --target explicitly."
                ))
            })?,
        };
        let artifact_name = t.artifact_name(bin);
        let artifact_path = bin_path.with_file_name(&artifact_name);

        eprintln!(
            "copying {} -> {}",
            bin_path.display(),
            artifact_path.display()
        );
        std::fs::copy(&bin_path, &artifact_path)?;

        Ok(vec![artifact_path])
    }
}
