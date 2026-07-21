//! Rebuild a usage-ranking [`IntentGraph`] by replaying local trace logs
//! (ADR-0013).
//!
//! The learner in `ratel-ai-core` grows a graph from live events, but it lives
//! in memory: a fresh process starts knowing nothing. `JsonlSink` has been
//! writing every search and invoke to `~/.ratel/telemetry/<project>/*.jsonl`
//! all along, so that log is already a durable record of everything the learner
//! would have seen. Replaying it reconstructs the graph — no new storage.
//!
//! Replay runs through **the same** [`UsageLearner`] the live path uses, via
//! [`UsageLearner::replay`], which stamps each observation with the envelope's
//! own timestamp. So a replayed graph is what the live path would have grown,
//! not an approximation of it.
//!
//! **Sessions are replayed separately.** A confirmed observation is a search and
//! an invoke from *one* session; feeding two interleaved sessions through one
//! learner would pair one session's search with another's invoke and invent
//! edges nobody produced. [`replay_envelopes`] groups by `session_id` first.

#![warn(missing_docs)]

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::{Arc, RwLock};

use ratel_ai_core::{IntentGraph, NoopSink, TraceEnvelope, UsageLearner};

/// What a replay consumed — enough to tell "no telemetry found" from "telemetry
/// found, but nobody ever invoked anything".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ReplayStats {
    /// JSONL files read.
    pub files: usize,
    /// Lines that parsed into a trace envelope.
    pub envelopes: usize,
    /// Lines that did not parse and were skipped — a truncated final line is
    /// normal for a log still being appended to.
    pub skipped_lines: usize,
    /// Distinct sessions replayed, each through its own learner.
    pub sessions: usize,
}

/// Replay every `*.jsonl` under `dir`, recursively, into a fresh graph.
///
/// A missing directory is not an error: it means no telemetry has been written
/// yet, and the correct result is an empty graph.
///
/// # Errors
///
/// Any [`std::io::Error`] from walking the directory or reading a file.
pub fn replay_dir(dir: impl AsRef<Path>) -> std::io::Result<(IntentGraph, ReplayStats)> {
    let mut envelopes = Vec::new();
    let mut stats = ReplayStats::default();
    collect(dir.as_ref(), &mut envelopes, &mut stats)?;
    let graph = replay_envelopes(&envelopes);
    stats.sessions = distinct_sessions(&envelopes);
    Ok((graph, stats))
}

fn collect(
    dir: &Path,
    out: &mut Vec<TraceEnvelope>,
    stats: &mut ReplayStats,
) -> std::io::Result<()> {
    if !dir.exists() {
        return Ok(()); // no telemetry yet — an empty graph is the right answer
    }
    // Sorted, so a replay of the same tree is reproducible regardless of the
    // order the filesystem happens to hand entries back.
    let mut entries: Vec<_> = fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, out, stats)?;
        } else if path.extension().is_some_and(|e| e == "jsonl") {
            stats.files += 1;
            read_jsonl(&path, out, stats)?;
        }
    }
    Ok(())
}

fn read_jsonl(
    path: &Path,
    out: &mut Vec<TraceEnvelope>,
    stats: &mut ReplayStats,
) -> std::io::Result<()> {
    for line in BufReader::new(fs::File::open(path)?).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        // A trace log is append-only and may be mid-write, so the last line can
        // be truncated. Unparseable lines are counted and skipped, never fatal —
        // one bad line must not cost the whole history.
        match serde_json::from_str::<TraceEnvelope>(&line) {
            Ok(envelope) => {
                out.push(envelope);
                stats.envelopes += 1;
            }
            Err(_) => stats.skipped_lines += 1,
        }
    }
    Ok(())
}

fn distinct_sessions(envelopes: &[TraceEnvelope]) -> usize {
    let mut seen: BTreeMap<&str, ()> = BTreeMap::new();
    for e in envelopes {
        seen.insert(e.session_id.as_str(), ());
    }
    seen.len()
}

/// Replay `envelopes` into a fresh graph, one learner per `session_id`.
///
/// Within a session, envelopes are replayed in timestamp order — a log may
/// interleave sessions, and pairing depends on a search preceding its invoke.
/// Sessions are processed in id order so the result does not depend on input
/// order.
pub fn replay_envelopes(envelopes: &[TraceEnvelope]) -> IntentGraph {
    let graph = Arc::new(RwLock::new(IntentGraph::empty()));

    let mut by_session: BTreeMap<&str, Vec<&TraceEnvelope>> = BTreeMap::new();
    for e in envelopes {
        by_session.entry(e.session_id.as_str()).or_default().push(e);
    }

    for (_, mut session) in by_session {
        // Stable sort by ts keeps same-millisecond events in log order, which is
        // what distinguishes a search from the invoke that answered it.
        session.sort_by_key(|e| e.ts);
        let learner = UsageLearner::new(graph.clone(), Arc::new(NoopSink));
        for envelope in session {
            learner.replay(envelope);
        }
    }

    Arc::try_unwrap(graph)
        .map(|lock| lock.into_inner().expect("graph lock poisoned"))
        .unwrap_or_else(|arc| arc.read().expect("graph lock poisoned").clone())
}

/// Render a graph for a human: one block per cluster, strongest first.
///
/// This is the whole reason a graph is inspectable rather than magic — you can
/// see which asks it recognizes, how much evidence each carries, and what it
/// would promote.
pub fn render(graph: &IntentGraph) -> String {
    use std::fmt::Write;

    let mut out = String::new();
    if graph.is_empty() {
        return "no clusters yet — nothing has been searched and then invoked\n".into();
    }

    // `labeled()` materializes the display fields against the graph as it is now
    // — they are derived, not stored, so reading `graph.intents` directly would
    // print blanks.
    let materialized = graph.labeled();
    let mut intents: Vec<_> = materialized.iter().collect();
    intents.sort_by(|a, b| b.support.cmp(&a.support).then_with(|| a.id.cmp(&b.id)));

    for it in intents {
        let _ = writeln!(out, "{}  ({} observations)", it.label, it.support);
        if !it.terms.is_empty() {
            let _ = writeln!(out, "  {:8} {}", "terms:", it.terms.join(", "));
        }
        let _ = writeln!(out, "  {:8} {}", "members:", it.members.len());
        for (kind, edges) in [("tools", &it.tools), ("skills", &it.skills)] {
            if edges.is_empty() {
                continue;
            }
            let mut ranked: Vec<_> = edges.iter().collect();
            ranked.sort_by(|a, b| {
                b.1.partial_cmp(a.1)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.0.cmp(b.0))
            });
            let list: Vec<String> = ranked
                .iter()
                .map(|(id, w)| format!("{id} {w:.2}"))
                .collect();
            let _ = writeln!(out, "  {:8} {}", format!("{kind}:"), list.join("  "));
        }
        out.push('\n');
    }
    out
}
