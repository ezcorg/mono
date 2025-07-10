use crate::cert::generator::{CertificateBundle, DeviceInfo, Platform};
use crate::cert::CertificateFormat;
use askama::Template;

#[derive(Template)]
#[template(path = "index.html")]
pub struct IndexTemplate {
    pub platform_name: String,
    pub format_name: String,
}

impl IndexTemplate {
    pub fn new(device_info: &DeviceInfo) -> Self {
        let platform_name = match device_info.platform {
            Platform::IOs => "iOS",
            Platform::Android => "Android",
            Platform::Windows => "Windows",
            Platform::MacOS => "macOS",
            Platform::Linux => "Linux",
            Platform::Unknown => "Unknown",
        }
        .to_string();

        let recommended_format = device_info.recommended_format();
        let format_name = match recommended_format {
            CertificateFormat::Pem => "PEM",
            CertificateFormat::Der => "Certificate (CRT)",
            CertificateFormat::P12 => "PKCS#12 (P12)",
            CertificateFormat::MobileConfig => "Mobile Configuration",
        }
        .to_string();

        Self {
            platform_name,
            format_name,
        }
    }
}

#[derive(Template)]
#[template(path = "instructions.html")]
pub struct InstructionsTemplate {
    pub bundle_format: String,
    pub bundle_filename: String,
    pub bundle_instructions: String,
}

impl InstructionsTemplate {
    pub fn new(bundle: &CertificateBundle) -> Self {
        Self {
            bundle_format: bundle.format.to_string().to_lowercase(),
            bundle_filename: bundle.filename.clone(),
            bundle_instructions: bundle.instructions.clone(),
        }
    }
}

#[derive(Template)]
#[template(path = "dashboard.html")]
pub struct DashboardTemplate;

impl DashboardTemplate {
    pub fn new() -> Self {
        Self
    }
}
