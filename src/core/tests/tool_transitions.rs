//! Tool transitions end to end through the public API (ADR-0028), measured on a
//! held-out split of multi-step turns.
//!
//! Two numbers matter. **Next-tool recall@3**: once a turn has invoked a tool,
//! is the tool it invokes next among the three predicted after it? Compared
//! against predicting the three most-invoked tools. **Searches**: a turn costs
//! one search per tool without hints; with them, the first search also returns
//! the strong chain, so every tool the chain gets right in order needs no search
//! of its own.
//!
//! ```text
//! cargo test -p ratel-ai-core --test tool_transitions -- --nocapture
//! ```

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use ratel_ai_core::{
    IntentGraph, NoopSink, Origin, SearchMethod, Tool, ToolRegistry, TraceEvent, TraceEventContext,
    TrailTracker, UsageLearner,
};
use serde::Deserialize;
use serde_json::json;

const SEQUENCES: &str = include_str!("fixtures/sequences.json");

#[derive(Deserialize)]
struct Fixture {
    turns: Vec<Turn>,
}

#[derive(Deserialize)]
struct Turn {
    turn: String,
    query: String,
    tools: Vec<String>,
}

fn turns() -> (Vec<Turn>, Vec<Turn>) {
    let fixture: Fixture = serde_json::from_str(SEQUENCES).unwrap();
    let (mut train, mut held) = (Vec::new(), Vec::new());
    for (i, t) in fixture.turns.into_iter().enumerate() {
        if i % 5 == 4 {
            held.push(t)
        } else {
            train.push(t)
        }
    }
    (train, held)
}

fn in_turn(turn: &str) -> TraceEventContext {
    TraceEventContext {
        turn_id: Some(turn.into()),
        ..TraceEventContext::default()
    }
}

fn registry(
    turns: &[Turn],
    sink: impl FnOnce(Arc<RwLock<IntentGraph>>) -> Arc<dyn ratel_ai_core::TraceSink>,
    graph: Arc<RwLock<IntentGraph>>,
) -> ToolRegistry {
    let mut reg = ToolRegistry::new();
    let mut ids: Vec<&str> = turns
        .iter()
        .flat_map(|t| t.tools.iter().map(String::as_str))
        .collect();
    ids.sort_unstable();
    ids.dedup();
    for id in ids {
        reg.register(Tool {
            id: id.into(),
            name: id.into(),
            description: id.replace('_', " "),
            experimental_searchable_description: None,
            input_schema: json!({}),
            output_schema: json!({}),
        });
    }
    reg.set_trace_sink(sink(graph.clone()));
    reg.set_intent_graph(Some(graph));
    reg
}

fn search(reg: &ToolRegistry, turn: &Turn) {
    reg.search_with_method_and_context(
        &turn.query,
        5,
        Origin::Agent,
        SearchMethod::Bm25,
        in_turn(&turn.turn),
    )
    .unwrap();
}

fn invoke(reg: &ToolRegistry, turn: &Turn, tool: &str) {
    reg.record_event_with_context(
        TraceEvent::InvokeStart {
            tool_id: tool.into(),
            args_size_bytes: 0,
        },
        in_turn(&turn.turn),
    );
}

struct Report {
    recall: f32,
    popularity_recall: f32,
    searches_without: usize,
    searches_with: usize,
}

fn measure() -> Report {
    let (train, held) = turns();
    let graph = Arc::new(RwLock::new(IntentGraph::empty()));
    let learner = registry(
        &train,
        |g| Arc::new(UsageLearner::new(g, Arc::new(NoopSink))),
        graph.clone(),
    );
    for turn in &train {
        search(&learner, turn);
        for tool in &turn.tools {
            invoke(&learner, turn, tool);
        }
    }

    let mut counts: HashMap<&str, usize> = HashMap::new();
    for tool in train.iter().flat_map(|t| &t.tools) {
        *counts.entry(tool).or_default() += 1;
    }
    let mut popular: Vec<_> = counts.into_iter().collect();
    popular.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    let popular: Vec<&str> = popular.into_iter().take(3).map(|(id, _)| id).collect();

    // Held-out turns run against the learned graph without learning into it.
    let eval = registry(
        &train,
        |g| Arc::new(TrailTracker::new(g, Arc::new(NoopSink))),
        graph,
    );
    let (mut hits, mut popular_hits, mut steps) = (0, 0, 0);
    let (mut searches_without, mut searches_with) = (0, 0);
    for turn in &held {
        search(&eval, turn);
        let first =
            eval.experimental_predict_next(Some(&turn.turn), Some(&turn.query), &[], 3, false);
        let covered = first
            .chain
            .iter()
            .zip(&turn.tools)
            .take_while(|(c, tool)| &c.tool.id == *tool)
            .count();
        searches_without += turn.tools.len();
        searches_with += 1 + turn.tools.len() - covered.max(1);

        for pair in turn.tools.windows(2) {
            invoke(&eval, turn, &pair[0]);
            let p = eval.experimental_predict_next(Some(&turn.turn), None, &[&pair[0]], 3, false);
            let next: Vec<&str> = p
                .after
                .first()
                .map(|(_, n)| n.iter().map(|t| t.id.as_str()).collect())
                .unwrap_or_default();
            steps += 1;
            hits += usize::from(next.contains(&pair[1].as_str()));
            popular_hits += usize::from(popular.contains(&pair[1].as_str()));
        }
    }
    Report {
        recall: hits as f32 / steps as f32,
        popularity_recall: popular_hits as f32 / steps as f32,
        searches_without,
        searches_with,
    }
}

#[test]
fn transitions_predict_the_next_tool_and_save_searches_on_held_out_turns() {
    let r = measure();
    println!(
        "next-tool recall@3 {:.3} (popularity {:.3}); searches {} -> {} ({:.0}% fewer)",
        r.recall,
        r.popularity_recall,
        r.searches_without,
        r.searches_with,
        100.0 * (1.0 - r.searches_with as f32 / r.searches_without as f32)
    );
    assert!(
        r.recall > r.popularity_recall,
        "beats predicting the most-used tools"
    );
    assert!(
        r.recall >= 0.9,
        "every second step is fixed or a frequent tail"
    );
    assert!(
        (r.searches_with as f32) < 0.6 * r.searches_without as f32,
        "the first search's chain covers most steps"
    );
}
