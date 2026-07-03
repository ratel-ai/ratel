//! `ratel-ai-cloud` — the canonical schema for Ratel Cloud telemetry.
//!
//! An event is the request/response of a single LLM call: resolved provider and
//! model, the messages and tool definitions sent, sampling params, token usage,
//! and finish reason. Developers populate one unified shape (not provider
//! passthrough); this crate is the source of truth that the pure-language
//! clients (`@ratel-ai/cloud`, `ratel-ai-cloud` for Python) mirror, kept honest
//! by the shared conformance fixtures in `../fixtures`.
//!
//! The schema is *strict but forward-compatible*: there is no escape-hatch bag,
//! so the type surface is closed, but deserialization ignores unknown fields so
//! that adding fields later stays non-breaking. Semantic invariants are enforced
//! by [`validate`], not by wire-level rejection.
//!
//! See `README.md` and `docs/adr/0013-cloud-telemetry-unified-schema.md`.

mod content;
mod event;
mod message;
mod validate;

pub use content::Block;
pub use event::{Event, FinishReason, Params, Savings, SourceTokens, ToolDef, Usage};
pub use message::{Content, Message};
pub use validate::{Issue, ValidationError, validate};
