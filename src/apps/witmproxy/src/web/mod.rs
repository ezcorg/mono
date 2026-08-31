pub mod acl_middleware;
pub mod auth;
pub mod auth_endpoints;
pub mod cert_distribution;
pub mod device_detection;
pub mod management;
pub mod server;
pub mod templates;

use askama::Template;
use salvo::writing::Text;
pub use server::WebServer;

use salvo::oapi::endpoint;
use salvo::{Depot, Request, Response, Scribe};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

use crate::cert::generator::DeviceInfo;
use crate::cert::{CertificateAuthority, CertificateFormat, CertificateGenerator};
use crate::web::templates::{IndexTemplate, InstructionsTemplate};

/// Log an internal failure server-side and produce the 500 the client sees.
///
/// These handlers were discarding the cause entirely, which made every 500
/// undiagnosable. The detail deliberately stays in the log rather than the
/// response: `brief` is sent to the client, so putting an internal error
/// there would leak implementation detail to whoever triggered it.
/// `Debug` rather than `Display` because not every failure here carries a
/// cause: a `Depot::obtain` miss yields `Option<&Box<dyn Any>>`, where the
/// information is simply that the state was never installed. `context` names
/// which lookup failed, which is the part that matters.
pub(crate) fn internal_error(
    context: &'static str,
    err: impl std::fmt::Debug,
) -> salvo::http::StatusError {
    tracing::error!(target: "web", "{context}: {err:?}");
    salvo::http::StatusError::internal_server_error().brief(context)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod auth_tests;

#[derive(Clone)]
pub struct AppState {
    pub ca: CertificateAuthority,
    pub plugin_registry: Option<Arc<crate::plugins::registry::PluginRegistry>>,
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

// Main certificate download endpoint.
// Returns either a binary file download or an HTML instructions page.
// We return Result<(), StatusError> so error responses are documented in OpenAPI;
// the success response writes directly to `res` because it can be HTML or binary.
#[endpoint(status_codes(200, 500))]
pub async fn download_certificate(
    res: &mut Response,
    req: &Request,
    depot: &mut Depot,
) -> Result<(), salvo::http::StatusError> {
    let user_agent = req
        .headers()
        .get("user-agent")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("Unknown");
    let device_info = DeviceInfo::from_user_agent(user_agent);

    let state = depot
        .obtain::<AppState>()
        .map_err(|e| internal_error("Internal error", e))?;

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

    let cert_pem = state.ca.get_root_certificate_pem().map_err(|e| internal_error("Certificate error", e))?;

    let bundle = CertificateGenerator::generate_bundle(&cert_pem, format, &device_info)
        .map_err(|e| internal_error("Bundle error", e))?;

    // Return file download or instructions page
    if req.query::<bool>("download").unwrap_or(false) {
        res.status_code(salvo::http::StatusCode::OK)
            .add_header(salvo::http::header::CONTENT_TYPE, bundle.mime_type, true)
            .map_err(|e| internal_error("Failed to set content type", e))?
            .add_header(
                salvo::http::header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{}\"", bundle.filename),
                true,
            )
            .map_err(|e| internal_error("Failed to set content disposition", e))?
            .body(bundle.data);
    } else {
        let html = InstructionsTemplate::new(&bundle).render().map_err(|e| internal_error("Template error", e))?;
        res.status_code(salvo::http::StatusCode::OK);
        res.add_header(salvo::http::header::CONTENT_TYPE, "text/html", true)
            .map_err(|e| internal_error("Failed to set content type", e))?;
        res.render(Text::Html(html));
    }
    Ok(())
}

#[endpoint]
pub async fn index_page(req: &mut salvo::Request, res: &mut salvo::Response) {
    let user_agent = req
        .headers()
        .get("user-agent")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("Unknown");

    let device_info = DeviceInfo::from_user_agent(user_agent);
    let template = IndexTemplate::new(&device_info);
    if let Ok(body) = template.render() {
        Text::Html(body).render(res);
    } else {
        Text::Plain("Something went wrong").render(res);
    }
}
