use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::trace::event::{TraceEnvelope, TraceEvent};

const ENVELOPE_VERSION: u32 = 1;

/// A best-effort sink for trace events. Implementations must be cheap on the
/// hot path — see ADR-0007 for the query-log reliability profile (lossy on
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
    session_id: String,
    events: Mutex<Vec<TraceEnvelope>>,
}

impl MemorySink {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            events: Mutex::new(Vec::new()),
        }
    }

    pub fn snapshot(&self) -> Vec<TraceEnvelope> {
        self.events.lock().expect("trace sink poisoned").clone()
    }

    pub fn drain(&self) -> Vec<TraceEnvelope> {
        let mut guard = self.events.lock().expect("trace sink poisoned");
        std::mem::take(&mut *guard)
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }
}

impl TraceSink for MemorySink {
    fn record(&self, event: TraceEvent) {
        let envelope = wrap(self.session_id.clone(), event);
        if let Ok(mut guard) = self.events.lock() {
            guard.push(envelope);
        }
    }
}

pub struct JsonlSink {
    session_id: String,
    file: Mutex<BufWriter<File>>,
}

impl JsonlSink {
    pub fn new(session_id: impl Into<String>, path: impl AsRef<Path>) -> std::io::Result<Self> {
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
            session_id: session_id.into(),
            file: Mutex::new(BufWriter::new(file)),
        })
    }
}

impl TraceSink for JsonlSink {
    fn record(&self, event: TraceEvent) {
        let envelope = wrap(self.session_id.clone(), event);
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

fn wrap(session_id: String, event: TraceEvent) -> TraceEnvelope {
    TraceEnvelope {
        v: ENVELOPE_VERSION,
        ts: now_ms(),
        session_id,
        event,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
