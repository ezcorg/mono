use crate::{cert::CertificateAuthority, config::AppConfig};
use anyhow::Result;
use clap::Subcommand;

#[derive(Subcommand)]
pub enum CaCommands {
    /// Install the root CA certificate to system trust store
    Install {
        /// Skip confirmation prompts
        #[arg(short, long)]
        yes: bool,
        /// Show what would be done without actually doing it
        #[arg(short = 'n', long)]
        dry_run: bool,
    },
    /// Uninstall the root CA certificate from system trust store
    Uninstall {
        /// Skip confirmation prompts
        #[arg(short, long)]
        yes: bool,
        /// Show what would be done without actually doing it
        #[arg(short = 'n', long)]
        dry_run: bool,
    },
    /// Show the status of the root CA certificate in system trust store
    Status,
}

pub struct CaHandler {
    config: AppConfig,
}

impl CaHandler {
    pub fn new(config: AppConfig) -> Self {
        Self { config }
    }

    pub async fn handle(&self, command: &CaCommands) -> Result<()> {
        // Create certificate authority to access the root certificate
        let ca = CertificateAuthority::new(&self.config.tls.cert_dir).await?;

        match command {
            CaCommands::Install { yes, dry_run } => {
                ca.install_root_certificate(*yes, *dry_run).await
            }
            CaCommands::Uninstall { yes, dry_run } => {
                ca.remove_root_certificate(*yes, *dry_run).await
            }
            CaCommands::Status => ca.check_root_certificate_status().await,
        }
    }
}
