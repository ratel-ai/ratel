//! Usage-estimation maths — the network-free token/cost primitives shared across
//! Ratel's SDKs.
//!
//! Pure and dependency-light: token-footprint estimation, per-definition tool /
//! skill footprints, full-catalog-vs-selected savings, and coarse cost estimation.
//! The host SDKs (Python, TS) bind these directly so the maths live in one place
//! instead of each re-deriving them. No prompt/output text is retained here.

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
/// deliberately approximate, demo-grade defaults; a caller with real pricing passes
/// its own cost and bypasses this.
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
}
