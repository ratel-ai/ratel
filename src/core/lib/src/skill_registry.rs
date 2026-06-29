use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use crate::dense_search::dense_search;
use crate::embedding::embedder;
use crate::fusion::{RERANK_POOL, RETRIEVE_DEPTH, RRF_K, rrf_fuse, sort_and_truncate};
use crate::reranker::reranker;
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

/// Retrieval index over [`Skill`]s — the on-demand analog of
/// [`crate::ToolRegistry`]. Same hybrid engine (BM25 + dense + RRF + cross-encoder
/// rerank, ADR-0013); a parallel type keeps the tool path independent and lets
/// skill telemetry stand on its own.
pub struct SkillRegistry {
    skills: Vec<Skill>,
    /// Precomputed dense embeddings, index-aligned with `skills` (one per
    /// `register`). Mirrors [`crate::ToolRegistry`]'s dense path.
    embeddings: Vec<Vec<f32>>,
    sink: Arc<dyn TraceSink>,
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
            embeddings: Vec::new(),
            sink: Arc::new(NoopSink),
        }
    }

    pub fn with_trace_sink(sink: Arc<dyn TraceSink>) -> Self {
        Self {
            skills: Vec::new(),
            embeddings: Vec::new(),
            sink,
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
        // Embed the same name+description+tags text BM25 indexes, once, before
        // the skill is moved into the corpus. Index-aligned with `skills`.
        let embedding = embedder().embed_doc(&searchable_text(&skill));
        self.skills.push(skill);
        self.embeddings.push(embedding);
        self.sink.record(TraceEvent::SkillChurn {
            kind: ChurnKind::Add,
            skill_id,
        });
    }

    pub fn search(&self, query: &str, top_k: usize) -> Vec<SkillHit> {
        self.search_with_origin(query, top_k, Origin::Direct)
    }

    /// Hybrid skill retrieval — the skill analog of
    /// [`crate::ToolRegistry::search_with_origin`]. Same `(query, top_k)`
    /// contract; BM25 + dense fused with RRF, then cross-encoder reranked.
    pub fn search_with_origin(&self, query: &str, top_k: usize, origin: Origin) -> Vec<SkillHit> {
        let started = Instant::now();
        if self.skills.is_empty() || top_k == 0 {
            self.sink.record(TraceEvent::SkillSearch {
                query: query.to_string(),
                origin,
                top_k: top_k as u32,
                hits: Vec::new(),
                stages: Vec::new(),
                took_ms: started.elapsed().as_millis() as u64,
            });
            return Vec::new();
        }

        let depth = RETRIEVE_DEPTH.max(top_k);
        let pool = RERANK_POOL.max(top_k);

        // Collapse duplicate ids to the latest entry (last-wins), mirroring BM25.
        let mut latest_vec: HashMap<&str, &[f32]> = HashMap::new();
        let mut latest_skill: HashMap<&str, &Skill> = HashMap::new();
        for (skill, embedding) in self.skills.iter().zip(self.embeddings.iter()) {
            latest_vec.insert(skill.id.as_str(), embedding.as_slice());
            latest_skill.insert(skill.id.as_str(), skill);
        }

        // 1. BM25 (lexical).
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

        // 2. Dense (semantic).
        let t = Instant::now();
        let query_vec = embedder().embed_query(query);
        let dense_ranked = dense_search(
            latest_vec.iter().map(|(id, v)| (id.to_string(), *v)),
            &query_vec,
            depth,
        );
        let dense_stage = SearchStage {
            name: "dense".into(),
            took_ms: t.elapsed().as_millis() as u64,
            top_score: dense_ranked.first().map(|(_, s)| *s as f64),
        };

        // 3. RRF fusion → bounded rerank pool.
        let t = Instant::now();
        let bm25_ids: Vec<String> = bm25_ranked.into_iter().map(|(id, _)| id).collect();
        let dense_ids: Vec<String> = dense_ranked.into_iter().map(|(id, _)| id).collect();
        let mut fused = rrf_fuse(&[&bm25_ids, &dense_ids], RRF_K);
        fused.truncate(pool);
        let rrf_stage = SearchStage {
            name: "rrf".into(),
            took_ms: t.elapsed().as_millis() as u64,
            top_score: fused.first().map(|(_, s)| *s as f64),
        };

        // 4. Cross-encoder rerank → final top_k.
        let t = Instant::now();
        let candidates: Vec<(String, String)> = fused
            .iter()
            .filter_map(|(id, _)| {
                latest_skill
                    .get(id.as_str())
                    .map(|skill| (id.clone(), searchable_text(skill)))
            })
            .collect();
        let mut reranked = reranker().rerank(query, &candidates);
        sort_and_truncate(&mut reranked, top_k);
        let rerank_stage = SearchStage {
            name: "rerank".into(),
            took_ms: t.elapsed().as_millis() as u64,
            top_score: reranked.first().map(|(_, s)| *s as f64),
        };

        let hits: Vec<SkillHit> = reranked
            .into_iter()
            .map(|(skill_id, score)| SkillHit { skill_id, score })
            .collect();
        let took_ms = started.elapsed().as_millis() as u64;
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
            stages: vec![bm25_stage, dense_stage, rrf_stage, rerank_stage],
            took_ms,
        });
        hits
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::MemorySink;

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
