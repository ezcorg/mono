use crate::context::MonoContext;
use crate::error::MonoError;
use crate::project::registry;

pub fn run(ctx: &MonoContext) -> Result<(), MonoError> {
    let projects = registry::all_projects(&ctx.repo_root);

    for p in &projects {
        let version = p
            .version()
            .map(|v| v.to_string())
            .unwrap_or_else(|_| "?".to_string());
        println!(
            "{:<20} {:<16} {:<16} {}",
            p.id(),
            p.kind(),
            version,
            p.root().display()
        );
    }

    Ok(())
}
