use ezfilter_rs::{Content, FilterConfig, should_show};
use std::env;

#[tokio::main]
async fn main() {
    let api_endpoint = env::var("API_ENDPOINT")
        .unwrap_or("http://localhost:11434/v1/chat/completions".to_string());
    let api_key = env::var("API_KEY").unwrap_or("".to_string());
    let model = env::var("MODEL").unwrap_or("llama3".to_string());

    let config = FilterConfig {
        api_endpoint,
        api_key,
        model,
        prompt_template: "Is this content safe to show? Respond with yes or no: {content}"
            .to_string(),
    };

    let content = Content::Text("Hello, this is safe content.".to_string());

    match should_show(&content, &config, "", "", "", "").await {
        Ok(should) => println!("Should show: {}", should),
        Err(e) => eprintln!("Error: {}", e),
    }
}
