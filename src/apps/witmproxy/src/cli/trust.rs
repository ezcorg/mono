use crate::{cert::CertificateAuthority, config::AppConfig};
use anyhow::Result;
use conf::{Conf, Subcommands};

#[derive(Subcommands)]
#[conf(serde)]
pub enum CaCommands {
    /// Install the root CA certificate to system trust store
    Install(CaActionArgs),
    /// Uninstall the root CA certificate from system trust store
    Uninstall(CaActionArgs),
    /// Show the status of the root CA certificate in system trust store
    Status,
}

#[derive(Conf)]
#[conf(serde)]
pub struct CaActionArgs {
    /// Skip confirmation prompts
    #[arg(short, long)]
    pub yes: bool,
    /// Show what would be done without actually doing it
    #[arg(short = 'n', long)]
    pub dry_run: bool,
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
            CaCommands::Install(a) => ca.install_root_certificate(a.yes, a.dry_run).await,
            CaCommands::Uninstall(a) => ca.remove_root_certificate(a.yes, a.dry_run).await,
            CaCommands::Status => ca.check_root_certificate_status().await,
        }
    }
}
