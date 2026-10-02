//! Two-stage retrieval: a first-stage [`SearchMethod`] picks candidates, an
//! optional [`Reranker`] re-scores the top `depth` of them with any method
//! (ADR-0027).
//!
//! The reranker sees only stage 1's candidates; it never widens the set. Its
//! score replaces stage 1's, and ties fall back to stage 1's order rather than
//! the id, so a candidate the reranker cannot tell apart from another keeps the
//! position stage 1 gave it.

use std::fmt;

use crate::embedding::EmbedderError;
use crate::method::SearchMethod;
use crate::system_one::SystemOneError;
use crate::trace::TraceEventContext;

/// A second-stage ranker over the first stage's top `depth` candidates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reranker {
    method: SearchMethod,
    depth: usize,
}

impl Reranker {
    /// How many stage-1 candidates a reranker re-scores unless told otherwise.
    pub const DEFAULT_DEPTH: usize = 50;

    /// A reranker using `method` over the default depth.
    #[must_use]
    pub fn new(method: SearchMethod) -> Self {
        Self {
            method,
            depth: Self::DEFAULT_DEPTH,
        }
    }

    /// Re-score the top `depth` stage-1 candidates instead of the default. A
    /// depth below the search's `top_k` is raised to `top_k`, so a reranker
    /// never returns fewer hits than the caller asked for.
    ///
    /// # Errors
    /// [`SearchError::InvalidOptions`] if `depth` is zero.
    pub fn with_depth(self, depth: usize) -> Result<Self, SearchError> {
        if depth == 0 {
            return Err(SearchError::InvalidOptions {
                message: "reranker depth must be at least 1".into(),
            });
        }
        Ok(Self { depth, ..self })
    }

    /// The method that re-scores the candidates.
    #[must_use]
    pub fn method(&self) -> SearchMethod {
        self.method
    }

    /// How many stage-1 candidates are re-scored.
    #[must_use]
    pub fn depth(&self) -> usize {
        self.depth
    }
}

/// Everything a search needs beyond the query and `top_k`.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct SearchOptions {
    /// The first-stage method.
    pub method: SearchMethod,
    /// The optional second stage.
    pub reranker: Option<Reranker>,
    /// Event identity and OTel correlation for the emitted trace.
    pub context: TraceEventContext,
}

impl SearchOptions {
    /// Search with `method` alone.
    #[must_use]
    pub fn new(method: SearchMethod) -> Self {
        Self {
            method,
            ..Self::default()
        }
    }

    /// Re-score the first stage's candidates with `reranker`.
    #[must_use]
    pub fn with_reranker(mut self, reranker: Reranker) -> Self {
        self.reranker = Some(reranker);
        self
    }

    /// Attach caller-supplied event identity and correlation.
    #[must_use]
    pub fn with_context(mut self, context: TraceEventContext) -> Self {
        self.context = context;
        self
    }
}

/// A search failed.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum SearchError {
    /// The semantic or hybrid path failed (see [`EmbedderError`]).
    Embedder(EmbedderError),
    /// A standalone system-one search failed (see [`SystemOneError`]). A
    /// system-one *reranker* never raises this: it falls back to stage 1.
    SystemOne(SystemOneError),
    /// The search options cannot be honoured — e.g. a reranker using the same
    /// method as the first stage, which would only re-derive stage 1's order.
    InvalidOptions {
        /// What is wrong with the options.
        message: String,
    },
}

impl fmt::Display for SearchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SearchError::Embedder(e) => e.fmt(f),
            SearchError::SystemOne(e) => e.fmt(f),
            SearchError::InvalidOptions { message } => {
                write!(f, "invalid search options: {message}")
            }
        }
    }
}

impl std::error::Error for SearchError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            SearchError::Embedder(e) => Some(e),
            SearchError::SystemOne(e) => Some(e),
            SearchError::InvalidOptions { .. } => None,
        }
    }
}

impl From<SystemOneError> for SearchError {
    fn from(e: SystemOneError) -> Self {
        SearchError::SystemOne(e)
    }
}

impl From<EmbedderError> for SearchError {
    fn from(e: EmbedderError) -> Self {
        SearchError::Embedder(e)
    }
}

/// Order re-scored candidates best-first: score descending, then stage-1
/// position ascending. `stage_one` is the candidates' stage-1 order.
pub(crate) fn order_by_rescore(scored: &mut [(String, f32)], stage_one: &[String]) {
    use std::collections::HashMap;
    let position: HashMap<&str, usize> = stage_one
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    let pos = |id: &str| position.get(id).copied().unwrap_or(usize::MAX);
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| pos(&a.0).cmp(&pos(&b.0)))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_depth_is_fifty() {
        assert_eq!(Reranker::new(SearchMethod::Semantic).depth(), 50);
    }

    #[test]
    fn zero_depth_is_rejected() {
        assert!(matches!(
            Reranker::new(SearchMethod::Bm25).with_depth(0),
            Err(SearchError::InvalidOptions { .. })
        ));
    }

    #[test]
    fn ties_keep_stage_one_order_not_id_order() {
        let stage_one = vec!["zeta".to_string(), "alpha".to_string(), "mid".to_string()];
        let mut scored = vec![
            ("alpha".to_string(), 0.0),
            ("mid".to_string(), 0.9),
            ("zeta".to_string(), 0.0),
        ];
        order_by_rescore(&mut scored, &stage_one);
        let ids: Vec<&str> = scored.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, vec!["mid", "zeta", "alpha"]);
    }
}
