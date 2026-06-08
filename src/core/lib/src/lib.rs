//! `ratel-ai-core` — the Rust core of Ratel.
//!
//! See `README.md` and `docs/adr/` for design.

mod indexing;
mod registry;
mod search;
mod skill;
mod skill_indexing;
mod skill_registry;
mod tool;
mod trace;

pub use registry::{SearchHit, ToolRegistry};
pub use skill::Skill;
pub use skill_registry::{SkillHit, SkillRegistry};
pub use tool::Tool;
pub use trace::{
    ChurnKind, JsonlSink, MemorySink, NoopSink, Origin, SearchHitTrace, SearchStage, SkillHitTrace,
    TraceEnvelope, TraceEvent, TraceSink,
};
