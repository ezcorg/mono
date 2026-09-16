//! Declared configuration: what a capability asks the user to fill in, typed by
//! an `ezco:ezcap/forms` schema (the analogue of a witmproxy plugin's
//! configuration), and the generic operations the consent app uses to list,
//! add, edit and remove configured instances.
//!
//! Values live in the store's generic `configuration` table under
//! `<capability>/<instance>` owners, as `forms.actual-input` JSON, so no
//! capability owns a table. A capability that wants configuration registers a
//! [`Declared`] schema in [`crate::capabilities`]; everything else here is
//! shared: validation against the schema, secret masking on the way out, and
//! "keep the stored secret when the form left it blank" on the way in.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::store::Store;

/// The state owner under which declarations and revisions live.
const OWNER: &str = "configuration";

/// The host form of `forms.input-type`. Serialises externally tagged, so a
/// unit variant is its name (`"str"`) and `select` carries its options
/// (`{"select": ["a", "b"]}`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InputType {
    Str,
    Boolean,
    Number,
    Select(Vec<String>),
    Datetime,
    Daterange,
    File,
    Binary,
    Secret,
}

/// A file the user supplied (`forms.file-input`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileInput {
    pub name: String,
    pub content_type: Option<String>,
    pub data: Vec<u8>,
}

/// The host form of `forms.actual-input`, externally tagged: `{"str": "x"}`,
/// `{"secret": "k"}`, `{"select": "openai"}`, `{"boolean": true}`. This is
/// exactly what the store holds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Value {
    Str(String),
    Boolean(bool),
    Number(f64),
    Select(String),
    Datetime(String),
    Daterange((String, String)),
    File(FileInput),
    Binary(Vec<u8>),
    Secret(String),
}

impl Value {
    /// The textual payload of a text-like value (`str`, `select`, `secret`,
    /// `datetime`), else `None`.
    pub fn text(&self) -> Option<&str> {
        match self {
            Value::Str(s) | Value::Select(s) | Value::Secret(s) | Value::Datetime(s) => Some(s),
            _ => None,
        }
    }

    /// Whether this value is of the shape `ty` declares.
    pub fn fits(&self, ty: &InputType) -> bool {
        match (self, ty) {
            (Value::Str(_), InputType::Str)
            | (Value::Boolean(_), InputType::Boolean)
            | (Value::Number(_), InputType::Number)
            | (Value::Datetime(_), InputType::Datetime)
            | (Value::Daterange(_), InputType::Daterange)
            | (Value::File(_), InputType::File)
            | (Value::Binary(_), InputType::Binary)
            | (Value::Secret(_), InputType::Secret) => true,
            (Value::Select(v), InputType::Select(options)) => options.iter().any(|o| o == v),
            _ => false,
        }
    }

    fn is_empty_text(&self) -> bool {
        self.text().is_some_and(|s| s.trim().is_empty())
    }
}

/// One declared input (`forms.input-schema`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Field {
    pub name: String,
    pub input_type: InputType,
    pub optional: bool,
    pub default: Option<Value>,
    pub description: Option<String>,
}

impl Field {
    pub fn new(name: &str, input_type: InputType, description: &str) -> Self {
        Self {
            name: name.to_string(),
            input_type,
            optional: false,
            default: None,
            description: Some(description.to_string()),
        }
    }

    pub fn optional(mut self) -> Self {
        self.optional = true;
        self
    }

    pub fn default(mut self, value: Value) -> Self {
        self.default = Some(value);
        self
    }
}

/// One value the user supplied (`forms.user-input`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UserInput {
    pub name: String,
    pub value: Value,
}

/// A capability's declared configuration: the schema one instance is filled
/// in against, and where instances live in the store.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Declared {
    /// The capability's registry id (`inference`), or another host's name
    /// for its part (`witmproxy:@ezco/noshorts`).
    pub capability: String,
    /// What an instance is, for the form's heading (`backend`).
    pub instance_noun: String,
    /// The store owner prefix instances are keyed under (`inference/`).
    pub owner_prefix: String,
    /// Exactly one instance (a plugin's settings) rather than a named set.
    #[serde(default)]
    pub single: bool,
    pub fields: Vec<Field>,
    /// Shown with the form.
    #[serde(default)]
    pub description: Option<String>,
}

/// The instance name a `single` declaration's one instance has.
pub const SINGLE: &str = "default";

impl Declared {
    pub fn new(capability: &str, instance_noun: &str, fields: Vec<Field>) -> Self {
        Self {
            capability: capability.to_string(),
            instance_noun: instance_noun.to_string(),
            owner_prefix: format!("{capability}/"),
            single: false,
            fields,
            description: None,
        }
    }

    pub fn single(mut self) -> Self {
        self.single = true;
        self
    }

    pub fn describe(mut self, description: &str) -> Self {
        self.description = Some(description.to_string());
        self
    }

    /// Every instance's values, unmasked: what the declaring host consumes.
    pub async fn values(&self, store: &Store) -> Result<Vec<(String, Vec<UserInput>)>> {
        let mut out = Vec::new();
        for owner in store.owners(&self.owner_prefix).await? {
            let name = owner
                .strip_prefix(&self.owner_prefix)
                .unwrap_or(&owner)
                .to_string();
            let values = store
                .configuration(&owner)
                .await?
                .into_iter()
                .filter_map(|(name, v)| {
                    serde_json::from_value::<Value>(v)
                        .ok()
                        .map(|value| UserInput { name, value })
                })
                .collect();
            out.push((name, values));
        }
        Ok(out)
    }

    fn field(&self, name: &str) -> Option<&Field> {
        self.fields.iter().find(|f| f.name == name)
    }

    fn owner(&self, instance: &str) -> Result<String> {
        let instance = instance.trim();
        if instance.is_empty() {
            bail!("the {} needs a name", self.instance_noun);
        }
        if !instance
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            bail!(
                "`{instance}`: a {} name is letters, digits, `-`, `_` and `.`",
                self.instance_noun
            );
        }
        Ok(format!("{}{instance}", self.owner_prefix))
    }

    /// Validate `inputs` against the schema, filling defaults and keeping a
    /// stored secret the form left blank. Returns the full row set to write.
    fn resolve(
        &self,
        inputs: &[UserInput],
        existing: &[(String, Value)],
    ) -> Result<Vec<(String, Value)>> {
        for input in inputs {
            let Some(field) = self.field(&input.name) else {
                bail!("`{}` is not a declared input", input.name);
            };
            if !input.value.fits(&field.input_type) {
                bail!(
                    "`{}` is not a valid value for `{}`",
                    describe(&input.value),
                    field.name
                );
            }
        }
        let mut rows = Vec::with_capacity(self.fields.len());
        for field in &self.fields {
            let supplied = inputs
                .iter()
                .find(|i| i.name == field.name)
                .map(|i| i.value.clone())
                .filter(|v| !v.is_empty_text());
            let kept = existing
                .iter()
                .find(|(n, _)| *n == field.name)
                .map(|(_, v)| v.clone())
                .filter(|_| matches!(field.input_type, InputType::Secret));
            match supplied.or(kept).or_else(|| field.default.clone()) {
                Some(value) => rows.push((field.name.clone(), value)),
                None if field.optional => {}
                None => bail!("`{}` is required", field.name),
            }
        }
        Ok(rows)
    }

    /// Every configured instance, secrets masked.
    pub async fn instances(&self, store: &Store) -> Result<Vec<Instance>> {
        let mut out = Vec::new();
        for owner in store.owners(&self.owner_prefix).await? {
            let name = owner
                .strip_prefix(&self.owner_prefix)
                .unwrap_or(&owner)
                .to_string();
            let rows = store.configuration(&owner).await?;
            let values = self
                .fields
                .iter()
                .map(|field| {
                    let stored = rows
                        .iter()
                        .find(|(n, _)| *n == field.name)
                        .and_then(|(_, v)| serde_json::from_value::<Value>(v.clone()).ok());
                    let set = stored.is_some();
                    let value = match (&field.input_type, stored) {
                        (InputType::Secret, _) => None,
                        (_, v) => v,
                    };
                    Configured {
                        name: field.name.clone(),
                        value,
                        set,
                    }
                })
                .collect();
            out.push(Instance {
                name,
                owner,
                values,
            });
        }
        Ok(out)
    }

    /// Create or update `instance` from the form's `inputs`. A blank secret
    /// keeps the stored one; unknown names, ill-typed values and missing
    /// required inputs are refused before anything is written.
    pub async fn set(&self, store: &Store, instance: &str, inputs: &[UserInput]) -> Result<()> {
        let owner = self.owner(instance)?;
        let existing: Vec<(String, Value)> = store
            .configuration(&owner)
            .await?
            .into_iter()
            .filter_map(|(n, v)| serde_json::from_value(v).ok().map(|v| (n, v)))
            .collect();
        let rows = self.resolve(inputs, &existing)?;
        store.clear_configuration(&owner).await?;
        for (name, value) in rows {
            store
                .set_configuration(&owner, &name, &serde_json::to_value(&value)?)
                .await?;
        }
        Ok(())
    }

    /// Remove `instance` entirely. `Ok(false)` if there was none.
    pub async fn remove(&self, store: &Store, instance: &str) -> Result<bool> {
        let owner = self.owner(instance)?;
        store.clear_configuration(&owner).await
    }
}

/// One configured value as the consent app sees it: a secret is reported as
/// set or unset, never by value.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Configured {
    pub name: String,
    pub value: Option<Value>,
    pub set: bool,
}

/// One configured instance of a declared schema.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Instance {
    pub name: String,
    pub owner: String,
    pub values: Vec<Configured>,
}

/// Everything declared on this machine: a host's built-in schemas plus the
/// ones other local hosts registered through the store (`declared:*` state
/// rows), with the generic operations over both. Every write under a prefix
/// bumps that prefix's revision, so a declaring host can poll for edits.
#[derive(Clone)]
pub struct Registry {
    store: Option<Store>,
    builtin: Vec<Declared>,
}

/// What a declaring host reads back: the prefix's revision and every
/// instance's values, unmasked.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub revision: u64,
    pub instances: Vec<(String, Vec<UserInput>)>,
}

impl Registry {
    pub fn new(store: Option<Store>, builtin: Vec<Declared>) -> Self {
        Self { store, builtin }
    }

    pub fn store(&self) -> Option<&Store> {
        self.store.as_ref()
    }

    /// Built-in declarations first, then the stored ones.
    pub async fn declared(&self) -> Vec<Declared> {
        let mut out = self.builtin.clone();
        if let Some(store) = &self.store {
            match store.state_list(OWNER, "declared:").await {
                Ok(rows) => {
                    for (_, bytes) in rows {
                        match serde_json::from_slice::<Declared>(&bytes) {
                            Ok(d) if !out.iter().any(|b| b.capability == d.capability) => {
                                out.push(d)
                            }
                            Ok(_) => {}
                            Err(err) => tracing::warn!(?err, "stored declaration is malformed"),
                        }
                    }
                }
                Err(err) => tracing::warn!(?err, "could not read declarations"),
            }
        }
        out
    }

    pub async fn find(&self, capability: &str) -> Option<Declared> {
        self.declared()
            .await
            .into_iter()
            .find(|d| d.capability == capability)
    }

    /// Register or refresh another host's schema.
    pub async fn declare(&self, declared: &Declared) -> Result<()> {
        if self
            .builtin
            .iter()
            .any(|b| b.capability == declared.capability)
        {
            bail!("`{}` is this host's own", declared.capability);
        }
        if declared.capability.trim().is_empty() || declared.owner_prefix.trim().is_empty() {
            bail!("a declaration needs a capability and an owner prefix");
        }
        let store = self.writable()?;
        store
            .state_set(
                OWNER,
                &format!("declared:{}", declared.capability),
                &serde_json::to_vec(declared)?,
            )
            .await
    }

    pub async fn undeclare(&self, capability: &str) -> Result<bool> {
        let store = self.writable()?;
        store
            .state_delete(OWNER, &format!("declared:{capability}"))
            .await
    }

    /// Every declaration with its configured instances, secrets masked (the
    /// consent app's view).
    pub async fn configuration(&self) -> Result<Vec<(Declared, Vec<Instance>)>> {
        let mut out = Vec::new();
        for declared in self.declared().await {
            let instances = match &self.store {
                Some(store) => declared.instances(store).await?,
                None => Vec::new(),
            };
            out.push((declared, instances));
        }
        Ok(out)
    }

    /// Create or update one instance; returns its declaration so the host can
    /// let the capability pick the change up.
    pub async fn configure(
        &self,
        capability: &str,
        instance: &str,
        inputs: &[UserInput],
    ) -> Result<Declared> {
        let (declared, store) = self.target(capability).await?;
        let instance = if declared.single { SINGLE } else { instance };
        declared.set(store, instance, inputs).await?;
        self.bump(&declared.owner_prefix).await;
        Ok(declared)
    }

    pub async fn unconfigure(&self, capability: &str, instance: &str) -> Result<(Declared, bool)> {
        let (declared, store) = self.target(capability).await?;
        let instance = if declared.single { SINGLE } else { instance };
        let removed = declared.remove(store, instance).await?;
        self.bump(&declared.owner_prefix).await;
        Ok((declared, removed))
    }

    /// What a declaring host reads back for its prefix.
    pub async fn configured(&self, owner_prefix: &str) -> Result<Snapshot> {
        let store = self.writable()?;
        let Some(declared) = self
            .declared()
            .await
            .into_iter()
            .find(|d| d.owner_prefix == owner_prefix)
        else {
            bail!("nothing is declared under `{owner_prefix}`");
        };
        Ok(Snapshot {
            revision: self.revision(owner_prefix).await,
            instances: declared.values(store).await?,
        })
    }

    pub async fn revision(&self, owner_prefix: &str) -> u64 {
        match &self.store {
            Some(store) => store
                .state_counter(OWNER, &format!("revision:{owner_prefix}"))
                .await
                .unwrap_or(0)
                .max(0) as u64,
            None => 0,
        }
    }

    async fn bump(&self, owner_prefix: &str) {
        if let Some(store) = &self.store {
            if let Err(err) = store
                .state_add(OWNER, &format!("revision:{owner_prefix}"), 1)
                .await
            {
                tracing::warn!(?err, owner_prefix, "could not bump the revision");
            }
        }
    }

    async fn target(&self, capability: &str) -> Result<(Declared, &Store)> {
        let Some(declared) = self.find(capability).await else {
            bail!("`{capability}` declares no configuration");
        };
        Ok((declared, self.writable()?))
    }

    fn writable(&self) -> Result<&Store> {
        self.store.as_ref().ok_or_else(|| {
            anyhow::anyhow!("the store is unavailable, so configuration cannot be saved")
        })
    }
}

fn describe(value: &Value) -> String {
    match value {
        Value::Str(s) | Value::Select(s) | Value::Datetime(s) => format!("\"{s}\""),
        Value::Secret(_) => "a secret".to_string(),
        Value::Boolean(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Daterange((a, b)) => format!("{a}..{b}"),
        Value::File(f) => format!("file {}", f.name),
        Value::Binary(b) => format!("{} bytes", b.len()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema() -> Declared {
        Declared::new(
            "demo",
            "thing",
            vec![
                Field::new(
                    "kind",
                    InputType::Select(vec!["a".into(), "b".into()]),
                    "which",
                ),
                Field::new("url", InputType::Str, "where"),
                Field::new("key", InputType::Secret, "auth").optional(),
                Field::new("on", InputType::Boolean, "flag").default(Value::Boolean(true)),
            ],
        )
    }

    async fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let store = Store::open_with(dir.path().join("icanhaz.db"), &source)
            .await
            .unwrap();
        (dir, store)
    }

    fn input(name: &str, value: Value) -> UserInput {
        UserInput {
            name: name.into(),
            value,
        }
    }

    #[test]
    fn values_round_trip_as_forms_actual_input_json() {
        let v = serde_json::to_value(Value::Secret("k".into())).unwrap();
        assert_eq!(v, serde_json::json!({"secret": "k"}));
        let t = serde_json::to_value(InputType::Select(vec!["x".into()])).unwrap();
        assert_eq!(t, serde_json::json!({"select": ["x"]}));
        assert_eq!(
            serde_json::to_value(InputType::Str).unwrap(),
            serde_json::json!("str")
        );
        let back: Value = serde_json::from_value(serde_json::json!({"boolean": true})).unwrap();
        assert_eq!(back, Value::Boolean(true));
    }

    #[test]
    fn validation_refuses_unknown_ill_typed_and_missing() {
        let s = schema();
        let err = |inputs: &[UserInput]| s.resolve(inputs, &[]).unwrap_err().to_string();
        assert!(err(&[input("nope", Value::Str("x".into()))]).contains("not a declared input"));
        assert!(err(&[input("kind", Value::Select("z".into()))]).contains("not a valid value"));
        assert!(err(&[input("kind", Value::Str("a".into()))]).contains("not a valid value"));
        assert!(err(&[input("kind", Value::Select("a".into()))]).contains("`url` is required"));
        let rows = s
            .resolve(
                &[
                    input("kind", Value::Select("a".into())),
                    input("url", Value::Str("http://x".into())),
                ],
                &[],
            )
            .unwrap();
        // Defaults fill, optional secrets are simply absent.
        assert_eq!(
            rows,
            vec![
                ("kind".to_string(), Value::Select("a".into())),
                ("url".to_string(), Value::Str("http://x".into())),
                ("on".to_string(), Value::Boolean(true)),
            ]
        );
        assert!(s.owner("").is_err());
        assert!(s.owner("a/b").is_err());
        assert_eq!(s.owner("local-1").unwrap(), "demo/local-1");
    }

    #[tokio::test]
    async fn another_host_declares_and_reads_back_with_a_revision() {
        let (_dir, store) = store().await;
        let registry = Registry::new(Some(store), vec![schema()]);
        // The host's own declaration cannot be shadowed.
        assert!(registry.declare(&schema()).await.is_err());
        let plugin = Declared {
            capability: "witmproxy:@ezco/noshorts".into(),
            instance_noun: "configuration".into(),
            owner_prefix: "witmproxy/@ezco/noshorts/".into(),
            single: true,
            fields: vec![
                Field::new("limit", InputType::Number, "how many"),
                Field::new("token", InputType::Secret, "auth").optional(),
            ],
            description: Some("Hides shorts".into()),
        };
        registry.declare(&plugin).await.unwrap();
        let listed = registry.declared().await;
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[1], plugin);
        let before = registry
            .configured("witmproxy/@ezco/noshorts/")
            .await
            .unwrap();
        assert_eq!(before.revision, 0);
        assert!(before.instances.is_empty());

        // The tray writes (a single declaration ignores the instance name).
        registry
            .configure(
                "witmproxy:@ezco/noshorts",
                "whatever",
                &[
                    input("limit", Value::Number(3.0)),
                    input("token", Value::Secret("t".into())),
                ],
            )
            .await
            .unwrap();
        let after = registry
            .configured("witmproxy/@ezco/noshorts/")
            .await
            .unwrap();
        assert_eq!(after.revision, 1);
        assert_eq!(after.instances.len(), 1);
        assert_eq!(after.instances[0].0, SINGLE);
        // Unmasked for the declaring host…
        assert!(after.instances[0]
            .1
            .contains(&input("token", Value::Secret("t".into()))));
        // …masked for the tray.
        let view = registry.configuration().await.unwrap();
        let (_, instances) = &view[1];
        assert!(instances[0]
            .values
            .iter()
            .any(|v| v.name == "token" && v.value.is_none() && v.set));

        assert!(registry
            .undeclare("witmproxy:@ezco/noshorts")
            .await
            .unwrap());
        assert_eq!(registry.declared().await.len(), 1);
        assert!(registry
            .configured("witmproxy/@ezco/noshorts/")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn secrets_are_masked_on_read_and_kept_when_left_blank() {
        let (_dir, store) = store().await;
        let s = schema();
        s.set(
            &store,
            "one",
            &[
                input("kind", Value::Select("b".into())),
                input("url", Value::Str("http://one".into())),
                input("key", Value::Secret("hunter2".into())),
            ],
        )
        .await
        .unwrap();

        let list = s.instances(&store).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "one");
        assert_eq!(list[0].owner, "demo/one");
        let key = list[0].values.iter().find(|v| v.name == "key").unwrap();
        assert_eq!(key.value, None);
        assert!(key.set);
        let url = list[0].values.iter().find(|v| v.name == "url").unwrap();
        assert_eq!(url.value, Some(Value::Str("http://one".into())));

        // Editing with a blank secret keeps the stored one; a new one replaces it.
        s.set(
            &store,
            "one",
            &[
                input("kind", Value::Select("a".into())),
                input("url", Value::Str("http://two".into())),
                input("key", Value::Secret(String::new())),
            ],
        )
        .await
        .unwrap();
        let rows = store.configuration("demo/one").await.unwrap();
        assert!(rows.contains(&("key".to_string(), serde_json::json!({"secret": "hunter2"}))));
        assert!(rows.contains(&("url".to_string(), serde_json::json!({"str": "http://two"}))));

        assert!(s.remove(&store, "one").await.unwrap());
        assert!(!s.remove(&store, "one").await.unwrap());
        assert!(s.instances(&store).await.unwrap().is_empty());
    }
}
