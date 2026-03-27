/// The environment the CLI is running in.
#[derive(Debug)]
pub enum Environment {
    Local,
    GitHubActions {
        #[allow(dead_code)]
        token: Option<String>,
        #[allow(dead_code)]
        ref_name: String,
        #[allow(dead_code)]
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

    #[allow(dead_code)]
    pub fn is_ci(&self) -> bool {
        matches!(self, Environment::GitHubActions { .. })
    }
}
