use bm25::{Document, Language, SearchEngineBuilder};

// Tuned for short tool/skill descriptions; see ADR-0004.
pub(crate) const BM25_K1: f32 = 0.9;
pub(crate) const BM25_B: f32 = 0.4;

/// Build a one-shot BM25 index over `(id, searchable_text)` documents and
/// return the top-`top_k` matches as `(id, score)`, ordered best-first.
///
/// The index is rebuilt per call (no persistence) — the same strategy the tool
/// registry has always used. Empty input yields an empty result without
/// touching the engine.
pub(crate) fn bm25_search<I>(docs: I, query: &str, top_k: usize) -> Vec<(String, f32)>
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut documents = docs
        .into_iter()
        .map(|(id, contents)| Document { id, contents })
        .peekable();
    if documents.peek().is_none() {
        return Vec::new();
    }
    let engine = SearchEngineBuilder::<String>::with_documents(Language::English, documents)
        .k1(BM25_K1)
        .b(BM25_B)
        .build();
    engine
        .search(query, top_k)
        .into_iter()
        .map(|r| (r.document.id, r.score))
        .collect()
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
}
