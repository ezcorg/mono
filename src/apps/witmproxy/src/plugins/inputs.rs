//! Turning operator-supplied text into the typed inputs a plugin declared.
//!
//! `witm plugin configure --set key=value` can only carry strings, but a
//! manifest declares each input's type. Storing every value as a string
//! meant a plugin that declared `daily_budget_minutes` as a number received a
//! string at runtime; a plugin written against its own schema would reject
//! its own configuration.

use anyhow::{Result, anyhow, bail};

use crate::wasm::bindgen::{ActualInput, InputSchema, InputType};

/// Parses `raw` according to `schema.input_type`.
pub fn coerce_input(schema: &InputSchema, raw: &str) -> Result<ActualInput> {
    let name = &schema.name;
    Ok(match &schema.input_type {
        InputType::Str => ActualInput::Str(raw.to_string()),
        InputType::Boolean => match raw.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "on" | "1" => ActualInput::Boolean(true),
            "false" | "no" | "off" | "0" => ActualInput::Boolean(false),
            other => {
                bail!("`{name}` is a boolean; `{other}` is not one of true/false/yes/no/on/off/1/0")
            }
        },
        InputType::Number => ActualInput::Number(
            raw.trim()
                .parse::<f64>()
                .map_err(|e| anyhow!("`{name}` is a number; `{raw}` does not parse as one: {e}"))?,
        ),
        InputType::Select(options) => {
            if options.iter().any(|o| o == raw) {
                ActualInput::Select(raw.to_string())
            } else {
                bail!(
                    "`{name}` must be one of: {}; got `{raw}`",
                    options.join(", ")
                );
            }
        }
        InputType::Datetime => ActualInput::Datetime(raw.to_string()),
        InputType::Daterange => {
            let (a, b) = raw
                .split_once("..")
                .ok_or_else(|| anyhow!("`{name}` is a date range; write it as `start..end`"))?;
            ActualInput::Daterange((a.trim().to_string(), b.trim().to_string()))
        }
        InputType::Secret => ActualInput::Secret(raw.to_string()),
        InputType::File | InputType::Binary => {
            bail!("`{name}` takes a file, which the command line cannot supply; use the web API")
        }
    })
}

/// Human-readable rendering of a stored or default value.
pub fn display_input(value: &ActualInput) -> String {
    match value {
        ActualInput::Str(s) | ActualInput::Select(s) | ActualInput::Datetime(s) => {
            if s.is_empty() {
                "(empty)".to_string()
            } else {
                s.clone()
            }
        }
        ActualInput::Boolean(b) => b.to_string(),
        ActualInput::Number(n) => n.to_string(),
        ActualInput::Daterange((a, b)) => format!("{a}..{b}"),
        ActualInput::File(f) => format!("file {} ({} bytes)", f.name, f.data.len()),
        ActualInput::Binary(b) => format!("{} bytes", b.len()),
        // Never shown: a secret's value does not leave the store.
        ActualInput::Secret(_) => "••••••".to_string(),
    }
}

/// The type name shown in `witm plugin configure` listings.
pub fn display_type(t: &InputType) -> String {
    match t {
        InputType::Str => "string".into(),
        InputType::Boolean => "boolean".into(),
        InputType::Number => "number".into(),
        InputType::Select(options) => format!("one of {}", options.join(" | ")),
        InputType::Datetime => "datetime".into(),
        InputType::Daterange => "date range (start..end)".into(),
        InputType::File => "file".into(),
        InputType::Binary => "binary".into(),
        InputType::Secret => "secret".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema(name: &str, input_type: InputType) -> InputSchema {
        InputSchema {
            name: name.to_string(),
            input_type,
            optional: true,
            default: None,
            description: None,
        }
    }

    #[test]
    fn numbers_and_booleans_are_typed() {
        assert!(matches!(
            coerce_input(&schema("n", InputType::Number), " 2.5 ").unwrap(),
            ActualInput::Number(v) if (v - 2.5).abs() < f64::EPSILON
        ));
        assert!(matches!(
            coerce_input(&schema("b", InputType::Boolean), "Yes").unwrap(),
            ActualInput::Boolean(true)
        ));
        assert!(matches!(
            coerce_input(&schema("b", InputType::Boolean), "0").unwrap(),
            ActualInput::Boolean(false)
        ));
        let err = coerce_input(&schema("n", InputType::Number), "lots").unwrap_err();
        assert!(err.to_string().contains("`n` is a number"), "{err}");
        let err = coerce_input(&schema("b", InputType::Boolean), "maybe").unwrap_err();
        assert!(err.to_string().contains("`b` is a boolean"), "{err}");
    }

    #[test]
    fn strings_pass_through_untouched() {
        assert!(matches!(
            coerce_input(&schema("s", InputType::Str), " 42 ").unwrap(),
            ActualInput::Str(v) if v == " 42 "
        ));
    }

    #[test]
    fn selects_validate_membership() {
        let s = schema("mode", InputType::Select(vec!["a".into(), "b".into()]));
        assert!(matches!(coerce_input(&s, "b").unwrap(), ActualInput::Select(v) if v == "b"));
        let err = coerce_input(&s, "c").unwrap_err().to_string();
        assert!(err.contains("one of: a, b"), "{err}");
    }

    #[test]
    fn ranges_and_files() {
        assert!(matches!(
            coerce_input(&schema("r", InputType::Daterange), "2026-01-01 .. 2026-02-01").unwrap(),
            ActualInput::Daterange((a, b)) if a == "2026-01-01" && b == "2026-02-01"
        ));
        assert!(coerce_input(&schema("r", InputType::Daterange), "2026-01-01").is_err());
        assert!(coerce_input(&schema("f", InputType::File), "x").is_err());
    }

    #[test]
    fn display() {
        assert_eq!(display_input(&ActualInput::Number(3.0)), "3");
        assert_eq!(display_input(&ActualInput::Str(String::new())), "(empty)");
        assert_eq!(
            display_type(&InputType::Select(vec!["x".into(), "y".into()])),
            "one of x | y"
        );
    }
}
