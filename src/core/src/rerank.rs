//! Two-stage retrieval and caller-supplied ranking (ADR-0027).
//!
//! A first-stage [`SearchMethod`] picks candidates and an optional [`Reranker`]
//! re-scores the top `depth` of them with another built-in method. A ranking
//! function the caller supplies (a model the SDK calls, e.g. Jev) runs outside
//! the registry, between two phases: the registry hands out [`RankCandidate`]s
//! (the whole catalog, or a [`StageOne`]) and completes the search with what the
//! function returned.
//!
//! A reranker sees only stage 1's candidates; it never widens the set. Its
//! score replaces stage 1's, and ties fall back to stage 1's order rather than
//! the id, so a candidate the reranker cannot tell apart from another keeps the
//! position stage 1 gave it.

use std::collections::HashSet;
use std::fmt;
use std::time::Instant;

use crate::embedding::EmbedderError;
use crate::method::SearchMethod;
use crate::trace::{SearchStage, TraceEventContext};

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

/// A catalog item offered to a caller-supplied ranking function: its id and
/// the text the built-in methods rank (ADR-0004, ADR-0021).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RankCandidate {
    /// The tool or skill id.
    pub id: String,
    /// Its searchable text.
    pub text: String,
}

/// Stage 1 of a search whose reranker runs outside the registry: the
/// candidates to rerank, best first. Hand it back to the registry's
/// `complete_rerank` with the reranker's outcome; it records the search then.
#[derive(Debug)]
pub struct StageOne<H> {
    pub(crate) candidates: Vec<RankCandidate>,
    pub(crate) hits: Vec<H>,
    pub(crate) stages: Vec<SearchStage>,
    pub(crate) top_k: usize,
    pub(crate) started: Instant,
}

impl<H> StageOne<H> {
    /// The candidates to rerank, in stage 1's order. Empty when the catalog
    /// is empty, nothing matched, or `top_k` is zero: there is nothing to ask.
    #[must_use]
    pub fn candidates(&self) -> &[RankCandidate] {
        &self.candidates
    }

    pub(crate) fn ids(&self) -> Vec<String> {
        self.candidates.iter().map(|c| c.id.clone()).collect()
    }
}

/// What a caller-supplied reranker produced.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum RerankOutcome {
    /// `(id, score)` pairs, in any order; see the registry's `complete_rerank`.
    Ranked(Vec<(String, f32)>),
    /// The reranker failed transiently; keep stage 1's order. `code` names the
    /// failure and is recorded as a `rerank_fallback:<code>` stage.
    Fallback {
        /// A short failure code, e.g. `Timeout`.
        code: String,
    },
}

/// A search failed.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum SearchError {
    /// The semantic or hybrid path failed (see [`EmbedderError`]).
    Embedder(EmbedderError),
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
            SearchError::InvalidOptions { .. } => None,
        }
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

/// Clean a caller-supplied ranking: ids `known` accepts, each once (the first
/// wins), scores clamped to `[0, 1]` with a non-finite score read as `0`.
fn sanitize(ranked: Vec<(String, f32)>, known: impl Fn(&str) -> bool) -> Vec<(String, f32)> {
    let mut seen = HashSet::new();
    ranked
        .into_iter()
        .filter(|(id, _)| known(id) && seen.insert(id.clone()))
        .map(|(id, score)| {
            let score = if score.is_finite() {
                score.clamp(0.0, 1.0)
            } else {
                0.0
            };
            (id, score)
        })
        .collect()
}

/// A caller-supplied ranking of the whole catalog, ready to become hits: only
/// the ids it returned, best first (ties keep the function's order), at most
/// `top_k`. Unknown ids are dropped — nothing here could invoke them.
pub(crate) fn order_retrieved(
    ranked: Vec<(String, f32)>,
    known: impl Fn(&str) -> bool,
    top_k: usize,
) -> Vec<(String, f32)> {
    let mut ranked = sanitize(ranked, known);
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    ranked.truncate(top_k);
    ranked
}

/// A caller-supplied reranking of stage 1's candidates, ready to become hits.
/// Like a built-in reranker it never widens the set: ids outside stage 1 are
/// dropped, and candidates the function left out follow at `0`, so the list
/// still fills `top_k`. Ordered by [`order_by_rescore`].
pub(crate) fn order_reranked(
    ranked: Vec<(String, f32)>,
    stage_one: &[String],
    top_k: usize,
) -> Vec<(String, f32)> {
    let offered: HashSet<&str> = stage_one.iter().map(String::as_str).collect();
    let mut ranked = sanitize(ranked, |id| offered.contains(id));
    let returned: HashSet<String> = ranked.iter().map(|(id, _)| id.clone()).collect();
    ranked.extend(
        stage_one
            .iter()
            .filter(|id| !returned.contains(*id))
            .map(|id| (id.clone(), 0.0)),
    );
    order_by_rescore(&mut ranked, stage_one);
    ranked.truncate(top_k);
    ranked
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

    fn pairs(list: &[(&str, f32)]) -> Vec<(String, f32)> {
        list.iter().map(|(id, s)| (id.to_string(), *s)).collect()
    }

    fn ids(list: &[(String, f32)]) -> Vec<&str> {
        list.iter().map(|(id, _)| id.as_str()).collect()
    }

    #[test]
    fn retrieved_drops_unknown_and_duplicate_ids() {
        let got = order_retrieved(
            pairs(&[("a", 0.2), ("ghost", 0.9), ("b", 0.5), ("a", 0.99)]),
            |id| id != "ghost",
            10,
        );
        assert_eq!(got, pairs(&[("b", 0.5), ("a", 0.2)]));
    }

    #[test]
    fn retrieved_clamps_scores_and_zeroes_non_finite_ones() {
        let got = order_retrieved(
            pairs(&[
                ("a", 7.0),
                ("b", f32::NAN),
                ("c", -1.0),
                ("d", f32::INFINITY),
            ]),
            |_| true,
            10,
        );
        assert_eq!(
            got,
            pairs(&[("a", 1.0), ("b", 0.0), ("c", 0.0), ("d", 0.0)])
        );
    }

    #[test]
    fn retrieved_ties_keep_the_functions_order_and_respect_top_k() {
        let got = order_retrieved(pairs(&[("z", 0.5), ("a", 0.5), ("m", 0.9)]), |_| true, 2);
        assert_eq!(ids(&got), vec!["m", "z"]);
    }

    #[test]
    fn reranked_never_widens_and_fills_with_what_it_left_out() {
        let stage_one = vec!["s1".to_string(), "s2".to_string(), "s3".to_string()];
        let got = order_reranked(pairs(&[("s3", 0.8), ("outsider", 1.0)]), &stage_one, 3);
        assert_eq!(ids(&got), vec!["s3", "s1", "s2"]);
        assert_eq!(got[1].1, 0.0);
    }

    #[test]
    fn reranked_ties_keep_stage_one_order_and_respect_top_k() {
        let stage_one = vec!["s1".to_string(), "s2".to_string(), "s3".to_string()];
        let got = order_reranked(pairs(&[("s3", 0.4), ("s2", 0.4)]), &stage_one, 2);
        assert_eq!(ids(&got), vec!["s2", "s3"]);
    }
}
