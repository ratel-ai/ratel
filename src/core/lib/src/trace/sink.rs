use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::trace::event::{TraceEnvelope, TraceEvent};

const ENVELOPE_VERSION: u32 = 1;

/// Stamps [`TraceEvent`]s into [`TraceEnvelope`]s: version, timestamp,
/// session identity, and a per-session monotonic `seq`. Share ONE stamper
/// across every sink of a session — `(session_id, seq)` is only unique under
/// a shared stamper (ADR-0013).
pub struct EnvelopeStamper {
    session_id: String,
    harness: Option<String>,
    environment: Option<String>,
    sdk_version: Option<String>,
    /// Mutable mid-session: the catalog-sync layer re-points it on every
    /// version change, and a stamp reflects the value at record time.
    catalog_version: Mutex<Option<String>>,
    seq: AtomicU64,
}

impl EnvelopeStamper {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            harness: None,
            environment: None,
            sdk_version: None,
            catalog_version: Mutex::new(None),
            seq: AtomicU64::new(0),
        }
    }

    pub fn with_harness(mut self, harness: impl Into<String>) -> Self {
        self.harness = Some(harness.into());
        self
    }

    pub fn with_environment(mut self, environment: impl Into<String>) -> Self {
        self.environment = Some(environment.into());
        self
    }

    pub fn with_sdk_version(mut self, sdk_version: impl Into<String>) -> Self {
        self.sdk_version = Some(sdk_version.into());
        self
    }

    pub fn with_catalog_version(self, catalog_version: impl Into<String>) -> Self {
        *self.catalog_version.lock().expect("stamper poisoned") = Some(catalog_version.into());
        self
    }

    pub fn set_catalog_version(&self, catalog_version: Option<String>) {
        if let Ok(mut guard) = self.catalog_version.lock() {
            *guard = catalog_version;
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn stamp(&self, event: TraceEvent) -> TraceEnvelope {
        TraceEnvelope {
            v: ENVELOPE_VERSION,
            ts: now_ms(),
            session_id: self.session_id.clone(),
            seq: Some(self.seq.fetch_add(1, Ordering::Relaxed)),
            harness: self.harness.clone(),
            environment: self.environment.clone(),
            sdk_version: self.sdk_version.clone(),
            catalog_version: self
                .catalog_version
                .lock()
                .ok()
                .and_then(|guard| guard.clone()),
            event,
        }
    }
}

/// A best-effort sink for trace events. Implementations must be cheap on the
/// hot path — see ADR-0009 for the query-log reliability profile (lossy on
/// backpressure is fine, blocking the agent loop is not).
pub trait TraceSink: Send + Sync {
    fn record(&self, event: TraceEvent);

    /// Per-sink rate limit hint. Currently a documentation knob; v0.1.5 doesn't
    /// rate-limit anywhere, but the contract is in place so consumers can
    /// adopt it without a breaking change.
    fn sample_rate(&self) -> f64 {
        1.0
    }
}

pub struct NoopSink;

impl TraceSink for NoopSink {
    fn record(&self, _event: TraceEvent) {}
}

pub struct MemorySink {
    stamper: Arc<EnvelopeStamper>,
    events: Mutex<VecDeque<TraceEnvelope>>,
    capacity: Option<usize>,
    dropped: AtomicU64,
}

impl MemorySink {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self::with_stamper(Arc::new(EnvelopeStamper::new(session_id)))
    }

    pub fn with_stamper(stamper: Arc<EnvelopeStamper>) -> Self {
        Self {
            stamper,
            events: Mutex::new(VecDeque::new()),
            capacity: None,
            dropped: AtomicU64::new(0),
        }
    }

    /// Bounds the buffer: past `capacity` events, the oldest are dropped
    /// (query-log semantics — losing a trace beats unbounded growth when the
    /// drainer stalls). Default is unbounded for backwards compatibility.
    pub fn with_capacity(mut self, capacity: usize) -> Self {
        self.capacity = Some(capacity);
        self
    }

    /// Number of events dropped to the capacity bound since construction.
    pub fn dropped_count(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub fn snapshot(&self) -> Vec<TraceEnvelope> {
        self.events
            .lock()
            .expect("trace sink poisoned")
            .iter()
            .cloned()
            .collect()
    }

    pub fn drain(&self) -> Vec<TraceEnvelope> {
        let mut guard = self.events.lock().expect("trace sink poisoned");
        std::mem::take(&mut *guard).into_iter().collect()
    }

    pub fn session_id(&self) -> &str {
        self.stamper.session_id()
    }

    pub fn stamper(&self) -> &Arc<EnvelopeStamper> {
        &self.stamper
    }
}

impl TraceSink for MemorySink {
    fn record(&self, event: TraceEvent) {
        let envelope = self.stamper.stamp(event);
        if let Ok(mut guard) = self.events.lock() {
            if let Some(capacity) = self.capacity {
                while guard.len() >= capacity {
                    guard.pop_front();
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                }
            }
            guard.push_back(envelope);
        }
    }
}

pub struct JsonlSink {
    stamper: Arc<EnvelopeStamper>,
    file: Mutex<BufWriter<File>>,
}

impl JsonlSink {
    pub fn new(session_id: impl Into<String>, path: impl AsRef<Path>) -> std::io::Result<Self> {
        Self::with_stamper(Arc::new(EnvelopeStamper::new(session_id)), path)
    }

    pub fn with_stamper(
        stamper: Arc<EnvelopeStamper>,
        path: impl AsRef<Path>,
    ) -> std::io::Result<Self> {
        let path: PathBuf = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(Self {
            stamper,
            file: Mutex::new(BufWriter::new(file)),
        })
    }
}

impl TraceSink for JsonlSink {
    fn record(&self, event: TraceEvent) {
        let envelope = self.stamper.stamp(event);
        let Ok(line) = serde_json::to_string(&envelope) else {
            return;
        };
        if let Ok(mut guard) = self.file.lock() {
            // Best-effort: a write failure should not crash the agent loop.
            let _ = writeln!(guard, "{line}");
            let _ = guard.flush();
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
