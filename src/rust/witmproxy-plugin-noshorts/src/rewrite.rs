//! Streaming HTML rewriting: append fragments to `<head>` and `<body>`.

use encoding_rs::Encoding;
use lol_html::{AsciiCompatibleEncoding, HtmlRewriter, Settings as RewriterSettings, element};

/// The charset named in a `Content-Type`, defaulting to UTF-8.
pub fn charset_of(content_type: &str) -> &'static Encoding {
    content_type
        .split(';')
        .map(str::trim)
        .find_map(|part| {
            let (k, v) = part.split_once('=')?;
            if k.trim().eq_ignore_ascii_case("charset") {
                Encoding::for_label(v.trim().trim_matches('"').as_bytes())
            } else {
                None
            }
        })
        .unwrap_or(encoding_rs::UTF_8)
}

/// A rewriter that appends `head_html` inside `<head>` and `body_html`
/// inside `<body>`, delivering output to `sink`. `None` when the document's
/// encoding is one `lol_html` cannot stream (UTF-16), in which case the
/// caller should pass the body through untouched.
pub fn injecting_rewriter<'h>(
    encoding: &'static Encoding,
    head_html: String,
    body_html: String,
    sink: impl FnMut(&[u8]) + 'h,
) -> Option<HtmlRewriter<'h, impl FnMut(&[u8]) + 'h>> {
    let encoding = AsciiCompatibleEncoding::new(encoding)?;
    let mut handlers = Vec::new();
    if !head_html.is_empty() {
        handlers.push(element!("head", move |el| {
            el.append(&head_html, lol_html::html_content::ContentType::Html);
            Ok(())
        }));
    }
    if !body_html.is_empty() {
        handlers.push(element!("body", move |el| {
            el.append(&body_html, lol_html::html_content::ContentType::Html);
            Ok(())
        }));
    }
    Some(HtmlRewriter::new(
        RewriterSettings {
            element_content_handlers: handlers,
            encoding,
            ..RewriterSettings::default()
        },
        sink,
    ))
}

/// One-shot rewrite for tests and small documents.
pub fn rewrite_all(
    html: &[u8],
    encoding: &'static Encoding,
    head: &str,
    body: &str,
) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(html.len() + head.len() + body.len());
    {
        let mut rw = injecting_rewriter(
            encoding,
            head.to_string(),
            body.to_string(),
            |c: &[u8]| out.extend_from_slice(c),
        )?;
        rw.write(html).ok()?;
        rw.end().ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn charset_detection() {
        assert_eq!(charset_of("text/html"), encoding_rs::UTF_8);
        assert_eq!(
            charset_of("text/html; charset=ISO-8859-1"),
            encoding_rs::WINDOWS_1252
        );
        assert_eq!(
            charset_of("text/html; Charset=\"utf-8\""),
            encoding_rs::UTF_8
        );
        assert_eq!(charset_of("text/html; charset=bogus"), encoding_rs::UTF_8);
    }

    #[test]
    fn appends_into_head_and_body() {
        let html =
            b"<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>";
        let out = rewrite_all(
            html,
            encoding_rs::UTF_8,
            "<style>x{}</style>",
            "<iframe></iframe>",
        )
        .unwrap();
        let s = String::from_utf8(out).unwrap();
        assert_eq!(
            s,
            "<!doctype html><html><head><title>t</title><style>x{}</style></head><body><p>hi</p><iframe></iframe></body></html>"
        );
    }

    #[test]
    fn utf16_is_declined() {
        assert!(rewrite_all(b"", encoding_rs::UTF_16LE, "a", "b").is_none());
    }
}
