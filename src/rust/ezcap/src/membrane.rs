//! The membrane runtime: minted instances, narrowing, admission, counters.
//!
//! One [`Membrane`] serves one capability kind: it holds the compiled CEL
//! environment for that kind and a table of instances. Minting compiles a
//! scope; narrowing mints a child whose scope is the parent's conjoined with
//! the extra clause (the only way scopes change); admission binds a
//! [`Call`] and evaluates `allow`. A `false`, an evaluation error, or an
//! unbound variable all deny, so scopes fail closed. Counters live on the
//! instance and are updated only after an admitted call.

use crate::bind::{BindError, Val, bind};
use crate::env::{
    CALL_BYTES, CALL_METHOD, CALLER_KEY, CALLER_ORIGIN, CALLER_PEER, CALLER_PLUGIN, CallEnv,
    EnvError, STATE_BYTES, STATE_CALLS,
};
use crate::profile::render_line;
use crate::shape::{Decl, Shape};
use crate::types::{Capability, CapabilityError, Kind, Narrowing, Scope};
use cel_cxx::{Activation, Env, Program, Value};
use std::collections::HashMap;

/// Opaque per-membrane instance id. Sturdy references (M2) wrap these.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct InstanceId(pub String);

/// Who is making the call. Every field is optional; a clause that names an
/// absent one denies.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Caller {
    pub plugin: Option<String>,
    pub key: Option<String>,
    pub peer: Option<String>,
    pub origin: Option<String>,
}

/// One invocation to admit.
#[derive(Debug, Clone, Default)]
pub struct Call {
    /// Bare method name (`set`, `open-at`).
    pub method: String,
    /// Flattened arguments by declared name (`call.args.key`).
    pub args: Vec<(String, Val)>,
    pub caller: Caller,
    /// Payload size the host attributes to this call, for `call.bytes` and `state.bytes`.
    pub bytes: i64,
}

impl Call {
    pub fn new(method: impl Into<String>) -> Self {
        Call {
            method: method.into(),
            ..Default::default()
        }
    }
    pub fn arg(mut self, name: &str, val: impl Into<Val>) -> Self {
        self.args.push((format!("call.args.{name}"), val.into()));
        self
    }
    pub fn caller(mut self, caller: Caller) -> Self {
        self.caller = caller;
        self
    }
    pub fn bytes(mut self, n: i64) -> Self {
        self.bytes = n;
        self
    }
}

/// A minted capability instance.
pub struct Instance {
    pub id: InstanceId,
    pub kind: Kind,
    pub scope: Scope,
    pub parent: Option<InstanceId>,
    pub counters: HashMap<String, i64>,
    pub revoked: bool,
    allow: Program<'static>,
    when: Program<'static>,
}

impl Instance {
    pub fn counter(&self, name: &str) -> i64 {
        self.counters.get(name).copied().unwrap_or(0)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MembraneError {
    #[error(transparent)]
    Env(#[from] EnvError),
    #[error("scope `{field}` does not compile: {message}")]
    Compile {
        field: &'static str,
        message: String,
    },
    #[error("kind mismatch: membrane is for `{expected}`, request is for `{got}`")]
    Kind { expected: Kind, got: Kind },
    #[error("no instance `{0}`")]
    NoInstance(String),
    #[error(transparent)]
    Bind(#[from] BindError),
}

/// The runtime for one capability kind.
pub struct Membrane {
    env_model: CallEnv,
    env: Env<'static>,
    /// Extra counters the host maintains beyond `calls` and `bytes`, declared
    /// as `state.<name>`.
    extra_counters: Vec<String>,
    instances: HashMap<InstanceId, Instance>,
    next: u64,
}

impl Membrane {
    /// Build a membrane from a generated environment. `extra_counters` are
    /// host-defined `state.*` integers (`tokens`, …) the host reports after
    /// each call via [`Membrane::charge`].
    pub fn new(env_model: CallEnv, extra_counters: &[&str]) -> Result<Membrane, MembraneError> {
        Self::with_builder(env_model, extra_counters, |b| b)
    }

    /// Like [`Membrane::new`], with a hook to register host-specific
    /// variables and functions (`time`, `request`, …) on the builder.
    pub fn with_builder(
        env_model: CallEnv,
        extra_counters: &[&str],
        customize: impl FnOnce(cel_cxx::EnvBuilder<'static>) -> cel_cxx::EnvBuilder<'static>,
    ) -> Result<Membrane, MembraneError> {
        let mut builder = env_model.apply(Env::builder())?;
        for name in extra_counters {
            builder = builder
                .declare_variable::<i64>(format!("state.{name}"))
                .map_err(|e| EnvError::Cel(e.to_string()))?;
        }
        let builder = customize(builder);
        let env = builder.build().map_err(|e| EnvError::Cel(e.to_string()))?;
        Ok(Membrane {
            env_model,
            env,
            extra_counters: extra_counters.iter().map(|s| s.to_string()).collect(),
            instances: HashMap::new(),
            next: 1,
        })
    }

    pub fn kind(&self) -> &Kind {
        &self.env_model.kind
    }

    pub fn env(&self) -> &CallEnv {
        &self.env_model
    }

    /// Compile both scope fields against this kind's environment. This is
    /// the load-time check: a clause naming an argument the interface does
    /// not have fails here.
    pub fn check(&self, scope: &Scope) -> Result<(), MembraneError> {
        self.compile(scope).map(|_| ())
    }

    fn compile(
        &self,
        scope: &Scope,
    ) -> Result<(Program<'static>, Program<'static>), MembraneError> {
        let when = self
            .env
            .compile(&scope.when)
            .map_err(|e| MembraneError::Compile {
                field: "when",
                message: e.to_string(),
            })?;
        let allow = self
            .env
            .compile(&scope.allow)
            .map_err(|e| MembraneError::Compile {
                field: "allow",
                message: e.to_string(),
            })?;
        Ok((when, allow))
    }

    /// Mint a root instance from a request.
    pub fn mint(&mut self, cap: &Capability) -> Result<InstanceId, MembraneError> {
        if cap.kind != self.env_model.kind {
            return Err(MembraneError::Kind {
                expected: self.env_model.kind.clone(),
                got: cap.kind.clone(),
            });
        }
        self.insert(cap.scope.clone(), None)
    }

    /// Mint a child of `parent` whose scope is `parent && extra`.
    pub fn narrow(
        &mut self,
        parent: &InstanceId,
        extra: &Narrowing,
    ) -> Result<InstanceId, MembraneError> {
        let parent_scope = self
            .instances
            .get(parent)
            .ok_or_else(|| MembraneError::NoInstance(parent.0.clone()))?
            .scope
            .clone();
        self.insert(parent_scope.narrowed(extra), Some(parent.clone()))
    }

    fn insert(
        &mut self,
        scope: Scope,
        parent: Option<InstanceId>,
    ) -> Result<InstanceId, MembraneError> {
        let (when, allow) = self.compile(&scope)?;
        let id = InstanceId(format!("i-{}", self.next));
        self.next += 1;
        let mut counters: HashMap<String, i64> = HashMap::new();
        counters.insert("calls".to_string(), 0);
        counters.insert("bytes".to_string(), 0);
        for c in &self.extra_counters {
            counters.insert(c.clone(), 0);
        }
        self.instances.insert(
            id.clone(),
            Instance {
                id: id.clone(),
                kind: self.env_model.kind.clone(),
                scope,
                parent,
                counters,
                revoked: false,
                allow,
                when,
            },
        );
        Ok(id)
    }

    pub fn get(&self, id: &InstanceId) -> Option<&Instance> {
        self.instances.get(id)
    }

    /// Revoke an instance and everything narrowed from it.
    pub fn revoke(&mut self, id: &InstanceId) {
        let mut stack = vec![id.clone()];
        while let Some(cur) = stack.pop() {
            if let Some(inst) = self.instances.get_mut(&cur) {
                inst.revoked = true;
            }
            for (child_id, child) in &self.instances {
                if child.parent.as_ref() == Some(&cur) && !child.revoked {
                    stack.push(child_id.clone());
                }
            }
        }
    }

    /// Evaluate `when` for an event. The host binds its event variables
    /// through `bind_event`; `false`, an error, or an unbound variable all
    /// mean "do not run".
    pub fn admit_event(
        &self,
        id: &InstanceId,
        bind_event: impl FnOnce(Activation<'static>) -> Result<Activation<'static>, cel_cxx::Error>,
    ) -> bool {
        let Some(inst) = self.instances.get(id) else {
            return false;
        };
        if inst.revoked {
            return false;
        }
        let Ok(act) = bind_event(Activation::new()) else {
            return false;
        };
        matches!(inst.when.evaluate(&act), Ok(Value::Bool(true)))
    }

    /// Evaluate `allow` for a call. On admission the instance's `calls` and
    /// `bytes` counters advance. On denial the error carries the scope
    /// rendered as sentences.
    pub fn admit(&mut self, id: &InstanceId, call: &Call) -> Result<(), CapabilityError> {
        let Some(inst) = self.instances.get(id) else {
            return Err(CapabilityError::Unavailable);
        };
        if inst.revoked {
            return Err(CapabilityError::Unavailable);
        }
        let admitted = match self.activation(inst, call) {
            Ok(act) => matches!(inst.allow.evaluate(&act), Ok(Value::Bool(true))),
            Err(_) => false,
        };
        if !admitted {
            return Err(CapabilityError::Denied(render_line(&inst.scope.allow)));
        }
        if let Some(inst) = self.instances.get_mut(id) {
            *inst.counters.entry("calls".to_string()).or_insert(0) += 1;
            *inst.counters.entry("bytes".to_string()).or_insert(0) += call.bytes;
        }
        Ok(())
    }

    /// Advance a host-defined counter after a call (e.g. tokens actually
    /// consumed).
    pub fn charge(&mut self, id: &InstanceId, counter: &str, amount: i64) {
        if let Some(inst) = self.instances.get_mut(id) {
            *inst.counters.entry(counter.to_string()).or_insert(0) += amount;
        }
    }

    fn activation(
        &self,
        inst: &Instance,
        call: &Call,
    ) -> Result<Activation<'static>, MembraneError> {
        let mut act = Activation::new();
        let s = |v: &str| Val::Str(v.to_string());
        act = bind(act, CALL_METHOD, &Shape::String, &s(&call.method))?;
        act = bind(act, CALL_BYTES, &Shape::Int, &Val::Int(call.bytes))?;
        for (name, value) in [
            (CALLER_PLUGIN, &call.caller.plugin),
            (CALLER_KEY, &call.caller.key),
            (CALLER_PEER, &call.caller.peer),
            (CALLER_ORIGIN, &call.caller.origin),
        ] {
            if let Some(v) = value {
                act = bind(act, name, &Shape::String, &s(v))?;
            }
        }
        act = bind(
            act,
            STATE_CALLS,
            &Shape::Int,
            &Val::Int(inst.counter("calls")),
        )?;
        act = bind(
            act,
            STATE_BYTES,
            &Shape::Int,
            &Val::Int(inst.counter("bytes")),
        )?;
        for c in &self.extra_counters {
            act = bind(
                act,
                &format!("state.{c}"),
                &Shape::Int,
                &Val::Int(inst.counter(c)),
            )?;
        }
        for (name, val) in &call.args {
            if let Some(decl) = self.decl(name)
                && decl.shape.is_bindable()
            {
                act = bind(act, name, &decl.shape, val)?;
            }
        }
        Ok(act)
    }

    fn decl(&self, name: &str) -> Option<&Decl> {
        self.env_model.decls.iter().find(|d| d.name == name)
    }
}
