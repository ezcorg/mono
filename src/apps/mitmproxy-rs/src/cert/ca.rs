use super::{CertError, CertResult, Certificate, CertificateCache};
use anyhow::Result;
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, SanType};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::fs;
use tracing::{debug, info};

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

impl CertificateAuthority {
    pub async fn new<P: AsRef<Path>>(cert_dir: P) -> Result<Self> {
        let cert_dir = cert_dir.as_ref().to_path_buf();

        // Create certificate directory if it doesn't exist
        fs::create_dir_all(&cert_dir).await?;

        let root_cert_path = cert_dir.join("ca.crt");
        let root_key_path = cert_dir.join("ca.key");
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
}
