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
    /// The marker beside the database that records which source holds the
    /// key could not be read or written.
    #[error("key-source marker {path}: {source}")]
    Marker {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// The marker names a source this application does not resolve from.
    #[error(
        "key-source marker {path} says the database key is held by `{recorded}`, \
         which is not one of this application's key sources"
    )]
    UnknownRecordedSource { path: PathBuf, recorded: String },
    /// The marker names a source that no longer holds the key. A fresh key
    /// is deliberately not created: the database was encrypted with the one
    /// that is gone, and a new key would only make it unopenable in a
    /// quieter way.
    #[error(
        "the database key was recorded (in {path}) as held by the {recorded}, but it is \
         not there: {detail}\n  \
         Restore the {recorded}, or delete the database together with its key-source marker \
         to start over with a fresh key."
    )]
    RecordedKeyMissing {
        path: PathBuf,
        recorded: String,
        detail: String,
    },
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
    /// A chain that remembers its choice. The first resolve tries the sources
    /// in order (one that already holds a key wins over creating one
    /// anywhere) and writes the winner's name (`keychain`, `file`, ...) to
    /// `marker`, a small file beside the database. Every later resolve reads
    /// the marker and uses that source alone, never creating a key in another:
    /// a database opened headless (the file) and later from the desktop (the
    /// keychain) keeps the one key it was encrypted with. A marker naming a
    /// source that no longer has the key is an error that says so, not a
    /// silent fresh key.
    Recorded {
        marker: PathBuf,
        sources: Vec<KeySource>,
    },
}

impl KeySource {
    /// The default for an application: its keychain item, then a key file in
    /// `dir`, with the choice recorded in `dir/<app>.key-source`. A machine
    /// without a keychain (a headless Linux box, CI) lands on the file
    /// without anyone configuring anything, and stays on it if a keychain
    /// turns up later.
    pub fn default_for(app: &str, dir: impl Into<PathBuf>) -> KeySource {
        let dir = dir.into();
        KeySource::Recorded {
            marker: dir.join(format!("{app}.key-source")),
            sources: vec![
                KeySource::Keychain {
                    service: app.to_string(),
                    account: "database".to_string(),
                },
                KeySource::File(dir.join(format!("{app}.key"))),
            ],
        }
    }

    /// The name a `Recorded` marker records this source under.
    pub fn label(&self) -> &'static str {
        match self {
            KeySource::Provided(_) => "provided",
            KeySource::Env(_) => "env",
            KeySource::File(_) => "file",
            KeySource::Keychain { .. } => "keychain",
            KeySource::Chain(_) => "chain",
            KeySource::Recorded { .. } => "recorded",
        }
    }

    pub fn resolve(&self) -> Result<Key, KeyError> {
        match self {
            KeySource::Provided(key) => Ok(key.clone()),
            KeySource::Env(var) => std::env::var(var)
                .map(Key::from)
                .map_err(|_unset| KeyError::EnvUnset(var.clone())),
            KeySource::File(path) => resolve_file(path, Create::IfMissing),
            KeySource::Keychain { service, account } => {
                resolve_keychain(service, account, Create::IfMissing)
            }
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
            KeySource::Recorded { marker, sources } => resolve_recorded(marker, sources),
        }
    }

    /// Resolve without creating: `Ok(None)` when the source is reachable but
    /// holds no key.
    fn lookup(&self) -> Result<Option<Key>, KeyError> {
        match self {
            KeySource::Provided(key) => Ok(Some(key.clone())),
            KeySource::Env(var) => Ok(std::env::var(var).ok().map(Key::from)),
            KeySource::File(path) => resolve_file(path, Create::Never).map(Some),
            KeySource::Keychain { service, account } => {
                resolve_keychain(service, account, Create::Never).map(Some)
            }
            // A nested chain is resolved as itself; it decides its own creation.
            KeySource::Chain(_) | KeySource::Recorded { .. } => self.resolve().map(Some),
        }
        .or_else(|e| match e {
            KeyError::RecordedKeyMissing { .. } => Ok(None),
            other => Err(other),
        })
    }
}

/// Whether a `File` or `Keychain` source may create a key on a miss.
#[derive(Clone, Copy, PartialEq)]
enum Create {
    IfMissing,
    /// A miss is `KeyError::RecordedKeyMissing` with an empty `path` and
    /// `recorded`, which the caller fills in.
    Never,
}

fn missing(detail: impl Into<String>) -> KeyError {
    KeyError::RecordedKeyMissing {
        path: PathBuf::new(),
        recorded: String::new(),
        detail: detail.into(),
    }
}

fn resolve_recorded(marker: &PathBuf, sources: &[KeySource]) -> Result<Key, KeyError> {
    let marker_io = |source: std::io::Error| KeyError::Marker {
        path: marker.clone(),
        source,
    };
    let recorded = match std::fs::read_to_string(marker) {
        Ok(s) => Some(s.trim().to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(marker_io(e)),
    };
    if let Some(recorded) = recorded {
        // The marker decides. Only the recorded source is consulted, and it
        // is never asked to create: the database is encrypted with the key
        // it is supposed to hold.
        let source = sources
            .iter()
            .find(|s| s.label() == recorded)
            .ok_or_else(|| KeyError::UnknownRecordedSource {
                path: marker.clone(),
                recorded: recorded.clone(),
            })?;
        return match source.lookup() {
            Ok(Some(key)) => Ok(key),
            Ok(None) => Err(KeyError::RecordedKeyMissing {
                path: marker.clone(),
                recorded,
                detail: format!("{source:?} holds no key"),
            }),
            Err(KeyError::RecordedKeyMissing { detail, .. }) => Err(KeyError::RecordedKeyMissing {
                path: marker.clone(),
                recorded,
                detail,
            }),
            Err(other) => Err(other),
        };
    }
    // No marker yet: a source that already holds a key wins over creating
    // one anywhere (a database made before markers existed keeps its key),
    // then the first source that can create one. Either way the winner is
    // recorded, and from now on it is the only one consulted.
    let record = |source: &KeySource, key: Key| -> Result<Key, KeyError> {
        if let Some(parent) = marker.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent).map_err(marker_io)?;
        }
        std::fs::write(marker, format!("{}\n", source.label())).map_err(marker_io)?;
        Ok(key)
    };
    for source in sources {
        if let Ok(Some(key)) = source.lookup() {
            return record(source, key);
        }
    }
    let mut failures = Vec::new();
    for source in sources {
        match source.resolve() {
            Ok(key) => return record(source, key),
            Err(e) => failures.push(format!("  - {e}")),
        }
    }
    Err(KeyError::Exhausted(failures.join("\n")))
}

fn resolve_file(path: &PathBuf, create: Create) -> Result<Key, KeyError> {
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
            if create == Create::Never {
                return Err(missing(format!(
                    "key file {} does not exist",
                    path.display()
                )));
            }
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

fn resolve_keychain(service: &str, account: &str, create: Create) -> Result<Key, KeyError> {
    let kc = |source: keyring::Error| KeyError::Keychain {
        service: service.to_string(),
        account: account.to_string(),
        source,
    };
    let entry = keyring::Entry::new(service, account).map_err(kc)?;
    match entry.get_password() {
        Ok(existing) => Ok(Key::from(existing)),
        Err(keyring::Error::NoEntry) => {
            if create == Create::Never {
                return Err(missing(format!(
                    "keychain item `{service}/{account}` does not exist"
                )));
            }
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

    fn keychain(app: &str) -> KeySource {
        KeySource::Keychain {
            service: app.to_string(),
            account: "database".to_string(),
        }
    }

    fn recorded(marker: &std::path::Path, sources: Vec<KeySource>) -> KeySource {
        KeySource::Recorded {
            marker: marker.to_path_buf(),
            sources,
        }
    }

    #[test]
    fn the_source_that_held_the_key_is_recorded_and_used_from_then_on() -> Result<(), KeyError> {
        let dir = tempfile::tempdir().map_err(|e| KeyError::Marker {
            path: PathBuf::new(),
            source: e,
        })?;
        let marker = dir.path().join("app.key-source");
        let file = dir.path().join("app.key");

        // Headless first: only the file is available.
        let headless = recorded(&marker, vec![KeySource::File(file.clone())]);
        let first = headless.resolve()?;
        assert!(file.exists(), "the file created the key");
        assert_eq!(
            std::fs::read_to_string(&marker).expect("marker written"),
            "file\n"
        );

        // Later from the desktop, with a chain that would prefer the
        // keychain: the marker says the file holds the key, so the keychain
        // is never consulted (this test must not touch the real one) and
        // no second key is made.
        let desktop = recorded(
            &marker,
            vec![
                keychain("ezdb-test-never-touched"),
                KeySource::File(file.clone()),
            ],
        );
        let again = desktop.resolve()?;
        assert_eq!(first.expose(), again.expose());
        assert_eq!(std::fs::read_to_string(&marker).expect("marker"), "file\n");
        Ok(())
    }

    #[test]
    fn default_for_records_beside_the_database() {
        let dir = tempfile::tempdir().expect("tempdir");
        match KeySource::default_for("app", dir.path()) {
            KeySource::Recorded { marker, sources } => {
                assert_eq!(marker, dir.path().join("app.key-source"));
                assert_eq!(
                    sources.iter().map(KeySource::label).collect::<Vec<_>>(),
                    ["keychain", "file"]
                );
            }
            other => panic!("expected a recorded chain, got {other:?}"),
        }
    }

    #[test]
    fn a_missing_key_at_the_recorded_source_is_an_error_not_a_new_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let marker = dir.path().join("app.key-source");
        let file = dir.path().join("app.key");
        let source = recorded(
            &marker,
            vec![
                keychain("ezdb-test-never-touched"),
                KeySource::File(file.clone()),
            ],
        );
        std::fs::write(&marker, "file\n").expect("marker");

        match source.resolve() {
            Err(KeyError::RecordedKeyMissing { path, recorded, .. }) => {
                assert_eq!(path, marker);
                assert_eq!(recorded, "file");
            }
            other => panic!("expected RecordedKeyMissing, got {other:?}"),
        }
        assert!(!file.exists(), "no key was created in the file's place");
        let text = source.resolve().unwrap_err().to_string();
        assert!(text.contains("recorded"), "{text}");
        assert!(text.contains("not there"), "{text}");
    }

    #[test]
    fn a_marker_naming_an_unknown_source_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let marker = dir.path().join("app.key-source");
        std::fs::write(&marker, "floppy\n").expect("marker");
        let source = recorded(&marker, vec![KeySource::File(dir.path().join("app.key"))]);
        assert!(matches!(
            source.resolve(),
            Err(KeyError::UnknownRecordedSource { recorded, .. }) if recorded == "floppy"
        ));
    }

    #[test]
    fn without_a_marker_a_source_that_already_holds_the_key_wins_over_creating() {
        // A database made before markers existed: the key file is there, the
        // marker is not. The keychain (first in the chain) must not create
        // a second key; the existing file is recorded.
        let dir = tempfile::tempdir().expect("tempdir");
        let marker = dir.path().join("app.key-source");
        let file = dir.path().join("app.key");
        let existing = KeySource::File(file.clone()).resolve().expect("create");
        let source = recorded(
            &marker,
            vec![
                // An unset variable stands in for the keychain: it would win
                // the creating pass if creation were tried first.
                KeySource::Env("EZDB_TEST_KEY_THAT_IS_NOT_SET".to_string()),
                KeySource::File(file),
            ],
        );
        let key = source.resolve().expect("resolves");
        assert_eq!(key.expose(), existing.expose());
        assert_eq!(std::fs::read_to_string(&marker).expect("marker"), "file\n");
    }

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
