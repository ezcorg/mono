use salvo::http::response::Parts;
use wasmtime_wasi_http::p3::Response as WasiResponse;

#[derive(PartialEq, Eq)]
pub enum ContentEncoding {
    Gzip,    // gzip
    Deflate, // deflate
    Br,      // br
    Zstd,    // zstd
    None,    // identity
    // Dcb,
    // Dcz,
    Unknown,
}

pub trait Encoded {
    fn encoding(&self) -> ContentEncoding;
}

impl Encoded for Parts {
    /// Returns the content encoding based on the first value of the `Content-Encoding` header.
    /// If the header is not present, returns `ContentEncoding::None`.
    /// If values were found, but none supported, returns `ContentEncoding::Unknown`.
    fn encoding(&self) -> ContentEncoding {
        let mut found_but_unknown = false;

        for value in self.headers.get_all("content-encoding") {
            if let Ok(value_str) = value.to_str() {
                match value_str.to_lowercase().as_str() {
                    "gzip" => return ContentEncoding::Gzip,
                    "deflate" => return ContentEncoding::Deflate,
                    "br" => return ContentEncoding::Br,
                    "zstd" => return ContentEncoding::Zstd,
                    "identity" => return ContentEncoding::None,
                    _ => found_but_unknown = true,
                }
            }
        }
        if found_but_unknown {
            ContentEncoding::Unknown
        } else {
            ContentEncoding::None
        }
    }
}

pub trait ContentTyped {
    fn content_type(&self) -> String;
}

impl ContentTyped for WasiResponse {
    fn content_type(&self) -> String {
        let joined = self
            .headers
            .get_all("content-type")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .collect::<Vec<&str>>()
            .join(", ");

        if joined.is_empty() {
            "unknown".to_string()
        } else {
            joined
        }
    }
}
