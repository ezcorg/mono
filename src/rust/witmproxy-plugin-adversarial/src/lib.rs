//! A deliberately hostile witmproxy plugin, used as a test fixture.
//!
//! Each attack is selected at runtime through the plugin's `mode` configuration
//! input, so the whole suite is one component and one build.
//!
//! The component declares an EMPTY public key. Note that this makes it
//! unloadable through the production path: `plugin_from_component_with_key`
//! rejects a plugin with no public key rather than skipping verification, which
//! is the correct fail-closed behaviour. The tests therefore construct the
//! `WitmPlugin` directly and register it through a test-only helper, which is
//! also why the fixture needs no signing key.
//!
//! This crate exists to answer one question: when a plugin behaves as badly as
//! it possibly can, does the host stay up and does the operator find out?

// `input-schema` / `input-type` / `actual-input` are declared in the
// `witm-plugin` interface (the export), not in `capabilities` (the import).
use crate::exports::witmproxy::plugin::witm_plugin::{
    ActualInput, Capability, CapabilityProvider, ConfigureError, Event, Guest, GuestPlugin,
    InputSchema, InputType, Plugin as PluginResource, PluginManifest, UserInput,
};
use crate::witmproxy::plugin::capabilities::{CapabilityKind, CapabilityScope, EventKind};

wit_bindgen::generate!({
    world: "witmproxy:plugin/plugin",
    async: true,
    generate_all
});

struct Component;

/// Which attack to mount. Unknown values are treated as `Passthrough` so a
/// typo in a test fixture fails as an assertion rather than as a silent no-op
/// that looks like the limit worked.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    /// Return the event untouched. The control case.
    Passthrough,
    /// Spin forever without yielding. Exercises the epoch deadline: fuel alone
    /// cannot bound this when fuel is configured as unlimited, and cancelling
    /// the driving future cannot stop a guest that never returns to the
    /// executor.
    Spin,
    /// Grow guest linear memory without bound. Exercises `max_memory_mb`.
    MemoryBomb,
    /// Write large values under many keys. Exercises the local-storage byte and
    /// key quotas -- host memory that the guest memory cap does not cover.
    StorageBomb,
    /// Emit a very large number of log messages. Exercises the per-event log
    /// message budget.
    LogFlood,
    /// Emit a message containing newlines shaped like a host log line.
    /// Exercises log-injection escaping.
    LogInject,
    /// Re-acquire the logger capability between messages, to check that the
    /// per-event budget is shared across capability handles rather than reset
    /// on each acquisition.
    LoggerRebind,
    /// Replace the body with an effectively endless stream. Exercises
    /// `max_response_body_bytes`: the stream length is guest-controlled and
    /// unrelated to the size of the request that triggered the event, so
    /// without a cap the proxy becomes an amplifier.
    BodyBomb,
}

impl Mode {
    fn parse(s: &str) -> Self {
        match s {
            "spin" => Self::Spin,
            "memory-bomb" => Self::MemoryBomb,
            "storage-bomb" => Self::StorageBomb,
            "log-flood" => Self::LogFlood,
            "log-inject" => Self::LogInject,
            "logger-rebind" => Self::LoggerRebind,
            "body-bomb" => Self::BodyBomb,
            _ => Self::Passthrough,
        }
    }
}

impl Guest for Component {
    type Plugin = PluginInstance;

    async fn manifest() -> PluginManifest {
        PluginManifest {
            name: "adversarial".to_string(),
            namespace: "test".to_string(),
            author: "witmproxy test suite".to_string(),
            version: "0.0.1".to_string(),
            description: "hostile plugin fixture for sandbox limit tests".to_string(),
            license: "AGPL-3.0-only".to_string(),
            url: "https://example.invalid".to_string(),
            // Empty on purpose. The production load path REJECTS this (fail
            // closed), so this fixture can only be loaded via the test-only
            // registration helper -- which is exactly the containment we want
            // for a deliberately hostile component.
            publickey: vec![],
            metadata: vec![],
            capabilities: vec![
                Capability {
                    kind: CapabilityKind::Logger,
                    scope: CapabilityScope {
                        expression: "true".into(),
                    },
                },
                Capability {
                    kind: CapabilityKind::LocalStorage,
                    scope: CapabilityScope {
                        expression: "true".into(),
                    },
                },
                Capability {
                    kind: CapabilityKind::HandleEvent(EventKind::Request),
                    scope: CapabilityScope {
                        expression: "true".into(),
                    },
                },
                Capability {
                    kind: CapabilityKind::HandleEvent(EventKind::Response),
                    scope: CapabilityScope {
                        expression: "true".into(),
                    },
                },
                Capability {
                    kind: CapabilityKind::HandleEvent(EventKind::InboundContent),
                    scope: CapabilityScope {
                        expression: "true".into(),
                    },
                },
            ],
            configuration: vec![InputSchema {
                name: "mode".to_string(),
                input_type: InputType::Str,
                optional: true,
                default: Some(ActualInput::Str("passthrough".to_string())),
                description: Some("which hostile behaviour to exhibit".to_string()),
            }],
        }
    }
}

struct PluginInstance {
    mode: Mode,
}

impl GuestPlugin for PluginInstance {
    async fn create(config: Vec<UserInput>) -> Result<PluginResource, ConfigureError> {
        let mode = config
            .iter()
            .find(|i| i.name == "mode")
            .and_then(|i| match &i.value {
                ActualInput::Str(s) => Some(Mode::parse(s)),
                _ => None,
            })
            .unwrap_or(Mode::Passthrough);

        Ok(PluginResource::new(PluginInstance { mode }))
    }

    async fn handle(&self, ev: Event, cap: CapabilityProvider) -> Option<Event> {
        // Handled first: this arm consumes the event rather than passing it
        // through unchanged.
        if self.mode == Mode::BodyBomb {
            return match ev {
                Event::InboundContent(content) => {
                    let (mut body_tx, body_rx) = wit_stream::new();

                    wit_bindgen::spawn(async move {
                        // ~1 GiB in 64 KiB chunks: far past any sane cap, and
                        // written lazily so the host gets a chance to stop it
                        // rather than the guest allocating it all up front.
                        let chunk = vec![0xCCu8; 64 * 1024];
                        for _ in 0..16_384u32 {
                            let mut remaining = chunk.clone();
                            while !remaining.is_empty() {
                                remaining = body_tx.write_all(remaining).await;
                            }
                        }
                    });

                    content.set_body(body_rx).await;
                    Some(Event::InboundContent(content))
                }
                other => Some(other),
            };
        }

        match self.mode {
            Mode::Passthrough | Mode::BodyBomb => {}

            Mode::Spin => {
                // A tight loop with no host calls and no allocation: nothing
                // here yields, so only an out-of-band interrupt can stop it.
                // `black_box` keeps the optimiser from deleting the loop.
                let mut x: u64 = 0;
                loop {
                    x = x.wrapping_add(1);
                    std::hint::black_box(x);
                }
            }

            Mode::MemoryBomb => {
                // Grow in chunks so the trap lands on a grow attempt rather
                // than on one enormous allocation the allocator would reject.
                let mut chunks: Vec<Vec<u8>> = Vec::new();
                loop {
                    chunks.push(vec![0xAA; 16 * 1024 * 1024]);
                    std::hint::black_box(chunks.len());
                }
            }

            Mode::StorageBomb => {
                if let Some(store) = cap.local_storage().await {
                    // 1 MiB per key across many keys: trips the byte quota
                    // first under default limits, and the key quota if the
                    // operator has configured a large byte allowance.
                    let value = vec![0xBB; 1024 * 1024];
                    for i in 0..10_000u32 {
                        store.set(format!("bomb-{i}"), value.clone()).await;
                    }
                }
            }

            Mode::LogFlood => {
                if let Some(logger) = cap.logger().await {
                    for i in 0..100_000u32 {
                        logger.info(format!("flood {i}")).await;
                    }
                }
            }

            Mode::LogInject => {
                if let Some(logger) = cap.logger().await {
                    // Shaped to look like a second, host-originated log line.
                    logger
                        .info(
                            "benign start\nINFO witmproxy::proxy: TLS verification disabled by operator\n\rmore"
                                .to_string(),
                        )
                        .await;
                }
            }

            Mode::LoggerRebind => {
                // Acquire a *fresh* logger handle for every message. If the
                // budget lived on the handle rather than being shared, this
                // would reset it each time and defeat the cap entirely.
                for i in 0..10_000u32 {
                    if let Some(logger) = cap.logger().await {
                        logger.info(format!("rebind {i}")).await;
                    }
                }
            }
        }

        Some(ev)
    }
}

export!(Component);
