use std::sync::Arc;
use std::time::Instant;

use indexmap::IndexMap;

use crate::dense_cache::{DenseCache, Embeddable};
use crate::embedding::EmbedderError;
use crate::embedding_config::EmbeddingModel;
use crate::fusion::{RETRIEVE_DEPTH, RRF_K, rrf_fuse};
use crate::indexing::searchable_text;
use crate::method::SearchMethod;
use crate::search::bm25_search;
use crate::tool::Tool;
use crate::trace::{
    ChurnKind, NoopSink, Origin, SearchHitTrace, SearchStage, TraceEvent, TraceSink,
};

/// One ranked match from a [`ToolRegistry`] search, best-first in the
/// returned `Vec`.
pub struct SearchHit {
    /// Id of the matching tool ([`Tool::id`]).
    pub tool_id: String,
    /// Relevance score — higher is better, and the scale depends on the
    /// [`SearchMethod`] that produced the hit:
    ///
    /// - `Bm25`: raw BM25 relevance (non-negative, unbounded; `k1=0.9`,
    ///   `b=0.4`, tuned for short tool text per ADR-0004).
    /// - `Semantic`: cosine similarity of the L2-normalized query and
    ///   document embeddings (at most `1.0`).
    /// - `Hybrid`: the Reciprocal Rank Fusion sum `Σ 1/(60 + rank)` over the
    ///   BM25 and dense rankings — with two arms at most `2/60 ≈ 0.033`, so
    ///   only the ordering is meaningful, not the magnitude.
    ///
    /// Scores are comparable within one result list, not across methods or
    /// corpora. Ties are broken by `tool_id` ascending, so ordering is
    /// deterministic across processes.
    pub score: f32,
}

impl Embeddable for Tool {
    fn embed_id(&self) -> &str {
        &self.id
    }
    fn embed_text(&self) -> String {
        searchable_text(self)
    }
}

/// Retrieval index over [`Tool`]s — the registry behind the SDKs' tool
/// catalogs.
///
/// Tools are [`Self::register`]ed into an id-keyed corpus (re-registering an
/// id replaces it in place) and ranked by one of three engines selected per
/// call via [`SearchMethod`]. The plain [`Self::search`] path is lexical BM25:
/// infallible, model-free, ready as soon as tools are registered. Semantic
/// and hybrid go through [`Self::search_with_method`] and require
/// [`Self::build_embeddings`] first — a search never embeds the corpus (see
/// ADR-0011).
///
/// Every register and search emits a [`TraceEvent`] on the registry's
/// [`TraceSink`] ([`NoopSink`] by default). [`SkillRegistry`] is the
/// skill-side twin with the same shape.
///
/// [`SkillRegistry`]: crate::SkillRegistry
pub struct ToolRegistry {
    /// Corpus keyed by tool id, in insertion order. Keying by id makes `register`
    /// replace an existing id in place (never a duplicate), so the BM25 corpus
    /// stays one-entry-per-id — no `avgdl` drift, no leak (RAT-378).
    tools: IndexMap<String, Tool>,
    sink: Arc<dyn TraceSink>,
    /// Dense embeddings for `tools`, keyed by id and built on demand. `register`
    /// invalidates a replaced id; the missing ids are embedded by
    /// [`Self::build_embeddings`] — a search never embeds the corpus (it requires
    /// the cache built first). A pure BM25 user never populates it and never loads
    /// the model (see ADR-0011 and [`DenseCache`]).
    dense: DenseCache,
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolRegistry {
    /// An empty registry with tracing off ([`NoopSink`]); attach a real sink
    /// later with [`Self::set_trace_sink`].
    pub fn new() -> Self {
        Self {
            tools: IndexMap::new(),
            sink: Arc::new(NoopSink),
            dense: DenseCache::new(),
        }
    }

    /// An empty registry recording trace events to `sink` from the start.
    pub fn with_trace_sink(sink: Arc<dyn TraceSink>) -> Self {
        Self {
            tools: IndexMap::new(),
            sink,
            dense: DenseCache::new(),
        }
    }

    /// A registry whose semantic/hybrid engines use an explicit embedding model
    /// (the configurable-model path). BM25 is unaffected — it needs no model.
    /// Direct enum variants are validated on the first embedding build; call
    /// [`EmbeddingModel::validate`] first when construction-time feedback is
    /// required. The trace sink is set separately via [`Self::set_trace_sink`].
    pub fn with_embedding(model: EmbeddingModel) -> Self {
        Self {
            tools: IndexMap::new(),
            sink: Arc::new(NoopSink),
            dense: DenseCache::with_model(model),
        }
    }

    /// Replace the trace sink; subsequent register/search/`record_event`
    /// events go to `sink`. Already-recorded events are not replayed.
    pub fn set_trace_sink(&mut self, sink: Arc<dyn TraceSink>) {
        self.sink = sink;
    }

    /// Record an arbitrary [`TraceEvent`] on the registry's sink. Higher
    /// layers (the SDK catalogs and capability tools) use this to emit their
    /// invoke/upstream/auth lifecycle events into the same stream as the
    /// registry's own search and churn events (ADR-0007).
    pub fn record_event(&self, event: TraceEvent) {
        self.sink.record(event);
    }

    /// Register a tool, or replace one in place if its id is already present.
    /// Replacing invalidates the old id's cached embedding so the next
    /// `build_embeddings` re-embeds the new content; the corpus never holds a
    /// duplicate. Registration stays infallible and model-free (a search never
    /// embeds), so BM25 users are unaffected (see ADR-0011).
    ///
    /// # Examples
    ///
    /// ```
    /// use ratel_ai_core::{Tool, ToolRegistry};
    ///
    /// let tool = |desc: &str| Tool {
    ///     id: "read_file".into(),
    ///     name: "read_file".into(),
    ///     description: desc.into(),
    ///     input_schema: serde_json::json!({}),
    ///     output_schema: serde_json::json!({}),
    /// };
    ///
    /// let mut registry = ToolRegistry::new();
    /// registry.register(tool("Read a file"));
    /// registry.register(tool("Read a file from disk")); // same id: replaced
    /// assert_eq!(registry.len(), 1);
    /// ```
    pub fn register(&mut self, tool: Tool) {
        let tool_id = tool.id.clone();
        if self.tools.insert(tool_id.clone(), tool).is_some() {
            // Replaced an existing id: drop its stale embedding.
            self.dense.invalidate(&tool_id);
        }
        self.sink.record(TraceEvent::IndexChurn {
            kind: ChurnKind::Add,
            tool_id,
        });
    }

    /// Number of registered tools (distinct ids).
    pub fn len(&self) -> usize {
        self.tools.len()
    }

    /// Whether no tools are registered.
    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    /// Lexical BM25 retrieval. The default engine — needs no model and never
    /// fails, so the public `search`/`search_with_origin` stay infallible and
    /// byte-for-byte compatible with the BM25-only releases.
    ///
    /// Returns at most `top_k` hits, best-first (see [`SearchHit::score`] for
    /// the score semantics). Traced as [`Origin::Direct`].
    ///
    /// # Examples
    ///
    /// ```
    /// use ratel_ai_core::{Tool, ToolRegistry};
    ///
    /// let mut registry = ToolRegistry::new();
    /// registry.register(Tool {
    ///     id: "read_file".into(),
    ///     name: "read_file".into(),
    ///     description: "Read a file from disk".into(),
    ///     input_schema: serde_json::json!({}),
    ///     output_schema: serde_json::json!({}),
    /// });
    ///
    /// let hits = registry.search("read a file", 5);
    /// assert_eq!(hits[0].tool_id, "read_file");
    /// ```
    pub fn search(&self, query: &str, top_k: usize) -> Vec<SearchHit> {
        self.search_with_origin(query, top_k, Origin::Direct)
    }

    /// [`Self::search`] with an explicit trace [`Origin`], so consumers of the
    /// trace stream can tell agent-synthesized searches from direct library
    /// calls. Same BM25 engine, same infallibility.
    pub fn search_with_origin(&self, query: &str, top_k: usize, origin: Origin) -> Vec<SearchHit> {
        self.bm25_search_traced(query, top_k, origin)
    }

    /// Retrieve with an explicit [`SearchMethod`]. `Bm25` is infallible; `Semantic`
    /// and `Hybrid` rank against the prebuilt embedding cache and return an
    /// [`EmbedderError`] (`EmbeddingsNotBuilt`) if it isn't built — they never load
    /// the model or embed the corpus in-search (the model loads at
    /// `build_embeddings`). The SDK layer picks the method (a per-catalog default or
    /// a per-call override) and calls this.
    ///
    /// # Errors
    ///
    /// Never errors for [`SearchMethod::Bm25`]. For `Semantic` and `Hybrid`:
    /// [`EmbedderError::EmbeddingsNotBuilt`] when the cache does not cover the
    /// corpus (call [`Self::build_embeddings`] after registering), or any
    /// other [`EmbedderError`] from loading the model / embedding the query.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use ratel_ai_core::{Origin, SearchMethod, Tool, ToolRegistry};
    /// # fn main() -> Result<(), ratel_ai_core::EmbedderError> {
    /// let mut registry = ToolRegistry::new();
    /// registry.register(Tool {
    ///     id: "delete_file".into(),
    ///     name: "delete_file".into(),
    ///     description: "Delete a path from the filesystem".into(),
    ///     input_schema: serde_json::json!({}),
    ///     output_schema: serde_json::json!({}),
    /// });
    /// registry.build_embeddings()?; // loads the model on first use
    ///
    /// // Lexically unrelated query, semantically close:
    /// let hits = registry.search_with_method(
    ///     "remove a document",
    ///     5,
    ///     Origin::Direct,
    ///     SearchMethod::Semantic,
    /// )?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn search_with_method(
        &self,
        query: &str,
        top_k: usize,
        origin: Origin,
        method: SearchMethod,
    ) -> Result<Vec<SearchHit>, EmbedderError> {
        match method {
            SearchMethod::Bm25 => Ok(self.bm25_search_traced(query, top_k, origin)),
            SearchMethod::Semantic => self.semantic_search_traced(query, top_k, origin),
            SearchMethod::Hybrid => self.hybrid_search_traced(query, top_k, origin),
        }
    }

    /// Pre-compute embeddings for any not-yet-embedded tools so a later
    /// semantic/hybrid search only has to embed the query (never the corpus).
    /// Incremental — embeds only tools registered since the last call. Callers
    /// invoke this explicitly before semantic/hybrid search; a BM25-only user
    /// never calls it and never loads the model.
    ///
    /// # Errors
    ///
    /// Any [`EmbedderError`] from resolving or using the embedding source,
    /// including `Config`, `NotCached`, `Download`, `CacheUnwritable`, `Load`,
    /// or `Inference`; retained caches can also surface `DimensionMismatch` or
    /// `ModelMismatch`. A failed build leaves the prior cache unchanged and a
    /// later call can retry once the cause clears.
    pub fn build_embeddings(&self) -> Result<(), EmbedderError> {
        self.dense.extend(self.tools.values(), self.sink.as_ref())
    }

    /// Recompute embeddings for the full tool corpus and atomically replace the
    /// dense cache. Unlike [`Self::build_embeddings`], this adopts a changed model
    /// identity or dimension. A failed rebuild preserves the prior cache.
    ///
    /// # Errors
    ///
    /// Any [`EmbedderError`] from loading or embedding the complete corpus.
    pub fn rebuild_embeddings(&self) -> Result<(), EmbedderError> {
        self.dense.rebuild(self.tools.values(), self.sink.as_ref())
    }

    // ---- engines -----------------------------------------------------------

    fn bm25_search_traced(&self, query: &str, top_k: usize, origin: Origin) -> Vec<SearchHit> {
        let started = Instant::now();
        let hits: Vec<SearchHit> = bm25_search(
            self.tools
                .values()
                .map(|t| (t.id.clone(), searchable_text(t))),
            query,
            top_k,
        )
        .into_iter()
        .map(|(tool_id, score)| SearchHit { tool_id, score })
        .collect();
        let took_ms = started.elapsed().as_millis() as u64;
        let top_score = hits.first().map(|h| h.score as f64);
        self.record_search(
            query,
            origin,
            top_k,
            &hits,
            vec![SearchStage {
                name: "bm25".into(),
                took_ms,
                top_score,
            }],
            took_ms,
        );
        hits
    }

    fn semantic_search_traced(
        &self,
        query: &str,
        top_k: usize,
        origin: Origin,
    ) -> Result<Vec<SearchHit>, EmbedderError> {
        let started = Instant::now();
        if self.tools.is_empty() || top_k == 0 {
            self.record_search(query, origin, top_k, &[], Vec::new(), 0);
            return Ok(Vec::new());
        }
        let t = Instant::now();
        let ranked = self
            .dense
            .search(self.tools.values(), query, top_k, self.sink.as_ref())?;
        let stage_ms = t.elapsed().as_millis() as u64;
        let hits: Vec<SearchHit> = ranked
            .into_iter()
            .map(|(tool_id, score)| SearchHit { tool_id, score })
            .collect();
        let took_ms = started.elapsed().as_millis() as u64;
        let top_score = hits.first().map(|h| h.score as f64);
        self.record_search(
            query,
            origin,
            top_k,
            &hits,
            vec![SearchStage {
                name: "dense".into(),
                took_ms: stage_ms,
                top_score,
            }],
            took_ms,
        );
        Ok(hits)
    }

    /// Hybrid retrieval (ADR-0011): BM25 and dense each rank the corpus deeper
    /// than `top_k`, then Reciprocal Rank Fusion combines the two rankings into
    /// the final order (no reranker). Emits `bm25`, `dense`, and `rrf` stages.
    fn hybrid_search_traced(
        &self,
        query: &str,
        top_k: usize,
        origin: Origin,
    ) -> Result<Vec<SearchHit>, EmbedderError> {
        let started = Instant::now();
        if self.tools.is_empty() || top_k == 0 {
            self.record_search(query, origin, top_k, &[], Vec::new(), 0);
            return Ok(Vec::new());
        }
        // Retrieve deeper than `top_k` so a tool ranked low by one arm but high
        // by the other still has rank signal to fuse.
        let depth = RETRIEVE_DEPTH.max(top_k);

        // 1. BM25 (lexical).
        let t = Instant::now();
        let bm25_ranked = bm25_search(
            self.tools
                .values()
                .map(|t| (t.id.clone(), searchable_text(t))),
            query,
            depth,
        );
        let bm25_stage = SearchStage {
            name: "bm25".into(),
            took_ms: t.elapsed().as_millis() as u64,
            top_score: bm25_ranked.first().map(|(_, s)| *s as f64),
        };

        // 2. Dense (semantic) — requires embeddings to be built; never embeds in-search.
        let t = Instant::now();
        let dense_ranked =
            self.dense
                .search(self.tools.values(), query, depth, self.sink.as_ref())?;
        let dense_stage = SearchStage {
            name: "dense".into(),
            took_ms: t.elapsed().as_millis() as u64,
            top_score: dense_ranked.first().map(|(_, s)| *s as f64),
        };

        // 3. RRF fusion of the two rankings → final top_k.
        let t = Instant::now();
        let bm25_ids: Vec<String> = bm25_ranked.into_iter().map(|(id, _)| id).collect();
        let dense_ids: Vec<String> = dense_ranked.into_iter().map(|(id, _)| id).collect();
        let mut fused = rrf_fuse(&[&bm25_ids, &dense_ids], RRF_K);
        fused.truncate(top_k);
        let rrf_stage = SearchStage {
            name: "rrf".into(),
            took_ms: t.elapsed().as_millis() as u64,
            top_score: fused.first().map(|(_, s)| *s as f64),
        };

        let hits: Vec<SearchHit> = fused
            .into_iter()
            .map(|(tool_id, score)| SearchHit { tool_id, score })
            .collect();
        let took_ms = started.elapsed().as_millis() as u64;
        self.record_search(
            query,
            origin,
            top_k,
            &hits,
            vec![bm25_stage, dense_stage, rrf_stage],
            took_ms,
        );
        Ok(hits)
    }

    #[allow(clippy::too_many_arguments)]
    fn record_search(
        &self,
        query: &str,
        origin: Origin,
        top_k: usize,
        hits: &[SearchHit],
        stages: Vec<SearchStage>,
        took_ms: u64,
    ) {
        self.sink.record(TraceEvent::Search {
            query: query.to_string(),
            origin,
            top_k: top_k as u32,
            hits: hits
                .iter()
                .map(|h| SearchHitTrace {
                    tool_id: h.tool_id.clone(),
                    score: h.score as f64,
                })
                .collect(),
            stages,
            took_ms,
        });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Barrier, mpsc};
    use std::time::Duration;

    use super::*;
    use crate::embedding::{Embedded, Embedder};
    use crate::trace::MemorySink;

    /// Deterministic, network-free embedder: a 3-d one-hot keyed on a keyword so
    /// dense ranking is predictable ("read" docs/queries collide, etc.).
    struct StubEmbedder;
    impl StubEmbedder {
        fn vec_for(text: &str) -> Vec<f32> {
            let t = text.to_lowercase();
            if t.contains("read") {
                vec![1.0, 0.0, 0.0]
            } else if t.contains("delete") || t.contains("remove") {
                vec![0.0, 1.0, 0.0]
            } else {
                vec![0.0, 0.0, 1.0]
            }
        }
    }
    impl Embedder for StubEmbedder {
        fn embed_doc(&self, text: &str) -> Result<Vec<f32>, EmbedderError> {
            Ok(StubEmbedder::vec_for(text))
        }
        fn embed_query(&self, text: &str) -> Result<Vec<f32>, EmbedderError> {
            Ok(StubEmbedder::vec_for(text))
        }
    }

    /// Stands in for a machine that can't run the model: every embed fails.
    struct FailingEmbedder;
    impl Embedder for FailingEmbedder {
        fn embed_doc(&self, _: &str) -> Result<Vec<f32>, EmbedderError> {
            Err(EmbedderError::Inference {
                source: "stub failure".into(),
            })
        }
        fn embed_query(&self, _: &str) -> Result<Vec<f32>, EmbedderError> {
            Err(EmbedderError::Inference {
                source: "stub failure".into(),
            })
        }
    }

    /// Counts `embed_doc` calls so tests can prove the cache is incremental
    /// (registering a tool re-embeds only that tool, not the whole corpus).
    struct CountingEmbedder {
        doc_calls: std::sync::atomic::AtomicUsize,
    }
    impl CountingEmbedder {
        fn new() -> Self {
            Self {
                doc_calls: std::sync::atomic::AtomicUsize::new(0),
            }
        }
        fn doc_calls(&self) -> usize {
            self.doc_calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }
    impl Embedder for CountingEmbedder {
        fn embed_doc(&self, text: &str) -> Result<Vec<f32>, EmbedderError> {
            self.doc_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(StubEmbedder::vec_for(text))
        }
        fn embed_query(&self, text: &str) -> Result<Vec<f32>, EmbedderError> {
            Ok(StubEmbedder::vec_for(text))
        }
    }

    fn with_embedder(embedder: Arc<dyn Embedder>) -> ToolRegistry {
        ToolRegistry {
            tools: IndexMap::new(),
            sink: Arc::new(NoopSink),
            dense: DenseCache::with_embedder(embedder),
        }
    }

    fn tool(id: &str, description: &str) -> Tool {
        Tool {
            id: id.into(),
            name: id.into(),
            description: description.into(),
            input_schema: serde_json::json!({}),
            output_schema: serde_json::json!({}),
        }
    }

    fn catalog(embedder: Arc<dyn Embedder>) -> ToolRegistry {
        let mut reg = with_embedder(embedder);
        reg.register(tool("read_file", "read a file"));
        reg.register(tool("delete_file", "delete a file"));
        reg
    }

    #[test]
    fn default_search_is_bm25_and_infallible() {
        let mut reg = ToolRegistry::new();
        reg.register(tool("read_file", "read the contents of a file"));
        reg.register(tool("delete_file", "delete a file"));
        // No embedder override, no model load — pure lexical.
        let hits = reg.search("read a file", 5);
        assert_eq!(hits.first().map(|h| h.tool_id.as_str()), Some("read_file"));
    }

    #[test]
    fn bm25_never_loads_the_model() {
        // A registry with a failing embedder must still serve BM25 without ever
        // touching the embedder (lazy) — proves the default path is ML-free.
        let reg = catalog(Arc::new(FailingEmbedder));
        let hits = reg
            .search_with_method("read", 5, Origin::Direct, SearchMethod::Bm25)
            .expect("bm25 is infallible");
        assert_eq!(hits.first().map(|h| h.tool_id.as_str()), Some("read_file"));
    }

    #[test]
    fn semantic_ranks_via_injected_embedder() {
        let reg = catalog(Arc::new(StubEmbedder));
        reg.build_embeddings().unwrap();
        let hits = reg
            .search_with_method("read something", 5, Origin::Direct, SearchMethod::Semantic)
            .unwrap();
        assert_eq!(hits.first().map(|h| h.tool_id.as_str()), Some("read_file"));
    }

    #[test]
    fn semantic_without_embeddings_errors() {
        // Registered but embeddings never built: a semantic search must refuse with a clear
        // error rather than silently embedding the corpus in the search path.
        let reg = catalog(Arc::new(StubEmbedder));
        assert!(matches!(
            reg.search_with_method("read", 5, Origin::Direct, SearchMethod::Semantic),
            Err(EmbedderError::EmbeddingsNotBuilt)
        ));
    }

    #[test]
    fn build_embeddings_surfaces_embedder_error_instead_of_panicking() {
        // The failing embedder's error surfaces at build_embeddings() (where embedding
        // happens) as a catchable error.
        let reg = catalog(Arc::new(FailingEmbedder));
        assert!(matches!(
            reg.build_embeddings(),
            Err(EmbedderError::Inference { .. })
        ));
    }

    #[test]
    fn hybrid_fuses_bm25_and_dense() {
        let reg = catalog(Arc::new(StubEmbedder));
        reg.build_embeddings().unwrap();
        let hits = reg
            .search_with_method("read a file", 5, Origin::Direct, SearchMethod::Hybrid)
            .unwrap();
        // Both arms rank read_file first (lexical "read a file" + dense "read").
        assert_eq!(hits.first().map(|h| h.tool_id.as_str()), Some("read_file"));
    }

    #[test]
    fn hybrid_recalls_a_tool_bm25_alone_misses() {
        // The two arms disagree: `records_mgr` matches the query lexically, while
        // `deleter` matches only in the dense bucket (zero lexical overlap with the
        // query). Hybrid must fuse both arms and surface `deleter` — the semantic
        // recall a pure BM25 search never returns.
        let mut reg = with_embedder(Arc::new(StubEmbedder));
        reg.register(tool("records_mgr", "manage old records archive")); // dense: other
        reg.register(tool("deleter", "delete entries")); // dense: delete bucket
        reg.build_embeddings().unwrap();
        let q = "remove old records"; // lexical -> records_mgr; dense bucket -> deleter

        let bm25 = reg
            .search_with_method(q, 5, Origin::Direct, SearchMethod::Bm25)
            .unwrap();
        let semantic = reg
            .search_with_method(q, 5, Origin::Direct, SearchMethod::Semantic)
            .unwrap();
        let hybrid = reg
            .search_with_method(q, 5, Origin::Direct, SearchMethod::Hybrid)
            .unwrap();

        // The arms genuinely disagree on the top hit...
        assert_eq!(
            bm25.first().map(|h| h.tool_id.as_str()),
            Some("records_mgr")
        );
        assert_eq!(
            semantic.first().map(|h| h.tool_id.as_str()),
            Some("deleter")
        );
        // ...and pure BM25 never surfaces the lexically-invisible tool.
        assert!(!bm25.iter().any(|h| h.tool_id == "deleter"));
        // Hybrid fuses both arms, so it recalls both.
        let ids: Vec<&str> = hybrid.iter().map(|h| h.tool_id.as_str()).collect();
        assert!(
            ids.contains(&"records_mgr") && ids.contains(&"deleter"),
            "hybrid should fuse both arms, got {ids:?}"
        );
    }

    #[test]
    fn semantic_stage_is_named_dense() {
        let sink = Arc::new(MemorySink::new("s"));
        let mut reg = catalog(Arc::new(StubEmbedder));
        reg.set_trace_sink(sink.clone());
        reg.build_embeddings().unwrap();
        reg.search_with_method("read", 5, Origin::Agent, SearchMethod::Semantic)
            .unwrap();
        let events = sink.drain();
        assert!(events.iter().any(|e| matches!(
            &e.event,
            TraceEvent::Search { stages, .. } if stages.iter().any(|s| s.name == "dense")
        )));
    }

    #[test]
    fn hybrid_emits_three_stages() {
        let sink = Arc::new(MemorySink::new("s"));
        let mut reg = catalog(Arc::new(StubEmbedder));
        reg.set_trace_sink(sink.clone());
        reg.build_embeddings().unwrap();
        reg.search_with_method("read", 5, Origin::Agent, SearchMethod::Hybrid)
            .unwrap();
        let events = sink.drain();
        assert!(events.iter().any(|e| matches!(
            &e.event,
            TraceEvent::Search { stages, .. }
                if stages.iter().any(|s| s.name == "bm25")
                && stages.iter().any(|s| s.name == "dense")
                && stages.iter().any(|s| s.name == "rrf")
        )));
    }

    #[test]
    fn build_embeddings_after_register_embeds_only_the_new_tool() {
        let counter = Arc::new(CountingEmbedder::new());
        let mut reg = with_embedder(counter.clone());
        reg.register(tool("read_file", "read a file"));
        reg.register(tool("delete_file", "delete a file"));
        // build_embeddings embeds the 2-tool corpus.
        reg.build_embeddings().unwrap();
        assert_eq!(counter.doc_calls(), 2);
        // Registering one more then building embeddings must embed ONLY it — the two existing
        // vectors are reused, never recomputed (the O(N) regression).
        reg.register(tool("reader_v2", "read a file too"));
        reg.build_embeddings().unwrap();
        assert_eq!(
            counter.doc_calls(),
            3,
            "only the newly-registered tool should be embedded"
        );
        let hits = reg
            .search_with_method("read", 10, Origin::Direct, SearchMethod::Semantic)
            .unwrap();
        assert!(hits.iter().any(|h| h.tool_id == "reader_v2"));
    }

    #[test]
    fn build_embeddings_precomputes_so_search_embeds_no_docs() {
        let counter = Arc::new(CountingEmbedder::new());
        let mut reg = with_embedder(counter.clone());
        reg.register(tool("read_file", "read a file"));
        reg.register(tool("delete_file", "delete a file"));
        reg.build_embeddings().unwrap();
        assert_eq!(
            counter.doc_calls(),
            2,
            "build_embeddings embeds the corpus up front"
        );
        reg.search_with_method("read", 5, Origin::Direct, SearchMethod::Semantic)
            .unwrap();
        assert_eq!(
            counter.doc_calls(),
            2,
            "a search after build_embeddings embeds only the query, no documents"
        );
    }

    #[test]
    fn build_embeddings_is_idempotent() {
        let counter = Arc::new(CountingEmbedder::new());
        let mut reg = with_embedder(counter.clone());
        reg.register(tool("read_file", "read a file"));
        reg.build_embeddings().unwrap();
        reg.build_embeddings().unwrap();
        assert_eq!(counter.doc_calls(), 1);
    }

    #[test]
    fn rebuild_embeddings_recomputes_the_full_corpus() {
        let counter = Arc::new(CountingEmbedder::new());
        let mut reg = with_embedder(counter.clone());
        reg.register(tool("read_file", "read a file"));
        reg.register(tool("delete_file", "delete a file"));
        reg.build_embeddings().unwrap();
        reg.rebuild_embeddings().unwrap();
        assert_eq!(counter.doc_calls(), 4, "rebuild embeds every tool again");
    }

    struct FailSecondBatch {
        calls: std::sync::atomic::AtomicUsize,
    }

    impl Embedder for FailSecondBatch {
        fn embed_doc(&self, text: &str) -> Result<Vec<f32>, EmbedderError> {
            Ok(StubEmbedder::vec_for(text))
        }

        fn embed_query(&self, text: &str) -> Result<Vec<f32>, EmbedderError> {
            Ok(StubEmbedder::vec_for(text))
        }

        fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbedderError> {
            if self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                return Err(EmbedderError::Inference {
                    source: "rebuild failed".into(),
                });
            }
            texts.iter().map(|text| self.embed_doc(text)).collect()
        }
    }

    #[test]
    fn failed_rebuild_preserves_the_previous_searchable_cache() {
        let mut reg = with_embedder(Arc::new(FailSecondBatch {
            calls: std::sync::atomic::AtomicUsize::new(0),
        }));
        reg.register(tool("read_file", "read a file"));
        reg.build_embeddings().unwrap();

        assert!(matches!(
            reg.rebuild_embeddings(),
            Err(EmbedderError::Inference { .. })
        ));
        let hits = reg
            .search_with_method("read", 5, Origin::Direct, SearchMethod::Semantic)
            .unwrap();
        assert_eq!(
            hits.first().map(|hit| hit.tool_id.as_str()),
            Some("read_file")
        );
    }

    struct RebuildRaceEmbedder {
        rebuilding: AtomicBool,
        query_started: Barrier,
        release_query: Barrier,
        rebuild_entered: mpsc::Sender<()>,
    }

    impl RebuildRaceEmbedder {
        fn batch(&self, texts: &[String], rebuilding: bool) -> Vec<Vec<f32>> {
            texts
                .iter()
                .map(|text| match (text.contains("alpha"), rebuilding) {
                    (true, false) | (false, true) => vec![1.0, 0.0],
                    (false, false) | (true, true) => vec![0.0, 1.0],
                })
                .collect()
        }
    }

    impl Embedder for RebuildRaceEmbedder {
        fn embed_doc(&self, text: &str) -> Result<Vec<f32>, EmbedderError> {
            Ok(self.batch(&[text.to_string()], false).remove(0))
        }

        fn embed_query(&self, _: &str) -> Result<Vec<f32>, EmbedderError> {
            Ok(vec![1.0, 0.0])
        }

        fn embed_query_with_identity(&self, _: &str) -> Result<Embedded<Vec<f32>>, EmbedderError> {
            self.query_started.wait();
            self.release_query.wait();
            Ok(Embedded {
                value: vec![1.0, 0.0],
                fingerprint: "old".into(),
            })
        }

        fn embed_batch_with_identity(
            &self,
            texts: &[String],
        ) -> Result<Embedded<Vec<Vec<f32>>>, EmbedderError> {
            let rebuilding = self.rebuilding.load(Ordering::SeqCst);
            if rebuilding {
                self.rebuild_entered.send(()).unwrap();
            }
            Ok(Embedded {
                value: self.batch(texts, rebuilding),
                fingerprint: if rebuilding { "new" } else { "old" }.into(),
            })
        }
    }

    #[test]
    fn rebuild_cannot_swap_vector_space_during_dense_search() {
        let (rebuild_entered_tx, rebuild_entered_rx) = mpsc::channel();
        let embedder = Arc::new(RebuildRaceEmbedder {
            rebuilding: AtomicBool::new(false),
            query_started: Barrier::new(2),
            release_query: Barrier::new(2),
            rebuild_entered: rebuild_entered_tx,
        });
        let mut reg = with_embedder(embedder.clone());
        reg.register(tool("alpha", "alpha"));
        reg.register(tool("beta", "beta"));
        reg.build_embeddings().unwrap();
        embedder.rebuilding.store(true, Ordering::SeqCst);
        let reg = Arc::new(reg);

        let search_reg = reg.clone();
        let search = std::thread::spawn(move || {
            search_reg.search_with_method("query", 2, Origin::Direct, SearchMethod::Semantic)
        });
        embedder.query_started.wait();

        let rebuild_started = Arc::new(Barrier::new(2));
        let rebuild_reg = reg.clone();
        let rebuild_thread_started = rebuild_started.clone();
        let rebuild = std::thread::spawn(move || {
            rebuild_thread_started.wait();
            rebuild_reg.rebuild_embeddings()
        });
        rebuild_started.wait();
        let swapped_during_query = rebuild_entered_rx
            .recv_timeout(Duration::from_millis(500))
            .is_ok();

        embedder.release_query.wait();
        let hits = search.join().unwrap().unwrap();
        rebuild.join().unwrap().unwrap();

        assert!(
            !swapped_during_query,
            "rebuild entered the embedder while a query from the old vector space was in flight"
        );
        assert_eq!(hits.first().map(|hit| hit.tool_id.as_str()), Some("alpha"));
    }

    #[test]
    fn direct_embedding_model_is_validated_before_loading() {
        let mut reg = ToolRegistry::with_embedding(EmbeddingModel::Endpoint {
            url: " ".into(),
            model: "model".into(),
            api_key_env: None,
            query_prefix: None,
            doc_prefix: None,
        });
        reg.register(tool("alpha", "alpha"));

        assert!(matches!(
            reg.build_embeddings(),
            Err(EmbedderError::Config { .. })
        ));
    }

    #[test]
    fn re_register_replaces_not_appends() {
        // Re-registering an id must REPLACE it in place, not append a duplicate.
        // A duplicate would inflate the BM25 corpus (avgdl drift, degrading scores
        // corpus-wide) and leak the old Tool + its embedding. The corpus must hold
        // exactly one entry per id (RAT-378).
        let mut reg = ToolRegistry::new();
        reg.register(tool("shared", "read a file"));
        reg.register(tool("shared", "delete a file"));
        assert_eq!(reg.len(), 1, "re-register replaces, not appends");
        // The single surviving entry ranks with the latest content.
        let hits = reg.search("delete a file", 5);
        assert_eq!(hits.first().map(|h| h.tool_id.as_str()), Some("shared"));
        assert_eq!(hits.len(), 1, "one id in the corpus yields at most one hit");
    }

    #[test]
    fn re_register_updates_the_ranked_vector() {
        // Re-registering an id replaces it in place and invalidates its cached
        // embedding; the next build_embeddings re-embeds the new content, so the
        // updated content wins.
        let mut reg = with_embedder(Arc::new(StubEmbedder));
        reg.register(tool("t", "read a file")); // dense vec keyed on "read"
        reg.build_embeddings().unwrap();
        reg.register(tool("t", "delete a file")); // re-register → invalidated, keyed on "delete"
        reg.build_embeddings().unwrap();
        let hits = reg
            .search_with_method("delete", 5, Origin::Direct, SearchMethod::Semantic)
            .unwrap();
        assert_eq!(hits.first().map(|h| h.tool_id.as_str()), Some("t"));
        assert!(hits[0].score > 0.9, "ranks with the re-registered vector");
    }

    #[test]
    fn empty_registry_semantic_returns_no_hits_without_loading() {
        // Failing embedder + empty corpus: must short-circuit before any load.
        let reg = with_embedder(Arc::new(FailingEmbedder));
        let hits = reg
            .search_with_method("anything", 5, Origin::Direct, SearchMethod::Semantic)
            .unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn register_and_search_emit_trace_events() {
        let sink = Arc::new(MemorySink::new("test-session"));
        let mut reg = ToolRegistry::with_trace_sink(sink.clone());
        reg.register(tool("read_file", "read a file"));
        reg.search_with_origin("read", 5, Origin::Agent);

        let events = sink.drain();
        assert!(events.iter().any(|e| matches!(
            e.event,
            TraceEvent::IndexChurn {
                kind: ChurnKind::Add,
                ..
            }
        )));
        assert!(events.iter().any(|e| matches!(
            &e.event,
            TraceEvent::Search { origin: Origin::Agent, hits, .. } if !hits.is_empty()
        )));
    }
}
