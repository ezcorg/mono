//! `icanhazd` — the icanhaz daemon (v0).
//!
//! Serves an interactive terminal to this machine over a WebSocket, gated by a
//! one-time PIN (your consent) and meant to sit behind `tailscale serve` for
//! TLS + a tailnet endpoint. The browser client lives in `../web`.
//!
//! This is the shipping vertical slice. The general capability layer (the full
//! NoCap broker + every WASI capability, served over wRPC) is the `provider`
//! world in `../wit` and is the next milestone — see README.

mod protocol;
mod pty;
mod rpc;
mod server;

use anyhow::Result;
use clap::Parser;

#[derive(Parser)]
#[command(name = "icanhazd", version, about = "An interactive terminal to this machine, for your browser.")]
struct Args {
    /// Address to bind. Plain ws — front it with `tailscale serve` for TLS.
    #[arg(long, default_value = "127.0.0.1:7777")]
    bind: String,

    /// Shell to run. Defaults to $SHELL, else /bin/bash.
    #[arg(long)]
    shell: Option<String>,

    /// PIN a client must present (your consent). Generated + printed if omitted.
    #[arg(long)]
    pin: Option<String>,

    /// Allow the *real* host shell, not just a jailed one. Until sandboxing
    /// lands this is full access to your account — opt in deliberately.
    #[arg(long)]
    allow_host_shell: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    let args = Args::parse();
    let shell = args
        .shell
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/bash".into());
    let pin = args.pin.unwrap_or_else(generate_pin);

    println!("icanhaz daemon (v0)");
    println!("  bind:  ws://{}", args.bind);
    println!(
        "  shell: {shell}{}",
        if args.allow_host_shell {
            "   [HOST SHELL ALLOWED]"
        } else {
            "   (pass --allow-host-shell for a real shell)"
        }
    );
    println!("  PIN:   {pin}   ← enter this in the browser to connect");
    println!();
    println!("expose on your tailnet:  tailscale serve https / http://{}", args.bind);
    println!();

    server::run(server::Config {
        bind: args.bind,
        pin,
        shell,
        allow_host_shell: args.allow_host_shell,
    })
    .await
}

fn generate_pin() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..6)
        .map(|_| char::from(b'0' + rng.gen_range(0u8..10)))
        .collect()
}
