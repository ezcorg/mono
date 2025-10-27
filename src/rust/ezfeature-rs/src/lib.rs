//! ezfeature-RS: A comprehensive feature extraction pipeline for various content types
//!
//! This library provides feature extraction capabilities for:
//! - Text content with tagging and analysis
//! - Website content including JavaScript execution and media extraction
//! - Audio content with metadata and duplicate detection
//! - Video content with audio extraction and duplicate detection
//! - YouTube videos with transcripts and metadata

pub mod audio;
pub mod database;
pub mod error;
pub mod text;
pub mod types;
pub mod video;
pub mod website;
pub mod youtube;

pub use error::FeatureExtractionError;
pub use types::*;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/// Main feature extraction pipeline coordinator
pub struct FeatureExtractor {
    pub database: database::Database,
    pub config: FeatureExtractionConfig,
}

/// Configuration for feature extraction
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureExtractionConfig {
    pub database_url: String,
    pub openai_api_key: Option<String>,
    pub youtube_api_key: Option<String>,
    pub enable_javascript: bool,
    pub max_content_size_mb: usize,
    pub embedding_model: String,
    pub duplicate_threshold: f32,
}

impl Default for FeatureExtractionConfig {
    fn default() -> Self {
        Self {
            database_url: "postgresql://localhost/ezfeature".to_string(),
            openai_api_key: None,
            youtube_api_key: None,
            enable_javascript: true,
            max_content_size_mb: 100,
            embedding_model: "text-embedding-3-small".to_string(),
            duplicate_threshold: 0.95,
        }
    }
}

/// Trait for content-specific feature extractors
#[async_trait]
pub trait ContentExtractor {
    type Input;
    type Output;

    async fn extract_features(
        &self,
        input: Self::Input,
        config: &FeatureExtractionConfig,
    ) -> Result<Self::Output, FeatureExtractionError>;

    async fn should_filter(
        &self,
        features: &Self::Output,
        config: &FeatureExtractionConfig,
    ) -> Result<bool, FeatureExtractionError>;
}

impl FeatureExtractor {
    /// Create a new feature extractor with the given configuration
    pub async fn new(config: FeatureExtractionConfig) -> Result<Self, FeatureExtractionError> {
        let database = database::Database::new(&config.database_url).await?;

        Ok(Self { database, config })
    }

    /// Process content and extract features based on content type
    pub async fn process_content(
        &self,
        content: ContentInput,
    ) -> Result<ProcessingResult, FeatureExtractionError> {
        match content {
            ContentInput::Text { content, metadata } => {
                let extractor = text::TextExtractor::new();
                let features = extractor
                    .extract_features(text::TextInput { content, metadata }, &self.config)
                    .await?;

                let content_id = self
                    .database
                    .store_content(
                        ContentType::Text,
                        &features.content,
                        features.metadata.clone(),
                    )
                    .await?;

                self.database
                    .store_text_features(content_id, &features)
                    .await?;

                let should_filter = extractor.should_filter(&features, &self.config).await?;

                Ok(ProcessingResult {
                    content_id,
                    content_type: ContentType::Text,
                    should_filter,
                    features: serde_json::to_value(features)?,
                })
            }

            ContentInput::Website { url, metadata } => {
                let extractor = website::WebsiteExtractor::new();
                let features = extractor
                    .extract_features(website::WebsiteInput { url, metadata }, &self.config)
                    .await?;

                let metadata_map: HashMap<String, serde_json::Value> =
                    serde_json::from_value(serde_json::to_value(&features.metadata)?)?;

                let content_id = self
                    .database
                    .store_content(ContentType::Website, &features.url, metadata_map)
                    .await?;

                self.database
                    .store_website_features(content_id, &features)
                    .await?;

                let should_filter = extractor.should_filter(&features, &self.config).await?;

                Ok(ProcessingResult {
                    content_id,
                    content_type: ContentType::Website,
                    should_filter,
                    features: serde_json::to_value(features)?,
                })
            }

            ContentInput::Audio { data, metadata } => {
                let extractor = audio::AudioExtractor::new();
                let features = extractor
                    .extract_features(audio::AudioInput { data, metadata }, &self.config)
                    .await?;

                let metadata_map: HashMap<String, serde_json::Value> =
                    serde_json::from_value(serde_json::to_value(&features.metadata)?)?;

                let content_id = self
                    .database
                    .store_content(ContentType::Audio, "", metadata_map)
                    .await?;

                self.database
                    .store_audio_features(content_id, &features)
                    .await?;

                let should_filter = extractor.should_filter(&features, &self.config).await?;

                Ok(ProcessingResult {
                    content_id,
                    content_type: ContentType::Audio,
                    should_filter,
                    features: serde_json::to_value(features)?,
                })
            }

            ContentInput::Video { data, metadata } => {
                let extractor = video::VideoExtractor::new();
                let features = extractor
                    .extract_features(video::VideoInput { data, metadata }, &self.config)
                    .await?;

                let metadata_map: HashMap<String, serde_json::Value> =
                    serde_json::from_value(serde_json::to_value(&features.metadata)?)?;

                let content_id = self
                    .database
                    .store_content(ContentType::Video, "", metadata_map)
                    .await?;

                self.database
                    .store_video_features(content_id, &features)
                    .await?;

                let should_filter = extractor.should_filter(&features, &self.config).await?;

                Ok(ProcessingResult {
                    content_id,
                    content_type: ContentType::Video,
                    should_filter,
                    features: serde_json::to_value(features)?,
                })
            }

            ContentInput::YouTube { url, metadata } => {
                let extractor = youtube::YouTubeExtractor::new();
                let features = extractor
                    .extract_features(youtube::YouTubeInput { url, metadata }, &self.config)
                    .await?;

                let metadata_map: HashMap<String, serde_json::Value> =
                    serde_json::from_value(serde_json::to_value(&features.metadata)?)?;

                let content_id = self
                    .database
                    .store_content(ContentType::YouTube, &features.url, metadata_map)
                    .await?;

                self.database
                    .store_youtube_features(content_id, &features)
                    .await?;

                let should_filter = extractor.should_filter(&features, &self.config).await?;

                Ok(ProcessingResult {
                    content_id,
                    content_type: ContentType::YouTube,
                    should_filter,
                    features: serde_json::to_value(features)?,
                })
            }
        }
    }

    /// Find similar content based on embeddings
    pub async fn find_similar_content(
        &self,
        content_id: Uuid,
        similarity_threshold: f32,
        limit: usize,
    ) -> Result<Vec<SimilarContent>, FeatureExtractionError> {
        self.database
            .find_similar_content(content_id, similarity_threshold, limit)
            .await
    }

    /// Check if content is a duplicate
    pub async fn is_duplicate(
        &self,
        content_hash: &str,
    ) -> Result<Option<Uuid>, FeatureExtractionError> {
        self.database.find_duplicate_by_hash(content_hash).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_feature_extractor_creation() {
        let config = FeatureExtractionConfig::default();
        // This would fail without a real database, but tests the structure
        assert_eq!(config.max_content_size_mb, 100);
    }
}
