use salvo::http::uri::Scheme;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use wasmtime_wasi_http::p3::{Request as WasiRequest, Response as WasiResponse};

#[derive(Serialize, Deserialize)]
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

#[derive(Serialize, Deserialize)]
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
