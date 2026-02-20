use std::collections::HashMap;

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
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

    // Document frequency: how many docs contain each term
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

            // Term frequencies in this doc
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
}
