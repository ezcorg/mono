pub mod ca;
pub mod generator;

pub use ca::CertificateAuthority;
pub use generator::{CertificateGenerator, CertificateFormat};

use anyhow::Result;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug)]
pub struct Certificate {
    pub cert_der: CertificateDer<'static>,
    pub key_der: PrivateKeyDer<'static>,
    pub pem_cert: String,
    pub pem_key: String,
}

impl Clone for Certificate {
    fn clone(&self) -> Self {
        Self {
            cert_der: self.cert_der.clone(),
            key_der: self.key_der.clone_key(),
            pem_cert: self.pem_cert.clone(),
            pem_key: self.pem_key.clone(),
        }
    }
}

#[derive(Debug)]
pub struct CertificateCache {
    cache: Arc<RwLock<HashMap<String, Certificate>>>,
    max_size: usize,
}

impl CertificateCache {
    pub fn new(max_size: usize) -> Self {
        Self {
            cache: Arc::new(RwLock::new(HashMap::new())),
            max_size,
        }
    }

    pub async fn get(&self, domain: &str) -> Option<Certificate> {
        let cache = self.cache.read().await;
        cache.get(domain).cloned()
    }

    pub async fn insert(&self, domain: String, cert: Certificate) {
        let mut cache = self.cache.write().await;
        
        // Simple LRU eviction - remove oldest entries if cache is full
        if cache.len() >= self.max_size {
            if let Some(key) = cache.keys().next().cloned() {
                cache.remove(&key);
            }
        }
        
        cache.insert(domain, cert);
    }

    pub async fn clear(&self) {
        let mut cache = self.cache.write().await;
        cache.clear();
    }

    pub async fn size(&self) -> usize {
        let cache = self.cache.read().await;
        cache.len()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CertError {
    #[error("Certificate generation failed: {0}")]
    Generation(#[from] rcgen::Error),
    
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    
    #[error("Invalid certificate format")]
    InvalidFormat,
    
    #[error("Certificate not found for domain: {0}")]
    NotFound(String),
}

pub type CertResult<T> = Result<T, CertError>;