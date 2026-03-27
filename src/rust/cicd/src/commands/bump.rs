use crate::context::MonoContext;
use crate::error::MonoError;
use crate::project::{find_project, registry};
use crate::types::{ProjectId, Version};

pub fn run(ctx: &MonoContext, project: &ProjectId, version: &Version) -> Result<(), MonoError> {
    let projects = registry::all_projects(&ctx.repo_root);
    let idx = find_project(&projects, project)?;
    projects[idx].bump(ctx, version)
}
