//! Field-weighted lexical ranking (BM25F) over a tool's name, description and
//! schema — the experimental alternative to scoring one flattened document
//! (ADR-0025).
//!
//! The flat projection lets a query's throwaway verb outrank its intent noun
//! when the verb happens to sit in a shorter description (issue #56). Scoring
//! the fields separately gives each one a weight and its own length
//! normalization, so a short name field stops being normalized like free text.
//!
//! Tokenization is the `bm25` crate's English tokenizer, the same stemming and
//! stopwords the default index uses, so both paths agree on what a term is.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};

use bm25::Tokenizer;

use crate::indexing::ToolFields;
use crate::search::{Bm25Params, distinct_terms, tokenizer};

/// How much one field counts, and how hard its length is normalized.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FieldParams {
    /// Multiplier on this field's term frequencies.
    pub weight: f32,
    /// Length normalization, BM25's `b`: `0.0` ignores field length entirely,
    /// `1.0` normalizes fully.
    pub b: f32,
}

/// The three ranking fields of a tool, weighted separately.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FieldWeights {
    /// The tool name, whole and identifier-split.
    pub name: FieldParams,
    /// The authored description, or the ADR-0021 searchable-description
    /// override when one is set.
    pub description: FieldParams,
    /// The semantic tokens of the input and output schemas.
    pub schema: FieldParams,
}

impl Default for FieldWeights {
    /// Provisional defaults: the name counts most and is barely
    /// length-normalized (it is a handful of tokens, and a longer name is not
    /// a worse match), schema tokens count least because they repeat across a
    /// catalog. The numbers are tuning, not contract — ADR-0025 settles them
    /// against `ratel-bench` before this graduates.
    fn default() -> Self {
        Self {
            name: FieldParams {
                weight: 2.0,
                b: 0.3,
            },
            description: FieldParams {
                weight: 1.0,
                b: 0.4,
            },
            schema: FieldParams {
                weight: 0.5,
                b: 0.6,
            },
        }
    }
}

const FIELDS: usize = 3;

/// One tool's per-field term counts and lengths.
struct FieldDoc {
    id: String,
    terms: [HashMap<String, f32>; FIELDS],
    len: [f32; FIELDS],
}

/// A prebuilt BM25F index over `(id, fields)` documents. Like [`Bm25Index`],
/// it is built once per corpus state and queried many times, ranks the full
/// corpus, and breaks ties by id.
///
/// [`Bm25Index`]: crate::search::Bm25Index
pub(crate) struct Bm25fIndex {
    docs: Vec<FieldDoc>,
    /// Tools containing each term in any field — document frequency stays
    /// corpus-level, so weighting moves only the term-frequency side of the
    /// score and IDF is what it always was.
    doc_freq: HashMap<String, f32>,
    avg_len: [f32; FIELDS],
    fields: [FieldParams; FIELDS],
    /// Term-frequency saturation, from the registry's [`Bm25Params`]. Its `b`
    /// has no meaning here: length normalisation is per field, so each field's
    /// own `b` replaces it.
    k1: f32,
}

impl Bm25fIndex {
    /// Tokenize and index `docs` field by field.
    pub(crate) fn build<I>(docs: I, weights: FieldWeights, params: Bm25Params) -> Self
    where
        I: IntoIterator<Item = (String, ToolFields)>,
    {
        let tokenizer = tokenizer();
        let mut indexed: Vec<FieldDoc> = Vec::new();
        let mut doc_freq: HashMap<String, f32> = HashMap::new();
        let mut totals = [0f32; FIELDS];

        for (id, fields) in docs {
            let texts = [fields.name, fields.description, fields.schema];
            let mut terms: [HashMap<String, f32>; FIELDS] = Default::default();
            let mut len = [0f32; FIELDS];
            for (field, text) in texts.iter().enumerate() {
                let tokens = tokenizer.tokenize(text);
                len[field] = tokens.len() as f32;
                totals[field] += len[field];
                for token in tokens {
                    *terms[field].entry(token).or_insert(0.0) += 1.0;
                }
            }
            let distinct: HashSet<&String> = terms.iter().flat_map(HashMap::keys).collect();
            for term in distinct {
                *doc_freq.entry(term.clone()).or_insert(0.0) += 1.0;
            }
            indexed.push(FieldDoc { id, terms, len });
        }

        let docs_len = indexed.len().max(1) as f32;
        let avg_len = [
            totals[0] / docs_len,
            totals[1] / docs_len,
            totals[2] / docs_len,
        ];
        Self {
            docs: indexed,
            doc_freq,
            avg_len,
            fields: [weights.name, weights.description, weights.schema],
            k1: params.k1,
        }
    }

    /// The score an average-length document containing each query term once
    /// would earn, which fusion divides by (ADR-0024). Same definition as the
    /// flattened index: a term at average length in a weight-1.0 field
    /// contributes its IDF unchanged, so both scorers normalise alike. A match
    /// in a field weighted above 1.0 can exceed it, and the caller clamps.
    pub(crate) fn query_ceiling(&self, query: &str) -> f32 {
        let corpus = self.docs.len() as f32;
        if corpus == 0.0 {
            return 0.0;
        }
        distinct_terms(query)
            .iter()
            .map(|term| {
                let df = self.doc_freq.get(term).copied().unwrap_or(0.0);
                (1.0 + (corpus - df + 0.5) / (df + 0.5)).ln()
            })
            .sum()
    }

    /// Top-`top_k` matches as `(id, score)`, best-first, ties broken by id.
    pub(crate) fn search(&self, query: &str, top_k: usize) -> Vec<(String, f32)> {
        // Distinct terms, like the flattened index: the ceiling counts each
        // term once, so the score has to as well.
        let query_terms = distinct_terms(query);
        if self.docs.is_empty() || query_terms.is_empty() {
            return Vec::new();
        }
        let corpus = self.docs.len() as f32;

        let mut ranked: Vec<(String, f32)> = self
            .docs
            .iter()
            .filter_map(|doc| {
                let mut score = 0f32;
                for term in &query_terms {
                    let Some(&df) = self.doc_freq.get(term) else {
                        continue;
                    };
                    let weighted_tf = self.weighted_tf(doc, term);
                    if weighted_tf == 0.0 {
                        continue;
                    }
                    // The crate's IDF and saturation, with the per-field sum
                    // standing in for a single document's term frequency.
                    let idf = (1.0 + (corpus - df + 0.5) / (df + 0.5)).ln();
                    score += idf * weighted_tf * (self.k1 + 1.0) / (self.k1 + weighted_tf);
                }
                (score > 0.0).then(|| (doc.id.clone(), score))
            })
            .collect();

        ranked.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(Ordering::Equal)
                .then_with(|| a.0.cmp(&b.0))
        });
        ranked.truncate(top_k);
        ranked
    }

    /// One term's term frequency summed across fields, each field normalized
    /// by its own length and scaled by its own weight.
    fn weighted_tf(&self, doc: &FieldDoc, term: &str) -> f32 {
        let mut total = 0f32;
        for (field, params) in self.fields.iter().enumerate() {
            let Some(&tf) = doc.terms[field].get(term) else {
                continue;
            };
            let avg = if self.avg_len[field] > 0.0 {
                self.avg_len[field]
            } else {
                1.0
            };
            let norm = 1.0 - params.b + params.b * (doc.len[field] / avg);
            if norm > 0.0 {
                total += params.weight * tf / norm;
            }
        }
        total
    }
}

/// Dirty-flag holder for a registry's [`Bm25fIndex`], the [`Bm25Cache`]
/// shape: every corpus mutation and every weight change invalidates it.
///
/// [`Bm25Cache`]: crate::search::Bm25Cache
pub(crate) struct Bm25fCache {
    index: Mutex<Option<Arc<Bm25fIndex>>>,
}

impl Bm25fCache {
    pub(crate) fn new() -> Self {
        Self {
            index: Mutex::new(None),
        }
    }

    pub(crate) fn get_or_build<I>(
        &self,
        weights: FieldWeights,
        params: Bm25Params,
        docs: impl FnOnce() -> I,
    ) -> Arc<Bm25fIndex>
    where
        I: IntoIterator<Item = (String, ToolFields)>,
    {
        let mut slot = self.index.lock().unwrap_or_else(PoisonError::into_inner);
        match &*slot {
            Some(index) => Arc::clone(index),
            None => {
                let index = Arc::new(Bm25fIndex::build(docs(), weights, params));
                *slot = Some(Arc::clone(&index));
                index
            }
        }
    }

    pub(crate) fn invalidate(&self) {
        *self.index.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(name: &str, description: &str, schema: &str) -> ToolFields {
        ToolFields {
            name: name.to_string(),
            description: description.to_string(),
            schema: schema.to_string(),
        }
    }

    fn index(docs: Vec<(&str, ToolFields)>, weights: FieldWeights) -> Bm25fIndex {
        Bm25fIndex::build(
            docs.into_iter().map(|(id, f)| (id.to_string(), f)),
            weights,
            Bm25Params::default(),
        )
    }

    #[test]
    fn empty_corpus_and_empty_query_rank_nothing() {
        let empty = index(Vec::new(), FieldWeights::default());
        assert!(empty.search("documentation", 5).is_empty());

        let one = index(
            vec![("docs", fields("search_docs", "search documentation", ""))],
            FieldWeights::default(),
        );
        assert!(one.search("", 5).is_empty());
    }

    #[test]
    fn equal_scores_are_ordered_by_id() {
        let weights = FieldWeights::default();
        let docs = vec![
            ("zeta", fields("zeta", "send a notification", "")),
            ("alpha", fields("alpha", "send a notification", "")),
        ];
        let ranked = index(docs, weights).search("notification", 5);
        let ids: Vec<&str> = ranked.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, ["alpha", "zeta"]);
        assert_eq!(ranked[0].1, ranked[1].1);
    }

    #[test]
    fn a_zero_weight_field_stops_contributing() {
        let weights = FieldWeights {
            description: FieldParams {
                weight: 0.0,
                b: 0.4,
            },
            ..FieldWeights::default()
        };
        let docs = vec![
            (
                "named",
                fields("weather_lookup weather lookup", "forecast", ""),
            ),
            ("described", fields("alpha", "weather lookup", "")),
        ];
        let ranked = index(docs, weights).search("weather", 5);
        let ids: Vec<&str> = ranked.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, ["named"]);
    }

    #[test]
    fn a_long_field_is_not_punished_when_its_b_is_zero() {
        let short = fields("alpha", "deployment", "");
        let long = fields(
            "beta",
            "deployment configuration notes covering staging, production, and every \
             rollout step the team takes when shipping a release",
            "",
        );

        let normalized = FieldWeights::default();
        let ranked =
            index(vec![("alpha", short), ("beta", long)], normalized).search("deployment", 5);
        assert_eq!(
            ranked[0].0, "alpha",
            "length normalization favors the short one"
        );

        let short = fields("alpha", "deployment", "");
        let long = fields(
            "beta",
            "deployment configuration notes covering staging, production, and every \
             rollout step the team takes when shipping a release",
            "",
        );
        let flat = FieldWeights {
            description: FieldParams {
                weight: 1.0,
                b: 0.0,
            },
            ..FieldWeights::default()
        };
        let ranked = index(vec![("alpha", short), ("beta", long)], flat).search("deployment", 5);
        assert_eq!(
            ranked[0].1, ranked[1].1,
            "with b = 0 the two score the same regardless of length"
        );
    }

    #[test]
    fn document_frequency_counts_a_tool_once_across_fields() {
        // "search" sits in both the name and the description of one tool. If
        // df were counted per field it would be 2 here and the term would look
        // twice as common as it is.
        let docs = vec![
            ("docs", fields("search_docs", "search documentation", "")),
            ("email", fields("send_email", "send a message", "")),
        ];
        let built = index(docs, FieldWeights::default());
        assert_eq!(built.doc_freq.get("search").copied(), Some(1.0));
    }

    #[test]
    fn the_cache_rebuilds_after_invalidate() {
        let cache = Bm25fCache::new();
        let first = cache.get_or_build(FieldWeights::default(), Bm25Params::default(), || {
            vec![(
                "docs".to_string(),
                fields("search_docs", "search documentation", ""),
            )]
        });
        let cached = cache.get_or_build(FieldWeights::default(), Bm25Params::default(), Vec::new);
        assert!(Arc::ptr_eq(&first, &cached), "second call reuses the index");

        cache.invalidate();
        let rebuilt = cache.get_or_build(FieldWeights::default(), Bm25Params::default(), || {
            vec![(
                "docs".to_string(),
                fields("search_docs", "search documentation", ""),
            )]
        });
        assert!(
            !Arc::ptr_eq(&first, &rebuilt),
            "invalidate forces a rebuild"
        );
    }
}
