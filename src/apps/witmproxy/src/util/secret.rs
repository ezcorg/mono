//! A string secret (database password, JWT signing secret, admin password).
//!
//! What this type guarantees:
//! - the backing memory is zeroed on drop — including every clone;
//! - `Debug` prints `[REDACTED]`, so config structs stay safely `Debug`;
//! - there is no `Display`; the only path to the plaintext is [`Secret::expose`].
//!
//! What it deliberately does NOT guarantee: copies outside our control (argv,
//! the process environment, the sqlx pool's per-connection `PRAGMA key` value)
//! are not zeroed. Prefer the prompt/file/config-file input paths over
//! `--db-password <value>` — argv is visible in shell history and `ps`.

use std::str::FromStr;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

/// See the module docs. `Serialize` exists solely so [`crate::AppConfig::save`]
/// can persist secrets to the 0600 `config.toml`; never serialize secrets
/// anywhere else (the management API's `RuntimeConfig` deliberately excludes
/// them).
#[derive(Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    /// The plaintext. Every use site is a deliberate exposure decision.
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// An empty secret is the "prompt me" sentinel: it's what a bare
    /// `--db-password` (via conf's `default_if_missing`) parses to, and an
    /// empty value was never a valid secret anyway.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED]")
    }
}

impl From<String> for Secret {
    fn from(s: String) -> Self {
        Secret(s)
    }
}

impl From<&str> for Secret {
    fn from(s: &str) -> Self {
        Secret(s.to_string())
    }
}

impl FromStr for Secret {
    type Err = std::convert::Infallible;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Secret(s.to_string()))
    }
}

/// Prompt for a secret, labeled so multiple prompts are unambiguous.
///
/// On a TTY this is a hidden (no-echo) prompt. With stdin piped it reads one
/// line instead (the docker `--password-stdin` convention), so a script
/// supplying several secrets writes one per line in the order the prompts
/// occur — which is fixed and documented, not dependent on flag order.
pub fn prompt(label: &str) -> Result<Secret> {
    use std::io::IsTerminal;

    let mut value = if std::io::stdin().is_terminal() {
        rpassword::prompt_password(format!("{label}: "))?
    } else {
        // One secret per line: read exactly one line, leaving the rest of the
        // stream buffered for any later prompt.
        let mut line = String::new();
        std::io::BufRead::read_line(&mut std::io::stdin().lock(), &mut line)?;
        while line.ends_with(['\n', '\r']) {
            line.pop();
        }
        line
    };
    if value.is_empty() {
        value.zeroize();
        anyhow::bail!("{label}: no value provided");
    }
    Ok(Secret(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_is_redacted() {
        let s = Secret::from("hunter2");
        assert_eq!(format!("{s:?}"), "[REDACTED]");
        // ...including inside containers and derived Debug impls.
        assert_eq!(format!("{:?}", Some(&s)), "Some([REDACTED])");
    }

    #[test]
    fn toml_round_trip_is_transparent() {
        #[derive(Serialize, Deserialize)]
        struct Wrap {
            secret: Option<Secret>,
        }
        let toml_str = toml::to_string(&Wrap {
            secret: Some(Secret::from("hunter2")),
        })
        .unwrap();
        assert_eq!(toml_str.trim(), r#"secret = "hunter2""#);
        let back: Wrap = toml::from_str(&toml_str).unwrap();
        assert_eq!(back.secret.unwrap().expose(), "hunter2");
    }

    #[test]
    fn empty_is_the_prompt_sentinel() {
        assert!(Secret::from("").is_empty());
        assert!(!Secret::from("x").is_empty());
    }
}
