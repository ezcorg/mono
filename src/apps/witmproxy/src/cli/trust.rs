// The `Conf` / `Subcommands` derives generate public interfaces over these
// types, so they must stay `pub` even though this module is private and
// nothing outside the crate can name them. `pub(crate)` fails with E0446.
#![allow(unreachable_pub)]

use super::GlobalArgs;
use crate::{
    cert::CertificateAuthority,
    config::{TlsConfig, TlsScopedConfig},
};
use anyhow::Result;
use conf::{Conf, Subcommands};

#[derive(Subcommands)]
#[conf(serde)]
pub enum CaCommands {
    /// Install the root CA certificate to system trust store
    #[conf(serde(rename = "config"))]
    Install(CaActionArgs),
    /// Uninstall the root CA certificate from system trust store
    #[conf(serde(rename = "config"))]
    Uninstall(CaActionArgs),
    /// Show the status of the root CA certificate in system trust store
    #[conf(serde(rename = "config"))]
    Status(CaStatusArgs),
}

impl CaCommands {
    /// The config scope + shared flags carried by whichever leaf was invoked.
    pub(crate) fn scope(&self) -> (&TlsScopedConfig, &GlobalArgs) {
        match self {
            CaCommands::Install(a) | CaCommands::Uninstall(a) => (&a.config, &a.globals),
            CaCommands::Status(a) => (&a.config, &a.globals),
        }
    }
}

#[derive(Conf)]
#[conf(serde(allow_unknown_fields))]
pub struct CaActionArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,
    #[conf(flatten, serde(flatten))]
    pub config: TlsScopedConfig,

    /// Skip confirmation prompts
    #[arg(short, long)]
    pub yes: bool,
    /// Show what would be done without actually doing it
    #[arg(short = 'n', long)]
    pub dry_run: bool,
}

#[derive(Conf)]
#[conf(serde(allow_unknown_fields))]
pub struct CaStatusArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,
    #[conf(flatten, serde(flatten))]
    pub config: TlsScopedConfig,
}

pub struct CaHandler {
    tls: TlsConfig,
}

impl CaHandler {
    pub fn new(tls: TlsConfig) -> Self {
        Self { tls }
    }

    pub async fn handle(&self, command: &CaCommands) -> Result<()> {
        // Create certificate authority to access the root certificate
        let ca = CertificateAuthority::new(&self.tls.cert_dir).await?;

        match command {
            CaCommands::Install(a) => ca.install_root_certificate(a.yes, a.dry_run).await,
            CaCommands::Uninstall(a) => ca.remove_root_certificate(a.yes, a.dry_run).await,
            CaCommands::Status(_) => ca.check_root_certificate_status().await,
        }
    }
}
