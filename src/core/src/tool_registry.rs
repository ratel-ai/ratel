use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::dense_search::dense_search;
use crate::embedding::{Embedder, EmbedderError, embedder_with_telemetry};
use crate::fusion::{RETRIEVE_DEPTH, RRF_K, rrf_fuse};
use crate::indexing::searchable_text;
use crate::method::SearchMethod;
use crate::search::bm25_search;
use crate::tool::Tool;
use crate::trace::{
    ChurnKind, NoopSink, Origin, SearchHitTrace, SearchStage, TraceEvent, TraceSink,
};

pub struct SearchHit {
    pub tool_id: String,
    pub score: f32,
}

pub struct ToolRegistry {
    tools: Vec<Tool>,
    sink: Arc<dyn TraceSink>,
    /// Dense embeddings, a growing **prefix** of `tools`: `embeddings[i]` is the
    /// vector for `tools[i]`, and any tool beyond `embeddings.len()` is not yet
    /// embedded. `register` only appends a tool (never invalidates); the missing
    /// tail is embedded incrementally by [`Self::warm`] or the first semantic/
    /// hybrid search — so an existing vector is never recomputed. A pure BM25 user
    /// never populates this and never loads the model (see ADR-0011).
    embeddings: Mutex<Vec<Vec<f32>>>,
    /// Test-only override for the process embedder (`None` → the shared
    /// bge-small, loaded lazily on first use). Lets tests inject a
    /// deterministic/failing embedder without touching the network.
    embedder_override: Option<Arc<dyn Embedder>>,
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: Vec::new(),
            sink: Arc::new(NoopSink),
            embeddings: Mutex::new(Vec::new()),
            embedder_override: None,
        }
    }

    pub fn with_trace_sink(sink: Arc<dyn TraceSink>) -> Self {
        Self {
            tools: Vec::new(),
            sink,
            embeddings: Mutex::new(Vec::new()),
            embedder_override: None,
        }
    }

    pub fn set_trace_sink(&mut self, sink: Arc<dyn TraceSink>) {
        self.sink = sink;
    }

    pub fn record_event(&self, event: TraceEvent) {
        self.sink.record(event);
    }

    pub fn register(&mut self, tool: Tool) {
        let tool_id = tool.id.clone();
        self.tools.push(tool);
        // Just append — never touch the embeddings cache. The new tool sits
        // beyond the cached prefix and gets embedded incrementally by the next
        // `warm`/semantic search. Registration stays infallible and model-free,
        // so BM25 users are unaffected (see ADR-0011).
        self.sink.record(TraceEvent::IndexChurn {
            kind: ChurnKind::Add,
            tool_id,
        });
    }

    /// Lexical BM25 retrieval. The default engine — needs no model and never
    /// fails, so the public `search`/`search_with_origin` stay infallible and
    /// byte-for-byte compatible with the BM25-only releases.
    pub fn search(&self, query: &str, top_k: usize) -> Vec<SearchHit> {
        self.search_with_origin(query, top_k, Origin::Direct)
    }

    pub fn search_with_origin(&self, query: &str, top_k: usize, origin: Origin) -> Vec<SearchHit> {
        self.bm25_search_traced(query, top_k, origin)
    }

    /// Retrieve with an explicit [`SearchMethod`]. `Bm25` is infallible; `Semantic`
    /// and `Hybrid` load the embedding model lazily and may return an
    /// [`EmbedderError`] on a failed load/inference (network, cache, underpowered
    /// machine). The SDK layer picks the method (a per-catalog default or a
    /// per-call override) and calls this.
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
    /// Incremental — embeds only tools registered since the last call. The SDK
    /// calls this after `register` in semantic mode so searches never pay the
    /// embedding cost; a BM25-only user never calls it and never loads the model.
    pub fn warm(&self) -> Result<(), EmbedderError> {
        self.extend_embeddings()
    }

    // ---- engines -----------------------------------------------------------

    fn bm25_search_traced(&self, query: &str, top_k: usize, origin: Origin) -> Vec<SearchHit> {
        let started = Instant::now();
        let hits: Vec<SearchHit> = bm25_search(
            self.tools
                .iter()
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
        self.extend_embeddings()?;
        let query_vec = self.resolve_embedder()?.embed_query(query)?;
        let t = Instant::now();
        let ranked = self.dense_ranked(&query_vec, top_k)?;
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
                .iter()
                .map(|t| (t.id.clone(), searchable_text(t))),
            query,
            depth,
        );
        let bm25_stage = SearchStage {
            name: "bm25".into(),
            took_ms: t.elapsed().as_millis() as u64,
            top_score: bm25_ranked.first().map(|(_, s)| *s as f64),
        };

        // 2. Dense (semantic) — extend the cache with any new tools.
        self.extend_embeddings()?;
        let t = Instant::now();
        let query_vec = self.resolve_embedder()?.embed_query(query)?;
        let dense_ranked = self.dense_ranked(&query_vec, depth)?;
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

    // ---- dense support -----------------------------------------------------

    /// The embedder to use: an injected one (tests) or the shared process
    /// embedder, whose one-time load telemetry is recorded on this sink.
    fn resolve_embedder(&self) -> Result<Arc<dyn Embedder>, EmbedderError> {
        match &self.embedder_override {
            Some(e) => Ok(e.clone()),
            None => embedder_with_telemetry(self.sink.as_ref()),
        }
    }

    /// Embed the tools not yet in the cache and append them — the incremental
    /// core of the prefix cache. Embeds only `tools[cache.len()..]`, so an
    /// already-embedded tool is never recomputed (O(k) for k newly-registered
    /// tools). Idempotent: a no-op once the cache is caught up.
    fn extend_embeddings(&self) -> Result<(), EmbedderError> {
        let mut guard = self.embeddings.lock().expect("embeddings mutex poisoned");
        if guard.len() >= self.tools.len() {
            return Ok(());
        }
        let embedder = self.resolve_embedder()?;
        for tool in &self.tools[guard.len()..] {
            guard.push(embedder.embed_doc(&searchable_text(tool))?);
        }
        Ok(())
    }

    /// Cosine-rank the query against the cached embeddings. Assumes
    /// [`Self::extend_embeddings`] already ran. Collapses duplicate ids to the
    /// latest embedding (last-wins), mirroring the BM25 engine's id-keyed dedup —
    /// so a re-registered tool (a later entry in the prefix) wins.
    fn dense_ranked(
        &self,
        query_vec: &[f32],
        depth: usize,
    ) -> Result<Vec<(String, f32)>, EmbedderError> {
        let guard = self.embeddings.lock().expect("embeddings mutex poisoned");
        let mut latest: HashMap<&str, &[f32]> = HashMap::new();
        for (tool, embedding) in self.tools.iter().zip(guard.iter()) {
            latest.insert(tool.id.as_str(), embedding.as_slice());
        }
        Ok(dense_search(
            latest.into_iter().map(|(id, v)| (id.to_string(), v)),
            query_vec,
            depth,
        ))
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
    use super::*;
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
            tools: Vec::new(),
            sink: Arc::new(NoopSink),
            embeddings: Mutex::new(Vec::new()),
            embedder_override: Some(embedder),
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
        let hits = reg
            .search_with_method("read something", 5, Origin::Direct, SearchMethod::Semantic)
            .unwrap();
        assert_eq!(hits.first().map(|h| h.tool_id.as_str()), Some("read_file"));
    }

    #[test]
    fn semantic_surfaces_embedder_error_instead_of_panicking() {
        let reg = catalog(Arc::new(FailingEmbedder));
        assert!(matches!(
            reg.search_with_method("anything", 5, Origin::Direct, SearchMethod::Semantic),
            Err(EmbedderError::Inference { .. })
        ));
    }

    #[test]
    fn hybrid_fuses_bm25_and_dense() {
        let reg = catalog(Arc::new(StubEmbedder));
        let hits = reg
            .search_with_method("read a file", 5, Origin::Direct, SearchMethod::Hybrid)
            .unwrap();
        // Both arms rank read_file first (lexical "read a file" + dense "read").
        assert_eq!(hits.first().map(|h| h.tool_id.as_str()), Some("read_file"));
    }

    #[test]
    fn semantic_stage_is_named_dense() {
        let sink = Arc::new(MemorySink::new("s"));
        let mut reg = catalog(Arc::new(StubEmbedder));
        reg.set_trace_sink(sink.clone());
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
    fn register_after_search_embeds_only_the_new_tool() {
        let counter = Arc::new(CountingEmbedder::new());
        let mut reg = with_embedder(counter.clone());
        reg.register(tool("read_file", "read a file"));
        reg.register(tool("delete_file", "delete a file"));
        // First semantic search embeds the 2-tool corpus.
        reg.search_with_method("read", 5, Origin::Direct, SearchMethod::Semantic)
            .unwrap();
        assert_eq!(counter.doc_calls(), 2);
        // Registering one more must embed ONLY it on the next search — the two
        // existing vectors are reused, never recomputed (the O(N) regression).
        reg.register(tool("reader_v2", "read a file too"));
        let hits = reg
            .search_with_method("read", 10, Origin::Direct, SearchMethod::Semantic)
            .unwrap();
        assert_eq!(
            counter.doc_calls(),
            3,
            "only the newly-registered tool should be embedded"
        );
        assert!(hits.iter().any(|h| h.tool_id == "reader_v2"));
    }

    #[test]
    fn warm_precomputes_so_search_embeds_no_docs() {
        let counter = Arc::new(CountingEmbedder::new());
        let mut reg = with_embedder(counter.clone());
        reg.register(tool("read_file", "read a file"));
        reg.register(tool("delete_file", "delete a file"));
        reg.warm().unwrap();
        assert_eq!(counter.doc_calls(), 2, "warm embeds the corpus up front");
        reg.search_with_method("read", 5, Origin::Direct, SearchMethod::Semantic)
            .unwrap();
        assert_eq!(
            counter.doc_calls(),
            2,
            "a warmed search embeds only the query, no documents"
        );
    }

    #[test]
    fn warm_is_idempotent() {
        let counter = Arc::new(CountingEmbedder::new());
        let mut reg = with_embedder(counter.clone());
        reg.register(tool("read_file", "read a file"));
        reg.warm().unwrap();
        reg.warm().unwrap();
        assert_eq!(counter.doc_calls(), 1);
    }

    #[test]
    fn re_register_updates_the_ranked_vector() {
        // Re-registering an id appends a fresh entry; last-wins dedup ranks with
        // the latest embedding, so the updated content wins.
        let mut reg = with_embedder(Arc::new(StubEmbedder));
        reg.register(tool("t", "read a file")); // dense vec keyed on "read"
        reg.search_with_method("read", 5, Origin::Direct, SearchMethod::Semantic)
            .unwrap();
        reg.register(tool("t", "delete a file")); // re-register → keyed on "delete"
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
