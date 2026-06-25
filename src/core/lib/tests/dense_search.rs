//! Dense (semantic) retrieval over the registries. In this version `.search()`
//! IS dense (ADR-0013), so these assert the semantic behaviour directly.

use std::sync::Arc;

use ratel_ai_core::{MemorySink, Skill, SkillRegistry, Tool, ToolRegistry, TraceEvent};
use serde_json::json;

// ---- Tools ----

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
    r.register(tool("delete_path", "erase a directory entry permanently"));
    r.register(tool(
        "weather",
        "get the current weather forecast for a city",
    ));
    r.register(tool("send_email", "compose and send an email message"));
    r
}

#[test]
fn search_surfaces_a_synonym_match() {
    // "remove a file" shares no content words with "erase a directory entry" —
    // the lexical "missing gold" case dense closes.
    let hits = catalog().search("remove a file", 3);
    assert_eq!(
        hits.first().map(|h| h.tool_id.as_str()),
        Some("delete_path")
    );
}

#[test]
fn search_respects_top_k() {
    assert!(catalog().search("anything", 2).len() <= 2);
}

#[test]
fn empty_registry_returns_no_hits() {
    assert!(ToolRegistry::new().search("anything", 5).is_empty());
}

#[test]
fn search_emits_a_dense_trace_stage() {
    let sink = Arc::new(MemorySink::new("test-session"));
    let mut registry = ToolRegistry::with_trace_sink(sink.clone());
    registry.register(tool("delete_path", "delete a path"));
    let _ = registry.search("remove a file", 1);
    let saw_dense = sink.snapshot().into_iter().any(|env| match env.event {
        TraceEvent::Search { stages, .. } => stages.iter().any(|s| s.name == "dense"),
        _ => false,
    });
    assert!(saw_dense, "expected a Search event with a dense stage");
}

// ---- Skills ----

fn skill(id: &str, description: &str) -> Skill {
    Skill {
        id: id.into(),
        name: id.into(),
        description: description.into(),
        tags: vec![],
        tools: vec![],
        metadata: std::collections::HashMap::new(),
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
    let hits = skill_catalog().search("remove a file", 3);
    assert_eq!(
        hits.first().map(|h| h.skill_id.as_str()),
        Some("delete_path")
    );
}

#[test]
fn skill_search_emits_a_dense_trace_stage() {
    let sink = Arc::new(MemorySink::new("test-session"));
    let mut registry = SkillRegistry::with_trace_sink(sink.clone());
    registry.register(skill("delete_path", "delete a path"));
    let _ = registry.search("remove a file", 1);
    let saw_dense = sink.snapshot().into_iter().any(|env| match env.event {
        TraceEvent::SkillSearch { stages, .. } => stages.iter().any(|s| s.name == "dense"),
        _ => false,
    });
    assert!(saw_dense, "expected a SkillSearch event with a dense stage");
}
