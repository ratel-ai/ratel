//! Retrieval-only metrics (BM25 quality vs gold tools).
//!
//! No LLM calls — this layer answers "given a query and a candidate pool, does
//! `ratel-ai-core` rank the gold tool(s) at the top?" Outputs feed the report's
//! retrieval-quality panel.

use ratel_ai_core::ToolRegistry;
use serde::Serialize;

use crate::corpus::ToolSpec;

/// Retrieval metrics for one (scenario, pool, K) cell.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RetrievalMetrics {
    pub k: usize,
    pub pool_size: usize,
    pub gold_count: usize,
    /// Fraction of gold tools that appear anywhere in the top-K hits.
    pub recall_at_k: f64,
    /// Fraction of top-K hits that are gold tools.
    pub precision_at_k: f64,
    /// 1 / rank of the first gold hit (1-indexed); 0.0 if no gold in top-K.
    pub reciprocal_rank: f64,
    /// True if at least one gold tool is in the top-K.
    pub hit_at_k: bool,
    /// Normalized DCG@K under binary relevance: DCG / IDCG, where IDCG places
    /// every gold tool at the top of the ranking. 0.0 when there are no gold
    /// tools (IDCG would be 0 too). Comparable to ToolRet's leaderboard column.
    pub ndcg_at_k: f64,
}

/// Evaluate retrieval quality at multiple K cutoffs in one BM25 pass.
///
/// Runs one ranking per (pool, query) and slices metrics for each K — much
/// cheaper than re-ranking per K. Returns one `RetrievalMetrics` per `k`,
/// preserving the input order. Empty `ks` yields an empty result.
pub fn evaluate_at_ks(
    pool: &[ToolSpec],
    query: &str,
    gold_tool_ids: &[String],
    ks: &[usize],
) -> Vec<RetrievalMetrics> {
    if ks.is_empty() {
        return Vec::new();
    }
    let max_k = *ks.iter().max().unwrap();
    let mut registry = ToolRegistry::new();
    for spec in pool {
        registry.register(spec.into());
    }
    let hits = registry.search(query, max_k);

    let gold_count = gold_tool_ids.len();
    ks.iter()
        .map(|&k| {
            let cutoff = hits.len().min(k);
            let mut gold_in_topk = 0usize;
            let mut first_gold_rank: Option<usize> = None;
            let mut dcg = 0.0f64;
            for (rank0, hit) in hits.iter().take(cutoff).enumerate() {
                if gold_tool_ids.iter().any(|g| g == &hit.tool_id) {
                    gold_in_topk += 1;
                    if first_gold_rank.is_none() {
                        first_gold_rank = Some(rank0 + 1);
                    }
                    dcg += 1.0 / ((rank0 + 2) as f64).log2();
                }
            }
            let recall_at_k = if gold_count == 0 {
                0.0
            } else {
                gold_in_topk as f64 / gold_count as f64
            };
            let precision_at_k = if cutoff == 0 {
                0.0
            } else {
                gold_in_topk as f64 / cutoff as f64
            };
            let reciprocal_rank = first_gold_rank.map(|r| 1.0 / r as f64).unwrap_or(0.0);
            // Ideal DCG places every gold tool at the top of the ranking, up to K.
            let ideal_hits = gold_count.min(k);
            let idcg: f64 = (0..ideal_hits).map(|i| 1.0 / ((i + 2) as f64).log2()).sum();
            let ndcg_at_k = if idcg == 0.0 { 0.0 } else { dcg / idcg };
            RetrievalMetrics {
                k,
                pool_size: pool.len(),
                gold_count,
                recall_at_k,
                precision_at_k,
                reciprocal_rank,
                hit_at_k: gold_in_topk > 0,
                ndcg_at_k,
            }
        })
        .collect()
}

/// Single-K shim around [`evaluate_at_ks`]. Kept for callers that just want
/// metrics at one cutoff.
pub fn evaluate(
    pool: &[ToolSpec],
    query: &str,
    gold_tool_ids: &[String],
    k: usize,
) -> RetrievalMetrics {
    evaluate_at_ks(pool, query, gold_tool_ids, &[k])
        .into_iter()
        .next()
        .expect("evaluate_at_ks with one k always returns one metric")
}

/// Build a pool of `target_size` tools = scenario tools + leading distractors.
///
/// Scenario tools are always included verbatim (so gold tools are guaranteed
/// to be present). Distractors are drawn in order — caller controls the seed
/// by shuffling `distractors` before passing it in.
pub fn build_pool(
    scenario_pool: &[ToolSpec],
    distractors: &[ToolSpec],
    target_size: usize,
) -> Vec<ToolSpec> {
    let mut out: Vec<ToolSpec> = scenario_pool.to_vec();
    let scenario_ids: std::collections::HashSet<&String> =
        scenario_pool.iter().map(|t| &t.id).collect();
    if out.len() >= target_size {
        return out;
    }
    let remaining = target_size - out.len();
    for d in distractors.iter() {
        if scenario_ids.contains(&d.id) {
            continue;
        }
        out.push(d.clone());
        if out.len() - scenario_pool.len() >= remaining {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(id: &str, name: &str, description: &str) -> ToolSpec {
        ToolSpec {
            id: id.into(),
            name: name.into(),
            description: description.into(),
            input_schema: json!({}),
            output_schema: json!({}),
        }
    }

    fn read_file_pool() -> Vec<ToolSpec> {
        vec![
            tool("fs.read_file", "read_file", "Read a file from disk."),
            tool("fs.write_file", "write_file", "Write contents to a file."),
            tool("net.http_get", "http_get", "Fetch an HTTP URL."),
            tool("db.query", "query_db", "Run a SQL query."),
            tool(
                "mail.send",
                "send_email",
                "Send an email via SMTP to a recipient.",
            ),
        ]
    }

    #[test]
    fn recall_is_one_when_gold_in_topk() {
        let pool = read_file_pool();
        let m = evaluate(&pool, "read a file from disk", &["fs.read_file".into()], 3);
        assert_eq!(m.recall_at_k, 1.0);
        assert!(m.hit_at_k);
        assert!(m.reciprocal_rank > 0.0);
    }

    #[test]
    fn recall_counts_gold_proportion() {
        let pool = read_file_pool();
        let m = evaluate(
            &pool,
            "file disk read write",
            &["fs.read_file".into(), "fs.write_file".into()],
            5,
        );
        assert_eq!(m.gold_count, 2);
        assert!(
            m.recall_at_k > 0.0,
            "expected at least one gold to be retrieved, got {m:?}"
        );
    }

    #[test]
    fn no_match_yields_zero_metrics() {
        let pool = read_file_pool();
        let m = evaluate(
            &pool,
            "completely unrelated query about astrophysics",
            &["does.not.exist".into()],
            3,
        );
        assert_eq!(m.recall_at_k, 0.0);
        assert_eq!(m.reciprocal_rank, 0.0);
        assert!(!m.hit_at_k);
    }

    #[test]
    fn empty_pool_yields_zero_metrics() {
        let m = evaluate(&[], "anything", &["x".into()], 5);
        assert_eq!(m.recall_at_k, 0.0);
        assert_eq!(m.precision_at_k, 0.0);
        assert!(!m.hit_at_k);
        assert_eq!(m.pool_size, 0);
    }

    #[test]
    fn mrr_inversely_proportional_to_rank() {
        // Gold tool description is uniquely matched by query; should be rank 1.
        let pool = read_file_pool();
        let m = evaluate(&pool, "send an email via SMTP", &["mail.send".into()], 5);
        assert_eq!(m.reciprocal_rank, 1.0);
    }

    #[test]
    fn build_pool_returns_scenario_tools_when_target_smaller() {
        let scenario = vec![tool("a", "a", "alpha"), tool("b", "b", "beta")];
        let distractors = vec![tool("c", "c", "gamma")];
        let pool = build_pool(&scenario, &distractors, 1);
        assert_eq!(pool.len(), 2);
        assert_eq!(pool[0].id, "a");
        assert_eq!(pool[1].id, "b");
    }

    #[test]
    fn build_pool_pads_with_distractors_to_target_size() {
        let scenario = vec![tool("a", "a", "alpha")];
        let distractors = vec![
            tool("b", "b", "beta"),
            tool("c", "c", "gamma"),
            tool("d", "d", "delta"),
        ];
        let pool = build_pool(&scenario, &distractors, 3);
        assert_eq!(pool.len(), 3);
        assert_eq!(pool[0].id, "a");
        assert_eq!(pool[1].id, "b");
        assert_eq!(pool[2].id, "c");
    }

    #[test]
    fn build_pool_skips_distractors_already_in_scenario() {
        let scenario = vec![tool("a", "a", "alpha")];
        let distractors = vec![tool("a", "a", "alpha-dup"), tool("b", "b", "beta")];
        let pool = build_pool(&scenario, &distractors, 2);
        assert_eq!(pool.len(), 2);
        assert_eq!(pool[0].id, "a");
        assert_eq!(pool[1].id, "b");
    }

    #[test]
    fn build_pool_caps_at_distractor_supply() {
        let scenario = vec![tool("a", "a", "alpha")];
        let distractors = vec![tool("b", "b", "beta")];
        let pool = build_pool(&scenario, &distractors, 100);
        assert_eq!(pool.len(), 2);
    }

    #[test]
    fn evaluate_at_ks_returns_one_metric_per_k_in_order() {
        let pool = read_file_pool();
        let metrics = evaluate_at_ks(
            &pool,
            "read a file from disk",
            &["fs.read_file".into()],
            &[1, 3, 5],
        );
        assert_eq!(metrics.len(), 3);
        assert_eq!(metrics[0].k, 1);
        assert_eq!(metrics[1].k, 3);
        assert_eq!(metrics[2].k, 5);
    }

    #[test]
    fn evaluate_at_ks_smaller_k_can_miss_when_gold_is_lower_ranked() {
        // Construct a query that puts the gold tool at rank 2: query weakly
        // matches read but more strongly matches "file disk", which surfaces
        // multiple file/disk-mentioning tools above it.
        let pool = vec![
            tool(
                "fs.write_file",
                "write_file",
                "Write contents to a file on disk.",
            ),
            tool(
                "fs.read_file",
                "read_file",
                "Read a file from local disk and return its textual contents.",
            ),
            tool("net.http_get", "http_get", "Fetch an HTTP URL."),
        ];
        let metrics = evaluate_at_ks(&pool, "write file disk", &["fs.read_file".into()], &[1, 3]);
        // At K=1 a non-gold rank-1 tool dominates → miss.
        assert_eq!(metrics[0].recall_at_k, 0.0);
        assert!(!metrics[0].hit_at_k);
        // At K=3 the gold tool has room to land → recall@3 should pick it up.
        assert_eq!(metrics[1].recall_at_k, 1.0);
        assert!(metrics[1].hit_at_k);
    }

    #[test]
    fn ndcg_is_one_when_gold_at_rank_one() {
        let pool = read_file_pool();
        let m = evaluate(&pool, "send an email via SMTP", &["mail.send".into()], 5);
        assert_eq!(m.ndcg_at_k, 1.0);
    }

    #[test]
    fn ndcg_is_zero_when_gold_missing_from_topk() {
        let pool = read_file_pool();
        let m = evaluate(
            &pool,
            "completely unrelated query about astrophysics",
            &["does.not.exist".into()],
            3,
        );
        assert_eq!(m.ndcg_at_k, 0.0);
    }

    #[test]
    fn ndcg_is_zero_when_no_gold_tools() {
        let pool = read_file_pool();
        let m = evaluate(&pool, "anything", &[], 5);
        assert_eq!(m.ndcg_at_k, 0.0);
    }

    #[test]
    fn ndcg_at_rank_two_uses_log2_three_discount() {
        // Query is ambiguous between two file/disk tools; gold lands at rank 2.
        let pool = vec![
            tool(
                "fs.write_file",
                "write_file",
                "Write contents to a file on disk.",
            ),
            tool(
                "fs.read_file",
                "read_file",
                "Read a file from local disk and return its textual contents.",
            ),
            tool("net.http_get", "http_get", "Fetch an HTTP URL."),
        ];
        let m = evaluate(&pool, "write file disk", &["fs.read_file".into()], 3);
        // Single gold at rank 2 → DCG = 1/log2(3); IDCG = 1 (gold at top); nDCG = 1/log2(3).
        let expected = 1.0 / 3.0_f64.log2();
        assert!(
            (m.ndcg_at_k - expected).abs() < 1e-9,
            "nDCG was {}",
            m.ndcg_at_k
        );
    }

    #[test]
    fn ndcg_with_multi_gold_partial_recovery() {
        // Two gold tools; if both land in top-K but at ranks 1 and 3, nDCG should
        // be the ratio (1 + 1/log2(4)) / (1 + 1/log2(3)).
        let pool = vec![
            tool("a.alpha", "alpha", "alpha alpha alpha"),
            tool("b.beta", "beta", "beta beta beta"),
            tool("a.gamma", "gamma", "alpha alpha gamma"),
            tool("c.cee", "cee", "unrelated"),
        ];
        // Query "alpha" matches both a.alpha (rank 1) and a.gamma (rank 2 or 3 depending on BM25)
        // — the assertion is structural: nDCG should be in (0, 1] and equal to DCG/IDCG.
        let m = evaluate(&pool, "alpha", &["a.alpha".into(), "a.gamma".into()], 5);
        assert!(m.gold_count == 2);
        // Both gold present (recall 1.0) but order may not be ideal → nDCG ≤ 1.
        if m.recall_at_k == 1.0 {
            assert!(
                m.ndcg_at_k > 0.0 && m.ndcg_at_k <= 1.0,
                "nDCG was {}",
                m.ndcg_at_k
            );
        }
    }

    #[test]
    fn ndcg_at_ks_monotone_when_gold_in_window() {
        // With one gold at rank 1, nDCG@K stays 1.0 across K ≥ 1.
        let pool = read_file_pool();
        let metrics = evaluate_at_ks(
            &pool,
            "send an email via SMTP",
            &["mail.send".into()],
            &[1, 3, 5],
        );
        assert_eq!(metrics[0].ndcg_at_k, 1.0);
        assert_eq!(metrics[1].ndcg_at_k, 1.0);
        assert_eq!(metrics[2].ndcg_at_k, 1.0);
    }

    #[test]
    fn evaluate_at_ks_empty_ks_yields_empty_vec() {
        let pool = read_file_pool();
        let metrics = evaluate_at_ks(&pool, "anything", &["x".into()], &[]);
        assert!(metrics.is_empty());
    }

    #[test]
    fn evaluate_at_ks_runs_one_search_for_max_k() {
        // Smoke: with K=[1,5] the single search at K=5 is enough to score both.
        // Just asserts both metrics are populated and consistent.
        let pool = read_file_pool();
        let metrics = evaluate_at_ks(&pool, "send email via SMTP", &["mail.send".into()], &[1, 5]);
        assert_eq!(metrics.len(), 2);
        assert_eq!(metrics[0].k, 1);
        assert_eq!(metrics[1].k, 5);
        // Same query → same first-gold rank → same reciprocal_rank across K
        // cutoffs (as long as the gold is within both cutoffs).
        if metrics[0].hit_at_k {
            assert_eq!(metrics[0].reciprocal_rank, metrics[1].reciprocal_rank);
        }
    }
}
