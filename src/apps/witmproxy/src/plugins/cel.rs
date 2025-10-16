use bytes::Bytes;
use hyper::Request;
use salvo::http::uri::Scheme;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use wasmtime_wasi_http::p3::{Request as WasiRequest, Response as WasiResponse};

#[derive(Clone, Serialize, Deserialize)]
pub struct CelRequest {
    pub scheme: String,
    pub host: String,
    pub path: String,
    pub query: HashMap<String, Vec<String>>,
    pub method: String,
    pub headers: HashMap<String, Vec<String>>,
}

impl From<&WasiRequest> for CelRequest {
    fn from(req: &WasiRequest) -> Self {
        let mut headers = HashMap::new();

        for (name, value) in req.headers.iter() {
            let entry = headers
                .entry(name.as_str().to_string())
                .or_insert_with(Vec::new);
            if let Ok(val_str) = value.to_str() {
                entry.push(val_str.to_string());
            }
        }

        let host = if let Some(authority) = &req.authority {
            authority.to_string()
        } else {
            "".to_string()
        };
        let mut query = HashMap::new();
        let mut path = "".to_string();
        let scheme = req.scheme.clone().unwrap_or(Scheme::HTTPS).to_string();
        let method = req.method.to_string();

        if let Some(path_and_query) = &req.path_with_query {
            path = path_and_query.path().to_string();

            if let Some(query_str) = path_and_query.query() {
                for (key, value) in url::form_urlencoded::parse(query_str.as_bytes()) {
                    let entry = query.entry(key.to_string()).or_insert_with(Vec::new);
                    entry.push(value.to_string());
                }
            }
        }

        CelRequest {
            scheme,
            host,
            path,
            query,
            method,
            headers,
        }
    }
}

impl <B> From<&Request<B>> for CelRequest
where B: http_body::Body<Data = Bytes> + Send + Sync + 'static,
{
    fn from(req: &Request<B>) -> Self {
        let mut headers = HashMap::new();

        for (name, value) in req.headers().iter() {
            let entry = headers
                .entry(name.as_str().to_string())
                .or_insert_with(Vec::new);
            if let Ok(val_str) = value.to_str() {
                entry.push(val_str.to_string());
            }
        }

        let host = if let Some(authority) = req.uri().authority() {
            authority.to_string()
        } else {
            "".to_string()
        };
        let mut query = HashMap::new();
        let mut path = "".to_string();
        let scheme = req.uri().scheme_str().unwrap_or("https").to_string();
        let method = req.method().clone().to_string();

        if let Some(path_and_query) = req.uri().path_and_query() {
            path = path_and_query.path().to_string();

            if let Some(query_str) = path_and_query.query() {
                for (key, value) in url::form_urlencoded::parse(query_str.as_bytes()) {
                    let entry = query.entry(key.to_string()).or_insert_with(Vec::new);
                    entry.push(value.to_string());
                }
            }
        }

        CelRequest {
            scheme,
            host,
            path,
            query,
            method,
            headers,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct CelResponse {
    pub status: u16,
    pub headers: HashMap<String, Vec<String>>,
}

impl From<&WasiResponse> for CelResponse {
    fn from(res: &WasiResponse) -> Self {
        let mut headers = HashMap::new();

        for (name, value) in res.headers.iter() {
            let entry = headers
                .entry(name.as_str().to_string())
                .or_insert_with(Vec::new);
            if let Ok(val_str) = value.to_str() {
                entry.push(val_str.to_string());
            }
        }

        CelResponse {
            status: res.status.as_u16(),
            headers,
        }
    }
}

impl From<&reqwest::Request> for CelRequest {
    fn from(req: &reqwest::Request) -> Self {
        let mut headers = HashMap::new();
        
        for (name, value) in req.headers().iter() {
            let entry = headers
                .entry(name.as_str().to_string())
                .or_insert_with(Vec::new);
            if let Ok(val_str) = value.to_str() {
                entry.push(val_str.to_string());
            }
        }

        let url = req.url();
        let host = url.host_str().unwrap_or("").to_string();
        let path = url.path().to_string();
        let scheme = url.scheme().to_string();
        let method = req.method().to_string();

        let mut query = HashMap::new();
        for (key, value) in url.query_pairs() {
            let entry = query.entry(key.to_string()).or_insert_with(Vec::new);
            entry.push(value.to_string());
        }

        CelRequest {
            scheme,
            host,
            path,
            query,
            method,
            headers,
        }
    }
}
