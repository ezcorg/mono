use super::{CertError, CertResult};
use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;

#[derive(Debug, Clone)]
pub enum CertificateFormat {
    Pem,
    Der,
    P12,
    MobileConfig,
}

#[derive(Debug, Clone, Serialize)]
pub struct CertificateBundle {
    pub format: String,
    pub data: Vec<u8>,
    pub filename: String,
    pub mime_type: String,
    pub instructions: String,
}

pub struct CertificateGenerator;

impl CertificateGenerator {
    pub fn generate_bundle(
        cert_pem: &str,
        format: CertificateFormat,
        device_info: &DeviceInfo,
    ) -> CertResult<CertificateBundle> {
        match format {
            CertificateFormat::Pem => Self::generate_pem_bundle(cert_pem),
            CertificateFormat::Der => Self::generate_der_bundle(cert_pem),
            CertificateFormat::P12 => Self::generate_p12_bundle(cert_pem),
            CertificateFormat::MobileConfig => {
                Self::generate_mobileconfig_bundle(cert_pem, device_info)
            }
        }
    }

    fn generate_pem_bundle(cert_pem: &str) -> CertResult<CertificateBundle> {
        Ok(CertificateBundle {
            format: "pem".to_string(),
            data: cert_pem.as_bytes().to_vec(),
            filename: "mitm-proxy-ca.pem".to_string(),
            mime_type: "application/x-pem-file".to_string(),
            instructions: Self::get_pem_instructions(),
        })
    }

    fn generate_der_bundle(cert_pem: &str) -> CertResult<CertificateBundle> {
        // Convert PEM to DER
        let cert_der = Self::pem_to_der(cert_pem)?;

        Ok(CertificateBundle {
            format: "der".to_string(),
            data: cert_der,
            filename: "mitm-proxy-ca.crt".to_string(),
            mime_type: "application/x-x509-ca-cert".to_string(),
            instructions: Self::get_der_instructions(),
        })
    }

    fn generate_p12_bundle(cert_pem: &str) -> CertResult<CertificateBundle> {
        // For P12, we need to create a PKCS#12 bundle
        // This is a simplified version - in production you'd use proper PKCS#12 libraries
        let cert_der = Self::pem_to_der(cert_pem)?;

        Ok(CertificateBundle {
            format: "p12".to_string(),
            data: cert_der, // Simplified - should be proper PKCS#12
            filename: "mitm-proxy-ca.p12".to_string(),
            mime_type: "application/x-pkcs12".to_string(),
            instructions: Self::get_p12_instructions(),
        })
    }

    fn generate_mobileconfig_bundle(
        cert_pem: &str,
        device_info: &DeviceInfo,
    ) -> CertResult<CertificateBundle> {
        let cert_der = Self::pem_to_der(cert_pem)?;
        let cert_base64 = general_purpose::STANDARD.encode(&cert_der);

        let mobileconfig = Self::create_mobileconfig_xml(&cert_base64, device_info);

        Ok(CertificateBundle {
            format: "mobileconfig".to_string(),
            data: mobileconfig.as_bytes().to_vec(),
            filename: "mitm-proxy-ca.mobileconfig".to_string(),
            mime_type: "application/x-apple-aspen-config".to_string(),
            instructions: Self::get_mobileconfig_instructions(),
        })
    }

    fn pem_to_der(pem: &str) -> CertResult<Vec<u8>> {
        // Extract the base64 content between BEGIN and END markers
        let lines: Vec<&str> = pem.lines().collect();
        let mut in_cert = false;
        let mut base64_content = String::new();

        for line in lines {
            if line.contains("-----BEGIN CERTIFICATE-----") {
                in_cert = true;
                continue;
            }
            if line.contains("-----END CERTIFICATE-----") {
                break;
            }
            if in_cert {
                base64_content.push_str(line.trim());
            }
        }

        general_purpose::STANDARD
            .decode(base64_content)
            .map_err(|_| CertError::InvalidFormat)
    }

    fn create_mobileconfig_xml(cert_base64: &str, _device_info: &DeviceInfo) -> String {
        let uuid = uuid::Uuid::new_v4().to_string().to_uppercase();
        let payload_uuid = uuid::Uuid::new_v4().to_string().to_uppercase();

        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>PayloadCertificateFileName</key>
            <string>mitm-proxy-ca.crt</string>
            <key>PayloadContent</key>
            <data>{}</data>
            <key>PayloadDescription</key>
            <string>MITM Proxy Root Certificate</string>
            <key>PayloadDisplayName</key>
            <string>MITM Proxy CA</string>
            <key>PayloadIdentifier</key>
            <string>com.mitmproxy.ca.{}</string>
            <key>PayloadType</key>
            <string>com.apple.security.root</string>
            <key>PayloadUUID</key>
            <string>{}</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
        </dict>
    </array>
    <key>PayloadDescription</key>
    <string>Install MITM Proxy Root Certificate</string>
    <key>PayloadDisplayName</key>
    <string>MITM Proxy Certificate</string>
    <key>PayloadIdentifier</key>
    <string>com.mitmproxy.profile</string>
    <key>PayloadRemovalDisallowed</key>
    <false/>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>{}</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
</dict>
</plist>"#,
            cert_base64, payload_uuid, payload_uuid, uuid
        )
    }

    fn get_pem_instructions() -> String {
        r#"Linux/macOS Instructions:
1. Download the certificate file
2. For Chrome/Chromium: Go to Settings > Privacy and security > Security > Manage certificates > Authorities > Import
3. For Firefox: Go to Preferences > Privacy & Security > Certificates > View Certificates > Authorities > Import
4. For system-wide: Copy to /usr/local/share/ca-certificates/ and run 'sudo update-ca-certificates'"#.to_string()
    }

    fn get_der_instructions() -> String {
        r#"Android Instructions:
1. Download the certificate file
2. Go to Settings > Security > Encryption & credentials > Install a certificate > CA certificate
3. Select the downloaded file
4. Enter your device PIN/password when prompted
5. The certificate will be installed as a trusted CA"#
            .to_string()
    }

    fn get_p12_instructions() -> String {
        r#"Windows Instructions:
1. Download the certificate file
2. Double-click the .p12 file
3. Follow the Certificate Import Wizard
4. Choose "Place all certificates in the following store"
5. Select "Trusted Root Certification Authorities"
6. Complete the import process"#
            .to_string()
    }

    fn get_mobileconfig_instructions() -> String {
        r#"iOS Instructions:
1. Download the configuration profile
2. Go to Settings > General > VPN & Device Management
3. Tap on the downloaded profile under "Downloaded Profile"
4. Tap "Install" and enter your passcode
5. Go to Settings > General > About > Certificate Trust Settings
6. Enable full trust for the MITM Proxy CA certificate"#
            .to_string()
    }
}

#[derive(Debug, Clone)]
pub struct DeviceInfo {
    pub platform: Platform,
    pub browser: Browser,
    pub user_agent: String,
}

#[derive(Debug, Clone)]
pub enum Platform {
    IOs,
    Android,
    Windows,
    MacOS,
    Linux,
    Unknown,
}

#[derive(Debug, Clone)]
pub enum Browser {
    Safari,
    Chrome,
    Firefox,
    Edge,
    Unknown,
}

impl DeviceInfo {
    pub fn from_user_agent(user_agent: &str) -> Self {
        let ua = user_agent.to_lowercase();

        let platform = if ua.contains("iphone") || ua.contains("ipad") {
            Platform::IOs
        } else if ua.contains("android") {
            Platform::Android
        } else if ua.contains("windows") {
            Platform::Windows
        } else if ua.contains("macintosh") || ua.contains("mac os") {
            Platform::MacOS
        } else if ua.contains("linux") {
            Platform::Linux
        } else {
            Platform::Unknown
        };

        let browser = if ua.contains("safari") && !ua.contains("chrome") {
            Browser::Safari
        } else if ua.contains("chrome") {
            Browser::Chrome
        } else if ua.contains("firefox") {
            Browser::Firefox
        } else if ua.contains("edge") {
            Browser::Edge
        } else {
            Browser::Unknown
        };

        Self {
            platform,
            browser,
            user_agent: user_agent.to_string(),
        }
    }

    pub fn recommended_format(&self) -> CertificateFormat {
        match self.platform {
            Platform::IOs => CertificateFormat::MobileConfig,
            Platform::Android => CertificateFormat::Der,
            Platform::Windows => CertificateFormat::P12,
            Platform::MacOS | Platform::Linux => CertificateFormat::Pem,
            Platform::Unknown => CertificateFormat::Pem,
        }
    }
}
