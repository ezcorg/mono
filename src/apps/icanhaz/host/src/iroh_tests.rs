//! The peer path end to end: wRPC over iroh, the remote endpoint id as the
//! caller's identity, and a certificate bound to a peer key redeemed only by
//! that peer.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use iroh::endpoint::presets::Minimal;
use iroh::Endpoint;
use wrpc_transport_iroh::Client;

use crate::broker::bindings::ezco::ezcap::types::Scope as ScopeWire;
use crate::broker::bindings::icanhaz::nocap::types::Denied;
use crate::broker::client::Audience;
use crate::broker::{
    client, serve_iroh, BrokerProvider, CapabilityKind, Consent, GrantStore, Pairings,
    ProcessRequest, IROH_ALPN,
};

fn unrestricted() -> ScopeWire {
    ScopeWire {
        when: "true".to_string(),
        allow: "true".to_string(),
    }
}

fn ezkey(id: iroh::EndpointId) -> ezcap::PublicKey {
    ezcap::PublicKey::from_bytes(*id.as_bytes())
}

async fn peer(server: &iroh::EndpointAddr) -> (Endpoint, Client) {
    let ep = Endpoint::builder(Minimal).bind().await.expect("bind peer");
    let conn = ep
        .connect(server.clone(), IROH_ALPN)
        .await
        .expect("connect to the broker over iroh");
    (ep, Client::from(conn))
}

#[tokio::test]
async fn iroh_peer_redeems_a_certificate_bound_to_its_key() {
    tokio::time::timeout(Duration::from_secs(60), async {
        // The broker's key is the iroh endpoint's key: issuer == locator.
        let key = ezcap::Keypair::generate().expect("key");
        let store: Arc<Mutex<GrantStore>> = GrantStore::shared();
        store.lock().unwrap().set_identity(key.clone());
        let provider = BrokerProvider::new(store.clone(), Consent::AutoApprove, Pairings::shared());
        let server_ep = Endpoint::builder(Minimal)
            .secret_key(iroh::SecretKey::from_bytes(&key.to_bytes()))
            .alpns(vec![IROH_ALPN.to_vec()])
            .bind()
            .await
            .expect("bind broker endpoint");
        let server_addr = server_ep.addr();
        assert_eq!(ezkey(server_ep.id()), key.public());
        let server = tokio::spawn(serve_iroh(server_ep, provider));

        let (alice_ep, alice) = peer(&server_addr).await;
        let (bob_ep, bob) = peer(&server_addr).await;

        // The broker names itself by the same key the handshake proved.
        assert_eq!(
            client::identity(&alice, ()).await.expect("identity"),
            key.public().to_string()
        );

        // Alice is granted (auto consent) as the peer the transport identified.
        let want = CapabilityKind::Process(ProcessRequest {
            image: "echo".to_string(),
            args: vec![],
            guest_chooses_argv: true,
        });
        let token = client::request_scoped(&alice, (), &want, &unrestricted(), "share", None)
            .await
            .expect("invoke")
            .expect("granted")
            .token;
        let mine = client::granted(&alice, ()).await.expect("granted list");
        assert!(
            mine.iter()
                .any(|g| g.holder.id == ezkey(alice_ep.id()).to_string()),
            "{mine:?}"
        );

        // A certificate for Bob's key: Alice cannot redeem it, Bob can.
        let cert = client::certify(
            &alice,
            (),
            &token,
            &Audience::Peer(ezkey(bob_ep.id()).to_string()),
            60,
            &ScopeWire {
                when: "true".to_string(),
                allow: "size(call.args.args) < 2".to_string(),
            },
        )
        .await
        .expect("invoke")
        .expect("certified");
        let refused = client::redeem(&alice, (), &cert).await.expect("invoke");
        assert!(matches!(refused, Err(Denied::NotAuthorized)), "{refused:?}");
        let redeemed = client::redeem(&bob, (), &cert)
            .await
            .expect("invoke")
            .expect("redeemed");
        // Bob holds a grant narrowed by the chain, in his own name.
        let bobs = client::granted(&bob, ()).await.expect("granted list");
        assert!(
            bobs.iter()
                .any(|g| g.holder.id == ezkey(bob_ep.id()).to_string()
                    && g.summary.contains("allow:")),
            "{bobs:?}"
        );
        let ok = crate::broker::AdmitCall::new("spawn").arg("args", vec!["x".to_string()]);
        assert!(store.lock().unwrap().admit(&redeemed.token, ok).is_ok());
        let two = crate::broker::AdmitCall::new("spawn")
            .arg("args", vec!["x".to_string(), "y".to_string()]);
        let outcome = store.lock().unwrap().admit(&redeemed.token, two);
        assert!(matches!(outcome, Err(Denied::OutOfScope(_))), "{outcome:?}");

        server.abort();
        drop((alice_ep, bob_ep));
    })
    .await
    .expect("test timed out");
}
