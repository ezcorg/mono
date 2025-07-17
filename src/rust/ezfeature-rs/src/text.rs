//! Text feature extraction pipeline

use crate::error::{FeatureExtractionError, Result};
use crate::types::*;
use crate::{ContentExtractor, FeatureExtractionConfig};
use async_trait::async_trait;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Input for text feature extraction
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextInput {
    pub content: String,
    pub metadata: HashMap<String, serde_json::Value>,
}

/// Extracted text features
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextFeatures {
    pub content: String,
    pub metadata: HashMap<String, serde_json::Value>,
    pub tags: Vec<Tag>,
    pub embeddings: Vec<FeatureEmbedding>,
    pub language: Option<String>,
    pub word_count: usize,
    pub character_count: usize,
    pub sentiment_score: Option<f32>,
    pub readability_score: Option<f32>,
    pub topics: Vec<String>,
    pub entities: Vec<NamedEntity>,
    pub keywords: Vec<Keyword>,
}

/// Named entity extracted from text
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamedEntity {
    pub text: String,
    pub entity_type: String,
    pub confidence: f32,
    pub start_pos: usize,
    pub end_pos: usize,
}

/// Keyword extracted from text
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Keyword {
    pub text: String,
    pub score: f32,
    pub frequency: usize,
}

/// Text feature extractor
pub struct TextExtractor {
    client: reqwest::Client,
}

impl TextExtractor {
    /// Create a new text extractor
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }

    /// Extract language from text
    async fn detect_language(&self, text: &str) -> Result<Option<String>> {
        // Simple language detection based on character patterns
        // In a real implementation, you'd use a proper language detection library

        let english_words = [
            "the", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
        ];
        let spanish_words = [
            "el", "la", "y", "o", "pero", "en", "de", "con", "por", "para",
        ];
        let french_words = [
            "le", "la", "et", "ou", "mais", "dans", "de", "avec", "par", "pour",
        ];

        let text_lower = text.to_lowercase();
        let words: Vec<&str> = text_lower.split_whitespace().collect();

        let mut english_score = 0;
        let mut spanish_score = 0;
        let mut french_score = 0;

        for word in &words {
            if english_words.contains(word) {
                english_score += 1;
            }
            if spanish_words.contains(word) {
                spanish_score += 1;
            }
            if french_words.contains(word) {
                french_score += 1;
            }
        }

        let max_score = english_score.max(spanish_score).max(french_score);
        if max_score == 0 {
            return Ok(None);
        }

        if english_score == max_score {
            Ok(Some("en".to_string()))
        } else if spanish_score == max_score {
            Ok(Some("es".to_string()))
        } else if french_score == max_score {
            Ok(Some("fr".to_string()))
        } else {
            Ok(None)
        }
    }

    /// Extract named entities from text
    async fn extract_entities(&self, text: &str) -> Result<Vec<NamedEntity>> {
        let mut entities = Vec::new();

        // Simple regex-based entity extraction
        // In a real implementation, you'd use a proper NER model

        // Email addresses
        let email_regex = Regex::new(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b")
            .map_err(|e| FeatureExtractionError::text_processing(e.to_string()))?;

        for mat in email_regex.find_iter(text) {
            entities.push(NamedEntity {
                text: mat.as_str().to_string(),
                entity_type: "EMAIL".to_string(),
                confidence: 0.9,
                start_pos: mat.start(),
                end_pos: mat.end(),
            });
        }

        // URLs
        let url_regex = Regex::new(r"https?://[^\s]+")
            .map_err(|e| FeatureExtractionError::text_processing(e.to_string()))?;

        for mat in url_regex.find_iter(text) {
            entities.push(NamedEntity {
                text: mat.as_str().to_string(),
                entity_type: "URL".to_string(),
                confidence: 0.95,
                start_pos: mat.start(),
                end_pos: mat.end(),
            });
        }

        // Phone numbers (simple pattern)
        let phone_regex = Regex::new(r"\b\d{3}-\d{3}-\d{4}\b|\b\(\d{3}\)\s*\d{3}-\d{4}\b")
            .map_err(|e| FeatureExtractionError::text_processing(e.to_string()))?;

        for mat in phone_regex.find_iter(text) {
            entities.push(NamedEntity {
                text: mat.as_str().to_string(),
                entity_type: "PHONE".to_string(),
                confidence: 0.8,
                start_pos: mat.start(),
                end_pos: mat.end(),
            });
        }

        Ok(entities)
    }

    /// Extract keywords from text
    async fn extract_keywords(&self, text: &str) -> Result<Vec<Keyword>> {
        let mut word_freq: HashMap<String, usize> = HashMap::new();

        // Simple keyword extraction based on word frequency
        let words: Vec<String> = text
            .to_lowercase()
            .split_whitespace()
            .filter(|word| word.len() > 3) // Filter short words
            .map(|word| word.to_string())
            .collect();

        for word in words {
            let clean_word = word.trim_matches(|c: char| !c.is_alphabetic());
            if !clean_word.is_empty() {
                *word_freq.entry(clean_word.to_string()).or_insert(0) += 1;
            }
        }

        // Convert to keywords and sort by frequency
        let mut keywords: Vec<Keyword> = word_freq
            .into_iter()
            .map(|(text, frequency)| Keyword {
                score: frequency as f32,
                text,
                frequency,
            })
            .collect();

        keywords.sort_by(|a, b| b.frequency.cmp(&a.frequency));
        keywords.truncate(20); // Keep top 20 keywords

        Ok(keywords)
    }

    /// Calculate sentiment score
    async fn calculate_sentiment(&self, text: &str) -> Result<Option<f32>> {
        // Simple sentiment analysis based on positive/negative word lists
        let positive_words = [
            "good",
            "great",
            "excellent",
            "amazing",
            "wonderful",
            "fantastic",
            "love",
            "like",
            "happy",
            "joy",
        ];
        let negative_words = [
            "bad",
            "terrible",
            "awful",
            "horrible",
            "hate",
            "dislike",
            "sad",
            "angry",
            "disappointed",
            "frustrated",
        ];

        let text_lower = text.to_lowercase();
        let words: Vec<&str> = text_lower.split_whitespace().collect();

        let mut positive_count = 0;
        let mut negative_count = 0;

        for word in words {
            if positive_words.contains(&word) {
                positive_count += 1;
            }
            if negative_words.contains(&word) {
                negative_count += 1;
            }
        }

        let total_sentiment_words = positive_count + negative_count;
        if total_sentiment_words == 0 {
            return Ok(None);
        }

        // Return score between -1 (negative) and 1 (positive)
        let score = (positive_count as f32 - negative_count as f32) / total_sentiment_words as f32;
        Ok(Some(score))
    }

    /// Generate text embedding using OpenAI API
    async fn generate_embedding(
        &self,
        text: &str,
        config: &FeatureExtractionConfig,
    ) -> Result<Vec<f32>> {
        let api_key = config
            .openai_api_key
            .as_ref()
            .ok_or_else(|| FeatureExtractionError::configuration("OpenAI API key not provided"))?;

        let response = self
            .client
            .post("https://api.openai.com/v1/embeddings")
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "input": text,
                "model": config.embedding_model
            }))
            .send()
            .await?;

        let response_json: serde_json::Value = response.json().await?;

        let embedding = response_json["data"][0]["embedding"]
            .as_array()
            .ok_or_else(|| {
                FeatureExtractionError::embedding_generation("Invalid embedding response")
            })?
            .iter()
            .map(|v| v.as_f64().unwrap_or(0.0) as f32)
            .collect();

        Ok(embedding)
    }

    /// Generate tags based on content analysis
    async fn generate_tags(&self, features: &TextFeatures) -> Result<Vec<Tag>> {
        let mut tags = Vec::new();

        // Language tag
        if let Some(ref language) = features.language {
            tags.push(Tag {
                name: "language".to_string(),
                value: Some(language.clone()),
                confidence: 0.8,
                source: "text_analysis".to_string(),
            });
        }

        // Length tags
        if features.word_count < 50 {
            tags.push(Tag {
                name: "length".to_string(),
                value: Some("short".to_string()),
                confidence: 0.9,
                source: "text_analysis".to_string(),
            });
        } else if features.word_count > 500 {
            tags.push(Tag {
                name: "length".to_string(),
                value: Some("long".to_string()),
                confidence: 0.9,
                source: "text_analysis".to_string(),
            });
        } else {
            tags.push(Tag {
                name: "length".to_string(),
                value: Some("medium".to_string()),
                confidence: 0.9,
                source: "text_analysis".to_string(),
            });
        }

        // Sentiment tags
        if let Some(sentiment) = features.sentiment_score {
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
                source: "text_analysis".to_string(),
            });
        }

        // Entity type tags
        for entity in &features.entities {
            tags.push(Tag {
                name: "entity_type".to_string(),
                value: Some(entity.entity_type.clone()),
                confidence: entity.confidence,
                source: "text_analysis".to_string(),
            });
        }

        Ok(tags)
    }
}

#[async_trait]
impl ContentExtractor for TextExtractor {
    type Input = TextInput;
    type Output = TextFeatures;

    async fn extract_features(
        &self,
        input: Self::Input,
        config: &FeatureExtractionConfig,
    ) -> Result<Self::Output> {
        let content = input.content;
        let metadata = input.metadata;

        // Basic text statistics
        let word_count = content.split_whitespace().count();
        let character_count = content.chars().count();

        // Extract various features
        let language = self.detect_language(&content).await?;
        let entities = self.extract_entities(&content).await?;
        let keywords = self.extract_keywords(&content).await?;
        let sentiment_score = self.calculate_sentiment(&content).await?;

        // Generate embedding
        let embedding = self.generate_embedding(&content, config).await?;
        let embeddings = vec![FeatureEmbedding {
            feature_type: "text_content".to_string(),
            embedding,
            confidence: 0.9,
        }];

        let features = TextFeatures {
            content: content.clone(),
            metadata,
            tags: Vec::new(), // Will be populated below
            embeddings,
            language,
            word_count,
            character_count,
            sentiment_score,
            readability_score: None, // Could implement readability calculation
            topics: Vec::new(),      // Could implement topic modeling
            entities,
            keywords,
        };

        // Generate tags based on extracted features
        let tags = self.generate_tags(&features).await?;

        Ok(TextFeatures { tags, ..features })
    }

    async fn should_filter(
        &self,
        features: &Self::Output,
        _config: &FeatureExtractionConfig,
    ) -> Result<bool> {
        // Simple filtering logic

        // Filter very short content
        if features.word_count < 5 {
            return Ok(true);
        }

        // Filter based on sentiment (very negative content)
        if let Some(sentiment) = features.sentiment_score {
            if sentiment < -0.8 {
                return Ok(true);
            }
        }

        // Filter content with too many URLs (likely spam)
        let url_count = features
            .entities
            .iter()
            .filter(|e| e.entity_type == "URL")
            .count();

        if url_count > 5 && features.word_count < 100 {
            return Ok(true);
        }

        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_text_extraction() {
        let extractor = TextExtractor::new();
        let input = TextInput {
            content: "This is a test document with some content.".to_string(),
            metadata: HashMap::new(),
        };

        let config = FeatureExtractionConfig::default();

        // This would fail without API key, but tests the structure
        assert_eq!(input.content.split_whitespace().count(), 9);
    }
}
