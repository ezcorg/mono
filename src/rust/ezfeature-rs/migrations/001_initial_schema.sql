-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Content table to store all content with metadata
CREATE TABLE IF NOT EXISTS content (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_type TEXT NOT NULL CHECK (content_type IN ('text', 'website', 'audio', 'video', 'youtube')),
    url TEXT,
    title TEXT,
    description TEXT,
    raw_data BYTEA,
    metadata JSONB DEFAULT '{}',
    content_hash TEXT UNIQUE NOT NULL, -- SHA-256 hash for deduplication
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Features table to store extracted features
CREATE TABLE IF NOT EXISTS features (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id UUID NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    feature_type TEXT NOT NULL, -- e.g., 'text_tags', 'audio_metadata', 'video_transcript'
    feature_data JSONB NOT NULL,
    embedding vector(1536), -- OpenAI embedding dimension, adjust as needed
    confidence_score REAL,
    extracted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tags table for categorical features
CREATE TABLE IF NOT EXISTS tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id UUID NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    tag_name TEXT NOT NULL,
    tag_value TEXT,
    confidence_score REAL,
    source TEXT NOT NULL, -- e.g., 'text_analysis', 'audio_analysis', 'manual'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Audio metadata table
CREATE TABLE IF NOT EXISTS audio_metadata (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id UUID NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    duration_seconds REAL,
    sample_rate INTEGER,
    channels INTEGER,
    bit_rate INTEGER,
    format TEXT,
    codec TEXT,
    is_duplicate_of UUID REFERENCES content(id), -- Reference to original if duplicate
    audio_fingerprint vector(128), -- Audio fingerprint for duplicate detection
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Video metadata table
CREATE TABLE IF NOT EXISTS video_metadata (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id UUID NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    duration_seconds REAL,
    width INTEGER,
    height INTEGER,
    frame_rate REAL,
    bit_rate INTEGER,
    format TEXT,
    codec TEXT,
    has_audio BOOLEAN DEFAULT FALSE,
    audio_content_id UUID REFERENCES content(id), -- Extracted audio
    is_duplicate_of UUID REFERENCES content(id), -- Reference to original if duplicate
    video_fingerprint vector(256), -- Video fingerprint for duplicate detection
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- YouTube specific metadata
CREATE TABLE IF NOT EXISTS youtube_metadata (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id UUID NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    video_id TEXT UNIQUE NOT NULL,
    channel_id TEXT,
    channel_name TEXT,
    view_count BIGINT,
    like_count BIGINT,
    comment_count BIGINT,
    upload_date TIMESTAMP WITH TIME ZONE,
    transcript_content_id UUID REFERENCES content(id), -- Extracted transcript
    comments_data JSONB, -- Store comments as JSON
    statistics JSONB, -- Additional statistics
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Website metadata table
CREATE TABLE IF NOT EXISTS website_metadata (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id UUID NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    domain TEXT,
    page_title TEXT,
    meta_description TEXT,
    meta_keywords TEXT[],
    language TEXT,
    has_audio BOOLEAN DEFAULT FALSE,
    has_video BOOLEAN DEFAULT FALSE,
    audio_urls TEXT[],
    video_urls TEXT[],
    javascript_executed BOOLEAN DEFAULT FALSE,
    page_load_time_ms INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_content_type ON content(content_type);
CREATE INDEX idx_content_hash ON content(content_hash);
CREATE INDEX idx_content_created_at ON content(created_at);

CREATE INDEX idx_features_content_id ON features(content_id);
CREATE INDEX idx_features_type ON features(feature_type);
CREATE INDEX idx_features_embedding ON features USING ivfflat (embedding vector_cosine_ops);

CREATE INDEX idx_tags_content_id ON tags(content_id);
CREATE INDEX idx_tags_name ON tags(tag_name);
CREATE INDEX idx_tags_source ON tags(source);

CREATE INDEX idx_audio_content_id ON audio_metadata(content_id);
CREATE INDEX idx_audio_fingerprint ON audio_metadata USING ivfflat (audio_fingerprint vector_cosine_ops);
CREATE INDEX idx_audio_duplicate ON audio_metadata(is_duplicate_of);

CREATE INDEX idx_video_content_id ON video_metadata(content_id);
CREATE INDEX idx_video_fingerprint ON video_metadata USING ivfflat (video_fingerprint vector_cosine_ops);
CREATE INDEX idx_video_duplicate ON video_metadata(is_duplicate_of);

CREATE INDEX idx_youtube_content_id ON youtube_metadata(content_id);
CREATE INDEX idx_youtube_video_id ON youtube_metadata(video_id);
CREATE INDEX idx_youtube_channel_id ON youtube_metadata(channel_id);

CREATE INDEX idx_website_content_id ON website_metadata(content_id);
CREATE INDEX idx_website_domain ON website_metadata(domain);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to automatically update updated_at
CREATE TRIGGER update_content_updated_at BEFORE UPDATE ON content
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();