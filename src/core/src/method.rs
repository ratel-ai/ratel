//! The retrieval method a registry uses to rank a query.
//!
//! Three engines coexist and are selectable per registry (a construction-time
//! default) or per call (an explicit override). BM25 is the default — it needs
//! no model and never fails, so the legacy `search`/`search_with_origin` paths
//! stay infallible. Semantic and Hybrid load the embedding model lazily on first
//! use (see `embedding.rs` and ADR-0011).

use std::fmt;
use std::str::FromStr;

/// Which ranking engine a search uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SearchMethod {
    /// Lexical BM25 over the flattened searchable text. Default; no model.
    #[default]
    Bm25,
    /// Dense cosine similarity over embedded tool/skill text.
    Semantic,
    /// BM25 and dense arms fused by Reciprocal Rank Fusion (no reranker).
    Hybrid,
}

impl SearchMethod {
    /// The trace/`as_str` identifier used across the SDKs: `"bm25"`,
    /// `"semantic"`, `"hybrid"`.
    pub fn as_str(&self) -> &'static str {
        match self {
            SearchMethod::Bm25 => "bm25",
            SearchMethod::Semantic => "semantic",
            SearchMethod::Hybrid => "hybrid",
        }
    }
}

impl fmt::Display for SearchMethod {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The identifier did not name a known method.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseSearchMethodError(pub String);

impl fmt::Display for ParseSearchMethodError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "unknown search method {:?} (expected \"bm25\", \"semantic\", or \"hybrid\")",
            self.0
        )
    }
}

impl std::error::Error for ParseSearchMethodError {}

impl FromStr for SearchMethod {
    type Err = ParseSearchMethodError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "bm25" => Ok(SearchMethod::Bm25),
            "semantic" | "dense" => Ok(SearchMethod::Semantic),
            "hybrid" => Ok(SearchMethod::Hybrid),
            other => Err(ParseSearchMethodError(other.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_bm25() {
        assert_eq!(SearchMethod::default(), SearchMethod::Bm25);
    }

    #[test]
    fn round_trips_through_str() {
        for m in [
            SearchMethod::Bm25,
            SearchMethod::Semantic,
            SearchMethod::Hybrid,
        ] {
            assert_eq!(m.as_str().parse::<SearchMethod>().unwrap(), m);
        }
    }

    #[test]
    fn dense_is_an_alias_for_semantic() {
        assert_eq!(
            "dense".parse::<SearchMethod>().unwrap(),
            SearchMethod::Semantic
        );
    }

    #[test]
    fn unknown_method_is_rejected() {
        assert!("keyword".parse::<SearchMethod>().is_err());
    }
}
