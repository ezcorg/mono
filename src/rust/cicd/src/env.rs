/// The environment the CLI is running in.
#[derive(Debug)]
pub enum Environment {
    Local,
    GitHubActions {
        token: Option<String>,
        ref_name: String,
        event_name: String,
    },
}

impl Environment {
    pub fn detect() -> Self {
        if std::env::var("GITHUB_ACTIONS").is_ok() {
            Environment::GitHubActions {
                token: std::env::var("GITHUB_TOKEN").ok(),
                ref_name: std::env::var("GITHUB_REF_NAME").unwrap_or_default(),
                event_name: std::env::var("GITHUB_EVENT_NAME").unwrap_or_default(),
            }
        } else {
            Environment::Local
        }
    }

    pub fn is_ci(&self) -> bool {
        matches!(self, Environment::GitHubActions { .. })
    }
}
