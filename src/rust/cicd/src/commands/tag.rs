use crate::context::MonoContext;
use crate::error::MonoError;
use crate::project::{find_project, registry};
use crate::types::ProjectId;
use xshell::cmd;

pub fn run(ctx: &MonoContext, project: &ProjectId) -> Result<(), MonoError> {
    let projects = registry::all_projects(&ctx.repo_root);
    let idx = find_project(&projects, project)?;
    let p = &projects[idx];

    let version = p.version()?;
    let tag = format!("{}{version}", p.tag_prefix());

    let sh = ctx.shell.inner();
    eprintln!("tagging {tag}...");
    ctx.shell.run_destructive(&cmd!(sh, "git tag {tag}"))?;

    eprintln!("tag created: {tag}");
    eprintln!("push with: git push origin {tag}");

    Ok(())
}
