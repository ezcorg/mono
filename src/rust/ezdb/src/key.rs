//! Where the database key comes from.

use std::path::PathBuf;

use rand::RngCore as _;
use zeroize::Zeroize;

/// A passphrase: zeroed on drop, redacted in `Debug`.
#[derive(Clone)]
pub struct Key(String);

impl Key {
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// 32 random bytes as hex.
    pub fn generate() -> Key {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        Key(bytes.iter().map(|b| format!("{b:02x}")).collect())
    }
}

impl From<String> for Key {
    fn from(s: String) -> Self {
        Key(s)
    }
}

impl From<&str> for Key {
    fn from(s: &str) -> Self {
        Key(s.to_string())
    }
}

impl Drop for Key {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl std::fmt::Debug for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED]")
    }
}

#[derive(Debug, thiserror::Error)]
pub enum KeyError {
    #[error("environment variable `{0}` is not set")]
    EnvUnset(String),
    #[error("key file {path}: {source}")]
    File {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("keychain `{service}/{account}`: {source}")]
    Keychain {
        service: String,
        account: String,
        #[source]
        source: keyring::Error,
    },
    #[error("no key source succeeded:\n{0}")]
    Exhausted(String),
}

/// How to obtain the key. `Keychain` and `File` create a fresh random key on
/// first use; `Env` and `Provided` only read.
#[derive(Debug, Clone)]
pub enum KeySource {
    /// A passphrase the caller already holds (a `--db-password`).
    Provided(Key),
    /// Read from an environment variable.
    Env(String),
    /// A key file, created with `0600` permissions if missing.
    File(PathBuf),
    /// An OS keychain item (macOS Keychain, Windows Credential Manager,
    /// Secret Service on Linux), created if missing.
    Keychain { service: String, account: String },
    /// The first source that resolves wins; every failure is reported if
    /// none does.
    Chain(Vec<KeySource>),
}

impl KeySource {
    /// The default for an application: its keychain item, then a key file in
    /// `dir`. A machine without a keychain (a headless Linux box, CI) lands
    /// on the file without anyone configuring anything.
    pub fn default_for(app: &str, dir: impl Into<PathBuf>) -> KeySource {
        KeySource::Chain(vec![
            KeySource::Keychain {
                service: app.to_string(),
                account: "database".to_string(),
            },
            KeySource::File(dir.into().join(format!("{app}.key"))),
        ])
    }

    pub fn resolve(&self) -> Result<Key, KeyError> {
        match self {
            KeySource::Provided(key) => Ok(key.clone()),
            KeySource::Env(var) => std::env::var(var)
                .map(Key::from)
                .map_err(|_unset| KeyError::EnvUnset(var.clone())),
            KeySource::File(path) => resolve_file(path),
            KeySource::Keychain { service, account } => resolve_keychain(service, account),
            KeySource::Chain(sources) => {
                let mut failures = Vec::new();
                for source in sources {
                    match source.resolve() {
                        Ok(key) => return Ok(key),
                        Err(e) => failures.push(format!("  - {e}")),
                    }
                }
                Err(KeyError::Exhausted(failures.join("\n")))
            }
        }
    }
}

fn resolve_file(path: &PathBuf) -> Result<Key, KeyError> {
    let io = |source: std::io::Error| KeyError::File {
        path: path.clone(),
        source,
    };
    match std::fs::read_to_string(path) {
        Ok(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return Err(io(std::io::Error::other("key file is empty")));
            }
            Ok(Key::from(trimmed))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(io)?;
            }
            let key = Key::generate();
            write_private(path, key.expose()).map_err(io)?;
            Ok(key)
        }
        Err(e) => Err(io(e)),
    }
}

#[cfg(unix)]
fn write_private(path: &PathBuf, contents: &str) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents.as_bytes())?;
    file.write_all(b"\n")
}

#[cfg(not(unix))]
fn write_private(path: &PathBuf, contents: &str) -> std::io::Result<()> {
    std::fs::write(path, format!("{contents}\n"))
}

fn resolve_keychain(service: &str, account: &str) -> Result<Key, KeyError> {
    let kc = |source: keyring::Error| KeyError::Keychain {
        service: service.to_string(),
        account: account.to_string(),
        source,
    };
    let entry = keyring::Entry::new(service, account).map_err(kc)?;
    match entry.get_password() {
        Ok(existing) => Ok(Key::from(existing)),
        Err(keyring::Error::NoEntry) => {
            let key = Key::generate();
            entry.set_password(key.expose()).map_err(kc)?;
            Ok(key)
        }
        Err(e) => Err(kc(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Touches the real keychain, so it only runs on request:
    /// `cargo test -p ezdb -- --ignored keychain`.
    #[test]
    #[ignore]
    fn keychain_round_trip() -> Result<(), KeyError> {
        let source = KeySource::Keychain {
            service: "ezdb-test".to_string(),
            account: "database".to_string(),
        };
        let a = source.resolve()?;
        let b = source.resolve()?;
        assert_eq!(a.expose(), b.expose());
        let _ = keyring::Entry::new("ezdb-test", "database").and_then(|e| e.delete_credential());
        Ok(())
    }
}
