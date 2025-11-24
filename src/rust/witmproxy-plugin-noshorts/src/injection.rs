use crate::wasi::http::types::Headers;
use crate::{wit_stream};
use std::io::{Read, Write};
use anyhow::Result;
use flate2::bufread::{DeflateDecoder, GzDecoder};

pub const STYLES: &str = r#"
<style>
    a[href*="shorts"] {
        display: none !important;
    }

    [is-shorts="true"] {
        display: none !important;
    }
</style>
"#;


/// Check if content-type header indicates HTML
pub fn is_html_response(headers: &Headers) -> bool {
    let content_type_values = headers.get("content-type");
    content_type_values.iter().any(|value| {
        String::from_utf8_lossy(value).to_lowercase().contains("text/html")
    })
}

/// Check if response has content encoding (compression)
pub fn is_content_encoded(headers: &Headers) -> bool {
    let encoding_values = headers.get("content-encoding");
    !encoding_values.is_empty()
}

/// Get the content encoding type from headers
pub fn get_content_encoding(headers: &Headers) -> Option<String> {
    let encoding_values = headers.get("content-encoding");
    encoding_values.first().map(|value| {
        String::from_utf8_lossy(value).to_lowercase()
    })
}

/// Create a streaming decompressor wrapper for chunk-by-chunk decompression
pub struct StreamingDecompressor {
    encoding: String,
    gzip_decoder: Option<GzDecoder<std::io::Cursor<Vec<u8>>>>,
    deflate_decoder: Option<DeflateDecoder<std::io::Cursor<Vec<u8>>>>,
    brotli_decoder: Option<brotli::Decompressor<std::io::Cursor<Vec<u8>>>>,
    buffer: std::io::Cursor<Vec<u8>>,
}

impl StreamingDecompressor {
    pub fn new(encoding: &str) -> Self {
        Self {
            encoding: encoding.to_lowercase(),
            gzip_decoder: None,
            deflate_decoder: None,
            brotli_decoder: None,
            buffer: std::io::Cursor::new(Vec::new()),
        }
    }
    
    pub fn decompress_chunk(&mut self, chunk: &[u8]) -> Result<Vec<u8>> {
        // Append new chunk to buffer
        self.buffer.get_mut().extend_from_slice(chunk);
        self.buffer.set_position(0);
        
        let mut output = Vec::new();
        
        match self.encoding.as_str() {
            "gzip" => {
                if self.gzip_decoder.is_none() {
                    self.gzip_decoder = Some(GzDecoder::new(std::mem::replace(&mut self.buffer, std::io::Cursor::new(Vec::new()))));
                }
                if let Some(ref mut decoder) = self.gzip_decoder {
                    let mut temp_buf = [0u8; 4096];
                    while let Ok(n) = decoder.read(&mut temp_buf) {
                        if n == 0 { break; }
                        output.extend_from_slice(&temp_buf[..n]);
                    }
                }
            },
            "deflate" => {
                if self.deflate_decoder.is_none() {
                    self.deflate_decoder = Some(DeflateDecoder::new(std::mem::replace(&mut self.buffer, std::io::Cursor::new(Vec::new()))));
                }
                if let Some(ref mut decoder) = self.deflate_decoder {
                    let mut temp_buf = [0u8; 4096];
                    while let Ok(n) = decoder.read(&mut temp_buf) {
                        if n == 0 { break; }
                        output.extend_from_slice(&temp_buf[..n]);
                    }
                }
            },
            "br" | "brotli" => {
                if self.brotli_decoder.is_none() {
                    self.brotli_decoder = Some(brotli::Decompressor::new(std::mem::replace(&mut self.buffer, std::io::Cursor::new(Vec::new())), 4096));
                }
                if let Some(ref mut decoder) = self.brotli_decoder {
                    let mut temp_buf = [0u8; 4096];
                    while let Ok(n) = decoder.read(&mut temp_buf) {
                        if n == 0 { break; }
                        output.extend_from_slice(&temp_buf[..n]);
                    }
                }
            },
            _ => {
                // Unknown encoding, return chunk as-is
                output.extend_from_slice(chunk);
            }
        }
        
        Ok(output)
    }
}

/// Decompress data based on the encoding type (kept for backward compatibility)
pub fn decompress_data(data: &[u8], encoding: &str) -> Result<Vec<u8>> {
    let mut decompressor = StreamingDecompressor::new(encoding);
    decompressor.decompress_chunk(data)
}

/// Compress data back with the original encoding after modification
pub fn recompress_data(data: &[u8], encoding: &str) -> Result<Vec<u8>> {
    match encoding {
        "gzip" => {
            use flate2::write::GzEncoder;
            use flate2::Compression;
            use std::io::Write;
            
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(data)?;
            Ok(encoder.finish()?)
        },
        "deflate" => {
            use flate2::write::DeflateEncoder;
            use flate2::Compression;
            use std::io::Write;
            
            let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(data)?;
            Ok(encoder.finish()?)
        },
        "br" | "brotli" => {
            let mut result = Vec::new();
            let mut encoder = brotli::CompressorWriter::new(&mut result, 4096, 6, 22);
            encoder.write_all(data)?;
            drop(encoder);
            Ok(result)
        },
        _ => {
            // Unknown encoding, return as-is
            Ok(data.to_vec())
        }
    }
}

/// Find the position of `<head>` in a buffer (case-insensitive)
pub fn find_head_tag(buffer: &[u8]) -> Option<usize> {
    let buffer_str = String::from_utf8_lossy(buffer).to_lowercase();
    buffer_str.find("<head")
}

/// Inject styles after the `<head>` tag in HTML content
pub fn inject_styles_into_html(html: &str, head_pos: usize) -> String {
    // Find the end of the opening <head> tag
    let after_head = html[head_pos..].find('>').map(|pos| head_pos + pos + 1);
    
    match after_head {
        Some(insert_pos) => {
            let mut result = String::new();
            result.push_str(&html[..insert_pos]);
            result.push_str("\n");
            result.push_str(STYLES);
            result.push_str(&html[insert_pos..]);
            result
        },
        None => html.to_string(), // Malformed HTML, return as-is
    }
}

/// Create a new response body stream from content
pub fn create_response_body(content: Vec<u8>) -> wit_bindgen::rt::async_support::StreamReader<u8> {
    let (mut pipe_tx, pipe_rx) = wit_stream::new();

    wit_bindgen::spawn(async move {
        pipe_tx.write_all(content).await;
        drop(pipe_tx);
    });

    pipe_rx
}

/// Combine consumed buffer with remaining stream data
pub async fn reconstruct_body_from_parts(
    consumed_buffer: Vec<u8>,
    mut remaining_stream: wit_bindgen::rt::async_support::StreamReader<u8>,
) -> wit_bindgen::rt::async_support::StreamReader<u8> {
    let (mut pipe_tx, pipe_rx) = wit_stream::new();

    wit_bindgen::spawn(async move {
        // Write the consumed buffer first
        pipe_tx.write_all(consumed_buffer).await;
        
        // Then copy the remaining stream
        let mut buffer = vec![0u8; 8192];
        loop {
            let (result, returned_buffer) = remaining_stream.read(buffer).await;
            buffer = returned_buffer;
            
            match result {
                wit_bindgen::rt::async_support::StreamResult::Complete(n) if n > 0 => {
                    pipe_tx.write_all(buffer[..n].to_vec()).await;
                },
                _ => break,
            }
        }
        
        drop(pipe_tx);
    });

    pipe_rx
}