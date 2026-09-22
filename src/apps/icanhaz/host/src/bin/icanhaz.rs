//! `icanhaz`: the command line for authoring capabilities.
//!
//!   icanhaz capability inspect <wasm>            validate + print the world
//!   icanhaz capability add <wasm>                store it in the daemon by hash
//!   icanhaz capability list | get <hash> -o f    the store
//!   icanhaz capability compose a.wasm b.wasm -o  wac: later components' imports
//!                                                from earlier ones' exports
//!   icanhaz capability new <name> --export I     a novel capability scaffold
//!   icanhaz capability wrap <interface>          a wrapping scaffold

use std::path::PathBuf;

use anyhow::{bail, Context as _};
use clap::{Parser, Subcommand};

use icanhaz_host::components::{self, client as components_client};
use icanhaz_host::configuration_serve::client as configuration_client;
use icanhaz_host::scaffold::{self, WorldSpec};

#[derive(Parser)]
#[command(
    name = "icanhaz",
    about = "icanhaz: capabilities, from the command line"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Author, validate, store and compose capability components.
    Capability {
        #[command(subcommand)]
        cmd: Capability,
    },
}

#[derive(Subcommand)]
enum Capability {
    /// Set one configured instance: `icanhaz capability configure registry default username=theo password:secret=pw`.
    /// A value is `key=value` (text), or typed as `key:secret=`, `key:boolean=`,
    /// `key:number=`, `key:select=`.
    Configure {
        capability: String,
        instance: String,
        #[arg(required = true)]
        values: Vec<String>,
        #[arg(long, env = "ICANHAZ_WS", default_value = "ws://127.0.0.1:7777")]
        daemon: String,
    },
    /// Remove one configured instance.
    Unconfigure {
        capability: String,
        instance: String,
        #[arg(long, env = "ICANHAZ_WS", default_value = "ws://127.0.0.1:7777")]
        daemon: String,
    },
    /// Validate a component and print its world (imports, exports, hash).
    Inspect {
        wasm: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// Add a component to the daemon's store: a local `.wasm` (validated
    /// here first), an OCI reference (`oci://ghcr.io/org/name:tag`), or a
    /// component another daemon holds (`iroh:<key>?addr=…#sha256:<hex>`).
    /// The daemon fetches the latter two itself and records where from.
    Add {
        wasm: String,
        #[arg(long, env = "ICANHAZ_WS", default_value = "ws://127.0.0.1:7777")]
        daemon: String,
        /// Provenance: where the source lives (a repository or URL).
        #[arg(long)]
        source: Option<String>,
        /// The commit, tag or content hash within the source.
        #[arg(long)]
        revision: Option<String>,
        /// The command that produced the bytes.
        #[arg(long)]
        build: Option<String>,
        /// The toolchain or container image, by name or hash.
        #[arg(long)]
        builder: Option<String>,
    },
    /// Publish a held component in the daemon's own registry under
    /// `<name>:<tag>`, for others to pull with the registry credential.
    Publish {
        hash: String,
        reference: String,
        #[arg(long, env = "ICANHAZ_WS", default_value = "ws://127.0.0.1:7777")]
        daemon: String,
    },
    /// Forget a published tag (the component stays in the store).
    Unpublish {
        reference: String,
        #[arg(long, env = "ICANHAZ_WS", default_value = "ws://127.0.0.1:7777")]
        daemon: String,
    },
    /// The tags the daemon's registry serves.
    Published {
        #[arg(long, env = "ICANHAZ_WS", default_value = "ws://127.0.0.1:7777")]
        daemon: String,
    },
    /// The components in the daemon's store.
    List {
        #[arg(long, env = "ICANHAZ_WS", default_value = "ws://127.0.0.1:7777")]
        daemon: String,
        #[arg(long)]
        json: bool,
    },
    /// Fetch a component from the store by hash.
    Get {
        hash: String,
        #[arg(short, long)]
        out: PathBuf,
        #[arg(long, env = "ICANHAZ_WS", default_value = "ws://127.0.0.1:7777")]
        daemon: String,
    },
    /// Compose components with wac: each later component's imports are
    /// satisfied by earlier ones' exports; what remains is imported; the last
    /// component's exports are exported.
    Compose {
        #[arg(required = true)]
        components: Vec<PathBuf>,
        #[arg(short, long)]
        out: PathBuf,
    },
    /// Scaffold a novel capability crate.
    New {
        name: String,
        /// Interfaces it exports (`icanhaz:nocap/workspace@0.1.0`).
        #[arg(long = "export", required = true)]
        exports: Vec<String>,
        /// Interfaces it imports.
        #[arg(long = "import")]
        imports: Vec<String>,
        #[arg(long, default_value = "An icanhaz capability")]
        description: String,
        #[arg(long, default_value = "rust")]
        lang: String,
        #[arg(short, long)]
        out: Option<PathBuf>,
        /// The daemon's WIT directory to vendor (defaults to the repo's).
        #[arg(long)]
        wit: Option<PathBuf>,
    },
    /// Scaffold a crate that wraps an existing capability: imports and exports
    /// the same interface, forwarding what it does not refuse or rewrite.
    Wrap {
        /// The interface to wrap (`icanhaz:nocap/workspace@0.1.0`).
        interface: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long, default_value = "rust")]
        lang: String,
        #[arg(short, long)]
        out: Option<PathBuf>,
        #[arg(long)]
        wit: Option<PathBuf>,
    },
}

async fn ws(daemon: &str) -> anyhow::Result<icanhaz_host::ws_client::MuxClient> {
    icanhaz_host::ws_client::MuxClient::connect(daemon).await
}

fn print_info(info: &components::ComponentInfo, json: bool) -> anyhow::Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(info)?);
        return Ok(());
    }
    println!(
        "{}  {}  {} bytes",
        info.hash,
        info.name.as_deref().unwrap_or("-"),
        info.size
    );
    if let Some(p) = &info.provenance {
        println!(
            "  from {}{}{}",
            p.source,
            p.revision
                .as_ref()
                .map(|r| format!(" @ {r}"))
                .unwrap_or_default(),
            if info.reproducible {
                " (reproducible)"
            } else {
                ""
            }
        );
    }
    for i in &info.imports {
        println!("  import {i}");
    }
    for e in &info.exports {
        println!("  export {e}");
    }
    Ok(())
}

fn compose(paths: &[PathBuf], out: &PathBuf) -> anyhow::Result<()> {
    let mut parts = Vec::new();
    for path in paths {
        parts.push(std::fs::read(path).with_context(|| format!("read {}", path.display()))?);
    }
    let bytes = components::compose(&parts)?;
    let info = components::validate(&bytes)?;
    std::fs::write(out, &bytes).with_context(|| format!("write {}", out.display()))?;
    print_info(&info, false)?;
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let Cmd::Capability { cmd } = cli.cmd;
    match cmd {
        Capability::Inspect { wasm, json } => {
            let bytes = std::fs::read(&wasm).with_context(|| format!("read {}", wasm.display()))?;
            match components::validate(&bytes) {
                Ok(info) => print_info(&info, json)?,
                Err(e) => {
                    let (name, imports, exports) = components::inspect(&bytes).unwrap_or_default();
                    eprintln!("not a capability component: {e:#}");
                    if let Some(n) = name {
                        eprintln!("  world {n}");
                    }
                    for i in imports {
                        eprintln!("  import {i}");
                    }
                    for x in exports {
                        eprintln!("  export {x}");
                    }
                    std::process::exit(1);
                }
            }
        }
        Capability::Add {
            wasm,
            daemon,
            source,
            revision,
            build,
            builder,
        } => {
            let client = ws(&daemon).await?;
            if icanhaz_host::fetch::ComponentSource::is_source(&wasm) {
                icanhaz_host::fetch::ComponentSource::parse(&wasm)?;
                match components_client::fetch(&client, (), &wasm).await? {
                    Ok(info) => println!("{}", info.hash),
                    Err(e) => bail!("{e}"),
                }
                return Ok(());
            }
            let bytes = std::fs::read(&wasm).with_context(|| format!("read {wasm}"))?;
            components::validate(&bytes)?;
            let provenance = source.map(|source| components_client::Provenance {
                source,
                revision,
                build,
                builder,
            });
            match components_client::add(&client, (), &bytes.into(), provenance).await? {
                Ok(info) => println!("{}", info.hash),
                Err(e) => bail!("{e}"),
            }
        }
        Capability::Configure {
            capability,
            instance,
            values,
            daemon,
        } => {
            use icanhaz_host::configuration_serve::bindings::ezco::ezcap::forms::{
                ActualInput, UserInput,
            };
            let mut inputs = Vec::new();
            for v in &values {
                let (key, value) = v
                    .split_once('=')
                    .with_context(|| format!("`{v}` is not key=value"))?;
                let (name, ty) = key.split_once(':').unwrap_or((key, "str"));
                let value = match ty {
                    "str" => ActualInput::Str(value.to_string()),
                    "secret" => ActualInput::Secret(value.to_string()),
                    "select" => ActualInput::Select(value.to_string()),
                    "boolean" => ActualInput::Boolean(value.parse().with_context(|| format!("`{value}` is not a boolean"))?),
                    "number" => ActualInput::Number(value.parse().with_context(|| format!("`{value}` is not a number"))?),
                    "datetime" => ActualInput::Datetime(value.to_string()),
                    other => bail!("`{other}` is not an input type (str, secret, select, boolean, number, datetime)"),
                };
                inputs.push(UserInput {
                    name: name.to_string(),
                    value,
                });
            }
            let client = ws(&daemon).await?;
            match configuration_client::configure(&client, (), &capability, &instance, &inputs)
                .await?
            {
                Ok(()) => println!("configured {capability} {instance}"),
                Err(e) => bail!("{e}"),
            }
        }
        Capability::Unconfigure {
            capability,
            instance,
            daemon,
        } => {
            let client = ws(&daemon).await?;
            match configuration_client::unconfigure(&client, (), &capability, &instance).await? {
                Ok(true) => println!("removed {capability} {instance}"),
                Ok(false) => println!("{capability} {instance} was not configured"),
                Err(e) => bail!("{e}"),
            }
        }
        Capability::Publish {
            hash,
            reference,
            daemon,
        } => {
            let client = ws(&daemon).await?;
            match components_client::publish(&client, (), &hash, &reference).await? {
                Ok(p) => println!("{}\t{}", p.reference, p.digest),
                Err(e) => bail!("{e}"),
            }
        }
        Capability::Unpublish { reference, daemon } => {
            let client = ws(&daemon).await?;
            match components_client::unpublish(&client, (), &reference).await? {
                Ok(true) => println!("unpublished {reference}"),
                Ok(false) => println!("{reference} was not published"),
                Err(e) => bail!("{e}"),
            }
        }
        Capability::Published { daemon } => {
            let client = ws(&daemon).await?;
            for p in components_client::published(&client, ()).await? {
                println!("{}\t{}\t{}", p.reference, p.digest, p.hash);
            }
        }
        Capability::List { daemon, json } => {
            let client = ws(&daemon).await?;
            let list = components_client::all(&client, ()).await?;
            for c in list {
                let info = components::ComponentInfo {
                    hash: c.hash,
                    name: c.name,
                    size: c.size,
                    imports: c.imports,
                    exports: c.exports,
                    added: c.added,
                    provenance: c.provenance.map(|p| components::Provenance {
                        source: p.source,
                        revision: p.revision,
                        build: p.build,
                        builder: p.builder,
                    }),
                    reproducible: c.reproducible,
                };
                print_info(&info, json)?;
            }
        }
        Capability::Get { hash, out, daemon } => {
            let client = ws(&daemon).await?;
            match components_client::get(&client, (), &hash).await? {
                Ok(bytes) => {
                    std::fs::write(&out, &bytes)?;
                    println!("{} ({} bytes)", out.display(), bytes.len());
                }
                Err(e) => bail!("{e}"),
            }
        }
        Capability::Compose { components, out } => compose(&components, &out)?,
        Capability::New {
            name,
            exports,
            imports,
            description,
            lang,
            out,
            wit,
        } => {
            if lang != "rust" {
                bail!("only `rust` scaffolds exist yet; `{lang}` is next");
            }
            let out = out.unwrap_or_else(|| PathBuf::from(&name));
            scaffold::rust_capability(
                &out,
                &name,
                &description,
                &WorldSpec { exports, imports },
                &wit.unwrap_or_else(scaffold::default_wit_dir),
                false,
            )?;
            println!("{}: a new capability. See AGENTS.md.", out.display());
        }
        Capability::Wrap {
            interface,
            name,
            lang,
            out,
            wit,
        } => {
            if lang != "rust" {
                bail!("only `rust` scaffolds exist yet; `{lang}` is next");
            }
            let short = interface
                .rsplit('/')
                .next()
                .unwrap_or(&interface)
                .split('@')
                .next()
                .unwrap_or(&interface)
                .to_string();
            let name = name.unwrap_or_else(|| format!("{short}-wrap"));
            let out = out.unwrap_or_else(|| PathBuf::from(&name));
            scaffold::rust_capability(
                &out,
                &name,
                &format!("wraps {interface}"),
                &WorldSpec {
                    exports: vec![interface.clone()],
                    imports: vec![interface],
                },
                &wit.unwrap_or_else(scaffold::default_wit_dir),
                true,
            )?;
            println!("{}: a wrapper. See AGENTS.md.", out.display());
        }
    }
    Ok(())
}
