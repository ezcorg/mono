pub mod server;
pub mod device_detection;
pub mod cert_distribution;
pub mod templates;

pub use server::WebServer;

use anyhow::Result;
use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{Html, Response},
    routing::{get, post},
    Json, Router,
};
use askama_axum::IntoResponse;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tower::ServiceBuilder;
use tower_http::{cors::CorsLayer, services::ServeDir};
use tracing::{debug, info};

use crate::cert::{CertificateAuthority, CertificateGenerator, CertificateFormat};
use crate::cert::generator::{DeviceInfo, Platform, Browser};
use crate::web::templates::{IndexTemplate, InstructionsTemplate};

#[derive(Debug, Clone)]
pub struct AppState {
    pub ca: CertificateAuthority,
}

#[derive(Debug, Deserialize)]
pub struct CertQuery {
    format: Option<String>,
    download: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct CertInfo {
    pub formats: Vec<FormatInfo>,
    pub instructions: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct FormatInfo {
    pub name: String,
    pub extension: String,
    pub mime_type: String,
    pub description: String,
    pub platforms: Vec<String>,
}

// Main certificate download endpoint
pub async fn download_certificate(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CertQuery>,
    headers: axum::http::HeaderMap,
) -> Result<Response, StatusCode> {
    let user_agent = headers
        .get("user-agent")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("Unknown");
    
    let device_info = DeviceInfo::from_user_agent(user_agent);
    debug!("Device detected: {:?}", device_info);
    
    // Get root certificate
    let cert_pem = state.ca.get_root_certificate_pem()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    
    // Determine format
    let format = if let Some(fmt) = query.format {
        match fmt.as_str() {
            "pem" => CertificateFormat::Pem,
            "der" | "crt" => CertificateFormat::Der,
            "p12" => CertificateFormat::P12,
            "mobileconfig" => CertificateFormat::MobileConfig,
            _ => device_info.recommended_format(),
        }
    } else {
        device_info.recommended_format()
    };
    
    // Generate certificate bundle
    let bundle = CertificateGenerator::generate_bundle(&cert_pem, format, &device_info)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    
    // Return file download or instructions page
    if query.download.unwrap_or(false) {
        Ok((
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, bundle.mime_type),
                (
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"{}\"", bundle.filename),
                ),
            ],
            bundle.data,
        ).into_response())
    } else {
        // Return instructions page
        let template = InstructionsTemplate::new(&bundle);
        Ok(template.into_response())
    }
}

// Legacy endpoints for compatibility
pub async fn download_ca_crt(
    State(state): State<Arc<AppState>>,
) -> Result<Response, StatusCode> {
    let cert_der = state.ca.get_root_certificate_der()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/x-x509-ca-cert"),
            (header::CONTENT_DISPOSITION, "attachment; filename=\"mitm-proxy-ca.crt\""),
        ],
        cert_der,
    ).into_response())
}

pub async fn download_ca_pem(
    State(state): State<Arc<AppState>>,
) -> Result<Response, StatusCode> {
    let cert_pem = state.ca.get_root_certificate_pem()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/x-pem-file"),
            (header::CONTENT_DISPOSITION, "attachment; filename=\"mitm-proxy-ca.pem\""),
        ],
        cert_pem,
    ).into_response())
}

// Main landing page
pub async fn index_page(
    headers: axum::http::HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
    let user_agent = headers
        .get("user-agent")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("Unknown");
    
    let device_info = DeviceInfo::from_user_agent(user_agent);
    let template = IndexTemplate::new(&device_info);
    Ok(template)
}

// Certificate information API
pub async fn cert_info(
    State(state): State<Arc<AppState>>,
) -> Result<Json<CertInfo>, StatusCode> {
    let formats = vec![
        FormatInfo {
            name: "PEM".to_string(),
            extension: "pem".to_string(),
            mime_type: "application/x-pem-file".to_string(),
            description: "Privacy-Enhanced Mail format, widely supported".to_string(),
            platforms: vec!["Linux".to_string(), "macOS".to_string()],
        },
        FormatInfo {
            name: "DER/CRT".to_string(),
            extension: "crt".to_string(),
            mime_type: "application/x-x509-ca-cert".to_string(),
            description: "Distinguished Encoding Rules, binary format".to_string(),
            platforms: vec!["Android".to_string(), "Windows".to_string()],
        },
        FormatInfo {
            name: "PKCS#12".to_string(),
            extension: "p12".to_string(),
            mime_type: "application/x-pkcs12".to_string(),
            description: "Public Key Cryptography Standards #12".to_string(),
            platforms: vec!["Windows".to_string()],
        },
        FormatInfo {
            name: "Mobile Config".to_string(),
            extension: "mobileconfig".to_string(),
            mime_type: "application/x-apple-aspen-config".to_string(),
            description: "Apple Configuration Profile".to_string(),
            platforms: vec!["iOS".to_string(), "macOS".to_string()],
        },
    ];
    
    let mut instructions = HashMap::new();
    instructions.insert("general".to_string(), 
        "Download and install the certificate to enable HTTPS interception.".to_string());
    
    Ok(Json(CertInfo { formats, instructions }))
}
