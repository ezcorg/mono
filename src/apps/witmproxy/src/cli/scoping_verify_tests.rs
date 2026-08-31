// The `Conf` and `Subcommands` derives generate public interfaces referencing
// these types, so they must stay `pub` even though nothing outside this
// `#[cfg(test)]` module can name them.
#![allow(unreachable_pub)]

//! Regression tests for the `conf` mechanics the scoped-subcommand-config
//! design (see `Cli`/`Command`) depends on:
//!  1. multiple subcommand variants can share `#[conf(serde(rename = "config"))]`
//!     and read the same `[config]` doc section;
//!  2. a scoped config struct with `#[conf(serde(allow_unknown_fields))]`
//!     ignores `[config.*]` tables it doesn't declare;
//!  3. a unit variant (no config) parses fine while the doc has `[config]`;
//!  4. CLI args still override doc values.

use conf::{Conf, Subcommands};

use crate::util::secret::Secret;

/// The `--db-password`-style shape: an optional secret whose bare-flag form
/// (`default_if_missing = ""`) parses to the empty "prompt me" sentinel.
#[derive(Conf, Debug)]
#[conf(serde)]
pub struct SecretCfg {
    #[arg(
        long = "secret-value",
        env = "SCOPETEST_SECRET_VALUE",
        default_if_missing = ""
    )]
    pub secret_value: Option<Secret>,
}

#[derive(Conf, Debug)]
#[conf(serde)]
pub struct SectionA {
    #[arg(
        long = "a-value",
        env = "SCOPETEST_A_VALUE",
        default_value = "a-default"
    )]
    pub a_value: String,
}

#[derive(Conf, Debug)]
#[conf(serde)]
pub struct SectionB {
    #[arg(
        long = "b-value",
        env = "SCOPETEST_B_VALUE",
        default_value = "b-default"
    )]
    pub b_value: String,
}

#[derive(Conf, Debug)]
#[conf(serde)]
pub struct FullCfg {
    #[arg(flatten)]
    pub a: SectionA,
    #[arg(flatten)]
    pub b: SectionB,
}

#[derive(Conf, Debug)]
#[conf(serde(allow_unknown_fields))]
pub struct ScopedCfg {
    #[arg(flatten)]
    pub a: SectionA,
}

/// The real shape used by `witm plugin`/`witm service`: the variant's args
/// struct carries a scoped config (lifted to the `[config]` scope via
/// `serde(flatten)`) AND a nested subcommands enum.
#[derive(Conf, Debug)]
#[conf(serde(allow_unknown_fields))]
pub struct NestedArgs {
    #[conf(flatten, serde(flatten))]
    pub config: ScopedCfg,
    #[arg(subcommands)]
    pub action: NestedAction,
}

#[derive(Subcommands, Debug)]
#[conf(serde)]
pub enum NestedAction {
    Add(AddArgs),
    List,
}

#[derive(Conf, Debug)]
#[conf(serde)]
pub struct AddArgs {
    #[arg(pos)]
    pub name: String,
}

/// The dispatcher-parent shape used by `witm service`/`witm plugin`/…: the
/// parent variant keeps its NATURAL serde name and its args struct carries
/// nothing but the nested subcommands; every LEAF variant is renamed
/// "config", so a leaf reads `doc[<parent>]["config"]` — which `parse_args`
/// populates with a mirror of the file's `[config]` table.
#[derive(Conf, Debug)]
#[conf(serde)]
pub struct SvcArgs {
    #[arg(subcommands)]
    pub action: SvcAction,
}

#[derive(Subcommands, Debug)]
#[conf(serde)]
pub enum SvcAction {
    #[conf(serde(rename = "config"))]
    Fire(LeafArgs),
    #[conf(serde(rename = "config"))]
    Halt(LeafArgs),
}

#[derive(Conf, Debug)]
#[conf(serde(allow_unknown_fields))]
pub struct LeafArgs {
    #[conf(flatten, serde(flatten))]
    pub config: ScopedCfg,
}

#[derive(Subcommands, Debug)]
#[conf(serde)]
pub enum Cmd {
    #[conf(serde(rename = "config"))]
    Full(FullCfg),
    #[conf(serde(rename = "config"))]
    Scoped(ScopedCfg),
    #[conf(serde(rename = "config"))]
    Nested(NestedArgs),
    Svc(SvcArgs),
    Sec(SecretCfg),
    Version,
}

#[derive(Conf, Debug)]
#[conf(serde(allow_unknown_fields))]
pub struct Root {
    #[arg(subcommands)]
    pub command: Cmd,
}

// The exact daemon-restart shape (see `nested_secret_section_reads_doc_on_restart`):
// a nested `serde(default)` section with a `default_if_missing` secret, inside
// a `serde(flatten)`'d config under a `serde(rename="config")` variant.
#[derive(Conf, Debug, serde::Deserialize, serde::Serialize, Default)]
#[conf(serde)]
pub struct RestartDbSection {
    #[arg(long = "db-password", default_if_missing = "")]
    pub db_password: Option<Secret>,
}

#[derive(Conf, Debug, serde::Deserialize, serde::Serialize, Default)]
#[conf(serde)]
pub struct RestartAppCfg {
    #[arg(flatten)]
    #[serde(default)]
    pub db: RestartDbSection,
}

#[derive(Conf, Debug)]
#[conf(serde)]
pub struct RestartRunCfg {
    #[conf(flatten, serde(flatten))]
    pub config: RestartAppCfg,
}

#[derive(Subcommands, Debug)]
#[conf(serde)]
pub enum RestartCmd {
    #[conf(serde(rename = "config"))]
    Run(RestartRunCfg),
}

#[derive(Conf, Debug)]
#[conf(serde(allow_unknown_fields))]
pub struct RestartRoot {
    #[arg(subcommands)]
    pub command: RestartCmd,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> toml::Value {
        // The shape `parse_args` synthesizes: the file's `[config]` table,
        // mirrored under each dispatcher-parent key for its leaves.
        toml::from_str(
            r#"
            [config.a]
            a_value = "a-from-file"
            [config.b]
            b_value = "b-from-file"
            [svc.config.a]
            a_value = "a-from-file"
            "#,
        )
        .unwrap()
    }

    fn parse(args: &[&str]) -> Result<Root, conf::Error> {
        Root::conf_builder()
            .args(args.iter().map(|s| s.to_string()))
            .doc("test.toml", doc())
            .try_parse()
    }

    #[test]
    fn full_variant_reads_all_sections_from_config_key() {
        let root = parse(&["witm", "full"]).unwrap();
        match root.command {
            Cmd::Full(cfg) => {
                assert_eq!(cfg.a.a_value, "a-from-file");
                assert_eq!(cfg.b.b_value, "b-from-file");
            }
            other => panic!("expected Full, got {other:?}"),
        }
    }

    #[test]
    fn scoped_variant_ignores_undeclared_sections() {
        let root = parse(&["witm", "scoped"]).unwrap();
        match root.command {
            Cmd::Scoped(cfg) => assert_eq!(cfg.a.a_value, "a-from-file"),
            other => panic!("expected Scoped, got {other:?}"),
        }
    }

    #[test]
    fn unit_variant_tolerates_config_section_in_doc() {
        let root = parse(&["witm", "version"]).unwrap();
        assert!(matches!(root.command, Cmd::Version));
    }

    #[test]
    fn cli_args_override_doc_values() {
        let root = parse(&["witm", "scoped", "--a-value", "from-cli"]).unwrap();
        match root.command {
            Cmd::Scoped(cfg) => assert_eq!(cfg.a.a_value, "from-cli"),
            other => panic!("expected Scoped, got {other:?}"),
        }
    }

    #[test]
    fn nested_subcommand_reads_scoped_config_and_ignores_rest() {
        let root = parse(&["witm", "nested", "add", "thing"]).unwrap();
        match root.command {
            Cmd::Nested(args) => {
                assert_eq!(args.config.a.a_value, "a-from-file");
                match args.action {
                    NestedAction::Add(add) => assert_eq!(add.name, "thing"),
                    other => panic!("expected Add, got {other:?}"),
                }
            }
            other => panic!("expected Nested, got {other:?}"),
        }
    }

    /// A leaf under a dispatcher parent (natural parent serde name, leaf
    /// renamed "config") reads `doc[<parent>]["config"]`; the strict parent
    /// dispatcher struct tolerates the "config" key because it matches its
    /// leaves' serde names.
    #[test]
    fn leaf_under_dispatcher_parent_reads_mirrored_config() {
        for leaf in ["fire", "halt"] {
            let root = parse(&["witm", "svc", leaf]).unwrap();
            match root.command {
                Cmd::Svc(svc) => {
                    let (SvcAction::Fire(a) | SvcAction::Halt(a)) = svc.action;
                    assert_eq!(a.config.a.a_value, "a-from-file", "leaf {leaf}");
                }
                other => panic!("expected Svc, got {other:?}"),
            }
        }
    }

    /// CLI args on the leaf override the mirrored doc values.
    #[test]
    fn leaf_cli_args_override_mirrored_doc() {
        let root = parse(&["witm", "svc", "fire", "--a-value", "leaf-cli"]).unwrap();
        match root.command {
            Cmd::Svc(svc) => {
                let (SvcAction::Fire(a) | SvcAction::Halt(a)) = svc.action;
                assert_eq!(a.config.a.a_value, "leaf-cli");
            }
            other => panic!("expected Svc, got {other:?}"),
        }
    }

    /// The three input shapes of an optional-value secret flag:
    /// `--secret-value v` → the value; bare `--secret-value` → the empty
    /// "prompt me" sentinel; absent → `None`.
    #[test]
    fn secret_flag_value_bare_and_absent() {
        let with_value = parse(&["witm", "sec", "--secret-value", "hunter2"]).unwrap();
        let Cmd::Sec(cfg) = with_value.command else {
            panic!("expected Sec");
        };
        assert_eq!(cfg.secret_value.unwrap().expose(), "hunter2");

        let bare = parse(&["witm", "sec", "--secret-value"]).unwrap();
        let Cmd::Sec(cfg) = bare.command else {
            panic!("expected Sec");
        };
        assert!(cfg.secret_value.is_some_and(|s| s.is_empty()));

        let absent = parse(&["witm", "sec"]).unwrap();
        let Cmd::Sec(cfg) = absent.command else {
            panic!("expected Sec");
        };
        assert!(cfg.secret_value.is_none());
    }

    /// When the secret flag is ABSENT, its value must still come from the
    /// config doc (file layer) — `default_if_missing` applies only to a
    /// present-but-valueless flag, not an absent one. This is the daemon
    /// restart path: `db_password` persisted to the file must be read back.
    #[test]
    fn absent_secret_flag_reads_doc_value() {
        let doc: toml::Value = toml::from_str(r#"secret_value = "from-file""#).unwrap();
        let parsed = SecretCfg::conf_builder()
            .args(["witm"].map(String::from))
            .doc("test.toml", doc)
            .try_parse()
            .unwrap();
        assert_eq!(
            parsed.secret_value.as_ref().map(|s| s.expose()),
            Some("from-file"),
            "an absent secret flag must fall through to the config file"
        );
    }

    /// The REAL daemon-restart composition: a `serde(rename="config")` variant
    /// whose flattened config has a nested `serde(default)` section holding a
    /// `default_if_missing` secret. `[config.db] db_password = …` in the file
    /// must reach the field when the flag is absent.
    #[test]
    fn nested_secret_section_reads_doc_on_restart() {
        let doc: toml::Value = toml::from_str(
            r#"
            [config.db]
            db_password = "persisted"
            "#,
        )
        .unwrap();
        let r = RestartRoot::conf_builder()
            .args(["witm", "run"].map(String::from))
            .doc("test.toml", doc)
            .try_parse()
            .unwrap();
        let RestartCmd::Run(cfg) = r.command;
        assert_eq!(
            cfg.config.db.db_password.as_ref().map(|s| s.expose()),
            Some("persisted"),
            "persisted db_password must be read back on restart"
        );
    }

    /// A bare secret flag followed by another flag must not swallow it.
    #[test]
    fn bare_secret_flag_does_not_consume_next_flag() {
        #[derive(Conf, Debug)]
        #[conf(serde)]
        pub struct TwoFlags {
            #[arg(long = "secret-value", default_if_missing = "")]
            pub secret_value: Option<Secret>,
            #[arg(long = "other")]
            pub other: bool,
        }
        let parsed = TwoFlags::conf_builder()
            .args(["witm", "--secret-value", "--other"].map(String::from))
            .try_parse()
            .unwrap();
        assert!(parsed.secret_value.is_some_and(|s| s.is_empty()));
        assert!(parsed.other);
    }

    /// The scoped options must be accepted AFTER the nested subcommand too
    /// (they're declared on the variant's args struct, not the nested enum).
    #[test]
    fn parent_options_position_relative_to_nested_subcommand() {
        // Before the nested subcommand definitely works:
        let root = parse(&["witm", "nested", "--a-value", "cli-a", "list"]).unwrap();
        match root.command {
            Cmd::Nested(args) => {
                assert_eq!(args.config.a.a_value, "cli-a");
                assert!(matches!(args.action, NestedAction::List));
            }
            other => panic!("expected Nested, got {other:?}"),
        }
    }
}
