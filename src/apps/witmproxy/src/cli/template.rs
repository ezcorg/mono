//! Plugin project scaffolding.
//!
//! Replaces the `cargo-generate` dependency, which pulled in libgit2, libssh2
//! and a second vendored OpenSSL to provide, in practice, three things: fetch a
//! template, substitute a handful of variables, write the result.
//!
//! The templates are embedded in the binary instead of cloned from git, which
//! also fixes a correctness problem with the old flow: the generated project's
//! `wit/` now comes from *this* build of witmproxy, so a scaffolded plugin
//! always targets the WIT world of the host that generated it rather than
//! whatever happened to be on the template repo's `main` branch.

use anyhow::{Context, Result, bail};
use rust_embed::RustEmbed;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Template sources for `witm plugin new --language rust`.
///
/// Files carry a `.tmpl` suffix so that a nested `Cargo.toml` inside this crate
/// is not picked up by cargo; the suffix is stripped on render.
#[derive(RustEmbed)]
#[folder = "templates/plugin/rust"]
struct RustPluginTemplate;

/// The host's own WIT world, vendored into generated projects verbatim.
#[derive(RustEmbed)]
#[folder = "wit"]
struct WitAssets;

/// Keep in sync with the `wit-bindgen` dependency in this crate's Cargo.toml.
/// `tests::wit_bindgen_version_matches_manifest` enforces that.
const WIT_BINDGEN_VERSION: &str = "0.61.1";

/// Languages `witm plugin new` can scaffold.
pub const SUPPORTED_LANGUAGES: &[&str] = &["rust"];

/// Options for scaffolding a new plugin project.
#[derive(Debug, Clone)]
pub struct ScaffoldOptions {
    pub plugin_name: String,
    pub language: String,
    pub destination: PathBuf,
    pub namespace: Option<String>,
    pub author: Option<String>,
    pub description: Option<String>,
    pub license: Option<String>,
    pub url: Option<String>,
    /// Overwrite files that already exist in the destination.
    pub force: bool,
}

/// Substitute `{{ key }}` placeholders.
///
/// Deliberately strict: an unknown placeholder is an error rather than an empty
/// string, so a template that drifts ahead of this table fails loudly at the
/// point of change instead of silently emitting a broken project.
fn render(template: &str, vars: &BTreeMap<&str, String>) -> Result<String> {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;

    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            bail!("unterminated `{{{{` in template");
        };
        let key = after[..end].trim();
        match vars.get(key) {
            Some(value) => out.push_str(value),
            None => bail!(
                "unknown template variable `{key}`; known variables: {}",
                vars.keys().copied().collect::<Vec<_>>().join(", ")
            ),
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Validate a plugin name so the generated project is actually buildable.
///
/// Cargo package names are the binding constraint here, and a bad name would
/// otherwise surface as a confusing `cargo build` failure inside the generated
/// project rather than as an error from `witm plugin new`.
fn validate_plugin_name(name: &str) -> Result<()> {
    if name.is_empty() {
        bail!("plugin name must not be empty");
    }
    if name.len() > 64 {
        bail!("plugin name must be 64 characters or fewer (got {})", name.len());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        bail!(
            "plugin name `{name}` must contain only ASCII letters, digits, `-` and `_`"
        );
    }
    if !name.starts_with(|c: char| c.is_ascii_alphabetic()) {
        bail!("plugin name `{name}` must start with an ASCII letter");
    }
    Ok(())
}

/// Best-effort author, matching what cargo-generate used to infer.
fn detect_author() -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["config", "--get", "user.name"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!name.is_empty()).then_some(name)
}

fn build_vars(opts: &ScaffoldOptions) -> BTreeMap<&'static str, String> {
    let project_name = opts.plugin_name.replace('_', "-");
    let crate_name = opts.plugin_name.replace('-', "_");

    let mut vars = BTreeMap::new();
    vars.insert("project-name", project_name);
    vars.insert("crate_name", crate_name);
    vars.insert("plugin-name", opts.plugin_name.clone());
    vars.insert(
        "namespace",
        opts.namespace.clone().unwrap_or_else(|| "local".to_string()),
    );
    vars.insert(
        "author",
        opts.author
            .clone()
            .or_else(detect_author)
            .unwrap_or_else(|| "unknown".to_string()),
    );
    vars.insert(
        "description",
        opts.description
            .clone()
            .unwrap_or_else(|| format!("a witmproxy plugin: {}", opts.plugin_name)),
    );
    vars.insert(
        "license",
        opts.license.clone().unwrap_or_else(|| "MIT".to_string()),
    );
    vars.insert(
        "url",
        opts.url
            .clone()
            .unwrap_or_else(|| "https://example.com".to_string()),
    );
    vars.insert("wit-bindgen-version", WIT_BINDGEN_VERSION.to_string());
    vars.insert("witm-version", env!("CARGO_PKG_VERSION").to_string());
    vars
}

/// Write `contents` to `path`, creating parents. Refuses to clobber unless
/// `force`, so a mistyped destination cannot silently destroy existing work.
fn write_file(path: &Path, contents: &[u8], force: bool) -> Result<()> {
    if path.exists() && !force {
        bail!(
            "refusing to overwrite existing file: {} (pass --force to overwrite)",
            path.display()
        );
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating directory {}", parent.display()))?;
    }
    std::fs::write(path, contents).with_context(|| format!("writing {}", path.display()))
}

/// Scaffold a new plugin project. Returns the project root.
pub fn scaffold(opts: &ScaffoldOptions) -> Result<PathBuf> {
    validate_plugin_name(&opts.plugin_name)?;

    if !SUPPORTED_LANGUAGES.contains(&opts.language.as_str()) {
        bail!(
            "unsupported language `{}`; supported: {}",
            opts.language,
            SUPPORTED_LANGUAGES.join(", ")
        );
    }

    let vars = build_vars(opts);
    let root = opts.destination.join(&opts.plugin_name);

    // Pre-flight: if anything is in the way, fail before writing a partial tree.
    if root.exists() && !opts.force {
        let non_empty = std::fs::read_dir(&root)
            .map(|mut d| d.next().is_some())
            .unwrap_or(false);
        if non_empty {
            bail!(
                "destination {} already exists and is not empty (pass --force to overwrite)",
                root.display()
            );
        }
    }

    let mut written = 0usize;

    for name in RustPluginTemplate::iter() {
        let file = RustPluginTemplate::get(name.as_ref())
            .with_context(|| format!("embedded template file missing: {name}"))?;
        let text = std::str::from_utf8(&file.data)
            .with_context(|| format!("embedded template file is not UTF-8: {name}"))?;

        // Substitute in the path as well as the contents, then drop `.tmpl`.
        let rendered_path = render(name.as_ref(), &vars)?;
        let rel = rendered_path
            .strip_suffix(".tmpl")
            .unwrap_or(&rendered_path)
            .to_string();

        let rendered = render(text, &vars)
            .with_context(|| format!("rendering template {name}"))?;
        write_file(&root.join(&rel), rendered.as_bytes(), opts.force)?;
        written += 1;
    }

    // Vendor the host's WIT world verbatim (not rendered: WIT is not a template
    // and `{{` has no meaning there).
    for name in WitAssets::iter() {
        let file = WitAssets::get(name.as_ref())
            .with_context(|| format!("embedded wit file missing: {name}"))?;
        write_file(&root.join("wit").join(name.as_ref()), &file.data, opts.force)?;
        written += 1;
    }

    if written == 0 {
        bail!("no template files were embedded; this is a build configuration bug");
    }

    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(name: &str, dest: PathBuf) -> ScaffoldOptions {
        ScaffoldOptions {
            plugin_name: name.to_string(),
            language: "rust".to_string(),
            destination: dest,
            namespace: Some("test".into()),
            author: Some("Tester".into()),
            description: Some("a test plugin".into()),
            license: Some("MIT".into()),
            url: None,
            force: false,
        }
    }

    #[test]
    fn render_substitutes_and_trims() {
        let mut vars = BTreeMap::new();
        vars.insert("name", "witm".to_string());
        assert_eq!(render("a {{name}} b", &vars).unwrap(), "a witm b");
        assert_eq!(render("a {{ name }} b", &vars).unwrap(), "a witm b");
        assert_eq!(render("no placeholders", &vars).unwrap(), "no placeholders");
    }

    #[test]
    fn render_rejects_unknown_variable() {
        let vars = BTreeMap::new();
        let err = render("{{nope}}", &vars).unwrap_err().to_string();
        assert!(err.contains("unknown template variable"), "{err}");
    }

    #[test]
    fn render_rejects_unterminated_placeholder() {
        let vars = BTreeMap::new();
        assert!(render("{{oops", &vars).is_err());
    }

    #[test]
    fn rejects_bad_plugin_names() {
        assert!(validate_plugin_name("").is_err());
        assert!(validate_plugin_name("1bad").is_err());
        assert!(validate_plugin_name("bad name").is_err());
        assert!(validate_plugin_name("../escape").is_err());
        assert!(validate_plugin_name("good-name_1").is_ok());
    }

    /// Every placeholder in every embedded template must resolve, so a template
    /// edit that introduces a new variable fails here rather than in a user's
    /// generated project.
    #[test]
    fn all_templates_render() {
        let o = opts("demo", PathBuf::from("/tmp"));
        let vars = build_vars(&o);
        for name in RustPluginTemplate::iter() {
            let file = RustPluginTemplate::get(name.as_ref()).unwrap();
            let text = std::str::from_utf8(&file.data).unwrap();
            render(text, &vars).unwrap_or_else(|e| panic!("template {name}: {e}"));
            render(name.as_ref(), &vars).unwrap();
        }
    }

    #[test]
    fn scaffold_writes_expected_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let o = opts("my-plugin", tmp.path().to_path_buf());
        let root = scaffold(&o).unwrap();

        for expected in ["Cargo.toml", "Makefile", "README.md", ".gitignore", "src/lib.rs"] {
            assert!(root.join(expected).exists(), "missing {expected}");
        }
        assert!(root.join("wit/world.wit").exists(), "wit world not vendored");

        let cargo_toml = std::fs::read_to_string(root.join("Cargo.toml")).unwrap();
        assert!(cargo_toml.contains("name = \"my-plugin\""), "{cargo_toml}");
        assert!(!cargo_toml.contains("{{"), "unsubstituted placeholder");

        let lib = std::fs::read_to_string(root.join("src/lib.rs")).unwrap();
        assert!(lib.contains("\"my-plugin\""));
        assert!(!lib.contains("{{"), "unsubstituted placeholder in lib.rs");

        // The Makefile must reference the snake_case artifact cargo produces.
        let makefile = std::fs::read_to_string(root.join("Makefile")).unwrap();
        assert!(makefile.contains("my_plugin.wasm"), "{makefile}");
    }

    #[test]
    fn scaffold_refuses_to_clobber() {
        let tmp = tempfile::tempdir().unwrap();
        let o = opts("dup", tmp.path().to_path_buf());
        scaffold(&o).unwrap();
        let err = scaffold(&o).unwrap_err().to_string();
        assert!(err.contains("already exists"), "{err}");
    }

    #[test]
    fn scaffold_rejects_unsupported_language() {
        let tmp = tempfile::tempdir().unwrap();
        let mut o = opts("x", tmp.path().to_path_buf());
        o.language = "cobol".into();
        assert!(scaffold(&o).is_err());
    }

    /// `WIT_BINDGEN_VERSION` is emitted into every generated Cargo.toml; if this
    /// crate bumps wit-bindgen, generated plugins must follow or they will bind
    /// against a different ABI than the host.
    #[test]
    fn wit_bindgen_version_matches_manifest() {
        let manifest = include_str!("../../Cargo.toml");
        let line = manifest
            .lines()
            .find(|l| l.trim_start().starts_with("wit-bindgen"))
            .expect("wit-bindgen dependency present in Cargo.toml");
        assert!(
            line.contains(WIT_BINDGEN_VERSION),
            "WIT_BINDGEN_VERSION ({WIT_BINDGEN_VERSION}) is out of sync with Cargo.toml: {line}"
        );
    }
}
