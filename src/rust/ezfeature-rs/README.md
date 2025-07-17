# EzFeature-RS

A comprehensive feature extraction pipeline for various content types including text, websites, audio, video, and YouTube content with PostgreSQL storage and vector similarity search capabilities.

## Features

### Content Type Support
- **Text**: Language detection, sentiment analysis, named entity recognition, keyword extraction, and embedding generation
- **Websites**: HTML parsing, JavaScript execution, media detection, metadata extraction, and content analysis
- **Audio**: Metadata extraction, spectral/temporal feature analysis, duplicate detection, and quality scoring
- **Video**: Keyframe extraction, scene detection, audio extraction, and duplicate detection via fingerprinting
- **YouTube**: Video download, transcript extraction, comment analysis, engagement metrics, and comprehensive metadata

### Core Capabilities
- **Vector Embeddings**: Generate and store high-dimensional embeddings for similarity search
- **Duplicate Detection**: Content fingerprinting and hash-based deduplication
- **Quality Scoring**: Automated quality assessment for all content types
- **Content Filtering**: Intelligent filtering based on quality, sentiment, and content analysis
- **PostgreSQL Storage**: Robust storage with pgvector extension for vector operations
- **RESTful API**: Complete HTTP API for all extraction operations

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Text Pipeline │    │ Website Pipeline│    │  Audio Pipeline │
│                 │    │                 │    │                 │
│ • Language Det. │    │ • HTML Parsing  │    │ • Metadata Ext. │
│ • Sentiment     │    │ • JS Execution  │    │ • Spectral Feat.│
│ • NER           │    │ • Media Extract │    │ • Fingerprinting│
│ • Embeddings    │    │ • Content Anal. │    │ • Quality Score │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
┌─────────────────┐    ┌─────────▼─────────┐    ┌─────────────────┐
│  Video Pipeline │    │   Core Engine     │    │YouTube Pipeline │
│                 │    │                   │    │                 │
│ • Keyframe Ext. │    │ • Feature Store   │    │ • Video Download│
│ • Scene Detect  │    │ • Vector Search   │    │ • Transcript    │
│ • Audio Extract │    │ • Deduplication   │    │ • Comments      │
│ • Fingerprinting│    │ • Content Filter  │    │ • Engagement    │
└─────────────────┘    └───────────────────┘    └─────────────────┘
                                 │
                    ┌─────────────▼─────────────┐
                    │     PostgreSQL + Vector   │
                    │                           │
                    │ • Content Storage         │
                    │ • Feature Embeddings     │
                    │ • Metadata & Tags        │
                    │ • Similarity Search      │
                    └───────────────────────────┘
```

## Quick Start

### Prerequisites

- Rust 1.75+
- Docker and Docker Compose
- FFmpeg (for audio/video processing)
- yt-dlp (for YouTube downloads)
- Chrome/Chromium (for website JavaScript execution)

### Environment Variables

Create a `.env` file:

```bash
# Database
DATABASE_URL=postgresql://ezfeature_user:ezfeature_password@localhost:5432/ezfeature

# API Keys
OPENAI_API_KEY=your_openai_api_key_here
YOUTUBE_API_KEY=your_youtube_api_key_here

# Configuration
ENABLE_JAVASCRIPT=true
MAX_CONTENT_SIZE_MB=100
EMBEDDING_MODEL=text-embedding-3-small
DUPLICATE_THRESHOLD=0.95
RUST_LOG=info
```

### Running with Docker Compose

```bash
# Clone and navigate to the project
cd src/rust/ezfeature-rs

# Start all services
docker-compose up -d

# Check service health
docker-compose ps

# View logs
docker-compose logs -f ezfeature-app
```

### Running Locally

```bash
# Install dependencies
cargo build

# Run database migrations
sqlx migrate run

# Start the service
cargo run
```

## API Usage

### Text Extraction

```bash
curl -X POST http://localhost:8080/extract/text \
  -H "Content-Type: application/json" \
  -d '{
    "content": "This is a sample text for analysis.",
    "metadata": {"source": "user_input"}
  }'
```

### Website Extraction

```bash
curl -X POST http://localhost:8080/extract/website \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "metadata": {"crawl_depth": 1}
  }'
```

### Audio Extraction

```bash
curl -X POST http://localhost:8080/extract/audio \
  -H "Content-Type: application/octet-stream" \
  --data-binary @audio_file.mp3
```

### Video Extraction

```bash
curl -X POST http://localhost:8080/extract/video \
  -H "Content-Type: application/octet-stream" \
  --data-binary @video_file.mp4
```

### YouTube Extraction

```bash
curl -X POST http://localhost:8080/extract/youtube \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "metadata": {"include_comments": true}
  }'
```

### Similarity Search

```bash
curl "http://localhost:8080/similar/{content_id}?threshold=0.8&limit=10"
```

## Database Schema

The system uses PostgreSQL with the pgvector extension for efficient vector operations:

### Core Tables
- `content`: Main content storage with metadata and hashes
- `features`: Extracted features with vector embeddings
- `tags`: Categorical features and labels
- `*_metadata`: Type-specific metadata tables

### Vector Operations
- Cosine similarity search using pgvector
- Efficient indexing with IVFFlat
- Configurable similarity thresholds

## Configuration

### Feature Extraction Config

```rust
FeatureExtractionConfig {
    database_url: String,
    openai_api_key: Option<String>,
    youtube_api_key: Option<String>,
    enable_javascript: bool,
    max_content_size_mb: usize,
    embedding_model: String,
    duplicate_threshold: f32,
}
```

### Content Filtering

The system includes intelligent content filtering based on:
- Quality scores (resolution, bitrate, etc.)
- Content analysis (sentiment, appropriateness)
- Duplicate detection via fingerprinting
- Size and duration limits

## Development

### Project Structure

```
src/rust/ezfeature-rs/
├── src/
│   ├── lib.rs              # Main library interface
│   ├── main.rs             # Web server and CLI
│   ├── types.rs            # Core data structures
│   ├── error.rs            # Error handling
│   ├── database.rs         # Database operations
│   ├── text.rs             # Text feature extraction
│   ├── website.rs          # Website feature extraction
│   ├── audio.rs            # Audio feature extraction
│   ├── video.rs            # Video feature extraction
│   └── youtube.rs          # YouTube feature extraction
├── migrations/             # Database migrations
├── docker-compose.yml      # Docker services
├── Dockerfile             # Application container
└── README.md              # This file
```

### Adding New Extractors

1. Implement the `ContentExtractor` trait:

```rust
#[async_trait]
impl ContentExtractor for MyExtractor {
    type Input = MyInput;
    type Output = MyFeatures;

    async fn extract_features(&self, input: Self::Input, config: &FeatureExtractionConfig) -> Result<Self::Output>;
    async fn should_filter(&self, features: &Self::Output, config: &FeatureExtractionConfig) -> Result<bool>;
}
```

2. Add database storage methods
3. Update the main processing pipeline
4. Add API endpoints

### Testing

```bash
# Run all tests
cargo test

# Run specific test module
cargo test text::tests

# Run with logging
RUST_LOG=debug cargo test
```

## Monitoring and Observability

The Docker Compose setup includes:

- **Prometheus**: Metrics collection
- **Grafana**: Visualization dashboards
- **Elasticsearch + Kibana**: Log analysis
- **Health checks**: Service monitoring

Access the monitoring interfaces:
- Grafana: http://localhost:3000 (admin/admin)
- Prometheus: http://localhost:9090
- Kibana: http://localhost:5601

## Performance Considerations

### Optimization Tips

1. **Batch Processing**: Process multiple items together
2. **Caching**: Use Redis for frequently accessed data
3. **Async Processing**: Leverage Tokio for concurrent operations
4. **Vector Indexing**: Tune pgvector index parameters
5. **Content Limits**: Set appropriate size limits for media

### Scaling

- **Horizontal**: Run multiple worker instances
- **Database**: Use read replicas for queries
- **Storage**: Consider object storage for large media files
- **Caching**: Implement multi-level caching strategies

## Security

- API key management via environment variables
- Input validation and sanitization
- Content size limits to prevent DoS
- Database connection pooling with limits
- Container security best practices

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Troubleshooting

### Common Issues

**Database Connection Errors**
```bash
# Check if PostgreSQL is running
docker-compose ps postgres

# View database logs
docker-compose logs postgres
```

**FFmpeg Not Found**
```bash
# Install FFmpeg
sudo apt-get install ffmpeg  # Ubuntu/Debian
brew install ffmpeg          # macOS
```

**YouTube Download Failures**
```bash
# Update yt-dlp
pip install --upgrade yt-dlp
```

**Memory Issues**
- Reduce `MAX_CONTENT_SIZE_MB`
- Increase Docker memory limits
- Monitor with `docker stats`

### Performance Tuning

**Database Optimization**
```sql
-- Tune vector index
SET ivfflat.probes = 10;

-- Analyze query performance
EXPLAIN ANALYZE SELECT ...;
```

**Application Tuning**
- Adjust worker thread counts
- Tune connection pool sizes
- Monitor with Prometheus metrics

For more help, check the issues section or create a new issue with detailed information about your problem.