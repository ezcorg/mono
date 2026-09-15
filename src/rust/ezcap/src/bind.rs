//! Binding call arguments into a CEL activation.
//!
//! Hosts hand the membrane a [`Val`] per argument (already flattened to the
//! same dotted names the environment declared). [`bind`] converts each to the
//! Rust type the declaration used, so a mismatch is an error rather than a
//! silently unbound variable.

use crate::shape::Shape;
use cel_cxx::{Activation, FnMarker, Optional};
use std::collections::HashMap;

/// A flattened argument value.
#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    Bool(bool),
    Int(i64),
    Double(f64),
    Str(String),
    Bytes(Vec<u8>),
    List(Vec<Val>),
    /// `None` binds a CEL optional with no value.
    Opt(Option<Box<Val>>),
    /// String-keyed.
    Map(Vec<(String, Val)>),
}

impl Val {
    /// Saturating: WIT `u64` above `i64::MAX` clamps.
    pub fn uint(v: u64) -> Val {
        Val::Int(i64::try_from(v).unwrap_or(i64::MAX))
    }
}

impl From<&str> for Val {
    fn from(s: &str) -> Self {
        Val::Str(s.to_string())
    }
}
impl From<String> for Val {
    fn from(s: String) -> Self {
        Val::Str(s)
    }
}
impl From<i64> for Val {
    fn from(v: i64) -> Self {
        Val::Int(v)
    }
}
impl From<bool> for Val {
    fn from(v: bool) -> Self {
        Val::Bool(v)
    }
}
impl From<Vec<String>> for Val {
    fn from(v: Vec<String>) -> Self {
        Val::List(v.into_iter().map(Val::Str).collect())
    }
}
impl From<Vec<u8>> for Val {
    fn from(v: Vec<u8>) -> Self {
        Val::Bytes(v)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BindError {
    #[error("`{name}`: expected {shape}, got {got}")]
    Mismatch {
        name: String,
        shape: Shape,
        got: String,
    },
    #[error("`{name}`: {0}", name = .1)]
    Cel(cel_cxx::Error, String),
}

fn kind_of(v: &Val) -> &'static str {
    match v {
        Val::Bool(_) => "bool",
        Val::Int(_) => "int",
        Val::Double(_) => "double",
        Val::Str(_) => "string",
        Val::Bytes(_) => "bytes",
        Val::List(_) => "list",
        Val::Opt(_) => "optional",
        Val::Map(_) => "map",
    }
}

fn mismatch(name: &str, shape: &Shape, got: &Val) -> BindError {
    BindError::Mismatch {
        name: name.to_string(),
        shape: shape.clone(),
        got: kind_of(got).to_string(),
    }
}

/// Bind `val` as `name` with the declared `shape`.
pub fn bind<'f, Fm: FnMarker>(
    act: Activation<'f, Fm>,
    name: &str,
    shape: &Shape,
    val: &Val,
) -> Result<Activation<'f, Fm>, BindError> {
    let cel = |e: cel_cxx::Error| BindError::Cel(e, name.to_string());
    match (shape, val) {
        (Shape::Bool, Val::Bool(v)) => act.bind_variable(name, *v).map_err(cel),
        (Shape::Int, Val::Int(v)) => act.bind_variable(name, *v).map_err(cel),
        (Shape::Double, Val::Double(v)) => act.bind_variable(name, *v).map_err(cel),
        (Shape::Double, Val::Int(v)) => act.bind_variable(name, *v as f64).map_err(cel),
        (Shape::String, Val::Str(v)) => act.bind_variable(name, v.clone()).map_err(cel),
        (Shape::Bytes, Val::Bytes(v)) => act.bind_variable(name, v.clone()).map_err(cel),
        (Shape::List(inner), Val::List(items)) => match **inner {
            Shape::Bool => act
                .bind_variable(
                    name,
                    collect(items, name, shape, |v| match v {
                        Val::Bool(b) => Some(*b),
                        _ => None,
                    })?,
                )
                .map_err(cel),
            Shape::Int => act
                .bind_variable(
                    name,
                    collect(items, name, shape, |v| match v {
                        Val::Int(i) => Some(*i),
                        _ => None,
                    })?,
                )
                .map_err(cel),
            Shape::Double => act
                .bind_variable(
                    name,
                    collect(items, name, shape, |v| match v {
                        Val::Double(d) => Some(*d),
                        Val::Int(i) => Some(*i as f64),
                        _ => None,
                    })?,
                )
                .map_err(cel),
            Shape::String => act
                .bind_variable(
                    name,
                    collect(items, name, shape, |v| match v {
                        Val::Str(s) => Some(s.clone()),
                        _ => None,
                    })?,
                )
                .map_err(cel),
            Shape::Bytes => act
                .bind_variable(
                    name,
                    collect(items, name, shape, |v| match v {
                        Val::Bytes(b) => Some(b.clone()),
                        _ => None,
                    })?,
                )
                .map_err(cel),
            _ => Err(mismatch(name, shape, val)),
        },
        (Shape::Optional(inner), Val::Opt(opt)) => match (&**inner, opt.as_deref()) {
            (Shape::Bool, None) => act
                .bind_variable(name, Optional::<bool>::none())
                .map_err(cel),
            (Shape::Bool, Some(Val::Bool(b))) => {
                act.bind_variable(name, Optional::new(*b)).map_err(cel)
            }
            (Shape::Int, None) => act
                .bind_variable(name, Optional::<i64>::none())
                .map_err(cel),
            (Shape::Int, Some(Val::Int(i))) => {
                act.bind_variable(name, Optional::new(*i)).map_err(cel)
            }
            (Shape::Double, None) => act
                .bind_variable(name, Optional::<f64>::none())
                .map_err(cel),
            (Shape::Double, Some(Val::Double(d))) => {
                act.bind_variable(name, Optional::new(*d)).map_err(cel)
            }
            (Shape::String, None) => act
                .bind_variable(name, Optional::<String>::none())
                .map_err(cel),
            (Shape::String, Some(Val::Str(s))) => act
                .bind_variable(name, Optional::new(s.clone()))
                .map_err(cel),
            (Shape::Bytes, None) => act
                .bind_variable(name, Optional::<Vec<u8>>::none())
                .map_err(cel),
            (Shape::Bytes, Some(Val::Bytes(b))) => act
                .bind_variable(name, Optional::new(b.clone()))
                .map_err(cel),
            (Shape::List(elem), None) if **elem == Shape::String => act
                .bind_variable(name, Optional::<Vec<String>>::none())
                .map_err(cel),
            (Shape::List(elem), Some(Val::List(items))) if **elem == Shape::String => {
                let v = collect(items, name, shape, |v| match v {
                    Val::Str(s) => Some(s.clone()),
                    _ => None,
                })?;
                act.bind_variable(name, Optional::new(v)).map_err(cel)
            }
            _ => Err(mismatch(name, shape, val)),
        },
        // A bare value for an optional declaration is fine: wrap it.
        (Shape::Optional(_), other) if !matches!(other, Val::Opt(_)) => {
            bind(act, name, shape, &Val::Opt(Some(Box::new(other.clone()))))
        }
        (Shape::Map(inner), Val::Map(entries)) => match **inner {
            Shape::Bool => act
                .bind_variable(
                    name,
                    collect_map(entries, name, shape, |v| match v {
                        Val::Bool(b) => Some(*b),
                        _ => None,
                    })?,
                )
                .map_err(cel),
            Shape::Int => act
                .bind_variable(
                    name,
                    collect_map(entries, name, shape, |v| match v {
                        Val::Int(i) => Some(*i),
                        _ => None,
                    })?,
                )
                .map_err(cel),
            Shape::Double => act
                .bind_variable(
                    name,
                    collect_map(entries, name, shape, |v| match v {
                        Val::Double(d) => Some(*d),
                        Val::Int(i) => Some(*i as f64),
                        _ => None,
                    })?,
                )
                .map_err(cel),
            Shape::String => act
                .bind_variable(
                    name,
                    collect_map(entries, name, shape, |v| match v {
                        Val::Str(s) => Some(s.clone()),
                        _ => None,
                    })?,
                )
                .map_err(cel),
            Shape::Bytes => act
                .bind_variable(
                    name,
                    collect_map(entries, name, shape, |v| match v {
                        Val::Bytes(b) => Some(b.clone()),
                        _ => None,
                    })?,
                )
                .map_err(cel),
            Shape::List(ref elem) if **elem == Shape::String => {
                let m = collect_map(entries, name, shape, |v| match v {
                    Val::List(items) => items
                        .iter()
                        .map(|i| match i {
                            Val::Str(s) => Some(s.clone()),
                            _ => None,
                        })
                        .collect::<Option<Vec<String>>>(),
                    _ => None,
                })?;
                act.bind_variable(name, m).map_err(cel)
            }
            _ => Err(mismatch(name, shape, val)),
        },
        _ => Err(mismatch(name, shape, val)),
    }
}

fn collect<T>(
    items: &[Val],
    name: &str,
    shape: &Shape,
    f: impl Fn(&Val) -> Option<T>,
) -> Result<Vec<T>, BindError> {
    items
        .iter()
        .map(|v| f(v).ok_or_else(|| mismatch(name, shape, v)))
        .collect()
}

fn collect_map<T>(
    entries: &[(String, Val)],
    name: &str,
    shape: &Shape,
    f: impl Fn(&Val) -> Option<T>,
) -> Result<HashMap<String, T>, BindError> {
    entries
        .iter()
        .map(|(k, v)| {
            f(v).map(|t| (k.clone(), t))
                .ok_or_else(|| mismatch(name, shape, v))
        })
        .collect()
}
