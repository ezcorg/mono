//! Database integration layer for storing and retrieving content features

use crate::error::{FeatureExtractionError, Result};
use crate::types::*;
use sqlx::{query, PgPool, Row};
use std::collections::HashMap;
use uuid::Uuid;

/// Database connection and operations
pub struct Database {
    pool: PgPool,
}

impl Database {
    /// Create a new database connection
    pub async fn new(database_url: &str) -> Result<Self> {
        let pool = PgPool::connect(database_url).await?;

        // Run migrations
        sqlx::migrate::Migrator::new(std::path::Path::new("./migrations"))
            .await?
            .run(&pool)
            .await?;

        Ok(Self { pool })
    }

    /// Store content in the database
    pub async fn store_content(
        &self,
        content_type: ContentType,
        content_data: &str,
        metadata: HashMap<String, serde_json::Value>,
    ) -> Result<Uuid> {
        let content_hash = self.calculate_content_hash(content_data);

        // Check for duplicates
        if let Some(_existing_id) = self.find_duplicate_by_hash(&content_hash).await? {
            return Err(FeatureExtractionError::DuplicateContent { hash: content_hash });
        }

        let content_id = Uuid::new_v4();
        let metadata_json = serde_json::to_value(metadata)?;

        query(
            r#"
            INSERT INTO content (id, content_type, title, description, metadata, content_hash)
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(content_id)
        .bind(content_type.to_db_string())
        .bind(metadata_json.get("title").and_then(|v| v.as_str()))
        .bind(metadata_json.get("description").and_then(|v| v.as_str()))
        .bind(&metadata_json)
        .bind(content_hash)
        .execute(&self.pool)
        .await?;

        Ok(content_id)
    }

    /// Store text features
    pub async fn store_text_features(
        &self,
        content_id: Uuid,
        features: &crate::text::TextFeatures,
    ) -> Result<()> {
        // Store tags
        for tag in &features.tags {
            query(
                r#"
                INSERT INTO tags (content_id, tag_name, tag_value, confidence_score, source)
                VALUES ($1, $2, $3, $4, $5)
                "#,
            )
            .bind(content_id)
            .bind(&tag.name)
            .bind(&tag.value)
            .bind(tag.confidence)
            .bind(&tag.source)
            .execute(&self.pool)
            .await?;
        }

        // Store embeddings
        for embedding in &features.embeddings {
            query(
                r#"
                INSERT INTO features (content_id, feature_type, feature_data, embedding, confidence_score)
                VALUES ($1, $2, $3, $4, $5)
                "#,
            )
            .bind(content_id)
            .bind(&embedding.feature_type)
            .bind(serde_json::json!({}))
            .bind(&embedding.embedding)
            .bind(embedding.confidence)
            .execute(&self.pool)
            .await?;
        }

        Ok(())
    }

    /// Store website features
    pub async fn store_website_features(
        &self,
        content_id: Uuid,
        features: &crate::website::WebsiteFeatures,
    ) -> Result<()> {
        // Store website metadata
        query(
            r#"
            INSERT INTO website_metadata (
                content_id, domain, page_title, meta_description, meta_keywords,
                language, has_audio, has_video, audio_urls, video_urls,
                javascript_executed, page_load_time_ms
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            "#,
        )
        .bind(content_id)
        .bind(&features.metadata.domain)
        .bind(&features.metadata.title)
        .bind(&features.metadata.description)
        .bind(&features.metadata.keywords)
        .bind(&features.metadata.language)
        .bind(features.metadata.has_audio)
        .bind(features.metadata.has_video)
        .bind(&features.metadata.audio_urls)
        .bind(&features.metadata.video_urls)
        .bind(features.metadata.javascript_executed)
        .bind(features.metadata.page_load_time_ms)
        .execute(&self.pool)
        .await?;

        // Store tags and embeddings
        self.store_tags_and_embeddings(content_id, &features.tags, &features.embeddings)
            .await?;

        Ok(())
    }

    /// Store audio features
    pub async fn store_audio_features(
        &self,
        content_id: Uuid,
        features: &crate::audio::AudioFeatures,
    ) -> Result<()> {
        // Store audio metadata
        query(
            r#"
            INSERT INTO audio_metadata (
                content_id, duration_seconds, sample_rate, channels, bit_rate,
                format, codec, audio_fingerprint
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            "#,
        )
        .bind(content_id)
        .bind(features.metadata.duration_seconds)
        .bind(features.metadata.sample_rate)
        .bind(features.metadata.channels)
        .bind(features.metadata.bit_rate)
        .bind(&features.metadata.format)
        .bind(&features.metadata.codec)
        .bind(
            features
                .fingerprint
                .as_ref()
                .and_then(|f| f.audio_fingerprint.as_ref()),
        )
        .execute(&self.pool)
        .await?;

        // Store tags and embeddings
        self.store_tags_and_embeddings(content_id, &features.tags, &features.embeddings)
            .await?;

        Ok(())
    }

    /// Store video features
    pub async fn store_video_features(
        &self,
        content_id: Uuid,
        features: &crate::video::VideoFeatures,
    ) -> Result<()> {
        // Store video metadata
        query(
            r#"
            INSERT INTO video_metadata (
                content_id, duration_seconds, width, height, frame_rate,
                bit_rate, format, codec, has_audio, video_fingerprint
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            "#,
        )
        .bind(content_id)
        .bind(features.metadata.duration_seconds)
        .bind(features.metadata.width)
        .bind(features.metadata.height)
        .bind(features.metadata.frame_rate)
        .bind(features.metadata.bit_rate)
        .bind(&features.metadata.format)
        .bind(&features.metadata.codec)
        .bind(features.metadata.has_audio)
        .bind(
            features
                .fingerprint
                .as_ref()
                .and_then(|f| f.video_fingerprint.as_ref()),
        )
        .execute(&self.pool)
        .await?;

        // Store tags and embeddings
        self.store_tags_and_embeddings(content_id, &features.tags, &features.embeddings)
            .await?;

        Ok(())
    }

    /// Store YouTube features
    pub async fn store_youtube_features(
        &self,
        content_id: Uuid,
        features: &crate::youtube::YouTubeFeatures,
    ) -> Result<()> {
        // Store YouTube metadata
        let comments_json = serde_json::to_value(&features.metadata.comments)?;
        let statistics_json = serde_json::to_value(&features.metadata.statistics)?;

        query(
            r#"
            INSERT INTO youtube_metadata (
                content_id, video_id, channel_id, channel_name, view_count,
                like_count, comment_count, upload_date, comments_data, statistics
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            "#,
        )
        .bind(content_id)
        .bind(&features.metadata.video_id)
        .bind(&features.metadata.channel_id)
        .bind(&features.metadata.channel_name)
        .bind(features.metadata.view_count)
        .bind(features.metadata.like_count)
        .bind(features.metadata.comment_count)
        .bind(features.metadata.upload_date)
        .bind(comments_json)
        .bind(statistics_json)
        .execute(&self.pool)
        .await?;

        // Store tags and embeddings
        self.store_tags_and_embeddings(content_id, &features.tags, &features.embeddings)
            .await?;

        Ok(())
    }

    /// Find similar content based on embeddings
    pub async fn find_similar_content(
        &self,
        content_id: Uuid,
        similarity_threshold: f32,
        limit: usize,
    ) -> Result<Vec<SimilarContent>> {
        let rows = query(
            r#"
            SELECT
                c.id,
                c.content_type,
                c.title,
                c.url,
                1 - (f1.embedding <=> f2.embedding) as similarity
            FROM content c
            JOIN features f1 ON c.id = f1.content_id
            JOIN features f2 ON f2.content_id = $1
            WHERE c.id != $1
            AND 1 - (f1.embedding <=> f2.embedding) > $2
            ORDER BY similarity DESC
            LIMIT $3
            "#,
        )
        .bind(content_id)
        .bind(similarity_threshold)
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await?;

        let results = rows
            .into_iter()
            .map(|row| {
                let content_type_str: String = row.get("content_type");
                SimilarContent {
                    content_id: row.get("id"),
                    content_type: ContentType::from_db_string(&content_type_str)
                        .unwrap_or(ContentType::Text),
                    similarity_score: row.get::<Option<f32>, _>("similarity").unwrap_or(0.0),
                    title: row.get("title"),
                    url: row.get("url"),
                }
            })
            .collect();

        Ok(results)
    }

    /// Find duplicate content by hash
    pub async fn find_duplicate_by_hash(&self, content_hash: &str) -> Result<Option<Uuid>> {
        let row = query("SELECT id FROM content WHERE content_hash = $1")
            .bind(content_hash)
            .fetch_optional(&self.pool)
            .await?;

        Ok(row.map(|r| r.get("id")))
    }

    /// Helper method to store tags and embeddings
    async fn store_tags_and_embeddings(
        &self,
        content_id: Uuid,
        tags: &[Tag],
        embeddings: &[FeatureEmbedding],
    ) -> Result<()> {
        // Store tags
        for tag in tags {
            query(
                r#"
                INSERT INTO tags (content_id, tag_name, tag_value, confidence_score, source)
                VALUES ($1, $2, $3, $4, $5)
                "#,
            )
            .bind(content_id)
            .bind(&tag.name)
            .bind(&tag.value)
            .bind(tag.confidence)
            .bind(&tag.source)
            .execute(&self.pool)
            .await?;
        }

        // Store embeddings
        for embedding in embeddings {
            query(
                r#"
                INSERT INTO features (content_id, feature_type, feature_data, embedding, confidence_score)
                VALUES ($1, $2, $3, $4, $5)
                "#,
            )
            .bind(content_id)
            .bind(&embedding.feature_type)
            .bind(serde_json::json!({}))
            .bind(&embedding.embedding)
            .bind(embedding.confidence)
            .execute(&self.pool)
            .await?;
        }

        Ok(())
    }

    /// Calculate content hash for deduplication
    fn calculate_content_hash(&self, content: &str) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(content.as_bytes());
        format!("{:x}", hasher.finalize())
    }
}
