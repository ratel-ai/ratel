use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use crate::dense_search::dense_search;
use crate::embedding::{Embedder, EmbedderError, embedder_with_telemetry};
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
/// [`crate::ToolRegistry`]. Same dense engine; a parallel type keeps skill
/// telemetry standing on its own.
pub struct SkillRegistry {
    skills: Vec<Skill>,
    /// Precomputed embeddings, index-aligned with `skills` (one per `register`).
    /// Mirrors [`crate::ToolRegistry`]'s dense path.
    embeddings: Vec<Vec<f32>>,
    sink: Arc<dyn TraceSink>,
    /// Test-only override for the process embedder (`None` → the shared
    /// bge-small). Mirrors [`crate::ToolRegistry`].
    embedder_override: Option<Arc<dyn Embedder>>,
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
            embedder_override: None,
        }
    }

    pub fn with_trace_sink(sink: Arc<dyn TraceSink>) -> Self {
        Self {
            skills: Vec::new(),
            embeddings: Vec::new(),
            sink,
            embedder_override: None,
        }
    }

    pub fn set_trace_sink(&mut self, sink: Arc<dyn TraceSink>) {
        self.sink = sink;
    }

    pub fn record_event(&self, event: TraceEvent) {
        self.sink.record(event);
    }

    /// The embedder to use: an injected one (tests) or the shared process
    /// embedder, whose one-time load telemetry is recorded on this sink.
    fn resolve_embedder(&self) -> Result<Arc<dyn Embedder>, EmbedderError> {
        match &self.embedder_override {
            Some(e) => Ok(e.clone()),
            None => embedder_with_telemetry(self.sink.as_ref()),
        }
    }

    /// Register a skill. Fallible for the same reason as
    /// [`crate::ToolRegistry::register`]: the first-use model load can fail.
    pub fn register(&mut self, skill: Skill) -> Result<(), EmbedderError> {
        let skill_id = skill.id.clone();
        // Embed the skill's name+description+tags text once, before the skill is
        // moved into the corpus. Index-aligned with `skills`.
        let embedding = self
            .resolve_embedder()?
            .embed_doc(&searchable_text(&skill))?;
        self.skills.push(skill);
        self.embeddings.push(embedding);
        self.sink.record(TraceEvent::SkillChurn {
            kind: ChurnKind::Add,
            skill_id,
        });
        Ok(())
    }

    pub fn search(&self, query: &str, top_k: usize) -> Result<Vec<SkillHit>, EmbedderError> {
        self.search_with_origin(query, top_k, Origin::Direct)
    }

    /// Dense (semantic) skill retrieval — the skill analog of
    /// [`crate::ToolRegistry::search_with_origin`]. Ranks by embedding cosine;
    /// the only retrieval path in this version (see ADR-0013).
    pub fn search_with_origin(
        &self,
        query: &str,
        top_k: usize,
        origin: Origin,
    ) -> Result<Vec<SkillHit>, EmbedderError> {
        let started = Instant::now();
        let query_vec = self.resolve_embedder()?.embed_query(query)?;
        // Collapse duplicate ids to the latest embedding (last-wins), so
        // re-registering a skill replaces it.
        let mut latest: HashMap<&str, &[f32]> = HashMap::new();
        for (skill, embedding) in self.skills.iter().zip(self.embeddings.iter()) {
            latest.insert(skill.id.as_str(), embedding.as_slice());
        }
        let hits: Vec<SkillHit> = dense_search(
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
        Ok(hits)
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

    fn catalog() -> SkillRegistry {
        let mut reg = SkillRegistry::new();
        reg.register(skill(
            "frontend-slides",
            "frontend-slides",
            "Build animation-rich HTML presentations from scratch",
            &["frontend", "presentations"],
        ))
        .unwrap();
        reg.register(skill(
            "api-design",
            "api-design",
            "REST API design patterns: resource naming, status codes, pagination",
            &["backend", "api"],
        ))
        .unwrap();
        reg
    }

    #[test]
    fn search_ranks_the_relevant_skill_first() {
        let reg = catalog();
        let hits = reg
            .search("design a REST endpoint with pagination", 5)
            .unwrap();
        assert_eq!(
            hits.first().map(|h| h.skill_id.as_str()),
            Some("api-design")
        );
    }

    #[test]
    fn search_on_empty_registry_returns_no_hits() {
        let reg = SkillRegistry::new();
        assert!(reg.search("anything", 5).unwrap().is_empty());
    }

    #[test]
    fn register_surfaces_embedder_error_instead_of_panicking() {
        let mut reg = SkillRegistry {
            skills: Vec::new(),
            embeddings: Vec::new(),
            sink: Arc::new(NoopSink),
            embedder_override: Some(Arc::new(FailingEmbedder)),
        };
        let err = reg
            .register(skill(
                "api-design",
                "api-design",
                "REST API design",
                &["api"],
            ))
            .unwrap_err();
        assert!(matches!(err, EmbedderError::Inference { .. }));
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
        ))
        .unwrap();
        reg.search_with_origin("api design", 5, Origin::Agent)
            .unwrap();

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
