//! YouTube-specific feature extraction pipeline with video download, transcript extraction, and metadata analysis

use crate::error::{FeatureExtractionError, Result};
use crate::types::*;
use crate::{ContentExtractor, FeatureExtractionConfig};
use async_trait::async_trait;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Command;
use tempfile::NamedTempFile;

/// Input for YouTube feature extraction
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YouTubeInput {
    pub url: String,
    pub metadata: HashMap<String, serde_json::Value>,
}

/// Extracted YouTube features
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YouTubeFeatures {
    pub url: String,
    pub video_id: String,
    pub metadata: YouTubeMetadata,
    pub tags: Vec<Tag>,
    pub embeddings: Vec<FeatureEmbedding>,
    pub video_data: Option<Vec<u8>>,
    pub audio_data: Option<Vec<u8>>,
    pub transcript: Option<String>,
    pub video_features: Option<crate::video::VideoFeatures>,
    pub audio_features: Option<crate::audio::AudioFeatures>,
    pub engagement_metrics: EngagementMetrics,
    pub content_analysis: ContentAnalysis,
}

/// Engagement metrics for YouTube video
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngagementMetrics {
    pub view_count: Option<i64>,
    pub like_count: Option<i64>,
    pub dislike_count: Option<i64>,
    pub comment_count: Option<i64>,
    pub subscriber_count: Option<i64>,
    pub engagement_rate: Option<f32>,
    pub like_ratio: Option<f32>,
    pub comments_per_view: Option<f32>,
}

/// Content analysis for YouTube video
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentAnalysis {
    pub category: Option<String>,
    pub topics: Vec<String>,
    pub sentiment_score: Option<f32>,
    pub educational_score: Option<f32>,
    pub entertainment_score: Option<f32>,
    pub age_rating: Option<String>,
    pub content_warnings: Vec<String>,
}

/// YouTube API response structures
#[derive(Debug, Deserialize)]
struct YouTubeApiResponse {
    items: Vec<YouTubeVideoItem>,
}

#[derive(Debug, Deserialize)]
struct YouTubeVideoItem {
    id: String,
    snippet: YouTubeSnippet,
    statistics: Option<YouTubeStatistics>,
    #[serde(rename = "contentDetails")]
    content_details: Option<YouTubeContentDetails>,
}

#[derive(Debug, Deserialize)]
struct YouTubeSnippet {
    #[serde(rename = "publishedAt")]
    published_at: String,
    #[serde(rename = "channelId")]
    channel_id: String,
    title: String,
    description: String,
    #[serde(rename = "channelTitle")]
    channel_title: String,
    tags: Option<Vec<String>>,
    #[serde(rename = "categoryId")]
    category_id: Option<String>,
    #[serde(rename = "defaultLanguage")]
    default_language: Option<String>,
}

#[derive(Debug, Deserialize)]
struct YouTubeStatistics {
    #[serde(rename = "viewCount")]
    view_count: Option<String>,
    #[serde(rename = "likeCount")]
    like_count: Option<String>,
    #[serde(rename = "dislikeCount")]
    dislike_count: Option<String>,
    #[serde(rename = "commentCount")]
    comment_count: Option<String>,
}

#[derive(Debug, Deserialize)]
struct YouTubeContentDetails {
    duration: String,
}

/// YouTube feature extractor
pub struct YouTubeExtractor {
    client: reqwest::Client,
    video_extractor: crate::video::VideoExtractor,
    audio_extractor: crate::audio::AudioExtractor,
}

impl YouTubeExtractor {
    /// Create a new YouTube extractor
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
            video_extractor: crate::video::VideoExtractor::new(),
            audio_extractor: crate::audio::AudioExtractor::new(),
        }
    }

    /// Extract video ID from YouTube URL
    fn extract_video_id(&self, url: &str) -> Result<String> {
        let patterns = [
            r"(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/)([a-zA-Z0-9_-]{11})",
            r"youtube\.com/v/([a-zA-Z0-9_-]{11})",
        ];

        for pattern in &patterns {
            let regex = Regex::new(pattern).map_err(|e| {
                FeatureExtractionError::youtube_api(format!("Invalid regex: {}", e))
            })?;

            if let Some(captures) = regex.captures(url) {
                if let Some(video_id) = captures.get(1) {
                    return Ok(video_id.as_str().to_string());
                }
            }
        }

        Err(FeatureExtractionError::youtube_api(
            "Could not extract video ID from URL".to_string(),
        ))
    }

    /// Fetch video metadata from YouTube API
    async fn fetch_metadata(&self, video_id: &str, api_key: &str) -> Result<YouTubeMetadata> {
        let url = format!(
            "https://www.googleapis.com/youtube/v3/videos?id={}&part=snippet,statistics,contentDetails&key={}",
            video_id, api_key
        );

        let response = self.client.get(&url).send().await.map_err(|e| {
            FeatureExtractionError::youtube_api(format!("API request failed: {}", e))
        })?;

        if !response.status().is_success() {
            return Err(FeatureExtractionError::youtube_api(format!(
                "YouTube API error: {}",
                response.status()
            )));
        }

        let api_response: YouTubeApiResponse = response.json().await.map_err(|e| {
            FeatureExtractionError::youtube_api(format!("Failed to parse API response: {}", e))
        })?;

        let video_item =
            api_response.items.into_iter().next().ok_or_else(|| {
                FeatureExtractionError::youtube_api("Video not found".to_string())
            })?;

        let snippet = video_item.snippet;
        let statistics = video_item.statistics;

        // Parse upload date
        let upload_date = chrono::DateTime::parse_from_rfc3339(&snippet.published_at)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .ok();

        // Parse statistics
        let view_count = statistics
            .as_ref()
            .and_then(|s| s.view_count.as_ref())
            .and_then(|v| v.parse().ok());

        let like_count = statistics
            .as_ref()
            .and_then(|s| s.like_count.as_ref())
            .and_then(|v| v.parse().ok());

        let comment_count = statistics
            .as_ref()
            .and_then(|s| s.comment_count.as_ref())
            .and_then(|v| v.parse().ok());

        Ok(YouTubeMetadata {
            video_id: video_id.to_string(),
            channel_id: Some(snippet.channel_id),
            channel_name: Some(snippet.channel_title),
            view_count,
            like_count,
            comment_count,
            upload_date,
            comments: Vec::new(),       // Will be fetched separately
            statistics: HashMap::new(), // Additional statistics
        })
    }

    /// Fetch video comments
    async fn fetch_comments(
        &self,
        video_id: &str,
        api_key: &str,
        max_comments: usize,
    ) -> Result<Vec<YouTubeComment>> {
        let url = format!(
            "https://www.googleapis.com/youtube/v3/commentThreads?videoId={}&part=snippet&maxResults={}&key={}",
            video_id, max_comments, api_key
        );

        let response = self.client.get(&url).send().await.map_err(|e| {
            FeatureExtractionError::youtube_api(format!("Comments API request failed: {}", e))
        })?;

        if !response.status().is_success() {
            // Comments might be disabled, return empty list
            return Ok(Vec::new());
        }

        let response_json: serde_json::Value = response.json().await.map_err(|e| {
            FeatureExtractionError::youtube_api(format!("Failed to parse comments response: {}", e))
        })?;

        let mut comments = Vec::new();

        if let Some(items) = response_json["items"].as_array() {
            for item in items {
                if let Some(snippet) = item["snippet"]["topLevelComment"]["snippet"].as_object() {
                    let author = snippet["authorDisplayName"]
                        .as_str()
                        .unwrap_or("Unknown")
                        .to_string();
                    let text = snippet["textDisplay"].as_str().unwrap_or("").to_string();
                    let like_count = snippet["likeCount"].as_i64();

                    let published_at = snippet["publishedAt"]
                        .as_str()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .map(|dt| dt.with_timezone(&chrono::Utc));

                    comments.push(YouTubeComment {
                        author,
                        text,
                        like_count,
                        published_at,
                        replies: Vec::new(), // Could fetch replies if needed
                    });
                }
            }
        }

        Ok(comments)
    }

    /// Download video using yt-dlp
    async fn download_video(&self, video_id: &str) -> Result<Vec<u8>> {
        let temp_file = NamedTempFile::new().map_err(|e| {
            FeatureExtractionError::youtube_api(format!("Failed to create temp file: {}", e))
        })?;

        let url = format!("https://www.youtube.com/watch?v={}", video_id);

        let output = Command::new("yt-dlp")
            .args(&[
                "-f",
                "best[height<=720]", // Limit quality to reduce size
                "-o",
                temp_file.path().to_str().unwrap(),
                &url,
            ])
            .output()
            .map_err(|e| FeatureExtractionError::youtube_api(format!("yt-dlp failed: {}", e)))?;

        if !output.status.success() {
            return Err(FeatureExtractionError::youtube_api(format!(
                "yt-dlp error: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }

        let video_data = std::fs::read(temp_file.path()).map_err(|e| {
            FeatureExtractionError::youtube_api(format!("Failed to read video file: {}", e))
        })?;

        Ok(video_data)
    }

    /// Extract transcript using yt-dlp
    async fn extract_transcript(&self, video_id: &str) -> Result<Option<String>> {
        let url = format!("https://www.youtube.com/watch?v={}", video_id);

        let output = Command::new("yt-dlp")
            .args(&[
                "--write-subs",
                "--write-auto-subs",
                "--sub-lang",
                "en",
                "--skip-download",
                "--print",
                "%(subtitles)s",
                &url,
            ])
            .output()
            .map_err(|e| {
                FeatureExtractionError::youtube_api(format!("yt-dlp transcript failed: {}", e))
            })?;

        if output.status.success() {
            let transcript = String::from_utf8_lossy(&output.stdout);
            if !transcript.trim().is_empty() {
                return Ok(Some(transcript.to_string()));
            }
        }

        // Try alternative method - extract from video description or use speech-to-text
        Ok(None)
    }

    /// Calculate engagement metrics
    fn calculate_engagement_metrics(&self, metadata: &YouTubeMetadata) -> EngagementMetrics {
        let view_count = metadata.view_count;
        let like_count = metadata.like_count;
        let comment_count = metadata.comment_count;

        let engagement_rate = if let (Some(views), Some(likes), Some(comments)) =
            (view_count, like_count, comment_count)
        {
            if views > 0 {
                Some((likes + comments) as f32 / views as f32)
            } else {
                None
            }
        } else {
            None
        };

        let like_ratio = if let (Some(likes), Some(views)) = (like_count, view_count) {
            if views > 0 {
                Some(likes as f32 / views as f32)
            } else {
                None
            }
        } else {
            None
        };

        let comments_per_view = if let (Some(comments), Some(views)) = (comment_count, view_count) {
            if views > 0 {
                Some(comments as f32 / views as f32)
            } else {
                None
            }
        } else {
            None
        };

        EngagementMetrics {
            view_count,
            like_count,
            dislike_count: None, // YouTube removed public dislike counts
            comment_count,
            subscriber_count: None, // Would need channel API call
            engagement_rate,
            like_ratio,
            comments_per_view,
        }
    }

    /// Analyze content based on metadata and transcript
    fn analyze_content(
        &self,
        metadata: &YouTubeMetadata,
        _transcript: &Option<String>,
    ) -> ContentAnalysis {
        let topics = Vec::new();
        let content_warnings = Vec::new();

        // Extract topics from title and description (simplified)
        // In practice, you'd use NLP models for topic extraction

        // Simple sentiment analysis on comments
        let sentiment_score = if !metadata.comments.is_empty() {
            let positive_words = ["good", "great", "love", "amazing", "awesome"];
            let negative_words = ["bad", "hate", "terrible", "awful", "boring"];

            let mut positive_count = 0;
            let mut negative_count = 0;

            for comment in &metadata.comments {
                let text_lower = comment.text.to_lowercase();
                for word in positive_words.iter() {
                    if text_lower.contains(word) {
                        positive_count += 1;
                    }
                }
                for word in negative_words.iter() {
                    if text_lower.contains(word) {
                        negative_count += 1;
                    }
                }
            }

            let total = positive_count + negative_count;
            if total > 0 {
                Some((positive_count as f32 - negative_count as f32) / total as f32)
            } else {
                None
            }
        } else {
            None
        };

        ContentAnalysis {
            category: None, // Could map from YouTube category ID
            topics,
            sentiment_score,
            educational_score: None, // Could implement educational content detection
            entertainment_score: None, // Could implement entertainment content detection
            age_rating: None,        // Could implement age rating detection
            content_warnings,
        }
    }

    /// Generate tags based on YouTube analysis
    fn generate_tags(&self, features: &YouTubeFeatures) -> Vec<Tag> {
        let mut tags = Vec::new();

        // Channel tag
        if let Some(channel_name) = &features.metadata.channel_name {
            tags.push(Tag {
                name: "channel".to_string(),
                value: Some(channel_name.clone()),
                confidence: 1.0,
                source: "youtube_analysis".to_string(),
            });
        }

        // Engagement tags
        if let Some(engagement_rate) = features.engagement_metrics.engagement_rate {
            let engagement_level = if engagement_rate > 0.1 {
                "high"
            } else if engagement_rate > 0.01 {
                "medium"
            } else {
                "low"
            };

            tags.push(Tag {
                name: "engagement".to_string(),
                value: Some(engagement_level.to_string()),
                confidence: 0.8,
                source: "youtube_analysis".to_string(),
            });
        }

        // View count tags
        if let Some(view_count) = features.metadata.view_count {
            let popularity = if view_count > 1_000_000 {
                "viral"
            } else if view_count > 100_000 {
                "popular"
            } else if view_count > 10_000 {
                "moderate"
            } else {
                "low"
            };

            tags.push(Tag {
                name: "popularity".to_string(),
                value: Some(popularity.to_string()),
                confidence: 0.9,
                source: "youtube_analysis".to_string(),
            });
        }

        // Content type tags
        if features.transcript.is_some() {
            tags.push(Tag {
                name: "has_transcript".to_string(),
                value: Some("true".to_string()),
                confidence: 1.0,
                source: "youtube_analysis".to_string(),
            });
        }

        // Sentiment tags
        if let Some(sentiment) = features.content_analysis.sentiment_score {
            let sentiment_label = if sentiment > 0.3 {
                "positive"
            } else if sentiment < -0.3 {
                "negative"
            } else {
                "neutral"
            };

            tags.push(Tag {
                name: "sentiment".to_string(),
                value: Some(sentiment_label.to_string()),
                confidence: sentiment.abs(),
                source: "youtube_analysis".to_string(),
            });
        }

        tags
    }

    /// Generate embeddings for YouTube content
    async fn generate_embeddings(
        &self,
        features: &YouTubeFeatures,
        config: &FeatureExtractionConfig,
    ) -> Result<Vec<FeatureEmbedding>> {
        let mut embeddings = Vec::new();

        // Generate embedding from transcript
        if let Some(transcript) = &features.transcript {
            if let Some(api_key) = &config.openai_api_key {
                let response = self
                    .client
                    .post("https://api.openai.com/v1/embeddings")
                    .header("Authorization", format!("Bearer {}", api_key))
                    .header("Content-Type", "application/json")
                    .json(&serde_json::json!({
                        "input": transcript,
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
                        feature_type: "youtube_transcript".to_string(),
                        embedding,
                        confidence: 0.9,
                    });
                }
            }
        }

        // Generate embedding from comments
        if !features.metadata.comments.is_empty() {
            let comments_text: String = features
                .metadata
                .comments
                .iter()
                .take(10) // Limit to top 10 comments
                .map(|c| c.text.clone())
                .collect::<Vec<_>>()
                .join(" ");

            if let Some(api_key) = &config.openai_api_key {
                let response = self
                    .client
                    .post("https://api.openai.com/v1/embeddings")
                    .header("Authorization", format!("Bearer {}", api_key))
                    .header("Content-Type", "application/json")
                    .json(&serde_json::json!({
                        "input": comments_text,
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
                        feature_type: "youtube_comments".to_string(),
                        embedding,
                        confidence: 0.7,
                    });
                }
            }
        }

        // Include video and audio embeddings if available
        if let Some(video_features) = &features.video_features {
            embeddings.extend(video_features.embeddings.clone());
        }

        if let Some(audio_features) = &features.audio_features {
            embeddings.extend(audio_features.embeddings.clone());
        }

        Ok(embeddings)
    }
}

#[async_trait]
impl ContentExtractor for YouTubeExtractor {
    type Input = YouTubeInput;
    type Output = YouTubeFeatures;

    async fn extract_features(
        &self,
        input: Self::Input,
        config: &FeatureExtractionConfig,
    ) -> Result<Self::Output> {
        let url = input.url;
        let _metadata = input.metadata;

        // Extract video ID
        let video_id = self.extract_video_id(&url)?;

        // Fetch metadata from YouTube API
        let api_key = config
            .youtube_api_key
            .as_ref()
            .ok_or_else(|| FeatureExtractionError::configuration("YouTube API key not provided"))?;

        let mut youtube_metadata = self.fetch_metadata(&video_id, api_key).await?;

        // Fetch comments
        let comments = self.fetch_comments(&video_id, api_key, 50).await?;
        youtube_metadata.comments = comments;

        // Download video (optional, based on configuration)
        let video_data = if config.max_content_size_mb > 0 {
            match self.download_video(&video_id).await {
                Ok(data) => Some(data),
                Err(_) => None, // Continue without video data if download fails
            }
        } else {
            None
        };

        // Extract transcript
        let transcript = self.extract_transcript(&video_id).await?;

        // Extract video features if we have video data
        let video_features = if let Some(ref data) = video_data {
            match self
                .video_extractor
                .extract_features(
                    crate::video::VideoInput {
                        data: data.clone(),
                        metadata: HashMap::new(),
                    },
                    config,
                )
                .await
            {
                Ok(features) => Some(features),
                Err(_) => None,
            }
        } else {
            None
        };

        // Extract audio features if we have video data
        let (audio_data, audio_features) = if let Some(ref video_feat) = video_features {
            if let Some(ref audio_data) = video_feat.extracted_audio {
                let audio_features = match self
                    .audio_extractor
                    .extract_features(
                        crate::audio::AudioInput {
                            data: audio_data.clone(),
                            metadata: HashMap::new(),
                        },
                        config,
                    )
                    .await
                {
                    Ok(features) => Some(features),
                    Err(_) => None,
                };
                (Some(audio_data.clone()), audio_features)
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };

        // Calculate engagement metrics
        let engagement_metrics = self.calculate_engagement_metrics(&youtube_metadata);

        // Analyze content
        let content_analysis = self.analyze_content(&youtube_metadata, &transcript);

        let features = YouTubeFeatures {
            url: url.clone(),
            video_id,
            metadata: youtube_metadata,
            tags: Vec::new(),       // Will be populated below
            embeddings: Vec::new(), // Will be populated below
            video_data,
            audio_data,
            transcript,
            video_features,
            audio_features,
            engagement_metrics,
            content_analysis,
        };

        // Generate tags
        let tags = self.generate_tags(&features);

        // Generate embeddings
        let embeddings = self.generate_embeddings(&features, config).await?;

        Ok(YouTubeFeatures {
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
        // Filter based on YouTube-specific criteria

        // Filter videos with very low engagement
        if let Some(engagement_rate) = features.engagement_metrics.engagement_rate {
            if engagement_rate < 0.001 && features.metadata.view_count.unwrap_or(0) > 1000 {
                return Ok(true);
            }
        }

        // Filter videos with very negative sentiment
        if let Some(sentiment) = features.content_analysis.sentiment_score {
            if sentiment < -0.8 {
                return Ok(true);
            }
        }

        // Filter videos with content warnings
        if !features.content_analysis.content_warnings.is_empty() {
            return Ok(true);
        }

        // Use video and audio filtering if available
        if let Some(ref video_features) = features.video_features {
            if self
                .video_extractor
                .should_filter(video_features, _config)
                .await?
            {
                return Ok(true);
            }
        }

        if let Some(ref audio_features) = features.audio_features {
            if self
                .audio_extractor
                .should_filter(audio_features, _config)
                .await?
            {
                return Ok(true);
            }
        }

        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_video_id_extraction() {
        let extractor = YouTubeExtractor::new();

        let test_urls = [
            ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ];

        for (url, expected_id) in &test_urls {
            let result = extractor.extract_video_id(url);
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), *expected_id);
        }
    }

    #[test]
    fn test_engagement_metrics_calculation() {
        let extractor = YouTubeExtractor::new();
        let metadata = YouTubeMetadata {
            video_id: "test".to_string(),
            channel_id: Some("channel".to_string()),
            channel_name: Some("Test Channel".to_string()),
            view_count: Some(1000),
            like_count: Some(100),
            comment_count: Some(50),
            upload_date: None,
            comments: Vec::new(),
            statistics: HashMap::new(),
        };

        let metrics = extractor.calculate_engagement_metrics(&metadata);
        assert!(metrics.engagement_rate.is_some());
        assert!(metrics.like_ratio.is_some());
        assert!(metrics.comments_per_view.is_some());
    }
}
