//! Shared incremental dense-embedding cache backing the registries' semantic and
//! hybrid engines.
//!
//! [`crate::ToolRegistry`] and [`crate::SkillRegistry`] rank two different item
//! types (tools, skills) but embed and cosine-rank them identically: a growing
//! **prefix** of per-item vectors, extended incrementally and never invalidated
//! on `register`. This type owns that structure and its operations so the two
//! registries share one implementation instead of two copies that could drift.
//! The registries keep their own trace-emitting search wrappers, since the trace
//! event shapes differ (tool vs skill). See ADR-0011.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::dense_search::dense_search;
use crate::embedding::{Embedder, EmbedderError, embedder_with_telemetry};
use crate::trace::TraceSink;

/// An item the cache can embed and rank: its stable id and the flat searchable
/// text fed to the embedder. Implemented by `Tool` and `Skill` in their
/// respective registries, so the cache stays agnostic to the item type.
pub(crate) trait Embeddable {
    fn embed_id(&self) -> &str;
    fn embed_text(&self) -> String;
}

/// Per-item dense vectors, a growing prefix of a registry's corpus.
pub(crate) struct DenseCache {
    /// `vectors[i]` is the embedding for the registry's item `i`; any item beyond
    /// `vectors.len()` is not yet embedded. Only appended to (never invalidated),
    /// so an existing vector is never recomputed.
    vectors: Mutex<Vec<Vec<f32>>>,
    /// Test-only embedder override (`None` → the shared process bge-small, loaded
    /// lazily on first use). Lets tests inject a deterministic/failing embedder
    /// without touching the network.
    embedder_override: Option<Arc<dyn Embedder>>,
}

impl DenseCache {
    pub(crate) fn new() -> Self {
        Self {
            vectors: Mutex::new(Vec::new()),
            embedder_override: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_embedder(embedder: Arc<dyn Embedder>) -> Self {
        Self {
            vectors: Mutex::new(Vec::new()),
            embedder_override: Some(embedder),
        }
    }

    /// The embedder to use: an injected one (tests) or the shared process
    /// embedder, whose one-time load telemetry is recorded on `sink`.
    fn resolve_embedder(&self, sink: &dyn TraceSink) -> Result<Arc<dyn Embedder>, EmbedderError> {
        match &self.embedder_override {
            Some(e) => Ok(e.clone()),
            None => embedder_with_telemetry(sink),
        }
    }

    /// Error unless the cache covers the whole corpus (`corpus_len` items). A
    /// semantic/hybrid search never embeds inside the search path — the caller
    /// must have built first (a semantic-mode catalog does this at `register`),
    /// so no search silently pays the embedding cost. Loads no model.
    pub(crate) fn require_built(&self, corpus_len: usize) -> Result<(), EmbedderError> {
        let cached = self
            .vectors
            .lock()
            .expect("embeddings mutex poisoned")
            .len();
        if cached < corpus_len {
            return Err(EmbedderError::EmbeddingsNotBuilt);
        }
        Ok(())
    }

    /// Embed the items not yet in the cache and append them — the incremental
    /// core of the prefix cache. Embeds only `items[cache.len()..]`, so an
    /// already-embedded item is never recomputed (O(k) for k newly-registered
    /// items). Idempotent: a no-op once the cache is caught up.
    pub(crate) fn extend<T: Embeddable>(
        &self,
        items: &[T],
        sink: &dyn TraceSink,
    ) -> Result<(), EmbedderError> {
        let mut guard = self.vectors.lock().expect("embeddings mutex poisoned");
        if guard.len() >= items.len() {
            return Ok(());
        }
        let embedder = self.resolve_embedder(sink)?;
        for item in &items[guard.len()..] {
            guard.push(embedder.embed_doc(&item.embed_text())?);
        }
        Ok(())
    }

    /// Embed a query for cosine ranking (uses the same embedder as
    /// [`Self::extend`], so the one-time model load is shared).
    pub(crate) fn embed_query(
        &self,
        query: &str,
        sink: &dyn TraceSink,
    ) -> Result<Vec<f32>, EmbedderError> {
        self.resolve_embedder(sink)?.embed_query(query)
    }

    /// Cosine-rank `query_vec` against the cached vectors, best-first with ties
    /// broken by id. Assumes [`Self::extend`] already ran (`require_built`
    /// passed). Collapses duplicate ids to the latest embedding (last-wins),
    /// mirroring the BM25 engine's id-keyed dedup — so a re-registered item (a
    /// later entry in the prefix) wins.
    pub(crate) fn ranked<T: Embeddable>(
        &self,
        items: &[T],
        query_vec: &[f32],
        depth: usize,
    ) -> Vec<(String, f32)> {
        let guard = self.vectors.lock().expect("embeddings mutex poisoned");
        let mut latest: HashMap<&str, &[f32]> = HashMap::new();
        for (item, embedding) in items.iter().zip(guard.iter()) {
            latest.insert(item.embed_id(), embedding.as_slice());
        }
        dense_search(
            latest.into_iter().map(|(id, v)| (id.to_string(), v)),
            query_vec,
            depth,
        )
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::trace::NoopSink;

    struct Doc {
        id: String,
        text: String,
    }
    impl Embeddable for Doc {
        fn embed_id(&self) -> &str {
            &self.id
        }
        fn embed_text(&self) -> String {
            self.text.clone()
        }
    }
    fn doc(id: &str, text: &str) -> Doc {
        Doc {
            id: id.into(),
            text: text.into(),
        }
    }

    /// One-hot embedder keyed on the word "read", counting `embed_doc` calls so
    /// the incremental contract is provable without the network.
    struct CountingStub {
        docs: AtomicUsize,
    }
    impl CountingStub {
        fn new() -> Self {
            Self {
                docs: AtomicUsize::new(0),
            }
        }
        fn docs(&self) -> usize {
            self.docs.load(Ordering::SeqCst)
        }
    }
    fn vec_for(text: &str) -> Vec<f32> {
        if text.to_lowercase().contains("read") {
            vec![1.0, 0.0]
        } else {
            vec![0.0, 1.0]
        }
    }
    impl Embedder for CountingStub {
        fn embed_doc(&self, text: &str) -> Result<Vec<f32>, EmbedderError> {
            self.docs.fetch_add(1, Ordering::SeqCst);
            Ok(vec_for(text))
        }
        fn embed_query(&self, text: &str) -> Result<Vec<f32>, EmbedderError> {
            Ok(vec_for(text))
        }
    }

    #[test]
    fn require_built_errors_until_the_cache_covers_the_corpus() {
        let cache = DenseCache::with_embedder(Arc::new(CountingStub::new()));
        let items = vec![doc("a", "read"), doc("b", "write")];
        assert!(matches!(
            cache.require_built(items.len()),
            Err(EmbedderError::EmbeddingsNotBuilt)
        ));
        cache.extend(&items, &NoopSink).unwrap();
        assert!(cache.require_built(items.len()).is_ok());
    }

    #[test]
    fn extend_embeds_only_the_new_tail() {
        let stub = Arc::new(CountingStub::new());
        let cache = DenseCache::with_embedder(stub.clone());
        let mut items = vec![doc("a", "read"), doc("b", "write")];
        cache.extend(&items, &NoopSink).unwrap();
        assert_eq!(stub.docs(), 2);
        items.push(doc("c", "read"));
        cache.extend(&items, &NoopSink).unwrap();
        assert_eq!(stub.docs(), 3, "only the newly-appended item is embedded");
        // Idempotent once caught up.
        cache.extend(&items, &NoopSink).unwrap();
        assert_eq!(stub.docs(), 3);
    }

    #[test]
    fn ranked_dedups_duplicate_ids_last_wins() {
        let cache = DenseCache::with_embedder(Arc::new(CountingStub::new()));
        // Same id twice: first "read", then "write". The later vector must win.
        let items = vec![doc("x", "read"), doc("x", "write")];
        cache.extend(&items, &NoopSink).unwrap();
        let ranked = cache.ranked(&items, &[0.0, 1.0], 10); // query matches "write"
        assert_eq!(ranked.len(), 1, "a duplicate id collapses to one entry");
        assert_eq!(ranked[0].0, "x");
        assert!(ranked[0].1 > 0.9, "ranks with the last-registered vector");
    }
}
