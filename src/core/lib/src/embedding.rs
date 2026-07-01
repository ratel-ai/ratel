//! Local dense embedder — `bge-small-en-v1.5` run in-process via Candle.
//!
//! Pure-Rust inference (no C++/ONNX native dep), so the SDK wheels/addons stay
//! clean cross-platform. The model is BERT-family, 384-dim; we pool the `[CLS]`
//! token of the last hidden state and L2-normalize, so cosine similarity is a
//! dot product (see [`crate::dense_search`]). It is asymmetric: documents are
//! embedded plain, queries with the retrieval instruction prefix below.
//!
//! Weights are **not** bundled. On first use the model is downloaded via
//! `hf-hub` into the shared HuggingFace cache (`~/.cache/huggingface`) at a
//! pinned revision, then loaded from cache on every later run — offline after
//! the first fetch, deterministic because the revision is fixed. The model is
//! loaded once per process (kept resident for both registration and queries).
//! See ADR-0013.

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use candle_core::{DType, Device, IndexOp, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config};
use hf_hub::api::sync::{Api, ApiRepo};
use hf_hub::{Repo, RepoType};
use tokenizers::{Tokenizer, TruncationDirection, TruncationParams, TruncationStrategy};

/// bge asymmetric-retrieval query prefix; only the query side gets it.
const QUERY_INSTRUCTION: &str = "Represent this sentence for searching relevant passages: ";

/// HuggingFace repo and pinned commit for the embedding model. Pinning the
/// revision keeps embeddings reproducible across machines and over time.
const MODEL_REPO: &str = "BAAI/bge-small-en-v1.5";
const MODEL_REVISION: &str = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a";

/// Maps a tool's searchable text (and a query) to an L2-normalized vector.
/// A trait so the model is swappable — MiniLM or a static model can be dropped
/// in as alternate benchmark arms without touching the registry.
pub(crate) trait Embedder: Send + Sync {
    fn embed_doc(&self, text: &str) -> Vec<f32>;
    fn embed_query(&self, text: &str) -> Vec<f32>;
}

/// Process-wide embedder, loaded once on first use. First use triggers a model
/// download into the HF cache (later runs load from cache); a load failure is
/// thus typically a first-run network/cache problem — we fail loud rather than
/// thread a `Result` through the infallible `Embedder` API.
pub(crate) fn embedder() -> &'static dyn Embedder {
    static EMBEDDER: OnceLock<BgeSmallEmbedder> = OnceLock::new();
    EMBEDDER.get_or_init(|| {
        BgeSmallEmbedder::load()
            .expect("download/load bge-small-en-v1.5 embedder (first use needs network)")
    })
}

pub(crate) struct BgeSmallEmbedder {
    model: BertModel,
    tokenizer: Tokenizer,
    device: Device,
}

impl BgeSmallEmbedder {
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
        let config_path = fetch_cached(&repo, "config.json")?;
        let tokenizer_path = fetch_cached(&repo, "tokenizer.json")?;
        let weights_path = fetch_cached(&repo, "model.safetensors")?;

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

        // (1, seq, hidden); CLS pooling = the first token's hidden state.
        let sequence_output =
            self.model
                .forward(&input_ids, &token_type_ids, Some(&attention_mask))?;
        let cls = sequence_output.i((0, 0))?; // (hidden,)
        let vec = cls.to_vec1::<f32>()?;
        Ok(l2_normalize(vec))
    }
}

impl Embedder for BgeSmallEmbedder {
    fn embed_doc(&self, text: &str) -> Vec<f32> {
        self.embed(text).expect("embed document")
    }

    fn embed_query(&self, text: &str) -> Vec<f32> {
        self.embed(&format!("{QUERY_INSTRUCTION}{text}"))
            .expect("embed query")
    }
}

/// Resolve one model file from the HF cache, tolerating the cross-process
/// download race on a cold cache. hf-hub guards each blob with a *non-blocking*
/// `flock` and gives up after ~5s (5 × 1s); a first fetch of the ~130 MB weights
/// takes longer, so when several processes load the embedder at once on a cold
/// cache — parallel test workers, a web server's worker pool cold-starting,
/// `multiprocessing` — every process but the lock holder gets `LockAcquisition`
/// and, through the infallible [`Embedder`] API, aborts. Retry with backoff: the
/// losers wait for the winner's download to land, then `get()` returns the
/// now-cached blob without locking (hf-hub checks the cache before it locks).
/// Non-lock errors (network, 404, disk) are returned immediately. See ADR-0013.
fn fetch_cached(repo: &ApiRepo, file: &str) -> candle_core::Result<PathBuf> {
    // ~30 × (up to hf-hub's own ~5s lock wait + 1s backoff) comfortably outlasts
    // a single cold-cache download; the loser normally succeeds within a few.
    const MAX_ATTEMPTS: u32 = 30;
    const BACKOFF: Duration = Duration::from_secs(1);

    let mut attempt = 1;
    loop {
        match repo.get(file) {
            Ok(path) => return Ok(path),
            Err(e) => {
                let msg = e.to_string();
                if attempt < MAX_ATTEMPTS && is_lock_contention(&msg) {
                    attempt += 1;
                    std::thread::sleep(BACKOFF);
                    continue;
                }
                return Err(candle_core::Error::Msg(msg));
            }
        }
    }
}

/// True only when an hf-hub fetch failed because another process holds the
/// download lock — the one error worth retrying, since the blob appears once the
/// winner finishes. Every other failure is terminal and returned as-is.
fn is_lock_contention(err: &str) -> bool {
    err.contains("Lock acquisition failed")
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
    fn only_lock_contention_is_retried() {
        // The cold-cache download race: retry and wait for the winner.
        assert!(is_lock_contention(
            "Lock acquisition failed: /home/u/.cache/huggingface/hub/models--BAAI--bge-small-en-v1.5/blobs/abc.lock"
        ));
        // Everything else is terminal — fail loud, don't spin.
        assert!(!is_lock_contention("request error: connection refused"));
        assert!(!is_lock_contention("Http(reqwest::Error { status: 404 })"));
        assert!(!is_lock_contention(
            "No such file or directory (os error 2)"
        ));
    }

    #[test]
    fn embeds_to_unit_norm_384_vectors_deterministically() {
        let e = embedder();
        let a = e.embed_doc("read a file from disk");
        let b = e.embed_doc("read a file from disk");
        assert_eq!(a.len(), 384, "bge-small is 384-dim");
        assert_eq!(a, b, "same text must embed identically (determinism)");
        let norm = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-3, "expected unit norm, got {norm}");
    }

    #[test]
    fn query_prefix_changes_the_embedding() {
        let e = embedder();
        let doc = e.embed_doc("delete a file");
        let query = e.embed_query("delete a file");
        assert_ne!(doc, query, "query instruction prefix must shift the vector");
    }

    #[test]
    fn ranks_synonyms_above_lexically_unrelated_text() {
        // The "missing gold" case BM25 can't see: query and doc share no words.
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
