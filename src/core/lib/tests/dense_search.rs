//! Dense retrieval over `ToolRegistry`. Only built with the `dense-search`
//! feature; a no-op otherwise.
#![cfg(feature = "dense-search")]

use std::sync::Arc;

use ratel_ai_core::{MemorySink, Skill, SkillRegistry, Tool, ToolRegistry, TraceEvent};
use serde_json::json;

fn tool(id: &str, name: &str, description: &str) -> Tool {
    Tool {
        id: id.into(),
        name: name.into(),
        description: description.into(),
        input_schema: json!({}),
        output_schema: json!({}),
    }
}

fn catalog() -> ToolRegistry {
    let mut r = ToolRegistry::new();
    r.register(tool(
        "delete_file",
        "delete_file",
        "delete a path from the filesystem",
    ));
    r.register(tool(
        "weather",
        "weather",
        "get the current weather forecast for a city",
    ));
    r.register(tool(
        "send_email",
        "send_email",
        "compose and send an email message",
    ));
    r
}

#[test]
fn dense_search_surfaces_a_synonym_match_bm25_would_miss() {
    let registry = catalog();
    // "remove a file" shares no content words with "delete a path…" — the
    // "missing gold" case. Dense should still rank delete_file first.
    let hits = registry.search_dense("remove a file", 3);
    assert_eq!(
        hits.first().map(|h| h.tool_id.as_str()),
        Some("delete_file")
    );
}

#[test]
fn registering_for_dense_leaves_bm25_search_intact() {
    let registry = catalog();
    // The lexical path is unchanged: a literal term still ranks its tool first.
    let hits = registry.search("weather forecast", 3);
    assert_eq!(hits.first().map(|h| h.tool_id.as_str()), Some("weather"));
}

#[test]
fn dense_search_emits_a_dense_trace_stage() {
    let sink = Arc::new(MemorySink::new("test-session"));
    let mut registry = ToolRegistry::with_trace_sink(sink.clone());
    registry.register(tool("delete_file", "delete_file", "delete a path"));
    let _ = registry.search_dense("remove a file", 1);
    // The emitted Search event must carry a stage named "dense" (not "bm25"),
    // so telemetry can tell the retrieval paths apart.
    let saw_dense = sink.snapshot().into_iter().any(|env| match env.event {
        TraceEvent::Search { stages, .. } => stages.iter().any(|s| s.name == "dense"),
        _ => false,
    });
    assert!(saw_dense, "expected a Search event with a dense stage");
}

// ---- Skills (SR-Agents-style skill retrieval) ----

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
fn skill_dense_search_surfaces_a_synonym_match() {
    let registry = skill_catalog();
    let hits = registry.search_dense("remove a file", 3);
    assert_eq!(
        hits.first().map(|h| h.skill_id.as_str()),
        Some("delete_path")
    );
}

#[test]
fn skill_registering_for_dense_leaves_bm25_search_intact() {
    let registry = skill_catalog();
    let hits = registry.search("weather forecast", 3);
    assert_eq!(hits.first().map(|h| h.skill_id.as_str()), Some("weather"));
}

#[test]
fn skill_dense_search_emits_a_dense_trace_stage() {
    let sink = Arc::new(MemorySink::new("test-session"));
    let mut registry = SkillRegistry::with_trace_sink(sink.clone());
    registry.register(skill("delete_path", "delete a path"));
    let _ = registry.search_dense("remove a file", 1);
    let saw_dense = sink.snapshot().into_iter().any(|env| match env.event {
        TraceEvent::SkillSearch { stages, .. } => stages.iter().any(|s| s.name == "dense"),
        _ => false,
    });
    assert!(saw_dense, "expected a SkillSearch event with a dense stage");
}
