use crate::context::MonoContext;
use crate::error::MonoError;
use crate::project::{find_project, registry};
use crate::types::ProjectId;
use std::path::PathBuf;
use xshell::cmd;

pub fn run(ctx: &MonoContext, project: &ProjectId, assets: &[PathBuf]) -> Result<(), MonoError> {
    let projects = registry::all_projects(&ctx.repo_root);
    let idx = find_project(&projects, project)?;
    let p = &projects[idx];

    let version = p.version()?;
    let tag = format!("{}{version}", p.tag_prefix());

    create_or_upload(
        ctx,
        &tag,
        &format!("{} v{version}", p.id()),
        version.is_prerelease(),
        assets,
    )
}

/// Create a new GitHub release, or upload assets to an existing one.
pub fn create_or_upload(
    ctx: &MonoContext,
    tag: &str,
    title: &str,
    prerelease: bool,
    assets: &[PathBuf],
) -> Result<(), MonoError> {
    let sh = ctx.shell.inner();

    // Check if the release already exists
    let exists = ctx.shell.read(&cmd!(sh, "gh release view {tag}")).is_ok();

    if exists {
        if assets.is_empty() {
            eprintln!("release {tag} already exists, no new assets to upload.");
            return Ok(());
        }

        eprintln!("release {tag} already exists, uploading assets...");
        let asset_paths: Vec<String> = assets
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        ctx.shell.run_destructive(&cmd!(
            sh,
            "gh release upload {tag} --clobber {asset_paths...}"
        ))?;
    } else {
        eprintln!("creating GitHub release {tag}...");
        let mut args: Vec<String> = vec![
            "release".into(),
            "create".into(),
            tag.to_string(),
            "--title".into(),
            title.to_string(),
            "--generate-notes".into(),
        ];

        if prerelease {
            args.push("--prerelease".into());
        }

        for asset in assets {
            args.push(asset.to_string_lossy().to_string());
        }

        ctx.shell.run_destructive(&cmd!(sh, "gh {args...}"))?;
    }

    Ok(())
}
