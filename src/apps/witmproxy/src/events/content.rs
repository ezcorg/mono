use anyhow::Result;
use bytes::Bytes;
use http_body_util::BodyExt;
use http_body_util::combinators::UnsyncBoxBody;
use hyper::Response;
use salvo::http::response::Parts;
use wasmtime::{Store, component::Resource};
use wasmtime_wasi_http::p3::Response as WasiResponse;

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
/// [`InboundContent`] is a wrapper around a WASI HTTP [`Response`]
/// that provides a convenient interface for accessing and modifying
/// the content of the response (without worrying about any encoding or decoding).
///
/// It supports decompressing the body based on the received `Content-Encoding` header,
/// and will compress the body when converting back to a WASI HTTP `Response`.
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

    fn compress(
        parts: &Parts,
        body: UnsyncBoxBody<Bytes, ErrorCode>,
    ) -> Result<UnsyncBoxBody<Bytes, ErrorCode>> {
        use async_compression::futures::bufread::{
            BrotliEncoder, DeflateEncoder, GzipEncoder, ZstdEncoder,
        };
        use futures::TryStreamExt;
        use futures::io::BufReader;
        use http_body_util::StreamBody;

        let encoding = parts.encoding();

        match encoding {
            ContentEncoding::None => Ok(body),
            ContentEncoding::Unknown => {
                anyhow::bail!("Unsupported content encoding")
            }
            _ => {
                // Convert body to a stream of Result<Bytes, ErrorCode>
                let stream = http_body_util::BodyStream::new(body);

                // Convert to a futures::io::AsyncRead
                let async_read = stream
                    .map_ok(|frame| frame.into_data().unwrap_or_else(|_| Bytes::new()))
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
                    .into_async_read();

                let buf_reader = BufReader::new(async_read);

                // Apply the appropriate encoder
                let encoded: Box<dyn futures::io::AsyncRead + Send + Unpin> = match encoding {
                    ContentEncoding::Gzip => Box::new(GzipEncoder::new(buf_reader)),
                    ContentEncoding::Deflate => Box::new(DeflateEncoder::new(buf_reader)),
                    ContentEncoding::Br => Box::new(BrotliEncoder::new(buf_reader)),
                    ContentEncoding::Zstd => Box::new(ZstdEncoder::new(buf_reader)),
                    _ => unreachable!(),
                };

                // Convert AsyncRead back to a stream of Bytes
                use tokio_util::io::ReaderStream;

                // Convert futures::io::AsyncRead to tokio::io::AsyncRead
                let tokio_compat = tokio_util::compat::FuturesAsyncReadCompatExt::compat(encoded);
                let byte_stream = ReaderStream::new(tokio_compat);

                // Convert to http_body stream
                let frame_stream = byte_stream.map_ok(|bytes| http_body::Frame::data(bytes));
                let encoded_body =
                    http_body_util::BodyExt::map_err(StreamBody::new(frame_stream), |e| {
                        ErrorCode::InternalError(Some(format!("Compression error: {}", e)))
                    })
                    .boxed_unsync();
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
        use async_compression::futures::bufread::{
            BrotliDecoder, DeflateDecoder, GzipDecoder, ZstdDecoder,
        };
        use futures::TryStreamExt;
        use futures::io::BufReader;
        use http_body_util::StreamBody;

        let encoding = parts.encoding();

        match encoding {
            ContentEncoding::None => Ok(body),
            ContentEncoding::Unknown => {
                anyhow::bail!("Unsupported content encoding")
            }
            _ => {
                // Convert body to a stream of Result<Bytes, ErrorCode>
                let stream = http_body_util::BodyStream::new(body);

                // Convert to a futures::io::AsyncRead
                let async_read = stream
                    .map_ok(|frame| frame.into_data().unwrap_or_else(|_| Bytes::new()))
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
                    .into_async_read();

                let buf_reader = BufReader::new(async_read);

                // Apply the appropriate decoder
                let decoded: Box<dyn futures::io::AsyncRead + Send + Unpin> = match encoding {
                    ContentEncoding::Gzip => Box::new(GzipDecoder::new(buf_reader)),
                    ContentEncoding::Deflate => Box::new(DeflateDecoder::new(buf_reader)),
                    ContentEncoding::Br => Box::new(BrotliDecoder::new(buf_reader)),
                    ContentEncoding::Zstd => Box::new(ZstdDecoder::new(buf_reader)),
                    _ => unreachable!(),
                };

                // Convert AsyncRead back to a stream of Bytes
                use tokio_util::io::ReaderStream;

                // Convert futures::io::AsyncRead to tokio::io::AsyncRead
                let tokio_compat = tokio_util::compat::FuturesAsyncReadCompatExt::compat(decoded);
                let byte_stream = ReaderStream::new(tokio_compat);

                // Convert to http_body stream
                let frame_stream = byte_stream.map_ok(|bytes| http_body::Frame::data(bytes));
                let decoded_body =
                    http_body_util::BodyExt::map_err(StreamBody::new(frame_stream), |e| {
                        ErrorCode::InternalError(Some(format!("Decompression error: {}", e)))
                    })
                    .boxed_unsync();

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

    pub async fn into_full_response(self) -> Result<hyper::Response<http_body_util::Full<Bytes>>> {
        use http_body_util::BodyExt;

        // Build the HTTP response using the parts
        // If data was taken, provide an empty body
        let start = std::time::Instant::now();
        let body = self.body.unwrap_or_else(|| {
            use http_body_util::Empty;
            Empty::<Bytes>::new()
                .map_err(|_| ErrorCode::InternalError(Some("empty body".to_string())))
                .boxed_unsync()
        });
        tracing::debug!("Body unwrap took {:?}", start.elapsed());

        let start_compress = std::time::Instant::now();
        let body = InboundContent::compress(&self.parts, body)?;
        tracing::debug!("Compression setup took {:?}", start_compress.elapsed());

        // Collect the body
        tracing::debug!("Starting body collection...");
        let start_collect = std::time::Instant::now();
        let collected = body
            .collect()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to collect body: {:?}", e))?;
        tracing::debug!("Body collection took {:?}", start_collect.elapsed(),);

        // Remove content-length header since the body may have been modified
        let mut parts = self.parts;
        parts.headers.remove(hyper::header::CONTENT_LENGTH);

        let bytes = collected.to_bytes();
        tracing::debug!(
            "Total bytes in final body: {}, total processing took {:?}",
            bytes.len(),
            start.elapsed()
        );
        let full_body = http_body_util::Full::new(bytes);
        let response = Response::from_parts(parts, full_body);

        Ok(response)
    }

    pub fn into_wasi(
        self,
    ) -> Result<(
        WasiResponse,
        impl futures::Future<Output = Result<(), ErrorCode>> + Send,
    )> {
        // Build the HTTP response using the parts
        // If data was taken, provide an empty body
        let body = self.body.unwrap_or_else(|| {
            use http_body_util::Empty;
            Empty::<Bytes>::new()
                .map_err(|_| ErrorCode::InternalError(Some("empty body".to_string())))
                .boxed_unsync()
        });
        let body = InboundContent::compress(&self.parts, body)?;

        // Remove content-length header since the body may have been modified
        // and we're using chunked transfer encoding for the streaming body
        let mut parts = self.parts;
        parts.headers.remove(hyper::header::CONTENT_LENGTH);

        let response = Response::from_parts(parts, body);

        // Convert to WASI HTTP Response
        let (wasi_response, io_future) = WasiResponse::from_http(response);

        Ok((wasi_response, io_future))
    }
}
