//! Replay is only worth having if it reconstructs what the live learner would
//! have grown. That equivalence is the first test here; the rest cover the ways
//! a real trace directory is messier than a fixture.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use ratel_ai_core::{IntentGraph, NoopSink, Origin, TraceEnvelope, TraceEvent, UsageLearner};
use ratel_ai_graph::{DEFAULT_HALF_LIFE_DAYS, render, replay_dir, replay_envelopes};

const T0: u64 = 1_753_000_000_000;

fn envelope(session: &str, ts: u64, event: TraceEvent) -> TraceEnvelope {
    TraceEnvelope {
        v: 1,
        ts,
        session_id: session.into(),
        event,
    }
}

fn search(query: &str) -> TraceEvent {
    TraceEvent::Search {
        query: query.into(),
        origin: Origin::Agent,
        top_k: 5,
        hits: Vec::new(),
        stages: Vec::new(),
        took_ms: 0,
    }
}

fn invoke(tool_id: &str) -> TraceEvent {
    TraceEvent::InvokeStart {
        tool_id: tool_id.into(),
        args_size_bytes: 0,
    }
}

/// A single session: three build questions, each answered with `gh_run_list`.
fn one_session() -> Vec<TraceEnvelope> {
    vec![
        envelope("s1", T0, search("why is the build broken")),
        envelope("s1", T0 + 1, invoke("gh_run_list")),
        envelope("s1", T0 + 2, search("is the build broken again")),
        envelope("s1", T0 + 3, invoke("gh_run_list")),
        envelope("s1", T0 + 4, search("the build broken on main")),
        envelope("s1", T0 + 5, invoke("gh_run_list")),
    ]
}

// ---- the equivalence that justifies replay existing --------------------------

#[test]
fn replay_reproduces_what_the_live_learner_grew() {
    let envelopes = one_session();

    // Live path: the same events through UsageLearner::replay, which is what the
    // sink does with a wall-clock stamp instead of the envelope's.
    let live_graph = Arc::new(RwLock::new(IntentGraph::empty(DEFAULT_HALF_LIFE_DAYS)));
    let learner = UsageLearner::new(live_graph.clone(), Arc::new(NoopSink));
    for e in &envelopes {
        learner.replay(e);
    }
    let live = live_graph.read().unwrap().clone();

    let replayed = replay_envelopes(&envelopes, DEFAULT_HALF_LIFE_DAYS);
    assert_eq!(live, replayed);
}

#[test]
fn replay_is_independent_of_input_order() {
    // A trace directory is many files; the order they are read must not change
    // the graph. Sessions are grouped and sorted by timestamp before pairing.
    let forward = one_session();
    let mut reversed = forward.clone();
    reversed.reverse();

    assert_eq!(
        replay_envelopes(&forward, DEFAULT_HALF_LIFE_DAYS),
        replay_envelopes(&reversed, DEFAULT_HALF_LIFE_DAYS)
    );
}

#[test]
fn sessions_are_paired_separately() {
    // Interleaved sessions: s1 searched about builds, s2 invoked a secret tool.
    // Pairing across them would credit `vault_rotate` to the build cluster —
    // an edge nobody produced.
    let envelopes = vec![
        envelope("s1", T0, search("why is the build broken")),
        envelope("s2", T0 + 1, invoke("vault_rotate")),
        envelope("s1", T0 + 2, invoke("gh_run_list")),
    ];
    let graph = replay_envelopes(&envelopes, DEFAULT_HALF_LIFE_DAYS);

    assert_eq!(graph.len(), 1);
    assert_eq!(
        graph.intents[0].tools.keys().collect::<Vec<_>>(),
        vec!["gh_run_list"],
        "s2's invoke must not attach to s1's query"
    );
}

// ---- a real directory is messier --------------------------------------------

fn write_log(dir: &PathBuf, name: &str, envelopes: &[TraceEnvelope]) {
    fs::create_dir_all(dir).unwrap();
    let body: String = envelopes
        .iter()
        .map(|e| serde_json::to_string(e).unwrap() + "\n")
        .collect();
    fs::write(dir.join(name), body).unwrap();
}

fn tmpdir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ratel-graph-test-{name}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn replays_jsonl_across_nested_project_directories() {
    // JsonlSink buckets per project slug, so the tree is nested by design.
    let root = tmpdir("nested");
    write_log(&root.join("proj-a"), "session.jsonl", &one_session());
    write_log(
        &root.join("proj-b"),
        "session.jsonl",
        &[
            envelope("s2", T0, search("rotate the signing key")),
            envelope("s2", T0 + 1, invoke("vault_rotate")),
        ],
    );

    let (graph, stats) = replay_dir(&root).unwrap();
    assert_eq!(stats.files, 2);
    assert_eq!(stats.sessions, 2);
    assert_eq!(graph.len(), 2);
}

#[test]
fn a_truncated_final_line_is_skipped_not_fatal() {
    // The log is appended to live, so the last line may be half-written. Losing
    // the whole history to one bad line would be the wrong trade.
    let root = tmpdir("truncated");
    write_log(&root, "session.jsonl", &one_session());
    let mut body = fs::read_to_string(root.join("session.jsonl")).unwrap();
    body.push_str("{\"v\":1,\"ts\":123,\"session_id\":\"s1\",\"ty");
    fs::write(root.join("session.jsonl"), body).unwrap();

    let (graph, stats) = replay_dir(&root).unwrap();
    assert_eq!(stats.skipped_lines, 1);
    assert_eq!(graph.len(), 1, "the intact history still replayed");
}

#[test]
fn a_missing_telemetry_directory_yields_an_empty_graph() {
    // Not an error: it means nothing has been recorded yet.
    let (graph, stats) =
        replay_dir(std::env::temp_dir().join("ratel-graph-does-not-exist")).unwrap();
    assert!(graph.is_empty());
    assert_eq!(stats.files, 0);
}

#[test]
fn non_jsonl_files_are_ignored() {
    let root = tmpdir("mixed");
    write_log(&root, "session.jsonl", &one_session());
    fs::write(root.join("notes.txt"), "not telemetry").unwrap();

    let (_, stats) = replay_dir(&root).unwrap();
    assert_eq!(stats.files, 1);
}

// ---- inspection --------------------------------------------------------------

#[test]
fn render_shows_the_label_evidence_and_edges() {
    let graph = replay_envelopes(&one_session(), DEFAULT_HALF_LIFE_DAYS);
    let out = render(&graph);
    assert!(out.contains("3 observations"), "got: {out}");
    assert!(out.contains("gh_run_list"), "got: {out}");
    assert!(out.contains("build"), "got: {out}");
}

#[test]
fn render_distinguishes_an_empty_graph_from_a_broken_one() {
    let out = render(&IntentGraph::empty(DEFAULT_HALF_LIFE_DAYS));
    assert!(
        out.contains("nothing has been searched and then invoked"),
        "got: {out}"
    );
}

#[test]
fn a_replayed_graph_is_valid_protocol_v1_json() {
    // `build` prints this; the schema in protocol/v1 is what consumers validate
    // against, so a replay must not emit something only this crate can read.
    let graph = replay_envelopes(&one_session(), DEFAULT_HALF_LIFE_DAYS);
    let json = serde_json::to_string(&graph).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed["v"], 1);
    assert!(parsed["half_life_days"].is_number());
    assert!(parsed["built_from_ts"].is_number());
    let intent = &parsed["intents"][0];
    for field in [
        "id", "label", "terms", "members", "support", "tools", "skills",
    ] {
        assert!(!intent[field].is_null(), "missing required field {field}");
    }
    assert!(
        intent.get("centroid").is_none(),
        "a lexically replayed graph carries no centroid"
    );
    assert_eq!(
        IntentGraph::from_json(&json).unwrap(),
        graph,
        "round-trips through the wire form"
    );
}
