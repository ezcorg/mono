use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum MonoError {
    #[error("unknown project: {0}")]
    UnknownProject(String),

    #[error("command failed: {cmd}\n{stderr}")]
    CommandFailed { cmd: String, stderr: String },

    #[error("invalid version: {0}")]
    InvalidVersion(#[from] semver::Error),

    #[error("missing environment variable: {0}")]
    MissingEnv(String),

    #[allow(dead_code)]
    #[error("project `{project}` does not support `{operation}`")]
    UnsupportedOperation { project: String, operation: String },

    #[error("could not find repository root from {0}")]
    NoRepoRoot(PathBuf),

    #[error("failed to parse {path}: {reason}")]
    ParseError { path: PathBuf, reason: String },

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Shell(#[from] xshell::Error),

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}
