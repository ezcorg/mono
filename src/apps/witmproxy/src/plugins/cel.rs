use std::collections::HashMap;

use hyper::{body::{Body}, Request};
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize)]
pub struct CelRequest {
    pub scheme: String,
    pub host: String,
    pub path: String,
    pub query: HashMap<String, Vec<String>>,
    pub method: String,
    pub headers: HashMap<String, Vec<String>>,
}

impl<B> From<&Request<B>> for CelRequest
where
    B: Body + Send + 'static,
{
    fn from(req: &Request<B>) -> Self {
        let mut headers = HashMap::new();

        for (name, value) in req.headers().iter() {
            let entry = headers.entry(name.as_str().to_string()).or_insert_with(Vec::new);
            if let Ok(val_str) = value.to_str() {
                entry.push(val_str.to_string());
            }
        }

        let mut query = HashMap::new();
        if let Some(query_str) = req.uri().query() {
            for (key, value) in url::form_urlencoded::parse(query_str.as_bytes()) {
                let entry = query.entry(key.to_string()).or_insert_with(Vec::new);
                entry.push(value.to_string());
            }
        }

        CelRequest {
            scheme: req.uri().scheme_str().unwrap_or("").to_string(),
            host: req.uri().host().unwrap_or("").to_string(),
            path: req.uri().path().to_string(),
            query,
            method: req.method().to_string(),
            headers,
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct CelResponse {
    pub status: u16,
    pub headers: HashMap<String, Vec<String>>,
    pub host: String,
    pub path: String,
}