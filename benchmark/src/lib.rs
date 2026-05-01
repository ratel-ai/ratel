//! `ratel-benchmark` — harness for measuring Ratel's retrieval quality and
//! token savings.
//!
//! Two layers, this crate is the Rust half:
//! - retrieval-only metrics (BM25 quality vs gold tools), no LLM calls
//! - corpus loader that feeds both halves a normalized scenario stream
//!
//! See `docs/adr/0005-benchmark-design.md` for design.

pub mod corpus;
pub mod ingest;
pub mod retrieval;
pub mod runner;
