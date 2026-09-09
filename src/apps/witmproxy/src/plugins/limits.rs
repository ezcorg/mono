//! Per-plugin resource limits and quota accounting.
//!
//! # Threat model
//!
//! Plugins are untrusted WASM components supplied by third parties. The host
//! runs them inline on the proxy's request path, so a plugin that misbehaves --
//! maliciously or by accident -- degrades service for every user of the proxy.
//! The wasmtime sandbox contains *memory safety*; it does not by itself bound
//! resource consumption.
//!
//! # Design rules
//!
//! 1. **Every limit is expressible globally and per-plugin.** A global default
//!    with no per-plugin override forces an operator to loosen the limit for
//!    everyone in order to accommodate one plugin, which is how limits end up
//!    disabled entirely. `LimitOverrides` therefore mirrors every dimension.
//! 2. **Every limit breach is observable.** Silent clamping hides both attacks
//!    and honest bugs, so a breach always emits a structured `tracing` warning
//!    naming the plugin, the dimension, the observed value and the configured
//!    ceiling.
//! 3. **`0` means unbounded**, consistently, and is preserved through
//!    resolution so an operator can deliberately opt out per plugin.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

/// What the host does when a plugin fails part-way through handling an event.
///
/// The event payload contains linear resources -- most importantly the body,
/// which `wasi:http` models as a move precisely because a stream can be read
/// exactly once. Once a guest has taken the body, the host cannot reconstruct
/// the original event from what remains, so continuing the chain would forward
/// something neither the client nor the upstream asked for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecoveryPolicy {
    /// End the event. The request fails with an error rather than proceeding
    /// with state a failed guest may have consumed or half-modified.
    ///
    /// The default, deliberately: forwarding a possibly-corrupt event is the
    /// worse failure mode, and it is silent.
    #[default]
    FailClosed,
    /// Continue the chain with the event as it was before the failing plugin
    /// ran.
    ///
    /// The host installs a bounded tee on the event's body at handover, so
    /// bytes are retained only as the guest actually reads them: a plugin that
    /// inspects headers and returns costs nothing. Past
    /// `max_event_recovery_buffer_bytes` the host gives up and fails closed
    /// rather than rebuilding a truncated event.
    ///
    /// Recovery restores the event *payload*. It does not undo side effects --
    /// a plugin that wrote to local storage or emitted logs before failing has
    /// still done so.
    FailOpen,
}

/// A fully resolved limit set for one plugin.
///
/// A value of `0` in any field means "unbounded" for that dimension.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResolvedLimits {
    /// WASM fuel (instruction budget) per guest call. Bounds pure computation.
    pub max_fuel: u64,
    /// Guest linear-memory ceiling, in MiB.
    pub max_memory_mb: u64,
    /// Wall-clock ceiling for one guest call, in milliseconds. Enforced by
    /// epoch interruption (which can preempt a non-yielding guest) rather than
    /// by future cancellation alone.
    pub timeout_ms: u64,
    /// Ceiling on total table elements across the store. Table growth is host
    /// allocation that the linear-memory cap does not cover.
    pub max_table_elements: u64,
    /// Ceiling on concurrent instances in one store.
    pub max_instances: u64,
    /// Total bytes a plugin may retain in host-side local storage. This is
    /// host memory, not guest memory, so `max_memory_mb` does not bound it.
    pub max_local_storage_bytes: u64,
    /// Distinct keys a plugin may retain in host-side local storage.
    pub max_local_storage_keys: u64,
    /// Bytes a plugin may emit to the log per event.
    pub max_log_bytes_per_event: u64,
    /// Log messages a plugin may emit per event.
    pub max_log_messages_per_event: u64,
    /// Bytes a plugin may write into a replacement body. Bounds the
    /// amplification available from `content.set-body`.
    pub max_response_body_bytes: u64,
    /// Ceiling on host memory used to duplicate event data so a failed guest
    /// can be recovered from. Only consulted under [`RecoveryPolicy::FailOpen`].
    ///
    /// This is host memory with the same exhaustion shape as local storage: a
    /// plugin that streams a large body forces the host to retain it.
    pub max_event_recovery_buffer_bytes: u64,
    /// What to do when a plugin fails mid-event.
    pub recovery: RecoveryPolicy,
}

impl ResolvedLimits {
    /// Conservative defaults, used when no configuration is supplied.
    ///
    /// These are deliberately finite. A default of "unbounded" would mean the
    /// out-of-the-box configuration is the vulnerable one, and most operators
    /// never revisit defaults.
    pub const DEFAULTS: Self = Self {
        // Unbounded by default. `timeout_ms` is the DoS control here: it is
        // enforced by epoch interruption, which preempts even a guest that
        // never yields, and it bounds the thing an operator actually cares
        // about -- wall clock. Fuel bounds an abstract instruction count that
        // nobody can size correctly: the previous default of 1,000,000 could
        // not parse a 400 KB HTML page, so it broke every content-rewriting
        // plugin on a real-world page while adding nothing the timeout did not
        // already cover. Still available for operators who want a
        // deterministic compute bound.
        max_fuel: 0,
        max_memory_mb: 1024,
        timeout_ms: 10_000,
        max_table_elements: 100_000,
        max_instances: 64,
        max_local_storage_bytes: 8 * 1024 * 1024,
        max_local_storage_keys: 4096,
        max_log_bytes_per_event: 64 * 1024,
        max_log_messages_per_event: 256,
        max_response_body_bytes: 128 * 1024 * 1024,
        max_event_recovery_buffer_bytes: 16 * 1024 * 1024,
        recovery: RecoveryPolicy::FailClosed,
    };
}

impl Default for ResolvedLimits {
    fn default() -> Self {
        Self::DEFAULTS
    }
}

/// Per-plugin overrides. `None` means "inherit the global value".
///
/// Every dimension in [`ResolvedLimits`] appears here; that symmetry is the
/// escape hatch that keeps an operator from having to relax a global limit in
/// order to accommodate a single plugin.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LimitOverrides {
    pub max_fuel: Option<u64>,
    pub max_memory_mb: Option<u64>,
    pub timeout_ms: Option<u64>,
    pub max_table_elements: Option<u64>,
    pub max_instances: Option<u64>,
    pub max_local_storage_bytes: Option<u64>,
    pub max_local_storage_keys: Option<u64>,
    pub max_log_bytes_per_event: Option<u64>,
    pub max_log_messages_per_event: Option<u64>,
    pub max_response_body_bytes: Option<u64>,
    pub max_event_recovery_buffer_bytes: Option<u64>,
    pub recovery: Option<RecoveryPolicy>,
}

impl LimitOverrides {
    /// True when no dimension is overridden (the common case; lets callers skip
    /// storing a row at all).
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// Apply these overrides on top of a global baseline.
    pub fn resolve(&self, global: &ResolvedLimits) -> ResolvedLimits {
        ResolvedLimits {
            max_fuel: self.max_fuel.unwrap_or(global.max_fuel),
            max_memory_mb: self.max_memory_mb.unwrap_or(global.max_memory_mb),
            timeout_ms: self.timeout_ms.unwrap_or(global.timeout_ms),
            max_table_elements: self.max_table_elements.unwrap_or(global.max_table_elements),
            max_instances: self.max_instances.unwrap_or(global.max_instances),
            max_local_storage_bytes: self
                .max_local_storage_bytes
                .unwrap_or(global.max_local_storage_bytes),
            max_local_storage_keys: self
                .max_local_storage_keys
                .unwrap_or(global.max_local_storage_keys),
            max_log_bytes_per_event: self
                .max_log_bytes_per_event
                .unwrap_or(global.max_log_bytes_per_event),
            max_log_messages_per_event: self
                .max_log_messages_per_event
                .unwrap_or(global.max_log_messages_per_event),
            max_response_body_bytes: self
                .max_response_body_bytes
                .unwrap_or(global.max_response_body_bytes),
            max_event_recovery_buffer_bytes: self
                .max_event_recovery_buffer_bytes
                .unwrap_or(global.max_event_recovery_buffer_bytes),
            recovery: self.recovery.unwrap_or(global.recovery),
        }
    }
}

/// The resource dimension a plugin exceeded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LimitKind {
    Fuel,
    Memory,
    Timeout,
    TableElements,
    Instances,
    LocalStorageBytes,
    LocalStorageKeys,
    LogBytes,
    LogMessages,
    ResponseBodyBytes,
    EventRecoveryBufferBytes,
}

impl LimitKind {
    /// Stable identifier used as a structured log field, so breaches can be
    /// alerted on without parsing human-readable text.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fuel => "max_fuel",
            Self::Memory => "max_memory_mb",
            Self::Timeout => "timeout_ms",
            Self::TableElements => "max_table_elements",
            Self::Instances => "max_instances",
            Self::LocalStorageBytes => "max_local_storage_bytes",
            Self::LocalStorageKeys => "max_local_storage_keys",
            Self::LogBytes => "max_log_bytes_per_event",
            Self::LogMessages => "max_log_messages_per_event",
            Self::ResponseBodyBytes => "max_response_body_bytes",
            Self::EventRecoveryBufferBytes => "max_event_recovery_buffer_bytes",
        }
    }
}

impl std::fmt::Display for LimitKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Counts limit breaches per plugin and emits a structured warning for each.
///
/// Shared via `Arc` because the capability clients that detect breaches (local
/// storage, logger, body writer) outlive any single guest call.
#[derive(Debug, Default)]
pub struct BreachRecorder {
    plugin_id: String,
    breaches: AtomicU64,
    /// Warnings emitted so far. A plugin hammering a limit in a tight loop must
    /// not be able to turn the *warning* into its own log-flood DoS, so the
    /// count is reported but the emission is capped.
    warnings_emitted: AtomicU64,
}

/// Warnings per recorder before emission is suppressed. The running total is
/// still tracked and reported on the suppression notice.
const MAX_WARNINGS: u64 = 32;

impl BreachRecorder {
    pub fn new(plugin_id: impl Into<String>) -> Arc<Self> {
        Arc::new(Self {
            plugin_id: plugin_id.into(),
            breaches: AtomicU64::new(0),
            warnings_emitted: AtomicU64::new(0),
        })
    }

    /// Total breaches recorded for this plugin.
    pub fn count(&self) -> u64 {
        self.breaches.load(Ordering::Relaxed)
    }

    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    /// Record a breach and emit a structured warning.
    ///
    /// `observed` and `limit` are reported so an operator can distinguish a
    /// plugin that is marginally over a tight limit (probably a misconfigured
    /// limit) from one that is orders of magnitude over (probably hostile).
    pub fn record(&self, kind: LimitKind, observed: u64, limit: u64) {
        let total = self.breaches.fetch_add(1, Ordering::Relaxed) + 1;
        let emitted = self.warnings_emitted.fetch_add(1, Ordering::Relaxed) + 1;

        if emitted <= MAX_WARNINGS {
            tracing::warn!(
                target: "plugins::limits",
                plugin_id = %self.plugin_id,
                limit = kind.as_str(),
                observed,
                limit_value = limit,
                breach_count = total,
                "plugin exceeded a resource limit; request denied for this dimension"
            );
        }
        if emitted == MAX_WARNINGS {
            tracing::warn!(
                target: "plugins::limits",
                plugin_id = %self.plugin_id,
                breach_count = total,
                "further limit-breach warnings for this plugin will be suppressed; \
                 the breach counter keeps incrementing"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_default_to_global() {
        let global = ResolvedLimits::DEFAULTS;
        let resolved = LimitOverrides::default().resolve(&global);
        assert_eq!(resolved, global);
    }

    #[test]
    fn overrides_win_over_global() {
        let global = ResolvedLimits::DEFAULTS;
        let overrides = LimitOverrides {
            max_fuel: Some(42),
            timeout_ms: Some(5),
            ..Default::default()
        };
        let resolved = overrides.resolve(&global);
        assert_eq!(resolved.max_fuel, 42);
        assert_eq!(resolved.timeout_ms, 5);
        // Untouched dimensions still inherit.
        assert_eq!(resolved.max_memory_mb, global.max_memory_mb);
    }

    /// A per-plugin override of `0` must survive resolution: that is the
    /// documented escape hatch for deliberately unbounding one plugin.
    #[test]
    fn zero_override_is_preserved_as_unbounded() {
        let global = ResolvedLimits {
            max_fuel: 1000,
            ..ResolvedLimits::DEFAULTS
        };
        let overrides = LimitOverrides {
            max_fuel: Some(0),
            ..Default::default()
        };
        assert_eq!(overrides.resolve(&global).max_fuel, 0);
    }

    /// Symmetry between the two structs is the property that guarantees rule 1
    /// (no globally-only limit). If a dimension is added to `ResolvedLimits`
    /// without a matching override, this fails.
    #[test]
    fn every_dimension_has_an_override() {
        let global = ResolvedLimits {
            max_fuel: 1,
            max_memory_mb: 1,
            timeout_ms: 1,
            max_table_elements: 1,
            max_instances: 1,
            max_local_storage_bytes: 1,
            max_local_storage_keys: 1,
            max_log_bytes_per_event: 1,
            max_log_messages_per_event: 1,
            max_response_body_bytes: 1,
            max_event_recovery_buffer_bytes: 1,
            recovery: RecoveryPolicy::FailClosed,
        };
        let all = LimitOverrides {
            max_fuel: Some(9),
            max_memory_mb: Some(9),
            timeout_ms: Some(9),
            max_table_elements: Some(9),
            max_instances: Some(9),
            max_local_storage_bytes: Some(9),
            max_local_storage_keys: Some(9),
            max_log_bytes_per_event: Some(9),
            max_log_messages_per_event: Some(9),
            max_response_body_bytes: Some(9),
            max_event_recovery_buffer_bytes: Some(9),
            recovery: Some(RecoveryPolicy::FailOpen),
        };
        let r = all.resolve(&global);
        // Every field must have taken the override value.
        assert_eq!(
            r,
            ResolvedLimits {
                max_fuel: 9,
                max_memory_mb: 9,
                timeout_ms: 9,
                max_table_elements: 9,
                max_instances: 9,
                max_local_storage_bytes: 9,
                max_local_storage_keys: 9,
                max_log_bytes_per_event: 9,
                max_log_messages_per_event: 9,
                max_response_body_bytes: 9,
                max_event_recovery_buffer_bytes: 9,
                recovery: RecoveryPolicy::FailOpen,
            }
        );
    }

    #[test]
    fn is_empty_detects_no_overrides() {
        assert!(LimitOverrides::default().is_empty());
        assert!(
            !LimitOverrides {
                max_fuel: Some(1),
                ..Default::default()
            }
            .is_empty()
        );
    }

    #[test]
    fn recorder_counts_every_breach_even_when_warnings_are_suppressed() {
        let rec = BreachRecorder::new("ns/name");
        for _ in 0..(MAX_WARNINGS + 50) {
            rec.record(LimitKind::LogBytes, 100, 10);
        }
        assert_eq!(rec.count(), MAX_WARNINGS + 50);
    }

    #[test]
    fn overrides_roundtrip_through_json() {
        let o = LimitOverrides {
            max_fuel: Some(7),
            max_local_storage_bytes: Some(0),
            ..Default::default()
        };
        let json = serde_json::to_string(&o).unwrap();
        let back: LimitOverrides = serde_json::from_str(&json).unwrap();
        assert_eq!(o, back);
    }
}
