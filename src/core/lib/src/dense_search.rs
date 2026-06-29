//! Dense (semantic) ranking over precomputed embeddings.
//!
//! The cosine-similarity analog of [`crate::search::bm25_search`]. Vectors are
//! assumed L2-normalized (the embedder normalizes both documents and the query),
//! so cosine reduces to a dot product. Ordering mirrors the BM25 path exactly —
//! best score first, ties broken by `id` — so top-K membership is stable across
//! processes regardless of input order.

/// Rank `(id, vector)` documents against `query_vec` by cosine similarity and
/// return the top-`top_k` as `(id, score)`, best-first with ties broken by `id`.
///
/// Takes precomputed vectors (no model load), so the ranking contract is
/// unit-testable on its own. Empty input yields an empty result.
pub(crate) fn dense_search<'a, I>(docs: I, query_vec: &[f32], top_k: usize) -> Vec<(String, f32)>
where
    I: IntoIterator<Item = (String, &'a [f32])>,
{
    // Mirror `bm25_search`: rank the full corpus, then truncate — never let a
    // tie straddling the `top_k` boundary make membership depend on input
    // order. The (score desc, id asc) sort fixes both order and membership.
    let mut ranked: Vec<(String, f32)> = docs
        .into_iter()
        .map(|(id, vec)| (id, cosine(vec, query_vec)))
        .collect();
    crate::fusion::sort_and_truncate(&mut ranked, top_k);
    ranked
}

/// Cosine similarity of two L2-normalized vectors — i.e. their dot product.
/// Zips to the shorter length; in practice both carry the model's dimension.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refs(docs: &[(String, Vec<f32>)]) -> Vec<(String, &[f32])> {
        docs.iter()
            .map(|(id, v)| (id.clone(), v.as_slice()))
            .collect()
    }

    #[test]
    fn empty_docs_yield_no_hits() {
        let hits = dense_search(Vec::<(String, &[f32])>::new(), &[1.0, 0.0], 5);
        assert!(hits.is_empty());
    }

    #[test]
    fn ranks_the_closest_vector_first() {
        let docs = vec![
            ("read".to_string(), vec![1.0, 0.0]),
            ("write".to_string(), vec![0.0, 1.0]),
        ];
        let hits = dense_search(refs(&docs), &[1.0, 0.0], 5);
        assert_eq!(hits.first().map(|(id, _)| id.as_str()), Some("read"));
    }

    #[test]
    fn respects_top_k() {
        let docs: Vec<(String, Vec<f32>)> = (0..10)
            .map(|i| (format!("doc{i}"), vec![1.0, 0.0]))
            .collect();
        let hits = dense_search(refs(&docs), &[1.0, 0.0], 3);
        assert!(hits.len() <= 3);
    }

    #[test]
    fn tied_scores_break_by_id_with_stable_top_k_membership() {
        // Identical vectors → identical cosine for any query. The (score desc,
        // id asc) order must fix both the returned order AND which docs survive
        // the top_k cut, independent of input order — same contract bm25_search
        // guarantees (see search.rs).
        let docs = vec![
            ("zeta".to_string(), vec![0.0, 1.0]),
            ("alpha".to_string(), vec![0.0, 1.0]),
            ("mid".to_string(), vec![0.0, 1.0]),
        ];
        let hits = dense_search(refs(&docs), &[0.0, 1.0], 2);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].0, "alpha");
        assert_eq!(hits[1].0, "mid");
    }
}
