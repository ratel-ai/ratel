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

/// A traced skill search: the ranked hits plus the `search_id` stamped on the
/// emitted `skill_search` event.
pub struct SkillSearchOutcome {
    pub search_id: String,
    pub hits: Vec<SkillHit>,
}

/// Retrieval index over [`Skill`]s — the on-demand analog of
/// [`crate::ToolRegistry`]. Same BM25 engine and tuning; a parallel type keeps
/// the tool path untouched and lets skill telemetry stand on its own.
pub struct SkillRegistry {
    skills: Vec<Skill>,
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
            sink: Arc::new(NoopSink),
        }
    }

    pub fn with_trace_sink(sink: Arc<dyn TraceSink>) -> Self {
        Self {
            skills: Vec::new(),
            sink,
        }
    }

    pub fn set_trace_sink(&mut self, sink: Arc<dyn TraceSink>) {
        self.sink = sink;
    }

    pub fn record_event(&self, event: TraceEvent) {
        self.sink.record(event);
    }

    /// Appends blindly — duplicate ids are possible and all get indexed.
    /// Id-stable callers (catalog sync, hot reload) should use [`Self::upsert`].
    pub fn register(&mut self, skill: Skill) {
        let skill_id = skill.id.clone();
        self.skills.push(skill);
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

    /// Removes every skill with the given id (tolerating historical
    /// duplicates from [`Self::register`]). Returns `true` when anything was
    /// removed.
    pub fn remove(&mut self, skill_id: &str) -> bool {
        let before = self.skills.len();
        self.skills.retain(|s| s.id != skill_id);
        let removed = self.skills.len() < before;
        if removed {
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
        self.search_traced(query, top_k, origin).hits
    }

    /// Like [`Self::search_with_origin`], but also returns the `search_id`
    /// stamped on the emitted `skill_search` event (ADR-0013).
    pub fn search_traced(&self, query: &str, top_k: usize, origin: Origin) -> SkillSearchOutcome {
        let search_id = uuid::Uuid::new_v4().to_string();
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
            search_id: Some(search_id.clone()),
        });
        SkillSearchOutcome { search_id, hits }
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
