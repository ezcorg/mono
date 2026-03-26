use crate::env::Environment;
use crate::error::MonoError;
use crate::shell::MonoShell;
use std::path::{Path, PathBuf};

/// Shared context threaded through all commands.
pub struct MonoContext {
    pub repo_root: PathBuf,
    pub environment: Environment,
    pub shell: MonoShell,
}

impl MonoContext {
    pub fn new(dry_run: bool, verbose: bool) -> Result<Self, MonoError> {
        let repo_root = find_repo_root()?;
        let environment = Environment::detect();
        let shell = MonoShell::new(dry_run, verbose)?;
        shell.inner().change_dir(&repo_root);
        Ok(Self {
            repo_root,
            environment,
            shell,
        })
    }
}

/// Walk up from the current directory to find the repo root (contains Cargo.toml with [workspace]).
fn find_repo_root() -> Result<PathBuf, MonoError> {
    let cwd = std::env::current_dir()?;
    let mut dir = cwd.as_path();
    loop {
        let cargo_toml = dir.join("Cargo.toml");
        if cargo_toml.exists() {
            let contents = std::fs::read_to_string(&cargo_toml)?;
            if contents.contains("[workspace]") {
                return Ok(dir.to_path_buf());
            }
        }
        dir = dir
            .parent()
            .ok_or_else(|| MonoError::NoRepoRoot(cwd.clone()))?;
    }
}

/// Resolve a path relative to the repo root.
pub fn repo_path(ctx: &MonoContext, relative: impl AsRef<Path>) -> PathBuf {
    ctx.repo_root.join(relative)
}
