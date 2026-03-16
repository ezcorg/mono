use bytes::Bytes;
use cel_cxx::Opaque;
use chrono::Datelike;
use hyper::{Request, Response};
use salvo::http::uri::Scheme;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::str::FromStr;
use wasmtime_wasi_http::p3::{Request as WasiRequest, Response as WasiResponse};

use crate::{
    events::content::InboundContent, wasm::bindgen::witmproxy::plugin::capabilities::RequestContext,
};

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

impl From<CelRequest> for RequestContext {
    fn from(val: CelRequest) -> Self {
        let query = val
            .query
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let headers = val
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        RequestContext {
            scheme: val.scheme,
            host: val.host,
            path: val.path,
            query,
            method: val.method,
            headers,
        }
    }
}

impl From<&RequestContext> for CelRequest {
    fn from(ctx: &RequestContext) -> Self {
        let query = ctx
            .query
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let headers = ctx
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        CelRequest {
            scheme: ctx.scheme.clone(),
            host: ctx.host.clone(),
            path: ctx.path.clone(),
            query,
            method: ctx.method.clone(),
            headers,
        }
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
    content_type: String,
}

impl CelContent {
    pub fn content_type(&self) -> &str {
        &self.content_type
    }
}

impl From<&InboundContent> for CelContent {
    fn from(content: &InboundContent) -> Self {
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

        CelContent { content_type }
    }
}

/// A CEL context object providing time-based convenience methods for controlling
/// when a plugin should run, without leaking detailed host information to the plugin.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Opaque)]
#[cel_cxx(display)]
pub struct CelTime {
    /// Current hour (0-23)
    hour: u32,
    /// Current day of week (0=Sunday, 6=Saturday)
    day_of_week: u32,
    /// For cron matching, we store the current UTC time
    now_utc: chrono::DateTime<chrono::Utc>,
}

impl CelTime {
    /// Create a new CelTime from the current system time
    pub fn now() -> Self {
        let now_utc = chrono::Utc::now();
        let hour = now_utc.hour();
        // chrono: Mon=0 .. Sun=6; we want Sun=0 .. Sat=6
        let day_of_week = match now_utc.weekday() {
            chrono::Weekday::Sun => 0,
            chrono::Weekday::Mon => 1,
            chrono::Weekday::Tue => 2,
            chrono::Weekday::Wed => 3,
            chrono::Weekday::Thu => 4,
            chrono::Weekday::Fri => 5,
            chrono::Weekday::Sat => 6,
        };
        Self {
            hour,
            day_of_week,
            now_utc,
        }
    }

    /// Returns whether the given CRON expression matches the current system time.
    ///
    /// Example CEL: `time.matches_cron("0 9-17 * * MON-FRI")`
    pub fn matches_cron(&self, cron_str: &str) -> bool {
        match cron::Schedule::from_str(cron_str) {
            Ok(schedule) => schedule.upcoming(chrono::Utc).take(1).any(|next| {
                // Check if the next occurrence is within 60 seconds of now
                let diff = next.signed_duration_since(self.now_utc);
                diff.num_seconds().abs() < 60
            }),
            Err(_) => false,
        }
    }

    /// Returns whether the current day matches the given weekday integer.
    /// 0 = Sunday, 1 = Monday, ..., 6 = Saturday.
    ///
    /// Example CEL: `time.is_day_of_week(1)` (true on Mondays)
    pub fn is_day_of_week(&self, weekday: i64) -> bool {
        weekday >= 0 && weekday <= 6 && self.day_of_week == weekday as u32
    }

    /// Returns whether the current hour is between `hour_start` and `hour_end` (inclusive).
    /// Both values must be in range [0, 23].
    ///
    /// Example CEL: `time.is_between_hours(9, 17)` (true from 9:00 to 17:59)
    pub fn is_between_hours(&self, hour_start: i64, hour_end: i64) -> bool {
        if hour_start < 0 || hour_start > 23 || hour_end < 0 || hour_end > 23 {
            return false;
        }
        let h = self.hour as i64;
        if hour_start <= hour_end {
            h >= hour_start && h <= hour_end
        } else {
            // Wraps around midnight (e.g., 22 to 6)
            h >= hour_start || h <= hour_end
        }
    }

    /// Register the `time` variable and its methods with the CEL environment
    pub fn register_cel_env(
        env: cel_cxx::EnvBuilder<'_>,
    ) -> anyhow::Result<cel_cxx::EnvBuilder<'_>> {
        let env = env
            .declare_variable::<CelTime>("time")?
            .register_member_function("matches_cron", CelTime::matches_cron)?
            .register_member_function("is_day_of_week", CelTime::is_day_of_week)?
            .register_member_function("is_between_hours", CelTime::is_between_hours)?;
        Ok(env)
    }
}

use chrono::Timelike;
