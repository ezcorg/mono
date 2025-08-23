use crate::cert::{CertError, Certificate};
use rustls::pki_types::CertificateDer;
use rustls::{ClientConfig, ServerConfig};
use std::sync::Arc;

/// Create a server TLS configuration with ALPN support for multi-protocol negotiation
pub fn create_server_config(cert: Certificate) -> Result<ServerConfig, CertError> {
    let cert_chain = vec![cert.cert_der];
    let private_key = cert.key_der;

    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(cert_chain, private_key)
        .map_err(|_e| CertError::InvalidFormat)?;

    // Configure ALPN protocols in order of preference
    config.alpn_protocols = vec![
        b"h2".to_vec(),       // HTTP/2
        b"http/1.1".to_vec(), // HTTP/1.1
        b"h3".to_vec(),       // HTTP/3 (for future QUIC support)
    ];

    Ok(config)
}

/// Create a client TLS configuration with ALPN support
pub fn create_client_config() -> Result<ClientConfig, CertError> {
    let mut root_store = rustls::RootCertStore::empty();

    // Add system root certificates
    let native_certs = rustls_native_certs::load_native_certs();
    for cert in native_certs.certs {
        root_store.add(cert).ok();
    }

    let mut config = ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();

    // Configure ALPN protocols for client connections
    config.alpn_protocols = vec![
        b"h2".to_vec(),       // HTTP/2
        b"http/1.1".to_vec(), // HTTP/1.1
        b"h3".to_vec(),       // HTTP/3
    ];

    Ok(config)
}

/// Create an insecure client TLS configuration with ALPN support (for testing)
pub fn create_insecure_client_config() -> Result<ClientConfig, CertError> {
    // Create a client config that accepts any certificate (for testing)
    let mut config = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(InsecureVerifier))
        .with_no_client_auth();

    // Configure ALPN protocols for insecure client connections
    config.alpn_protocols = vec![
        b"h2".to_vec(),       // HTTP/2
        b"http/1.1".to_vec(), // HTTP/1.1
        b"h3".to_vec(),       // HTTP/3
    ];

    Ok(config)
}

/// Create a server TLS configuration with specific ALPN protocols
pub fn create_server_config_with_alpn(
    cert: Certificate,
    alpn_protocols: Vec<Vec<u8>>,
) -> Result<ServerConfig, CertError> {
    let cert_chain = vec![cert.cert_der];
    let private_key = cert.key_der;

    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(cert_chain, private_key)
        .map_err(|_e| CertError::InvalidFormat)?;

    config.alpn_protocols = alpn_protocols;

    Ok(config)
}

/// Create a client TLS configuration with specific ALPN protocols
pub fn create_client_config_with_alpn(
    alpn_protocols: Vec<Vec<u8>>,
) -> Result<ClientConfig, CertError> {
    let mut root_store = rustls::RootCertStore::empty();

    // Add system root certificates
    let native_certs = rustls_native_certs::load_native_certs();
    for cert in native_certs.certs {
        root_store.add(cert).ok();
    }

    let mut config = ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();

    config.alpn_protocols = alpn_protocols;

    Ok(config)
}

#[derive(Debug)]
struct InsecureVerifier;

impl rustls::client::danger::ServerCertVerifier for InsecureVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        vec![
            rustls::SignatureScheme::RSA_PKCS1_SHA1,
            rustls::SignatureScheme::ECDSA_SHA1_Legacy,
            rustls::SignatureScheme::RSA_PKCS1_SHA256,
            rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
            rustls::SignatureScheme::RSA_PKCS1_SHA384,
            rustls::SignatureScheme::ECDSA_NISTP384_SHA384,
            rustls::SignatureScheme::RSA_PKCS1_SHA512,
            rustls::SignatureScheme::ECDSA_NISTP521_SHA512,
            rustls::SignatureScheme::RSA_PSS_SHA256,
            rustls::SignatureScheme::RSA_PSS_SHA384,
            rustls::SignatureScheme::RSA_PSS_SHA512,
            rustls::SignatureScheme::ED25519,
            rustls::SignatureScheme::ED448,
        ]
    }
}
