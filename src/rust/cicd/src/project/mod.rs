pub mod registry;
pub mod rust;

use crate::context::MonoContext;
use crate::error::MonoError;
use crate::types::{BuildTarget, ProjectId, Version};
use std::path::Path;

/// The kind of project, determining which tools are used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectKind {
    RustCrate,
    WasmComponent,
    TypeScriptLib,
    TypeScriptApp,
}

impl std::fmt::Display for ProjectKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RustCrate => write!(f, "rust"),
            Self::WasmComponent => write!(f, "wasm-component"),
            Self::TypeScriptLib => write!(f, "typescript-lib"),
            Self::TypeScriptApp => write!(f, "typescript-app"),
        }
    }
}

/// A project in the monorepo.
pub trait Project {
    fn id(&self) -> &ProjectId;
    fn kind(&self) -> ProjectKind;
    fn root(&self) -> &Path;
    fn version(&self) -> Result<Version, MonoError>;
    fn tag_prefix(&self) -> &str;
    fn build_targets(&self) -> &[BuildTarget];

    fn check(&self, ctx: &MonoContext) -> Result<(), MonoError>;
    fn test(&self, ctx: &MonoContext) -> Result<(), MonoError>;
    fn build(
        &self,
        ctx: &MonoContext,
        release: bool,
        target: Option<&BuildTarget>,
    ) -> Result<(), MonoError>;
    fn bump(&self, ctx: &MonoContext, version: &Version) -> Result<(), MonoError>;
    fn publish(&self, ctx: &MonoContext) -> Result<(), MonoError>;
}

/// Find a project by id from the registry.
pub fn find_project(projects: &[Box<dyn Project>], id: &ProjectId) -> Result<usize, MonoError> {
    projects
        .iter()
        .position(|p| p.id() == id)
        .ok_or_else(|| MonoError::UnknownProject(id.to_string()))
}

/// Read the version string from a Cargo.toml file.
pub fn read_cargo_version(cargo_toml: &Path) -> Result<Version, MonoError> {
    let contents = std::fs::read_to_string(cargo_toml).map_err(|e| MonoError::ParseError {
        path: cargo_toml.to_path_buf(),
        reason: e.to_string(),
    })?;
    let doc = contents
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| MonoError::ParseError {
            path: cargo_toml.to_path_buf(),
            reason: e.to_string(),
        })?;
    let version_str = doc["package"]["version"]
        .as_str()
        .ok_or_else(|| MonoError::ParseError {
            path: cargo_toml.to_path_buf(),
            reason: "missing package.version".to_string(),
        })?;
    version_str.parse::<Version>().map_err(Into::into)
}

/// Update the version in a Cargo.toml file, preserving formatting.
pub fn write_cargo_version(cargo_toml: &Path, version: &Version) -> Result<(), MonoError> {
    let contents = std::fs::read_to_string(cargo_toml)?;
    let mut doc =
        contents
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| MonoError::ParseError {
                path: cargo_toml.to_path_buf(),
                reason: e.to_string(),
            })?;
    doc["package"]["version"] = toml_edit::value(version.to_string());
    std::fs::write(cargo_toml, doc.to_string())?;
    Ok(())
}
