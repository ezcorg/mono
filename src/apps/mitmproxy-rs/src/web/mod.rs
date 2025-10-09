pub mod cert_distribution;
pub mod device_detection;
pub mod server;
pub mod templates;

use askama::Template;
use salvo::writing::Text;
pub use server::WebServer;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tracing::debug;
use salvo::oapi::endpoint;
use salvo::{Depot, Request, Response, Scribe};

use crate::cert::generator::DeviceInfo;
use crate::cert::{CertificateAuthority, CertificateFormat, CertificateGenerator};
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
#[endpoint]
pub async fn download_certificate(res: &mut Response, req: &Request, depot: &mut Depot) {
    let user_agent = req.headers().get("user-agent").and_then(|h| h.to_str().ok()).unwrap_or("Unknown");

    let device_info = DeviceInfo::from_user_agent(user_agent);
    debug!("Device detected: {:?}", device_info);

    let state = if let Ok(state) = depot.obtain::<AppState>() {
        state
    } else {
        res.status_code(salvo::http::StatusCode::INTERNAL_SERVER_ERROR);
        res.render(Text::Plain("Internal server error"));
        return;
    };

    // Determine format
    let format = if let Some(fmt) = req.query::<String>("format") {
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

    let cert_pem = if let Ok(cert_pem) = state.ca.get_root_certificate_pem() {
        cert_pem
    } else {
        res.status_code(salvo::http::StatusCode::INTERNAL_SERVER_ERROR);
        res.render(Text::Plain("Internal server error"));
        return;
    };

    // Generate certificate bundle
    let bundle = if let Ok(bundle) = CertificateGenerator::generate_bundle(&cert_pem, format, &device_info) {
        bundle
    } else {
        res.status_code(salvo::http::StatusCode::INTERNAL_SERVER_ERROR);
        res.render(Text::Plain("Internal server error"));
        return;
    };

    // Return file download or instructions page
    if req.query::<bool>("download").unwrap_or(false) {
        res.status_code(salvo::http::StatusCode::OK)
        .add_header(salvo::http::header::CONTENT_TYPE, bundle.mime_type, true)
        .unwrap()
        .add_header(
            salvo::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", bundle.filename),
            true,
        ).unwrap().body(bundle.data);
    } else {
        // Return instructions page
        let template = InstructionsTemplate::new(&bundle);
        let template = match template.render() {
            Ok(html) => html,
            Err(_) => {
                res.status_code(salvo::http::StatusCode::INTERNAL_SERVER_ERROR);
                res.render(Text::Plain("Internal server error"));
                return;
            }
        };
        res.status_code(salvo::http::StatusCode::OK);
        res.add_header(salvo::http::header::CONTENT_TYPE, "text/html", true).unwrap();
        res.render(Text::Html(template));
    }
}

// // Legacy endpoints for compatibility
// pub async fn download_ca_crt(State(state): State<Arc<AppState>>) -> Result<Response, StatusCode> {
//     let cert_der = state
//         .ca
//         .get_root_certificate_der()
//         .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

//     Ok((
//         StatusCode::OK,
//         [
//             (header::CONTENT_TYPE, "application/x-x509-ca-cert"),
//             (
//                 header::CONTENT_DISPOSITION,
//                 "attachment; filename=\"mitm-proxy-ca.crt\"",
//             ),
//         ],
//         cert_der,
//     )
//         .into_response())
// }

// pub async fn download_ca_pem(State(state): State<Arc<AppState>>) -> Result<Response, StatusCode> {
//     let cert_pem = state
//         .ca
//         .get_root_certificate_pem()
//         .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

//     Ok((
//         StatusCode::OK,
//         [
//             (header::CONTENT_TYPE, "application/x-pem-file"),
//             (
//                 header::CONTENT_DISPOSITION,
//                 "attachment; filename=\"mitm-proxy-ca.pem\"",
//             ),
//         ],
//         cert_pem,
//     )
//         .into_response())
// }

#[endpoint]
pub async fn index_page(req: &mut salvo::Request, res: &mut salvo::Response) {
    let user_agent = req.headers().get("user-agent").and_then(|h| h.to_str().ok()).unwrap_or("Unknown");

    let device_info = DeviceInfo::from_user_agent(user_agent);
    let template = IndexTemplate::new(&device_info);
    if let Ok(body) = template.render() {
        Text::Html(body).render(res);
    } else {
        Text::Plain("Something went wrong").render(res);
    }
}

// // Certificate information API
// pub async fn cert_info(State(_state): State<Arc<AppState>>) -> Result<Json<CertInfo>, StatusCode> {
//     let formats = vec![
//         FormatInfo {
//             name: "PEM".to_string(),
//             extension: "pem".to_string(),
//             mime_type: "application/x-pem-file".to_string(),
//             description: "Privacy-Enhanced Mail format, widely supported".to_string(),
//             platforms: vec!["Linux".to_string(), "macOS".to_string()],
//         },
//         FormatInfo {
//             name: "DER/CRT".to_string(),
//             extension: "crt".to_string(),
//             mime_type: "application/x-x509-ca-cert".to_string(),
//             description: "Distinguished Encoding Rules, binary format".to_string(),
//             platforms: vec!["Android".to_string(), "Windows".to_string()],
//         },
//         FormatInfo {
//             name: "PKCS#12".to_string(),
//             extension: "p12".to_string(),
//             mime_type: "application/x-pkcs12".to_string(),
//             description: "Public Key Cryptography Standards #12".to_string(),
//             platforms: vec!["Windows".to_string()],
//         },
//         FormatInfo {
//             name: "Mobile Config".to_string(),
//             extension: "mobileconfig".to_string(),
//             mime_type: "application/x-apple-aspen-config".to_string(),
//             description: "Apple Configuration Profile".to_string(),
//             platforms: vec!["iOS".to_string(), "macOS".to_string()],
//         },
//     ];

//     let mut instructions = HashMap::new();
//     instructions.insert(
//         "general".to_string(),
//         "Download and install the certificate to enable HTTPS interception.".to_string(),
//     );

//     Ok(Json(CertInfo {
//         formats,
//         instructions,
//     }))
// }
