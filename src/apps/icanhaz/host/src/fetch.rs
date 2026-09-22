//! Where a component's bytes come from when they are not on this machine:
//! an OCI registry (`oci://ghcr.io/org/name:tag`, the way `wkg` and
//! wassette publish components), or another daemon that holds it
//! (`iroh:<key>?addr=…#sha256:<hex>`, over the peer path). Fetching is a
//! transfer, never a grant: what arrives is verified against the digest it
//! was announced under, stored by its hash with the source as provenance,
//! and sits inert until a grant names it.

use std::fmt;
use std::sync::Arc;

use anyhow::Context as _;
use oci_client::client::{Client, ClientConfig};
use oci_client::secrets::RegistryAuth;
use oci_client::Reference;
use oci_wasm::{WasmClient, WASM_LAYER_MEDIA_TYPE};
use sha2::{Digest as _, Sha256};

use crate::components::Provenance;
use crate::remote::Remotes;
use icanhaz_broker::configuration::{Declared, Field, InputType, Value};
use icanhaz_broker::store::Store;

/// `sha256:<hex>` of `bytes`: how components, layers and manifests are named.
pub fn digest_of(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

/// A place a component can be fetched from.
#[derive(Debug, Clone, PartialEq)]
pub enum ComponentSource {
    /// An OCI reference: `registry/name:tag` or `registry/name@sha256:…`.
    Oci(Reference),
    /// A component another daemon holds, by that daemon's locator and the
    /// component's hash.
    Peer { locator: String, hash: String },
}

impl ComponentSource {
    /// Whether `s` names a source rather than a local path.
    pub fn is_source(s: &str) -> bool {
        s.starts_with("oci://") || s.starts_with("iroh:")
    }

    pub fn parse(s: &str) -> anyhow::Result<Self> {
        if let Some(rest) = s.strip_prefix("oci://") {
            let reference: Reference = rest
                .parse()
                .with_context(|| format!("`{s}` is not an OCI reference"))?;
            return Ok(Self::Oci(reference));
        }
        if s.starts_with("iroh:") {
            let (locator, hash) = s.split_once('#').with_context(|| {
                format!("`{s}`: a peer source is `iroh:<key>?addr=…#sha256:<hex>`")
            })?;
            anyhow::ensure!(
                hash.starts_with("sha256:") && hash.len() == 7 + 64,
                "`{s}`: the fragment must be the component's `sha256:<hex>`"
            );
            crate::remote::parse_locator(locator)?;
            return Ok(Self::Peer {
                locator: locator.to_string(),
                hash: hash.to_string(),
            });
        }
        anyhow::bail!("`{s}` is not a component source: expected `oci://…` or `iroh:…#sha256:…`")
    }
}

impl fmt::Display for ComponentSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Oci(r) => write!(f, "oci://{}", r.whole()),
            Self::Peer { locator, hash } => write!(f, "{locator}#{hash}"),
        }
    }
}

/// How this daemon authenticates to registries, by registry host: what the
/// human configured in the store (`registries/<host>`, a username and a
/// secret password), else the credential the user's Docker client keeps
/// (`docker login <host>`), else anonymous.
#[derive(Default)]
pub struct Credentials {
    configured: std::sync::RwLock<std::collections::HashMap<String, (String, String)>>,
}

impl Credentials {
    /// The store owner prefix registry credentials live under.
    pub const OWNER_PREFIX: &'static str = "registries/";

    pub fn shared() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// The configuration the tray renders: one instance per registry host.
    pub fn declared() -> Declared {
        Declared::new(
            "registries",
            "registry",
            vec![
                Field::new("username", InputType::Str, "The account at the registry"),
                Field::new("password", InputType::Secret, "Its password or access token"),
            ],
        )
        .describe(
            "How this daemon signs in to OCI registries it pulls components from or pushes them to. \
             Name each instance after the registry host (ghcr.io). Without one, the credential the \
             Docker client keeps for the host is used, else the pull is anonymous.",
        )
    }

    /// Re-read the configured credentials.
    pub async fn reload(&self, store: &Store) {
        let mut configured = std::collections::HashMap::new();
        match store.owners(Self::OWNER_PREFIX).await {
            Ok(owners) => {
                for owner in owners {
                    let host = owner
                        .strip_prefix(Self::OWNER_PREFIX)
                        .unwrap_or(&owner)
                        .to_string();
                    let rows = match store.configuration(&owner).await {
                        Ok(rows) => rows,
                        Err(e) => {
                            tracing::warn!(error = %e, owner, "could not read a registry credential");
                            continue;
                        }
                    };
                    let get = |field: &str| -> Option<String> {
                        rows.iter().find(|(n, _)| n == field).and_then(|(_, v)| {
                            serde_json::from_value::<Value>(v.clone())
                                .ok()
                                .and_then(|v| v.text().map(str::to_string))
                        })
                    };
                    if let (Some(user), Some(pass)) = (get("username"), get("password")) {
                        configured.insert(host, (user, pass));
                    }
                }
            }
            Err(e) => tracing::warn!(error = %e, "could not list registry credentials"),
        }
        *self.configured.write().unwrap_or_else(|e| e.into_inner()) = configured;
    }

    /// Set a credential directly (tests, or a daemon without a store).
    pub fn set(&self, host: &str, username: &str, password: &str) {
        self.configured
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                host.to_string(),
                (username.to_string(), password.to_string()),
            );
    }

    /// The credential to present to `registry`.
    pub fn auth_for(&self, registry: &str) -> RegistryAuth {
        if let Some((user, pass)) = self
            .configured
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(registry)
        {
            return RegistryAuth::Basic(user.clone(), pass.clone());
        }
        match docker_credential::get_credential(registry) {
            Ok(docker_credential::DockerCredential::UsernamePassword(user, pass)) => {
                RegistryAuth::Basic(user, pass)
            }
            Ok(docker_credential::DockerCredential::IdentityToken(token)) => {
                RegistryAuth::Bearer(token)
            }
            Err(_) => RegistryAuth::Anonymous,
        }
    }
}

/// Fetches components: an OCI client with the daemon's credentials, and the
/// peer connections when the daemon has a peer endpoint.
pub struct Fetcher {
    oci: WasmClient,
    credentials: Arc<Credentials>,
    remotes: Option<Remotes>,
}

impl Fetcher {
    pub fn new(remotes: Option<Remotes>, credentials: Arc<Credentials>) -> Self {
        Self::with_config(ClientConfig::default(), remotes, credentials)
    }

    /// With an explicit OCI client configuration (a test's plain-HTTP registry).
    pub fn with_config(
        config: ClientConfig,
        remotes: Option<Remotes>,
        credentials: Arc<Credentials>,
    ) -> Self {
        Self {
            oci: WasmClient::new(Client::new(config)),
            credentials,
            remotes,
        }
    }

    pub fn shared(remotes: Option<Remotes>, credentials: Arc<Credentials>) -> Arc<Self> {
        Arc::new(Self::new(remotes, credentials))
    }

    /// The component's bytes and the provenance they arrived with. The bytes
    /// are verified against the digest the source announced them under.
    pub async fn fetch(&self, source: &ComponentSource) -> anyhow::Result<(Vec<u8>, Provenance)> {
        match source {
            ComponentSource::Oci(reference) => self.fetch_oci(reference).await,
            ComponentSource::Peer { locator, hash } => self.fetch_peer(locator, hash).await,
        }
    }

    async fn fetch_oci(&self, reference: &Reference) -> anyhow::Result<(Vec<u8>, Provenance)> {
        let auth = self.credentials.auth_for(reference.resolve_registry());
        let image = self
            .oci
            .pull(reference, &auth)
            .await
            .with_context(|| format!("pull oci://{}", reference.whole()))?;
        // The component is the wasm layer; a single-layer artifact from an
        // older publisher may not label it.
        let (index, layer) = image
            .layers
            .iter()
            .enumerate()
            .find(|(_, l)| l.media_type == WASM_LAYER_MEDIA_TYPE)
            .or_else(|| (image.layers.len() == 1).then(|| (0, &image.layers[0])))
            .with_context(|| {
                format!(
                    "oci://{}: no `{WASM_LAYER_MEDIA_TYPE}` layer among {:?}",
                    reference.whole(),
                    image
                        .layers
                        .iter()
                        .map(|l| l.media_type.as_str())
                        .collect::<Vec<_>>()
                )
            })?;
        // The manifest names the layer by digest; hold the bytes to it.
        if let Some(descriptor) = image.manifest.as_ref().and_then(|m| m.layers.get(index)) {
            let actual = format!("sha256:{:x}", Sha256::digest(&layer.data));
            anyhow::ensure!(
                descriptor.digest == actual,
                "oci://{}: the wasm layer's bytes hash to {actual}, not the {} the manifest names",
                reference.whole(),
                descriptor.digest
            );
        }
        let provenance = Provenance {
            source: format!("oci://{}", reference.whole()),
            revision: image.digest.clone(),
            build: None,
            builder: None,
        };
        Ok((layer.data.to_vec(), provenance))
    }

    async fn fetch_peer(&self, locator: &str, hash: &str) -> anyhow::Result<(Vec<u8>, Provenance)> {
        let remotes = self
            .remotes
            .as_ref()
            .context("no peer endpoint: this daemon cannot reach other daemons")?;
        let client = remotes.client(locator).await?;
        let bytes = crate::components::client::get(&client, (), hash)
            .await
            .with_context(|| format!("components.get at {locator}"))?
            .map_err(|e| anyhow::anyhow!("{locator} has no component {hash}: {e}"))?;
        let actual = format!("sha256:{:x}", Sha256::digest(&bytes));
        anyhow::ensure!(
            actual == hash,
            "{locator} sent bytes hashing to {actual}, not the {hash} asked for"
        );
        Ok((
            bytes.to_vec(),
            Provenance {
                source: locator.to_string(),
                revision: Some(hash.to_string()),
                build: None,
                builder: None,
            },
        ))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn sources_parse_and_print() {
        let oci = ComponentSource::parse("oci://ghcr.io/microsoft/time-server-js:latest").unwrap();
        assert_eq!(
            oci.to_string(),
            "oci://ghcr.io/microsoft/time-server-js:latest"
        );
        assert!(matches!(&oci, ComponentSource::Oci(r) if r.tag() == Some("latest")));
        let key = ezcap::Keypair::generate().unwrap().public();
        let hash = format!("sha256:{}", "ab".repeat(32));
        let peer =
            ComponentSource::parse(&format!("iroh:{key}?addr=127.0.0.1:4433#{hash}")).unwrap();
        assert!(matches!(&peer, ComponentSource::Peer { hash: h, .. } if h == &hash));
        assert!(ComponentSource::parse("iroh:notakey#sha256:00").is_err());
        assert!(ComponentSource::parse("./local.wasm").is_err());
        assert!(!ComponentSource::is_source("./local.wasm"));
    }

    use std::collections::HashMap;

    use oci_client::client::ClientProtocol;
    use oci_wasm::{WasmConfig, WASM_MANIFEST_CONFIG_MEDIA_TYPE, WASM_MANIFEST_MEDIA_TYPE};
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    fn digest(bytes: &[u8]) -> String {
        format!("sha256:{:x}", Sha256::digest(bytes))
    }

    /// The smallest OCI registry that serves one wasm artifact under `name`
    /// at `latest`: the manifest, its config, the layer. `served` is what the
    /// layer blob actually returns, so a test can tamper with it.
    pub(crate) async fn registry(name: &str, wasm: &[u8], served: Vec<u8>) -> (String, String) {
        let (config, _) = WasmConfig::from_raw_component(wasm.to_vec(), None).unwrap();
        let config_bytes = serde_json::to_vec(&config).unwrap();
        let config_digest = digest(&config_bytes);
        let layer_digest = digest(wasm);
        let manifest = serde_json::json!({
            "schemaVersion": 2,
            "mediaType": WASM_MANIFEST_MEDIA_TYPE,
            "config": { "mediaType": WASM_MANIFEST_CONFIG_MEDIA_TYPE, "digest": config_digest, "size": config_bytes.len() },
            "layers": [{ "mediaType": WASM_LAYER_MEDIA_TYPE, "digest": layer_digest, "size": wasm.len() }],
        });
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        let manifest_digest = digest(&manifest_bytes);
        let mut blobs: HashMap<String, Vec<u8>> = HashMap::new();
        blobs.insert(config_digest, config_bytes);
        blobs.insert(layer_digest, served);
        let routes = Arc::new((
            name.to_string(),
            manifest_bytes,
            manifest_digest.clone(),
            blobs,
        ));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            while let Ok((mut conn, _)) = listener.accept().await {
                let routes = Arc::clone(&routes);
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n")
                        && conn.read(&mut byte).await.unwrap_or(0) == 1
                    {
                        head.push(byte[0]);
                    }
                    let request = String::from_utf8_lossy(&head).into_owned();
                    let mut words = request.split_whitespace();
                    let (method, path) = (words.next().unwrap_or(""), words.next().unwrap_or(""));
                    let (name, manifest, manifest_digest, blobs) = &*routes;
                    let (status, content_type, body, extra) = if path == "/v2/" {
                        (200, "application/json", b"{}".to_vec(), String::new())
                    } else if let Some(reference) =
                        path.strip_prefix(&format!("/v2/{name}/manifests/"))
                    {
                        if reference == "latest" || reference == manifest_digest {
                            (
                                200,
                                WASM_MANIFEST_MEDIA_TYPE,
                                manifest.clone(),
                                format!("Docker-Content-Digest: {manifest_digest}\r\n"),
                            )
                        } else {
                            (
                                404,
                                "text/plain",
                                b"no such manifest".to_vec(),
                                String::new(),
                            )
                        }
                    } else if let Some(d) = path.strip_prefix(&format!("/v2/{name}/blobs/")) {
                        match blobs.get(d) {
                            Some(b) => (
                                200,
                                "application/octet-stream",
                                b.clone(),
                                format!("Docker-Content-Digest: {d}\r\n"),
                            ),
                            None => (404, "text/plain", b"no such blob".to_vec(), String::new()),
                        }
                    } else {
                        (404, "text/plain", b"nope".to_vec(), String::new())
                    };
                    let mut response = format!(
                        "HTTP/1.1 {status} OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
                        body.len()
                    )
                    .into_bytes();
                    if method != "HEAD" {
                        response.extend_from_slice(&body);
                    }
                    let _ = conn.write_all(&response).await;
                    let _ = conn.shutdown().await;
                });
            }
        });
        (addr, manifest_digest)
    }

    pub(crate) fn plain_http() -> ClientConfig {
        ClientConfig {
            protocol: ClientProtocol::Http,
            ..ClientConfig::default()
        }
    }

    #[tokio::test]
    async fn pulls_a_component_from_an_oci_registry_and_records_where_from() {
        let greeter = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/greeter.wasm"
        ))
        .expect("greeter.wasm fixture");
        let (addr, manifest_digest) = registry("acme/greeter", &greeter, greeter.clone()).await;
        let fetcher = Fetcher::with_config(plain_http(), None, Credentials::shared());
        let source = ComponentSource::parse(&format!("oci://{addr}/acme/greeter:latest")).unwrap();
        let (bytes, provenance) = fetcher.fetch(&source).await.expect("pulled");
        assert_eq!(bytes, greeter);
        // The tag is resolved to the manifest digest and that is what is kept.
        assert_eq!(
            provenance.source,
            format!("oci://{addr}/acme/greeter:latest")
        );
        assert_eq!(
            provenance.revision.as_deref(),
            Some(manifest_digest.as_str())
        );
        // What lands in the store is the component by its own hash.
        assert_eq!(
            crate::components::validate(&bytes).unwrap().hash,
            digest(&greeter)
        );
    }

    #[tokio::test]
    async fn refuses_a_layer_whose_bytes_are_not_what_the_manifest_names() {
        let greeter = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/greeter.wasm"
        ))
        .expect("greeter.wasm fixture");
        let mut tampered = greeter.clone();
        tampered.push(0);
        let (addr, _) = registry("acme/greeter", &greeter, tampered).await;
        let fetcher = Fetcher::with_config(plain_http(), None, Credentials::shared());
        let source = ComponentSource::parse(&format!("oci://{addr}/acme/greeter:latest")).unwrap();
        let err = fetcher.fetch(&source).await.expect_err("refused");
        let text = format!("{err:#}").to_lowercase();
        assert!(text.contains("digest") || text.contains("hash"), "{text}");
    }
}
