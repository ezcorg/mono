use super::{CertError, CertResult, Certificate, CertificateCache};
use anyhow::{Result, anyhow};
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, SanType};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use std::io;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use tokio::fs;
use tracing::{debug, info, warn, error};

#[derive(Clone)]
pub struct CertificateAuthority {
    root_cert: Arc<rcgen::Certificate>,
    root_key: Arc<KeyPair>,
    cert_cache: Arc<CertificateCache>,
    cert_dir: PathBuf,
}

impl std::fmt::Debug for CertificateAuthority {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CertificateAuthority")
            .field("cert_dir", &self.cert_dir)
            .field("cert_cache", &"<CertificateCache>")
            .finish()
    }
}

pub fn get_root_cert_path(cert_dir: &Path) -> PathBuf {
    cert_dir.join("ca.crt")
}

pub fn get_root_key_path(cert_dir: &Path) -> PathBuf {
    cert_dir.join("ca.key")
}

impl CertificateAuthority {
    pub async fn new<P: AsRef<Path>>(cert_dir: P) -> Result<Self> {
        let cert_dir = cert_dir.as_ref().to_path_buf();

        // Create certificate directory if it doesn't exist
        fs::create_dir_all(&cert_dir).await?;

        let root_cert_path = get_root_cert_path(&cert_dir);
        let root_key_path = get_root_key_path(&cert_dir);
        let (root_cert, root_key) = if root_cert_path.exists() && root_key_path.exists() {
            info!("Loading existing root certificate");
            Self::load_root_certificate(&root_cert_path, &root_key_path).await?
        } else {
            info!("Generating new root certificate");
            let (cert, key) = Self::generate_root_certificate().await?;
            Self::save_root_certificate(&cert, &key, &root_cert_path, &root_key_path).await?;
            (cert, key)
        };

        let cert_cache = Arc::new(CertificateCache::new(1000));

        Ok(Self {
            root_cert: Arc::new(root_cert),
            root_key: Arc::new(root_key),
            cert_cache,
            cert_dir,
        })
    }

    async fn generate_root_certificate() -> CertResult<(rcgen::Certificate, KeyPair)> {
        let mut params = CertificateParams::default();

        let mut distinguished_name = DistinguishedName::new();
        distinguished_name.push(DnType::CommonName, "MITM Proxy Root CA");
        distinguished_name.push(DnType::OrganizationName, "MITM Proxy");
        distinguished_name.push(DnType::CountryName, "US");

        params.distinguished_name = distinguished_name;
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        params.key_usages = vec![
            rcgen::KeyUsagePurpose::KeyCertSign,
            rcgen::KeyUsagePurpose::CrlSign,
        ];

        let not_before = time::OffsetDateTime::now_utc() - time::Duration::days(1);
        let not_after = not_before + time::Duration::days(365 * 10);
        params.not_before = not_before;
        params.not_after = not_after;

        let key_pair = KeyPair::generate()?;
        let cert = params.self_signed(&key_pair)?;
        Ok((cert, key_pair))
    }
    async fn load_root_certificate(
        cert_path: &Path,
        key_path: &Path,
    ) -> CertResult<(rcgen::Certificate, KeyPair)> {
        let _cert_pem = fs::read_to_string(cert_path).await?;
        let key_pem = fs::read_to_string(key_path).await?;

        let key_pair = KeyPair::from_pem(&key_pem)?;

        let mut params = CertificateParams::default();

        let mut distinguished_name = DistinguishedName::new();
        distinguished_name.push(DnType::CommonName, "MITM Proxy Root CA");
        distinguished_name.push(DnType::OrganizationName, "MITM Proxy");
        distinguished_name.push(DnType::CountryName, "US");

        params.distinguished_name = distinguished_name;
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        params.key_usages = vec![
            rcgen::KeyUsagePurpose::KeyCertSign,
            rcgen::KeyUsagePurpose::CrlSign,
        ];

        let cert = params.self_signed(&key_pair)?;
        Ok((cert, key_pair))
    }

    async fn save_root_certificate(
        cert: &rcgen::Certificate,
        key: &KeyPair,
        cert_path: &Path,
        key_path: &Path,
    ) -> CertResult<()> {
        let cert_pem = cert.pem();
        let key_pem = key.serialize_pem();

        fs::write(cert_path, cert_pem).await?;
        fs::write(key_path, key_pem).await?;

        info!("Root certificate saved to {:?}", cert_path);
        Ok(())
    }

    pub async fn get_certificate_for_domain(&self, domain: &str) -> CertResult<Certificate> {
        // Check cache first
        if let Some(cert) = self.cert_cache.get(domain).await {
            debug!("Certificate cache hit for domain: {}", domain);
            return Ok(cert);
        }

        debug!("Generating new certificate for domain: {}", domain);

        // Generate new certificate
        let cert = self.generate_domain_certificate(domain).await?;

        // Cache the certificate
        self.cert_cache
            .insert(domain.to_string(), cert.clone())
            .await;

        Ok(cert)
    }
    async fn generate_domain_certificate(&self, domain: &str) -> CertResult<Certificate> {
        let mut params = CertificateParams::default();

        // Add subject alternative names
        if let Ok(ip) = domain.parse::<IpAddr>() {
            params.subject_alt_names.push(rcgen::SanType::IpAddress(ip));
        } else {
            params.subject_alt_names.push(rcgen::SanType::DnsName(
                rcgen::Ia5String::try_from(domain.to_string())
                    .map_err(|_| CertError::InvalidFormat)?,
            ));
        }

        // If it's a wildcard domain, add the base domain too
        if domain.starts_with("*.") {
            let base_domain = &domain[2..];
            params.subject_alt_names.push(SanType::DnsName(
                base_domain
                    .try_into()
                    .map_err(|_| CertError::InvalidFormat)?,
            ));
        }

        let mut distinguished_name = DistinguishedName::new();
        distinguished_name.push(DnType::CommonName, domain);
        params.distinguished_name = distinguished_name;

        // Set as end-entity certificate
        params.is_ca = rcgen::IsCa::NoCa;
        params.key_usages = vec![
            rcgen::KeyUsagePurpose::DigitalSignature,
            rcgen::KeyUsagePurpose::KeyEncipherment,
        ];
        params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];

        // Set validity period (1 year)
        let not_before = time::OffsetDateTime::now_utc() - time::Duration::days(1);
        let not_after = not_before + time::Duration::days(365);
        params.not_before = not_before;
        params.not_after = not_after;

        // Generate key pair and create certificate
        let key_pair = KeyPair::generate()?;

        let cert = params.signed_by(&key_pair, &*self.root_cert, &*self.root_key)?;
        let pem_cert = cert.pem();
        let cert_der = cert.der();

        let key_der = key_pair.serialize_der();
        let pem_key = key_pair.serialize_pem();

        Ok(Certificate {
            cert_der: CertificateDer::from(cert_der.to_vec()),
            key_der: PrivateKeyDer::try_from(key_der).map_err(|_| CertError::InvalidFormat)?,
            pem_cert,
            pem_key,
        })
    }

    pub fn get_root_certificate_pem(&self) -> CertResult<String> {
        Ok(self.root_cert.pem())
    }

    pub fn get_root_certificate_der(&self) -> CertResult<Vec<u8>> {
        Ok(self.root_cert.der().to_vec())
    }

    pub async fn clear_cache(&self) {
        self.cert_cache.clear().await;
        info!("Certificate cache cleared");
    }

    pub async fn cache_stats(&self) -> (usize, usize) {
        let size = self.cert_cache.size().await;
        (size, 1000) // (current_size, max_size)
    }

    /// Install the root CA certificate to the system trust store
    pub async fn install_root_certificate(&self, yes: bool, dry_run: bool) -> Result<()> {
        let root_cert_path = get_root_cert_path(&self.cert_dir);
        let platform = detect_platform()?;
        debug!("Detected platform: {:?}", platform);

        if dry_run {
            info!("DRY RUN: Would install root certificate for platform: {:?}", platform);
            info!("DRY RUN: Certificate path: {:?}", root_cert_path);
            return Ok(());
        }

        if !yes {
            info!("This command will install the witmproxy root CA certificate to your system's trust store.");
            info!("This will allow the system to trust certificates issued by witmproxy.");
            info!("Certificate location: {:?}", root_cert_path);
            info!("Do you want to continue? [y/N]");
            
            let mut input = String::new();
            io::stdin().read_line(&mut input)?;
            if !input.trim().to_lowercase().starts_with('y') {
                info!("Installation cancelled.");
                return Ok(());
            }
        }

        match platform {
            Platform::MacOS => self.install_macos(&root_cert_path).await,
            Platform::Linux => self.install_linux(&root_cert_path).await,
            Platform::Windows => self.install_windows(&root_cert_path).await,
            Platform::Unknown(os) => {
                warn!("Unsupported platform: {}. Manual installation required.", os);
                self.print_manual_instructions(&root_cert_path).await
            }
        }
    }

    /// Remove the root CA certificate from the system trust store
    pub async fn remove_root_certificate(&self, yes: bool, dry_run: bool) -> Result<()> {
        let platform = detect_platform()?;
        info!("Detected platform: {:?}", platform);

        if dry_run {
            info!("DRY RUN: Would remove root certificate for platform: {:?}", platform);
            return Ok(());
        }

        if !yes {
            info!("This command will remove the witmproxy root CA certificate from your system's trust store.");
            info!("Do you want to continue? [y/N]");
            
            let mut input = String::new();
            io::stdin().read_line(&mut input)?;
            if !input.trim().to_lowercase().starts_with('y') {
                info!("Removal cancelled.");
                return Ok(());
            }
        }

        match platform {
            Platform::MacOS => self.remove_macos().await,
            Platform::Linux => self.remove_linux().await,
            Platform::Windows => self.remove_windows().await,
            Platform::Unknown(os) => {
                warn!("Unsupported platform: {}. Manual removal required.", os);
                self.print_manual_removal_instructions().await
            }
        }
    }

    /// Check the status of the root CA certificate in the system trust store
    pub async fn check_root_certificate_status(&self) -> Result<()> {
        let root_cert_path = get_root_cert_path(&self.cert_dir);
        let platform = detect_platform()?;
        
        info!("Certificate Authority Status");
        info!("============================");
        info!("Platform: {:?}", platform);
        info!("Certificate path: {:?}", root_cert_path);
        info!("Certificate exists: {}", root_cert_path.exists());
        
        if root_cert_path.exists() {
            match platform {
                Platform::MacOS => self.check_macos_status().await,
                Platform::Linux => self.check_linux_status().await,
                Platform::Windows => self.check_windows_status().await,
                Platform::Unknown(os) => {
                    info!("Trust status: Unknown (unsupported platform: {})", os);
                    Ok(())
                }
            }
        } else {
            info!("Trust status: Certificate not found");
            Ok(())
        }
    }

    // Platform-specific installation methods
    async fn install_macos(&self, cert_path: &Path) -> Result<()> {
        info!("Installing root certificate on macOS via Keychain");
        
        info!("Installing certificate to system keychain...");
        info!("You may be prompted for your password to access the System keychain.");
        
        let output = Command::new("sudo")
            .args(&["security", "add-trusted-cert", "-d", "-r", "trustRoot", "-k", "/Library/Keychains/System.keychain"])
            .arg(cert_path)
            .output()?;

        if output.status.success() {
            info!("✓ Certificate successfully installed to System keychain");
        } else {
            error!("Failed to install certificate: {}", String::from_utf8_lossy(&output.stderr));
            return Err(anyhow!("Failed to install certificate to macOS keychain"));
        }

        Ok(())
    }

    async fn install_linux(&self, cert_path: &Path) -> Result<()> {
        info!("Installing root certificate on Linux");
        
        // Try different approaches based on what's available on the system
        if Path::new("/usr/local/share/ca-certificates").exists() {
            // Ubuntu/Debian approach
            info!("Installing certificate via ca-certificates...");
            info!("You may be prompted for your password (sudo access required).");
            
            let cert_name = "witmproxy-root-ca.crt";
            let dest_path = format!("/usr/local/share/ca-certificates/{}", cert_name);
            
            let output = Command::new("sudo")
                .args(&["cp"])
                .arg(cert_path)
                .arg(&dest_path)
                .output()?;

            if !output.status.success() {
                return Err(anyhow!("Failed to copy certificate: {}", String::from_utf8_lossy(&output.stderr)));
            }

            let output = Command::new("sudo")
                .args(&["update-ca-certificates"])
                .output()?;

            if output.status.success() {
                info!("✓ Certificate successfully installed via update-ca-certificates");
            } else {
                error!("Failed to update certificates: {}", String::from_utf8_lossy(&output.stderr));
                return Err(anyhow!("Failed to update ca-certificates"));
            }
        } else if Path::new("/etc/pki/ca-trust/source/anchors").exists() {
            // RHEL/CentOS/Fedora approach
            info!("Installing certificate via ca-trust...");
            info!("You may be prompted for your password (sudo access required).");

            let cert_name = "witmproxy-root-ca.crt";
            let dest_path = format!("/etc/pki/ca-trust/source/anchors/{}", cert_name);
            
            let output = Command::new("sudo")
                .args(&["cp"])
                .arg(cert_path)
                .arg(&dest_path)
                .output()?;

            if !output.status.success() {
                return Err(anyhow!("Failed to copy certificate: {}", String::from_utf8_lossy(&output.stderr)));
            }

            let output = Command::new("sudo")
                .args(&["update-ca-trust"])
                .output()?;

            if output.status.success() {
                info!("✓ Certificate successfully installed via update-ca-trust");
            } else {
                error!("Failed to update certificates: {}", String::from_utf8_lossy(&output.stderr));
                return Err(anyhow!("Failed to update ca-trust"));
            }
        } else {
            warn!("No supported certificate installation method found");
            self.print_manual_instructions(cert_path).await?;
        }

        Ok(())
    }

    async fn install_windows(&self, cert_path: &Path) -> Result<()> {
        info!("Installing root certificate on Windows");
        
        info!("Installing certificate to Windows certificate store...");
        info!("You may see a User Account Control prompt.");
        
        let output = Command::new("certutil")
            .args(&["-addstore", "-f", "Root"])
            .arg(cert_path)
            .output()?;

        if output.status.success() {
            info!("✓ Certificate successfully installed using certutil");
        } else {
            error!("Failed to install certificate: {}", String::from_utf8_lossy(&output.stderr));
            return Err(anyhow!("Failed to install certificate to Windows store"));
        }

        Ok(())
    }

    // Platform-specific removal methods
    async fn remove_macos(&self) -> Result<()> {
        info!("Removing root certificate from macOS Keychain");

        info!("Searching for witmproxy certificates in keychain...");

        let output = Command::new("sudo")
            .args(&["security", "delete-certificate", "-c", "MITM Proxy Root CA", "/Library/Keychains/System.keychain"])
            .output()?;

        if output.status.success() {
            info!("✓ Certificate successfully removed from macOS System keychain");
        } else {
            warn!("⚠ Certificate may not have been installed or already removed: {}", String::from_utf8_lossy(&output.stderr));
        }

        Ok(())
    }

    async fn remove_linux(&self) -> Result<()> {
        info!("Removing root certificate from Linux");
        
        let mut removed = false;
        
        // Try Ubuntu/Debian approach
        let cert_path = "/usr/local/share/ca-certificates/witmproxy-root-ca.crt";
        if Path::new(cert_path).exists() {
            info!("Removing certificate from ca-certificates...");
            
            let output = Command::new("sudo")
                .args(&["rm", cert_path])
                .output()?;

            if output.status.success() {
                let _ = Command::new("sudo")
                    .args(&["update-ca-certificates"])
                    .output()?;
                removed = true;
                info!("✓ Certificate removed via ca-certificates");
            }
        }
        
        // Try RHEL/CentOS/Fedora approach
        let cert_path = "/etc/pki/ca-trust/source/anchors/witmproxy-root-ca.crt";
        if Path::new(cert_path).exists() {
            info!("Removing certificate from ca-trust...");
            
            let output = Command::new("sudo")
                .args(&["rm", cert_path])
                .output()?;

            if output.status.success() {
                let _ = Command::new("sudo")
                    .args(&["update-ca-trust"])
                    .output()?;
                removed = true;
                info!("✓ Certificate removed via ca-trust");
            }
        }
        
        if !removed {
            info!("⚠ Certificate not found in standard locations (may already be removed)");
        }

        Ok(())
    }

    async fn remove_windows(&self) -> Result<()> {
        info!("Removing root certificate from Windows");
        
        let output = Command::new("certutil")
            .args(&["-delstore", "Root", "MITM Proxy Root CA"])
            .output()?;

        if output.status.success() || output.stderr.is_empty() {
            info!("✓ Certificate removal attempted (may already be removed)");
        } else {
            warn!("⚠ Certificate removal failed or certificate not found: {}", String::from_utf8_lossy(&output.stderr));
        }

        Ok(())
    }

    // Platform-specific status checking methods
    async fn check_macos_status(&self) -> Result<()> {
        let output = Command::new("security")
            .args(&["find-certificate", "-c", "MITM Proxy Root CA", "/Library/Keychains/System.keychain"])
            .output()?;

        if output.status.success() {
            info!("Trust status: ✓ Installed in System keychain");
        } else {
            info!("Trust status: ✗ Not found in System keychain");
        }

        Ok(())
    }

    async fn check_linux_status(&self) -> Result<()> {
        let ubuntu_path = Path::new("/usr/local/share/ca-certificates/witmproxy-root-ca.crt");
        let rhel_path = Path::new("/etc/pki/ca-trust/source/anchors/witmproxy-root-ca.crt");
        
        if ubuntu_path.exists() {
            info!("Trust status: ✓ Installed via ca-certificates");
        } else if rhel_path.exists() {
            info!("Trust status: ✓ Installed via ca-trust");
        } else {
            info!("Trust status: ✗ Not found in standard trust stores");
        }

        Ok(())
    }

    async fn check_windows_status(&self) -> Result<()> {
        let output = Command::new("certutil")
            .args(&["-store", "Root", "MITM Proxy Root CA"])
            .output()?;

        if output.status.success() && !String::from_utf8_lossy(&output.stdout).contains("ERROR") {
            info!("Trust status: ✓ Installed in Root certificate store");
        } else {
            info!("Trust status: ✗ Not found in Root certificate store");
        }

        Ok(())
    }

    async fn print_manual_instructions(&self, cert_path: &Path) -> Result<()> {
        info!("\nManual Installation Instructions");
        info!("===============================");
        info!("Please manually install the certificate located at:");
        info!("{:?}", cert_path);
        info!("\nInstructions:");
        info!("1. Open the certificate file in your system's certificate manager");
        info!("2. Install it to the 'Trusted Root Certification Authorities' store");
        info!("3. Ensure it's marked as trusted for all purposes");
        Ok(())
    }

    async fn print_manual_removal_instructions(&self) -> Result<()> {
        info!("\nManual Removal Instructions");
        info!("==========================");
        info!("Please manually remove the 'MITM Proxy Root CA' certificate from:");
        info!("- Certificate Manager / Trusted Root Certification Authorities");
        info!("- Or your system's equivalent certificate trust store");
        Ok(())
    }
}

#[derive(Debug)]
enum Platform {
    MacOS,
    Linux,
    Windows,
    Unknown(String),
}

fn detect_platform() -> Result<Platform> {
    if cfg!(target_os = "macos") {
        Ok(Platform::MacOS)
    } else if cfg!(target_os = "linux") {
        Ok(Platform::Linux)
    } else if cfg!(target_os = "windows") {
        Ok(Platform::Windows)
    } else {
        Ok(Platform::Unknown(std::env::consts::OS.to_string()))
    }
}
