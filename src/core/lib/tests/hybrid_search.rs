//! End-to-end behavior of the public hybrid `search()` (ADR-0013/ADR-0014): BM25
//! and dense fused with RRF. These exercise the engine through the *unchanged*
//! public API, so they double as the proof that callers upgrading from the
//! BM25-only releases get hybrid transparently.
//!
//! First run downloads the bge-small model into the shared HuggingFace cache
//! (network required once, then offline).

use std::collections::HashMap;
use std::sync::Arc;

use ratel_ai_core::{MemorySink, Skill, SkillRegistry, Tool, ToolRegistry, TraceEvent};
use serde_json::json;

fn tool(id: &str, description: &str) -> Tool {
    Tool {
        id: id.into(),
        name: id.into(),
        description: description.into(),
        input_schema: json!({}),
        output_schema: json!({}),
    }
}

fn catalog() -> ToolRegistry {
    let mut r = ToolRegistry::new();
    r.register(tool("delete_file", "delete a path from the filesystem"));
    r.register(tool(
        "weather",
        "get the current weather forecast for a city",
    ));
    r.register(tool("send_email", "compose and send an email message"));
    r
}

#[test]
fn surfaces_a_synonym_match_pure_bm25_would_miss() {
    let registry = catalog();
    // "remove a file" shares no content words with "delete a path…" — the
    // "missing gold" case BM25 alone fails. Hybrid (dense + rerank) must still
    // rank delete_file first, through the public `search()`.
    let hits = registry.search("remove a file", 3);
    assert_eq!(
        hits.first().map(|h| h.tool_id.as_str()),
        Some("delete_file")
    );
}

#[test]
fn search_emits_the_three_hybrid_stages_in_order() {
    let sink = Arc::new(MemorySink::new("hybrid-stages"));
    let mut registry = ToolRegistry::with_trace_sink(sink.clone());
    registry.register(tool("delete_file", "delete a path from the filesystem"));

    let _ = registry.search("remove a file", 1);

    let stages = sink
        .snapshot()
        .into_iter()
        .find_map(|env| match env.event {
            TraceEvent::Search { stages, .. } => Some(stages),
            _ => None,
        })
        .expect("expected a Search event");
    let names: Vec<String> = stages.into_iter().map(|s| s.name).collect();
    assert_eq!(names, ["bm25", "dense", "rrf"]);
}

#[test]
fn search_is_deterministic() {
    let registry = catalog();
    let first = registry.search("remove a file", 3);
    let second = registry.search("remove a file", 3);
    let ids =
        |hs: &[ratel_ai_core::SearchHit]| hs.iter().map(|h| h.tool_id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&first), ids(&second), "hit order must be stable");
    for (a, b) in first.iter().zip(second.iter()) {
        assert_eq!(a.score, b.score, "scores must be bit-stable across calls");
    }
}

#[test]
fn empty_registry_returns_no_hits() {
    let registry = ToolRegistry::new();
    assert!(registry.search("anything", 5).is_empty());
}

#[test]
fn search_respects_top_k_bound() {
    let registry = catalog();
    let hits = registry.search("file", 2);
    assert!(
        hits.len() <= 2,
        "expected at most 2 hits, got {}",
        hits.len()
    );
}

#[test]
fn re_registering_same_id_replaces_text_on_every_arm() {
    let mut registry = ToolRegistry::new();
    registry.register(tool("doc", "get the current weather forecast"));
    // Re-register the same id with unrelated text; last-wins must propagate to
    // the dense embedding and the rerank candidate text, not just BM25.
    registry.register(tool("doc", "delete a path from the filesystem"));
    registry.register(tool("decoy", "get the current weather forecast"));

    // The id is deduped to a single entry.
    let hits = registry.search("delete a file", 5);
    assert_eq!(hits.iter().filter(|h| h.tool_id == "doc").count(), 1);
    // The *new* description drives ranking: a delete query now ranks doc first.
    assert_eq!(hits.first().map(|h| h.tool_id.as_str()), Some("doc"));
}

// ---- Skills (parallel SkillRegistry path) ----

fn skill(id: &str, description: &str) -> Skill {
    Skill {
        id: id.into(),
        name: id.into(),
        description: description.into(),
        tags: vec![],
        tools: vec![],
        metadata: HashMap::new(),
        body: String::new(),
    }
}

fn skill_catalog() -> SkillRegistry {
    let mut r = SkillRegistry::new();
    r.register(skill("delete_path", "erase a directory entry permanently"));
    r.register(skill(
        "weather",
        "get the current weather forecast for a city",
    ));
    r.register(skill("send_email", "compose and send an email message"));
    r
}

#[test]
fn skill_search_surfaces_a_synonym_match() {
    let registry = skill_catalog();
    let hits = registry.search("remove a file", 3);
    assert_eq!(
        hits.first().map(|h| h.skill_id.as_str()),
        Some("delete_path")
    );
}

#[test]
fn skill_search_emits_the_three_hybrid_stages() {
    let sink = Arc::new(MemorySink::new("hybrid-skill-stages"));
    let mut registry = SkillRegistry::with_trace_sink(sink.clone());
    registry.register(skill("delete_path", "erase a directory entry permanently"));

    let _ = registry.search("remove a file", 1);

    let stages = sink
        .snapshot()
        .into_iter()
        .find_map(|env| match env.event {
            TraceEvent::SkillSearch { stages, .. } => Some(stages),
            _ => None,
        })
        .expect("expected a SkillSearch event");
    let names: Vec<String> = stages.into_iter().map(|s| s.name).collect();
    assert_eq!(names, ["bm25", "dense", "rrf"]);
}

#[test]
fn skill_search_on_empty_registry_returns_no_hits() {
    let registry = SkillRegistry::new();
    assert!(registry.search("anything", 5).is_empty());
}
