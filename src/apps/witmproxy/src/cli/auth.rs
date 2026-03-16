use anyhow::Result;
use clap::Subcommand;

use crate::cli::api_client::{ApiClient, AuthStore};

#[derive(Subcommand)]
pub enum AuthCommands {
    /// Login to a remote witmproxy server
    Login {
        /// Server URL
        #[arg(long)]
        server: String,
        /// Email address
        #[arg(long)]
        email: Option<String>,
    },
    /// Logout (remove stored credentials)
    Logout,
    /// Show current auth status
    Status,
}

pub struct AuthHandler;

impl AuthHandler {
    pub async fn handle(&self, command: &AuthCommands) -> Result<()> {
        match command {
            AuthCommands::Login { server, email } => self.login(server, email.as_deref()).await,
            AuthCommands::Logout => self.logout(),
            AuthCommands::Status => self.status(),
        }
    }

    async fn login(&self, server: &str, email: Option<&str>) -> Result<()> {
        let email = match email {
            Some(e) => e.to_string(),
            None => {
                print!("Email: ");
                let mut input = String::new();
                std::io::stdin().read_line(&mut input)?;
                input.trim().to_string()
            }
        };

        print!("Password: ");
        let password = rpassword_fallback()?;

        let client = ApiClient::new(server, None);
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

/// Simple password reading fallback (reads from stdin without echo when possible).
fn rpassword_fallback() -> Result<String> {
    let mut input = String::new();
    std::io::stdin().read_line(&mut input)?;
    Ok(input.trim().to_string())
}
