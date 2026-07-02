use std::sync::Arc;

use ratel_ai_core::{
    ChurnKind, EnvelopeStamper, JsonlSink, MemorySink, NoopSink, Origin, Skill, SkillRegistry,
    Tool, ToolRegistry, TraceEnvelope, TraceEvent, TraceSink,
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

fn sample_skill(id: &str) -> Skill {
    Skill {
        id: id.into(),
        name: id.into(),
        description: "REST API design".into(),
        tags: vec!["api".into()],
        tools: vec![],
        metadata: std::collections::HashMap::new(),
        body: "# body".into(),
    }
}

#[test]
fn shared_stamper_seq_is_monotonic_across_registries() {
    let stamper = Arc::new(EnvelopeStamper::new("sess"));
    let sink = Arc::new(MemorySink::with_stamper(stamper));
    let mut tools = ToolRegistry::with_trace_sink(sink.clone());
    let mut skills = SkillRegistry::with_trace_sink(sink.clone());

    tools.register(lookup_tool("alpha"));
    skills.register(sample_skill("api-design"));
    let _ = tools.search("lookup", 5);

    let seqs: Vec<u64> = sink
        .drain()
        .iter()
        .map(|e| e.seq.expect("stamped seq"))
        .collect();
    assert_eq!(seqs, vec![0, 1, 2]);
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
        search_id: None,
    });

    let events = sink.snapshot();
    assert_eq!(events.len(), 1);
    match &events[0].event {
        TraceEvent::InvokeStart {
            tool_id,
            args_size_bytes,
            ..
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
fn jsonl_sink_with_stamper_writes_context_and_seq() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("trace.jsonl");
    let stamper = Arc::new(EnvelopeStamper::new("session-9").with_harness("claude-code"));
    let sink = JsonlSink::with_stamper(stamper, &path).expect("open sink");
    sink.record(TraceEvent::AuthNeeds {
        upstream: "github".into(),
    });
    drop(sink);

    let body = std::fs::read_to_string(&path).unwrap();
    let line: Value = serde_json::from_str(body.lines().next().unwrap()).unwrap();
    assert_eq!(line["harness"], "claude-code");
    assert_eq!(line["seq"], 0);
}

#[test]
fn stamper_context_lands_on_envelopes_and_catalog_version_moves_mid_stream() {
    let stamper = Arc::new(
        EnvelopeStamper::new("sess")
            .with_harness("claude-code")
            .with_environment("dev")
            .with_sdk_version("0.2.0"),
    );
    let sink = MemorySink::with_stamper(stamper.clone());

    sink.record(TraceEvent::AuthNeeds {
        upstream: "a".into(),
    });
    stamper.set_catalog_version(Some("etag-1".into()));
    sink.record(TraceEvent::AuthNeeds {
        upstream: "b".into(),
    });

    let events = sink.drain();
    assert_eq!(events[0].harness.as_deref(), Some("claude-code"));
    assert_eq!(events[0].environment.as_deref(), Some("dev"));
    assert_eq!(events[0].sdk_version.as_deref(), Some("0.2.0"));
    assert!(events[0].catalog_version.is_none());
    assert_eq!(events[1].catalog_version.as_deref(), Some("etag-1"));
}

#[test]
fn bounded_memory_sink_drops_oldest_and_counts_drops() {
    let sink = MemorySink::new("sess").with_capacity(3);

    for upstream in ["a", "b", "c", "d", "e"] {
        sink.record(TraceEvent::AuthNeeds {
            upstream: upstream.into(),
        });
    }

    assert_eq!(sink.dropped_count(), 2);
    let kept: Vec<String> = sink
        .drain()
        .into_iter()
        .map(|e| match e.event {
            TraceEvent::AuthNeeds { upstream } => upstream,
            other => panic!("unexpected {other:?}"),
        })
        .collect();
    assert_eq!(kept, vec!["c", "d", "e"]);
}

#[test]
fn search_traced_returns_the_id_stamped_on_the_emitted_event() {
    let sink = Arc::new(MemorySink::new("sess"));
    let mut tools = ToolRegistry::with_trace_sink(sink.clone());
    tools.register(lookup_tool("alpha"));

    let first = tools.search_traced("lookup", 5, Origin::Agent);
    let second = tools.search_traced("lookup", 5, Origin::Agent);
    let _ = tools.search("lookup", 5);

    assert!(!first.hits.is_empty());
    assert!(!first.search_id.is_empty());
    assert_ne!(first.search_id, second.search_id);

    let ids: Vec<Option<String>> = sink
        .drain()
        .into_iter()
        .filter_map(|e| match e.event {
            TraceEvent::Search { search_id, .. } => Some(search_id),
            _ => None,
        })
        .collect();
    assert_eq!(ids[0].as_deref(), Some(first.search_id.as_str()));
    assert_eq!(ids[1].as_deref(), Some(second.search_id.as_str()));
    assert!(ids[2].is_some(), "plain search must stamp an id too");
}

#[test]
fn skill_search_traced_returns_the_id_stamped_on_the_emitted_event() {
    let sink = Arc::new(MemorySink::new("sess"));
    let mut skills = SkillRegistry::with_trace_sink(sink.clone());
    skills.register(sample_skill("api-design"));

    let outcome = skills.search_traced("REST API design", 5, Origin::Agent);

    assert!(!outcome.hits.is_empty());
    let ids: Vec<Option<String>> = sink
        .drain()
        .into_iter()
        .filter_map(|e| match e.event {
            TraceEvent::SkillSearch { search_id, .. } => Some(search_id),
            _ => None,
        })
        .collect();
    assert_eq!(ids[0].as_deref(), Some(outcome.search_id.as_str()));
}

#[test]
fn pre_0013_envelope_and_event_json_still_parse() {
    let old_envelope = r#"{"v":1,"ts":123,"session_id":"s","type":"auth_needs","upstream":"u"}"#;
    let env: TraceEnvelope = serde_json::from_str(old_envelope).expect("old envelope parses");
    assert_eq!(env.v, 1);
    assert!(env.seq.is_none());

    let old_gateway_search =
        r#"{"type":"gateway_search","query":"q","origin":"agent","top_k":5,"hits":2,"took_ms":1}"#;
    let event: TraceEvent = serde_json::from_str(old_gateway_search).expect("old event parses");
    match event {
        TraceEvent::GatewaySearch {
            hits,
            tool_hits,
            skill_hits,
            search_id,
            ..
        } => {
            assert_eq!(hits, 2);
            assert!(tool_hits.is_none());
            assert!(skill_hits.is_none());
            assert!(search_id.is_none());
        }
        other => panic!("expected GatewaySearch, got {other:?}"),
    }
}

#[test]
fn absent_optional_fields_serialize_to_absent_keys() {
    let event = TraceEvent::InvokeEnd {
        tool_id: "x".into(),
        took_ms: 7,
        search_id: None,
        result_size_bytes: None,
    };
    let value = serde_json::to_value(&event).expect("serialize");
    let object = value.as_object().unwrap();
    assert!(!object.contains_key("search_id"));
    assert!(!object.contains_key("result_size_bytes"));
}

#[test]
fn new_0013_event_fields_round_trip() {
    let originals = vec![
        TraceEvent::GatewaySearch {
            query: "q".into(),
            origin: Origin::Agent,
            top_k: 5,
            hits: 2,
            took_ms: 1,
            search_id: Some("srch-1".into()),
            tool_hits: Some(vec![ratel_ai_core::GatewayToolHitTrace {
                tool_id: "t".into(),
                score: 1.5,
                rank: 0,
            }]),
            skill_hits: Some(vec![ratel_ai_core::GatewaySkillHitTrace {
                skill_id: "s".into(),
                score: 0.5,
                rank: 0,
            }]),
        },
        TraceEvent::InvokeError {
            tool_id: "x".into(),
            took_ms: 7,
            error: "needs_auth".into(),
            search_id: Some("srch-1".into()),
            error_code: Some("needs_auth".into()),
            error_kind: Some(ratel_ai_core::ErrorKind::Transient),
        },
        TraceEvent::InvokeEnd {
            tool_id: "x".into(),
            took_ms: 7,
            search_id: Some("srch-1".into()),
            result_size_bytes: Some(1024),
        },
    ];
    for original in originals {
        let serialized = serde_json::to_string(&original).expect("serialize");
        let back: TraceEvent = serde_json::from_str(&serialized).expect("deserialize");
        assert_eq!(back, original);
    }

    let kind_json = serde_json::to_value(ratel_ai_core::ErrorKind::Permanent).unwrap();
    assert_eq!(kind_json, serde_json::json!("permanent"));
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
            search_id: None,
        },
        TraceEvent::InvokeStart {
            tool_id: "x".into(),
            args_size_bytes: 12,
            search_id: None,
        },
        TraceEvent::InvokeEnd {
            tool_id: "x".into(),
            took_ms: 7,
            search_id: None,
            result_size_bytes: None,
        },
        TraceEvent::InvokeError {
            tool_id: "x".into(),
            took_ms: 7,
            error: "boom".into(),
            search_id: None,
            error_code: None,
            error_kind: None,
        },
        TraceEvent::GatewaySearch {
            query: "q".into(),
            origin: Origin::Agent,
            top_k: 5,
            hits: 1,
            took_ms: 1,
            search_id: None,
            tool_hits: None,
            skill_hits: None,
        },
        TraceEvent::GatewayInvoke {
            tool_id: "x".into(),
            took_ms: 1,
            search_id: None,
        },
        TraceEvent::GatewayError {
            tool_id: "x".into(),
            error: "boom".into(),
            error_code: None,
            error_kind: None,
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
            error_code: None,
            error_kind: None,
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
    ];

    for original in originals {
        let serialized = serde_json::to_string(&original).expect("serialize");
        let back: TraceEvent = serde_json::from_str(&serialized).expect("deserialize");
        assert_eq!(back, original);
    }
}
