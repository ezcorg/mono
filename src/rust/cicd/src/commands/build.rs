use crate::context::MonoContext;
use crate::error::MonoError;
use crate::project::{find_project, registry};
use crate::types::{BuildTarget, ProjectId};

pub fn run(
    ctx: &MonoContext,
    project: &ProjectId,
    release: bool,
    target: Option<BuildTarget>,
) -> Result<(), MonoError> {
    let projects = registry::all_projects(&ctx.repo_root);
    let idx = find_project(&projects, project)?;
    projects[idx].build(ctx, release, target.as_ref())
}
