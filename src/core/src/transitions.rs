//! Ordered tool→tool transitions within a turn (ADR-0028).
//!
//! A [`Transitions`] table maps a state to the tools invoked right after it.
//! A state is a tool id, or [`START`] for "the turn had invoked nothing yet".
//! Each row counts how often its state was *entered* (`n`) and how often each
//! next tool followed it (`next`). Nothing records the end of a turn, and
//! nothing has to: the turns that stopped at a state are `n − Σnext`.
//!
//! Counts stay raw integers on the wire so two tables add. Probabilities are
//! derived at read time from **organic** transitions only: a transition the
//! agent made because a hint offered it is recorded in `hinted` and left out,
//! so a hint can freeze an edge but never inflate it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The pseudo-state a turn is in before its first tool.
pub(crate) const START: &str = "<start>";

/// Next tools kept per row. Past it, the least-followed one goes.
const NEXT_CAP: usize = 16;

/// Rows kept per table. Past it, the least-entered tool row goes; [`START`]
/// is never the one dropped.
const ROW_CAP: usize = 256;

/// Additive smoothing on a row's denominator, so one observation reads `1/2`,
/// not certainty.
const SMOOTHING: f32 = 1.0;

/// An edge is strong — worth handing the agent a callable definition for —
/// when the Wilson lower bound (95%) of its organic share clears this.
const STRONG_LOWER_BOUND: f32 = 0.6;

/// Fewest organic entries into a row before any of its edges can be strong.
const STRONG_MIN_N: u32 = 5;

/// How often a hint offered an edge, and how often the agent then took it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HintCount {
    pub offered: u32,
    #[serde(default)]
    pub followed: u32,
}

/// One state's counts.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Row {
    /// Times this state was entered.
    pub n: u32,
    /// Times each tool came next.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub next: BTreeMap<String, u32>,
    /// Hint offers and follows per next tool. A followed transition is also in
    /// `next`; [`Transitions::predict`] subtracts it.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub hinted: BTreeMap<String, HintCount>,
}

impl Row {
    fn followed_total(&self) -> u32 {
        self.hinted.values().map(|h| h.followed).sum()
    }

    /// Entries that did not end in a followed hint.
    fn organic_n(&self) -> u32 {
        self.n.saturating_sub(self.followed_total())
    }

    fn organic(&self, id: &str) -> u32 {
        let count = self.next.get(id).copied().unwrap_or(0);
        let followed = self.hinted.get(id).map_or(0, |h| h.followed);
        count.saturating_sub(followed)
    }
}

/// A predicted next tool.
#[derive(Clone, Debug, PartialEq)]
pub struct NextTool {
    pub id: String,
    /// Smoothed organic probability that `id` comes next.
    pub p: f32,
    /// Organic entries into the row the prediction came from.
    pub n: u32,
    /// Whether the edge clears the strength bar.
    pub strong: bool,
}

/// A transition table: state → [`Row`].
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Transitions(BTreeMap<String, Row>);

impl Transitions {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub(crate) fn row(&self, state: &str) -> Option<&Row> {
        self.0.get(state)
    }

    /// Record that a turn entered `state`.
    pub(crate) fn enter(&mut self, state: &str) {
        self.0.entry(state.to_string()).or_default().n += 1;
        if self.0.len() > ROW_CAP {
            // The state just entered is spared: a full table must still admit
            // a new tool, or the first ROW_CAP tools would hold it forever.
            let victim = self
                .0
                .iter()
                .filter(|(k, _)| k.as_str() != START && k.as_str() != state)
                .min_by(|a, b| a.1.n.cmp(&b.1.n).then_with(|| a.0.cmp(b.0)))
                .map(|(k, _)| k.clone());
            if let Some(k) = victim {
                self.0.remove(&k);
            }
        }
    }

    /// Record `next` following `prev`, and entering `next`. `followed` marks a
    /// transition taken from a hint.
    pub(crate) fn step(&mut self, prev: &str, next: &str, followed: bool) {
        if let Some(row) = self.0.get_mut(prev) {
            *row.next.entry(next.to_string()).or_default() += 1;
            if followed {
                if let Some(h) = row.hinted.get_mut(next) {
                    h.followed = (h.followed + 1).min(h.offered);
                }
            }
            if row.next.len() > NEXT_CAP {
                // Spare the tool just recorded, for the same reason as rows.
                let victim = row
                    .next
                    .iter()
                    .filter(|(k, _)| k.as_str() != next)
                    .min_by(|a, b| a.1.cmp(b.1).then_with(|| a.0.cmp(b.0)))
                    .map(|(k, _)| k.clone());
                if let Some(k) = victim {
                    row.next.remove(&k);
                    row.hinted.remove(&k);
                }
            }
        }
        self.enter(next);
    }

    /// Record that a hint offered `next` after `prev`. A state never entered
    /// has nothing to offer from, and is ignored.
    pub(crate) fn offer(&mut self, prev: &str, next: &str) {
        if let Some(row) = self.0.get_mut(prev) {
            row.hinted.entry(next.to_string()).or_default().offered += 1;
        }
    }

    /// The likeliest tools after `state`, best first, at most `k`.
    pub(crate) fn predict(&self, state: &str, k: usize) -> Vec<NextTool> {
        let Some(row) = self.0.get(state) else {
            return Vec::new();
        };
        let n = row.organic_n();
        let mut out: Vec<NextTool> = row
            .next
            .keys()
            .filter_map(|id| {
                let c = row.organic(id);
                (c > 0).then(|| NextTool {
                    id: id.clone(),
                    p: c as f32 / (n as f32 + SMOOTHING),
                    n,
                    strong: n >= STRONG_MIN_N && wilson_lower(c, n) >= STRONG_LOWER_BOUND,
                })
            })
            .collect();
        out.sort_by(|a, b| b.p.total_cmp(&a.p).then_with(|| a.id.cmp(&b.id)));
        out.truncate(k);
        out
    }

    /// Check the wire rules the shape alone cannot enforce.
    pub(crate) fn validate(&self) -> Result<(), String> {
        for (state, row) in &self.0 {
            if state.is_empty() {
                return Err("a transition state is empty".into());
            }
            // Zero says "never", which absence already says: one meaning per state.
            if row.n == 0 {
                return Err(format!("transition state {state:?} has n 0"));
            }
            if row.next.values().any(|c| *c == 0) {
                return Err(format!("transition state {state:?} has a zero next count"));
            }
            if row.next.values().map(|c| u64::from(*c)).sum::<u64>() > u64::from(row.n) {
                return Err(format!(
                    "transition state {state:?} continues more often than it was entered"
                ));
            }
            for (id, h) in &row.hinted {
                if h.offered == 0 {
                    return Err(format!(
                        "transition {state:?} -> {id:?} was offered 0 times"
                    ));
                }
                if h.followed > h.offered || h.followed > row.next.get(id).copied().unwrap_or(0) {
                    return Err(format!(
                        "transition {state:?} -> {id:?} was followed more often than offered or taken"
                    ));
                }
            }
        }
        Ok(())
    }
}

/// The 95% Wilson score lower bound of `k` successes in `n` trials.
fn wilson_lower(k: u32, n: u32) -> f32 {
    const Z: f64 = 1.96;
    let (k, n) = (f64::from(k), f64::from(n));
    let p = k / n;
    let z2 = Z * Z;
    let centre = p + z2 / (2.0 * n);
    let margin = Z * (p * (1.0 - p) / n + z2 / (4.0 * n * n)).sqrt();
    ((centre - margin) / (1.0 + z2 / n)) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `turns` of the same tool sequence.
    fn table(turns: &[(&[&str], u32)]) -> Transitions {
        let mut t = Transitions::default();
        for (seq, times) in turns {
            for _ in 0..*times {
                t.enter(START);
                let mut prev = START;
                for tool in seq.iter() {
                    t.step(prev, tool, false);
                    prev = tool;
                }
            }
        }
        t
    }

    #[test]
    fn a_turn_counts_each_step_and_each_entry() {
        let t = table(&[(&["find", "assign"], 1)]);
        assert_eq!(t.row(START).unwrap().n, 1);
        assert_eq!(t.row(START).unwrap().next["find"], 1);
        assert_eq!(t.row("find").unwrap().n, 1);
        assert_eq!(t.row("find").unwrap().next["assign"], 1);
        assert_eq!(t.row("assign").unwrap().n, 1);
        assert!(t.row("assign").unwrap().next.is_empty());
    }

    #[test]
    fn the_end_of_a_turn_is_what_entries_did_not_continue() {
        let t = table(&[(&["assign", "notify"], 2), (&["assign"], 8)]);
        let row = t.row("assign").unwrap();
        assert_eq!(row.n, 10);
        assert_eq!(row.next.values().sum::<u32>(), 2);
    }

    #[test]
    fn a_probability_is_smoothed_against_ending() {
        let t = table(&[(&["assign", "notify"], 2), (&["assign"], 8)]);
        let p = t.predict("assign", 3);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].id, "notify");
        assert!((p[0].p - 2.0 / 11.0).abs() < 1e-6);
        assert_eq!(p[0].n, 10);
        assert!(!p[0].strong);
    }

    #[test]
    fn one_observation_is_not_certainty() {
        let t = table(&[(&["find", "assign"], 1)]);
        let p = t.predict("find", 3);
        assert!((p[0].p - 0.5).abs() < 1e-6);
        assert!(!p[0].strong);
    }

    #[test]
    fn a_consistent_edge_becomes_strong_with_enough_turns() {
        assert!(!table(&[(&["find", "assign"], 5)]).predict("find", 1)[0].strong);
        assert!(table(&[(&["find", "assign"], 6)]).predict("find", 1)[0].strong);
    }

    #[test]
    fn predictions_rank_by_probability_then_id() {
        let t = table(&[(&["a", "y"], 3), (&["a", "x"], 3), (&["a", "z"], 5)]);
        let ids: Vec<_> = t.predict("a", 3).into_iter().map(|n| n.id).collect();
        assert_eq!(ids, ["z", "x", "y"]);
        assert_eq!(t.predict("a", 1).len(), 1);
    }

    #[test]
    fn an_unknown_state_predicts_nothing() {
        assert!(table(&[(&["a"], 1)]).predict("b", 3).is_empty());
    }

    #[test]
    fn a_followed_hint_does_not_count_toward_probability() {
        let mut t = table(&[(&["find", "assign"], 6)]);
        for _ in 0..20 {
            t.enter(START);
            t.step(START, "find", false);
            t.offer("find", "assign");
            t.step("find", "assign", true);
        }
        let p = &t.predict("find", 1)[0];
        assert_eq!(p.n, 6);
        assert!((p.p - 6.0 / 7.0).abs() < 1e-6);
        let h = t.row("find").unwrap().hinted["assign"];
        assert_eq!((h.offered, h.followed), (20, 20));
    }

    #[test]
    fn an_edge_only_ever_followed_from_hints_is_not_predicted() {
        let mut t = table(&[(&["find"], 6)]);
        t.offer("find", "assign");
        t.step("find", "assign", true);
        assert!(t.predict("find", 3).is_empty());
    }

    #[test]
    fn offering_from_a_state_never_entered_is_ignored() {
        let mut t = Transitions::default();
        t.offer("find", "assign");
        assert!(t.is_empty());
    }

    #[test]
    fn a_full_row_admits_a_new_tool_by_dropping_the_least_followed() {
        let mut t = Transitions::default();
        for i in 0..NEXT_CAP {
            for _ in 0..2 {
                t.enter("a");
                t.step("a", &format!("t{i:02}"), false);
            }
        }
        t.enter("a");
        t.step("a", "late", false);
        let row = t.row("a").unwrap();
        assert_eq!(row.next.len(), NEXT_CAP);
        assert!(row.next.contains_key("late"));
        assert!(!row.next.contains_key("t00"));
        assert!(t.validate().is_ok());
    }

    #[test]
    fn a_full_table_admits_a_new_state_and_never_drops_start() {
        let mut t = Transitions::default();
        t.enter(START);
        for i in 0..ROW_CAP {
            t.enter(&format!("t{i:03}"));
            t.enter(&format!("t{i:03}"));
        }
        t.enter("late");
        assert_eq!(t.0.len(), ROW_CAP);
        assert!(t.row(START).is_some());
        assert!(t.row("late").is_some());
    }

    #[test]
    fn it_round_trips_and_an_empty_row_map_is_omitted() {
        let t = table(&[(&["find"], 1)]);
        let json = serde_json::to_value(&t).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "<start>": { "n": 1, "next": { "find": 1 } }, "find": { "n": 1 } })
        );
        let back: Transitions = serde_json::from_value(json).unwrap();
        assert_eq!(back, t);
    }

    #[test]
    fn validation_rejects_states_that_say_nothing_or_too_much() {
        let bad = |v: serde_json::Value| {
            serde_json::from_value::<Transitions>(v)
                .unwrap()
                .validate()
                .is_err()
        };
        assert!(bad(serde_json::json!({ "a": { "n": 0 } })));
        assert!(bad(
            serde_json::json!({ "a": { "n": 1, "next": { "b": 0 } } })
        ));
        assert!(bad(
            serde_json::json!({ "a": { "n": 1, "next": { "b": 2 } } })
        ));
        assert!(bad(serde_json::json!({ "": { "n": 1 } })));
        assert!(bad(
            serde_json::json!({ "a": { "n": 1, "hinted": { "b": { "offered": 0 } } } })
        ));
        assert!(bad(serde_json::json!({ "a": {
            "n": 2, "next": { "b": 1 }, "hinted": { "b": { "offered": 1, "followed": 2 } }
        } })));
        assert!(bad(serde_json::json!({ "a": {
            "n": 2, "hinted": { "b": { "offered": 1, "followed": 1 } }
        } })));
        assert!(!bad(serde_json::json!({ "a": {
            "n": 2, "next": { "b": 1 }, "hinted": { "b": { "offered": 3, "followed": 1 } }
        } })));
    }
}
