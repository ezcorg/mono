use bytes::Bytes;
use cel_cxx::{Opaque};
use hyper::{Request, Response};
use salvo::http::uri::Scheme;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use wasmtime_wasi_http::p3::{Request as WasiRequest, Response as WasiResponse};

use crate::{events::response::ResponseEnum, wasm::bindgen::witmproxy::plugin::capabilities::Content};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Opaque)]
#[cel_cxx(display)]
pub struct CelConnect {
    pub host: String,
    pub port: u16,
}

impl CelConnect {
    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Opaque)]
#[cel_cxx(display)]
pub struct CelRequest {
    pub scheme: String,
    pub host: String,
    pub path: String,
    pub query: HashMap<String, Vec<String>>,
    pub method: String,
    pub headers: HashMap<String, Vec<String>>,
}

impl CelRequest {
    pub fn scheme(&self) -> &str {
        &self.scheme
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn query(&self) -> &HashMap<String, Vec<String>> {
        &self.query
    }

    pub fn method(&self) -> &str {
        &self.method
    }

    pub fn headers(&self) -> &HashMap<String, Vec<String>> {
        &self.headers
    }
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

impl<B> From<&Request<B>> for CelRequest
where
    B: http_body::Body<Data = Bytes> + Send + 'static,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Opaque)]
#[cel_cxx(display)]
pub struct CelResponse {
    pub status: u16,
    pub headers: HashMap<String, Vec<String>>,
}

impl CelResponse {
    pub fn status(&self) -> u16 {
        self.status
    }

    pub fn headers(&self) -> &HashMap<String, Vec<String>> {
        &self.headers
    }
}

impl<B> From<&Response<B>> for CelResponse
where
    B: http_body::Body<Data = Bytes> + Send + 'static,
{
    fn from(res: &Response<B>) -> Self {
        let mut headers = HashMap::new();

        for (name, value) in res.headers().iter() {
            let entry = headers
                .entry(name.as_str().to_string())
                .or_insert_with(Vec::new);
            if let Ok(val_str) = value.to_str() {
                entry.push(val_str.to_string());
            }
        }

        CelResponse {
            status: res.status().as_u16(),
            headers,
        }
    }
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

impl<T> From<&ResponseEnum<T>> for CelResponse
where T: http_body::Body<Data = bytes::Bytes> + Send + Sync + 'static, {
    fn from(res_enum: &ResponseEnum<T>) -> Self {
        match res_enum {
            ResponseEnum::WasiResponse(wasi_res) => CelResponse::from(wasi_res),
            ResponseEnum::HyperResponse(hyper_res) => CelResponse::from(hyper_res),
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Opaque)]
#[cel_cxx(display)]
pub struct CelContent {
    content_type: String
}

impl CelContent {
    pub fn content_type(&self) -> &str {
        &self.content_type
    }
}

impl From<&Content> for CelContent {
    fn from(content: &Content) -> Self {
        CelContent {
            content_type: content.content_type(),
        }
    }
}

impl<B> From<&Response<B>> for CelContent
where
    B: http_body::Body<Data = Bytes> + Send + 'static,
{
    fn from(res: &Response<B>) -> Self {
        let content_type = if let Some(values) = res.headers().get("content-type") {
            if let Ok(val_str) = values.to_str() {
                val_str.to_string()
            } else {
                "unknown".to_string()
            }
        } else {
            "unknown".to_string()
        };

        CelContent {
            content_type
        }
    }
}