//! Rank fusion and the shared deterministic ordering used across rankers.
//!
//! Reciprocal Rank Fusion (RRF) combines the BM25 and dense rankings into one
//! candidate list for the hybrid pipeline (see [`crate::tool_registry`] and
//! ADR-0013). It fuses on *rank position*, not raw scores, so it is immune to
//! the incomparable scales of BM25 (unbounded) and cosine ([-1, 1]). Pure Rust,
//! no heavy deps — its tests run on every build without a model download.

/// RRF damping constant. 60 is the Cormack et al. (2009) default and the field
/// standard; large enough that the reciprocal curve is gentle past the head of
/// each list, small enough that top ranks still dominate.
pub(crate) const RRF_K: f32 = 60.0;

/// How deep each arm (BM25, dense) retrieves before fusion. Deeper than `top_k`
/// so a tool the two arms rank differently still has rank signal to fuse.
pub(crate) const RETRIEVE_DEPTH: usize = 100;

/// Max candidates the cross-encoder scores after fusion. Bounds the per-query
/// rerank cost (one forward pass per candidate); the reranker is what decides
/// the final order, so this only has to be wide enough to contain the gold.
pub(crate) const RERANK_POOL: usize = 50;

/// Reciprocal Rank Fusion over already-ranked, best-first id lists.
///
/// `score(id) = Σ_list 1 / (k + rank_in_list)`, with `rank` 0-based. An id
/// absent from a list contributes nothing for that list. The result is sorted
/// best-first with ties broken by `id` ascending — the same `(score desc, id
/// asc)` contract [`crate::search::bm25_search`] and [`crate::dense_search`]
/// guarantee, so fused top-K membership is stable across processes regardless of
/// input order. Empty input yields an empty result.
pub(crate) fn rrf_fuse(lists: &[&[String]], k: f32) -> Vec<(String, f32)> {
    use std::collections::HashMap;

    let mut scores: HashMap<&str, f32> = HashMap::new();
    for list in lists {
        for (rank, id) in list.iter().enumerate() {
            *scores.entry(id.as_str()).or_insert(0.0) += 1.0 / (k + rank as f32);
        }
    }
    let mut ranked: Vec<(String, f32)> = scores
        .into_iter()
        .map(|(id, score)| (id.to_string(), score))
        .collect();
    let len = ranked.len();
    sort_and_truncate(&mut ranked, len);
    ranked
}

/// The shared `(score desc, id asc)` ordering, then truncate to `top_k`. Ranking
/// the full set before the cut keeps top-K *membership* stable when a tie
/// straddles the boundary — see the rationale in [`crate::search::bm25_search`].
pub(crate) fn sort_and_truncate(ranked: &mut Vec<(String, f32)>, top_k: usize) {
    ranked.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    ranked.truncate(top_k);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn empty_input_yields_no_hits() {
        assert!(rrf_fuse(&[], RRF_K).is_empty());
        let empty: Vec<String> = Vec::new();
        assert!(rrf_fuse(&[empty.as_slice()], RRF_K).is_empty());
    }

    #[test]
    fn single_list_preserves_order_with_reciprocal_scores() {
        let list = ids(&["a", "b", "c"]);
        let fused = rrf_fuse(&[list.as_slice()], RRF_K);
        assert_eq!(
            fused.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
        // score(rank r) = 1 / (60 + r)
        assert!((fused[0].1 - 1.0 / 60.0).abs() < 1e-6);
        assert!((fused[1].1 - 1.0 / 61.0).abs() < 1e-6);
        assert!((fused[2].1 - 1.0 / 62.0).abs() < 1e-6);
    }

    #[test]
    fn doc_in_both_lists_outranks_doc_in_one() {
        // "shared" sits rank 1 in both lists; "solo" sits rank 0 in one only.
        // 1/61 + 1/61 ≈ 0.0328 beats 1/60 ≈ 0.0167 — agreement across arms wins.
        let bm25 = ids(&["solo", "shared"]);
        let dense = ids(&["other", "shared"]);
        let fused = rrf_fuse(&[bm25.as_slice(), dense.as_slice()], RRF_K);
        assert_eq!(fused.first().map(|(id, _)| id.as_str()), Some("shared"));
    }

    #[test]
    fn tied_scores_break_by_id_ascending() {
        // Each id appears once at rank 0 in its own list → identical RRF scores.
        let l1 = ids(&["zeta"]);
        let l2 = ids(&["alpha"]);
        let l3 = ids(&["mid"]);
        let fused = rrf_fuse(&[l1.as_slice(), l2.as_slice(), l3.as_slice()], RRF_K);
        assert_eq!(
            fused.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["alpha", "mid", "zeta"]
        );
    }

    #[test]
    fn arg_order_does_not_change_the_result() {
        let bm25 = ids(&["a", "b", "c"]);
        let dense = ids(&["b", "c", "d"]);
        let forward = rrf_fuse(&[bm25.as_slice(), dense.as_slice()], RRF_K);
        let swapped = rrf_fuse(&[dense.as_slice(), bm25.as_slice()], RRF_K);
        assert_eq!(forward, swapped);
    }

    #[test]
    fn sort_and_truncate_keeps_stable_membership_across_a_tie_boundary() {
        // Three tied scores, cut to 2: membership must be the id-ascending head,
        // not whatever order they arrived in.
        let mut ranked = vec![
            ("zeta".to_string(), 1.0_f32),
            ("alpha".to_string(), 1.0),
            ("mid".to_string(), 1.0),
        ];
        sort_and_truncate(&mut ranked, 2);
        assert_eq!(
            ranked.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["alpha", "mid"]
        );
    }
}
