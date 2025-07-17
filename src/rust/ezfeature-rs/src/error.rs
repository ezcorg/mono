//! Error types for the feature extraction system

use thiserror::Error;

/// Main error type for feature extraction operations
#[derive(Error, Debug)]
pub enum FeatureExtractionError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Migration error: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Audio processing error: {0}")]
    AudioProcessing(String),

    #[error("Video processing error: {0}")]
    VideoProcessing(String),

    #[error("Web scraping error: {0}")]
    WebScraping(String),

    #[error("YouTube API error: {0}")]
    YouTubeApi(String),

    #[error("Text processing error: {0}")]
    TextProcessing(String),

    #[error("Embedding generation error: {0}")]
    EmbeddingGeneration(String),

    #[error("Content too large: {size} bytes exceeds limit of {limit} bytes")]
    ContentTooLarge { size: usize, limit: usize },

    #[error("Unsupported content type: {content_type}")]
    UnsupportedContentType { content_type: String },

    #[error("Invalid URL: {url}")]
    InvalidUrl { url: String },

    #[error("Content not found: {id}")]
    ContentNotFound { id: String },

    #[error("Duplicate content detected: {hash}")]
    DuplicateContent { hash: String },

    #[error("Configuration error: {message}")]
    Configuration { message: String },

    #[error("External service error: {service} - {message}")]
    ExternalService { service: String, message: String },

    #[error("Timeout error: operation timed out after {seconds} seconds")]
    Timeout { seconds: u64 },

    #[error("Rate limit exceeded for service: {service}")]
    RateLimit { service: String },

    #[error("Authentication error: {message}")]
    Authentication { message: String },

    #[error("Validation error: {field} - {message}")]
    Validation { field: String, message: String },

    #[error("Feature extraction failed: {reason}")]
    ExtractionFailed { reason: String },

    #[error("Browser automation error: {message}")]
    BrowserAutomation { message: String },

    #[error("FFmpeg error: {message}")]
    FFmpeg { message: String },

    #[error("Model loading error: {model} - {message}")]
    ModelLoading { model: String, message: String },

    #[error("Vector operation error: {operation} - {message}")]
    VectorOperation { operation: String, message: String },
}

/// Result type alias for feature extraction operations
pub type Result<T> = std::result::Result<T, FeatureExtractionError>;

impl FeatureExtractionError {
    /// Create a new audio processing error
    pub fn audio_processing<S: Into<String>>(message: S) -> Self {
        Self::AudioProcessing(message.into())
    }

    /// Create a new video processing error
    pub fn video_processing<S: Into<String>>(message: S) -> Self {
        Self::VideoProcessing(message.into())
    }

    /// Create a new web scraping error
    pub fn web_scraping<S: Into<String>>(message: S) -> Self {
        Self::WebScraping(message.into())
    }

    /// Create a new YouTube API error
    pub fn youtube_api<S: Into<String>>(message: S) -> Self {
        Self::YouTubeApi(message.into())
    }

    /// Create a new text processing error
    pub fn text_processing<S: Into<String>>(message: S) -> Self {
        Self::TextProcessing(message.into())
    }

    /// Create a new embedding generation error
    pub fn embedding_generation<S: Into<String>>(message: S) -> Self {
        Self::EmbeddingGeneration(message.into())
    }

    /// Create a new configuration error
    pub fn configuration<S: Into<String>>(message: S) -> Self {
        Self::Configuration {
            message: message.into(),
        }
    }

    /// Create a new external service error
    pub fn external_service<S: Into<String>>(service: S, message: S) -> Self {
        Self::ExternalService {
            service: service.into(),
            message: message.into(),
        }
    }

    /// Create a new validation error
    pub fn validation<S: Into<String>>(field: S, message: S) -> Self {
        Self::Validation {
            field: field.into(),
            message: message.into(),
        }
    }

    /// Create a new extraction failed error
    pub fn extraction_failed<S: Into<String>>(reason: S) -> Self {
        Self::ExtractionFailed {
            reason: reason.into(),
        }
    }

    /// Create a new browser automation error
    pub fn browser_automation<S: Into<String>>(message: S) -> Self {
        Self::BrowserAutomation {
            message: message.into(),
        }
    }

    /// Create a new FFmpeg error
    pub fn ffmpeg<S: Into<String>>(message: S) -> Self {
        Self::FFmpeg {
            message: message.into(),
        }
    }

    /// Create a new model loading error
    pub fn model_loading<S: Into<String>>(model: S, message: S) -> Self {
        Self::ModelLoading {
            model: model.into(),
            message: message.into(),
        }
    }

    /// Create a new vector operation error
    pub fn vector_operation<S: Into<String>>(operation: S, message: S) -> Self {
        Self::VectorOperation {
            operation: operation.into(),
            message: message.into(),
        }
    }

    /// Check if the error is retryable
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::Network(_)
                | Self::Timeout { .. }
                | Self::RateLimit { .. }
                | Self::ExternalService { .. }
                | Self::BrowserAutomation { .. }
        )
    }

    /// Get the error category for logging/metrics
    pub fn category(&self) -> &'static str {
        match self {
            Self::Database(_) => "database",
            Self::Migration(_) => "migration",
            Self::Network(_) => "network",
            Self::Serialization(_) => "serialization",
            Self::Io(_) => "io",
            Self::AudioProcessing(_) => "audio_processing",
            Self::VideoProcessing(_) => "video_processing",
            Self::WebScraping(_) => "web_scraping",
            Self::YouTubeApi(_) => "youtube_api",
            Self::TextProcessing(_) => "text_processing",
            Self::EmbeddingGeneration(_) => "embedding_generation",
            Self::ContentTooLarge { .. } => "content_validation",
            Self::UnsupportedContentType { .. } => "content_validation",
            Self::InvalidUrl { .. } => "validation",
            Self::ContentNotFound { .. } => "not_found",
            Self::DuplicateContent { .. } => "duplicate",
            Self::Configuration { .. } => "configuration",
            Self::ExternalService { .. } => "external_service",
            Self::Timeout { .. } => "timeout",
            Self::RateLimit { .. } => "rate_limit",
            Self::Authentication { .. } => "authentication",
            Self::Validation { .. } => "validation",
            Self::ExtractionFailed { .. } => "extraction",
            Self::BrowserAutomation { .. } => "browser_automation",
            Self::FFmpeg { .. } => "ffmpeg",
            Self::ModelLoading { .. } => "model_loading",
            Self::VectorOperation { .. } => "vector_operation",
        }
    }
}
