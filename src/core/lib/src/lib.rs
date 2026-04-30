//! `ratel-core` — the Rust core of Ratel.
//!
//! See `README.md` and `docs/adr/` for design.

mod indexing;
mod registry;
mod tool;

pub use registry::{SearchHit, ToolRegistry};
pub use tool::Tool;
