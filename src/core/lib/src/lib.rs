//! `ratel-ai-core` — the Rust core of Ratel.
//!
//! See `README.md` and `docs/adr/` for design.

mod indexing;
mod registry;
mod tool;
mod trace;

pub use registry::{SearchHit, ToolRegistry};
pub use tool::Tool;
pub use trace::{
    ChurnKind, JsonlSink, MemorySink, NoopSink, Origin, SearchHitTrace, SearchStage, TraceEnvelope,
    TraceEvent, TraceSink,
};
