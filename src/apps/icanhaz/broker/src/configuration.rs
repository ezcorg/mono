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
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Declared {
    /// The capability's registry id (`inference`).
    pub capability: String,
    /// What an instance is, for the form's heading (`backend`).
    pub instance_noun: String,
    /// The store owner prefix instances are keyed under (`inference/`).
    pub owner_prefix: String,
    pub fields: Vec<Field>,
}

impl Declared {
    pub fn new(capability: &str, instance_noun: &str, fields: Vec<Field>) -> Self {
        Self {
            capability: capability.to_string(),
            instance_noun: instance_noun.to_string(),
            owner_prefix: format!("{capability}/"),
            fields,
        }
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
