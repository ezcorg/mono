//! OpenTelemetry integration for witmproxy.
//!
//! Provides tracing, metrics, and logging export via OTLP when the `otel` feature
//! is enabled and the user has set `telemetry.enabled = true` in the config (or
//! `OTEL_ENABLED=true` env var).

use crate::config::LogConfig;
use std::path::Path;
use tracing_appender::non_blocking::WorkerGuard;

/// Build a rolling file appender from the LogConfig, returning the non-blocking
/// writer and a guard that must be held for the lifetime of the process.
pub fn build_file_writer(
    log_dir: &Path,
    config: &LogConfig,
) -> (tracing_appender::non_blocking::NonBlocking, WorkerGuard) {
    let rotation = match config.rotation.as_str() {
        "hourly" => tracing_appender::rolling::Rotation::HOURLY,
        "never" => tracing_appender::rolling::Rotation::NEVER,
        _ => tracing_appender::rolling::Rotation::DAILY,
    };

    let appender = tracing_appender::rolling::Builder::new()
        .rotation(rotation)
        .filename_prefix("witmproxy")
        .filename_suffix("log")
        .max_log_files(config.max_files)
        .build(log_dir)
        .expect("failed to create rolling file appender");

    tracing_appender::non_blocking(appender)
}

#[cfg(feature = "otel")]
pub mod otel {
    use super::WorkerGuard;
    use crate::config::{LogConfig, TelemetryConfig};
    use opentelemetry::trace::TracerProvider as _;
    use opentelemetry::{KeyValue, global};
    use opentelemetry_otlp::WithExportConfig;
    use opentelemetry_sdk::Resource;
    use opentelemetry_sdk::metrics::SdkMeterProvider;
    use opentelemetry_sdk::trace::SdkTracerProvider;
    use tracing_subscriber::EnvFilter;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    /// Initializes the full tracing subscriber stack with OTel layers.
    /// Returns a guard that shuts down the OTel pipeline on drop.
    ///
    /// When `log_dir` is provided, logs are written to rolling files in that
    /// directory according to the `LogConfig` rotation/retention settings.
    pub fn init_telemetry(
        config: &TelemetryConfig,
        log_config: &LogConfig,
        log_dir: Option<&std::path::Path>,
    ) -> TelemetryGuard {
        let log_level = &log_config.log_level;
        let filter = EnvFilter::try_new(format!("witmproxy={},{}", log_level, log_level))
            .unwrap_or_else(|_| EnvFilter::new("info"));

        let mut tracer_provider: Option<SdkTracerProvider> = None;
        let mut meter_provider: Option<SdkMeterProvider> = None;

        if config.enabled {
            let version = env!("CARGO_PKG_VERSION");
            let resource = Resource::builder()
                .with_attributes([
                    KeyValue::new(
                        opentelemetry_semantic_conventions::attribute::SERVICE_NAME,
                        "witmproxy",
                    ),
                    KeyValue::new(
                        opentelemetry_semantic_conventions::attribute::SERVICE_VERSION,
                        version,
                    ),
                ])
                .build();

            // Traces
            if config.traces_enabled
                && let Ok(exporter) = opentelemetry_otlp::SpanExporter::builder()
                    .with_tonic()
                    .with_endpoint(&config.endpoint)
                    .build()
            {
                let tp = SdkTracerProvider::builder()
                    .with_batch_exporter(exporter)
                    .with_resource(resource.clone())
                    .build();
                tracer_provider = Some(tp);
            }

            // Metrics
            if config.metrics_enabled
                && let Ok(exporter) = opentelemetry_otlp::MetricExporter::builder()
                    .with_tonic()
                    .with_endpoint(&config.endpoint)
                    .build()
            {
                let mp = SdkMeterProvider::builder()
                    .with_periodic_exporter(exporter)
                    .with_resource(resource)
                    .build();
                global::set_meter_provider(mp.clone());
                meter_provider = Some(mp);
            }
        }

        // Build the file writer if a log directory was provided
        let file_writer = log_dir.map(|dir| super::build_file_writer(dir, log_config));

        // Build the subscriber. We branch on whether we have OTel tracing enabled
        // and whether we write to a file, to avoid Option<Layer> type issues.
        let worker_guard = match (tracer_provider.as_ref(), file_writer) {
            (Some(tp), Some((writer, guard))) => {
                let tracer = tp.tracer("witmproxy");
                let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);
                let fmt_layer = tracing_subscriber::fmt::layer()
                    .with_writer(writer)
                    .with_ansi(false);
                tracing_subscriber::registry()
                    .with(filter)
                    .with(fmt_layer)
                    .with(otel_layer)
                    .init();
                Some(guard)
            }
            (Some(tp), None) => {
                let tracer = tp.tracer("witmproxy");
                let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);
                let fmt_layer = tracing_subscriber::fmt::layer();
                tracing_subscriber::registry()
                    .with(filter)
                    .with(fmt_layer)
                    .with(otel_layer)
                    .init();
                None
            }
            (None, Some((writer, guard))) => {
                let fmt_layer = tracing_subscriber::fmt::layer()
                    .with_writer(writer)
                    .with_ansi(false);
                tracing_subscriber::registry()
                    .with(filter)
                    .with(fmt_layer)
                    .init();
                Some(guard)
            }
            (None, None) => {
                let fmt_layer = tracing_subscriber::fmt::layer();
                tracing_subscriber::registry()
                    .with(filter)
                    .with(fmt_layer)
                    .init();
                None
            }
        };

        TelemetryGuard {
            _tracer_provider: tracer_provider,
            _meter_provider: meter_provider,
            _worker_guard: worker_guard,
        }
    }

    /// Guard that shuts down OTel providers when dropped.
    pub struct TelemetryGuard {
        _tracer_provider: Option<SdkTracerProvider>,
        _meter_provider: Option<SdkMeterProvider>,
        _worker_guard: Option<WorkerGuard>,
    }

    impl Drop for TelemetryGuard {
        fn drop(&mut self) {
            if let Some(ref tp) = self._tracer_provider {
                let _ = tp.shutdown();
            }
            if let Some(ref mp) = self._meter_provider {
                let _ = mp.shutdown();
            }
        }
    }

    /// Spawns a background task that periodically emits system resource metrics
    /// (CPU, memory) via the OpenTelemetry meter.
    pub fn spawn_resource_metrics(interval_secs: u64) -> tokio::task::JoinHandle<()> {
        use sysinfo::System;

        tokio::spawn(async move {
            let meter = global::meter("witmproxy.system");

            let cpu_gauge = meter.f64_gauge("system.cpu.utilization").build();
            let mem_used = meter.u64_gauge("system.memory.usage").build();
            let mem_total = meter.u64_gauge("system.memory.limit").build();

            let pid = sysinfo::get_current_pid().ok();
            let mut sys = System::new_all();
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(interval_secs));

            loop {
                interval.tick().await;
                sys.refresh_all();

                // CPU
                if let Some(pid) = pid
                    && let Some(proc_) = sys.process(pid)
                {
                    cpu_gauge.record(
                        proc_.cpu_usage() as f64 / 100.0,
                        &[KeyValue::new("scope", "process")],
                    );
                }
                let global_cpu = sys.global_cpu_usage() as f64 / 100.0;
                cpu_gauge.record(global_cpu, &[KeyValue::new("scope", "system")]);

                // Memory
                if let Some(pid) = pid
                    && let Some(proc_) = sys.process(pid)
                {
                    mem_used.record(proc_.memory(), &[KeyValue::new("scope", "process")]);
                }
                mem_used.record(sys.used_memory(), &[KeyValue::new("scope", "system")]);
                mem_total.record(sys.total_memory(), &[KeyValue::new("scope", "system")]);
            }
        })
    }
}

/// When the `otel` feature is off, telemetry init is a no-op that just sets up
/// the standard tracing subscriber.
#[cfg(not(feature = "otel"))]
pub mod otel {
    use super::WorkerGuard;
    use crate::config::{LogConfig, TelemetryConfig};

    pub struct TelemetryGuard {
        _worker_guard: Option<WorkerGuard>,
    }

    pub fn init_telemetry(
        _config: &TelemetryConfig,
        log_config: &LogConfig,
        log_dir: Option<&std::path::Path>,
    ) -> TelemetryGuard {
        let log_level = &log_config.log_level;
        let filter = format!("witmproxy={},{}", log_level, log_level);
        let worker_guard = if let Some(dir) = log_dir {
            let (writer, guard) = super::build_file_writer(dir, log_config);
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_writer(writer)
                .with_ansi(false)
                .init();
            Some(guard)
        } else {
            tracing_subscriber::fmt().with_env_filter(filter).init();
            None
        };
        TelemetryGuard {
            _worker_guard: worker_guard,
        }
    }
}
