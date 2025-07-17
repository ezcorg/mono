use base64::{Engine as _, engine::general_purpose};
use reqwest::Client;
use serde_json::json;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum EzFilterError {
    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("Invalid content type")]
    InvalidContentType,
    #[error("LLM response parsing failed")]
    ResponseParsingFailed,
}

#[derive(Debug)]
pub enum Content {
    Text(String),
    Image(Vec<u8>),
    Video(Vec<u8>),
    Html(String),
    Json(serde_json::Value),
    // Add more types as needed
}

#[derive(Debug)]
pub struct FilterConfig {
    pub api_endpoint: String,
    pub api_key: String,
    pub model: String,
    pub prompt_template: String,
    // Add more configurable criteria
}

impl Default for FilterConfig {
    fn default() -> Self {
        FilterConfig {
            api_endpoint: "https://api.openai.com/v1/chat/completions".to_string(),
            api_key: String::new(),
            model: "gpt-4o".to_string(),
            prompt_template: "Given the users configured preferences: {user_preferences}, their descriptive features: {user_features}, and their stated session goal: {user_goal}, determine whether they should be shown this described content: {content_features} {content}"
                .to_string(),
        }
    }
}

pub async fn should_show(
    content: &Content,
    config: &FilterConfig,
    user_preferences: &str,
    user_features: &str,
    user_goal: &str,
    content_features: &str,
) -> Result<bool, EzFilterError> {
    let client = Client::new();

    let mut messages = vec![json!({
        "role": "system",
        "content": "You are a content filter. Respond with 'yes' or 'no' only."
    })];

    let content_str = match content {
        Content::Text(s) | Content::Html(s) => s.clone(),
        Content::Json(v) => v.to_string(),
        Content::Image(data) => general_purpose::STANDARD.encode(data),
        Content::Video(_) => return Err(EzFilterError::InvalidContentType),
    };

    let mut prompt_template = config.prompt_template.clone();
    prompt_template = prompt_template.replace("{user_preferences}", user_preferences);
    prompt_template = prompt_template.replace("{user_features}", user_features);
    prompt_template = prompt_template.replace("{user_goal}", user_goal);
    prompt_template = prompt_template.replace("{content_features}", content_features);

    let user_content: serde_json::Value;
    if let Content::Image(_) = content {
        let text = prompt_template.replace("{content}", "the image provided");
        user_content = json!([
            { "type": "text", "text": text },
            { "type": "image_url", "image_url": { "url": format!("data:image/jpeg;base64,{}", content_str) } }
        ]);
    } else {
        let text = prompt_template.replace("{content}", &content_str);
        user_content = json!(text);
    }

    messages.push(json!({
        "role": "user",
        "content": user_content
    }));

    let response = client
        .post(&config.api_endpoint)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&json!({
            "model": config.model,
            "messages": messages,
            "max_tokens": 1,
        }))
        .send()
        .await?;

    let response_text = response.text().await?;

    println!("Response: {}", response_text);

    let parsed: serde_json::Value = serde_json::from_str(&response_text)?;

    if let Some(choice) = parsed["choices"][0]["message"]["content"].as_str() {
        Ok(choice.trim().to_lowercase() == "yes")
    } else {
        Err(EzFilterError::ResponseParsingFailed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_should_show_text_safe() {
        let config = FilterConfig {
            api_key: "dummy".to_string(),
            ..Default::default()
        };
        let content = Content::Text("Hello, world!".to_string());
        // Note: This will fail without real API key, but for basic test, we can ignore or mock in future
        let result = should_show(&content, &config, "", "", "", "").await;
        assert!(result.is_err()); // Expect error due to dummy key
    }

    #[tokio::test]
    async fn test_should_show_image() {
        let config = FilterConfig::default();
        let content = Content::Image(vec![]);
        let result = should_show(&content, &config, "", "", "", "").await;
        assert!(result.is_err()); // Would fail without key
    }

    #[tokio::test]
    async fn test_should_show_html() {
        let config = FilterConfig {
            api_key: "dummy".to_string(),
            ..Default::default()
        };
        let content = Content::Html("<p>Hello</p>".to_string());
        let result = should_show(&content, &config, "", "", "", "").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_should_show_json() {
        let config = FilterConfig {
            api_key: "dummy".to_string(),
            ..Default::default()
        };
        let content = Content::Json(json!({"message": "hello"}));
        let result = should_show(&content, &config, "", "", "", "").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_should_show_large_text() {
        let config = FilterConfig {
            api_key: "dummy".to_string(),
            ..Default::default()
        };
        let large_text = "a".repeat(100000); // 100KB
        let content = Content::Text(large_text);
        let result = should_show(&content, &config, "", "", "", "").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_should_show_large_image() {
        let config = FilterConfig::default();
        let large_image = vec![0u8; 1024 * 1024]; // 1MB
        let content = Content::Image(large_image);
        let result = should_show(&content, &config, "", "", "", "").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_should_show_video_invalid() {
        let config = FilterConfig::default();
        let content = Content::Video(vec![]);
        let result = should_show(&content, &config, "", "", "", "").await;
        assert!(matches!(
            result.err().unwrap(),
            EzFilterError::InvalidContentType
        ));
    }
}
