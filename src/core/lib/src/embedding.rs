//! Local dense embedder — `all-MiniLM-L6-v2` run in-process via Candle.
//!
//! Pure-Rust inference (no C++/ONNX native dep), so the SDK wheels/addons stay
//! clean cross-platform. The model is BERT-family, 384-dim; we **mean-pool** the
//! last hidden state and L2-normalize, so cosine similarity is a dot product
//! (see [`crate::dense_search`]). MiniLM is **symmetric** — query and document
//! are embedded the same way, no instruction prefix.
//!
//! Weights are **not** bundled. On first use the model is downloaded via
//! `hf-hub` into the shared HuggingFace cache (`~/.cache/huggingface`) at a
//! pinned revision, then loaded from cache on every later run — offline after
//! the first fetch, deterministic because the revision is fixed. The model is
//! loaded once per process (kept resident for both registration and queries).
//! The model used is the experiment variable for this crate version (ADR-0013).

use std::sync::OnceLock;

use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config};
use hf_hub::api::sync::Api;
use hf_hub::{Repo, RepoType};
use tokenizers::{Tokenizer, TruncationDirection, TruncationParams, TruncationStrategy};

/// HuggingFace repo and pinned commit for the embedding model. Pinning the
/// revision keeps embeddings reproducible across machines and over time.
const MODEL_REPO: &str = "sentence-transformers/all-MiniLM-L6-v2";
const MODEL_REVISION: &str = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41";

/// Maps a tool's searchable text (and a query) to an L2-normalized vector.
/// A trait so the model is swappable per experiment without touching the
/// registry.
pub(crate) trait Embedder: Send + Sync {
    fn embed_doc(&self, text: &str) -> Vec<f32>;
    fn embed_query(&self, text: &str) -> Vec<f32>;
}

/// Process-wide embedder, loaded once on first use. First use triggers a model
/// download into the HF cache (later runs load from cache); a load failure is
/// thus typically a first-run network/cache problem — we fail loud rather than
/// thread a `Result` through the infallible `Embedder` API.
pub(crate) fn embedder() -> &'static dyn Embedder {
    static EMBEDDER: OnceLock<BertEmbedder> = OnceLock::new();
    EMBEDDER.get_or_init(|| {
        BertEmbedder::load().expect("download/load embedding model (first use needs network)")
    })
}

pub(crate) struct BertEmbedder {
    model: BertModel,
    tokenizer: Tokenizer,
    device: Device,
}

impl BertEmbedder {
    fn load() -> candle_core::Result<Self> {
        let device = Device::Cpu;

        // Resolve the three model files from the HuggingFace cache, downloading
        // them on first use. `get` returns a path to the cached blob; with a
        // pinned revision, later runs hit the cache without re-downloading.
        let api = Api::new().map_err(|e| candle_core::Error::Msg(e.to_string()))?;
        let repo = api.repo(Repo::with_revision(
            MODEL_REPO.to_string(),
            RepoType::Model,
            MODEL_REVISION.to_string(),
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
        // Cap at the model's positional limit so long tool text can't index past
        // the position embeddings.
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: config.max_position_embeddings,
                strategy: TruncationStrategy::LongestFirst,
                direction: TruncationDirection::Right,
                stride: 0,
            }))
            .map_err(|e| candle_core::Error::Msg(e.to_string()))?;

        // Upstream weights are f32; load them directly for reproducible CPU math.
        let vb =
            unsafe { VarBuilder::from_mmaped_safetensors(&[weights_path], DType::F32, &device)? };
        let model = BertModel::load(vb, &config)?;
        Ok(Self {
            model,
            tokenizer,
            device,
        })
    }

    fn embed(&self, text: &str) -> candle_core::Result<Vec<f32>> {
        let encoding = self
            .tokenizer
            .encode(text, true)
            .map_err(|e| candle_core::Error::Msg(e.to_string()))?;
        let ids = encoding.get_ids();
        let input_ids = Tensor::new(ids, &self.device)?.unsqueeze(0)?; // (1, seq)
        let token_type_ids = input_ids.zeros_like()?;
        let mask: Vec<u32> = encoding.get_attention_mask().to_vec();
        let attention_mask = Tensor::new(mask.as_slice(), &self.device)?.unsqueeze(0)?;

        // (1, seq, hidden). Mean-pool over the token dimension — exact here since
        // a single sequence has no padding (every attention-mask entry is 1).
        let sequence_output =
            self.model
                .forward(&input_ids, &token_type_ids, Some(&attention_mask))?;
        let pooled = sequence_output.mean(1)?.squeeze(0)?; // (hidden,)
        let vec = pooled.to_vec1::<f32>()?;
        Ok(l2_normalize(vec))
    }
}

impl Embedder for BertEmbedder {
    fn embed_doc(&self, text: &str) -> Vec<f32> {
        self.embed(text).expect("embed document")
    }

    // MiniLM is symmetric — the query is embedded exactly like a document.
    fn embed_query(&self, text: &str) -> Vec<f32> {
        self.embed(text).expect("embed query")
    }
}

/// Scale to unit L2 norm so downstream cosine similarity is a plain dot product.
/// A zero vector is returned unchanged (no NaNs).
fn l2_normalize(mut v: Vec<f32>) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in &mut v {
            *x /= norm;
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embeds_to_unit_norm_384_vectors_deterministically() {
        let e = embedder();
        let a = e.embed_doc("read a file from disk");
        let b = e.embed_doc("read a file from disk");
        assert_eq!(a.len(), 384, "MiniLM-L6 is 384-dim");
        assert_eq!(a, b, "same text must embed identically (determinism)");
        let norm = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-3, "expected unit norm, got {norm}");
    }

    #[test]
    fn query_and_doc_are_symmetric() {
        // MiniLM applies no query instruction, so both sides embed identically.
        let e = embedder();
        assert_eq!(e.embed_query("delete a file"), e.embed_doc("delete a file"));
    }

    #[test]
    fn ranks_synonyms_above_lexically_unrelated_text() {
        // The "missing gold" case lexical search can't see: query and doc share
        // no words.
        let e = embedder();
        let q = e.embed_query("remove a file");
        let delete = e.embed_doc("delete a path from the filesystem");
        let weather = e.embed_doc("get the current weather forecast");
        let dot = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
        assert!(
            dot(&q, &delete) > dot(&q, &weather),
            "semantic match should beat an unrelated tool"
        );
    }
}
