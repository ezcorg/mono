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
    /// Validate a component and print its world (imports, exports, hash).
    Inspect {
        wasm: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// Validate and add a component to the daemon's store.
    Add {
        wasm: PathBuf,
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

fn ws(daemon: &str) -> anyhow::Result<wrpc_websockets::Client<'static>> {
    let builder = wrpc_websockets::tokio_websockets::ClientBuilder::new()
        .uri(daemon)
        .with_context(|| format!("daemon url `{daemon}`"))?;
    Ok(wrpc_websockets::Client::from_builder(builder))
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
    use wac_graph::{CompositionGraph, EncodeOptions};
    use wac_types::Package;
    let mut graph = CompositionGraph::new();
    let mut instances: Vec<(wac_graph::NodeId, Vec<String>)> = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
        components::validate(&bytes)
            .with_context(|| format!("{} is not a capability component", path.display()))?;
        let package = Package::from_bytes(&format!("compose:c{i}"), None, bytes, graph.types_mut())
            .with_context(|| format!("parse {}", path.display()))?;
        let world = &graph.types()[package.ty()];
        let imports: Vec<String> = world.imports.keys().cloned().collect();
        let exports: Vec<String> = world.exports.keys().cloned().collect();
        let pid = graph.register_package(package)?;
        let inst = graph.instantiate(pid);
        for import in &imports {
            if let Some((src, _)) = instances.iter().rev().find(|(_, ex)| ex.contains(import)) {
                let alias = graph.alias_instance_export(*src, import)?;
                graph.set_instantiation_argument(inst, import, alias)?;
                eprintln!(
                    "  {} ← {} from {}",
                    import,
                    path.display(),
                    paths[instances.iter().position(|(n, _)| n == src).unwrap_or(0)].display()
                );
            }
        }
        instances.push((inst, exports));
    }
    let Some((last, exports)) = instances.last() else {
        bail!("nothing to compose");
    };
    for e in exports {
        let alias = graph.alias_instance_export(*last, e)?;
        graph.export(alias, e.as_str())?;
    }
    let bytes = graph.encode(EncodeOptions::default())?;
    let info =
        components::validate(&bytes).context("the composition is not a capability component")?;
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
            let bytes = std::fs::read(&wasm).with_context(|| format!("read {}", wasm.display()))?;
            components::validate(&bytes)?;
            let client = ws(&daemon)?;
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
        Capability::List { daemon, json } => {
            let client = ws(&daemon)?;
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
            let client = ws(&daemon)?;
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
