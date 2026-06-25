//! Per-interaction usage rollup — the analytics payload Ratel ships to its cloud.
//!
//! Pure and network-free (ADR-0016): this module owns the *logic* of cloud
//! analytics — token estimation, full-catalog-vs-selected savings, cost, and the
//! rollup envelope with its on-the-wire serialization. The host SDKs (Python, TS)
//! add only transport, so they stay thin bindings over one shared implementation
//! instead of each re-deriving the maths. No prompt/output text ever enters here.

use serde::{Deserialize, Serialize};

use crate::skill::Skill;
use crate::tool::Tool;

/// Characters per token for the dependency-free heuristic estimate. Savings is a
/// delta signal (full vs selected), so this constant bias largely cancels.
const CHARS_PER_TOKEN: usize = 4;

/// Estimate the token footprint of a string: `len / 4` over Unicode scalar values
/// (matches the reference `len(text) // 4`). Non-empty text estimates at least 1.
pub fn estimate_tokens(text: &str) -> u64 {
    let chars = text.chars().count();
    if chars == 0 {
        0
    } else {
        (chars / CHARS_PER_TOKEN).max(1) as u64
    }
}

/// True when a JSON schema carries no information worth pricing (absent or empty).
fn schema_is_empty(value: &serde_json::Value) -> bool {
    value.is_null()
        || value.as_object().is_some_and(|m| m.is_empty())
        || value.as_array().is_some_and(|a| a.is_empty())
}

/// The text a tool contributes to an agent's context: name, description, and its
/// JSON schemas. This is the footprint priced by [`estimate_tokens`] — distinct
/// from the BM25 *searchable* text, which is tuned for ranking, not size.
pub fn tool_footprint(tool: &Tool) -> String {
    let mut parts = vec![tool.name.clone(), tool.description.clone()];
    for schema in [&tool.input_schema, &tool.output_schema] {
        if schema_is_empty(schema) {
            continue;
        }
        if let Ok(rendered) = serde_json::to_string(schema) {
            parts.push(rendered);
        }
    }
    parts.join(" ")
}

/// The text a skill contributes to context: name, description, tags, and body.
pub fn skill_footprint(skill: &Skill) -> String {
    let mut parts = vec![skill.name.clone(), skill.description.clone()];
    if !skill.tags.is_empty() {
        parts.push(skill.tags.join(" "));
    }
    if !skill.body.is_empty() {
        parts.push(skill.body.clone());
    }
    parts.join(" ")
}

/// Estimated token footprint of a single tool's definition.
pub fn tool_tokens(tool: &Tool) -> u64 {
    estimate_tokens(&tool_footprint(tool))
}

/// Estimated token footprint of a single skill's definition.
pub fn skill_tokens(skill: &Skill) -> u64 {
    estimate_tokens(&skill_footprint(skill))
}

/// Context tokens kept out of the prompt by selection: the full footprint minus
/// what was actually selected. Never negative.
pub fn tokens_saved(full_tokens: u64, selected_tokens: u64) -> u64 {
    full_tokens.saturating_sub(selected_tokens)
}

/// Coarse USD price per 1M tokens `(input, output)` for cost estimation. These are
/// deliberately approximate, demo-grade defaults; a caller with real pricing sets
/// `cost_usd` on the rollup directly and bypasses this.
fn model_price_per_mtok(model: &str) -> (f64, f64) {
    let m = model.to_ascii_lowercase();
    if m.contains("opus") {
        (15.0, 75.0)
    } else if m.contains("sonnet") {
        (3.0, 15.0)
    } else if m.contains("haiku") {
        (0.80, 4.0)
    } else if m.contains("gpt-4o-mini") || m.contains("o4-mini") {
        (0.15, 0.60)
    } else if m.contains("gpt-4o") || m.contains("gpt-4.1") {
        (2.50, 10.0)
    } else {
        (1.0, 3.0)
    }
}

/// Estimate the USD cost of a generation from its model and token counts.
pub fn estimate_cost_usd(model: &str, input_tokens: u64, output_tokens: u64) -> f64 {
    let (input_price, output_price) = model_price_per_mtok(model);
    (input_tokens as f64 * input_price + output_tokens as f64 * output_price) / 1_000_000.0
}

/// Tokens attributed to each context source in one interaction. Field names are
/// exactly the wire keys the cloud's `tokens_by_category` expects.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceTokens {
    pub skills: u64,
    pub tools: u64,
    pub history: u64,
    pub memory: u64,
    pub user_input: u64,
}

impl SourceTokens {
    pub fn total(&self) -> u64 {
        self.skills + self.tools + self.history + self.memory + self.user_input
    }

    pub fn is_zero(&self) -> bool {
        self.total() == 0
    }
}

/// One interaction's usage rollup. Serializes to the exact body accepted by the
/// cloud's `POST /api/v1/events` (a batch is a JSON array of these). Optional
/// fields are omitted when unset so the wire stays compact.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Rollup {
    pub tokens_by_category: SourceTokens,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_by_category: Option<SourceTokens>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saveable_by_category: Option<SourceTokens>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occurred_at: Option<String>,
}

impl Rollup {
    /// A rollup carrying only the per-source spend; enrich via the field setters.
    pub fn new(tokens_by_category: SourceTokens) -> Self {
        let input_tokens = Some(tokens_by_category.total());
        Self {
            tokens_by_category,
            saved_by_category: None,
            saveable_by_category: None,
            input_tokens,
            output_tokens: None,
            model: None,
            latency_ms: None,
            cost_usd: None,
            occurred_at: None,
        }
    }

    /// Serialize to the JSON object the cloud accepts. Infallible in practice
    /// (plain data); falls back to `{}` rather than panicking.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(id: &str, name: &str, description: &str) -> Tool {
        Tool {
            id: id.into(),
            name: name.into(),
            description: description.into(),
            input_schema: serde_json::json!({}),
            output_schema: serde_json::json!({}),
        }
    }

    #[test]
    fn estimate_tokens_is_chars_over_four() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abc"), 1); // floor(3/4)=0 -> min 1
        assert_eq!(estimate_tokens("abcdefgh"), 2);
    }

    #[test]
    fn estimate_tokens_counts_unicode_scalars_not_bytes() {
        // "café" is 4 scalar values but 5 UTF-8 bytes.
        assert_eq!(estimate_tokens("café"), 1);
    }

    #[test]
    fn empty_schemas_are_not_priced() {
        let t = tool("a", "name", "desc");
        // footprint is just "name desc" (8 chars) -> 2 tokens, no "{}" noise.
        assert_eq!(tool_footprint(&t), "name desc");
        assert_eq!(tool_tokens(&t), estimate_tokens("name desc"));
    }

    #[test]
    fn populated_schema_adds_to_footprint() {
        let mut t = tool("a", "n", "d");
        t.input_schema = serde_json::json!({"type": "object"});
        assert!(tool_footprint(&t).contains("type"));
        assert!(tool_tokens(&t) > tool_tokens(&tool("a", "n", "d")));
    }

    #[test]
    fn savings_is_full_minus_selected_and_never_negative() {
        assert_eq!(tokens_saved(1000, 200), 800);
        assert_eq!(tokens_saved(100, 250), 0);
    }

    #[test]
    fn cost_scales_with_tokens_and_model_tier() {
        let opus = estimate_cost_usd("claude-opus-4-8", 1_000_000, 0);
        let haiku = estimate_cost_usd("claude-haiku-4-5", 1_000_000, 0);
        assert!(opus > haiku);
        assert!((opus - 15.0).abs() < 1e-9);
    }

    #[test]
    fn source_tokens_total_sums_every_field() {
        let s = SourceTokens {
            skills: 1,
            tools: 2,
            history: 3,
            memory: 4,
            user_input: 5,
        };
        assert_eq!(s.total(), 15);
        assert!(!s.is_zero());
        assert!(SourceTokens::default().is_zero());
    }

    #[test]
    fn rollup_serializes_to_the_cloud_contract() {
        let mut r = Rollup::new(SourceTokens {
            skills: 10,
            tools: 20,
            history: 30,
            memory: 5,
            user_input: 15,
        });
        r.model = Some("claude-sonnet-4-6".into());
        r.input_tokens = Some(80);
        let parsed: serde_json::Value = serde_json::from_str(&r.to_json()).unwrap();
        assert_eq!(parsed["tokens_by_category"]["tools"], 20);
        assert_eq!(parsed["input_tokens"], 80);
        assert_eq!(parsed["model"], "claude-sonnet-4-6");
        // Unset optionals are omitted, not null.
        assert!(parsed.get("saved_by_category").is_none());
        assert!(parsed.get("cost_usd").is_none());
    }
}
