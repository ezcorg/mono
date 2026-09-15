//! The WIT-to-CEL type model.
//!
//! A WIT method signature is flattened into a list of *declarations*: dotted
//! CEL variable names with a [`Shape`] each. Records flatten into their fields
//! (`call.args.ctx.host`), tuples into indices (`call.args.pair.0`), and the
//! map-shaped idiom `list<tuple<string, T>>` becomes a CEL map (`headers`,
//! `query` in witmproxy's `request-context`). Anything CEL cannot express is
//! declared [`Shape::Opaque`] and is not addressable from a clause, which the
//! rendering profile reports rather than silently ignoring.
//!
//! Integers all map to CEL `int`. WIT `u64` values above `i64::MAX` saturate at
//! bind time; every budget, size and count a scope reasons about fits, and one
//! integer type means `state.tokens + call.args.max_tokens <= 50000` type-checks
//! without `u` suffixes.

use serde::{Deserialize, Serialize};
use std::fmt;
use wit_parser::{Function, FunctionKind, Resolve, Type, TypeDefKind, TypeId};

/// The CEL type a declaration has.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Shape {
    Bool,
    /// All WIT integer types.
    Int,
    /// `f32` and `f64`.
    Double,
    /// `string`, `char`, enum cases, resource handles (as an id).
    String,
    /// `list<u8>`.
    Bytes,
    /// A list of a leaf shape.
    List(Box<Shape>),
    /// `option<T>` of a leaf shape, bound as a CEL optional.
    Optional(Box<Shape>),
    /// A string-keyed map to a leaf or list shape (`list<tuple<string, T>>`, `map<string, T>`).
    Map(Box<Shape>),
    /// Not addressable from CEL; the string says why.
    Opaque(String),
}

impl Shape {
    /// Whether values of this shape can be bound into an activation.
    pub fn is_bindable(&self) -> bool {
        match self {
            Shape::Opaque(_) => false,
            Shape::List(inner) | Shape::Optional(inner) | Shape::Map(inner) => inner.is_leaf(),
            _ => true,
        }
    }

    fn is_leaf(&self) -> bool {
        matches!(
            self,
            Shape::Bool | Shape::Int | Shape::Double | Shape::String | Shape::Bytes
        ) || matches!(self, Shape::List(inner) if inner.is_scalar())
    }

    fn is_scalar(&self) -> bool {
        matches!(
            self,
            Shape::Bool | Shape::Int | Shape::Double | Shape::String | Shape::Bytes
        )
    }
}

impl fmt::Display for Shape {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Shape::Bool => f.write_str("bool"),
            Shape::Int => f.write_str("int"),
            Shape::Double => f.write_str("double"),
            Shape::String => f.write_str("string"),
            Shape::Bytes => f.write_str("bytes"),
            Shape::List(inner) => write!(f, "list<{inner}>"),
            Shape::Optional(inner) => write!(f, "optional<{inner}>"),
            Shape::Map(inner) => write!(f, "map<string, {inner}>"),
            Shape::Opaque(why) => write!(f, "opaque ({why})"),
        }
    }
}

/// One CEL variable derived from WIT.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Decl {
    /// Dotted CEL name, e.g. `call.args.ctx.host`.
    pub name: String,
    pub shape: Shape,
    /// Which method(s) bind this variable; empty for variables every call binds.
    pub methods: Vec<String>,
}

/// WIT identifiers are kebab-case; CEL identifiers are not. `max-tokens`
/// becomes `max_tokens`.
pub fn cel_ident(wit_name: &str) -> String {
    wit_name.replace('-', "_")
}

/// The bare method name of a WIT function: `[method]local-storage-client.set`
/// becomes `set`, `[static]content.consume-body` becomes `consume-body`,
/// `[constructor]foo` becomes `constructor`, a free function keeps its name.
pub fn method_name(func: &Function) -> String {
    match &func.kind {
        FunctionKind::Freestanding | FunctionKind::AsyncFreestanding => func.name.clone(),
        FunctionKind::Constructor(_) => "constructor".to_string(),
        FunctionKind::Method(_)
        | FunctionKind::Static(_)
        | FunctionKind::AsyncMethod(_)
        | FunctionKind::AsyncStatic(_) => func
            .name
            .rsplit_once('.')
            .map(|(_, m)| m.to_string())
            .unwrap_or_else(|| func.name.clone()),
    }
}

/// The resource a function belongs to, if it is a method, static or constructor.
pub fn resource_of(func: &Function) -> Option<TypeId> {
    match &func.kind {
        FunctionKind::Method(id)
        | FunctionKind::Static(id)
        | FunctionKind::Constructor(id)
        | FunctionKind::AsyncMethod(id)
        | FunctionKind::AsyncStatic(id) => Some(*id),
        FunctionKind::Freestanding | FunctionKind::AsyncFreestanding => None,
    }
}

/// Flatten a function's parameters into declarations under `prefix`
/// (normally `call.args`). The `self` parameter of a method is skipped: the
/// receiver is the capability instance itself and is never a scope input.
pub fn flatten_params(resolve: &Resolve, func: &Function, prefix: &str) -> Vec<Decl> {
    let mut out = Vec::new();
    let method = method_name(func);
    for param in &func.params {
        if param.name == "self" {
            continue;
        }
        let name = format!("{prefix}.{}", cel_ident(&param.name));
        flatten_type(resolve, &param.ty, &name, &method, &mut out);
    }
    out
}

fn flatten_type(resolve: &Resolve, ty: &Type, name: &str, method: &str, out: &mut Vec<Decl>) {
    match ty {
        Type::Id(id) => flatten_typedef(resolve, *id, name, method, out),
        other => push(out, name, scalar_shape(other), method),
    }
}

fn scalar_shape(ty: &Type) -> Shape {
    match ty {
        Type::Bool => Shape::Bool,
        Type::U8
        | Type::U16
        | Type::U32
        | Type::U64
        | Type::S8
        | Type::S16
        | Type::S32
        | Type::S64 => Shape::Int,
        Type::F32 | Type::F64 => Shape::Double,
        Type::Char | Type::String => Shape::String,
        Type::ErrorContext => Shape::Opaque("error-context".to_string()),
        Type::Id(_) => Shape::Opaque("unresolved type id".to_string()),
    }
}

fn flatten_typedef(resolve: &Resolve, id: TypeId, name: &str, method: &str, out: &mut Vec<Decl>) {
    let Some(def) = resolve.types.get(id) else {
        push(
            out,
            name,
            Shape::Opaque("dangling type id".to_string()),
            method,
        );
        return;
    };
    match &def.kind {
        TypeDefKind::Type(inner) => flatten_type(resolve, inner, name, method, out),
        TypeDefKind::Record(record) => {
            for field in &record.fields {
                let child = format!("{name}.{}", cel_ident(&field.name));
                flatten_type(resolve, &field.ty, &child, method, out);
            }
        }
        TypeDefKind::Tuple(tuple) => {
            for (i, ty) in tuple.types.iter().enumerate() {
                let child = format!("{name}.{i}");
                flatten_type(resolve, ty, &child, method, out);
            }
        }
        TypeDefKind::Enum(_) => push(out, name, Shape::String, method),
        TypeDefKind::Flags(_) => push(out, name, Shape::List(Box::new(Shape::String)), method),
        TypeDefKind::Resource => push(out, name, Shape::String, method),
        TypeDefKind::Handle(_) => push(out, name, Shape::String, method),
        TypeDefKind::Variant(variant) => {
            // The case name is always addressable; payloads are opaque in v0.
            push(out, &format!("{name}.tag"), Shape::String, method);
            let _ = variant;
        }
        TypeDefKind::Option(inner) => {
            let shape = value_shape(resolve, inner);
            let shape = if shape.is_leaf() {
                Shape::Optional(Box::new(shape))
            } else {
                Shape::Opaque(format!("option<{shape}> is not flattenable"))
            };
            push(out, name, shape, method);
        }
        TypeDefKind::List(inner) => push(out, name, list_shape(resolve, inner), method),
        TypeDefKind::FixedLengthList(inner, _) => {
            push(out, name, list_shape(resolve, inner), method)
        }
        TypeDefKind::Map(key, value) => {
            let shape = match (value_shape(resolve, key), value_shape(resolve, value)) {
                (Shape::String, v) if v.is_leaf() => Shape::Map(Box::new(v)),
                (k, v) => Shape::Opaque(format!("map<{k}, {v}> is not addressable")),
            };
            push(out, name, shape, method);
        }
        TypeDefKind::Result(_) => push(out, name, Shape::Opaque("result".to_string()), method),
        TypeDefKind::Future(_) => push(out, name, Shape::Opaque("future".to_string()), method),
        TypeDefKind::Stream(_) => push(out, name, Shape::Opaque("stream".to_string()), method),
        TypeDefKind::Unknown => push(out, name, Shape::Opaque("unknown".to_string()), method),
    }
}

/// `list<u8>` is bytes; `list<tuple<string, T>>` is a map; a list of a leaf is
/// a list; anything else is opaque.
fn list_shape(resolve: &Resolve, inner: &Type) -> Shape {
    let inner = &unalias(resolve, *inner);
    if matches!(inner, Type::U8) {
        return Shape::Bytes;
    }
    if let Type::Id(id) = inner
        && let Some(TypeDefKind::Tuple(tuple)) = resolve.types.get(*id).map(|d| &d.kind)
        && let [key, value] = tuple.types.as_slice()
        && matches!(value_shape(resolve, key), Shape::String)
    {
        let v = value_shape(resolve, value);
        return if v.is_leaf() {
            Shape::Map(Box::new(v))
        } else {
            Shape::Opaque(format!("list<tuple<string, {v}>> is not addressable"))
        };
    }
    let elem = value_shape(resolve, inner);
    if elem.is_scalar() {
        Shape::List(Box::new(elem))
    } else {
        Shape::Opaque(format!("list<{elem}> is not addressable"))
    }
}

/// Follow `type a = b` aliases to the underlying type.
fn unalias(resolve: &Resolve, mut ty: Type) -> Type {
    while let Type::Id(id) = ty {
        match resolve.types.get(id).map(|d| &d.kind) {
            Some(TypeDefKind::Type(inner)) => ty = *inner,
            _ => break,
        }
    }
    ty
}

/// The shape of a type used *inside* a container, where flattening is not
/// possible.
fn value_shape(resolve: &Resolve, ty: &Type) -> Shape {
    match ty {
        Type::Id(id) => {
            let Some(def) = resolve.types.get(*id) else {
                return Shape::Opaque("dangling type id".to_string());
            };
            match &def.kind {
                TypeDefKind::Type(inner) => value_shape(resolve, inner),
                TypeDefKind::Enum(_) | TypeDefKind::Resource | TypeDefKind::Handle(_) => {
                    Shape::String
                }
                TypeDefKind::List(inner) => list_shape(resolve, inner),
                TypeDefKind::FixedLengthList(inner, _) => list_shape(resolve, inner),
                TypeDefKind::Flags(_) => Shape::List(Box::new(Shape::String)),
                TypeDefKind::Record(_) => Shape::Opaque("record inside a container".to_string()),
                TypeDefKind::Tuple(_) => Shape::Opaque("tuple inside a container".to_string()),
                TypeDefKind::Variant(_) => Shape::Opaque("variant inside a container".to_string()),
                TypeDefKind::Option(_) => Shape::Opaque("option inside a container".to_string()),
                TypeDefKind::Map(_, _) => Shape::Opaque("map inside a container".to_string()),
                TypeDefKind::Result(_) => Shape::Opaque("result".to_string()),
                TypeDefKind::Future(_) => Shape::Opaque("future".to_string()),
                TypeDefKind::Stream(_) => Shape::Opaque("stream".to_string()),
                TypeDefKind::Unknown => Shape::Opaque("unknown".to_string()),
            }
        }
        other => scalar_shape(other),
    }
}

fn push(out: &mut Vec<Decl>, name: &str, shape: Shape, method: &str) {
    out.push(Decl {
        name: name.to_string(),
        shape,
        methods: vec![method.to_string()],
    });
}
