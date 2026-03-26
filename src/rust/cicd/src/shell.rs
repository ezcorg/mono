use crate::error::MonoError;
use xshell::{Cmd, Shell};

/// A wrapper around `xshell::Shell` that supports dry-run and verbose modes.
pub struct MonoShell {
    inner: Shell,
    dry_run: bool,
    verbose: bool,
}

impl MonoShell {
    pub fn new(dry_run: bool, verbose: bool) -> Result<Self, MonoError> {
        let inner = Shell::new()?;
        Ok(Self {
            inner,
            dry_run,
            verbose,
        })
    }

    /// Get the underlying xshell::Shell for constructing commands.
    pub fn inner(&self) -> &Shell {
        &self.inner
    }

    /// Run a command that is always safe to execute (fmt check, test, build).
    pub fn run(&self, cmd: &Cmd<'_>) -> Result<(), MonoError> {
        if self.verbose {
            eprintln!("$ {cmd}");
        }
        cmd.run().map_err(|e| MonoError::CommandFailed {
            cmd: format!("{cmd}"),
            stderr: e.to_string(),
        })
    }

    /// Run a command and capture its stdout.
    pub fn read(&self, cmd: &Cmd<'_>) -> Result<String, MonoError> {
        if self.verbose {
            eprintln!("$ {cmd}");
        }
        cmd.read().map_err(|e| MonoError::CommandFailed {
            cmd: format!("{cmd}"),
            stderr: e.to_string(),
        })
    }

    /// Run a destructive command (publish, tag, release).
    /// In dry-run mode, prints what would be executed but does not run.
    pub fn run_destructive(&self, cmd: &Cmd<'_>) -> Result<(), MonoError> {
        if self.dry_run {
            eprintln!("[dry-run] would execute: {cmd}");
            return Ok(());
        }
        if self.verbose {
            eprintln!("$ {cmd}");
        }
        cmd.run().map_err(|e| MonoError::CommandFailed {
            cmd: format!("{cmd}"),
            stderr: e.to_string(),
        })
    }

    /// Read output from a destructive command.
    /// In dry-run mode, returns an empty string.
    pub fn read_destructive(&self, cmd: &Cmd<'_>) -> Result<String, MonoError> {
        if self.dry_run {
            eprintln!("[dry-run] would execute: {cmd}");
            return Ok(String::new());
        }
        self.read(cmd)
    }

    pub fn is_dry_run(&self) -> bool {
        self.dry_run
    }
}
