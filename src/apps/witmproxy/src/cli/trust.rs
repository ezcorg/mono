use anyhow::Result;
use clap::Subcommand;
use crate::{config::AppConfig, cert::CertificateAuthority};

#[derive(Subcommand)]
pub enum TrustCommands {
    /// Install the root CA certificate to system trust store
    Install {
        /// Skip confirmation prompts
        #[arg(short, long)]
        yes: bool,
        /// Show what would be done without actually doing it
        #[arg(short = 'n', long)]
        dry_run: bool,
    },
    /// Remove the root CA certificate from system trust store
    Remove {
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

pub struct TrustHandler {
    config: AppConfig,
}

impl TrustHandler {
    pub fn new(config: AppConfig) -> Self {
        Self { config }
    }

    pub async fn handle(&self, command: &TrustCommands) -> Result<()> {
        // Create certificate authority to access the root certificate
        let ca = CertificateAuthority::new(&self.config.tls.cert_dir).await?;
        
        match command {
            TrustCommands::Install { yes, dry_run } => {
                ca.install_root_certificate(*yes, *dry_run).await
            }
            TrustCommands::Remove { yes, dry_run } => {
                ca.remove_root_certificate(*yes, *dry_run).await
            }
            TrustCommands::Status => {
                ca.check_root_certificate_status().await
            }
        }
    }
}