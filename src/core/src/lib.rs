//! Tool and skill retrieval for AI agents — the Rust core of the Ratel
//! context engineering platform.
//!
//! Agents degrade when every tool definition is stuffed into the context
//! window. This crate keeps the full catalog *outside* the context and
//! retrieves only the entries relevant to the task at hand: register tools
//! and skills once, then search them per turn. The engine runs in-process;
//! BM25 and local dense retrieval need no server, while dense retrieval may
//! instead use a configured OpenAI-compatible embedding endpoint.
//!
//! # Mental model
//!
//! Three registries hold the corpus, one per capability kind:
//!
//! - [`ToolRegistry`] indexes [`Tool`]s — callable endpoints ranked by name
//!   plus description and JSON schema tokens, or by a searchable-description
//!   override that replaces both.
//! - [`SkillRegistry`] indexes [`Skill`]s — reusable instruction playbooks
//!   whose body is dispatched on demand (a *pull*).
//! - [`FactRegistry`] indexes [`Fact`]s — constant grounding content whose body
//!   the higher layers *push* into the context, always-on or retrieval-gated
//!   per [`PinMode`].
//!
//! All rank a query with one of four engines, selected by [`SearchMethod`]:
//!
//! - [`SearchMethod::Bm25`] (default) — lexical BM25. Needs no model and
//!   never fails; [`ToolRegistry::search`] and [`SkillRegistry::search`] use
//!   it unconditionally.
//! - [`SearchMethod::Semantic`] — cosine similarity over dense embeddings
//!   from a configurable in-process HuggingFace/local model (default
//!   `bge-small-en-v1.5`) or OpenAI-compatible endpoint (ADR-0011/ADR-0012).
//! - [`SearchMethod::Hybrid`] — the BM25 and dense scores normalised and
//!   fused (ADR-0024).
//! - [`SearchMethod::SystemOne`] — a hosted system-one model, Jev, picks
//!   from the candidates; tools and skills only (ADR-0027).
//!
//! [`ToolRegistry::search_with_options`] adds a second stage: a [`Reranker`]
//! re-scores the first stage's top candidates with any other method. A tool
//! catalog can instead be owned by Ratel Cloud: [`ToolRegistry::cloud_sync`]
//! uploads it and [`ToolRegistry::cloud_pick`] ranks through the Cloud Tool
//! Picker (ADR-0027, ADR-0028).
//!
//! Semantic and hybrid searches rank against an embedding cache built by
//! [`ToolRegistry::build_embeddings`] / [`SkillRegistry::build_embeddings`];
//! a search itself never embeds the corpus and never downloads the model.
//!
//! Every register and search also emits a [`TraceEvent`] on the registry's
//! [`TraceSink`] — the local trace stream behind the inspector and usage
//! reporting (ADR-0007). The default sink is [`NoopSink`] (discard);
//! [`MemorySink`] buffers for tests and introspection, [`JsonlSink`] appends
//! to a local file, and [`FnSink`] hands each line to a closure for hosts
//! whose destination this crate cannot own.
//!
//! # Example: register and search (BM25)
//!
//! ```
//! use ratel_ai_core::{Tool, ToolRegistry};
//!
//! let mut registry = ToolRegistry::new();
//! registry.register(Tool {
//!     id: "read_file".into(),
//!     name: "read_file".into(),
//!     description: "Read a file from disk".into(),
//!     experimental_searchable_description: None,
//!     input_schema: serde_json::json!({
//!         "properties": {
//!             "path": { "type": "string" }
//!         }
//!     }),
//!     output_schema: serde_json::json!({}),
//! });
//! registry.register(Tool {
//!     id: "send_email".into(),
//!     name: "send_email".into(),
//!     description: "Send an email to a recipient".into(),
//!     experimental_searchable_description: None,
//!     input_schema: serde_json::json!({}),
//!     output_schema: serde_json::json!({}),
//! });
//!
//! let hits = registry.search("read a file", 5);
//! assert_eq!(hits[0].tool_id, "read_file");
//! ```
//!
//! The language SDKs (`@ratel-ai/sdk` on npm, `ratel-ai` on PyPI) bundle this
//! crate and surface the same model; the agent-facing capability tools
//! (`search_capabilities` / `invoke_tool` / `get_skill_content`) sit on top
//! of them. Design rationale lives in the repo's `docs/adr/`.

#![warn(missing_docs)]

mod artifact_warm;
mod cloud;
mod dense_cache;
mod dense_search;
mod embedding;
mod embedding_artifact;
mod embedding_config;
mod fact;
mod fact_indexing;
mod fact_registry;
mod fusion;
mod indexing;
mod method;
mod rerank;
mod search;
mod skill;
mod skill_indexing;
mod skill_registry;
mod system_one;
mod tool;
mod tool_registry;
mod trace;
mod usage;
mod usage_learner;

#[cfg(test)]
mod harness;
#[cfg(test)]
mod test_support;

pub use artifact_warm::{ArtifactWarmError, OnArtifactMiss, ParseOnArtifactMissError};
pub use cloud::{
    CloudConfig, CloudError, DEFAULT_CLOUD_API_KEY_ENV, DEFAULT_CLOUD_URL, MAX_PICK_TOP_K,
    ParsePickModeError, PickMode, SyncOutcome,
};
pub use dense_cache::WarmError;
pub use embedding::EmbedderError;
pub use embedding_artifact::{ArtifactError, merge_embedding_artifacts};
pub use embedding_config::{EmbeddingModel, EmbeddingSpec, Pooling};
pub use fact::{Fact, ParsePinModeError, PinMode};
pub use fact_registry::{FactHit, FactRegistry};
pub use fusion::{DenseWeight, InvalidDenseWeight};
pub use method::{ParseSearchMethodError, SearchMethod};
pub use rerank::{Reranker, SearchError, SearchOptions};
pub use search::Bm25Params;
pub use skill::Skill;
pub use skill_registry::{ReplaceOutcome, SkillHit, SkillRegistry};
pub use system_one::{
    CandidateKind, DEFAULT_SYSTEM_ONE_API_KEY_ENV, DEFAULT_SYSTEM_ONE_MODEL,
    DEFAULT_SYSTEM_ONE_URL, SystemOneConfig, SystemOneError,
};
pub use tool::Tool;
pub use tool_registry::{AdaptiveRankingStatus, CloudPick, SearchHit, ToolRegistry};
pub use trace::{
    CatalogKind, ChurnKind, EmbedderLoadStatus, FactHitTrace, FactInjectReason, FanoutSink,
    FanoutSubscription, FnSink, JsonlSink, MemorySink, NoopSink, Origin, SearchHitTrace,
    SearchStage, SkillHitTrace, TraceEnvelope, TraceEvent, TraceEventContext, TraceSink,
};
pub use usage::{ClusterPolicy, Intent, IntentGraph, IntentGraphError};
pub use usage_learner::{ObservationPolicy, OriginFilter, Provenance, UsageLearner};
