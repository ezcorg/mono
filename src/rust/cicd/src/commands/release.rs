use crate::commands;
use crate::context::MonoContext;
use crate::error::MonoError;
use crate::project::{Project, ProjectKind, find_project, registry};
use crate::types::{BuildTarget, ProjectId, Version};
use std::path::PathBuf;
use xshell::cmd;

/// Orchestrates the full release pipeline:
/// check → test → bump → build → prepare assets → generate patches → tag → publish → gh-release
///
/// For RustCrate projects, `target` selects the platform. Subsequent runs for the same
/// version but different targets upload their assets to the existing release.
pub fn run(
    ctx: &MonoContext,
    project: &ProjectId,
    version: &Version,
    target: Option<BuildTarget>,
) -> Result<(), MonoError> {
    let projects = registry::all_projects(&ctx.repo_root);
    let idx = find_project(&projects, project)?;
    let p = &projects[idx];
    let tag = format!("{}{version}", p.tag_prefix());

    let target_desc = target.map(|t| format!(" for {t}")).unwrap_or_default();
    eprintln!("=== releasing {} v{version}{target_desc} ===\n", project);

    // --- check & test (skip on subsequent target runs) ---
    let is_subsequent_target = tag_exists(ctx, &tag);
    if !is_subsequent_target {
        eprintln!("--- step 1/8: check ---");
        commands::check::run(ctx, project)?;
        eprintln!();

        eprintln!("--- step 2/8: test ---");
        commands::test::run(ctx, project)?;
        eprintln!();
    } else {
        eprintln!("--- steps 1-2: check & test (skipped, tag {tag} exists) ---\n");
    }

    // --- bump (idempotent) ---
    let current = p.version()?;
    if current != *version {
        eprintln!("--- step 3/8: bump ---");
        commands::bump::run(ctx, project, version)?;
        eprintln!();
    } else {
        eprintln!("--- step 3/8: bump (already at {version}) ---\n");
    }

    // --- build ---
    eprintln!("--- step 4/8: build ---");
    commands::build::run(ctx, project, true, target)?;
    eprintln!();

    // --- prepare release assets ---
    eprintln!("--- step 5/8: prepare assets ---");
    let mut assets = p.release_assets(ctx, target.as_ref())?;
    for a in &assets {
        eprintln!("  asset: {}", a.display());
    }
    eprintln!();

    // --- generate bidiff patches (RustCrate with binary + target) ---
    eprintln!("--- step 6/8: generate patches ---");
    if let Some(t) = target
        && p.kind() == ProjectKind::RustCrate
    {
        match generate_bidiff_patch(ctx, p.as_ref(), version, &t) {
            Ok(Some(patch)) => {
                eprintln!("  patch: {}", patch.display());
                assets.push(patch);
            }
            Ok(None) => {
                eprintln!("  no previous release or asset found, skipping.");
            }
            Err(e) => {
                eprintln!("  warning: patch generation failed: {e:#}");
                eprintln!("  (continuing without patch)");
            }
        }
    } else {
        eprintln!("  (not applicable)");
    }
    eprintln!();

    // --- tag (idempotent) ---
    if !is_subsequent_target {
        eprintln!("--- step 7/8: tag ---");
        commands::tag::run(ctx, project)?;
        eprintln!();
    } else {
        eprintln!("--- step 7/8: tag (already exists) ---\n");
    }

    // --- publish & gh-release ---
    eprintln!("--- step 8/8: publish & release ---");
    if !is_subsequent_target && p.kind() == ProjectKind::RustCrate {
        match commands::publish::run(ctx, project) {
            Ok(()) => {}
            Err(e) => {
                eprintln!("  warning: publish failed: {e:#}");
                eprintln!("  (continuing with GitHub release)");
            }
        }
    }

    let title = format!("{} v{version}", p.id());
    commands::gh_release::create_or_upload(ctx, &tag, &title, version.is_prerelease(), &assets)?;
    eprintln!();

    eprintln!(
        "=== release complete: {} v{version}{target_desc} ===",
        project
    );
    Ok(())
}

fn tag_exists(ctx: &MonoContext, tag: &str) -> bool {
    let sh = ctx.shell.inner();
    ctx.shell
        .read(&cmd!(sh, "git tag --list {tag}"))
        .is_ok_and(|out| !out.trim().is_empty())
}

/// Generate a bidiff patch from the previous release's platform binary to the current one.
fn generate_bidiff_patch(
    ctx: &MonoContext,
    project: &dyn Project,
    current_version: &Version,
    target: &BuildTarget,
) -> Result<Option<PathBuf>, MonoError> {
    let sh = ctx.shell.inner();
    let bin = match project.bin_name() {
        Some(b) => b,
        None => return Ok(None),
    };

    let artifact_name = target.artifact_name(bin);
    let tag_prefix = project.tag_prefix();
    let current_tag = format!("{tag_prefix}{current_version}");

    // Find the previous release tag
    let tag_pattern = format!("{tag_prefix}*");
    let all_tags = ctx.shell.read(&cmd!(
        sh,
        "git tag --list {tag_pattern} --sort=-version:refname"
    ))?;

    let prev_tag = all_tags
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty() && *l != current_tag);

    let prev_tag = match prev_tag {
        Some(t) => t.to_string(),
        None => return Ok(None),
    };

    let prev_version = prev_tag.strip_prefix(tag_prefix).unwrap_or(&prev_tag);

    // Paths
    let release_dir = ctx
        .repo_root
        .join("target")
        .join(target.triple())
        .join("release");
    let new_binary = release_dir.join(&artifact_name);
    if !new_binary.exists() {
        return Ok(None);
    }

    // Download previous binary to temp dir
    let tmp_dir = release_dir.join(".bidiff-tmp");
    std::fs::create_dir_all(&tmp_dir)?;
    let old_binary = tmp_dir.join(&artifact_name);

    eprintln!("  downloading {artifact_name} from {prev_tag}...");
    let dl_ok = ctx
        .shell
        .read(&cmd!(
            sh,
            "gh release download {prev_tag} --pattern {artifact_name} --dir {tmp_dir} --clobber"
        ))
        .is_ok()
        && old_binary.exists();

    if !dl_ok {
        eprintln!("  {artifact_name} not found in {prev_tag}, skipping.");
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Ok(None);
    }

    // Generate patch
    let patch_name = format!("{artifact_name}.bidiff-from-{prev_version}");
    let patch_path = release_dir.join(&patch_name);

    eprintln!("  generating {patch_name}...");
    let result = ctx
        .shell
        .run(&cmd!(sh, "bidiff {old_binary} {new_binary} {patch_path}"));

    let _ = std::fs::remove_dir_all(&tmp_dir);

    match result {
        Ok(()) if patch_path.exists() => {
            let new_size = std::fs::metadata(&new_binary).map(|m| m.len()).unwrap_or(1);
            let patch_size = std::fs::metadata(&patch_path).map(|m| m.len()).unwrap_or(0);
            eprintln!(
                "  patch size: {} bytes ({}% of full binary)",
                patch_size,
                patch_size * 100 / new_size
            );
            Ok(Some(patch_path))
        }
        Ok(()) => Ok(None),
        Err(e) => {
            eprintln!("  bidiff failed: {e:#}");
            eprintln!("  (is `bidiff` installed? cargo install bidiff)");
            Ok(None)
        }
    }
}
