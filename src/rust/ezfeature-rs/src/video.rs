//! Video feature extraction pipeline with duplicate detection and audio extraction

use crate::error::{FeatureExtractionError, Result};
use crate::types::*;
use crate::{ContentExtractor, FeatureExtractionConfig};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::process::Command;
use tempfile::NamedTempFile;

/// Input for video feature extraction
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoInput {
    pub data: Vec<u8>,
    pub metadata: HashMap<String, serde_json::Value>,
}

/// Extracted video features
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoFeatures {
    pub metadata: VideoMetadata,
    pub tags: Vec<Tag>,
    pub embeddings: Vec<FeatureEmbedding>,
    pub fingerprint: Option<ContentFingerprint>,
    pub extracted_audio: Option<Vec<u8>>,
    pub keyframes: Vec<Keyframe>,
    pub scene_changes: Vec<f32>,
    pub motion_vectors: Option<Vec<MotionVector>>,
    pub color_histogram: Option<ColorHistogram>,
    pub quality_score: f32,
    pub content_rating: Option<String>,
}

/// Video keyframe information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Keyframe {
    pub timestamp: f32,
    pub frame_data: Vec<u8>, // JPEG encoded frame
    pub features: Vec<f32>,  // Visual features extracted from frame
    pub objects: Vec<DetectedObject>,
}

/// Detected object in a frame
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedObject {
    pub class: String,
    pub confidence: f32,
    pub bbox: (f32, f32, f32, f32), // x, y, width, height (normalized)
}

/// Motion vector information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MotionVector {
    pub timestamp: f32,
    pub magnitude: f32,
    pub direction: f32,
    pub region: (f32, f32, f32, f32), // x, y, width, height
}

/// Color histogram for the video
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColorHistogram {
    pub red: Vec<u32>,
    pub green: Vec<u32>,
    pub blue: Vec<u32>,
    pub dominant_colors: Vec<(u8, u8, u8)>, // RGB values
}

/// Video feature extractor
pub struct VideoExtractor {
    client: reqwest::Client,
}

impl VideoExtractor {
    /// Create a new video extractor
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }

    /// Extract video metadata using FFmpeg
    async fn extract_metadata(&self, data: &[u8]) -> Result<VideoMetadata> {
        // Write video data to temporary file
        let mut temp_file = NamedTempFile::new().map_err(|e| {
            FeatureExtractionError::video_processing(format!("Failed to create temp file: {}", e))
        })?;

        std::io::Write::write_all(&mut temp_file, data).map_err(|e| {
            FeatureExtractionError::video_processing(format!("Failed to write temp file: {}", e))
        })?;

        let temp_path = temp_file.path();

        // Use FFprobe to extract metadata
        let output = Command::new("ffprobe")
            .args(&[
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                temp_path.to_str().unwrap(),
            ])
            .output()
            .map_err(|e| FeatureExtractionError::ffmpeg(format!("FFprobe failed: {}", e)))?;

        if !output.status.success() {
            return Err(FeatureExtractionError::ffmpeg(format!(
                "FFprobe error: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }

        let metadata_json: serde_json::Value =
            serde_json::from_slice(&output.stdout).map_err(|e| {
                FeatureExtractionError::video_processing(format!(
                    "Failed to parse FFprobe output: {}",
                    e
                ))
            })?;

        // Extract video stream information
        let video_stream = metadata_json["streams"].as_array().and_then(|streams| {
            streams
                .iter()
                .find(|stream| stream["codec_type"].as_str() == Some("video"))
        });

        let audio_stream = metadata_json["streams"].as_array().and_then(|streams| {
            streams
                .iter()
                .find(|stream| stream["codec_type"].as_str() == Some("audio"))
        });

        let format = &metadata_json["format"];

        let duration_seconds = format["duration"]
            .as_str()
            .and_then(|d| d.parse::<f32>().ok());

        let (width, height, frame_rate, codec) = if let Some(stream) = video_stream {
            (
                stream["width"].as_i64().map(|w| w as i32),
                stream["height"].as_i64().map(|h| h as i32),
                stream["r_frame_rate"].as_str().and_then(|r| {
                    let parts: Vec<&str> = r.split('/').collect();
                    if parts.len() == 2 {
                        let num: f32 = parts[0].parse().ok()?;
                        let den: f32 = parts[1].parse().ok()?;
                        Some(num / den)
                    } else {
                        None
                    }
                }),
                stream["codec_name"].as_str().map(|c| c.to_string()),
            )
        } else {
            (None, None, None, None)
        };

        let bit_rate = format["bit_rate"]
            .as_str()
            .and_then(|b| b.parse::<i32>().ok());

        let format_name = format["format_name"].as_str().map(|f| f.to_string());

        Ok(VideoMetadata {
            duration_seconds,
            width,
            height,
            frame_rate,
            bit_rate,
            format: format_name,
            codec,
            has_audio: audio_stream.is_some(),
        })
    }

    /// Extract audio from video using FFmpeg
    async fn extract_audio(&self, data: &[u8]) -> Result<Option<Vec<u8>>> {
        // Write video data to temporary file
        let mut temp_video = NamedTempFile::new().map_err(|e| {
            FeatureExtractionError::video_processing(format!("Failed to create temp file: {}", e))
        })?;

        std::io::Write::write_all(&mut temp_video, data).map_err(|e| {
            FeatureExtractionError::video_processing(format!("Failed to write temp file: {}", e))
        })?;

        let temp_audio = NamedTempFile::new().map_err(|e| {
            FeatureExtractionError::video_processing(format!(
                "Failed to create temp audio file: {}",
                e
            ))
        })?;

        // Extract audio using FFmpeg
        let output = Command::new("ffmpeg")
            .args(&[
                "-i",
                temp_video.path().to_str().unwrap(),
                "-vn", // No video
                "-acodec",
                "libmp3lame",
                "-ab",
                "128k",
                "-y", // Overwrite output file
                temp_audio.path().to_str().unwrap(),
            ])
            .output()
            .map_err(|e| FeatureExtractionError::ffmpeg(format!("FFmpeg failed: {}", e)))?;

        if !output.status.success() {
            // Video might not have audio
            return Ok(None);
        }

        // Read extracted audio
        let audio_data = fs::read(temp_audio.path()).map_err(|e| {
            FeatureExtractionError::video_processing(format!("Failed to read audio file: {}", e))
        })?;

        Ok(Some(audio_data))
    }

    /// Extract keyframes from video
    async fn extract_keyframes(&self, data: &[u8], max_frames: usize) -> Result<Vec<Keyframe>> {
        let mut temp_video = NamedTempFile::new().map_err(|e| {
            FeatureExtractionError::video_processing(format!("Failed to create temp file: {}", e))
        })?;

        std::io::Write::write_all(&mut temp_video, data).map_err(|e| {
            FeatureExtractionError::video_processing(format!("Failed to write temp file: {}", e))
        })?;

        let temp_dir = tempfile::tempdir().map_err(|e| {
            FeatureExtractionError::video_processing(format!("Failed to create temp dir: {}", e))
        })?;

        // Extract keyframes using FFmpeg
        let output = Command::new("ffmpeg")
            .args(&[
                "-i",
                temp_video.path().to_str().unwrap(),
                "-vf",
                &format!("select='eq(pict_type,I)',scale=224:224"),
                "-vsync",
                "vfr",
                "-frames:v",
                &max_frames.to_string(),
                "-f",
                "image2",
                &format!("{}/%03d.jpg", temp_dir.path().display()),
            ])
            .output()
            .map_err(|e| {
                FeatureExtractionError::ffmpeg(format!("FFmpeg keyframe extraction failed: {}", e))
            })?;

        if !output.status.success() {
            return Err(FeatureExtractionError::ffmpeg(format!(
                "FFmpeg keyframe error: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }

        // Read extracted keyframes
        let mut keyframes = Vec::new();
        for i in 1..=max_frames {
            let frame_path = temp_dir.path().join(format!("{:03}.jpg", i));
            if frame_path.exists() {
                let frame_data = fs::read(&frame_path).map_err(|e| {
                    FeatureExtractionError::video_processing(format!("Failed to read frame: {}", e))
                })?;

                // Extract basic features from frame (simplified)
                let features = self.extract_frame_features(&frame_data)?;

                keyframes.push(Keyframe {
                    timestamp: (i - 1) as f32, // Simplified timestamp
                    frame_data,
                    features,
                    objects: Vec::new(), // Could implement object detection
                });
            }
        }

        Ok(keyframes)
    }

    /// Extract features from a single frame
    fn extract_frame_features(&self, frame_data: &[u8]) -> Result<Vec<f32>> {
        // Simplified feature extraction
        // In practice, you'd use computer vision libraries to extract:
        // - SIFT/SURF features
        // - Color histograms
        // - Texture features
        // - Deep learning features (CNN)

        let mut features = Vec::new();

        // Simple color-based features
        let mut r_sum = 0u64;
        let mut g_sum = 0u64;
        let mut b_sum = 0u64;
        let mut pixel_count = 0u64;

        // This is a very simplified approach - in reality you'd decode the JPEG
        for chunk in frame_data.chunks(3) {
            if chunk.len() == 3 {
                r_sum += chunk[0] as u64;
                g_sum += chunk[1] as u64;
                b_sum += chunk[2] as u64;
                pixel_count += 1;
            }
        }

        if pixel_count > 0 {
            features.push((r_sum as f32) / (pixel_count as f32) / 255.0);
            features.push((g_sum as f32) / (pixel_count as f32) / 255.0);
            features.push((b_sum as f32) / (pixel_count as f32) / 255.0);
        }

        // Pad to fixed size
        features.resize(128, 0.0);

        Ok(features)
    }

    /// Generate video fingerprint for duplicate detection
    fn generate_fingerprint(&self, keyframes: &[Keyframe]) -> Result<Option<ContentFingerprint>> {
        if keyframes.is_empty() {
            return Ok(None);
        }

        // Create hash from video data
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        for keyframe in keyframes {
            hasher.update(&keyframe.frame_data);
        }
        let hash = format!("{:x}", hasher.finalize());

        // Create video fingerprint from keyframe features
        let mut fingerprint = Vec::new();
        for keyframe in keyframes.iter().take(256) {
            // Limit to 256 keyframes
            if !keyframe.features.is_empty() {
                fingerprint.push(keyframe.features[0]); // Use first feature
            }
        }

        // Pad or truncate to 256 dimensions
        fingerprint.resize(256, 0.0);

        Ok(Some(ContentFingerprint {
            hash,
            audio_fingerprint: None,
            video_fingerprint: Some(fingerprint),
            text_fingerprint: None,
        }))
    }

    /// Detect scene changes in video
    fn detect_scene_changes(&self, keyframes: &[Keyframe]) -> Vec<f32> {
        let mut scene_changes = Vec::new();

        for i in 1..keyframes.len() {
            let prev_features = &keyframes[i - 1].features;
            let curr_features = &keyframes[i].features;

            // Calculate feature difference
            let mut diff_sum = 0.0;
            for (prev, curr) in prev_features.iter().zip(curr_features.iter()) {
                diff_sum += (prev - curr).abs();
            }

            let avg_diff = if !prev_features.is_empty() {
                diff_sum / prev_features.len() as f32
            } else {
                0.0
            };

            scene_changes.push(avg_diff);
        }

        scene_changes
    }

    /// Calculate video quality score
    fn calculate_quality_score(&self, metadata: &VideoMetadata, keyframes: &[Keyframe]) -> f32 {
        let mut score: f32 = 0.5; // Base score

        // Resolution quality
        if let (Some(width), Some(height)) = (metadata.width, metadata.height) {
            let pixels = width * height;
            if pixels >= 1920 * 1080 {
                // 1080p or higher
                score += 0.3;
            } else if pixels >= 1280 * 720 {
                // 720p
                score += 0.2;
            } else if pixels >= 640 * 480 {
                // 480p
                score += 0.1;
            }
        }

        // Frame rate quality
        if let Some(fps) = metadata.frame_rate {
            if fps >= 60.0 {
                score += 0.1;
            } else if fps >= 30.0 {
                score += 0.05;
            }
        }

        // Bit rate quality
        if let Some(bit_rate) = metadata.bit_rate {
            if bit_rate >= 5000000 {
                // 5 Mbps
                score += 0.1;
            } else if bit_rate >= 1000000 {
                // 1 Mbps
                score += 0.05;
            }
        }

        // Keyframe consistency (less variation = better quality)
        if keyframes.len() > 1 {
            let scene_changes = self.detect_scene_changes(keyframes);
            let avg_change: f32 = scene_changes.iter().sum::<f32>() / scene_changes.len() as f32;
            if avg_change < 0.1 {
                score += 0.05;
            }
        }

        score.min(1.0)
    }

    /// Generate tags based on video analysis
    fn generate_tags(&self, features: &VideoFeatures) -> Vec<Tag> {
        let mut tags = Vec::new();

        // Duration tags
        if let Some(duration) = features.metadata.duration_seconds {
            let duration_tag = if duration < 60.0 {
                "short"
            } else if duration > 1800.0 {
                // 30 minutes
                "long"
            } else {
                "medium"
            };

            tags.push(Tag {
                name: "duration".to_string(),
                value: Some(duration_tag.to_string()),
                confidence: 1.0,
                source: "video_analysis".to_string(),
            });
        }

        // Resolution tags
        if let (Some(width), Some(height)) = (features.metadata.width, features.metadata.height) {
            let resolution_tag = if width >= 1920 && height >= 1080 {
                "hd"
            } else if width >= 1280 && height >= 720 {
                "hd_ready"
            } else {
                "sd"
            };

            tags.push(Tag {
                name: "resolution".to_string(),
                value: Some(resolution_tag.to_string()),
                confidence: 1.0,
                source: "video_analysis".to_string(),
            });
        }

        // Audio tag
        if features.metadata.has_audio {
            tags.push(Tag {
                name: "has_audio".to_string(),
                value: Some("true".to_string()),
                confidence: 1.0,
                source: "video_analysis".to_string(),
            });
        }

        // Quality tags
        let quality_tag = if features.quality_score > 0.8 {
            "high"
        } else if features.quality_score > 0.5 {
            "medium"
        } else {
            "low"
        };

        tags.push(Tag {
            name: "quality".to_string(),
            value: Some(quality_tag.to_string()),
            confidence: features.quality_score,
            source: "video_analysis".to_string(),
        });

        // Format tags
        if let Some(format) = &features.metadata.format {
            tags.push(Tag {
                name: "format".to_string(),
                value: Some(format.clone()),
                confidence: 1.0,
                source: "video_analysis".to_string(),
            });
        }

        tags
    }

    /// Generate embeddings for video content
    async fn generate_embeddings(
        &self,
        features: &VideoFeatures,
        _config: &FeatureExtractionConfig,
    ) -> Result<Vec<FeatureEmbedding>> {
        let mut embeddings = Vec::new();

        // Generate embedding from keyframe features
        if !features.keyframes.is_empty() {
            let mut combined_features = Vec::new();
            for keyframe in &features.keyframes {
                combined_features.extend(&keyframe.features);
            }

            // Limit size and normalize
            combined_features.truncate(512);
            combined_features.resize(512, 0.0);

            embeddings.push(FeatureEmbedding {
                feature_type: "video_visual".to_string(),
                embedding: combined_features,
                confidence: 0.8,
            });
        }

        // Generate embedding from scene changes
        if !features.scene_changes.is_empty() {
            let mut scene_features = features.scene_changes.clone();
            scene_features.resize(64, 0.0);

            embeddings.push(FeatureEmbedding {
                feature_type: "video_temporal".to_string(),
                embedding: scene_features,
                confidence: 0.7,
            });
        }

        Ok(embeddings)
    }
}

#[async_trait]
impl ContentExtractor for VideoExtractor {
    type Input = VideoInput;
    type Output = VideoFeatures;

    async fn extract_features(
        &self,
        input: Self::Input,
        config: &FeatureExtractionConfig,
    ) -> Result<Self::Output> {
        let data = input.data;
        let _metadata = input.metadata;

        // Check content size
        let size_mb = data.len() / (1024 * 1024);
        if size_mb > config.max_content_size_mb {
            return Err(FeatureExtractionError::ContentTooLarge {
                size: data.len(),
                limit: config.max_content_size_mb * 1024 * 1024,
            });
        }

        // Extract video metadata
        let video_metadata = self.extract_metadata(&data).await?;

        // Extract audio if present
        let extracted_audio = if video_metadata.has_audio {
            self.extract_audio(&data).await?
        } else {
            None
        };

        // Extract keyframes
        let keyframes = self.extract_keyframes(&data, 10).await?; // Extract up to 10 keyframes

        // Generate fingerprint
        let fingerprint = self.generate_fingerprint(&keyframes)?;

        // Detect scene changes
        let scene_changes = self.detect_scene_changes(&keyframes);

        // Calculate quality score
        let quality_score = self.calculate_quality_score(&video_metadata, &keyframes);

        let features = VideoFeatures {
            metadata: video_metadata,
            tags: Vec::new(),       // Will be populated below
            embeddings: Vec::new(), // Will be populated below
            fingerprint,
            extracted_audio,
            keyframes,
            scene_changes,
            motion_vectors: None,  // Could implement motion vector analysis
            color_histogram: None, // Could implement color analysis
            quality_score,
            content_rating: None, // Could implement content rating
        };

        // Generate tags
        let tags = self.generate_tags(&features);

        // Generate embeddings
        let embeddings = self.generate_embeddings(&features, config).await?;

        Ok(VideoFeatures {
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
        // Filter based on quality and content

        // Filter very low quality video
        if features.quality_score < 0.2 {
            return Ok(true);
        }

        // Filter very short videos (likely noise or artifacts)
        if let Some(duration) = features.metadata.duration_seconds {
            if duration < 2.0 {
                return Ok(true);
            }
        }

        // Filter videos with no keyframes (corrupted)
        if features.keyframes.is_empty() {
            return Ok(true);
        }

        // Filter videos with very low resolution
        if let (Some(width), Some(height)) = (features.metadata.width, features.metadata.height) {
            if width < 160 || height < 120 {
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
    fn test_video_extractor_creation() {
        let extractor = VideoExtractor::new();
        // Basic test to ensure the extractor can be created
        assert!(true);
    }

    #[test]
    fn test_quality_score_calculation() {
        let extractor = VideoExtractor::new();
        let metadata = VideoMetadata {
            duration_seconds: Some(60.0),
            width: Some(1920),
            height: Some(1080),
            frame_rate: Some(30.0),
            bit_rate: Some(5000000),
            format: Some("mp4".to_string()),
            codec: Some("h264".to_string()),
            has_audio: true,
        };

        let keyframes = Vec::new();
        let score = extractor.calculate_quality_score(&metadata, &keyframes);
        assert!(score > 0.5);
    }
}
