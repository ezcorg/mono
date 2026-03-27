use crate::commands;
use crate::context::MonoContext;
use crate::error::MonoError;
use crate::types::{ProjectId, Version};

/// Orchestrates the full release pipeline:
/// check → test → bump → build → tag → publish → gh-release
pub fn run(ctx: &MonoContext, project: &ProjectId, version: &Version) -> Result<(), MonoError> {
    eprintln!("=== releasing {} v{version} ===\n", project);

    eprintln!("--- step 1/7: check ---");
    commands::check::run(ctx, project)?;
    eprintln!();

    eprintln!("--- step 2/7: test ---");
    commands::test::run(ctx, project)?;
    eprintln!();

    eprintln!("--- step 3/7: bump ---");
    commands::bump::run(ctx, project, version)?;
    eprintln!();

    eprintln!("--- step 4/7: build ---");
    commands::build::run(ctx, project, true, None)?;
    eprintln!();

    eprintln!("--- step 5/7: tag ---");
    commands::tag::run(ctx, project)?;
    eprintln!();

    eprintln!("--- step 6/7: publish ---");
    commands::publish::run(ctx, project)?;
    eprintln!();

    eprintln!("--- step 7/7: gh-release ---");
    commands::gh_release::run(ctx, project, &[])?;
    eprintln!();

    eprintln!("=== release complete: {} v{version} ===", project);
    Ok(())
}
