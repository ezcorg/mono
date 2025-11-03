use anyhow::Result;
use clap::Parser;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = witmproxy::cli::Cli::parse();
    cli.run().await
}
