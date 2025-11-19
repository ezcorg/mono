use super::{HtmlDocument, HtmlForm, HtmlInput, HtmlLink};
use anyhow::Result;
use html5ever::parse_document;
use html5ever::tendril::TendrilSink;
use markup5ever_rcdom::{Handle, NodeData, RcDom};
use std::collections::HashMap;

pub struct ContentParser;

impl ContentParser {
    /// Parse content based on content type
    pub fn parse(content_type: &str, body: &[u8]) -> Result<crate::content::ParsedContent> {
        match content_type {
            ct if super::is_json_content(ct) => Self::parse_json(body),
            ct if super::is_html_content(ct) => Self::parse_html(body),
            ct if ct.starts_with("text/") => Self::parse_text(body),
            _ => Ok(crate::content::ParsedContent::Binary(body.to_vec())),
        }
    }

    /// Parse JSON content
    fn parse_json(body: &[u8]) -> Result<crate::content::ParsedContent> {
        let json_value: serde_json::Value = serde_json::from_slice(body)?;
        Ok(crate::content::ParsedContent::Json(json_value))
    }

    /// Parse HTML content using html5ever
    fn parse_html(body: &[u8]) -> Result<crate::content::ParsedContent> {
        let html_str = String::from_utf8_lossy(body);
        let dom = parse_document(RcDom::default(), Default::default())
            .from_utf8()
            .read_from(&mut html_str.as_bytes())?;

        let document = Self::extract_html_info(&dom.document)?;
        Ok(crate::content::ParsedContent::Html(document))
    }

    /// Parse text content
    fn parse_text(body: &[u8]) -> Result<crate::content::ParsedContent> {
        let text = String::from_utf8_lossy(body).to_string();
        Ok(crate::content::ParsedContent::Text(text))
    }
    /// Extract structured information from HTML DOM
    fn extract_html_info(handle: &Handle) -> Result<HtmlDocument> {
        let mut document = HtmlDocument {
            title: None,
            meta: HashMap::new(),
            links: Vec::new(),
            forms: Vec::new(),
            scripts: Vec::new(),
            text_content: String::new(),
            raw_html: String::new(),
        };

        Self::traverse_node(handle, &mut document);
        Ok(document)
    }

    /// Recursively traverse HTML nodes to extract information
    fn traverse_node(handle: &Handle, document: &mut HtmlDocument) {
        let node = handle;
        match &node.data {
            NodeData::Document => {
                for child in node.children.borrow().iter() {
                    Self::traverse_node(child, document);
                }
            }
            NodeData::Element { name, attrs, .. } => {
                let tag_name = name.local.as_ref();
                let attributes = attrs.borrow();

                match tag_name {
                    "title" => {
                        document.title = Some(Self::get_text_content(handle));
                    }
                    "meta" => {
                        if let Some(name_attr) = Self::get_attr(&attributes, "name")
                            && let Some(content_attr) = Self::get_attr(&attributes, "content")
                        {
                            document.meta.insert(name_attr, content_attr);
                        }
                    }
                    "a" => {
                        if let Some(href) = Self::get_attr(&attributes, "href") {
                            let link = HtmlLink {
                                href,
                                rel: Self::get_attr(&attributes, "rel"),
                                text: Self::get_text_content(handle),
                            };
                            document.links.push(link);
                        }
                    }
                    "form" => {
                        let form = HtmlForm {
                            action: Self::get_attr(&attributes, "action"),
                            method: Self::get_attr(&attributes, "method")
                                .unwrap_or_else(|| "get".to_string()),
                            inputs: Self::extract_form_inputs(handle),
                        };
                        document.forms.push(form);
                    }
                    "script" => {
                        if let Some(src) = Self::get_attr(&attributes, "src") {
                            document.scripts.push(src);
                        }
                    }
                    _ => {}
                }

                // Continue traversing children
                for child in node.children.borrow().iter() {
                    Self::traverse_node(child, document);
                }
            }
            NodeData::Text { contents } => {
                let text = contents.borrow().to_string();
                if !text.trim().is_empty() {
                    document.text_content.push_str(&text);
                    document.text_content.push(' ');
                }
            }
            _ => {
                // Continue traversing children for other node types
                for child in node.children.borrow().iter() {
                    Self::traverse_node(child, document);
                }
            }
        }
    }

    /// Extract form inputs from a form element
    fn extract_form_inputs(form_handle: &Handle) -> Vec<HtmlInput> {
        let mut inputs = Vec::new();
        Self::collect_inputs(form_handle, &mut inputs);
        inputs
    }

    /// Recursively collect input elements
    fn collect_inputs(handle: &Handle, inputs: &mut Vec<HtmlInput>) {
        let node = handle;
        if let NodeData::Element { name, attrs, .. } = &node.data {
            let tag_name = name.local.as_ref();
            let attributes = attrs.borrow();

            if tag_name == "input" || tag_name == "textarea" || tag_name == "select" {
                let input = HtmlInput {
                    name: Self::get_attr(&attributes, "name"),
                    input_type: Self::get_attr(&attributes, "type")
                        .unwrap_or_else(|| "text".to_string()),
                    value: Self::get_attr(&attributes, "value"),
                };
                inputs.push(input);
            }
        }

        // Continue with children
        for child in node.children.borrow().iter() {
            Self::collect_inputs(child, inputs);
        }
    }

    /// Get attribute value by name
    fn get_attr(attrs: &std::cell::Ref<Vec<html5ever::Attribute>>, name: &str) -> Option<String> {
        attrs
            .iter()
            .find(|attr| attr.name.local.as_ref() == name)
            .map(|attr| attr.value.to_string())
    }

    /// Get text content from a node and its children
    fn get_text_content(handle: &Handle) -> String {
        let mut text = String::new();
        Self::collect_text(handle, &mut text);
        text.trim().to_string()
    }

    /// Recursively collect text content
    fn collect_text(handle: &Handle, text: &mut String) {
        let node = handle;
        match &node.data {
            NodeData::Text { contents } => {
                text.push_str(&contents.borrow().to_string());
            }
            _ => {
                for child in node.children.borrow().iter() {
                    Self::collect_text(child, text);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::ParsedContent;

    #[test]
    fn test_parse_json() {
        let json_data = r#"{"name": "test", "value": 42}"#;
        let result = ContentParser::parse("application/json", json_data.as_bytes()).unwrap();

        if let ParsedContent::Json(value) = result {
            assert_eq!(value["name"], "test");
            assert_eq!(value["value"], 42);
        } else {
            panic!("Expected JSON content");
        }
    }

    #[test]
    fn test_parse_html() {
        let html_data = r#"
            <html>
                <head>
                    <title>Test Page</title>
                    <meta name="description" content="A test page">
                </head>
                <body>
                    <a href="https://example.com">Example Link</a>
                    <form action="/submit" method="post">
                        <input type="text" name="username" value="test">
                        <input type="password" name="password">
                    </form>
                </body>
            </html>
        "#;

        let result = ContentParser::parse("text/html", html_data.as_bytes()).unwrap();

        if let ParsedContent::Html(doc) = result {
            assert_eq!(doc.title, Some("Test Page".to_string()));
            assert_eq!(
                doc.meta.get("description"),
                Some(&"A test page".to_string())
            );
            assert_eq!(doc.links.len(), 1);
            assert_eq!(doc.links[0].href, "https://example.com");
            assert_eq!(doc.forms.len(), 1);
            assert_eq!(doc.forms[0].inputs.len(), 2);
        } else {
            panic!("Expected HTML content");
        }
    }

    #[test]
    fn test_parse_text() {
        let text_data = "Hello, world!";
        let result = ContentParser::parse("text/plain", text_data.as_bytes()).unwrap();

        if let ParsedContent::Text(text) = result {
            assert_eq!(text, "Hello, world!");
        } else {
            panic!("Expected text content");
        }
    }
}
