pub mod parser;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Represents different types of parsed content
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ParsedContent {
    Json(serde_json::Value),
    Html(HtmlDocument),
    Text(String),
    Binary(Vec<u8>),
}

/// Simplified HTML document representation for plugins
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HtmlDocument {
    pub title: Option<String>,
    pub meta: HashMap<String, String>,
    pub links: Vec<HtmlLink>,
    pub forms: Vec<HtmlForm>,
    pub scripts: Vec<String>,
    pub text_content: String,
    pub raw_html: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HtmlLink {
    pub href: String,
    pub rel: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HtmlForm {
    pub action: Option<String>,
    pub method: String,
    pub inputs: Vec<HtmlInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HtmlInput {
    pub name: Option<String>,
    pub input_type: String,
    pub value: Option<String>,
}

/// Content type detection utilities
pub fn detect_content_type(headers: &HashMap<String, String>) -> Option<String> {
    headers
        .get("content-type")
        .map(|ct| ct.split(';').next().unwrap_or(ct).trim().to_lowercase())
}

pub fn is_json_content(content_type: &str) -> bool {
    content_type == "application/json"
        || content_type.starts_with("application/") && content_type.ends_with("+json")
}

pub fn is_html_content(content_type: &str) -> bool {
    content_type == "text/html" || content_type == "application/xhtml+xml"
}
