//! The registry of host **capabilities** the daemon can serve — what the consent
//! app's "Capabilities" tab enumerates. Ours are installed as defaults; the shape
//! leaves room for third-party capabilities to register later.
//!
//! Each entry carries a stable `id` (matching the `capability-kind` tag a grant
//! carries), a single-emoji `icon`, and a **localizable** description: a small
//! `locale -> text` table looked up by [`Capability::describe`], which takes an
//! optional language and otherwise falls back to the system locale, then English.

/// A registered host capability.
pub struct Capability {
    /// Stable id — matches the grant's `capability-kind` tag (`filesystem`,
    /// `terminal`, `process`, `watch`, `workspace`, `surface`).
    pub id: &'static str,
    /// A single emoji icon.
    pub icon: &'static str,
    /// `locale -> description`. Always includes `en`. Ordered; first is the default.
    pub descriptions: &'static [(&'static str, &'static str)],
}

impl Capability {
    /// The description in `lang` (e.g. `"de"`, `"en-US"`), else the system locale,
    /// else English, else the first entry. `lang` is the caller's explicit choice
    /// (for future i18n); passing `None` uses the host's locale.
    pub fn describe(&self, lang: Option<&str>) -> &'static str {
        let want = lang.map(primary_subtag).or_else(system_locale);
        if let Some(w) = want.as_deref() {
            if let Some((_, t)) = self.descriptions.iter().find(|(l, _)| *l == w) {
                return t;
            }
        }
        self.descriptions
            .iter()
            .find(|(l, _)| *l == "en")
            .or_else(|| self.descriptions.first())
            .map(|(_, t)| *t)
            .unwrap_or("")
    }
}

/// The installed capabilities — the ones we currently implement.
pub fn registry() -> &'static [Capability] {
    DEFAULTS
}

/// The emoji for a capability id (grant `kind` tag), or a key fallback.
pub fn icon_for(id: &str) -> &'static str {
    DEFAULTS
        .iter()
        .find(|c| c.id == id)
        .map(|c| c.icon)
        .unwrap_or("🔑")
}

static DEFAULTS: &[Capability] = &[
    Capability {
        id: "filesystem",
        icon: "📁",
        descriptions: &[("en", "Read and write files and folders you allow — scoped to the exact paths and rights you grant.")],
    },
    Capability {
        id: "terminal",
        icon: "🖥️",
        descriptions: &[("en", "Open an interactive shell on this machine, optionally sandboxed to a jail.")],
    },
    Capability {
        id: "process",
        icon: "⚙️",
        descriptions: &[("en", "Run one pinned program (e.g. a language server) with its exact, pre-approved arguments.")],
    },
    Capability {
        id: "watch",
        icon: "👁️",
        descriptions: &[("en", "Get notified when files change under a folder you've granted.")],
    },
    Capability {
        id: "workspace",
        icon: "🗂️",
        descriptions: &[("en", "Read the host path of a granted folder, so a site can form real file:// URIs.")],
    },
];

/// The primary language subtag: `"en-US"` / `"en_US.UTF-8"` -> `"en"`.
fn primary_subtag(tag: &str) -> String {
    tag.split(['-', '_', '.'])
        .next()
        .unwrap_or(tag)
        .to_ascii_lowercase()
}

/// The host's locale from the environment (`LANG` / `LC_ALL`), as a primary subtag.
fn system_locale() -> Option<String> {
    std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LANG"))
        .ok()
        .filter(|l| !l.is_empty() && l != "C" && l != "POSIX")
        .map(|l| primary_subtag(&l))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describe_falls_back_to_english() {
        let fs = registry().iter().find(|c| c.id == "filesystem").unwrap();
        // An unsupported language falls back to English (the only populated locale).
        assert!(fs.describe(Some("zz")).contains("files"));
        assert!(fs.describe(None).contains("files"));
        assert_eq!(fs.icon, "📁");
    }

    #[test]
    fn every_capability_has_english_and_an_emoji() {
        for c in registry() {
            assert!(
                c.descriptions.iter().any(|(l, _)| *l == "en"),
                "{} lacks en",
                c.id
            );
            assert!(!c.icon.is_empty(), "{} lacks an icon", c.id);
        }
    }
}
