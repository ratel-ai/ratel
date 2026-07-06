//! `ratel-ai-core` — the Rust core of Ratel.
//!
//! See `README.md` and `docs/adr/` for design.

mod dense_cache;
mod dense_search;
mod embedding;
mod fusion;
mod indexing;
mod method;
mod search;
mod skill;
mod skill_indexing;
mod skill_registry;
mod tool;
mod tool_registry;
mod trace;

pub use embedding::EmbedderError;
pub use method::{ParseSearchMethodError, SearchMethod};
pub use skill::Skill;
pub use skill_registry::{SkillHit, SkillRegistry};
pub use tool::Tool;
pub use tool_registry::{SearchHit, ToolRegistry};
pub use trace::{
    ChurnKind, EmbedderLoadStatus, JsonlSink, MemorySink, NoopSink, Origin, SearchHitTrace,
    SearchStage, SkillHitTrace, TraceEnvelope, TraceEvent, TraceSink,
};
