use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct CertQuery {
    pub format: Option<String>,
    pub download: Option<bool>,
}
