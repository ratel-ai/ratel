use std::sync::Arc;

use ratel_ai_core::{
    ChurnKind, JsonlSink, MemorySink, NoopSink, ObservationKind, ObservationStatus, Origin, Tool,
    ToolRegistry, TraceEnvelope, TraceEvent, TraceSink,
};
use serde_json::{Value, json};
use tempfile::tempdir;

fn empty_schema() -> Value {
    json!({})
}

fn lookup_tool(id: &str) -> Tool {
    Tool {
        id: id.into(),
        name: id.into(),
        description: "lookup".into(),
        input_schema: empty_schema(),
        output_schema: empty_schema(),
    }
}

#[test]
fn default_registry_uses_noop_sink_and_does_not_panic() {
    let mut registry = ToolRegistry::new();
    registry.register(lookup_tool("t"));
    let _ = registry.search("lookup", 5);
}

#[test]
fn register_emits_index_churn_add() {
    let sink = Arc::new(MemorySink::new("session-1"));
    let mut registry = ToolRegistry::with_trace_sink(sink.clone());
    registry.register(lookup_tool("alpha"));

    let events = sink.snapshot();
    assert_eq!(events.len(), 1);
    let env: &TraceEnvelope = &events[0];
    assert_eq!(env.session_id, "session-1");
    assert_eq!(env.v, 1);
    assert!(env.ts > 0);
    match &env.event {
        TraceEvent::IndexChurn { kind, tool_id } => {
            assert_eq!(*kind, ChurnKind::Add);
            assert_eq!(tool_id, "alpha");
        }
        other => panic!("expected IndexChurn, got {other:?}"),
    }
}

#[test]
fn search_emits_search_event_with_bm25_stage_and_hits() {
    let sink = Arc::new(MemorySink::new("session-2"));
    let mut registry = ToolRegistry::with_trace_sink(sink.clone());
    registry.register(lookup_tool("alpha"));

    let hits = registry.search("lookup", 5);
    assert!(!hits.is_empty());

    let events = sink.snapshot();
    let search_event = events
        .iter()
        .find(|e| matches!(e.event, TraceEvent::Search { .. }))
        .expect("expected a search event");

    match &search_event.event {
        TraceEvent::Search {
            query,
            origin,
            top_k,
            hits,
            stages,
            ..
        } => {
            assert_eq!(query, "lookup");
            assert_eq!(*origin, Origin::Direct);
            assert_eq!(*top_k, 5);
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].tool_id, "alpha");
            assert!(hits[0].score > 0.0);
            assert_eq!(stages.len(), 1);
            assert_eq!(stages[0].name, "bm25");
            assert_eq!(stages[0].top_score, Some(hits[0].score));
        }
        _ => unreachable!(),
    }
}

#[test]
fn search_with_origin_propagates_origin() {
    let sink = Arc::new(MemorySink::new("session-3"));
    let mut registry = ToolRegistry::with_trace_sink(sink.clone());
    registry.register(lookup_tool("alpha"));

    let _ = registry.search_with_origin("lookup", 3, Origin::Agent);

    let events = sink.snapshot();
    let search_event = events
        .iter()
        .find(|e| matches!(e.event, TraceEvent::Search { .. }))
        .expect("expected a search event");
    if let TraceEvent::Search { origin, .. } = &search_event.event {
        assert_eq!(*origin, Origin::Agent);
    }
}

#[test]
fn empty_registry_search_still_emits_event() {
    let sink = Arc::new(MemorySink::new("session-4"));
    let registry = ToolRegistry::with_trace_sink(sink.clone());

    let _ = registry.search("anything", 5);

    let events = sink.snapshot();
    assert_eq!(events.len(), 1);
    match &events[0].event {
        TraceEvent::Search { hits, stages, .. } => {
            assert!(hits.is_empty());
            assert_eq!(stages.len(), 1);
            assert_eq!(stages[0].name, "bm25");
            assert!(stages[0].top_score.is_none());
        }
        _ => panic!("expected Search event"),
    }
}

#[test]
fn record_event_passes_through_sink() {
    let sink = Arc::new(MemorySink::new("session-5"));
    let registry = ToolRegistry::with_trace_sink(sink.clone());

    registry.record_event(TraceEvent::InvokeStart {
        tool_id: "x".into(),
        args_size_bytes: 42,
    });

    let events = sink.snapshot();
    assert_eq!(events.len(), 1);
    match &events[0].event {
        TraceEvent::InvokeStart {
            tool_id,
            args_size_bytes,
        } => {
            assert_eq!(tool_id, "x");
            assert_eq!(*args_size_bytes, 42);
        }
        _ => panic!("expected InvokeStart"),
    }
}

#[test]
fn set_trace_sink_swaps_sink() {
    let mut registry = ToolRegistry::new();
    let sink = Arc::new(MemorySink::new("session-6"));
    registry.set_trace_sink(sink.clone());

    registry.record_event(TraceEvent::AuthNeeds {
        upstream: "github".into(),
    });

    assert_eq!(sink.snapshot().len(), 1);
}

#[test]
fn noop_sink_drops_everything() {
    let sink = Arc::new(NoopSink);
    let registry = ToolRegistry::with_trace_sink(sink);
    registry.record_event(TraceEvent::AuthRefresh {
        upstream: "x".into(),
        ok: true,
    });
    // Test that nothing panics; NoopSink has no observable side effect.
}

#[test]
fn jsonl_sink_writes_one_line_per_event() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("trace.jsonl");
    let sink = Arc::new(JsonlSink::new("session-7", &path).expect("open sink"));
    sink.record(TraceEvent::AuthNeeds {
        upstream: "github".into(),
    });
    sink.record(TraceEvent::AuthRefresh {
        upstream: "github".into(),
        ok: true,
    });
    drop(sink);

    let body = std::fs::read_to_string(&path).unwrap();
    let lines: Vec<&str> = body.lines().collect();
    assert_eq!(lines.len(), 2);

    let first: Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(first["v"], 1);
    assert_eq!(first["session_id"], "session-7");
    assert_eq!(first["type"], "auth_needs");
    assert_eq!(first["upstream"], "github");
    assert!(first["ts"].as_u64().unwrap() > 0);

    let second: Value = serde_json::from_str(lines[1]).unwrap();
    assert_eq!(second["type"], "auth_refresh");
    assert_eq!(second["ok"], true);
}

#[test]
fn jsonl_sink_creates_parent_directory() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("nested").join("subdir").join("trace.jsonl");
    let sink = JsonlSink::new("session-8", &path).expect("open sink in nested dir");
    sink.record(TraceEvent::AuthFlowStart {
        upstream: "x".into(),
    });
    drop(sink);
    assert!(path.exists());
}

#[test]
fn trace_event_round_trips_through_json() {
    let originals = vec![
        TraceEvent::Search {
            query: "q".into(),
            origin: Origin::Agent,
            top_k: 5,
            hits: vec![ratel_ai_core::SearchHitTrace {
                tool_id: "t".into(),
                score: 1.5,
            }],
            stages: vec![ratel_ai_core::SearchStage {
                name: "bm25".into(),
                took_ms: 1,
                top_score: Some(1.5),
            }],
            took_ms: 1,
        },
        TraceEvent::InvokeStart {
            tool_id: "x".into(),
            args_size_bytes: 12,
        },
        TraceEvent::InvokeEnd {
            tool_id: "x".into(),
            took_ms: 7,
        },
        TraceEvent::InvokeError {
            tool_id: "x".into(),
            took_ms: 7,
            error: "boom".into(),
        },
        TraceEvent::GatewaySearch {
            query: "q".into(),
            origin: Origin::Agent,
            top_k: 5,
            hits: 1,
            took_ms: 1,
        },
        TraceEvent::GatewayInvoke {
            tool_id: "x".into(),
            took_ms: 1,
        },
        TraceEvent::GatewayError {
            tool_id: "x".into(),
            error: "boom".into(),
        },
        TraceEvent::UpstreamRegister {
            server: "s".into(),
            transport: "stdio".into(),
            tool_count: 3,
        },
        TraceEvent::UpstreamInvoke {
            server: "s".into(),
            tool_id: "s.t".into(),
            took_ms: 1,
        },
        TraceEvent::UpstreamError {
            server: "s".into(),
            tool_id: "s.t".into(),
            error: "boom".into(),
        },
        TraceEvent::AuthRefresh {
            upstream: "u".into(),
            ok: false,
        },
        TraceEvent::AuthNeeds {
            upstream: "u".into(),
        },
        TraceEvent::AuthFlowStart {
            upstream: "u".into(),
        },
        TraceEvent::AuthFlowEnd {
            upstream: "u".into(),
            ok: true,
        },
        TraceEvent::IndexChurn {
            kind: ChurnKind::Add,
            tool_id: "t".into(),
        },
        TraceEvent::TraceRoot {
            trace_id: "trc".into(),
            name: "handle_ticket".into(),
            tags: vec!["prod".into()],
            version: Some("1.4.0".into()),
        },
        TraceEvent::ObservationStart {
            trace_id: "trc".into(),
            observation_id: "obs".into(),
            parent_observation_id: None,
            name: "retrieval".into(),
            kind: ObservationKind::Span,
        },
        TraceEvent::ObservationEnd {
            trace_id: "trc".into(),
            observation_id: "obs".into(),
            took_ms: 12,
            status: ObservationStatus::Ok,
            error: None,
        },
        TraceEvent::Generation {
            trace_id: "trc".into(),
            observation_id: "obs".into(),
            parent_observation_id: Some("root".into()),
            provider: "openai".into(),
            model: "gpt-4o".into(),
            input_tokens: Some(812),
            output_tokens: Some(96),
            total_tokens: Some(908),
        },
        TraceEvent::TokensSaved {
            trace_id: "trc".into(),
            full_catalog_tokens: 4200,
            selected_tokens: 380,
            top_k: 5,
        },
    ];

    for original in originals {
        let serialized = serde_json::to_string(&original).expect("serialize");
        let back: TraceEvent = serde_json::from_str(&serialized).expect("deserialize");
        assert_eq!(back, original);
    }
}

/// The Python observability layer (ADR-0012) emits these events via the PyO3
/// `record_event(dict)` path, which deserializes into `TraceEvent`. This test
/// locks the wire shape — `type` tags and field names — that the SDK depends on.
#[test]
fn observability_events_have_stable_wire_shape() {
    let trace_root = serde_json::to_value(TraceEvent::TraceRoot {
        trace_id: "trc".into(),
        name: "root".into(),
        tags: vec!["prod".into()],
        version: None,
    })
    .unwrap();
    assert_eq!(trace_root["type"], "trace_root");
    assert_eq!(trace_root["trace_id"], "trc");
    assert_eq!(trace_root["tags"][0], "prod");
    assert!(trace_root["version"].is_null());
    // user_id must NOT appear in the core event (PII stays in the cloud stream).
    assert!(trace_root.get("user_id").is_none());

    let start = serde_json::to_value(TraceEvent::ObservationStart {
        trace_id: "trc".into(),
        observation_id: "obs".into(),
        parent_observation_id: Some("parent".into()),
        name: "llm".into(),
        kind: ObservationKind::Generation,
    })
    .unwrap();
    assert_eq!(start["type"], "observation_start");
    assert_eq!(start["kind"], "generation");
    assert_eq!(start["parent_observation_id"], "parent");

    let end = serde_json::to_value(TraceEvent::ObservationEnd {
        trace_id: "trc".into(),
        observation_id: "obs".into(),
        took_ms: 3,
        status: ObservationStatus::Error,
        error: Some("boom".into()),
    })
    .unwrap();
    assert_eq!(end["type"], "observation_end");
    assert_eq!(end["status"], "error");
    assert_eq!(end["error"], "boom");

    let generation = serde_json::to_value(TraceEvent::Generation {
        trace_id: "trc".into(),
        observation_id: "obs".into(),
        parent_observation_id: None,
        provider: "anthropic".into(),
        model: "claude-opus-4-8".into(),
        input_tokens: Some(10),
        output_tokens: Some(20),
        total_tokens: Some(30),
    })
    .unwrap();
    assert_eq!(generation["type"], "generation");
    assert_eq!(generation["provider"], "anthropic");
    assert_eq!(generation["input_tokens"], 10);
    assert_eq!(generation["output_tokens"], 20);
    assert_eq!(generation["total_tokens"], 30);

    let saved = serde_json::to_value(TraceEvent::TokensSaved {
        trace_id: "trc".into(),
        full_catalog_tokens: 4200,
        selected_tokens: 380,
        top_k: 5,
    })
    .unwrap();
    assert_eq!(saved["type"], "tokens_saved");
    assert_eq!(saved["full_catalog_tokens"], 4200);
    assert_eq!(saved["selected_tokens"], 380);
    assert_eq!(saved["top_k"], 5);
}

/// The new variants must survive the same path the Python SDK uses:
/// dict → `serde_json::Value` → `TraceEvent` → sink.
#[test]
fn observability_events_record_through_sink() {
    let sink = Arc::new(MemorySink::new("session-obs"));
    let registry = ToolRegistry::with_trace_sink(sink.clone());

    // Simulate the deserialize step the PyO3 binding performs on a Python dict.
    let value = json!({
        "type": "generation",
        "trace_id": "trc",
        "observation_id": "obs",
        "parent_observation_id": null,
        "provider": "openai",
        "model": "gpt-4o",
        "input_tokens": 100,
        "output_tokens": 50,
        "total_tokens": 150
    });
    let event: TraceEvent = serde_json::from_value(value).expect("deserialize generation");
    registry.record_event(event);

    let events = sink.snapshot();
    assert_eq!(events.len(), 1);
    match &events[0].event {
        TraceEvent::Generation {
            provider,
            model,
            total_tokens,
            ..
        } => {
            assert_eq!(provider, "openai");
            assert_eq!(model, "gpt-4o");
            assert_eq!(*total_tokens, Some(150));
        }
        other => panic!("expected Generation, got {other:?}"),
    }
}
