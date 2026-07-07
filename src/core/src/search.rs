use bm25::{Document, Language, SearchEngineBuilder};

// Tuned for short tool/skill descriptions; see ADR-0004.
pub(crate) const BM25_K1: f32 = 0.9;
pub(crate) const BM25_B: f32 = 0.4;

/// Build a one-shot BM25 index over `(id, searchable_text)` documents and
/// return the top-`top_k` matches as `(id, score)`, ordered best-first with
/// ties broken by `id` so the result is deterministic across processes.
///
/// The index is rebuilt per call (no persistence) — the same strategy the tool
/// registry has always used. Empty input yields an empty result without
/// touching the engine.
pub(crate) fn bm25_search<I>(docs: I, query: &str, top_k: usize) -> Vec<(String, f32)>
where
    I: IntoIterator<Item = (String, String)>,
{
    let pairs: Vec<(String, String)> = docs.into_iter().collect();
    if pairs.is_empty() {
        return Vec::new();
    }
    // Rank against the full corpus, then truncate — never let the engine cut to
    // `top_k` itself. The bm25 crate sorts by score alone and collects
    // candidates through a HashSet, so equal scores fall back to hash-seed
    // iteration order and flip between processes; a tie straddling the `top_k`
    // boundary would make top-K *membership* nondeterministic. We rank
    // everything, break ties by id, then cut — so both the tool and skill
    // buckets are stable. (Centralizes #63, which originally fixed only the tool
    // path in ToolRegistry::search.)
    let doc_count = pairs.len();
    let engine = SearchEngineBuilder::<String>::with_documents(
        Language::English,
        pairs
            .into_iter()
            .map(|(id, contents)| Document { id, contents }),
    )
    .k1(BM25_K1)
    .b(BM25_B)
    .build();
    let mut ranked: Vec<(String, f32)> = engine
        .search(query, doc_count)
        .into_iter()
        .map(|r| (r.document.id, r.score))
        .collect();
    ranked.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    ranked.truncate(top_k);
    ranked
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_docs_yield_no_hits() {
        let hits = bm25_search(Vec::<(String, String)>::new(), "anything", 5);
        assert!(hits.is_empty());
    }

    #[test]
    fn ranks_the_lexically_closest_document_first() {
        let docs = vec![
            ("read".to_string(), "read a file from disk".to_string()),
            (
                "write".to_string(),
                "write bytes to a network socket".to_string(),
            ),
        ];
        let hits = bm25_search(docs, "read file", 5);
        assert_eq!(hits.first().map(|(id, _)| id.as_str()), Some("read"));
    }

    #[test]
    fn respects_top_k() {
        let docs = (0..10).map(|i| (format!("doc{i}"), "shared term content".to_string()));
        let hits = bm25_search(docs, "shared", 3);
        assert!(hits.len() <= 3);
    }

    #[test]
    fn tied_scores_break_by_id_with_stable_top_k_membership() {
        // Identical searchable text → identical scores for any matching query.
        // The bm25 crate collects candidates through a HashSet, so the engine's
        // own order is hash-seed dependent; bm25_search must impose a stable
        // (score desc, id asc) order so both the returned order AND which docs
        // survive the top_k cut are fixed across processes. Shared by the tool
        // and skill registries — see registry.rs / skill_registry.rs.
        let docs = vec![
            (
                "zeta".to_string(),
                "send a notification message".to_string(),
            ),
            (
                "alpha".to_string(),
                "send a notification message".to_string(),
            ),
            ("mid".to_string(), "send a notification message".to_string()),
        ];
        let hits = bm25_search(docs, "notification message", 2);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].0, "alpha");
        assert_eq!(hits[1].0, "mid");
    }
}
