//! Shared incremental dense-embedding cache backing the registries' semantic and
//! hybrid engines.
//!
//! [`crate::ToolRegistry`] and [`crate::SkillRegistry`] rank two different item
//! types (tools, skills) but embed and cosine-rank them identically: an **id-keyed
//! map** of per-item vectors, extended incrementally. This type owns that
//! structure and its operations so the two registries share one implementation
//! instead of two copies that could drift. The registries keep their own
//! trace-emitting search wrappers, since the trace event shapes differ (tool vs
//! skill). See ADR-0011.
//!
//! Keying by id (not by position) is what lets `register` replace an item in
//! place: on replace the registry calls [`DenseCache::invalidate`] to drop the
//! stale vector, and the next [`DenseCache::extend`] re-embeds that id like any
//! other missing one — so a re-registered id never leaves a stale embedding
//! behind (RAT-378).

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

/// Per-item dense vectors, keyed by item id.
pub(crate) struct DenseCache {
    /// `vectors[id]` is the embedding for the registry item with that id; an id
    /// absent from the map is not yet embedded. [`Self::extend`] fills in the
    /// missing ids; [`Self::invalidate`] drops one so a replaced item re-embeds.
    vectors: Mutex<HashMap<String, Vec<f32>>>,
    /// Test-only embedder override (`None` → the shared process bge-small, loaded
    /// lazily on first use). Lets tests inject a deterministic/failing embedder
    /// without touching the network.
    embedder_override: Option<Arc<dyn Embedder>>,
}

impl DenseCache {
    pub(crate) fn new() -> Self {
        Self {
            vectors: Mutex::new(HashMap::new()),
            embedder_override: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_embedder(embedder: Arc<dyn Embedder>) -> Self {
        Self {
            vectors: Mutex::new(HashMap::new()),
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

    /// Error unless the cache covers the whole corpus (`corpus_len` distinct ids).
    /// A semantic/hybrid search never embeds inside the search path — the caller
    /// must have built first (a semantic-mode catalog does this at `register`),
    /// so no search silently pays the embedding cost. Loads no model.
    ///
    /// The registries key their corpus by id, so `corpus_len` is the number of
    /// distinct ids and `vectors.len()` is the number of embedded ids; the two
    /// match exactly once every id is embedded. A re-register that
    /// [`Self::invalidate`]s an id drops `vectors.len()` below `corpus_len`, so a
    /// search after churn correctly reports `EmbeddingsNotBuilt` until the next
    /// [`Self::extend`] — the same "build after registering" contract as a fresh
    /// register.
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

    /// Embed any item whose id is not yet cached and insert it by id — the
    /// incremental core of the cache. Skips ids already present, so an
    /// already-embedded item is never recomputed (O(k) for k missing ids: newly
    /// registered *or* invalidated-on-replace). Idempotent: a no-op once every id
    /// is cached.
    pub(crate) fn extend<'a, T: Embeddable + 'a>(
        &self,
        items: impl IntoIterator<Item = &'a T>,
        sink: &dyn TraceSink,
    ) -> Result<(), EmbedderError> {
        let mut guard = self.vectors.lock().expect("embeddings mutex poisoned");
        // Resolve the embedder lazily on the first miss, so a fully-cached corpus
        // never loads the model.
        let mut embedder: Option<Arc<dyn Embedder>> = None;
        for item in items {
            if guard.contains_key(item.embed_id()) {
                continue;
            }
            if embedder.is_none() {
                embedder = Some(self.resolve_embedder(sink)?);
            }
            let vector = embedder
                .as_ref()
                .expect("embedder resolved on first miss")
                .embed_doc(&item.embed_text())?;
            guard.insert(item.embed_id().to_string(), vector);
        }
        Ok(())
    }

    /// Drop a cached embedding so the next [`Self::extend`] re-embeds this id.
    /// Called by a registry's `register` when it replaces an existing id in place.
    pub(crate) fn invalidate(&self, id: &str) {
        self.vectors
            .lock()
            .expect("embeddings mutex poisoned")
            .remove(id);
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
    /// passed), so every item's id resolves to a vector; an id missing from the
    /// cache (shouldn't happen post-`require_built`) is simply skipped. The
    /// id-keyed corpus holds one entry per id, so there are no duplicates to
    /// collapse.
    pub(crate) fn ranked<'a, T: Embeddable + 'a>(
        &self,
        items: impl IntoIterator<Item = &'a T>,
        query_vec: &[f32],
        depth: usize,
    ) -> Vec<(String, f32)> {
        let guard = self.vectors.lock().expect("embeddings mutex poisoned");
        let docs: Vec<(String, &[f32])> = items
            .into_iter()
            .filter_map(|item| {
                guard
                    .get(item.embed_id())
                    .map(|v| (item.embed_id().to_string(), v.as_slice()))
            })
            .collect();
        dense_search(docs, query_vec, depth)
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
    fn invalidate_forces_re_embed_of_an_id() {
        // Replace-in-place path: an id embedded as "read", then invalidated and
        // re-embedded from "write". The new vector must win — the mechanism a
        // re-registered tool/skill relies on (RAT-378).
        let stub = Arc::new(CountingStub::new());
        let cache = DenseCache::with_embedder(stub.clone());
        cache.extend([&doc("x", "read")], &NoopSink).unwrap();
        assert_eq!(stub.docs(), 1);

        cache.invalidate("x");
        // Re-embed x from its new content; the query matches "write".
        cache.extend([&doc("x", "write")], &NoopSink).unwrap();
        assert_eq!(stub.docs(), 2, "invalidated id is re-embedded, once");

        let item = doc("x", "write");
        let ranked = cache.ranked([&item], &[0.0, 1.0], 10);
        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].0, "x");
        assert!(ranked[0].1 > 0.9, "ranks with the re-embedded vector");
    }

    #[test]
    fn require_built_fails_after_invalidate_until_rebuilt() {
        let cache = DenseCache::with_embedder(Arc::new(CountingStub::new()));
        let items = vec![doc("a", "read"), doc("b", "write")];
        cache.extend(&items, &NoopSink).unwrap();
        assert!(cache.require_built(items.len()).is_ok());

        cache.invalidate("a");
        assert!(
            matches!(
                cache.require_built(items.len()),
                Err(EmbedderError::EmbeddingsNotBuilt)
            ),
            "an invalidated id drops the cache below the corpus until rebuilt"
        );
        cache.extend(&items, &NoopSink).unwrap();
        assert!(cache.require_built(items.len()).is_ok());
    }
}
