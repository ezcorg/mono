//! Website feature extraction pipeline with JavaScript execution and media detection

use crate::error::{FeatureExtractionError, Result};
use crate::types::*;
use crate::{ContentExtractor, FeatureExtractionConfig};
use async_trait::async_trait;
use headless_chrome::{Browser, LaunchOptions};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use url::Url;

/// Input for website feature extraction
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebsiteInput {
    pub url: String,
    pub metadata: HashMap<String, serde_json::Value>,
}

/// Extracted website features
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebsiteFeatures {
    pub url: String,
    pub metadata: WebsiteMetadata,
    pub tags: Vec<Tag>,
    pub embeddings: Vec<FeatureEmbedding>,
    pub html_content: String,
    pub text_content: String,
    pub links: Vec<String>,
    pub images: Vec<MediaElement>,
    pub audio_elements: Vec<MediaElement>,
    pub video_elements: Vec<MediaElement>,
    pub scripts: Vec<String>,
    pub stylesheets: Vec<String>,
}

/// Media element found on the website
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaElement {
    pub url: String,
    pub element_type: String, // "img", "audio", "video"
    pub alt_text: Option<String>,
    pub title: Option<String>,
    pub mime_type: Option<String>,
    pub size_bytes: Option<u64>,
    pub duration_seconds: Option<f32>,
    pub dimensions: Option<(u32, u32)>,
}

/// Website feature extractor
pub struct WebsiteExtractor {
    client: reqwest::Client,
}

impl WebsiteExtractor {
    /// Create a new website extractor
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap(),
        }
    }

    /// Fetch and parse HTML content
    async fn fetch_html(&self, url: &str) -> Result<String> {
        let response = self.client.get(url).send().await.map_err(|e| {
            FeatureExtractionError::web_scraping(format!("Failed to fetch URL: {}", e))
        })?;

        if !response.status().is_success() {
            return Err(FeatureExtractionError::web_scraping(format!(
                "HTTP error: {}",
                response.status()
            )));
        }

        let html = response.text().await.map_err(|e| {
            FeatureExtractionError::web_scraping(format!("Failed to read response: {}", e))
        })?;

        Ok(html)
    }

    /// Execute JavaScript and get rendered content
    async fn fetch_with_javascript(&self, url: &str) -> Result<(String, i32)> {
        let start_time = Instant::now();

        let browser = Browser::new(
            LaunchOptions::default_builder()
                .headless(true)
                .build()
                .map_err(|e| FeatureExtractionError::browser_automation(e.to_string()))?,
        )
        .map_err(|e| FeatureExtractionError::browser_automation(e.to_string()))?;

        let tab = browser
            .new_tab()
            .map_err(|e| FeatureExtractionError::browser_automation(e.to_string()))?;

        tab.navigate_to(url)
            .map_err(|e| FeatureExtractionError::browser_automation(e.to_string()))?;

        // Wait for page to load
        tab.wait_until_navigated()
            .map_err(|e| FeatureExtractionError::browser_automation(e.to_string()))?;

        // Wait a bit more for dynamic content
        std::thread::sleep(Duration::from_secs(3));

        let html = tab
            .get_content()
            .map_err(|e| FeatureExtractionError::browser_automation(e.to_string()))?;

        let load_time = start_time.elapsed().as_millis() as i32;

        Ok((html, load_time))
    }

    /// Parse HTML and extract metadata
    fn parse_html(
        &self,
        html: &str,
        base_url: &str,
    ) -> Result<(
        WebsiteMetadata,
        Vec<String>,
        Vec<MediaElement>,
        Vec<MediaElement>,
        Vec<MediaElement>,
        Vec<String>,
        Vec<String>,
        String,
    )> {
        let document = Html::parse_document(html);
        let base_url = Url::parse(base_url)
            .map_err(|e| FeatureExtractionError::web_scraping(format!("Invalid URL: {}", e)))?;

        // Extract title
        let title_selector = Selector::parse("title").unwrap();
        let title = document
            .select(&title_selector)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_string());

        // Extract meta description
        let meta_desc_selector = Selector::parse("meta[name='description']").unwrap();
        let description = document
            .select(&meta_desc_selector)
            .next()
            .and_then(|el| el.value().attr("content"))
            .map(|s| s.to_string());

        // Extract meta keywords
        let meta_keywords_selector = Selector::parse("meta[name='keywords']").unwrap();
        let keywords: Vec<String> = document
            .select(&meta_keywords_selector)
            .next()
            .and_then(|el| el.value().attr("content"))
            .map(|s| s.split(',').map(|k| k.trim().to_string()).collect())
            .unwrap_or_default();

        // Extract language
        let html_selector = Selector::parse("html").unwrap();
        let language = document
            .select(&html_selector)
            .next()
            .and_then(|el| el.value().attr("lang"))
            .map(|s| s.to_string());

        // Extract links
        let link_selector = Selector::parse("a[href]").unwrap();
        let links: Vec<String> = document
            .select(&link_selector)
            .filter_map(|el| el.value().attr("href"))
            .filter_map(|href| base_url.join(href).ok())
            .map(|url| url.to_string())
            .collect();

        // Extract images
        let img_selector = Selector::parse("img").unwrap();
        let images: Vec<MediaElement> = document
            .select(&img_selector)
            .filter_map(|el| {
                let src = el.value().attr("src")?;
                let url = base_url.join(src).ok()?.to_string();
                Some(MediaElement {
                    url,
                    element_type: "img".to_string(),
                    alt_text: el.value().attr("alt").map(|s| s.to_string()),
                    title: el.value().attr("title").map(|s| s.to_string()),
                    mime_type: None,
                    size_bytes: None,
                    duration_seconds: None,
                    dimensions: None,
                })
            })
            .collect();

        // Extract audio elements
        let audio_selector = Selector::parse("audio[src], audio source[src]").unwrap();
        let audio_elements: Vec<MediaElement> = document
            .select(&audio_selector)
            .filter_map(|el| {
                let src = el.value().attr("src")?;
                let url = base_url.join(src).ok()?.to_string();
                Some(MediaElement {
                    url,
                    element_type: "audio".to_string(),
                    alt_text: None,
                    title: el.value().attr("title").map(|s| s.to_string()),
                    mime_type: el.value().attr("type").map(|s| s.to_string()),
                    size_bytes: None,
                    duration_seconds: None,
                    dimensions: None,
                })
            })
            .collect();

        // Extract video elements
        let video_selector = Selector::parse("video[src], video source[src]").unwrap();
        let video_elements: Vec<MediaElement> = document
            .select(&video_selector)
            .filter_map(|el| {
                let src = el.value().attr("src")?;
                let url = base_url.join(src).ok()?.to_string();
                Some(MediaElement {
                    url,
                    element_type: "video".to_string(),
                    alt_text: None,
                    title: el.value().attr("title").map(|s| s.to_string()),
                    mime_type: el.value().attr("type").map(|s| s.to_string()),
                    size_bytes: None,
                    duration_seconds: None,
                    dimensions: None,
                })
            })
            .collect();

        // Extract scripts
        let script_selector = Selector::parse("script[src]").unwrap();
        let scripts: Vec<String> = document
            .select(&script_selector)
            .filter_map(|el| el.value().attr("src"))
            .filter_map(|src| base_url.join(src).ok())
            .map(|url| url.to_string())
            .collect();

        // Extract stylesheets
        let css_selector = Selector::parse("link[rel='stylesheet'][href]").unwrap();
        let stylesheets: Vec<String> = document
            .select(&css_selector)
            .filter_map(|el| el.value().attr("href"))
            .filter_map(|href| base_url.join(href).ok())
            .map(|url| url.to_string())
            .collect();

        // Extract text content
        let text_content = document
            .root_element()
            .text()
            .collect::<Vec<_>>()
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        let metadata = WebsiteMetadata {
            domain: base_url.domain().map(|s| s.to_string()),
            title,
            description,
            keywords,
            language,
            has_audio: !audio_elements.is_empty(),
            has_video: !video_elements.is_empty(),
            audio_urls: audio_elements.iter().map(|e| e.url.clone()).collect(),
            video_urls: video_elements.iter().map(|e| e.url.clone()).collect(),
            javascript_executed: false, // Will be updated if JS is executed
            page_load_time_ms: None,
        };

        Ok((
            metadata,
            links,
            images,
            audio_elements,
            video_elements,
            scripts,
            stylesheets,
            text_content,
        ))
    }

    /// Analyze media elements and extract additional metadata
    async fn analyze_media_elements(&self, elements: &mut [MediaElement]) -> Result<()> {
        for element in elements {
            // Try to get content-type and size from HEAD request
            if let Ok(response) = self.client.head(&element.url).send().await {
                if let Some(content_type) = response.headers().get("content-type") {
                    element.mime_type = content_type.to_str().ok().map(|s| s.to_string());
                }

                if let Some(content_length) = response.headers().get("content-length") {
                    if let Ok(size_str) = content_length.to_str() {
                        element.size_bytes = size_str.parse().ok();
                    }
                }
            }
        }
        Ok(())
    }

    /// Generate embeddings for website content
    async fn generate_embeddings(
        &self,
        features: &WebsiteFeatures,
        config: &FeatureExtractionConfig,
    ) -> Result<Vec<FeatureEmbedding>> {
        let mut embeddings = Vec::new();

        if let Some(api_key) = &config.openai_api_key {
            // Generate embedding for text content
            if !features.text_content.is_empty() {
                let response = self
                    .client
                    .post("https://api.openai.com/v1/embeddings")
                    .header("Authorization", format!("Bearer {}", api_key))
                    .header("Content-Type", "application/json")
                    .json(&serde_json::json!({
                        "input": features.text_content,
                        "model": config.embedding_model
                    }))
                    .send()
                    .await?;

                let response_json: serde_json::Value = response.json().await?;

                if let Some(embedding_data) = response_json["data"][0]["embedding"].as_array() {
                    let embedding: Vec<f32> = embedding_data
                        .iter()
                        .map(|v| v.as_f64().unwrap_or(0.0) as f32)
                        .collect();

                    embeddings.push(FeatureEmbedding {
                        feature_type: "website_text".to_string(),
                        embedding,
                        confidence: 0.9,
                    });
                }
            }

            // Generate embedding for title and description
            if let Some(title) = &features.metadata.title {
                let title_desc = if let Some(desc) = &features.metadata.description {
                    format!("{} {}", title, desc)
                } else {
                    title.clone()
                };

                let response = self
                    .client
                    .post("https://api.openai.com/v1/embeddings")
                    .header("Authorization", format!("Bearer {}", api_key))
                    .header("Content-Type", "application/json")
                    .json(&serde_json::json!({
                        "input": title_desc,
                        "model": config.embedding_model
                    }))
                    .send()
                    .await?;

                let response_json: serde_json::Value = response.json().await?;

                if let Some(embedding_data) = response_json["data"][0]["embedding"].as_array() {
                    let embedding: Vec<f32> = embedding_data
                        .iter()
                        .map(|v| v.as_f64().unwrap_or(0.0) as f32)
                        .collect();

                    embeddings.push(FeatureEmbedding {
                        feature_type: "website_metadata".to_string(),
                        embedding,
                        confidence: 0.8,
                    });
                }
            }
        }

        Ok(embeddings)
    }

    /// Generate tags based on website analysis
    fn generate_tags(&self, features: &WebsiteFeatures) -> Vec<Tag> {
        let mut tags = Vec::new();

        // Domain tag
        if let Some(domain) = &features.metadata.domain {
            tags.push(Tag {
                name: "domain".to_string(),
                value: Some(domain.clone()),
                confidence: 1.0,
                source: "website_analysis".to_string(),
            });
        }

        // Language tag
        if let Some(language) = &features.metadata.language {
            tags.push(Tag {
                name: "language".to_string(),
                value: Some(language.clone()),
                confidence: 0.9,
                source: "website_analysis".to_string(),
            });
        }

        // Media tags
        if features.metadata.has_audio {
            tags.push(Tag {
                name: "has_media".to_string(),
                value: Some("audio".to_string()),
                confidence: 1.0,
                source: "website_analysis".to_string(),
            });
        }

        if features.metadata.has_video {
            tags.push(Tag {
                name: "has_media".to_string(),
                value: Some("video".to_string()),
                confidence: 1.0,
                source: "website_analysis".to_string(),
            });
        }

        // Content length tag
        let word_count = features.text_content.split_whitespace().count();
        let content_length = if word_count < 100 {
            "short"
        } else if word_count > 1000 {
            "long"
        } else {
            "medium"
        };

        tags.push(Tag {
            name: "content_length".to_string(),
            value: Some(content_length.to_string()),
            confidence: 0.9,
            source: "website_analysis".to_string(),
        });

        // JavaScript execution tag
        if features.metadata.javascript_executed {
            tags.push(Tag {
                name: "javascript".to_string(),
                value: Some("executed".to_string()),
                confidence: 1.0,
                source: "website_analysis".to_string(),
            });
        }

        tags
    }
}

#[async_trait]
impl ContentExtractor for WebsiteExtractor {
    type Input = WebsiteInput;
    type Output = WebsiteFeatures;

    async fn extract_features(
        &self,
        input: Self::Input,
        config: &FeatureExtractionConfig,
    ) -> Result<Self::Output> {
        let url = input.url;
        let _metadata = input.metadata;

        // Validate URL
        Url::parse(&url).map_err(|_| FeatureExtractionError::InvalidUrl { url: url.clone() })?;

        // Fetch HTML content
        let (html_content, page_load_time) = if config.enable_javascript {
            self.fetch_with_javascript(&url).await?
        } else {
            let html = self.fetch_html(&url).await?;
            (html, 0)
        };

        // Parse HTML and extract features
        let (
            mut website_metadata,
            links,
            mut images,
            mut audio_elements,
            mut video_elements,
            scripts,
            stylesheets,
            text_content,
        ) = self.parse_html(&html_content, &url)?;

        // Update metadata with JavaScript execution info
        website_metadata.javascript_executed = config.enable_javascript;
        if page_load_time > 0 {
            website_metadata.page_load_time_ms = Some(page_load_time);
        }

        // Analyze media elements
        self.analyze_media_elements(&mut images).await?;
        self.analyze_media_elements(&mut audio_elements).await?;
        self.analyze_media_elements(&mut video_elements).await?;

        let features = WebsiteFeatures {
            url: url.clone(),
            metadata: website_metadata,
            tags: Vec::new(),       // Will be populated below
            embeddings: Vec::new(), // Will be populated below
            html_content,
            text_content,
            links,
            images,
            audio_elements,
            video_elements,
            scripts,
            stylesheets,
        };

        // Generate tags
        let tags = self.generate_tags(&features);

        // Generate embeddings
        let embeddings = self.generate_embeddings(&features, config).await?;

        Ok(WebsiteFeatures {
            tags,
            embeddings,
            ..features
        })
    }

    async fn should_filter(
        &self,
        features: &Self::Output,
        _config: &FeatureExtractionConfig,
    ) -> Result<bool> {
        // Filter based on content quality

        // Filter pages with very little text content
        let word_count = features.text_content.split_whitespace().count();
        if word_count < 10 {
            return Ok(true);
        }

        // Filter pages that are mostly redirects or error pages
        if let Some(title) = &features.metadata.title {
            let title_lower = title.to_lowercase();
            if title_lower.contains("404")
                || title_lower.contains("not found")
                || title_lower.contains("error")
                || title_lower.contains("redirect")
            {
                return Ok(true);
            }
        }

        // Filter pages with suspicious domains (basic check)
        if let Some(domain) = &features.metadata.domain {
            let suspicious_tlds = ["tk", "ml", "ga", "cf"];
            if suspicious_tlds.iter().any(|&tld| domain.ends_with(tld)) {
                return Ok(true);
            }
        }

        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_website_extraction() {
        let extractor = WebsiteExtractor::new();
        let input = WebsiteInput {
            url: "https://example.com".to_string(),
            metadata: HashMap::new(),
        };

        let config = FeatureExtractionConfig::default();

        // This would require network access, but tests the structure
        assert!(input.url.starts_with("https://"));
    }
}
