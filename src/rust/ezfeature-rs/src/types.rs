//! Core types and data structures for the feature extraction system

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/// Content types supported by the feature extraction system
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContentType {
    Text,
    Website,
    Audio,
    Video,
    YouTube,
}

impl ContentType {
    pub fn to_db_string(&self) -> &'static str {
        match self {
            ContentType::Text => "text",
            ContentType::Website => "website",
            ContentType::Audio => "audio",
            ContentType::Video => "video",
            ContentType::YouTube => "youtube",
        }
    }

    pub fn from_db_string(s: &str) -> Option<Self> {
        match s {
            "text" => Some(ContentType::Text),
            "website" => Some(ContentType::Website),
            "audio" => Some(ContentType::Audio),
            "video" => Some(ContentType::Video),
            "youtube" => Some(ContentType::YouTube),
            _ => None,
        }
    }
}

/// Input types for different content processors
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ContentInput {
    Text {
        content: String,
        metadata: HashMap<String, serde_json::Value>,
    },
    Website {
        url: String,
        metadata: HashMap<String, serde_json::Value>,
    },
    Audio {
        data: Vec<u8>,
        metadata: HashMap<String, serde_json::Value>,
    },
    Video {
        data: Vec<u8>,
        metadata: HashMap<String, serde_json::Value>,
    },
    YouTube {
        url: String,
        metadata: HashMap<String, serde_json::Value>,
    },
}

/// Result of content processing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessingResult {
    pub content_id: Uuid,
    pub content_type: ContentType,
    pub should_filter: bool,
    pub features: serde_json::Value,
}

/// Similar content result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimilarContent {
    pub content_id: Uuid,
    pub content_type: ContentType,
    pub similarity_score: f32,
    pub title: Option<String>,
    pub url: Option<String>,
}

/// Tag information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub name: String,
    pub value: Option<String>,
    pub confidence: f32,
    pub source: String,
}

/// Feature embedding
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureEmbedding {
    pub feature_type: String,
    pub embedding: Vec<f32>,
    pub confidence: f32,
}

/// Audio metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioMetadata {
    pub duration_seconds: Option<f32>,
    pub sample_rate: Option<i32>,
    pub channels: Option<i32>,
    pub bit_rate: Option<i32>,
    pub format: Option<String>,
    pub codec: Option<String>,
}

/// Video metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoMetadata {
    pub duration_seconds: Option<f32>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub frame_rate: Option<f32>,
    pub bit_rate: Option<i32>,
    pub format: Option<String>,
    pub codec: Option<String>,
    pub has_audio: bool,
}

/// Website metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebsiteMetadata {
    pub domain: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub keywords: Vec<String>,
    pub language: Option<String>,
    pub has_audio: bool,
    pub has_video: bool,
    pub audio_urls: Vec<String>,
    pub video_urls: Vec<String>,
    pub javascript_executed: bool,
    pub page_load_time_ms: Option<i32>,
}

/// YouTube metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YouTubeMetadata {
    pub video_id: String,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    pub view_count: Option<i64>,
    pub like_count: Option<i64>,
    pub comment_count: Option<i64>,
    pub upload_date: Option<chrono::DateTime<chrono::Utc>>,
    pub comments: Vec<YouTubeComment>,
    pub statistics: HashMap<String, serde_json::Value>,
}

/// YouTube comment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YouTubeComment {
    pub author: String,
    pub text: String,
    pub like_count: Option<i64>,
    pub published_at: Option<chrono::DateTime<chrono::Utc>>,
    pub replies: Vec<YouTubeComment>,
}

/// Content fingerprint for duplicate detection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentFingerprint {
    pub hash: String,
    pub audio_fingerprint: Option<Vec<f32>>,
    pub video_fingerprint: Option<Vec<f32>>,
    pub text_fingerprint: Option<Vec<f32>>,
}

/// Filter criteria for content
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterCriteria {
    pub min_quality_score: f32,
    pub blocked_tags: Vec<String>,
    pub required_tags: Vec<String>,
    pub max_duration_seconds: Option<f32>,
    pub min_duration_seconds: Option<f32>,
    pub allowed_languages: Vec<String>,
    pub blocked_domains: Vec<String>,
}

impl Default for FilterCriteria {
    fn default() -> Self {
        Self {
            min_quality_score: 0.5,
            blocked_tags: vec![
                "spam".to_string(),
                "inappropriate".to_string(),
                "low-quality".to_string(),
            ],
            required_tags: vec![],
            max_duration_seconds: None,
            min_duration_seconds: None,
            allowed_languages: vec!["en".to_string()],
            blocked_domains: vec![],
        }
    }
}
