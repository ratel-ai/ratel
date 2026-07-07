use std::sync::Arc;
use std::time::Instant;

use crate::dense_cache::{DenseCache, Embeddable};
use crate::embedding::EmbedderError;
use crate::fusion::{RETRIEVE_DEPTH, RRF_K, rrf_fuse};
use crate::method::SearchMethod;
use crate::search::bm25_search;
use crate::skill::Skill;
use crate::skill_indexing::searchable_text;
use crate::trace::{
    ChurnKind, NoopSink, Origin, SearchStage, SkillHitTrace, TraceEvent, TraceSink,
};

pub struct SkillHit {
    pub skill_id: String,
    pub score: f32,
}

impl Embeddable for Skill {
    fn embed_id(&self) -> &str {
        &self.id
    }
    fn embed_text(&self) -> String {
        searchable_text(self)
    }
}

/// Retrieval index over [`Skill`]s — the on-demand analog of
/// [`crate::ToolRegistry`]. Same selectable BM25/semantic/hybrid engines; a
/// parallel type keeps the tool path untouched and lets skill telemetry stand on
/// its own.
pub struct SkillRegistry {
    skills: Vec<Skill>,
    sink: Arc<dyn TraceSink>,
    /// Dense embeddings for `skills`, a growing prefix built on demand — the
    /// skill-side twin of [`crate::ToolRegistry`]'s field (see [`DenseCache`]).
    dense: DenseCache,
}

impl Default for SkillRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl SkillRegistry {
    pub fn new() -> Self {
        Self {
            skills: Vec::new(),
            sink: Arc::new(NoopSink),
            dense: DenseCache::new(),
        }
    }

    pub fn with_trace_sink(sink: Arc<dyn TraceSink>) -> Self {
        Self {
            skills: Vec::new(),
            sink,
            dense: DenseCache::new(),
        }
    }

    pub fn set_trace_sink(&mut self, sink: Arc<dyn TraceSink>) {
        self.sink = sink;
    }

    pub fn record_event(&self, event: TraceEvent) {
        self.sink.record(event);
    }

    pub fn register(&mut self, skill: Skill) {
        let skill_id = skill.id.clone();
        self.skills.push(skill);
        // Append only — the new skill is embedded by the next `build_embeddings`
        // (a search never embeds); see [`crate::ToolRegistry::register`].
        // Duplicate ids are possible and all get indexed (last wins at search
        // time); id-stable callers (catalog sync) should use [`Self::upsert`].
        self.sink.record(TraceEvent::SkillChurn {
            kind: ChurnKind::Add,
            skill_id,
        });
    }

    /// Registers the skill, replacing any existing skill with the same id
    /// (historical duplicates collapse). Emits `Remove` then `Add` churn on
    /// replacement. Returns `true` when something was replaced.
    pub fn upsert(&mut self, skill: Skill) -> bool {
        let replaced = self.remove(&skill.id);
        self.register(skill);
        replaced
    }

    /// Removes every skill with the given id (tolerating historical duplicates
    /// from [`Self::register`]). Returns `true` when anything was removed;
    /// unknown ids are a no-op with no churn event.
    pub fn remove(&mut self, skill_id: &str) -> bool {
        let before = self.skills.len();
        self.skills.retain(|s| s.id != skill_id);
        let removed = self.skills.len() < before;
        if removed {
            // Removal breaks the dense cache's index alignment (and can leave
            // it longer than the corpus); drop it and let the next
            // `build_embeddings` re-embed. Covers `upsert`'s replace path too.
            self.dense.clear();
            self.sink.record(TraceEvent::SkillChurn {
                kind: ChurnKind::Remove,
                skill_id: skill_id.to_string(),
            });
        }
        removed
    }

    pub fn search(&self, query: &str, top_k: usize) -> Vec<SkillHit> {
        self.search_with_origin(query, top_k, Origin::Direct)
    }

    pub fn search_with_origin(&self, query: &str, top_k: usize, origin: Origin) -> Vec<SkillHit> {
        self.bm25_search_traced(query, top_k, origin)
    }

    /// Retrieve with an explicit [`SearchMethod`]. See
    /// [`crate::ToolRegistry::search_with_method`].
    pub fn search_with_method(
        &self,
        query: &str,
        top_k: usize,
        origin: Origin,
        method: SearchMethod,
    ) -> Result<Vec<SkillHit>, EmbedderError> {
        match method {
            SearchMethod::Bm25 => Ok(self.bm25_search_traced(query, top_k, origin)),
            SearchMethod::Semantic => self.semantic_search_traced(query, top_k, origin),
            SearchMethod::Hybrid => self.hybrid_search_traced(query, top_k, origin),
        }
    }

    /// Pre-compute embeddings for not-yet-embedded skills — see
    /// [`crate::ToolRegistry::build_embeddings`].
    pub fn build_embeddings(&self) -> Result<(), EmbedderError> {
        self.dense.extend(&self.skills, self.sink.as_ref())
    }

    // ---- engines -----------------------------------------------------------

    fn bm25_search_traced(&self, query: &str, top_k: usize, origin: Origin) -> Vec<SkillHit> {
        let started = Instant::now();
        let hits: Vec<SkillHit> = bm25_search(
            self.skills
                .iter()
                .map(|s| (s.id.clone(), searchable_text(s))),
            query,
            top_k,
        )
        .into_iter()
        .map(|(skill_id, score)| SkillHit { skill_id, score })
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
    ) -> Result<Vec<SkillHit>, EmbedderError> {
        let started = Instant::now();
        if self.skills.is_empty() || top_k == 0 {
            self.record_search(query, origin, top_k, &[], Vec::new(), 0);
            return Ok(Vec::new());
        }
        self.dense.require_built(self.skills.len())?;
        let query_vec = self.dense.embed_query(query, self.sink.as_ref())?;
        let t = Instant::now();
        let ranked = self.dense.ranked(&self.skills, &query_vec, top_k);
        let stage_ms = t.elapsed().as_millis() as u64;
        let hits: Vec<SkillHit> = ranked
            .into_iter()
            .map(|(skill_id, score)| SkillHit { skill_id, score })
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

    fn hybrid_search_traced(
        &self,
        query: &str,
        top_k: usize,
        origin: Origin,
    ) -> Result<Vec<SkillHit>, EmbedderError> {
        let started = Instant::now();
        if self.skills.is_empty() || top_k == 0 {
            self.record_search(query, origin, top_k, &[], Vec::new(), 0);
            return Ok(Vec::new());
        }
        let depth = RETRIEVE_DEPTH.max(top_k);

        let t = Instant::now();
        let bm25_ranked = bm25_search(
            self.skills
                .iter()
                .map(|s| (s.id.clone(), searchable_text(s))),
            query,
            depth,
        );
        let bm25_stage = SearchStage {
            name: "bm25".into(),
            took_ms: t.elapsed().as_millis() as u64,
            top_score: bm25_ranked.first().map(|(_, s)| *s as f64),
        };

        self.dense.require_built(self.skills.len())?;
        let t = Instant::now();
        let query_vec = self.dense.embed_query(query, self.sink.as_ref())?;
        let dense_ranked = self.dense.ranked(&self.skills, &query_vec, depth);
        let dense_stage = SearchStage {
            name: "dense".into(),
            took_ms: t.elapsed().as_millis() as u64,
            top_score: dense_ranked.first().map(|(_, s)| *s as f64),
        };

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

        let hits: Vec<SkillHit> = fused
            .into_iter()
            .map(|(skill_id, score)| SkillHit { skill_id, score })
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
        hits: &[SkillHit],
        stages: Vec<SearchStage>,
        took_ms: u64,
    ) {
        self.sink.record(TraceEvent::SkillSearch {
            query: query.to_string(),
            origin,
            top_k: top_k as u32,
            hits: hits
                .iter()
                .map(|h| SkillHitTrace {
                    skill_id: h.skill_id.clone(),
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
    use crate::embedding::Embedder;
    use crate::trace::MemorySink;

    struct StubEmbedder;
    impl StubEmbedder {
        fn vec_for(text: &str) -> Vec<f32> {
            let t = text.to_lowercase();
            if t.contains("api") || t.contains("rest") {
                vec![1.0, 0.0, 0.0]
            } else if t.contains("frontend") || t.contains("slides") {
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

    /// Counts `embed_doc` calls (see `tool_registry`'s `CountingEmbedder`).
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

    fn with_embedder(embedder: Arc<dyn Embedder>) -> SkillRegistry {
        SkillRegistry {
            skills: Vec::new(),
            sink: Arc::new(NoopSink),
            dense: DenseCache::with_embedder(embedder),
        }
    }

    fn skill(id: &str, name: &str, description: &str, tags: &[&str]) -> Skill {
        Skill {
            id: id.into(),
            name: name.into(),
            description: description.into(),
            tags: tags.iter().map(|t| (*t).into()).collect(),
            tools: vec![],
            metadata: std::collections::HashMap::new(),
            body: format!("# {name}\n\nbody"),
        }
    }

    fn catalog() -> SkillRegistry {
        let mut reg = SkillRegistry::new();
        reg.register(skill(
            "frontend-slides",
            "frontend-slides",
            "Build animation-rich HTML presentations from scratch",
            &["frontend", "presentations"],
        ));
        reg.register(skill(
            "api-design",
            "api-design",
            "REST API design patterns: resource naming, status codes, pagination",
            &["backend", "api"],
        ));
        reg
    }

    #[test]
    fn upsert_new_id_registers_and_emits_add() {
        let sink = Arc::new(MemorySink::new("test-session"));
        let mut reg = SkillRegistry::with_trace_sink(sink.clone());

        let replaced = reg.upsert(skill(
            "api-design",
            "api-design",
            "REST API design",
            &["api"],
        ));

        assert!(!replaced);
        let hits = reg.search("REST API design", 5);
        assert_eq!(
            hits.first().map(|h| h.skill_id.as_str()),
            Some("api-design")
        );
        assert!(sink.drain().iter().any(|e| matches!(
            e.event,
            TraceEvent::SkillChurn {
                kind: ChurnKind::Add,
                ..
            }
        )));
    }

    #[test]
    fn upsert_existing_id_replaces_and_reindexes_with_remove_then_add() {
        let sink = Arc::new(MemorySink::new("test-session"));
        let mut reg = SkillRegistry::with_trace_sink(sink.clone());
        reg.register(skill(
            "api-design",
            "api-design",
            "REST API design",
            &["api"],
        ));
        sink.drain();

        let replaced = reg.upsert(skill(
            "api-design",
            "api-design",
            "GraphQL schema modeling",
            &["graphql"],
        ));

        assert!(replaced);
        let hits = reg.search("GraphQL schema", 5);
        assert_eq!(
            hits.first().map(|h| h.skill_id.as_str()),
            Some("api-design")
        );
        assert!(reg.search("REST", 5).is_empty());
        let churn: Vec<ChurnKind> = sink
            .drain()
            .into_iter()
            .filter_map(|e| match e.event {
                TraceEvent::SkillChurn { kind, .. } => Some(kind),
                _ => None,
            })
            .collect();
        assert!(matches!(
            churn.as_slice(),
            [ChurnKind::Remove, ChurnKind::Add]
        ));
    }

    #[test]
    fn remove_deletes_the_skill_and_emits_remove() {
        let sink = Arc::new(MemorySink::new("test-session"));
        let mut reg = SkillRegistry::with_trace_sink(sink.clone());
        reg.register(skill(
            "api-design",
            "api-design",
            "REST API design",
            &["api"],
        ));
        sink.drain();

        let removed = reg.remove("api-design");

        assert!(removed);
        assert!(reg.search("REST API design", 5).is_empty());
        assert!(sink.drain().iter().any(|e| matches!(
            e.event,
            TraceEvent::SkillChurn {
                kind: ChurnKind::Remove,
                ..
            }
        )));
    }

    #[test]
    fn remove_unknown_id_is_a_noop_without_events() {
        let sink = Arc::new(MemorySink::new("test-session"));
        let mut reg = SkillRegistry::with_trace_sink(sink.clone());

        let removed = reg.remove("ghost");

        assert!(!removed);
        assert!(sink.drain().is_empty());
    }

    #[test]
    fn remove_after_duplicate_registers_removes_all_occurrences() {
        let mut reg = SkillRegistry::new();
        reg.register(skill("dup", "dup", "REST API design", &["api"]));
        reg.register(skill("dup", "dup", "REST API design", &["api"]));

        assert!(reg.remove("dup"));

        assert!(reg.search("REST API design", 5).is_empty());
    }

    #[test]
    fn upsert_after_duplicate_registers_normalizes_to_one_skill() {
        let mut reg = SkillRegistry::new();
        reg.register(skill("dup", "dup", "REST API design", &["api"]));
        reg.register(skill("dup", "dup", "REST API design", &["api"]));

        assert!(reg.upsert(skill("dup", "dup", "GraphQL schema modeling", &["graphql"])));

        assert!(reg.search("REST", 5).is_empty());
        assert_eq!(reg.search("GraphQL schema", 5).len(), 1);
    }

    #[test]
    fn upsert_replace_invalidates_dense_cache_and_rebuild_reflects_the_new_text() {
        let mut reg = with_embedder(Arc::new(StubEmbedder));
        // Neutral id: the stub embedder keys on the searchable text, which
        // includes the name, so the id must not collide with its keywords.
        reg.register(skill("writer", "writer", "REST API design", &["rest"]));
        reg.register(skill("notes", "notes", "meeting notes", &["notes"]));
        reg.build_embeddings().unwrap();

        reg.upsert(skill("writer", "writer", "frontend slides", &["slides"]));

        // The stale vectors are gone: semantic search demands a rebuild instead
        // of silently ranking old embeddings against the mutated corpus.
        assert!(matches!(
            reg.search_with_method("frontend slides", 5, Origin::Direct, SearchMethod::Semantic),
            Err(EmbedderError::EmbeddingsNotBuilt)
        ));

        reg.build_embeddings().unwrap();
        let hits = reg
            .search_with_method("frontend slides", 5, Origin::Direct, SearchMethod::Semantic)
            .unwrap();
        assert_eq!(hits.first().map(|h| h.skill_id.as_str()), Some("writer"));
        assert!(hits[0].score > 0.9, "ranks with the replacement's vector");
    }

    #[test]
    fn remove_invalidates_dense_cache_so_stale_vectors_never_outlive_the_corpus() {
        let mut reg = with_embedder(Arc::new(StubEmbedder));
        reg.register(skill(
            "api-design",
            "api-design",
            "REST API design",
            &["api"],
        ));
        reg.register(skill(
            "frontend-slides",
            "frontend-slides",
            "frontend slides",
            &["frontend"],
        ));
        reg.build_embeddings().unwrap();

        reg.remove("api-design");

        // Without invalidation the cache would be LONGER than the corpus:
        // build_embeddings would early-return and the survivor would rank
        // against the removed skill's vector.
        assert!(matches!(
            reg.search_with_method("frontend slides", 5, Origin::Direct, SearchMethod::Semantic),
            Err(EmbedderError::EmbeddingsNotBuilt)
        ));

        reg.build_embeddings().unwrap();
        let hits = reg
            .search_with_method("frontend slides", 5, Origin::Direct, SearchMethod::Semantic)
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].skill_id, "frontend-slides");
        assert!(
            hits[0].score > 0.9,
            "ranks with its own vector, not a stale one"
        );
    }

    #[test]
    fn search_ranks_the_relevant_skill_first() {
        let reg = catalog();
        let hits = reg.search("design a REST endpoint with pagination", 5);
        assert_eq!(
            hits.first().map(|h| h.skill_id.as_str()),
            Some("api-design")
        );
    }

    #[test]
    fn search_on_empty_registry_returns_no_hits() {
        let reg = SkillRegistry::new();
        assert!(reg.search("anything", 5).is_empty());
    }

    #[test]
    fn semantic_ranks_via_injected_embedder() {
        let mut reg = with_embedder(Arc::new(StubEmbedder));
        reg.register(skill(
            "api-design",
            "api-design",
            "REST API design",
            &["api"],
        ));
        reg.register(skill(
            "frontend-slides",
            "frontend-slides",
            "HTML slides",
            &["frontend"],
        ));
        reg.build_embeddings().unwrap();
        let hits = reg
            .search_with_method("rest api", 5, Origin::Direct, SearchMethod::Semantic)
            .unwrap();
        assert_eq!(
            hits.first().map(|h| h.skill_id.as_str()),
            Some("api-design")
        );
    }

    #[test]
    fn build_embeddings_after_register_embeds_only_the_new_skill() {
        let counter = Arc::new(CountingEmbedder::new());
        let mut reg = with_embedder(counter.clone());
        reg.register(skill(
            "api-design",
            "api-design",
            "REST API design",
            &["api"],
        ));
        reg.register(skill("frontend", "frontend", "HTML slides", &["frontend"]));
        reg.build_embeddings().unwrap();
        assert_eq!(counter.doc_calls(), 2);
        reg.register(skill("api-v2", "api-v2", "REST API v2", &["api"]));
        reg.build_embeddings().unwrap();
        assert_eq!(counter.doc_calls(), 3, "only the new skill is embedded");
    }

    #[test]
    fn build_embeddings_precomputes_so_search_embeds_no_docs() {
        let counter = Arc::new(CountingEmbedder::new());
        let mut reg = with_embedder(counter.clone());
        reg.register(skill(
            "api-design",
            "api-design",
            "REST API design",
            &["api"],
        ));
        reg.build_embeddings().unwrap();
        assert_eq!(counter.doc_calls(), 1);
        reg.search_with_method("api", 5, Origin::Direct, SearchMethod::Semantic)
            .unwrap();
        assert_eq!(
            counter.doc_calls(),
            1,
            "a search after build_embeddings embeds only the query"
        );
    }

    #[test]
    fn hybrid_emits_three_stages() {
        let sink = Arc::new(MemorySink::new("s"));
        let mut reg = with_embedder(Arc::new(StubEmbedder));
        reg.set_trace_sink(sink.clone());
        reg.register(skill(
            "api-design",
            "api-design",
            "REST API design",
            &["api"],
        ));
        reg.build_embeddings().unwrap();
        reg.search_with_method("api", 5, Origin::Agent, SearchMethod::Hybrid)
            .unwrap();
        let events = sink.drain();
        assert!(events.iter().any(|e| matches!(
            &e.event,
            TraceEvent::SkillSearch { stages, .. }
                if stages.iter().any(|s| s.name == "bm25")
                && stages.iter().any(|s| s.name == "dense")
                && stages.iter().any(|s| s.name == "rrf")
        )));
    }

    #[test]
    fn register_and_search_emit_trace_events() {
        let sink = Arc::new(MemorySink::new("test-session"));
        let mut reg = SkillRegistry::with_trace_sink(sink.clone());
        reg.register(skill(
            "api-design",
            "api-design",
            "REST API design",
            &["api"],
        ));
        reg.search_with_origin("api design", 5, Origin::Agent);

        let events = sink.drain();
        assert!(events.iter().any(|e| matches!(
            e.event,
            TraceEvent::SkillChurn {
                kind: ChurnKind::Add,
                ..
            }
        )));
        assert!(events.iter().any(|e| matches!(
            &e.event,
            TraceEvent::SkillSearch { origin: Origin::Agent, hits, .. } if !hits.is_empty()
        )));
    }
}
