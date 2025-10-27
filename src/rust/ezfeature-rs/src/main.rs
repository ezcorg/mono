//! EzFeature-RS: Feature extraction service
//!
//! A comprehensive feature extraction pipeline for various content types including
//! text, websites, audio, video, and YouTube content with PostgreSQL storage and
//! vector similarity search capabilities.

use ezfeature_rs::{ContentInput, FeatureExtractionConfig, FeatureExtractor};
use std::collections::HashMap;
use std::sync::Arc;
use tokio;
use tracing::{error, info};
use warp::Filter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing
    tracing_subscriber::fmt::init();

    info!("Starting `ezfeature-rs` service");

    // Load configuration from environment
    let config = load_config_from_env()?;

    // Initialize feature extractor
    let extractor = Arc::new(FeatureExtractor::new(config.clone()).await?);

    // Create web server routes
    let health = warp::path("health")
        .and(warp::get())
        .map(|| warp::reply::with_status("OK", warp::http::StatusCode::OK));

    let extract_text = warp::path("extract")
        .and(warp::path("text"))
        .and(warp::post())
        .and(warp::body::json())
        .and(with_extractor(extractor.clone()))
        .and_then(handle_text_extraction);

    let extract_website = warp::path("extract")
        .and(warp::path("website"))
        .and(warp::post())
        .and(warp::body::json())
        .and(with_extractor(extractor.clone()))
        .and_then(handle_website_extraction);

    let extract_audio = warp::path("extract")
        .and(warp::path("audio"))
        .and(warp::post())
        .and(warp::body::bytes())
        .and(with_extractor(extractor.clone()))
        .and_then(handle_audio_extraction);

    let extract_video = warp::path("extract")
        .and(warp::path("video"))
        .and(warp::post())
        .and(warp::body::bytes())
        .and(with_extractor(extractor.clone()))
        .and_then(handle_video_extraction);

    let extract_youtube = warp::path("extract")
        .and(warp::path("youtube"))
        .and(warp::post())
        .and(warp::body::json())
        .and(with_extractor(extractor.clone()))
        .and_then(handle_youtube_extraction);

    let find_similar = warp::path("similar")
        .and(warp::path::param::<String>())
        .and(warp::get())
        .and(warp::query::<SimilarityQuery>())
        .and(with_extractor(extractor.clone()))
        .and_then(handle_find_similar);

    let routes = health
        .or(extract_text)
        .or(extract_website)
        .or(extract_audio)
        .or(extract_video)
        .or(extract_youtube)
        .or(find_similar)
        .with(warp::cors().allow_any_origin());

    info!("Server starting on port 8080");
    warp::serve(routes).run(([0, 0, 0, 0], 8080)).await;

    Ok(())
}

fn load_config_from_env() -> Result<FeatureExtractionConfig, Box<dyn std::error::Error>> {
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgresql://localhost/ezfeature".to_string());

    let openai_api_key = std::env::var("OPENAI_API_KEY").ok();
    let youtube_api_key = std::env::var("YOUTUBE_API_KEY").ok();

    let enable_javascript = std::env::var("ENABLE_JAVASCRIPT")
        .unwrap_or_else(|_| "true".to_string())
        .parse()
        .unwrap_or(true);

    let max_content_size_mb = std::env::var("MAX_CONTENT_SIZE_MB")
        .unwrap_or_else(|_| "100".to_string())
        .parse()
        .unwrap_or(100);

    let embedding_model =
        std::env::var("EMBEDDING_MODEL").unwrap_or_else(|_| "text-embedding-3-small".to_string());

    let duplicate_threshold = std::env::var("DUPLICATE_THRESHOLD")
        .unwrap_or_else(|_| "0.95".to_string())
        .parse()
        .unwrap_or(0.95);

    Ok(FeatureExtractionConfig {
        database_url,
        openai_api_key,
        youtube_api_key,
        enable_javascript,
        max_content_size_mb,
        embedding_model,
        duplicate_threshold,
    })
}

fn with_extractor(
    extractor: Arc<FeatureExtractor>,
) -> impl Filter<Extract = (Arc<FeatureExtractor>,), Error = std::convert::Infallible> + Clone {
    warp::any().map(move || extractor.clone())
}

#[derive(serde::Deserialize)]
struct TextExtractionRequest {
    content: String,
    metadata: Option<HashMap<String, serde_json::Value>>,
}

#[derive(serde::Deserialize)]
struct WebsiteExtractionRequest {
    url: String,
    metadata: Option<HashMap<String, serde_json::Value>>,
}

#[derive(serde::Deserialize)]
struct YouTubeExtractionRequest {
    url: String,
    metadata: Option<HashMap<String, serde_json::Value>>,
}

#[derive(serde::Deserialize)]
struct SimilarityQuery {
    threshold: Option<f32>,
    limit: Option<usize>,
}

async fn handle_text_extraction(
    request: TextExtractionRequest,
    extractor: Arc<FeatureExtractor>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let content_input = ContentInput::Text {
        content: request.content,
        metadata: request.metadata.unwrap_or_default(),
    };

    match extractor.process_content(content_input).await {
        Ok(result) => Ok(warp::reply::json(&result)),
        Err(e) => {
            error!("Text extraction failed: {}", e);
            Err(warp::reject::custom(ExtractionError(e.to_string())))
        }
    }
}

async fn handle_website_extraction(
    request: WebsiteExtractionRequest,
    extractor: Arc<FeatureExtractor>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let content_input = ContentInput::Website {
        url: request.url,
        metadata: request.metadata.unwrap_or_default(),
    };

    match extractor.process_content(content_input).await {
        Ok(result) => Ok(warp::reply::json(&result)),
        Err(e) => {
            error!("Website extraction failed: {}", e);
            Err(warp::reject::custom(ExtractionError(e.to_string())))
        }
    }
}

async fn handle_audio_extraction(
    data: bytes::Bytes,
    extractor: Arc<FeatureExtractor>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let content_input = ContentInput::Audio {
        data: data.to_vec(),
        metadata: HashMap::new(),
    };

    match extractor.process_content(content_input).await {
        Ok(result) => Ok(warp::reply::json(&result)),
        Err(e) => {
            error!("Audio extraction failed: {}", e);
            Err(warp::reject::custom(ExtractionError(e.to_string())))
        }
    }
}

async fn handle_video_extraction(
    data: bytes::Bytes,
    extractor: Arc<FeatureExtractor>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let content_input = ContentInput::Video {
        data: data.to_vec(),
        metadata: HashMap::new(),
    };

    match extractor.process_content(content_input).await {
        Ok(result) => Ok(warp::reply::json(&result)),
        Err(e) => {
            error!("Video extraction failed: {}", e);
            Err(warp::reject::custom(ExtractionError(e.to_string())))
        }
    }
}

async fn handle_youtube_extraction(
    request: YouTubeExtractionRequest,
    extractor: Arc<FeatureExtractor>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let content_input = ContentInput::YouTube {
        url: request.url,
        metadata: request.metadata.unwrap_or_default(),
    };

    match extractor.process_content(content_input).await {
        Ok(result) => Ok(warp::reply::json(&result)),
        Err(e) => {
            error!("YouTube extraction failed: {}", e);
            Err(warp::reject::custom(ExtractionError(e.to_string())))
        }
    }
}

async fn handle_find_similar(
    content_id: String,
    query: SimilarityQuery,
    extractor: Arc<FeatureExtractor>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let content_uuid = uuid::Uuid::parse_str(&content_id)
        .map_err(|_| warp::reject::custom(ExtractionError("Invalid UUID".to_string())))?;

    let threshold = query.threshold.unwrap_or(0.8);
    let limit = query.limit.unwrap_or(10);

    match extractor
        .find_similar_content(content_uuid, threshold, limit)
        .await
    {
        Ok(results) => Ok(warp::reply::json(&results)),
        Err(e) => {
            error!("Similarity search failed: {}", e);
            Err(warp::reject::custom(ExtractionError(e.to_string())))
        }
    }
}

#[derive(Debug)]
struct ExtractionError(String);

impl warp::reject::Reject for ExtractionError {}
