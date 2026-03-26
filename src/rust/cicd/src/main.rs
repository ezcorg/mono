mod cli;
mod commands;
mod context;
mod env;
mod error;
mod project;
mod shell;
mod types;

use anyhow::Result;
use clap::Parser;
use cli::{Cli, Commands};
use context::MonoContext;

fn main() -> Result<()> {
    let cli = Cli::parse();
    let ctx = MonoContext::new(cli.dry_run, cli.verbose)?;

    match cli.command {
        Commands::Check { project } => commands::check::run(&ctx, &project)?,
        Commands::Test { project } => commands::test::run(&ctx, &project)?,
        Commands::Build {
            project,
            release,
            target,
        } => commands::build::run(&ctx, &project, release, target)?,
        Commands::Bump { project, version } => commands::bump::run(&ctx, &project, &version)?,
        Commands::Tag { project } => commands::tag::run(&ctx, &project)?,
        Commands::Publish { project } => commands::publish::run(&ctx, &project)?,
        Commands::GhRelease { project, assets } => {
            commands::gh_release::run(&ctx, &project, &assets)?
        }
        Commands::Release { project, version } => {
            commands::release::run(&ctx, &project, &version)?
        }
        Commands::List => commands::list::run(&ctx)?,
    }

    Ok(())
}
