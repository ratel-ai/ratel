//! `ratel-benchmark-retrieval` — Rust half of the benchmark harness.
//!
//! Measures BM25 retrieval quality (recall/precision/MRR/nDCG) against gold
//! tools, ingests external corpora (MetaTool, ToolRet) into a normalized
//! scenario format, and exposes both as a CLI. The TS half (mode (c) — agent
//! campaign + token cost) lives at `benchmark/agent/`.
//!
//! See `docs/adr/0005-benchmark-design.md` and `docs/adr/0006-…` for design.

pub mod corpus;
pub mod ingest;
pub mod retrieval;
pub mod runner;
