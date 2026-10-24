//! A plugin's configuration and scopes as a file beside it.
//!
//! `--plugin-dir` makes a directory the deployment: drop a component in, it
//! loads; change it, it reloads. Until now what the plugin was *told* lived
//! elsewhere, in the database by way of `witm plugin configure` (a restart
//! away, and with secrets on the command line) or at the icanhaz tray app
//! (a human, not a tool). A tool that drives witmproxy, as rig does, wants
//! the whole deployment to be files it writes: this is the file for the rest.
//!
//! `<component>.toml` beside `<component>.wasm`, read whenever either changes:
//!
//! ```toml
//! [configuration]
//! rules = '[...]'                 # typed as the manifest declares the input
//!
//! [capabilities.handle_event_connect]
//! when = "connect.host() in ['api.example.com']"
//! ```
//!
//! A scope in the file is a narrowing, as a scope from the tray app is: the
//! manifest's clause stays and the file's is conjoined, so a sidecar can
//! only ever take events away from a plugin, never hand it ones its author
//! did not ask for. Configuration is checked against the declared inputs; a
//! name the plugin does not declare refuses the whole file, since a typo
//! that quietly configures nothing is the failure this exists to avoid.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;

use crate::plugins::WitmPlugin;
use crate::plugins::inputs::coerce_input;
use crate::wasm::bindgen::UserInput;

/// The file's shape.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sidecar {
    /// Input name to value. Booleans and numbers may be written as such or
    /// as strings; everything is coerced to the declared type.
    #[serde(default)]
    pub configuration: BTreeMap<String, toml::Value>,
    /// Capability (as `witm plugin list` names it: `handle_event_connect`,
    /// `logger`, ...) to the clauses to narrow it by.
    #[serde(default)]
    pub capabilities: BTreeMap<String, ScopeNarrowing>,
}

#[derive(Debug, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ScopeNarrowing {
    pub when: Option<String>,
    pub allow: Option<String>,
}

/// The sidecar that belongs to a component at `wasm`, whether or not it
/// exists.
pub fn path_for(wasm: &Path) -> PathBuf {
    wasm.with_extension("toml")
}

/// The component a sidecar at `toml` belongs to, if one is there.
pub fn component_for(toml: &Path) -> Option<PathBuf> {
    let wasm = toml.with_extension("wasm");
    wasm.is_file().then_some(wasm)
}

/// Parses the file.
pub fn parse(text: &str) -> Result<Sidecar> {
    toml::from_str(text).map_err(|e| anyhow!("{e}"))
}

/// Reads the sidecar beside `wasm`, when there is one, and applies it to
/// the parsed plugin. Call between `plugin_from_component` and
/// `register_plugin`, which compiles the scopes as they then stand.
pub fn apply_beside(plugin: &mut WitmPlugin, wasm: &Path) -> Result<Option<PathBuf>> {
    let path = path_for(wasm);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    let sidecar = parse(&text).with_context(|| format!("{}", path.display()))?;
    apply(plugin, &sidecar).with_context(|| format!("{}", path.display()))?;
    Ok(Some(path))
}

/// Applies a parsed sidecar: configuration typed against the manifest's
/// inputs, scopes conjoined with the manifest's.
pub fn apply(plugin: &mut WitmPlugin, sidecar: &Sidecar) -> Result<()> {
    let mut configuration = Vec::with_capacity(sidecar.configuration.len());
    for (name, value) in &sidecar.configuration {
        let schema = plugin
            .input_schema
            .iter()
            .find(|s| s.name == *name)
            .ok_or_else(|| {
                anyhow!(
                    "{} declares no input named `{name}`; it declares: {}",
                    plugin.id(),
                    declared(plugin)
                )
            })?;
        let raw = match value {
            toml::Value::String(s) => s.clone(),
            toml::Value::Boolean(b) => b.to_string(),
            toml::Value::Integer(i) => i.to_string(),
            toml::Value::Float(f) => f.to_string(),
            other => bail!(
                "`{name}`: a {} is not a value an input takes",
                other.type_str()
            ),
        };
        let value = coerce_input(schema, &raw)?;
        configuration.push(UserInput {
            name: name.clone(),
            value,
        });
    }
    // Everything the file says, and nothing it does not: the file is the
    // deployment, so a value removed from it is removed.
    plugin.configuration = configuration;

    let (id, wanted) = (plugin.id(), wanted(plugin));
    for (kind, narrowing) in &sidecar.capabilities {
        let cap = plugin
            .capabilities
            .iter_mut()
            .find(|c| c.inner.kind.to_string() == *kind)
            .ok_or_else(|| {
                anyhow!("{id} wants no capability named `{kind}`; it wants: {wanted}")
            })?;
        if let Some(when) = &narrowing.when {
            cap.inner.scope.when = conjoin(&cap.inner.scope.when, when);
        }
        if let Some(allow) = &narrowing.allow {
            cap.inner.scope.allow = conjoin(&cap.inner.scope.allow, allow);
        }
    }
    Ok(())
}

/// `base && extra`, as a CEL clause. A base of `true` contributes nothing
/// and is dropped, so the common case reads as what the file said.
fn conjoin(base: &str, extra: &str) -> String {
    let (base, extra) = (base.trim(), extra.trim());
    if extra.is_empty() {
        return base.to_string();
    }
    if base.is_empty() || base == "true" {
        return extra.to_string();
    }
    format!("({base}) && ({extra})")
}

fn declared(plugin: &WitmPlugin) -> String {
    let names: Vec<&str> = plugin
        .input_schema
        .iter()
        .map(|s| s.name.as_str())
        .collect();
    if names.is_empty() {
        "nothing".to_string()
    } else {
        names.join(", ")
    }
}

fn wanted(plugin: &WitmPlugin) -> String {
    plugin
        .capabilities
        .iter()
        .map(|c| c.inner.kind.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::capabilities::Capability;
    use crate::wasm::bindgen::exports::witmproxy::plugin::witm_plugin::{
        ActualInput, InputSchema, InputType, PluginManifest,
    };
    use crate::wasm::bindgen::ezco::ezcap::types::Scope as ScopeWire;
    use crate::wasm::bindgen::witmproxy::plugin::capabilities::{
        Capability as WitCapability, CapabilityKind, EventKind,
    };

    fn plugin() -> WitmPlugin {
        let cap = |kind: CapabilityKind, when: &str| WitCapability {
            kind,
            scope: ScopeWire {
                when: when.to_string(),
                allow: "true".to_string(),
            },
        };
        let input = |name: &str, input_type: InputType| InputSchema {
            name: name.to_string(),
            input_type,
            optional: true,
            default: None,
            description: None,
        };
        let mut p = WitmPlugin::from(PluginManifest {
            name: "secrets".into(),
            namespace: "witmproxy".into(),
            author: String::new(),
            version: "0.1.0".into(),
            description: String::new(),
            license: String::new(),
            url: String::new(),
            publickey: vec![],
            capabilities: vec![
                cap(CapabilityKind::HandleEvent(EventKind::Connect), "true"),
                cap(
                    CapabilityKind::HandleEvent(EventKind::Request),
                    "request.path() != '/health'",
                ),
                cap(CapabilityKind::Logger, "true"),
            ],
            metadata: vec![],
            configuration: vec![
                input("rules", InputType::Secret),
                input("budget", InputType::Number),
                input("strict", InputType::Boolean),
            ],
        });
        p.configuration = vec![UserInput {
            name: "rules".into(),
            value: ActualInput::Secret("stale".into()),
        }];
        p.capabilities.iter_mut().for_each(|c| c.granted = true);
        p
    }

    fn capability<'a>(p: &'a WitmPlugin, kind: &str) -> &'a Capability {
        p.capabilities
            .iter()
            .find(|c| c.inner.kind.to_string() == kind)
            .expect("capability")
    }

    #[test]
    fn configuration_is_typed_and_replaces_what_was_stored() {
        let mut p = plugin();
        let s = parse(
            r#"
            [configuration]
            rules = '[{"placeholder": "x"}]'
            budget = 30
            strict = "yes"
            "#,
        )
        .unwrap();
        apply(&mut p, &s).unwrap();
        let get = |name: &str| {
            p.configuration
                .iter()
                .find(|i| i.name == name)
                .map(|i| i.value.clone())
        };
        assert!(
            matches!(get("rules"), Some(ActualInput::Secret(v)) if v == r#"[{"placeholder": "x"}]"#)
        );
        assert!(
            matches!(get("budget"), Some(ActualInput::Number(n)) if (n - 30.0).abs() < f64::EPSILON)
        );
        assert!(matches!(get("strict"), Some(ActualInput::Boolean(true))));
        assert_eq!(p.configuration.len(), 3, "the stale stored value is gone");
    }

    #[test]
    fn an_undeclared_input_refuses_the_file() {
        let mut p = plugin();
        let s = parse("[configuration]\nrule = 'typo'\n").unwrap();
        let err = apply(&mut p, &s).unwrap_err().to_string();
        assert!(
            err.contains("`rule`") && err.contains("rules, budget, strict"),
            "{err}"
        );
        // Nothing was applied: the stored configuration is untouched.
        assert_eq!(p.configuration.len(), 1);
    }

    #[test]
    fn a_mistyped_value_refuses_the_file() {
        let mut p = plugin();
        let s = parse("[configuration]\nbudget = 'lots'\n").unwrap();
        assert!(apply(&mut p, &s).is_err());
        let s = parse("[configuration]\nrules = [1, 2]\n").unwrap();
        assert!(apply(&mut p, &s).unwrap_err().to_string().contains("array"));
    }

    #[test]
    fn scopes_narrow_and_never_widen() {
        let mut p = plugin();
        let s = parse(
            r#"
            [capabilities.handle_event_connect]
            when = "connect.host() in ['a.example']"
            [capabilities.handle_event_request]
            when = "request.host() in ['a.example']"
            [capabilities.logger]
            allow = "state.calls < 10"
            "#,
        )
        .unwrap();
        apply(&mut p, &s).unwrap();
        // A manifest clause of `true` says nothing, so the file's reads alone.
        assert_eq!(
            capability(&p, "handle_event_connect").inner.scope.when,
            "connect.host() in ['a.example']"
        );
        // Anything else stays, conjoined: the file cannot remove it.
        assert_eq!(
            capability(&p, "handle_event_request").inner.scope.when,
            "(request.path() != '/health') && (request.host() in ['a.example'])"
        );
        assert_eq!(
            capability(&p, "logger").inner.scope.allow,
            "state.calls < 10"
        );
        assert_eq!(capability(&p, "logger").inner.scope.when, "true");
    }

    #[test]
    fn an_unwanted_capability_refuses_the_file() {
        let mut p = plugin();
        let s = parse("[capabilities.clock]\nwhen = 'true'\n").unwrap();
        let err = apply(&mut p, &s).unwrap_err().to_string();
        assert!(
            err.contains("`clock`") && err.contains("handle_event_connect"),
            "{err}"
        );
    }

    #[test]
    fn unknown_keys_are_refused_at_parse() {
        assert!(parse("[configuraton]\nx = 1\n").is_err());
        assert!(parse("[capabilities.logger]\nwhenever = 'x'\n").is_err());
        assert!(parse("").is_ok());
    }

    #[test]
    fn paths_pair_a_component_with_its_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let wasm = dir.path().join("secrets.signed.wasm");
        assert_eq!(path_for(&wasm), dir.path().join("secrets.signed.toml"));
        assert_eq!(component_for(&path_for(&wasm)), None, "no component yet");
        std::fs::write(&wasm, b"\0asm").unwrap();
        assert_eq!(component_for(&path_for(&wasm)), Some(wasm.clone()));
        // No sidecar: nothing applied, nothing wrong.
        let mut p = plugin();
        assert_eq!(apply_beside(&mut p, &wasm).unwrap(), None);
        assert_eq!(p.configuration.len(), 1);
        std::fs::write(path_for(&wasm), "[configuration]\nbudget = 1\n").unwrap();
        assert_eq!(apply_beside(&mut p, &wasm).unwrap(), Some(path_for(&wasm)));
        assert_eq!(p.configuration.len(), 1);
        assert!(
            matches!(p.configuration[0].value, ActualInput::Number(n) if (n - 1.0).abs() < f64::EPSILON)
        );
    }
}
