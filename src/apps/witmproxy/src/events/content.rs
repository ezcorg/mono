use anyhow::Result;
use bytes::Bytes;
use http_body_util::BodyExt;
use http_body_util::combinators::UnsyncBoxBody;
use hyper::Response;
use salvo::http::response::Parts;
use wasmtime::{Store, component::Resource};
use wasmtime_wasi::runtime::with_ambient_tokio_runtime;

use crate::http::utils::ContentEncoding;
use crate::http::utils::Encoded;
use crate::{
    events::Event,
    plugins::cel::CelContent,
    wasm::{
        Host,
        bindgen::{
            Event as WasmEvent,
            witmproxy::plugin::capabilities::{CapabilityKind, EventKind},
        },
    },
};
use wasmtime_wasi_http::p3::bindings::http::types::ErrorCode;

pub struct InboundContent {
    parts: Parts,
    content_type: String,
    body: Option<UnsyncBoxBody<Bytes, ErrorCode>>,
}

impl Event for InboundContent {
    fn capability(&self) -> CapabilityKind {
        CapabilityKind::HandleEvent(EventKind::InboundContent)
    }

    fn into_event_data(self: Box<Self>, store: &mut Store<Host>) -> Result<WasmEvent> {
        let handle: Resource<InboundContent> = store.data_mut().table.push(*self)?;
        Ok(WasmEvent::InboundContent(handle))
    }

    fn register_cel_env<'a>(env: cel_cxx::EnvBuilder<'a>) -> Result<cel_cxx::EnvBuilder<'a>>
    where
        Self: Sized,
    {
        let env = env
            .declare_variable::<CelContent>("content")?
            .register_member_function("content_type", CelContent::content_type)?;
        Ok(env)
    }

    fn bind_cel_activation<'a>(
        &'a self,
        activation: cel_cxx::Activation<'a>,
    ) -> Option<cel_cxx::Activation<'a>> {
        activation
            .bind_variable("content", CelContent::from(self))
            .ok()
    }
}

// TODO: InboundContent is currently only used for responses, but could easily be made generic
// over any bundle of bytes with a content-type and encoding. Consider refactoring.
/// [`InboundContent`] is a wrapper around an HTTP [`Response`]
/// that provides a convenient interface for accessing and modifying
/// the content of the response (without worrying about any encoding or decoding).
///
/// It supports decompressing the body based on the received `Content-Encoding` header,
/// and will compress the body when converting back to an HTTP `Response`.
impl InboundContent {
    pub fn new(
        parts: Parts,
        content_type: String,
        body: UnsyncBoxBody<Bytes, ErrorCode>,
    ) -> Result<Self> {
        let body = InboundContent::decompress(&parts, body)?;

        Ok(Self {
            parts,
            content_type,
            body: Some(body),
        })
    }

    #[cfg(test)]
    fn compress(
        parts: &Parts,
        body: UnsyncBoxBody<Bytes, ErrorCode>,
    ) -> Result<UnsyncBoxBody<Bytes, ErrorCode>> {
        use async_compression::tokio::bufread::{
            BrotliEncoder, DeflateEncoder, GzipEncoder, ZstdEncoder,
        };
        use futures::TryStreamExt;
        use http_body_util::StreamBody;
        use tokio::io::BufReader;
        use tokio_util::io::{ReaderStream, StreamReader};

        let encoding = parts.encoding();

        match encoding {
            ContentEncoding::None => Ok(body),
            ContentEncoding::Unknown => {
                anyhow::bail!("Unsupported content encoding")
            }
            _ => {
                let encoded_body = with_ambient_tokio_runtime(|| {
                    // Convert body to a stream of Result<Bytes, ErrorCode>
                    let stream = http_body_util::BodyStream::new(body);

                    // Convert to a stream of Result<Bytes, std::io::Error> for StreamReader
                    let byte_stream = stream
                        .map_ok(|frame| frame.into_data().unwrap_or_else(|_| Bytes::new()))
                        .map_err(std::io::Error::other);

                    // Convert to a tokio::io::AsyncRead using StreamReader
                    let async_read = StreamReader::new(byte_stream);
                    let buf_reader = BufReader::new(async_read);

                    // Apply the appropriate encoder
                    let encoded: Box<dyn tokio::io::AsyncRead + Send + Unpin> = match encoding {
                        ContentEncoding::Gzip => Box::new(GzipEncoder::new(buf_reader)),
                        ContentEncoding::Deflate => Box::new(DeflateEncoder::new(buf_reader)),
                        ContentEncoding::Br => Box::new(BrotliEncoder::new(buf_reader)),
                        ContentEncoding::Zstd => Box::new(ZstdEncoder::new(buf_reader)),
                        _ => unreachable!(),
                    };

                    // Convert AsyncRead back to a stream of Bytes
                    let byte_stream = ReaderStream::new(encoded);

                    // Convert to http_body stream
                    let frame_stream = byte_stream.map_ok(http_body::Frame::data);
                    http_body_util::BodyExt::map_err(StreamBody::new(frame_stream), |e| {
                        ErrorCode::InternalError(Some(format!("Compression error: {}", e)))
                    })
                    .boxed_unsync()
                });
                Ok(encoded_body)
            }
        }
    }

    /// Uses appropriate streaming decompression to decompress the `Body` based on the `Content-Encoding` header.
    ///
    /// No-ops if there is no encoding.
    ///
    /// Returns an error if the encoding is unsupported.
    fn decompress(
        parts: &Parts,
        body: UnsyncBoxBody<Bytes, ErrorCode>,
    ) -> Result<UnsyncBoxBody<Bytes, ErrorCode>> {
        use async_compression::tokio::bufread::{
            BrotliDecoder, DeflateDecoder, GzipDecoder, ZstdDecoder,
        };
        use futures::TryStreamExt;
        use http_body_util::StreamBody;
        use tokio::io::BufReader;
        use tokio_util::io::{ReaderStream, StreamReader};

        let encoding = parts.encoding();

        match encoding {
            ContentEncoding::None => Ok(body),
            ContentEncoding::Unknown => {
                anyhow::bail!("Unsupported content encoding")
            }
            _ => {
                let decoded_body = with_ambient_tokio_runtime(|| {
                    // Convert body to a stream of Result<Bytes, ErrorCode>
                    let stream = http_body_util::BodyStream::new(body);

                    // Convert to a stream of Result<Bytes, std::io::Error> for StreamReader
                    let byte_stream = stream
                        .map_ok(|frame| frame.into_data().unwrap_or_else(|_| Bytes::new()))
                        .map_err(std::io::Error::other);

                    // Convert to a tokio::io::AsyncRead using StreamReader
                    let async_read = StreamReader::new(byte_stream);
                    let buf_reader = BufReader::new(async_read);

                    // Apply the appropriate decoder
                    let decoded: Box<dyn tokio::io::AsyncRead + Send + Unpin> = match encoding {
                        ContentEncoding::Gzip => Box::new(GzipDecoder::new(buf_reader)),
                        ContentEncoding::Deflate => Box::new(DeflateDecoder::new(buf_reader)),
                        ContentEncoding::Br => Box::new(BrotliDecoder::new(buf_reader)),
                        ContentEncoding::Zstd => Box::new(ZstdDecoder::new(buf_reader)),
                        _ => unreachable!(),
                    };

                    // Convert AsyncRead back to a stream of Bytes
                    let byte_stream = ReaderStream::new(decoded);

                    // Convert to http_body stream
                    let frame_stream = byte_stream.map_ok(http_body::Frame::data);
                    http_body_util::BodyExt::map_err(StreamBody::new(frame_stream), |e| {
                        ErrorCode::InternalError(Some(format!("Decompression error: {}", e)))
                    })
                    .boxed_unsync()
                });

                Ok(decoded_body)
            }
        }
    }

    pub fn content_type(&self) -> String {
        self.content_type.clone()
    }

    pub fn body(&mut self) -> Result<Option<UnsyncBoxBody<Bytes, ErrorCode>>> {
        Ok(self.body.take())
    }

    pub fn set_body(&mut self, content: UnsyncBoxBody<Bytes, ErrorCode>) {
        self.body = Some(content);
    }

    pub fn into_response(self) -> Result<Response<UnsyncBoxBody<Bytes, ErrorCode>>> {
        // Build the HTTP response using the parts
        // If data was taken, provide an empty body
        let body = self.body.unwrap_or_else(|| {
            use http_body_util::Empty;
            Empty::<Bytes>::new()
                .map_err(|_| ErrorCode::InternalError(Some("empty body".to_string())))
                .boxed_unsync()
        });
        // TODO: instrument/investigate why this is so expensive in certain cases
        // let body = InboundContent::compress(&self.parts, body)?;

        let mut parts = self.parts;
        // Content length is no longer valid after decompression/modification
        parts.headers.remove(hyper::header::CONTENT_LENGTH);
        // Remove content-encoding as we have decompressed the body
        parts.headers.remove(hyper::header::CONTENT_ENCODING);
        Ok(Response::from_parts(parts, body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use http_body_util::{BodyExt, Full};
    use hyper::header::CONTENT_ENCODING;
    use salvo::http::response::Parts;

    /// Helper function to create Parts with a specific Content-Encoding header
    fn create_parts_with_encoding(encoding: &str) -> Parts {
        let mut response = hyper::Response::new(());
        if !encoding.is_empty() {
            response
                .headers_mut()
                .insert(CONTENT_ENCODING, encoding.parse().unwrap());
        }
        let (parts, _) = response.into_parts();
        parts
    }

    /// Helper to create a body from bytes
    fn create_body(data: &[u8]) -> UnsyncBoxBody<Bytes, ErrorCode> {
        Full::new(Bytes::copy_from_slice(data))
            .map_err(|_| ErrorCode::InternalError(Some("body error".to_string())))
            .boxed_unsync()
    }

    /// Helper to read all bytes from a body
    async fn body_to_bytes(body: UnsyncBoxBody<Bytes, ErrorCode>) -> Vec<u8> {
        let collected = body.collect().await.expect("Failed to collect body");
        collected.to_bytes().to_vec()
    }

    /// Test data - simple HTML string
    const TEST_HTML: &str = r#"<!DOCTYPE html>
<html>
<head>
    <title>Test Page</title>
    <meta charset="UTF-8">
</head>
<body>
    <h1>Hello, World!</h1>
    <p>This is a test HTML page with various characters: ñ, é, ü, 中文, 日本語, 한글</p>
    <div>Some more content to make it larger...</div>
</body>
</html>"#;

    /// Test data - large HTML string
    fn large_html() -> String {
        let mut html = String::from(TEST_HTML);
        // Repeat content to make it large enough to test chunking behavior
        for i in 0..100 {
            html.push_str(&format!(
                "<p>Repeated paragraph number {} with UTF-8: ñ é ü 中文 日本語 한글</p>\n",
                i
            ));
        }
        html
    }

    #[tokio::test]
    async fn test_compress_decompress_gzip_roundtrip() {
        let parts = create_parts_with_encoding("gzip");
        let original_data = TEST_HTML.as_bytes();
        let body = create_body(original_data);

        // Compress
        let compressed =
            InboundContent::compress(&parts, body).expect("Compression should succeed");

        // Decompress
        let decompressed =
            InboundContent::decompress(&parts, compressed).expect("Decompression should succeed");

        // Verify
        let result = body_to_bytes(decompressed).await;
        assert_eq!(result, original_data, "Gzip round-trip failed");
    }

    #[tokio::test]
    async fn test_compress_decompress_deflate_roundtrip() {
        let parts = create_parts_with_encoding("deflate");
        let original_data = TEST_HTML.as_bytes();
        let body = create_body(original_data);

        // Compress
        let compressed =
            InboundContent::compress(&parts, body).expect("Compression should succeed");

        // Decompress
        let decompressed =
            InboundContent::decompress(&parts, compressed).expect("Decompression should succeed");

        // Verify
        let result = body_to_bytes(decompressed).await;
        assert_eq!(result, original_data, "Deflate round-trip failed");
    }

    #[tokio::test]
    async fn test_compress_decompress_brotli_roundtrip() {
        let parts = create_parts_with_encoding("br");
        let original_data = TEST_HTML.as_bytes();
        let body = create_body(original_data);

        // Compress
        let compressed =
            InboundContent::compress(&parts, body).expect("Compression should succeed");

        // Decompress
        let decompressed =
            InboundContent::decompress(&parts, compressed).expect("Decompression should succeed");

        // Verify
        let result = body_to_bytes(decompressed).await;
        assert_eq!(result, original_data, "Brotli round-trip failed");
    }

    #[tokio::test]
    async fn test_compress_decompress_zstd_roundtrip() {
        let parts = create_parts_with_encoding("zstd");
        let original_data = TEST_HTML.as_bytes();
        let body = create_body(original_data);

        // Compress
        let compressed =
            InboundContent::compress(&parts, body).expect("Compression should succeed");

        // Decompress
        let decompressed =
            InboundContent::decompress(&parts, compressed).expect("Decompression should succeed");

        // Verify
        let result = body_to_bytes(decompressed).await;
        assert_eq!(result, original_data, "Zstd round-trip failed");
    }

    #[tokio::test]
    async fn test_compress_decompress_large_html_gzip() {
        let parts = create_parts_with_encoding("gzip");
        let original_data = large_html();
        let body = create_body(original_data.as_bytes());

        // Compress
        let compressed =
            InboundContent::compress(&parts, body).expect("Compression should succeed");

        // Decompress
        let decompressed =
            InboundContent::decompress(&parts, compressed).expect("Decompression should succeed");

        // Verify
        let result = body_to_bytes(decompressed).await;
        assert_eq!(
            result,
            original_data.as_bytes(),
            "Large HTML gzip round-trip failed"
        );
    }

    #[tokio::test]
    async fn test_compress_decompress_large_html_deflate() {
        let parts = create_parts_with_encoding("deflate");
        let original_data = large_html();
        let body = create_body(original_data.as_bytes());

        // Compress
        let compressed =
            InboundContent::compress(&parts, body).expect("Compression should succeed");

        // Decompress
        let decompressed =
            InboundContent::decompress(&parts, compressed).expect("Decompression should succeed");

        // Verify
        let result = body_to_bytes(decompressed).await;
        assert_eq!(
            result,
            original_data.as_bytes(),
            "Large HTML deflate round-trip failed"
        );
    }

    #[tokio::test]
    async fn test_compress_decompress_large_html_brotli() {
        let parts = create_parts_with_encoding("br");
        let original_data = large_html();
        let body = create_body(original_data.as_bytes());

        // Compress
        let compressed =
            InboundContent::compress(&parts, body).expect("Compression should succeed");

        // Decompress
        let decompressed =
            InboundContent::decompress(&parts, compressed).expect("Decompression should succeed");

        // Verify
        let result = body_to_bytes(decompressed).await;
        assert_eq!(
            result,
            original_data.as_bytes(),
            "Large HTML brotli round-trip failed"
        );
    }

    #[tokio::test]
    async fn test_compress_decompress_large_html_zstd() {
        let parts = create_parts_with_encoding("zstd");
        let original_data = large_html();
        let body = create_body(original_data.as_bytes());

        // Compress
        let compressed =
            InboundContent::compress(&parts, body).expect("Compression should succeed");

        // Decompress
        let decompressed =
            InboundContent::decompress(&parts, compressed).expect("Decompression should succeed");

        // Verify
        let result = body_to_bytes(decompressed).await;
        assert_eq!(
            result,
            original_data.as_bytes(),
            "Large HTML zstd round-trip failed"
        );
    }

    #[tokio::test]
    async fn test_no_encoding_passthrough() {
        let parts = create_parts_with_encoding("");
        let original_data = TEST_HTML.as_bytes();
        let body = create_body(original_data);

        // Should pass through without modification
        let result_body =
            InboundContent::decompress(&parts, body).expect("Decompression should succeed");

        let result = body_to_bytes(result_body).await;
        assert_eq!(result, original_data, "No encoding should pass through");
    }

    #[tokio::test]
    async fn test_identity_encoding_passthrough() {
        let parts = create_parts_with_encoding("identity");
        let original_data = TEST_HTML.as_bytes();
        let body = create_body(original_data);

        // Should pass through without modification
        let result_body =
            InboundContent::decompress(&parts, body).expect("Decompression should succeed");

        let result = body_to_bytes(result_body).await;
        assert_eq!(
            result, original_data,
            "Identity encoding should pass through"
        );
    }

    #[tokio::test]
    async fn test_unknown_encoding_error() {
        let parts = create_parts_with_encoding("unsupported-encoding");
        let body = create_body(TEST_HTML.as_bytes());

        // Should return an error
        let result = InboundContent::decompress(&parts, body);
        assert!(result.is_err(), "Unknown encoding should return error");
        assert!(
            result.unwrap_err().to_string().contains("Unsupported"),
            "Error message should mention unsupported encoding"
        );
    }

    #[tokio::test]
    async fn test_empty_body_gzip() {
        let parts = create_parts_with_encoding("gzip");
        let body = create_body(&[]);

        // Compress
        let compressed =
            InboundContent::compress(&parts, body).expect("Compression should succeed");

        // Decompress
        let decompressed =
            InboundContent::decompress(&parts, compressed).expect("Decompression should succeed");

        // Verify
        let result = body_to_bytes(decompressed).await;
        assert!(result.is_empty(), "Empty body gzip round-trip failed");
    }

    #[tokio::test]
    async fn test_utf8_content_preservation_gzip() {
        let parts = create_parts_with_encoding("gzip");
        let utf8_content = "UTF-8 content: ñ, é, ü, 中文, 日本語, 한글, emoji: 🚀🌟💻";
        let body = create_body(utf8_content.as_bytes());

        // Compress
        let compressed =
            InboundContent::compress(&parts, body).expect("Compression should succeed");

        // Decompress
        let decompressed =
            InboundContent::decompress(&parts, compressed).expect("Decompression should succeed");

        // Verify
        let result = body_to_bytes(decompressed).await;
        let result_str = String::from_utf8(result).expect("Should be valid UTF-8");
        assert_eq!(
            result_str, utf8_content,
            "UTF-8 content should be preserved"
        );
    }

    #[tokio::test]
    async fn test_utf8_content_preservation_deflate() {
        let parts = create_parts_with_encoding("deflate");
        let utf8_content = "UTF-8 content: ñ, é, ü, 中文, 日本語, 한글, emoji: 🚀🌟💻";
        let body = create_body(utf8_content.as_bytes());

        // Compress
        let compressed =
            InboundContent::compress(&parts, body).expect("Compression should succeed");

        // Decompress
        let decompressed =
            InboundContent::decompress(&parts, compressed).expect("Decompression should succeed");

        // Verify
        let result = body_to_bytes(decompressed).await;
        let result_str = String::from_utf8(result).expect("Should be valid UTF-8");
        assert_eq!(
            result_str, utf8_content,
            "UTF-8 content should be preserved"
        );
    }

    #[tokio::test]
    async fn test_utf8_content_preservation_brotli() {
        let parts = create_parts_with_encoding("br");
        let utf8_content = "UTF-8 content: ñ, é, ü, 中文, 日本語, 한글, emoji: 🚀🌟💻";
        let body = create_body(utf8_content.as_bytes());

        // Compress
        let compressed =
            InboundContent::compress(&parts, body).expect("Compression should succeed");

        // Decompress
        let decompressed =
            InboundContent::decompress(&parts, compressed).expect("Decompression should succeed");

        // Verify
        let result = body_to_bytes(decompressed).await;
        let result_str = String::from_utf8(result).expect("Should be valid UTF-8");
        assert_eq!(
            result_str, utf8_content,
            "UTF-8 content should be preserved"
        );
    }

    #[tokio::test]
    async fn test_utf8_content_preservation_zstd() {
        let parts = create_parts_with_encoding("zstd");
        let utf8_content = "UTF-8 content: ñ, é, ü, 中文, 日本語, 한글, emoji: 🚀🌟💻";
        let body = create_body(utf8_content.as_bytes());

        // Compress
        let compressed =
            InboundContent::compress(&parts, body).expect("Compression should succeed");

        // Decompress
        let decompressed =
            InboundContent::decompress(&parts, compressed).expect("Decompression should succeed");

        // Verify
        let result = body_to_bytes(decompressed).await;
        let result_str = String::from_utf8(result).expect("Should be valid UTF-8");
        assert_eq!(
            result_str, utf8_content,
            "UTF-8 content should be preserved"
        );
    }

    // TODO: fix/remove, commented out as we no longer re-compress on into_response()
    // #[tokio::test]
    // async fn test_inbound_content_full_lifecycle_gzip() {
    //     // Test the full lifecycle: new() -> decompress, then into_response() -> compress
    //     let mut response = hyper::Response::new(());
    //     response
    //         .headers_mut()
    //         .insert(CONTENT_ENCODING, "gzip".parse().unwrap());
    //     response
    //         .headers_mut()
    //         .insert(hyper::header::CONTENT_TYPE, "text/html".parse().unwrap());

    //     let (parts, _) = response.into_parts();
    //     let parts = Parts::from(parts);

    //     // First compress the HTML manually to simulate receiving compressed content
    //     let original_html = TEST_HTML;
    //     let manually_compressed = {
    //         use async_compression::tokio::bufread::GzipEncoder;
    //         use tokio::io::AsyncReadExt;
    //         let cursor = std::io::Cursor::new(original_html.as_bytes());
    //         let reader = tokio::io::BufReader::new(cursor);
    //         let mut encoder = GzipEncoder::new(reader);
    //         let mut compressed = Vec::new();
    //         encoder
    //             .read_to_end(&mut compressed)
    //             .await
    //             .expect("Manual compression failed");
    //         compressed
    //     };

    //     // Create InboundContent with the pre-compressed body (simulating receiving from server)
    //     let body = create_body(&manually_compressed);
    //     let mut content = InboundContent::new(parts, "text/html".to_string(), body)
    //         .expect("InboundContent::new should succeed");

    //     // Take the body (it should be decompressed)
    //     let decompressed_body = content
    //         .body()
    //         .expect("Should have body")
    //         .expect("Body should be Some");
    //     let decompressed_data = body_to_bytes(decompressed_body).await;
    //     assert_eq!(
    //         decompressed_data,
    //         original_html.as_bytes(),
    //         "InboundContent should decompress on new()"
    //     );

    //     // Set it back
    //     let body_again = create_body(&decompressed_data);
    //     content.set_body(body_again);

    //     // Convert back to response (should compress)
    //     let response = content
    //         .into_response()
    //         .expect("into_response should succeed");
    //     let (parts, body) = response.into_parts();

    //     // Check that content-encoding is still there
    //     assert_eq!(
    //         parts
    //             .headers
    //             .get(CONTENT_ENCODING)
    //             .map(|v| v.to_str().unwrap()),
    //         Some("gzip"),
    //         "Content-Encoding should be preserved"
    //     );

    //     // Decompress the final body
    //     let parts_for_decompress = Parts::from(parts);
    //     let decompressed_final = InboundContent::decompress(&parts_for_decompress, body)
    //         .expect("Final decompression should succeed");
    //     let final_data = body_to_bytes(decompressed_final).await;

    //     assert_eq!(
    //         final_data,
    //         original_html.as_bytes(),
    //         "Full lifecycle should preserve data"
    //     );
    // }

    #[tokio::test]
    async fn test_inbound_content_full_lifecycle_deflate() {
        let mut response = hyper::Response::new(());
        response
            .headers_mut()
            .insert(CONTENT_ENCODING, "deflate".parse().unwrap());
        response
            .headers_mut()
            .insert(hyper::header::CONTENT_TYPE, "text/html".parse().unwrap());

        let (parts, _) = response.into_parts();
        // parts already has the correct type

        // First compress the HTML manually to simulate receiving compressed content
        let original_html = TEST_HTML;
        let manually_compressed = {
            use async_compression::tokio::bufread::DeflateEncoder;
            use tokio::io::AsyncReadExt;
            let cursor = std::io::Cursor::new(original_html.as_bytes());
            let reader = tokio::io::BufReader::new(cursor);
            let mut encoder = DeflateEncoder::new(reader);
            let mut compressed = Vec::new();
            encoder
                .read_to_end(&mut compressed)
                .await
                .expect("Manual compression failed");
            compressed
        };

        let body = create_body(&manually_compressed);
        let mut content = InboundContent::new(parts, "text/html".to_string(), body)
            .expect("InboundContent::new should succeed");

        let decompressed_body = content
            .body()
            .expect("Should have body")
            .expect("Body should be Some");
        let decompressed_data = body_to_bytes(decompressed_body).await;
        assert_eq!(
            decompressed_data,
            original_html.as_bytes(),
            "InboundContent should decompress on new()"
        );

        let body_again = create_body(&decompressed_data);
        content.set_body(body_again);

        let response = content
            .into_response()
            .expect("into_response should succeed");
        let (parts, body) = response.into_parts();

        let parts_for_decompress = parts;
        let decompressed_final = InboundContent::decompress(&parts_for_decompress, body)
            .expect("Final decompression should succeed");
        let final_data = body_to_bytes(decompressed_final).await;

        assert_eq!(
            final_data,
            original_html.as_bytes(),
            "Full lifecycle should preserve data"
        );
    }

    #[tokio::test]
    async fn test_inbound_content_full_lifecycle_brotli() {
        let mut response = hyper::Response::new(());
        response
            .headers_mut()
            .insert(CONTENT_ENCODING, "br".parse().unwrap());
        response
            .headers_mut()
            .insert(hyper::header::CONTENT_TYPE, "text/html".parse().unwrap());

        let (parts, _) = response.into_parts();
        // parts already has the correct type

        let original_html = TEST_HTML;
        let manually_compressed = {
            use async_compression::tokio::bufread::BrotliEncoder;
            use tokio::io::AsyncReadExt;
            let cursor = std::io::Cursor::new(original_html.as_bytes());
            let reader = tokio::io::BufReader::new(cursor);
            let mut encoder = BrotliEncoder::new(reader);
            let mut compressed = Vec::new();
            encoder
                .read_to_end(&mut compressed)
                .await
                .expect("Manual compression failed");
            compressed
        };

        let body = create_body(&manually_compressed);
        let mut content = InboundContent::new(parts, "text/html".to_string(), body)
            .expect("InboundContent::new should succeed");

        let decompressed_body = content
            .body()
            .expect("Should have body")
            .expect("Body should be Some");
        let decompressed_data = body_to_bytes(decompressed_body).await;
        assert_eq!(
            decompressed_data,
            original_html.as_bytes(),
            "InboundContent should decompress on new()"
        );

        let body_again = create_body(&decompressed_data);
        content.set_body(body_again);

        let response = content
            .into_response()
            .expect("into_response should succeed");
        let (parts, body) = response.into_parts();

        let parts_for_decompress = parts;
        let decompressed_final = InboundContent::decompress(&parts_for_decompress, body)
            .expect("Final decompression should succeed");
        let final_data = body_to_bytes(decompressed_final).await;

        assert_eq!(
            final_data,
            original_html.as_bytes(),
            "Full lifecycle should preserve data"
        );
    }
}
