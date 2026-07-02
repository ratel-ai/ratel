//! `ratel-ai-core` — the Rust core of Ratel.
//!
//! See `README.md` and `docs/adr/` for design.

mod indexing;
mod search;
mod skill;
mod skill_indexing;
mod skill_registry;
mod tool;
mod tool_registry;
mod trace;

pub use skill::Skill;
pub use skill_registry::{SkillHit, SkillRegistry, SkillSearchOutcome};
pub use tool::Tool;
pub use tool_registry::{SearchHit, SearchOutcome, ToolRegistry};
pub use trace::{
    ChurnKind, EnvelopeStamper, ErrorKind, GatewaySkillHitTrace, GatewayToolHitTrace, JsonlSink,
    MemorySink, NoopSink, Origin, SearchHitTrace, SearchStage, SkillHitTrace, TraceEnvelope,
    TraceEvent, TraceSink,
};
