use crate::context::MonoContext;
use crate::error::MonoError;
use crate::project::{find_project, registry};
use crate::types::ProjectId;

pub fn run(ctx: &MonoContext, project: &ProjectId) -> Result<(), MonoError> {
    let projects = registry::all_projects(&ctx.repo_root);
    let idx = find_project(&projects, project)?;
    projects[idx].publish(ctx)
}
