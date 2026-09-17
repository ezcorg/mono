//! Scaffolds for authoring capabilities (`icanhaz capability new|wrap`):
//! a Rust component crate with the WIT vendored, a devShell, an agent
//! instructions file, and a `src/lib.rs` generated from the WIT: a
//! passthrough for function-only interfaces, typed stubs where resources or
//! streams are involved.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context as _};
use wit_parser::{Resolve, Type, TypeDefKind};

/// What the new component's world says.
pub struct WorldSpec {
    /// Interfaces the component exports (qualified: `icanhaz:nocap/workspace@0.1.0`).
    pub exports: Vec<String>,
    /// Interfaces it imports.
    pub imports: Vec<String>,
}

/// Where the daemon's WIT lives (the packages a scaffold vendors).
pub fn default_wit_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../wit")
}

fn snake(s: &str) -> String {
    let mut out = s.replace('-', "_");
    if matches!(
        out.as_str(),
        "type"
            | "fn"
            | "impl"
            | "mod"
            | "self"
            | "use"
            | "in"
            | "as"
            | "ref"
            | "move"
            | "match"
            | "loop"
            | "let"
            | "if"
            | "else"
            | "where"
            | "async"
            | "await"
            | "dyn"
            | "crate"
    ) {
        out.push('_');
    }
    out
}

fn camel(s: &str) -> String {
    s.split(['-', '_'])
        .filter(|p| !p.is_empty())
        .map(|p| {
            let mut c = p.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect()
}

/// `ns:pkg/iface@ver` → (`ns`, `pkg`, `iface`, `Some(ver)`).
fn split_interface(qualified: &str) -> anyhow::Result<(String, String, String, Option<String>)> {
    let (pkg, rest) = qualified
        .split_once('/')
        .with_context(|| format!("`{qualified}`: expected `ns:pkg/interface[@version]`"))?;
    let (ns, name) = pkg
        .split_once(':')
        .with_context(|| format!("`{qualified}`: expected `ns:pkg/interface[@version]`"))?;
    let (iface, ver) = match rest.split_once('@') {
        Some((i, v)) => (i, Some(v.to_string())),
        None => (rest, None),
    };
    Ok((ns.to_string(), name.to_string(), iface.to_string(), ver))
}

/// The Rust type for a WIT type in guest bindings, with `upstream::` for
/// named types; `None` when it involves a resource, stream or future.
fn rust_type(resolve: &Resolve, ty: &Type) -> Option<String> {
    Some(match ty {
        Type::Bool => "bool".into(),
        Type::U8 => "u8".into(),
        Type::U16 => "u16".into(),
        Type::U32 => "u32".into(),
        Type::U64 => "u64".into(),
        Type::S8 => "i8".into(),
        Type::S16 => "i16".into(),
        Type::S32 => "i32".into(),
        Type::S64 => "i64".into(),
        Type::F32 => "f32".into(),
        Type::F64 => "f64".into(),
        Type::Char => "char".into(),
        Type::String => "String".into(),
        Type::ErrorContext => return None,
        Type::Id(id) => {
            let def = resolve.types.get(*id)?;
            match &def.kind {
                TypeDefKind::Type(inner) => match &def.name {
                    Some(n) => format!("upstream::{}", camel(n)),
                    None => rust_type(resolve, inner)?,
                },
                TypeDefKind::Record(_)
                | TypeDefKind::Variant(_)
                | TypeDefKind::Enum(_)
                | TypeDefKind::Flags(_) => format!("upstream::{}", camel(def.name.as_deref()?)),
                TypeDefKind::List(inner) => format!("Vec<{}>", rust_type(resolve, inner)?),
                TypeDefKind::FixedSizeList(inner, n) => {
                    format!("[{}; {n}]", rust_type(resolve, inner)?)
                }
                TypeDefKind::Option(inner) => format!("Option<{}>", rust_type(resolve, inner)?),
                TypeDefKind::Result(r) => format!(
                    "Result<{}, {}>",
                    r.ok.as_ref()
                        .map(|t| rust_type(resolve, t))
                        .unwrap_or(Some("()".into()))?,
                    r.err
                        .as_ref()
                        .map(|t| rust_type(resolve, t))
                        .unwrap_or(Some("()".into()))?,
                ),
                TypeDefKind::Tuple(t) => format!(
                    "({})",
                    t.types
                        .iter()
                        .map(|t| rust_type(resolve, t))
                        .collect::<Option<Vec<_>>>()?
                        .join(", ")
                ),
                TypeDefKind::Map(k, v) => format!(
                    "Vec<({}, {})>",
                    rust_type(resolve, k)?,
                    rust_type(resolve, v)?
                ),
                TypeDefKind::Handle(_)
                | TypeDefKind::Resource
                | TypeDefKind::Future(_)
                | TypeDefKind::Stream(_)
                | TypeDefKind::Unknown => return None,
            }
        }
    })
}

/// How a value of a WIT type is passed to an *imported* function in guest
/// bindings, which borrow strings, lists, records and variants.
fn rust_arg(resolve: &Resolve, ty: &Type, name: &str) -> String {
    fn borrowed(resolve: &Resolve, ty: &Type) -> bool {
        match ty {
            Type::String => true,
            Type::Id(id) => match resolve.types.get(*id).map(|d| &d.kind) {
                Some(TypeDefKind::Type(inner)) => borrowed(resolve, inner),
                Some(
                    TypeDefKind::List(_)
                    | TypeDefKind::FixedSizeList(..)
                    | TypeDefKind::Record(_)
                    | TypeDefKind::Variant(_)
                    | TypeDefKind::Tuple(_)
                    | TypeDefKind::Map(..),
                ) => true,
                _ => false,
            },
            _ => false,
        }
    }
    let inner_of_option = |ty: &Type| -> Option<Type> {
        let Type::Id(id) = ty else { return None };
        match resolve.types.get(*id).map(|d| &d.kind) {
            Some(TypeDefKind::Option(inner)) => Some(*inner),
            Some(TypeDefKind::Type(Type::Id(inner))) => {
                match resolve.types.get(*inner).map(|d| &d.kind) {
                    Some(TypeDefKind::Option(inner)) => Some(*inner),
                    _ => None,
                }
            }
            _ => None,
        }
    };
    if let Some(inner) = inner_of_option(ty) {
        if !borrowed(resolve, &inner) {
            return name.to_string();
        }
        return match inner {
            Type::String => format!("{name}.as_deref()"),
            Type::Id(id) => match resolve.types.get(id).map(|d| &d.kind) {
                Some(TypeDefKind::List(_)) => format!("{name}.as_deref()"),
                _ => format!("{name}.as_ref()"),
            },
            _ => name.to_string(),
        };
    }
    if borrowed(resolve, ty) {
        format!("&{name}")
    } else {
        name.to_string()
    }
}

/// The `impl Guest` body for one exported interface: forwards to the same
/// import when the function's types allow, else a typed stub.
fn guest_impl(resolve: &Resolve, iface_name: &str, wrapping: bool) -> anyhow::Result<String> {
    let (ns, pkg, iface, ver) = split_interface(iface_name)?;
    let iface_id = crate_env_find(resolve, &format!("{ns}:{pkg}"), &iface, ver.as_deref())
        .with_context(|| format!("`{iface_name}` is not in the vendored WIT"))?;
    let interface = &resolve.interfaces[iface_id];
    let module = format!("{}::{}::{}", snake(&ns), snake(&pkg), snake(&iface));
    let mut out = String::new();
    out.push_str(&format!(
        "use bindings::exports::{module}::Guest as {}Guest;\n",
        camel(&iface)
    ));
    if wrapping {
        out.push_str(&format!("use bindings::{module} as upstream;\n\n"));
    } else {
        out.push_str(&format!(
            "#[allow(unused_imports)]\nuse bindings::exports::{module} as upstream;\n\n"
        ));
    }
    let has_resources = interface.types.values().any(|t| {
        matches!(
            resolve.types.get(*t).map(|d| &d.kind),
            Some(TypeDefKind::Resource)
        )
    });
    out.push_str(&format!("impl {}Guest for Component {{\n", camel(&iface)));
    if has_resources {
        out.push_str("    // This interface has resources: each needs an associated type here\n    // (`type Descriptor = MyDescriptor;`) and a `Guest<Name>` impl. See the\n    // wit-bindgen guide for resources; the functions below are the free ones.\n");
    }
    for (fname, func) in &interface.functions {
        if !matches!(func.kind, wit_parser::FunctionKind::Freestanding) {
            continue;
        }
        let params: Vec<(String, Option<String>)> = func
            .params
            .iter()
            .map(|(name, ty)| (snake(name), rust_type(resolve, ty)))
            .collect();
        let ret = func.result.as_ref().map(|t| rust_type(resolve, t));
        let simple = params.iter().all(|(_, t)| t.is_some()) && !matches!(ret, Some(None));
        let sig_params = params
            .iter()
            .map(|(n, t)| {
                format!(
                    "{n}: {}",
                    t.clone()
                        .unwrap_or_else(|| "/* resource or stream */ ()".into())
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        let sig_ret = match &ret {
            None => String::new(),
            Some(Some(t)) => format!(" -> {t}"),
            Some(None) => " -> /* resource or stream */ ()".to_string(),
        };
        out.push_str(&format!(
            "    fn {}({sig_params}){sig_ret} {{\n",
            snake(fname)
        ));
        if wrapping && simple {
            let args = func
                .params
                .iter()
                .map(|(name, ty)| rust_arg(resolve, ty, &snake(name)))
                .collect::<Vec<_>>()
                .join(", ");
            out.push_str(&format!("        // Passthrough: forward to the wrapped capability. Refuse or rewrite here.\n        upstream::{}({args})\n", snake(fname)));
        } else if wrapping {
            out.push_str(&format!("        // `{fname}` carries a resource or a stream; forward it by hand.\n        todo!(\"forward {fname} to upstream::{}\")\n", snake(fname)));
        } else {
            out.push_str(&format!("        todo!(\"implement {fname}\")\n"));
        }
        out.push_str("    }\n");
    }
    out.push_str("}\n");
    Ok(out)
}

fn crate_env_find(
    resolve: &Resolve,
    package: &str,
    iface: &str,
    version: Option<&str>,
) -> Option<wit_parser::InterfaceId> {
    resolve.interfaces.iter().find_map(|(id, i)| {
        let pkg = resolve.packages.get(i.package?)?;
        let name = &pkg.name;
        let matches_pkg = format!("{}:{}", name.namespace, name.name) == package
            && version
                .map(|v| {
                    name.version
                        .as_ref()
                        .map(|pv| pv.to_string() == v)
                        .unwrap_or(false)
                })
                .unwrap_or(true);
        (matches_pkg && i.name.as_deref() == Some(iface)).then_some(id)
    })
}

/// Copy every `.wit` package file and `deps/` package directory from
/// `wit_dir` into `<out>/wit/deps/`, so the scaffold resolves alone.
fn vendor_wit(wit_dir: &Path, out: &Path) -> anyhow::Result<()> {
    let deps = out.join("wit").join("deps");
    std::fs::create_dir_all(&deps)?;
    // The daemon's own package: its top-level .wit files become one deps package.
    let own = deps.join("icanhaz-nocap");
    std::fs::create_dir_all(&own)?;
    for entry in std::fs::read_dir(wit_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "wit") {
            std::fs::copy(&path, own.join(entry.file_name()))?;
        }
    }
    let src_deps = wit_dir.join("deps");
    if src_deps.is_dir() {
        for entry in std::fs::read_dir(&src_deps)? {
            let entry = entry?;
            if entry.path().is_dir() {
                let dst = deps.join(entry.file_name());
                std::fs::create_dir_all(&dst)?;
                for f in std::fs::read_dir(entry.path())? {
                    let f = f?;
                    if f.path().is_file() {
                        std::fs::copy(f.path(), dst.join(f.file_name()))?;
                    }
                }
            }
        }
    }
    Ok(())
}

/// Generate a Rust capability crate at `out`.
pub fn rust_capability(
    out: &Path,
    name: &str,
    description: &str,
    spec: &WorldSpec,
    wit_dir: &Path,
    wrapping: bool,
) -> anyhow::Result<()> {
    if out.exists() && std::fs::read_dir(out)?.next().is_some() {
        bail!("{} exists and is not empty", out.display());
    }
    if spec.exports.is_empty() {
        bail!("a capability exports at least one interface");
    }
    let mut resolve = Resolve::default();
    resolve
        .push_dir(wit_dir)
        .with_context(|| format!("resolving WIT in {}", wit_dir.display()))?;
    std::fs::create_dir_all(out.join("src"))?;
    vendor_wit(wit_dir, out)?;

    let crate_name = name.replace('-', "_");
    let mut world =
        format!("package ezco:{name}@0.1.0;\n\n/// {description}\nworld capability {{\n");
    for i in &spec.imports {
        world.push_str(&format!("  import {i};\n"));
    }
    for e in &spec.exports {
        world.push_str(&format!("  export {e};\n"));
    }
    world.push_str("}\n");
    std::fs::write(out.join("wit").join("world.wit"), world)?;

    let mut lib = String::from(
        "//! An icanhaz capability. See AGENTS.md for the rules and the build.\n\n#[allow(warnings)]\nmod bindings {\n    wit_bindgen::generate!({\n        world: \"capability\",\n        generate_all,\n    });\n}\n\nstruct Component;\n\n",
    );
    for e in &spec.exports {
        lib.push_str(&guest_impl(
            &resolve,
            e,
            wrapping && spec.imports.contains(e),
        )?);
        lib.push('\n');
    }
    lib.push_str("bindings::export!(Component with_types_in bindings);\n");
    std::fs::write(out.join("src").join("lib.rs"), lib)?;

    let what = if wrapping {
        format!("wraps `{}`: it imports and exports the same interface, forwarding every call it does not refuse or rewrite", spec.exports.join(", "))
    } else {
        format!("provides `{}`", spec.exports.join(", "))
    };
    let fill = |t: &str| {
        t.replace("{{name}}", name)
            .replace("{{crate}}", &crate_name)
            .replace("{{description}}", description)
            .replace("{{what}}", &what)
    };
    std::fs::write(
        out.join("Cargo.toml"),
        fill(include_str!("../templates/rust/Cargo.toml.tmpl")),
    )?;
    std::fs::write(
        out.join("flake.nix"),
        fill(include_str!("../templates/rust/flake.nix")),
    )?;
    std::fs::write(
        out.join("AGENTS.md"),
        fill(include_str!("../templates/rust/AGENTS.md.tmpl")),
    )?;
    std::fs::write(
        out.join(".gitignore"),
        include_str!("../templates/rust/gitignore"),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_types_render_the_wit_bindgen_way() {
        assert_eq!(snake("root-path"), "root_path");
        assert_eq!(snake("type"), "type_");
        assert_eq!(camel("completion-request"), "CompletionRequest");
        assert_eq!(
            split_interface("icanhaz:nocap/workspace@0.1.0").unwrap(),
            (
                "icanhaz".into(),
                "nocap".into(),
                "workspace".into(),
                Some("0.1.0".into())
            )
        );
    }

    #[test]
    fn a_function_only_interface_becomes_a_passthrough_and_streams_become_stubs() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("ws-wrap");
        rust_capability(
            &out,
            "ws-wrap",
            "wraps workspace",
            &WorldSpec {
                exports: vec!["icanhaz:nocap/workspace@0.1.0".into()],
                imports: vec!["icanhaz:nocap/workspace@0.1.0".into()],
            },
            &default_wit_dir(),
            true,
        )
        .unwrap();
        let lib = std::fs::read_to_string(out.join("src/lib.rs")).unwrap();
        assert!(
            lib.contains("fn root_path(grant: String) -> Result<String, String> {"),
            "{lib}"
        );
        assert!(lib.contains("upstream::root_path(&grant)"), "{lib}");
        assert!(out.join("wit/deps/icanhaz-nocap/workspace.wit").exists());
        assert!(out.join("wit/deps/ezco-ezcap-0.1.0/package.wit").exists());
        let world = std::fs::read_to_string(out.join("wit/world.wit")).unwrap();
        assert!(world.contains("import icanhaz:nocap/workspace@0.1.0;"));
        assert!(world.contains("export icanhaz:nocap/workspace@0.1.0;"));
        assert!(std::fs::read_to_string(out.join("AGENTS.md"))
            .unwrap()
            .contains("ws_wrap.wasm"));

        // Streams: a typed stub, not a forward.
        let out = dir.path().join("proc-wrap");
        rust_capability(
            &out,
            "proc-wrap",
            "wraps process",
            &WorldSpec {
                exports: vec!["icanhaz:nocap/process@0.1.0".into()],
                imports: vec!["icanhaz:nocap/process@0.1.0".into()],
            },
            &default_wit_dir(),
            true,
        )
        .unwrap();
        let lib = std::fs::read_to_string(out.join("src/lib.rs")).unwrap();
        assert!(
            lib.contains("todo!(\"forward spawn to upstream::spawn\")"),
            "{lib}"
        );

        // A novel capability: stubs to implement.
        let out = dir.path().join("mine");
        rust_capability(
            &out,
            "mine",
            "a new workspace provider",
            &WorldSpec {
                exports: vec!["icanhaz:nocap/workspace@0.1.0".into()],
                imports: vec![],
            },
            &default_wit_dir(),
            false,
        )
        .unwrap();
        let lib = std::fs::read_to_string(out.join("src/lib.rs")).unwrap();
        assert!(lib.contains("todo!(\"implement root-path\")"), "{lib}");
        assert!(rust_capability(
            &out,
            "mine",
            "",
            &WorldSpec {
                exports: vec![],
                imports: vec![]
            },
            &default_wit_dir(),
            false
        )
        .is_err());
    }
}
