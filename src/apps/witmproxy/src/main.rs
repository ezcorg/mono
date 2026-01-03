use anyhow::Result;
use clap::Parser;
use wasmtime_wasi::runtime::with_ambient_tokio_runtime;

#[tokio::main]
async fn main() -> Result<()> {
    with_ambient_tokio_runtime(async move || {
        let cli = witmproxy::cli::Cli::parse();
        cli.run().await
    })
    .await
}
