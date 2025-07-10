use crate::cert::generator::{CertificateBundle, DeviceInfo};
use crate::cert::{CertificateAuthority, CertificateFormat, CertificateGenerator};
use anyhow::Result;
use axum::{
    extract::{Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use std::sync::Arc;
use tracing::debug;

#[derive(Debug, Deserialize)]
pub struct CertQuery {
    pub format: Option<String>,
    pub download: Option<bool>,
}

pub async fn handle_cert_download(
    State(ca): State<Arc<CertificateAuthority>>,
    Query(query): Query<CertQuery>,
    device_info: DeviceInfo,
) -> Result<Response, StatusCode> {
    debug!("Certificate download request: {:?}", query);

    // Get root certificate
    let cert_pem = ca
        .get_root_certificate_pem()
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

    // Return file download
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
        )
            .into_response())
    } else {
        // Return instructions page
        let html = generate_instructions_html(&bundle, &device_info);
        Ok((StatusCode::OK, [(header::CONTENT_TYPE, "text/html")], html).into_response())
    }
}

fn generate_instructions_html(bundle: &CertificateBundle, _device_info: &DeviceInfo) -> String {
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Certificate Installation Instructions</title>
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }}
        .container {{
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }}
        .download-section {{
            text-align: center;
            margin: 30px 0;
            padding: 20px;
            background: #f8f9fa;
            border-radius: 5px;
        }}
        .download-btn {{
            background: #2196f3;
            color: white;
            padding: 15px 30px;
            text-decoration: none;
            border-radius: 5px;
            font-size: 18px;
            display: inline-block;
        }}
        .instructions {{
            background: #e8f5e8;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
            white-space: pre-line;
            line-height: 1.6;
        }}
        .back-link {{
            color: #666;
            text-decoration: none;
            margin-top: 20px;
            display: inline-block;
        }}
    </style>
</head>
<body>
    <div class="container">
        <h1>📋 Installation Instructions</h1>
        <p><strong>Certificate Format:</strong> {} ({})</p>
        
        <div class="download-section">
            <p>First, download the certificate file:</p>
            <a href="/cert?format={}&download=true" class="download-btn">
                📥 Download {} Certificate
            </a>
        </div>
        
        <div class="instructions">
            <strong>Installation Steps:</strong>
            
{}
        </div>
        
        <a href="/" class="back-link">← Back to main page</a>
    </div>
</body>
</html>"#,
        bundle.format,
        bundle.filename,
        bundle.format,
        bundle.format.to_uppercase(),
        bundle.instructions
    )
}
