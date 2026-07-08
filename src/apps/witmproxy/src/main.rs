use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = witmproxy::cli::Cli::parse_args();
    cli.run().await
}
