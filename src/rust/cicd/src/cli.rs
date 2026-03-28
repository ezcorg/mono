use crate::types::{BuildTarget, ProjectId, Version};
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "mono")]
#[command(about = "CI/CD CLI for the mono repository")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,

    /// Perform a dry run (destructive operations are printed but not executed)
    #[arg(long, global = true)]
    pub dry_run: bool,

    /// Enable verbose output
    #[arg(short, long, global = true)]
    pub verbose: bool,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Run formatting and lint checks
    Check {
        /// Target project
        #[arg(short, long)]
        project: ProjectId,
    },

    /// Run tests
    Test {
        /// Target project
        #[arg(short, long)]
        project: ProjectId,
    },

    /// Build a project
    Build {
        /// Target project
        #[arg(short, long)]
        project: ProjectId,

        /// Build in release mode
        #[arg(long)]
        release: bool,

        /// Cross-compile for a specific target triple
        #[arg(long)]
        target: Option<BuildTarget>,
    },

    /// Update the project version
    Bump {
        /// Target project
        #[arg(short, long)]
        project: ProjectId,

        /// New version (semver)
        version: Version,
    },

    /// Create a git tag from the current project version
    Tag {
        /// Target project
        #[arg(short, long)]
        project: ProjectId,
    },

    /// Publish to a package registry (crates.io, npm, etc.)
    Publish {
        /// Target project
        #[arg(short, long)]
        project: ProjectId,
    },

    /// Create a GitHub release and optionally upload assets
    GhRelease {
        /// Target project
        #[arg(short, long)]
        project: ProjectId,

        /// Binary assets to upload to the release
        #[arg(long)]
        assets: Vec<PathBuf>,
    },

    /// Run the full release pipeline: check → test → bump → build → tag → publish → gh-release
    ///
    /// For cross-compiled projects (e.g., witmproxy), pass --target to produce a platform-specific
    /// binary. Run once per target — subsequent runs for the same version upload additional assets
    /// to the existing GitHub release.
    Release {
        /// Target project
        #[arg(short, long)]
        project: ProjectId,

        /// Version to release (semver)
        version: Version,

        /// Cross-compile for a specific target triple (e.g., x86_64-unknown-linux-gnu)
        #[arg(long)]
        target: Option<BuildTarget>,
    },

    /// List all registered projects
    List,
}
