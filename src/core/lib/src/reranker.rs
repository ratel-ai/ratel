//! Cross-encoder reranker — `ms-marco-MiniLM-L6-v2` run in-process via Candle.
//!
//! The last stage of the hybrid pipeline (see [`crate::tool_registry`] and
//! ADR-0013). Where the bi-encoder ([`crate::embedding`]) embeds query and
//! document *separately* and compares vectors, a cross-encoder feeds the
//! `(query, document)` pair through one BERT pass so attention crosses the two —
//! markedly more accurate, but one forward pass per candidate, so it runs only
//! over the bounded RRF candidate pool, never the whole corpus.
//!
//! The checkpoint is `BertForSequenceClassification` with a single-logit head:
//! `bert` (embeddings + encoder + pooler) → `classifier` linear (hidden → 1).
//! Candle's [`BertModel`] gives us the encoder's last hidden state; we load the
//! pooler and classifier heads from the same safetensors and apply them by hand.
//! The raw logit is the relevance score (the checkpoint's default activation is
//! Identity — higher = more relevant).
//!
//! Like the bi-encoder: pure-Rust Candle (no ONNX/C++), CPU + f32, weights
//! downloaded once on first use into the shared HuggingFace cache at a pinned
//! revision and resident for the process lifetime — deterministic and offline
//! after the first fetch.

use std::sync::OnceLock;

use candle_core::{DType, Device, IndexOp, Tensor};
use candle_nn::{Linear, Module, VarBuilder};
use candle_transformers::models::bert::{BertModel, Config};
use hf_hub::api::sync::Api;
use hf_hub::{Repo, RepoType};
use tokenizers::{Tokenizer, TruncationDirection, TruncationParams, TruncationStrategy};

/// HuggingFace repo and pinned commit for the cross-encoder. Pinning keeps
/// rerank scores reproducible across machines and over time.
const RERANK_REPO: &str = "cross-encoder/ms-marco-MiniLM-L6-v2";
const RERANK_REVISION: &str = "c5ee24cb16019beea0893ab7796b1df96625c6b8";

/// Scores `(query, document)` pairs by joint relevance. A trait so the model is
/// swappable without touching the registry, mirroring [`crate::embedding::Embedder`].
pub(crate) trait Reranker: Send + Sync {
    /// Relevance logit per candidate (higher = more relevant), returned in the
    /// **input order** — the caller applies the shared `(score desc, id asc)`
    /// ordering ([`crate::fusion::sort_and_truncate`]). `candidates` are
    /// `(id, searchable_text)`: the same ADR-0004 flattened text BM25 and the
    /// embedder index.
    fn rerank(&self, query: &str, candidates: &[(String, String)]) -> Vec<(String, f32)>;
}

/// Process-wide reranker, loaded once on first use. As with [`crate::embedding::embedder`],
/// a load failure is almost always a first-run network/cache problem, so we fail
/// loud rather than thread a `Result` through the infallible `Reranker` API.
pub(crate) fn reranker() -> &'static dyn Reranker {
    static RERANKER: OnceLock<MiniLmCrossEncoder> = OnceLock::new();
    RERANKER.get_or_init(|| {
        MiniLmCrossEncoder::load()
            .expect("download/load ms-marco-MiniLM-L6-v2 reranker (first use needs network)")
    })
}

pub(crate) struct MiniLmCrossEncoder {
    model: BertModel,
    pooler: Linear,
    classifier: Linear,
    tokenizer: Tokenizer,
    device: Device,
}

impl MiniLmCrossEncoder {
    fn load() -> candle_core::Result<Self> {
        let device = Device::Cpu;

        let api = Api::new().map_err(|e| candle_core::Error::Msg(e.to_string()))?;
        let repo = api.repo(Repo::with_revision(
            RERANK_REPO.to_string(),
            RepoType::Model,
            RERANK_REVISION.to_string(),
        ));
        let config_path = repo
            .get("config.json")
            .map_err(|e| candle_core::Error::Msg(e.to_string()))?;
        let tokenizer_path = repo
            .get("tokenizer.json")
            .map_err(|e| candle_core::Error::Msg(e.to_string()))?;
        let weights_path = repo
            .get("model.safetensors")
            .map_err(|e| candle_core::Error::Msg(e.to_string()))?;

        let config: Config =
            serde_json::from_slice(&std::fs::read(config_path).map_err(candle_core::Error::wrap)?)
                .map_err(|e| candle_core::Error::Msg(e.to_string()))?;

        let mut tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|e| candle_core::Error::Msg(e.to_string()))?;
        // Cap the *pair* at the model's positional limit; LongestFirst trims the
        // longer of (query, doc) so neither side can index past the position
        // embeddings.
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: config.max_position_embeddings,
                strategy: TruncationStrategy::LongestFirst,
                direction: TruncationDirection::Right,
                stride: 0,
            }))
            .map_err(|e| candle_core::Error::Msg(e.to_string()))?;

        // `BertForSequenceClassification` nests the encoder under `bert.*`; the
        // pooler and single-logit classifier head live alongside it and are not
        // part of candle's `BertModel`, so we load them by hand from the same
        // safetensors (keys verified: `bert.pooler.dense.*`, `classifier.*`).
        let vb =
            unsafe { VarBuilder::from_mmaped_safetensors(&[weights_path], DType::F32, &device)? };
        let model = BertModel::load(vb.pp("bert"), &config)?;
        let hidden = config.hidden_size;
        let pooler = candle_nn::linear(hidden, hidden, vb.pp("bert").pp("pooler").pp("dense"))?;
        let classifier = candle_nn::linear(hidden, 1, vb.pp("classifier"))?;
        Ok(Self {
            model,
            pooler,
            classifier,
            tokenizer,
            device,
        })
    }

    fn score(&self, query: &str, doc: &str) -> candle_core::Result<f32> {
        // Pair encoding lays out `[CLS] query [SEP] doc [SEP]` with segment ids
        // 0 for the query side and 1 for the doc side — the cross-encoder relies
        // on those segment embeddings, so (unlike the bi-encoder) we pass the
        // real type ids rather than zeros.
        let encoding = self
            .tokenizer
            .encode((query, doc), true)
            .map_err(|e| candle_core::Error::Msg(e.to_string()))?;
        let input_ids = Tensor::new(encoding.get_ids(), &self.device)?.unsqueeze(0)?; // (1, seq)
        let token_type_ids = Tensor::new(encoding.get_type_ids(), &self.device)?.unsqueeze(0)?;
        let attention_mask =
            Tensor::new(encoding.get_attention_mask(), &self.device)?.unsqueeze(0)?;

        let sequence_output =
            self.model
                .forward(&input_ids, &token_type_ids, Some(&attention_mask))?;
        // CLS token → pooler (dense + tanh) → classifier (hidden → 1 logit).
        let cls = sequence_output.i((.., 0))?; // (1, hidden)
        let pooled = self.pooler.forward(&cls)?.tanh()?;
        let logit = self.classifier.forward(&pooled)?; // (1, 1)
        let score = logit.flatten_all()?.to_vec1::<f32>()?[0];
        Ok(score)
    }
}

impl Reranker for MiniLmCrossEncoder {
    fn rerank(&self, query: &str, candidates: &[(String, String)]) -> Vec<(String, f32)> {
        candidates
            .iter()
            .map(|(id, text)| (id.clone(), self.score(query, text).expect("rerank score")))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scores_a_relevant_doc_above_an_unrelated_one() {
        let r = reranker();
        let scored = r.rerank(
            "how do I remove a file",
            &[
                ("delete".into(), "delete a path from the filesystem".into()),
                ("weather".into(), "get the current weather forecast".into()),
            ],
        );
        let delete = scored.iter().find(|(id, _)| id == "delete").unwrap().1;
        let weather = scored.iter().find(|(id, _)| id == "weather").unwrap().1;
        assert!(
            delete > weather,
            "cross-encoder should rank the relevant doc higher (delete={delete}, weather={weather})"
        );
    }

    #[test]
    fn rerank_preserves_input_order_and_is_deterministic() {
        let r = reranker();
        let cands: Vec<(String, String)> = vec![
            ("a".into(), "compose and send an email message".into()),
            ("b".into(), "delete a path from the filesystem".into()),
        ];
        let first = r.rerank("send an email", &cands);
        let second = r.rerank("send an email", &cands);
        assert_eq!(
            first.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"],
            "scores are returned in input order"
        );
        assert_eq!(first, second, "same input must score identically");
    }
}
