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
    let title = format!("{} v{version}", p.id());
    let sh = ctx.shell.inner();

    let mut args: Vec<String> = vec![
        "release".into(),
        "create".into(),
        tag.clone(),
        "--title".into(),
        title,
        "--generate-notes".into(),
    ];

    if version.is_prerelease() {
        args.push("--prerelease".into());
    }

    for asset in assets {
        let path = asset.to_string_lossy().to_string();
        args.push(path);
    }

    eprintln!("creating GitHub release {tag}...");
    ctx.shell.run_destructive(&cmd!(sh, "gh {args...}"))?;

    Ok(())
}
