use std::collections::HashMap;

use crate::models::{EmbeddingFieldWeights, FieldEmbeddings};

pub fn weighted_semantic_score(
    query_emb: &[f32],
    field_embs: &FieldEmbeddings,
    weights: &EmbeddingFieldWeights,
) -> f32 {
    let mut total_score = 0.0;
    let mut total_weight = 0.0;

    // Name field (always present)
    total_score += weights.name * cosine_similarity(query_emb, &field_embs.name);
    total_weight += weights.name;

    // Description field (always present)
    total_score += weights.description * cosine_similarity(query_emb, &field_embs.description);
    total_weight += weights.description;

    // Optional fields
    if let Some(ref emb) = field_embs.input_schema {
        total_score += weights.input_schema * cosine_similarity(query_emb, emb);
        total_weight += weights.input_schema;
    }
    if let Some(ref emb) = field_embs.output_schema {
        total_score += weights.output_schema * cosine_similarity(query_emb, emb);
        total_weight += weights.output_schema;
    }

    if total_weight > 0.0 { total_score / total_weight } else { 0.0 }
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len(), "cosine_similarity: vector length mismatch");
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let norm_a = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a * norm_b)
}

pub fn bm25_scores(query: &str, documents: &[String]) -> Vec<f32> {
    const K1: f32 = 1.2;
    const B: f32 = 0.75;

    let n = documents.len();
    if n == 0 {
        return vec![];
    }

    let query_terms = tokenize(query);
    let doc_terms: Vec<Vec<String>> = documents.iter().map(|d| tokenize(d)).collect();
    let avg_dl = doc_terms.iter().map(|d| d.len()).sum::<usize>() as f32 / n as f32;

    let mut df: HashMap<String, usize> = HashMap::new();
    for terms in &doc_terms {
        let unique: std::collections::HashSet<&str> = terms.iter().map(|s| s.as_str()).collect();
        for term in unique {
            *df.entry(term.to_string()).or_default() += 1;
        }
    }

    doc_terms
        .iter()
        .map(|terms| {
            let dl = terms.len() as f32;

            let mut tf: HashMap<&str, f32> = HashMap::new();
            for t in terms {
                *tf.entry(t.as_str()).or_default() += 1.0;
            }

            query_terms
                .iter()
                .map(|qt| {
                    let freq = tf.get(qt.as_str()).copied().unwrap_or(0.0);
                    let doc_freq = *df.get(qt.as_str()).unwrap_or(&0) as f32;
                    let idf = ((n as f32 - doc_freq + 0.5) / (doc_freq + 0.5) + 1.0).ln();
                    let tf_norm = (freq * (K1 + 1.0)) / (freq + K1 * (1.0 - B + B * dl / avg_dl));
                    idf * tf_norm
                })
                .sum()
        })
        .collect()
}

pub fn normalize_min_max(scores: &[f32]) -> Vec<f32> {
    if scores.is_empty() {
        return vec![];
    }
    let max = scores.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let min = scores.iter().cloned().fold(f32::INFINITY, f32::min);
    let range = max - min;
    scores.iter().map(|s| if range > 0.0 { (s - min) / range } else { 0.0 }).collect()
}

fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cosine_identical_vectors() {
        let a = vec![1.0, 0.0, 0.0];
        assert!((cosine_similarity(&a, &a) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_orthogonal_vectors() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![0.0, 1.0, 0.0];
        assert!(cosine_similarity(&a, &b).abs() < 1e-6);
    }

    #[test]
    fn cosine_opposite_vectors() {
        let a = vec![1.0, 0.0];
        let b = vec![-1.0, 0.0];
        assert!((cosine_similarity(&a, &b) + 1.0).abs() < 1e-6);
    }

    #[test]
    fn bm25_ranks_matching_doc_higher() {
        let docs = vec![
            "process a refund for a specific invoice".to_string(),
            "get customer account details including name and email".to_string(),
        ];
        let scores = bm25_scores("refund", &docs);
        assert!(scores[0] > scores[1], "refund doc should score higher: {:?}", scores);
    }

    #[test]
    fn bm25_returns_zero_for_no_match() {
        let docs = vec!["get customer account details".to_string()];
        let scores = bm25_scores("refund", &docs);
        assert!((scores[0]).abs() < 1e-6, "no match should score ~0: {:?}", scores);
    }

    #[test]
    fn weighted_semantic_score_uses_field_weights() {
        // Query vector aligned with name_emb
        let query = vec![1.0, 0.0, 0.0];
        let name_emb = vec![1.0, 0.0, 0.0]; // cosine = 1.0
        let desc_emb = vec![0.0, 1.0, 0.0]; // cosine = 0.0

        let field_embs = FieldEmbeddings {
            name: name_emb,
            description: desc_emb,
            input_schema: None,
            output_schema: None,
        };

        // Heavy name weight
        let weights = EmbeddingFieldWeights {
            name: 0.9,
            description: 0.1,
            input_schema: 0.0,
            output_schema: 0.0,
        };

        let score = weighted_semantic_score(&query, &field_embs, &weights);
        // Expected: (0.9 * 1.0 + 0.1 * 0.0) / (0.9 + 0.1) = 0.9
        assert!((score - 0.9).abs() < 1e-6, "expected ~0.9, got {score}");

        // Heavy description weight
        let weights2 = EmbeddingFieldWeights {
            name: 0.1,
            description: 0.9,
            input_schema: 0.0,
            output_schema: 0.0,
        };
        let score2 = weighted_semantic_score(&query, &field_embs, &weights2);
        // Expected: (0.1 * 1.0 + 0.9 * 0.0) / (0.1 + 0.9) = 0.1
        assert!((score2 - 0.1).abs() < 1e-6, "expected ~0.1, got {score2}");
    }

    #[test]
    fn normalize_min_max_basic() {
        let scores = vec![1.0, 3.0, 5.0];
        let norm = normalize_min_max(&scores);
        assert!((norm[0] - 0.0).abs() < 1e-6);
        assert!((norm[1] - 0.5).abs() < 1e-6);
        assert!((norm[2] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn normalize_min_max_all_equal() {
        let scores = vec![2.0, 2.0, 2.0];
        let norm = normalize_min_max(&scores);
        assert!(norm.iter().all(|s| *s == 0.0));
    }

    #[test]
    fn normalize_min_max_empty() {
        let norm = normalize_min_max(&[]);
        assert!(norm.is_empty());
    }

    #[test]
    fn normalize_min_max_single() {
        let norm = normalize_min_max(&[5.0]);
        assert!((norm[0] - 0.0).abs() < 1e-6);
    }

    #[test]
    fn weighted_semantic_score_handles_missing_fields() {
        let query = vec![1.0, 0.0, 0.0];
        let field_embs = FieldEmbeddings {
            name: vec![1.0, 0.0, 0.0],
            description: vec![0.5, 0.5, 0.0],
            input_schema: None,
            output_schema: None,
        };

        let weights = EmbeddingFieldWeights::default();
        let score = weighted_semantic_score(&query, &field_embs, &weights);

        // Only name (0.1) + description (0.5) active, total weight = 0.6
        let desc_cos = cosine_similarity(&query, &field_embs.description);
        let expected = (0.1 * 1.0 + 0.5 * desc_cos) / 0.6;
        assert!((score - expected).abs() < 1e-6, "expected {expected}, got {score}");
    }
}
