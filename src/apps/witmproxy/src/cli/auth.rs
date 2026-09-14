use anyhow::Result;
use conf::{Conf, Subcommands};

use super::GlobalArgs;
use crate::config::PluginScopedConfig;
use crate::db::{Db, tenants::Tenant};

use crate::cli::api_client::{ApiClient, AuthStore, LocalDaemon};

#[derive(Subcommands)]
#[conf(serde)]
pub enum AuthCommands {
    /// Login to a remote witmproxy server
    Login(AuthLoginArgs),
    /// Logout (remove stored credentials)
    Logout(GlobalArgs),
    /// Show current auth status
    Status(GlobalArgs),
    /// Set an account's password directly in the local database (for
    /// recovering the admin account; the daemon picks it up immediately)
    #[conf(serde(rename = "config"))]
    SetPassword(AuthSetPasswordArgs),
}

#[derive(Conf)]
#[conf(serde(allow_unknown_fields))]
pub struct AuthSetPasswordArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,
    #[conf(flatten, serde(flatten))]
    pub config: PluginScopedConfig,

    /// Account email (default: admin@localhost)
    #[arg(long, default_value = "admin@localhost")]
    pub email: String,
    /// The new password; prompted for (twice, unechoed) when omitted
    #[arg(long, env = "WITM_NEW_PASSWORD")]
    pub password: Option<String>,
}

#[derive(Conf)]
#[conf(serde)]
pub struct AuthLoginArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,

    /// Server URL (default: the daemon running on this machine)
    #[arg(long, env = "WITM_SERVER")]
    pub server: Option<String>,
    /// Email address
    #[arg(long)]
    pub email: Option<String>,
}

impl AuthCommands {
    pub(crate) fn globals(&self) -> &GlobalArgs {
        match self {
            AuthCommands::Login(a) => &a.globals,
            AuthCommands::Logout(g) | AuthCommands::Status(g) => g,
            AuthCommands::SetPassword(a) => &a.globals,
        }
    }
}

pub struct AuthHandler;

impl AuthHandler {
    pub async fn handle(&self, command: &AuthCommands) -> Result<()> {
        match command {
            AuthCommands::Login(a) => self.login(a.server.as_deref(), a.email.as_deref()).await,
            AuthCommands::Logout(_) => self.logout(),
            AuthCommands::Status(_) => self.status(),
            AuthCommands::SetPassword(a) => self.set_password(a).await,
        }
    }

    async fn set_password(&self, args: &AuthSetPasswordArgs) -> Result<()> {
        let password = match &args.password {
            Some(p) => crate::config::Secret::from(p.clone()),
            None => {
                let first = crate::util::secret::prompt("New password")?;
                let again = crate::util::secret::prompt("Repeat new password")?;
                if first.expose() != again.expose() {
                    anyhow::bail!("The passwords do not match.");
                }
                first
            }
        };
        if password.expose().is_empty() {
            anyhow::bail!("The password must not be empty.");
        }

        let config = args.config.clone().with_resolved_paths()?;
        let db_password = config.db.resolve_password()?;
        let db = Db::from_path(config.db.db_path.clone(), db_password.expose()).await?;
        drop(db_password);
        db.migrate().await?;

        set_password_for_email(&db, &args.email, password.expose()).await?;
        println!(
            "Password updated for {}. It takes effect on the next login; existing tokens stay valid.",
            args.email
        );
        Ok(())
    }

    async fn login(&self, server: Option<&str>, email: Option<&str>) -> Result<()> {
        let local = LocalDaemon::from_default_paths();
        let server = match server {
            Some(s) => crate::cli::api_client::normalise_server_url(s),
            None => local.web_url.clone().ok_or_else(|| {
                anyhow::anyhow!(
                    "No --server given and no local daemon found (is witmproxy running?)"
                )
            })?,
        };
        let server = server.as_str();
        println!("Logging in to {server}");
        let email = match email {
            Some(e) => e.to_string(),
            None => {
                use std::io::Write;
                print!("Email: ");
                std::io::stdout().flush()?;
                let mut input = String::new();
                std::io::stdin().read_line(&mut input)?;
                input.trim().to_string()
            }
        };

        let password = read_password()?;

        let client = ApiClient::new(server, None, local.root_cert)?;
        let result = client.login(&email, &password).await?;

        if let Some(token) = result.get("token").and_then(|t| t.as_str()) {
            let store = AuthStore {
                token: token.to_string(),
                server_url: server.to_string(),
            };
            store.save()?;
            println!("Login successful. Credentials saved.");
            if let Some(tenant_id) = result.get("tenant_id").and_then(|t| t.as_str()) {
                println!("Tenant ID: {}", tenant_id);
            }
        } else {
            println!("Login failed: {}", result);
        }

        Ok(())
    }

    fn logout(&self) -> Result<()> {
        AuthStore::remove()?;
        println!("Logged out. Credentials removed.");
        Ok(())
    }

    fn status(&self) -> Result<()> {
        match AuthStore::load()? {
            Some(store) => {
                println!("Authenticated");
                println!("Server: {}", store.server_url);
            }
            None => {
                println!("Not authenticated. Use 'witm auth login' to log in.");
            }
        }
        Ok(())
    }
}

/// Prompt for the password without echo on a terminal; when stdin is a pipe
/// (scripts, tests) read one line from it instead, since `rpassword` needs a
/// TTY to open.
fn read_password() -> Result<String> {
    use std::io::{IsTerminal, Write};
    if std::io::stdin().is_terminal() {
        let password = rpassword::prompt_password("Password: ")?;
        return Ok(password.trim_end_matches(['\r', '\n']).to_string());
    }
    print!("Password: ");
    std::io::stdout().flush()?;
    let mut input = String::new();
    std::io::stdin().read_line(&mut input)?;
    println!();
    Ok(input.trim_end_matches(['\r', '\n']).to_string())
}

/// Hash `password` and store it on the account with `email`.
pub(crate) async fn set_password_for_email(db: &Db, email: &str, password: &str) -> Result<()> {
    let tenant = Tenant::by_email(&db.pool, email)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No account with email {email}"))?;
    let hash = crate::web::auth::hash_password(password)
        .map_err(|e| anyhow::anyhow!("Failed to hash password: {e}"))?;
    Tenant::update_password_hash(&db.pool, &tenant.id, &hash).await
}
