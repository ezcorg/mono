//! The CEL environment a capability's scope is checked against.
//!
//! [`CallEnv::for_kind`] resolves a [`Kind`] path against a WIT [`Resolve`]
//! and produces one declaration set for the whole capability: the union of
//! every method's flattened parameters under `call.args`, plus the fixed
//! variables every call binds (`call.method`, `call.bytes`, `caller.*`,
//! `state.*`). The same name with two different shapes across methods is an
//! error at generation time rather than a surprise at consent time.
//!
//! Variables are declared with dotted names. CEL resolves a qualified
//! identifier against declared names before treating it as a field access, so
//! `call.args.key` is a plain `string` variable to the type checker and no
//! message descriptors are needed.

use crate::shape::{Decl, Shape, flatten_params, method_name, resource_of};
use crate::types::{Kind, KindError};
use cel_cxx::{EnvBuilder, FnMarker, Optional, RuntimeMarker};
use std::collections::{BTreeMap, HashMap};
use wit_parser::{InterfaceId, Resolve, TypeDefKind};

/// Fixed declarations bound on every call, independent of the interface.
pub const CALL_METHOD: &str = "call.method";
pub const CALL_BYTES: &str = "call.bytes";
pub const CALLER_PLUGIN: &str = "caller.plugin";
pub const CALLER_KEY: &str = "caller.key";
pub const CALLER_PEER: &str = "caller.peer";
pub const CALLER_ORIGIN: &str = "caller.origin";
pub const STATE_CALLS: &str = "state.calls";
pub const STATE_BYTES: &str = "state.bytes";

/// The declarations for one capability kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallEnv {
    pub kind: Kind,
    /// Method names this kind exposes (bare, kebab-case as in WIT).
    pub methods: Vec<String>,
    /// Every declared variable, fixed ones first, then `call.args.*` sorted by name.
    pub decls: Vec<Decl>,
}

#[derive(Debug, thiserror::Error)]
pub enum EnvError {
    #[error(transparent)]
    Kind(#[from] KindError),
    #[error("no interface `{0}` in the resolved packages")]
    NoInterface(String),
    #[error("no function or resource `{item}` in interface `{interface}`")]
    NoItem { interface: String, item: String },
    #[error("`{name}` has shape `{a}` on `{method_a}` but `{b}` on `{method_b}`")]
    Conflict {
        name: String,
        a: Shape,
        method_a: String,
        b: Shape,
        method_b: String,
    },
    #[error("CEL environment error: {0}")]
    Cel(String),
}

impl CallEnv {
    /// Generate the environment for `kind` from `resolve`.
    ///
    /// The kind's path selects the functions: none → every function in the
    /// interface; `resource` → that resource's methods; `resource.method` or
    /// `function` → exactly one.
    pub fn for_kind(resolve: &Resolve, kind: &Kind) -> Result<CallEnv, EnvError> {
        let parts = kind.parse()?;
        let iface_id = find_interface(
            resolve,
            &parts.package,
            &parts.interface,
            parts.version.as_deref(),
        )
        .ok_or_else(|| EnvError::NoInterface(format!("{}/{}", parts.package, parts.interface)))?;
        let iface = resolve.interfaces.get(iface_id).ok_or_else(|| {
            EnvError::NoInterface(format!("{}/{}", parts.package, parts.interface))
        })?;

        // Resource type ids in this interface, by name.
        let resources: HashMap<&str, wit_parser::TypeId> = iface
            .types
            .iter()
            .filter(|(_, id)| {
                resolve
                    .types
                    .get(**id)
                    .is_some_and(|d| matches!(d.kind, TypeDefKind::Resource))
            })
            .map(|(name, id)| (name.as_str(), *id))
            .collect();

        let selected: Vec<&wit_parser::Function> = match parts.path.as_slice() {
            [] => iface.functions.values().collect(),
            [item] => {
                if let Some(res_id) = resources.get(item.as_str()) {
                    iface
                        .functions
                        .values()
                        .filter(|f| resource_of(f) == Some(*res_id))
                        .collect()
                } else if let Some(f) = iface.functions.get(item.as_str()) {
                    vec![f]
                } else {
                    return Err(EnvError::NoItem {
                        interface: parts.interface.clone(),
                        item: item.clone(),
                    });
                }
            }
            [resource, method] => {
                let res_id = *resources
                    .get(resource.as_str())
                    .ok_or_else(|| EnvError::NoItem {
                        interface: parts.interface.clone(),
                        item: resource.clone(),
                    })?;
                let f = iface
                    .functions
                    .values()
                    .find(|f| resource_of(f) == Some(res_id) && method_name(f) == *method)
                    .ok_or_else(|| EnvError::NoItem {
                        interface: parts.interface.clone(),
                        item: format!("{resource}.{method}"),
                    })?;
                vec![f]
            }
            _ => return Err(EnvError::Kind(KindError::BadPath)),
        };

        let mut methods: Vec<String> = selected.iter().map(|f| method_name(f)).collect();
        methods.sort();
        methods.dedup();

        // Union of every method's arguments, checking for conflicting shapes.
        let mut merged: BTreeMap<String, Decl> = BTreeMap::new();
        for func in &selected {
            for decl in flatten_params(resolve, func, "call.args") {
                match merged.get_mut(&decl.name) {
                    None => {
                        merged.insert(decl.name.clone(), decl);
                    }
                    Some(existing) if existing.shape == decl.shape => {
                        existing.methods.extend(decl.methods);
                    }
                    Some(existing) => {
                        return Err(EnvError::Conflict {
                            name: decl.name.clone(),
                            a: existing.shape.clone(),
                            method_a: existing.methods.first().cloned().unwrap_or_default(),
                            b: decl.shape.clone(),
                            method_b: decl.methods.first().cloned().unwrap_or_default(),
                        });
                    }
                }
            }
        }

        let mut decls = fixed_decls();
        decls.extend(merged.into_values());
        Ok(CallEnv {
            kind: kind.clone(),
            methods,
            decls,
        })
    }

    /// Declare every bindable variable on a CEL environment builder. Opaque
    /// declarations are skipped: a clause that names one fails to compile,
    /// which is the intended signal.
    pub fn apply<'f, Fm: FnMarker, Rm: RuntimeMarker>(
        &self,
        mut builder: EnvBuilder<'f, Fm, Rm>,
    ) -> Result<EnvBuilder<'f, Fm, Rm>, EnvError> {
        for decl in &self.decls {
            if !decl.shape.is_bindable() {
                continue;
            }
            builder = declare(builder, &decl.name, &decl.shape)
                .map_err(|e| EnvError::Cel(e.to_string()))?;
        }
        Ok(builder)
    }

    /// The declarations that are addressable from a clause (everything but
    /// opaque ones).
    pub fn addressable(&self) -> impl Iterator<Item = &Decl> {
        self.decls.iter().filter(|d| d.shape.is_bindable())
    }

    /// The declarations a clause cannot use, with the reason.
    pub fn opaque(&self) -> impl Iterator<Item = (&str, &str)> {
        self.decls.iter().filter_map(|d| match &d.shape {
            Shape::Opaque(why) => Some((d.name.as_str(), why.as_str())),
            _ => None,
        })
    }

    /// A plain-text listing for documentation beside the WIT.
    pub fn describe(&self) -> String {
        let mut s = format!("# {}\n", self.kind);
        if !self.methods.is_empty() {
            s.push_str(&format!("methods: {}\n", self.methods.join(", ")));
        }
        for d in &self.decls {
            let methods = if d.methods.is_empty() {
                String::new()
            } else {
                format!("    [{}]", d.methods.join(", "))
            };
            s.push_str(&format!("{}: {}{}\n", d.name, d.shape, methods));
        }
        s
    }
}

/// `call.method`, `call.bytes`, `caller.*`, `state.*`: bound on every call.
pub fn fixed_decls() -> Vec<Decl> {
    let fixed = |name: &str, shape: Shape| Decl {
        name: name.to_string(),
        shape,
        methods: Vec::new(),
    };
    vec![
        fixed(CALL_METHOD, Shape::String),
        fixed(CALL_BYTES, Shape::Int),
        fixed(CALLER_PLUGIN, Shape::String),
        fixed(CALLER_KEY, Shape::String),
        fixed(CALLER_PEER, Shape::String),
        fixed(CALLER_ORIGIN, Shape::String),
        fixed(STATE_CALLS, Shape::Int),
        fixed(STATE_BYTES, Shape::Int),
    ]
}

/// Declare one variable by shape. cel-cxx declares by Rust type, so this is a
/// dispatch table over the shapes [`Shape::is_bindable`] admits.
pub fn declare<'f, Fm: FnMarker, Rm: RuntimeMarker>(
    b: EnvBuilder<'f, Fm, Rm>,
    name: &str,
    shape: &Shape,
) -> Result<EnvBuilder<'f, Fm, Rm>, cel_cxx::Error> {
    match shape {
        Shape::Bool => b.declare_variable::<bool>(name),
        Shape::Int => b.declare_variable::<i64>(name),
        Shape::Double => b.declare_variable::<f64>(name),
        Shape::String => b.declare_variable::<String>(name),
        Shape::Bytes => b.declare_variable::<Vec<u8>>(name),
        Shape::List(inner) => match **inner {
            Shape::Bool => b.declare_variable::<Vec<bool>>(name),
            Shape::Int => b.declare_variable::<Vec<i64>>(name),
            Shape::Double => b.declare_variable::<Vec<f64>>(name),
            Shape::String => b.declare_variable::<Vec<String>>(name),
            Shape::Bytes => b.declare_variable::<Vec<Vec<u8>>>(name),
            _ => Ok(b),
        },
        Shape::Optional(inner) => match **inner {
            Shape::Bool => b.declare_variable::<Optional<bool>>(name),
            Shape::Int => b.declare_variable::<Optional<i64>>(name),
            Shape::Double => b.declare_variable::<Optional<f64>>(name),
            Shape::String => b.declare_variable::<Optional<String>>(name),
            Shape::Bytes => b.declare_variable::<Optional<Vec<u8>>>(name),
            Shape::List(ref elem) if **elem == Shape::String => {
                b.declare_variable::<Optional<Vec<String>>>(name)
            }
            _ => Ok(b),
        },
        Shape::Map(inner) => match **inner {
            Shape::Bool => b.declare_variable::<HashMap<String, bool>>(name),
            Shape::Int => b.declare_variable::<HashMap<String, i64>>(name),
            Shape::Double => b.declare_variable::<HashMap<String, f64>>(name),
            Shape::String => b.declare_variable::<HashMap<String, String>>(name),
            Shape::Bytes => b.declare_variable::<HashMap<String, Vec<u8>>>(name),
            Shape::List(ref elem) if **elem == Shape::String => {
                b.declare_variable::<HashMap<String, Vec<String>>>(name)
            }
            _ => Ok(b),
        },
        Shape::Opaque(_) => Ok(b),
    }
}

/// Find an interface by `ns:pkg`, name and optional version.
pub fn find_interface(
    resolve: &Resolve,
    package: &str,
    interface: &str,
    version: Option<&str>,
) -> Option<InterfaceId> {
    resolve.interfaces.iter().find_map(|(id, iface)| {
        let name = iface.name.as_deref()?;
        if name != interface {
            return None;
        }
        let pkg = resolve.packages.get(iface.package?)?;
        let pkg_name = format!("{}:{}", pkg.name.namespace, pkg.name.name);
        if pkg_name != package {
            return None;
        }
        if let Some(v) = version {
            let pv = pkg.name.version.as_ref()?.to_string();
            if pv != v {
                return None;
            }
        }
        Some(id)
    })
}
