use std::sync::Arc;
use std::time::Instant;

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
/// [`crate::ToolRegistry`]. Same BM25 engine and tuning; a parallel type keeps
/// the tool path untouched and lets skill telemetry stand on its own.
pub struct SkillRegistry {
    skills: Vec<Skill>,
    /// Precomputed embeddings, index-aligned with `skills` (one per `register`).
    /// Mirrors [`crate::ToolRegistry`]'s dense path.
    #[cfg(feature = "dense-search")]
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
            #[cfg(feature = "dense-search")]
            embeddings: Vec::new(),
            sink: Arc::new(NoopSink),
        }
    }

    pub fn with_trace_sink(sink: Arc<dyn TraceSink>) -> Self {
        Self {
            skills: Vec::new(),
            #[cfg(feature = "dense-search")]
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
        #[cfg(feature = "dense-search")]
        let embedding = crate::embedding::embedder().embed_doc(&searchable_text(&skill));
        self.skills.push(skill);
        #[cfg(feature = "dense-search")]
        self.embeddings.push(embedding);
        self.sink.record(TraceEvent::SkillChurn {
            kind: ChurnKind::Add,
            skill_id,
        });
    }

    pub fn search(&self, query: &str, top_k: usize) -> Vec<SkillHit> {
        self.search_with_origin(query, top_k, Origin::Direct)
    }

    pub fn search_with_origin(&self, query: &str, top_k: usize, origin: Origin) -> Vec<SkillHit> {
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
            stages: vec![SearchStage {
                name: "bm25".into(),
                took_ms,
                top_score,
            }],
            took_ms,
        });
        hits
    }

    /// Dense (semantic) skill retrieval — the skill analog of
    /// [`crate::ToolRegistry::search_dense`]. Same `(query, top_k)` contract as
    /// [`Self::search`]; ranks by embedding cosine. BM25 is untouched.
    #[cfg(feature = "dense-search")]
    pub fn search_dense(&self, query: &str, top_k: usize) -> Vec<SkillHit> {
        self.search_dense_with_origin(query, top_k, Origin::Direct)
    }

    #[cfg(feature = "dense-search")]
    pub fn search_dense_with_origin(
        &self,
        query: &str,
        top_k: usize,
        origin: Origin,
    ) -> Vec<SkillHit> {
        use std::collections::HashMap;

        let started = Instant::now();
        let query_vec = crate::embedding::embedder().embed_query(query);
        // Collapse duplicate ids to the latest embedding — mirrors BM25's
        // id-keyed last-wins so re-registering a skill replaces it here too.
        let mut latest: HashMap<&str, &[f32]> = HashMap::new();
        for (skill, embedding) in self.skills.iter().zip(self.embeddings.iter()) {
            latest.insert(skill.id.as_str(), embedding.as_slice());
        }
        let hits: Vec<SkillHit> = crate::dense_search::dense_search(
            latest.into_iter().map(|(id, v)| (id.to_string(), v)),
            &query_vec,
            top_k,
        )
        .into_iter()
        .map(|(skill_id, score)| SkillHit { skill_id, score })
        .collect();
        let took_ms = started.elapsed().as_millis() as u64;
        let top_score = hits.first().map(|h| h.score as f64);
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
            stages: vec![SearchStage {
                name: "dense".into(),
                took_ms,
                top_score,
            }],
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
