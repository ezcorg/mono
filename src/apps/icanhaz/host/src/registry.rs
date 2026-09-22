//! The daemon's own OCI registry, when one is served: the component store
//! behind the distribution API, so `wkg`, `oras`, wassette and another
//! icanhaz can pull a component by `name:tag` and push one. It holds only
//! capability components: a pushed layer must validate under the same rule
//! as `components.add`, a manifest must be one wasm layer over a wasm
//! config, and a tag is a pointer at a manifest generated once from a held
//! component, so the digest is the identity throughout. Every request needs
//! the registry credential (`registry` in the configuration): a component's
//! bytes are their author's, so pulls are gated like pushes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Context as _;
use bytes::Bytes;
use http_body_util::{BodyExt as _, Full};
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use oci_wasm::{
    WasmConfig, WASM_LAYER_MEDIA_TYPE, WASM_MANIFEST_CONFIG_MEDIA_TYPE, WASM_MANIFEST_MEDIA_TYPE,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::components::{ComponentStore, Provenance};
use icanhaz_broker::configuration::{Declared, Field, InputType, Value, SINGLE};
use icanhaz_broker::store::Store;

/// The store owner the registry's index lives under.
const OWNER: &str = "registry";
/// A chunked upload may not grow past this.
const MAX_UPLOAD: usize = 256 << 20;

/// What a tag points at.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Published {
    pub reference: String,
    pub digest: String,
    pub hash: String,
}

/// The index: tags to manifests, manifests and configs by digest, over the
/// component store for the layers. Shared by the served registry and the
/// `components` interface's `publish`.
pub struct RegistryIndex {
    components: Arc<ComponentStore>,
    store: Option<Store>,
    /// Without a store, an in-memory index (tests, a daemon with no store).
    memory: Mutex<HashMap<String, Vec<u8>>>,
}

impl RegistryIndex {
    pub fn new(components: Arc<ComponentStore>, store: Option<Store>) -> Arc<Self> {
        Arc::new(Self {
            components,
            store,
            memory: Mutex::new(HashMap::new()),
        })
    }

    async fn get(&self, key: &str) -> Option<Vec<u8>> {
        match &self.store {
            Some(store) => store.state_get(OWNER, key).await.ok().flatten(),
            None => self
                .memory
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(key)
                .cloned(),
        }
    }

    async fn set(&self, key: &str, value: &[u8]) -> anyhow::Result<()> {
        match &self.store {
            Some(store) => store.state_set(OWNER, key, value).await,
            None => {
                self.memory
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(key.to_string(), value.to_vec());
                Ok(())
            }
        }
    }

    async fn delete(&self, key: &str) -> anyhow::Result<bool> {
        match &self.store {
            Some(store) => store.state_delete(OWNER, key).await,
            None => Ok(self
                .memory
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(key)
                .is_some()),
        }
    }

    async fn list(&self, prefix: &str) -> Vec<(String, Vec<u8>)> {
        match &self.store {
            Some(store) => store.state_list(OWNER, prefix).await.unwrap_or_default(),
            None => self
                .memory
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .filter(|(k, _)| k.starts_with(prefix))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        }
    }

    /// `name:tag` split and checked: an OCI repository name and a tag.
    fn split_reference(reference: &str) -> anyhow::Result<(String, String)> {
        let (name, tag) = reference
            .rsplit_once(':')
            .with_context(|| format!("`{reference}` is not `<name>:<tag>`"))?;
        let name_ok = !name.is_empty()
            && name.split('/').all(|p| {
                !p.is_empty()
                    && p.chars().all(|c| {
                        c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-')
                    })
            });
        let tag_ok = !tag.is_empty()
            && tag.len() <= 128
            && tag
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
        anyhow::ensure!(
            name_ok,
            "`{name}` is not an OCI repository name (lowercase, digits, `.`, `_`, `-`, `/`)"
        );
        anyhow::ensure!(tag_ok, "`{tag}` is not an OCI tag");
        Ok((name.to_string(), tag.to_string()))
    }

    /// Publish a held component under `reference`: generate its config and
    /// manifest once, keep both by digest, point the tag at the manifest.
    pub async fn publish(&self, hash: &str, reference: &str) -> anyhow::Result<Published> {
        let (name, tag) = Self::split_reference(reference)?;
        let bytes = self.components.get(hash)?;
        let (config, _) = WasmConfig::from_raw_component(bytes.clone(), None)
            .context("describe the component for its config")?;
        let config_bytes = serde_json::to_vec(&config)?;
        let config_digest = digest(&config_bytes);
        let manifest = serde_json::json!({
            "schemaVersion": 2,
            "mediaType": WASM_MANIFEST_MEDIA_TYPE,
            "config": { "mediaType": WASM_MANIFEST_CONFIG_MEDIA_TYPE, "digest": config_digest, "size": config_bytes.len() },
            "layers": [{ "mediaType": WASM_LAYER_MEDIA_TYPE, "digest": hash, "size": bytes.len() }],
        });
        let manifest_bytes = serde_json::to_vec(&manifest)?;
        let manifest_digest = digest(&manifest_bytes);
        self.set(&format!("blob:{config_digest}"), &config_bytes)
            .await?;
        self.set(&format!("manifest:{manifest_digest}"), &manifest_bytes)
            .await?;
        let published = Published {
            reference: format!("{name}:{tag}"),
            digest: manifest_digest,
            hash: hash.to_string(),
        };
        self.set(
            &format!("tag:{name}:{tag}"),
            &serde_json::to_vec(&published)?,
        )
        .await?;
        Ok(published)
    }

    pub async fn unpublish(&self, reference: &str) -> anyhow::Result<bool> {
        let (name, tag) = Self::split_reference(reference)?;
        self.delete(&format!("tag:{name}:{tag}")).await
    }

    pub async fn published(&self) -> Vec<Published> {
        self.list("tag:")
            .await
            .into_iter()
            .filter_map(|(_, v)| serde_json::from_slice(&v).ok())
            .collect()
    }

    async fn tag(&self, name: &str, tag: &str) -> Option<Published> {
        self.get(&format!("tag:{name}:{tag}"))
            .await
            .and_then(|v| serde_json::from_slice(&v).ok())
    }

    /// A manifest by tag or digest.
    async fn manifest(&self, name: &str, reference: &str) -> Option<(String, Vec<u8>)> {
        let digest = if reference.starts_with("sha256:") {
            reference.to_string()
        } else {
            self.tag(name, reference).await?.digest
        };
        let bytes = self.get(&format!("manifest:{digest}")).await?;
        Some((digest, bytes))
    }

    /// A blob by digest: a config the index keeps, or a component's bytes.
    async fn blob(&self, digest: &str) -> Option<Vec<u8>> {
        if let Some(b) = self.get(&format!("blob:{digest}")).await {
            return Some(b);
        }
        self.components.get(digest).ok()
    }

    /// A pushed blob: a capability component (kept in the store with the
    /// pusher as its provenance) or a wasm config (kept by digest). Anything
    /// else is refused: this registry holds components and nothing else.
    async fn accept_blob(
        &self,
        bytes: &[u8],
        digest: &str,
        pusher: &str,
    ) -> Result<(), (StatusCode, String)> {
        let actual = crate::fetch::digest_of(bytes);
        if actual != digest {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("the upload hashes to {actual}, not {digest}"),
            ));
        }
        if serde_json::from_slice::<WasmConfig>(bytes).is_ok() {
            self.set(&format!("blob:{digest}"), bytes)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
            return Ok(());
        }
        match crate::components::validate(bytes) {
            Ok(_) => {
                self.components
                    .add(
                        bytes,
                        Some(Provenance {
                            source: format!("pushed to this registry by {pusher}"),
                            revision: None,
                            build: None,
                            builder: None,
                        }),
                    )
                    .await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
                Ok(())
            }
            Err(e) => Err((
                StatusCode::BAD_REQUEST,
                format!("this registry holds capability components only: {e:#}"),
            )),
        }
    }

    /// A pushed manifest: one wasm layer this store holds, over a wasm config.
    async fn accept_manifest(
        &self,
        name: &str,
        reference: &str,
        bytes: &[u8],
    ) -> Result<String, (StatusCode, String)> {
        let manifest: serde_json::Value = serde_json::from_slice(bytes)
            .map_err(|e| (StatusCode::BAD_REQUEST, format!("not a manifest: {e}")))?;
        let layers = manifest["layers"].as_array().cloned().unwrap_or_default();
        let (hash, config_digest) = match (layers.as_slice(), manifest["config"]["digest"].as_str())
        {
            ([layer], Some(config)) if layer["mediaType"] == WASM_LAYER_MEDIA_TYPE => (
                layer["digest"].as_str().unwrap_or("").to_string(),
                config.to_string(),
            ),
            _ => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!(
                        "a manifest here is one `{WASM_LAYER_MEDIA_TYPE}` layer over a wasm config"
                    ),
                ))
            }
        };
        if self.components.get(&hash).is_err() {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("the layer {hash} was not pushed"),
            ));
        }
        if self.get(&format!("blob:{config_digest}")).await.is_none() {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("the config {config_digest} was not pushed"),
            ));
        }
        let manifest_digest = digest(bytes);
        self.set(&format!("manifest:{manifest_digest}"), bytes)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
        if !reference.starts_with("sha256:") {
            let published = Published {
                reference: format!("{name}:{reference}"),
                digest: manifest_digest.clone(),
                hash,
            };
            self.set(
                &format!("tag:{name}:{reference}"),
                &serde_json::to_vec(&published).unwrap_or_default(),
            )
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
        }
        Ok(manifest_digest)
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

/// The credential the served registry requires: one username and password,
/// configured in the store (`registry`, a single instance).
#[derive(Default)]
pub struct RegistryAccess {
    credential: std::sync::RwLock<Option<(String, String)>>,
}

impl RegistryAccess {
    pub const OWNER: &'static str = "registry/";

    pub fn shared() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn declared() -> Declared {
        Declared::new(
            "registry",
            "credential",
            vec![
                Field::new("username", InputType::Str, "The username pulls and pushes present"),
                Field::new("password", InputType::Secret, "Its password"),
            ],
        )
        .single()
        .describe(
            "The credential this daemon's own OCI registry requires, for pulls and pushes alike: a \\
             component's bytes are their author's. The registry serves nothing until this is set.",
        )
    }

    pub async fn reload(&self, store: &Store) {
        let owner = format!("{}{SINGLE}", Self::OWNER);
        let rows = store.configuration(&owner).await.unwrap_or_default();
        let get = |field: &str| -> Option<String> {
            rows.iter().find(|(n, _)| n == field).and_then(|(_, v)| {
                serde_json::from_value::<Value>(v.clone())
                    .ok()
                    .and_then(|v| v.text().map(str::to_string))
                    .filter(|s| !s.trim().is_empty())
            })
        };
        let credential = match (get("username"), get("password")) {
            (Some(u), Some(p)) => Some((u, p)),
            _ => None,
        };
        *self.credential.write().unwrap_or_else(|e| e.into_inner()) = credential;
    }

    pub fn set(&self, username: &str, password: &str) {
        *self.credential.write().unwrap_or_else(|e| e.into_inner()) =
            Some((username.to_string(), password.to_string()));
    }

    /// The username a request's `Authorization` proves, if it proves one.
    fn verify(&self, authorization: Option<&str>) -> Result<String, StatusCode> {
        use base64::Engine as _;
        let Some((user, pass)) = self
            .credential
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        else {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        };
        let Some(header) = authorization else {
            return Err(StatusCode::UNAUTHORIZED);
        };
        let Some(encoded) = header.strip_prefix("Basic ") else {
            return Err(StatusCode::UNAUTHORIZED);
        };
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|_| StatusCode::UNAUTHORIZED)?;
        let decoded = String::from_utf8(decoded).map_err(|_| StatusCode::UNAUTHORIZED)?;
        let Some((u, p)) = decoded.split_once(':') else {
            return Err(StatusCode::UNAUTHORIZED);
        };
        if u == user && p == pass {
            Ok(user)
        } else {
            Err(StatusCode::UNAUTHORIZED)
        }
    }
}

/// The served registry: the index, its access credential, and the uploads
/// in flight.
pub struct Registry {
    index: Arc<RegistryIndex>,
    access: Arc<RegistryAccess>,
    uploads: Mutex<HashMap<String, Vec<u8>>>,
}

type Reply = Response<Full<Bytes>>;

fn reply(status: StatusCode, body: impl Into<Bytes>) -> Reply {
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain")
        .body(Full::new(body.into()))
        .unwrap_or_default()
}

fn error(status: StatusCode, message: String) -> Reply {
    // The distribution spec's error envelope, so a client shows the reason.
    let body = serde_json::json!({ "errors": [{ "code": "DENIED", "message": message }] });
    Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap_or_default()
}

impl Registry {
    pub fn new(index: Arc<RegistryIndex>, access: Arc<RegistryAccess>) -> Arc<Self> {
        Arc::new(Self {
            index,
            access,
            uploads: Mutex::new(HashMap::new()),
        })
    }

    /// Serve the distribution API on `listener` until it closes.
    pub async fn serve(self: Arc<Self>, listener: tokio::net::TcpListener) {
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(error = %e, "registry accept failed");
                    continue;
                }
            };
            let me = Arc::clone(&self);
            tokio::spawn(async move {
                let service = hyper::service::service_fn(move |req| {
                    let me = Arc::clone(&me);
                    async move { Ok::<_, std::convert::Infallible>(me.handle(req).await) }
                });
                if let Err(e) = hyper::server::conn::http1::Builder::new()
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                    .await
                {
                    tracing::debug!(error = %e, "registry connection ended");
                }
            });
        }
    }

    async fn handle(&self, req: Request<Incoming>) -> Reply {
        let method = req.method().clone();
        let path = req.uri().path().to_string();
        let query = req.uri().query().unwrap_or("").to_string();
        let authorization = req
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        // Every request proves the credential first: a component's bytes are
        // their author's, so pulls are gated like pushes.
        let user = match self.access.verify(authorization.as_deref()) {
            Ok(user) => user,
            Err(StatusCode::SERVICE_UNAVAILABLE) => {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "this registry serves nothing until its credential is configured".to_string(),
                )
            }
            Err(status) => {
                return Response::builder()
                    .status(status)
                    .header("WWW-Authenticate", "Basic realm=\"icanhaz\"")
                    .header("Content-Type", "application/json")
                    .body(Full::new(Bytes::from(
                        serde_json::json!({ "errors": [{ "code": "UNAUTHORIZED", "message": "the registry credential is required" }] }).to_string(),
                    )))
                    .unwrap_or_default();
            }
        };
        let Some(rest) = path.strip_prefix("/v2/") else {
            return reply(StatusCode::NOT_FOUND, "not the distribution API");
        };
        if rest.is_empty() {
            return reply(StatusCode::OK, "{}");
        }
        // `<name>/manifests/<ref>`, `<name>/blobs/<digest>`, `<name>/blobs/uploads/[<id>]`, `<name>/tags/list`
        let segments: Vec<&str> = rest.split('/').collect();
        let find = |what: &str| segments.iter().rposition(|s| *s == what);
        if let Some(i) = find("manifests") {
            let name = segments[..i].join("/");
            let reference = segments.get(i + 1).copied().unwrap_or("");
            return match method {
                hyper::Method::GET | hyper::Method::HEAD => {
                    match self.index.manifest(&name, reference).await {
                        Some((digest, bytes)) => {
                            let body = if method == hyper::Method::HEAD {
                                Bytes::new()
                            } else {
                                Bytes::from(bytes.clone())
                            };
                            Response::builder()
                                .status(StatusCode::OK)
                                .header("Content-Type", WASM_MANIFEST_MEDIA_TYPE)
                                .header("Content-Length", bytes.len())
                                .header("Docker-Content-Digest", digest)
                                .body(Full::new(body))
                                .unwrap_or_default()
                        }
                        None => error(
                            StatusCode::NOT_FOUND,
                            format!("no manifest {name}:{reference}"),
                        ),
                    }
                }
                hyper::Method::PUT => {
                    let bytes = match req.into_body().collect().await {
                        Ok(b) => b.to_bytes(),
                        Err(e) => return error(StatusCode::BAD_REQUEST, format!("{e}")),
                    };
                    match self.index.accept_manifest(&name, reference, &bytes).await {
                        Ok(digest) => Response::builder()
                            .status(StatusCode::CREATED)
                            .header("Location", format!("/v2/{name}/manifests/{digest}"))
                            .header("Docker-Content-Digest", digest)
                            .body(Full::new(Bytes::new()))
                            .unwrap_or_default(),
                        Err((status, message)) => error(status, message),
                    }
                }
                _ => reply(StatusCode::METHOD_NOT_ALLOWED, ""),
            };
        }
        if let Some(i) = find("uploads") {
            if i > 0 && segments[i - 1] == "blobs" {
                let name = segments[..i - 1].join("/");
                let id = segments.get(i + 1).copied().unwrap_or("");
                return self.upload(&method, &name, id, &query, req, &user).await;
            }
        }
        if let Some(i) = find("blobs") {
            let name = segments[..i].join("/");
            let digest = segments.get(i + 1).copied().unwrap_or("");
            return match method {
                hyper::Method::GET | hyper::Method::HEAD => match self.index.blob(digest).await {
                    Some(bytes) => {
                        let body = if method == hyper::Method::HEAD {
                            Bytes::new()
                        } else {
                            Bytes::from(bytes.clone())
                        };
                        Response::builder()
                            .status(StatusCode::OK)
                            .header("Content-Type", "application/octet-stream")
                            .header("Content-Length", bytes.len())
                            .header("Docker-Content-Digest", digest)
                            .body(Full::new(body))
                            .unwrap_or_default()
                    }
                    None => error(StatusCode::NOT_FOUND, format!("no blob {digest} in {name}")),
                },
                _ => reply(StatusCode::METHOD_NOT_ALLOWED, ""),
            };
        }
        if let Some(i) = find("tags") {
            if segments.get(i + 1) == Some(&"list") {
                let name = segments[..i].join("/");
                let mut tags: Vec<String> = self
                    .index
                    .published()
                    .await
                    .into_iter()
                    .filter_map(|p| {
                        p.reference
                            .strip_prefix(&format!("{name}:"))
                            .map(str::to_string)
                    })
                    .collect();
                tags.sort();
                let body = serde_json::json!({ "name": name, "tags": tags });
                return Response::builder()
                    .status(StatusCode::OK)
                    .header("Content-Type", "application/json")
                    .body(Full::new(Bytes::from(body.to_string())))
                    .unwrap_or_default();
            }
        }
        reply(StatusCode::NOT_FOUND, "no such route")
    }

    /// The upload session: `POST …/uploads/` opens one, `PATCH …/uploads/<id>`
    /// appends, `PUT …/uploads/<id>?digest=` completes (with any final body).
    async fn upload(
        &self,
        method: &hyper::Method,
        name: &str,
        id: &str,
        query: &str,
        req: Request<Incoming>,
        user: &str,
    ) -> Reply {
        match *method {
            hyper::Method::POST => {
                let id = uuid::Uuid::new_v4().to_string();
                self.uploads
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(id.clone(), Vec::new());
                Response::builder()
                    .status(StatusCode::ACCEPTED)
                    .header("Location", format!("/v2/{name}/blobs/uploads/{id}"))
                    .header("Range", "0-0")
                    .header("Docker-Upload-UUID", id)
                    .body(Full::new(Bytes::new()))
                    .unwrap_or_default()
            }
            hyper::Method::PATCH | hyper::Method::PUT => {
                let body = match req.into_body().collect().await {
                    Ok(b) => b.to_bytes(),
                    Err(e) => return error(StatusCode::BAD_REQUEST, format!("{e}")),
                };
                let total = {
                    let mut uploads = self.uploads.lock().unwrap_or_else(|e| e.into_inner());
                    let Some(buf) = uploads.get_mut(id) else {
                        return error(StatusCode::NOT_FOUND, format!("no upload {id}"));
                    };
                    if buf.len() + body.len() > MAX_UPLOAD {
                        uploads.remove(id);
                        return error(
                            StatusCode::PAYLOAD_TOO_LARGE,
                            "an upload may not exceed 256 MiB".to_string(),
                        );
                    }
                    buf.extend_from_slice(&body);
                    buf.len()
                };
                if *method == hyper::Method::PATCH {
                    return Response::builder()
                        .status(StatusCode::ACCEPTED)
                        .header("Location", format!("/v2/{name}/blobs/uploads/{id}"))
                        .header("Range", format!("0-{}", total.saturating_sub(1)))
                        .header("Docker-Upload-UUID", id)
                        .body(Full::new(Bytes::new()))
                        .unwrap_or_default();
                }
                let digest = query
                    .split('&')
                    .find_map(|kv| kv.strip_prefix("digest="))
                    .map(|d| d.replace("%3A", ":"))
                    .unwrap_or_default();
                let bytes = self
                    .uploads
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(id)
                    .unwrap_or_default();
                match self.index.accept_blob(&bytes, &digest, user).await {
                    Ok(()) => Response::builder()
                        .status(StatusCode::CREATED)
                        .header("Location", format!("/v2/{name}/blobs/{digest}"))
                        .header("Docker-Content-Digest", digest)
                        .body(Full::new(Bytes::new()))
                        .unwrap_or_default(),
                    Err((status, message)) => error(status, message),
                }
            }
            _ => reply(StatusCode::METHOD_NOT_ALLOWED, ""),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fetch::{tests::plain_http, ComponentSource, Credentials, Fetcher};
    use oci_client::client::{Client, ClientConfig, Config, ImageLayer};
    use oci_client::secrets::RegistryAuth;
    use oci_client::Reference;
    use oci_wasm::WasmClient;

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/fixtures/{name}.wasm",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap_or_else(|e| panic!("{name}.wasm fixture: {e}"))
    }

    /// A served registry over a fresh store, with the credential `theo:pw`.
    async fn served() -> (String, Arc<RegistryIndex>, Arc<ComponentStore>) {
        let dir = tempfile::tempdir().unwrap();
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let db = Store::open_with(dir.path().join("icanhaz.db"), &source)
            .await
            .unwrap();
        let components = Arc::new(ComponentStore::new(
            dir.path().join("components"),
            Some(db.clone()),
        ));
        let index = RegistryIndex::new(Arc::clone(&components), Some(db));
        let access = RegistryAccess::shared();
        access.set("theo", "pw");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        tokio::spawn(Registry::new(Arc::clone(&index), access).serve(listener));
        std::mem::forget(dir);
        (addr, index, components)
    }

    fn fetcher_as(addr: &str, username: &str, password: &str) -> Fetcher {
        let credentials = Credentials::shared();
        credentials.set(addr, username, password);
        Fetcher::with_protocol(plain_http(), None, credentials)
    }

    #[tokio::test]
    async fn a_published_component_is_pulled_with_the_credential_and_refused_without() {
        let (addr, index, components) = served().await;
        let greeter = fixture("greeter");
        let info = components.add(&greeter, None).await.unwrap();
        let published = index
            .publish(&info.hash, "acme/greeter:v1")
            .await
            .expect("published");
        assert_eq!(published.hash, info.hash);
        assert!(index.publish(&info.hash, "Not Valid").await.is_err());
        assert!(index.publish("sha256:missing", "acme/x:1").await.is_err());

        let source = ComponentSource::parse(&format!("oci://{addr}/acme/greeter:v1")).unwrap();
        let (bytes, provenance) = fetcher_as(&addr, "theo", "pw")
            .fetch(&source)
            .await
            .expect("pulled with the credential");
        assert_eq!(bytes, greeter);
        assert_eq!(
            provenance.revision.as_deref(),
            Some(published.digest.as_str())
        );
        // By digest as well as by tag.
        let by_digest =
            ComponentSource::parse(&format!("oci://{addr}/acme/greeter@{}", published.digest))
                .unwrap();
        assert_eq!(
            fetcher_as(&addr, "theo", "pw")
                .fetch(&by_digest)
                .await
                .unwrap()
                .0,
            greeter
        );

        // Anonymous, or the wrong password: nothing comes back, not even the manifest.
        let anonymous = Fetcher::with_protocol(plain_http(), None, Credentials::shared());
        let err = anonymous
            .fetch(&source)
            .await
            .expect_err("anonymous pull refused");
        assert!(
            format!("{err:#}").to_lowercase().contains("authorized"),
            "{err:#}"
        );
        let err = fetcher_as(&addr, "theo", "nope")
            .fetch(&source)
            .await
            .expect_err("wrong password refused");
        assert!(
            format!("{err:#}").to_lowercase().contains("authorized"),
            "{err:#}"
        );

        // Unpublished: the tag is gone, the component stays.
        assert!(index.unpublish("acme/greeter:v1").await.unwrap());
        assert!(!index.unpublish("acme/greeter:v1").await.unwrap());
        assert!(fetcher_as(&addr, "theo", "pw")
            .fetch(&source)
            .await
            .is_err());
        assert!(components.get(&info.hash).is_ok());
    }

    #[tokio::test]
    async fn a_pushed_component_lands_in_the_store_and_only_a_component_is_accepted() {
        let (addr, index, components) = served().await;
        let oracle = fixture("oracle");
        let client = WasmClient::new(Client::new(ClientConfig {
            protocol: plain_http(),
            ..ClientConfig::default()
        }));
        let reference: Reference = format!("{addr}/acme/oracle:v1").parse().unwrap();
        let auth = RegistryAuth::Basic("theo".into(), "pw".into());
        let (config, layer) =
            WasmConfig::from_raw_component(oracle.clone(), Some("theo".into())).unwrap();
        client
            .push(&reference, &auth, layer, config, None)
            .await
            .expect("pushed with the credential");
        let hash = crate::fetch::digest_of(&oracle);
        let held = components
            .find(&hash)
            .await
            .expect("the pushed component is in the store");
        assert!(held
            .provenance
            .unwrap()
            .source
            .contains("pushed to this registry by theo"));
        let tags = index.published().await;
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].reference, "acme/oracle:v1");
        assert_eq!(tags[0].hash, hash);
        // Pulled back as pushed, and listed.
        let source = ComponentSource::parse(&format!("oci://{addr}/acme/oracle:v1")).unwrap();
        assert_eq!(
            fetcher_as(&addr, "theo", "pw")
                .fetch(&source)
                .await
                .unwrap()
                .0,
            oracle
        );
        let listed = client
            .list_tags(&reference, &auth, None, None)
            .await
            .unwrap();
        assert_eq!(listed.tags, vec!["v1".to_string()]);

        // Without the credential, nothing is pushed (a fresh client: the one
        // above keeps the credential it authenticated with).
        let anonymous = WasmClient::new(Client::new(ClientConfig {
            protocol: plain_http(),
            ..ClientConfig::default()
        }));
        let (config, layer) = WasmConfig::from_raw_component(oracle.clone(), None).unwrap();
        let other: Reference = format!("{addr}/acme/oracle:v2").parse().unwrap();
        assert!(anonymous
            .push(&other, &RegistryAuth::Anonymous, layer, config, None)
            .await
            .is_err());
        assert_eq!(index.published().await.len(), 1);

        // A layer that is not a capability component is refused at the blob.
        let junk = b"\0asm\x01\0\0\0not a component".to_vec();
        let junk_layer = ImageLayer::new(junk.clone(), WASM_LAYER_MEDIA_TYPE.to_string(), None);
        let junk_config = Config::new(
            b"{}".to_vec(),
            WASM_MANIFEST_CONFIG_MEDIA_TYPE.to_string(),
            None,
        );
        let junk_ref: Reference = format!("{addr}/acme/junk:1").parse().unwrap();
        let err =
            match Client::push(&client, &junk_ref, &[junk_layer], junk_config, &auth, None).await {
                Ok(_) => panic!("a non-component was accepted"),
                Err(e) => e,
            };
        assert!(
            format!("{err:#}").contains("capability components only")
                || format!("{err:#}").contains("400"),
            "{err:#}"
        );
        assert!(components
            .find(&crate::fetch::digest_of(&junk))
            .await
            .is_none());
        assert_eq!(index.published().await.len(), 1);
    }

    /// The realistic path for a novel capability: another daemon serves its
    /// registry with the links example published; this daemon, given a
    /// credential for it, resolves a request naming the component by hash
    /// and source, fetches it, checks the hash, and serves it over its own
    /// vault. The publisher's registry never sees a query.
    #[tokio::test]
    async fn a_novel_capability_named_by_hash_and_source_is_fetched_from_another_daemons_registry()
    {
        use crate::broker::{CapabilityKind, ComponentRequest, FsRequest, FsRights, PathGrant};
        use crate::component_serve::{component_router, serve_interface, Handles};
        use std::time::Duration;

        const IFACE: &str = "example:links/links@0.1.0";
        // The publisher: its registry holds the links example.
        let (addr, index, publisher_store) = served().await;
        let links = fixture("links");
        let published_info = publisher_store.add(&links, None).await.unwrap();
        index
            .publish(&published_info.hash, "example/links:v1")
            .await
            .expect("published");
        let hash = published_info.hash.clone();
        let source = format!("oci://{addr}/example/links:v1");

        // The consumer: an empty store, a credential for the publisher's registry.
        let dir = tempfile::tempdir().unwrap();
        let db_source = ezdb::KeySource::File(dir.path().join("k"));
        let db = Store::open_with(dir.path().join("icanhaz.db"), &db_source)
            .await
            .unwrap();
        let components = Arc::new(ComponentStore::new(dir.path().join("components"), Some(db)));
        let filesystem = std::fs::read(format!(
            "{}/../capabilities/filesystem/target/wasm32-wasip2/release/filesystem_capability.wasm",
            env!("CARGO_MANIFEST_DIR")
        ))
        .expect("build capabilities/filesystem first");
        let shipped = components.add(&filesystem, None).await.unwrap();
        components.register_shipped(&shipped);
        let provider = crate::components::ComponentsProvider::new(Arc::clone(&components))
            .with_fetcher(Arc::new(fetcher_as(&addr, "theo", "pw")));
        assert!(
            components.find(&hash).await.is_none(),
            "the consumer starts without it"
        );

        // A wrong credential cannot fetch it.
        let wrong = crate::components::ComponentsProvider::new(Arc::clone(&components))
            .with_fetcher(Arc::new(fetcher_as(&addr, "theo", "nope")));
        let err = wrong.ensure(&hash, Some(&source)).await.unwrap_err();
        assert!(err.to_lowercase().contains("authorized"), "{err}");
        assert!(components.find(&hash).await.is_none());

        // The request's provider resolves: fetched, hash-checked, kept with its source.
        let summary = provider
            .ensure(&hash, Some(&source))
            .await
            .expect("resolved from the publisher");
        assert_eq!(summary.source.as_deref(), Some(source.as_str()));
        let held = components.find(&hash).await.expect("now held");
        assert_eq!(held.provenance.as_ref().unwrap().source, source);

        // Served over the consumer's own vault, through the delegated grant.
        let grants = crate::broker::GrantStore::shared();
        let env = crate::components::env_for(&links, IFACE).unwrap();
        grants.lock().unwrap().add_environment(IFACE, env).unwrap();
        let vault = dir.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::write(vault.join("a.md"), "see [[b]]\n").unwrap();
        std::fs::write(vault.join("b.md"), "# b\n").unwrap();
        let (token, fs_token) = {
            let mut g = grants.lock().unwrap();
            let fs_token = g.issue(
                CapabilityKind::Filesystem(FsRequest {
                    roots: vec![PathGrant {
                        path: "/".to_string(),
                        rights: FsRights::READ,
                    }],
                }),
                "vault".to_string(),
                Duration::from_secs(60),
                crate::broker::anonymous_principal(),
            );
            let token = g.issue(
                CapabilityKind::Component(ComponentRequest {
                    provides: IFACE.to_string(),
                    provider: Some(hash.clone()),
                    delegated: vec![fs_token.clone()],
                    source: Some(source.clone()),
                }),
                "links".to_string(),
                Duration::from_secs(60),
                crate::broker::anonymous_principal(),
            );
            (token, fs_token)
        };
        let _ = fs_token;
        let jail = crate::workspace::WorkspaceProvider::new(vault.clone(), grants.clone());
        let mut raw = crate::raw::Raw::new(grants.clone());
        raw.root = Some(jail.native_for_grants());
        raw.open_root = Some(jail.native_open_root());
        let srv = Arc::new(wrpc_transport::Server::default());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let rpc_addr = listener.local_addr().unwrap().to_string();
        let accept = {
            let srv = Arc::clone(&srv);
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let (rx, tx) = stream.into_split();
                    let _ = srv.accept((), tx, rx).await;
                }
            })
        };
        let router = component_router(
            IFACE,
            Arc::clone(&components),
            wrpc_transport::tcp::Client::from(rpc_addr.clone()),
            (),
            grants.clone(),
            Arc::new(raw),
            Handles::new(),
        )
        .unwrap();
        let ty = wasmtime::component::Component::new(router.engine(), &links)
            .unwrap()
            .component_type();
        let _handlers = serve_interface(srv.as_ref(), &router, &ty, IFACE)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let wrpc = wrpc_transport::tcp::Client::from(&rpc_addr);
        let opened = links_client::example::links::links::open(&wrpc, (), &token)
            .await
            .unwrap()
            .expect("opened");
        let into_b = links_client::example::links::links::Index::backlinks(
            &wrpc,
            (),
            &opened.as_borrow(),
            "b",
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            into_b.iter().map(|l| l.source.as_str()).collect::<Vec<_>>(),
            vec!["a.md"]
        );
        accept.abort();
    }

    mod links_client {
        wit_bindgen_wrpc::generate!({
            world: "example:links/links-client",
            path: "../examples/links/wit",
        });
    }

    #[test]
    fn credentials_prefer_what_is_configured() {
        let credentials = Credentials::default();
        credentials.set("registry.example", "me", "secret");
        assert!(matches!(
            credentials.auth_for("registry.example"),
            RegistryAuth::Basic(u, p) if u == "me" && p == "secret"
        ));
        assert!(!matches!(
            credentials.auth_for("nowhere.invalid.example"),
            RegistryAuth::Basic(..)
        ));
    }
}
