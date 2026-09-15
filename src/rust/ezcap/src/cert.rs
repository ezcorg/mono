//! Certificates: how a grant travels.
//!
//! A [`Certificate`] is a **sturdy reference** to an instance the issuing
//! broker minted (`instance`: an unguessable id the broker resolves), bound to
//! an **audience** (who may redeem it), an **expiry**, and a signed chain of
//! **links**. The issuer signs the root; every link appends a [`Narrowing`]
//! and is signed by whoever appended it, over the previous signature, so the
//! order is bound too. Because a link can only conjoin clauses, anyone can
//! verify that a chain narrows by reading it: containment is syntactic, and no
//! policy language is evaluated to check it. The broker that minted the
//! instance evaluates the clauses when the certificate is redeemed.
//!
//! This is OCapN's layering with icanhaz as the vat: a pairing secret is a
//! bearer, a certificate is a bearer bound to a key or an origin, both
//! resolve at the owner's locator. Ed25519 throughout; the wire form is a
//! prefixed base64url JSON string, so it fits a query string, a share bundle
//! or a WIT `string`.

use std::fmt;
use std::str::FromStr;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use ed25519_dalek::{Signature, Signer as _, SigningKey, Verifier as _, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::types::Narrowing;

const PREFIX: &str = "ezcap1.";
const ROOT_DOMAIN: &[u8] = b"ezco:ezcap/cert@1 root\n";
const LINK_DOMAIN: &[u8] = b"ezco:ezcap/cert@1 link\n";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CertError {
    #[error("not a certificate: {0}")]
    Encoding(String),
    #[error("the issuer's signature does not verify")]
    RootSignature,
    #[error("link {0}'s signature does not verify")]
    LinkSignature(usize),
    #[error("expired")]
    Expired,
    #[error("not for this audience")]
    Audience,
    #[error("issued by another broker")]
    Issuer,
}

/// An Ed25519 public key. Displays as base64url (43 characters).
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct PublicKey([u8; 32]);

impl PublicKey {
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        PublicKey(bytes)
    }

    fn verifying(&self) -> Result<VerifyingKey, CertError> {
        VerifyingKey::from_bytes(&self.0)
            .map_err(|e| CertError::Encoding(format!("bad public key: {e}")))
    }
}

impl fmt::Debug for PublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PublicKey({self})")
    }
}

impl fmt::Display for PublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&B64.encode(self.0))
    }
}

impl FromStr for PublicKey {
    type Err = CertError;
    fn from_str(s: &str) -> Result<Self, CertError> {
        let bytes = B64
            .decode(s.trim())
            .map_err(|e| CertError::Encoding(format!("public key: {e}")))?;
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_bytes| CertError::Encoding("public key is not 32 bytes".into()))?;
        Ok(PublicKey(bytes))
    }
}

impl Serialize for PublicKey {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for PublicKey {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

/// An Ed25519 signing key: a broker's identity, or a holder's, for
/// attenuating. `Debug` never prints the secret.
#[derive(Clone)]
pub struct Keypair(SigningKey);

impl Keypair {
    /// A fresh random key.
    pub fn generate() -> Result<Self, CertError> {
        let mut seed = [0u8; 32];
        getrandom::getrandom(&mut seed)
            .map_err(|e| CertError::Encoding(format!("no randomness: {e}")))?;
        Ok(Keypair(SigningKey::from_bytes(&seed)))
    }

    /// The 32-byte secret seed, for a store to keep.
    pub fn to_bytes(&self) -> [u8; 32] {
        self.0.to_bytes()
    }

    pub fn from_bytes(seed: &[u8; 32]) -> Self {
        Keypair(SigningKey::from_bytes(seed))
    }

    pub fn public(&self) -> PublicKey {
        PublicKey(self.0.verifying_key().to_bytes())
    }

    fn sign(&self, domain: &[u8], parts: &[&[u8]]) -> Sig {
        let mut msg = domain.to_vec();
        for p in parts {
            msg.extend_from_slice(p);
        }
        Sig(self.0.sign(&msg).to_bytes())
    }
}

impl fmt::Debug for Keypair {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Keypair({})", self.public())
    }
}

/// A 64-byte signature, base64url on the wire.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Sig([u8; 64]);

impl Sig {
    fn verify(&self, key: &PublicKey, domain: &[u8], parts: &[&[u8]]) -> bool {
        let Ok(key) = key.verifying() else {
            return false;
        };
        let mut msg = domain.to_vec();
        for p in parts {
            msg.extend_from_slice(p);
        }
        key.verify(&msg, &Signature::from_bytes(&self.0)).is_ok()
    }
}

impl fmt::Debug for Sig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Sig({}…)", &B64.encode(self.0)[..8])
    }
}

impl Serialize for Sig {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&B64.encode(self.0))
    }
}

impl<'de> Deserialize<'de> for Sig {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        let bytes = B64.decode(s).map_err(serde::de::Error::custom)?;
        let bytes: [u8; 64] = bytes
            .try_into()
            .map_err(|_bytes| serde::de::Error::custom("signature is not 64 bytes"))?;
        Ok(Sig(bytes))
    }
}

/// Who may redeem a certificate. Checked against what the transport proved
/// about the presenter ([`Presented`]): a browser's attested `Origin`, or a
/// QUIC-authenticated peer key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Audience {
    /// Anyone holding it: a bearer.
    Any,
    /// A web origin, as the browser attests it.
    Origin(String),
    /// A peer whose transport identity is this key.
    Peer(PublicKey),
}

/// What the transport proved about whoever presents a certificate.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Presented {
    pub origin: Option<String>,
    pub peer: Option<PublicKey>,
}

impl Audience {
    pub fn admits(&self, presented: &Presented) -> bool {
        match self {
            Audience::Any => true,
            Audience::Origin(o) => presented.origin.as_deref() == Some(o.as_str()),
            Audience::Peer(k) => presented.peer.as_ref() == Some(k),
        }
    }
}

/// What the issuer signs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Root {
    /// The sturdy id of the instance at the issuing broker.
    instance: String,
    issuer: PublicKey,
    audience: Audience,
    /// Unix seconds; `0` never expires.
    expires: u64,
    /// Clauses the issuer added at issue time.
    extra: Narrowing,
}

/// One appended narrowing, signed by whoever appended it over the previous
/// signature in the chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Link {
    extra: Narrowing,
    by: PublicKey,
    signature: Sig,
}

/// A signed, attenuable reference to a minted instance. See the module docs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Certificate {
    root: Root,
    signature: Sig,
    links: Vec<Link>,
}

/// A certificate whose chain verified: the parts a broker acts on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    pub instance: String,
    pub issuer: PublicKey,
    pub audience: Audience,
    pub expires: u64,
    /// Everything the root and its links add, in order.
    pub narrowing: Narrowing,
    /// Who appended each link, in order.
    pub attenuated_by: Vec<PublicKey>,
}

fn json<T: Serialize>(v: &T) -> Vec<u8> {
    // serde_json writes struct fields in declaration order, so the same
    // struct serialises to the same bytes on both sides. Only structs and
    // strings are signed; there are no maps or floats to canonicalise.
    serde_json::to_vec(v).unwrap_or_default()
}

impl Certificate {
    /// Issue a certificate for `instance` under `key`, redeemable by
    /// `audience` until `expires` (unix seconds; `0` = never), with the
    /// issuer's own `extra` clauses.
    pub fn issue(
        key: &Keypair,
        instance: impl Into<String>,
        audience: Audience,
        expires: u64,
        extra: Narrowing,
    ) -> Self {
        let root = Root {
            instance: instance.into(),
            issuer: key.public(),
            audience,
            expires,
            extra,
        };
        let signature = key.sign(ROOT_DOMAIN, &[&json(&root)]);
        Certificate {
            root,
            signature,
            links: Vec::new(),
        }
    }

    /// Append clauses. The holder narrows offline; nothing about the root or
    /// earlier links changes, and the new link signs over the last signature.
    pub fn attenuate(&self, key: &Keypair, extra: Narrowing) -> Self {
        let previous = self.last_signature();
        let body = LinkBody {
            extra: &extra,
            by: key.public(),
        };
        let signature = key.sign(LINK_DOMAIN, &[&previous.0, &json(&body)]);
        let mut out = self.clone();
        out.links.push(Link {
            extra,
            by: key.public(),
            signature,
        });
        out
    }

    fn last_signature(&self) -> Sig {
        self.links
            .last()
            .map(|l| l.signature)
            .unwrap_or(self.signature)
    }

    /// Check every signature and the expiry against `now` (unix seconds).
    /// The audience is *not* checked here: the broker checks it against what
    /// its transport proved, see [`Verified::admits`].
    pub fn verify(&self, now: u64) -> Result<Verified, CertError> {
        if !self
            .signature
            .verify(&self.root.issuer, ROOT_DOMAIN, &[&json(&self.root)])
        {
            return Err(CertError::RootSignature);
        }
        let mut previous = self.signature;
        let mut narrowing = self.root.extra.clone();
        let mut attenuated_by = Vec::with_capacity(self.links.len());
        for (i, link) in self.links.iter().enumerate() {
            let body = LinkBody {
                extra: &link.extra,
                by: link.by,
            };
            if !link
                .signature
                .verify(&link.by, LINK_DOMAIN, &[&previous.0, &json(&body)])
            {
                return Err(CertError::LinkSignature(i));
            }
            previous = link.signature;
            narrowing = narrowing.and(&link.extra);
            attenuated_by.push(link.by);
        }
        if self.root.expires != 0 && now >= self.root.expires {
            return Err(CertError::Expired);
        }
        Ok(Verified {
            instance: self.root.instance.clone(),
            issuer: self.root.issuer,
            audience: self.root.audience.clone(),
            expires: self.root.expires,
            narrowing,
            attenuated_by,
        })
    }

    pub fn instance(&self) -> &str {
        &self.root.instance
    }

    pub fn issuer(&self) -> &PublicKey {
        &self.root.issuer
    }

    pub fn audience(&self) -> &Audience {
        &self.root.audience
    }

    pub fn expires(&self) -> u64 {
        self.root.expires
    }

    /// Everything the chain adds, without verifying it (for display).
    pub fn narrowing(&self) -> Narrowing {
        self.links
            .iter()
            .fold(self.root.extra.clone(), |n, l| n.and(&l.extra))
    }

    /// The wire form: `ezcap1.` + base64url(JSON).
    pub fn encode(&self) -> String {
        format!("{PREFIX}{}", B64.encode(json(self)))
    }

    pub fn decode(s: &str) -> Result<Self, CertError> {
        let body = s
            .trim()
            .strip_prefix(PREFIX)
            .ok_or_else(|| CertError::Encoding("missing `ezcap1.` prefix".into()))?;
        let bytes = B64
            .decode(body)
            .map_err(|e| CertError::Encoding(e.to_string()))?;
        serde_json::from_slice(&bytes).map_err(|e| CertError::Encoding(e.to_string()))
    }
}

impl Verified {
    /// Was it issued by `issuer`, and does the presenter match its audience?
    pub fn admits(&self, issuer: &PublicKey, presented: &Presented) -> Result<(), CertError> {
        if &self.issuer != issuer {
            return Err(CertError::Issuer);
        }
        if !self.audience.admits(presented) {
            return Err(CertError::Audience);
        }
        Ok(())
    }
}

/// What a link's signer signs (the link minus its own signature).
#[derive(Serialize)]
struct LinkBody<'a> {
    extra: &'a Narrowing,
    by: PublicKey,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> (Keypair, Keypair, Keypair) {
        (
            Keypair::generate().unwrap(),
            Keypair::generate().unwrap(),
            Keypair::generate().unwrap(),
        )
    }

    #[test]
    fn issue_encode_decode_verify() {
        let (issuer, _, _) = keys();
        let cert = Certificate::issue(
            &issuer,
            "inst-1",
            Audience::Origin("https://notes.example".into()),
            1_000,
            Narrowing::allow("state.tokens < 100"),
        );
        let wire = cert.encode();
        assert!(wire.starts_with("ezcap1."));
        let back = Certificate::decode(&wire).unwrap();
        assert_eq!(back, cert);
        let v = back.verify(999).unwrap();
        assert_eq!(v.instance, "inst-1");
        assert_eq!(v.narrowing, Narrowing::allow("state.tokens < 100"));
        assert!(v.attenuated_by.is_empty());
        assert_eq!(back.verify(1_000), Err(CertError::Expired));
        assert_eq!(
            Certificate::decode("nope").unwrap_err(),
            CertError::Encoding("missing `ezcap1.` prefix".into())
        );
    }

    #[test]
    fn audience_and_issuer_are_checked_at_the_broker() {
        let (issuer, other, peer) = keys();
        let v = Certificate::issue(
            &issuer,
            "i",
            Audience::Peer(peer.public()),
            0,
            Narrowing::default(),
        )
        .verify(1)
        .unwrap();
        let by_peer = Presented {
            peer: Some(peer.public()),
            ..Default::default()
        };
        assert_eq!(v.admits(&issuer.public(), &by_peer), Ok(()));
        assert_eq!(v.admits(&other.public(), &by_peer), Err(CertError::Issuer));
        assert_eq!(
            v.admits(&issuer.public(), &Presented::default()),
            Err(CertError::Audience)
        );
        let bearer = Certificate::issue(&issuer, "i", Audience::Any, 0, Narrowing::default())
            .verify(1)
            .unwrap();
        assert_eq!(
            bearer.admits(&issuer.public(), &Presented::default()),
            Ok(())
        );
    }

    #[test]
    fn links_only_append_and_bind_their_order() {
        let (issuer, alice, bob) = keys();
        let root = Certificate::issue(&issuer, "i", Audience::Any, 0, Narrowing::default());
        let a = root.attenuate(
            &alice,
            Narrowing::allow(r#"call.args.path.startsWith("src/")"#),
        );
        let ab = a.attenuate(&bob, Narrowing::when("time < 5"));
        let v = ab.verify(1).unwrap();
        assert_eq!(
            v.narrowing,
            Narrowing {
                when: Some("time < 5".into()),
                allow: Some(r#"call.args.path.startsWith("src/")"#.into()),
            }
        );
        assert_eq!(v.attenuated_by, vec![alice.public(), bob.public()]);

        // Editing a link's clause breaks its signature; reordering breaks the chain.
        let mut edited = ab.clone();
        edited.links[0].extra = Narrowing::allow("true");
        assert_eq!(edited.verify(1), Err(CertError::LinkSignature(0)));
        let mut swapped = ab.clone();
        swapped.links.swap(0, 1);
        assert_eq!(swapped.verify(1), Err(CertError::LinkSignature(0)));
        let mut dropped = ab.clone();
        dropped.links.remove(0);
        assert_eq!(dropped.verify(1), Err(CertError::LinkSignature(0)));
        // Editing the root breaks the issuer's signature.
        let mut widened = ab.clone();
        widened.root.expires = 0;
        widened.root.audience = Audience::Any;
        widened.root.instance = "other".into();
        assert_eq!(widened.verify(1), Err(CertError::RootSignature));
        // Anyone can verify the chain: no key of the issuer's is needed.
        assert!(Certificate::decode(&ab.encode()).unwrap().verify(1).is_ok());
    }

    #[test]
    fn narrowing_and_is_conjunction() {
        let a = Narrowing::allow("x");
        let b = Narrowing::allow("y");
        assert_eq!(a.and(&b).allow.as_deref(), Some("(x) && (y)"));
        assert_eq!(a.and(&Narrowing::default()), a);
        assert!(Narrowing::default().is_empty());
        assert!(Narrowing::allow("  ").is_empty());
    }
}
