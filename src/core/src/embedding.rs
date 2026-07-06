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
//!
//! **Footprint & failure modes.** The resident model is ~130 MB of f32 weights
//! plus BERT runtime buffers, and inference is CPU-only, so a constrained
//! machine may load or embed slowly — surfaced as a [`TraceEvent::EmbedderLoad`]
//! with status `slow` — or, if it runs out of memory, be killed by the OS (an
//! uncatchable SIGKILL, nothing we can flag). Load and inference are otherwise
//! **fallible**: a failure returns a typed [`EmbedderError`] (network, unwritable
//! cache, corrupt weights, inference) rather than aborting the process, and a
//! failed load is **not cached**, so a later call retries once the cause clears.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use candle_core::{DType, Device, IndexOp, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config};
use hf_hub::api::sync::{ApiBuilder, ApiRepo};
use hf_hub::{Repo, RepoType};
use tokenizers::{Tokenizer, TruncationDirection, TruncationParams, TruncationStrategy};

use crate::trace::{EmbedderLoadStatus, TraceEvent, TraceSink};

/// bge asymmetric-retrieval query prefix; only the query side gets it.
const QUERY_INSTRUCTION: &str = "Represent this sentence for searching relevant passages: ";

/// HuggingFace repo and pinned commit for the embedding model. Pinning the
/// revision keeps embeddings reproducible across machines and over time.
const MODEL_REPO: &str = "BAAI/bge-small-en-v1.5";
const MODEL_REVISION: &str = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a";

/// Default cold-load latency (ms) above which the load is flagged `slow`, a hint
/// that the machine may be underpowered. Override with `RATEL_EMBED_SLOW_MS`.
const DEFAULT_SLOW_LOAD_MS: u64 = 5_000;

/// Human-readable reason attached to a `slow` load event.
const SLOW_LOAD_REASON: &str = "embedding model load was slow — this machine may be underpowered \
     for bge-small-en-v1.5 (~130 MB, CPU inference); expect slow registration and search";

/// A recoverable embedder failure. Returned instead of panicking so a load or
/// inference problem surfaces to the SDK as a **catchable** error (with a
/// remediation hint in `Display`) rather than aborting the host process.
#[derive(Debug, Clone)]
pub enum EmbedderError {
    /// Model files could not be fetched: offline, DNS/TLS, timeout, or the
    /// pinned revision returned a 4xx.
    Download { model: String, source: String },
    /// The HuggingFace cache could not be written: permissions, disk full, or a
    /// read-only filesystem.
    CacheUnwritable { source: String },
    /// The fetched model is unusable: corrupt weights, or a config/tokenizer that
    /// failed to parse.
    Load { model: String, source: String },
    /// Embedding a specific text failed (tokenization or the forward pass).
    Inference { source: String },
    /// A semantic/hybrid search was requested but the embedding cache is not
    /// built for the current corpus — the registry was never warmed. No model is
    /// loaded; the caller must opt into embeddings first.
    NotWarmed,
}

impl EmbedderError {
    /// One-line remediation hint, embedded in the `Display` message.
    fn hint(&self) -> &'static str {
        match self {
            EmbedderError::Download { .. } => {
                "check network connectivity and that the model id + revision exist"
            }
            EmbedderError::CacheUnwritable { .. } => {
                "check ~/.cache/huggingface permissions and free disk space (or set HF_HOME)"
            }
            EmbedderError::Load { .. } => "clear the cached model so it re-downloads",
            EmbedderError::Inference { .. } => {
                "the machine may be underpowered for this embedding model"
            }
            EmbedderError::NotWarmed => {
                "construct the catalog with method=\"semantic\"/\"hybrid\" or call warm() first"
            }
        }
    }
}

impl std::fmt::Display for EmbedderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let hint = self.hint();
        match self {
            EmbedderError::Download { model, source } => write!(
                f,
                "failed to download embedding model {model}: {source} (hint: {hint})"
            ),
            EmbedderError::CacheUnwritable { source } => write!(
                f,
                "embedding model cache is not writable: {source} (hint: {hint})"
            ),
            EmbedderError::Load { model, source } => write!(
                f,
                "failed to load embedding model {model}: {source} (hint: {hint})"
            ),
            EmbedderError::Inference { source } => {
                write!(f, "embedding failed: {source} (hint: {hint})")
            }
            EmbedderError::NotWarmed => {
                write!(
                    f,
                    "embeddings are not computed for semantic search (hint: {hint})"
                )
            }
        }
    }
}

impl std::error::Error for EmbedderError {}

/// Maps a tool's searchable text (and a query) to an L2-normalized vector.
/// A trait so the model is swappable — MiniLM or a static model can be dropped
/// in as alternate benchmark arms without touching the registry.
pub(crate) trait Embedder: Send + Sync {
    fn embed_doc(&self, text: &str) -> Result<Vec<f32>, EmbedderError>;
    fn embed_query(&self, text: &str) -> Result<Vec<f32>, EmbedderError>;
}

/// Process-wide embedder, loaded once on first use. A failed load is **not**
/// cached (the slot stays empty), so a later call retries — a transient network
/// blip must not poison the model for the whole process. Returns the shared
/// embedder plus the cold-load latency: `Some(ms)` only on the call that
/// actually loaded, `None` on warm reuse, so load telemetry fires exactly once.
pub(crate) fn embedder() -> Result<(Arc<dyn Embedder>, Option<u64>), EmbedderError> {
    static CELL: OnceLock<Mutex<Option<Arc<BgeSmallEmbedder>>>> = OnceLock::new();
    let slot = CELL.get_or_init(|| Mutex::new(None));
    let (emb, load_ms) = get_or_load(slot, BgeSmallEmbedder::load)?;
    let emb: Arc<dyn Embedder> = emb;
    Ok((emb, load_ms))
}

/// Load-once-into-a-slot with **no failure caching**: on `Err` the slot stays
/// empty so a later call retries. Returns the value plus `Some(load_ms)` on the
/// call that performed the load, `None` on warm reuse. Generic so the
/// non-poisoning contract is unit-tested without touching the network.
fn get_or_load<T, E>(
    slot: &Mutex<Option<Arc<T>>>,
    load: impl FnOnce() -> Result<T, E>,
) -> Result<(Arc<T>, Option<u64>), E> {
    let mut guard = slot.lock().expect("embedder mutex poisoned");
    if let Some(existing) = guard.as_ref() {
        return Ok((existing.clone(), None));
    }
    let started = Instant::now();
    let loaded = Arc::new(load()?);
    let took_ms = started.elapsed().as_millis() as u64;
    *guard = Some(loaded.clone());
    Ok((loaded, Some(took_ms)))
}

/// Resolve the process embedder and record the one-time load-telemetry event on
/// `sink` (a slow/failed load is also logged to stderr). Registries call this so
/// the [`TraceEvent::EmbedderLoad`] flag is emitted from the layer that owns a
/// sink; the embedder itself stays sink-agnostic.
pub(crate) fn embedder_with_telemetry(
    sink: &dyn TraceSink,
) -> Result<Arc<dyn Embedder>, EmbedderError> {
    let (result, load_ms) = match embedder() {
        Ok((emb, ms)) => (Ok(emb), ms),
        Err(e) => (Err(e), None),
    };
    if let Some(event) = embedder_load_event(load_ms, result.as_ref().err()) {
        if let TraceEvent::EmbedderLoad {
            status,
            took_ms,
            reason,
            ..
        } = &event
            && !matches!(status, EmbedderLoadStatus::Ok)
        {
            eprintln!(
                "ratel: embedding model load {status:?} ({took_ms}ms): {}",
                reason.as_deref().unwrap_or("")
            );
        }
        sink.record(event);
    }
    result
}

/// Decide the load-telemetry event for a cold-load outcome. `None` on warm reuse
/// (no `load_ms`, no error). Pure, so the slow/failed thresholding is unit-tested
/// without the network.
fn embedder_load_event(load_ms: Option<u64>, error: Option<&EmbedderError>) -> Option<TraceEvent> {
    match (load_ms, error) {
        (_, Some(err)) => Some(TraceEvent::EmbedderLoad {
            model: MODEL_REPO.to_string(),
            status: EmbedderLoadStatus::Failed,
            took_ms: load_ms.unwrap_or(0),
            reason: Some(err.to_string()),
        }),
        (Some(ms), None) => {
            let slow = ms > slow_load_ms();
            Some(TraceEvent::EmbedderLoad {
                model: MODEL_REPO.to_string(),
                status: if slow {
                    EmbedderLoadStatus::Slow
                } else {
                    EmbedderLoadStatus::Ok
                },
                took_ms: ms,
                reason: slow.then(|| SLOW_LOAD_REASON.to_string()),
            })
        }
        (None, None) => None,
    }
}

fn slow_load_ms() -> u64 {
    std::env::var("RATEL_EMBED_SLOW_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_SLOW_LOAD_MS)
}

pub(crate) struct BgeSmallEmbedder {
    model: BertModel,
    tokenizer: Tokenizer,
    device: Device,
}

impl BgeSmallEmbedder {
    fn load() -> Result<Self, EmbedderError> {
        Self::load_from(MODEL_REPO, MODEL_REVISION)
    }

    /// Parameterized loader (repo + revision) so tests can force a deterministic
    /// download failure against a bogus revision without hardcoding the default.
    fn load_from(repo_id: &str, revision: &str) -> Result<Self, EmbedderError> {
        let device = Device::Cpu;

        // Resolve the three model files from the HuggingFace cache, downloading
        // them on first use. `get` returns a path to the cached blob; with a
        // pinned revision, later runs hit the cache without re-downloading.
        // `from_env` honors `HF_HOME` (cache location) and `HF_ENDPOINT` (mirror
        // / offline proxy) — see the `CacheUnwritable` hint and offline setups.
        let api = ApiBuilder::from_env()
            .build()
            .map_err(|e| EmbedderError::Download {
                model: repo_id.to_string(),
                source: e.to_string(),
            })?;
        let repo = api.repo(Repo::with_revision(
            repo_id.to_string(),
            RepoType::Model,
            revision.to_string(),
        ));
        let config_path = fetch_cached(&repo, "config.json", repo_id)?;
        let tokenizer_path = fetch_cached(&repo, "tokenizer.json", repo_id)?;
        let weights_path = fetch_cached(&repo, "model.safetensors", repo_id)?;

        let load_err = |source: String| EmbedderError::Load {
            model: repo_id.to_string(),
            source,
        };

        let config_bytes = std::fs::read(config_path).map_err(|e| load_err(e.to_string()))?;
        let config: Config =
            serde_json::from_slice(&config_bytes).map_err(|e| load_err(e.to_string()))?;

        let mut tokenizer =
            Tokenizer::from_file(tokenizer_path).map_err(|e| load_err(e.to_string()))?;
        // Cap at the model's positional limit so long tool text can't index past
        // the position embeddings.
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: config.max_position_embeddings,
                strategy: TruncationStrategy::LongestFirst,
                direction: TruncationDirection::Right,
                stride: 0,
            }))
            .map_err(|e| load_err(e.to_string()))?;

        // Upstream weights are f32; load them directly for reproducible CPU math.
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[weights_path], DType::F32, &device)
                .map_err(|e| load_err(e.to_string()))?
        };
        let model = BertModel::load(vb, &config).map_err(|e| load_err(e.to_string()))?;
        Ok(Self {
            model,
            tokenizer,
            device,
        })
    }

    fn embed(&self, text: &str) -> Result<Vec<f32>, EmbedderError> {
        self.embed_inner(text)
            .map_err(|e| EmbedderError::Inference {
                source: e.to_string(),
            })
    }

    fn embed_inner(&self, text: &str) -> candle_core::Result<Vec<f32>> {
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
    fn embed_doc(&self, text: &str) -> Result<Vec<f32>, EmbedderError> {
        self.embed(text)
    }

    fn embed_query(&self, text: &str) -> Result<Vec<f32>, EmbedderError> {
        self.embed(&format!("{QUERY_INSTRUCTION}{text}"))
    }
}

/// Resolve one model file from the HF cache, tolerating the cross-process
/// download race on a cold cache. hf-hub guards each blob with a *non-blocking*
/// `flock` and gives up after ~5s (5 × 1s); a first fetch of the ~130 MB weights
/// takes longer, so when several processes load the embedder at once on a cold
/// cache — parallel test workers, a web server's worker pool cold-starting,
/// `multiprocessing` — every process but the lock holder gets `LockAcquisition`
/// and would fail. Retry with backoff: the losers wait for the winner's download
/// to land, then `get()` returns the now-cached blob without locking (hf-hub
/// checks the cache before it locks). Any other failure is classified and
/// returned immediately. See ADR-0013.
fn fetch_cached(repo: &ApiRepo, file: &str, model: &str) -> Result<PathBuf, EmbedderError> {
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
                return Err(classify_fetch_error(model, &msg));
            }
        }
    }
}

/// True only when an hf-hub fetch failed because another process holds the
/// download lock — the one error worth retrying, since the blob appears once the
/// winner finishes. Every other failure is terminal and classified below.
fn is_lock_contention(err: &str) -> bool {
    err.contains("Lock acquisition failed")
}

/// Map an hf-hub fetch error string to a typed [`EmbedderError`]. A cache
/// permission/space problem is distinct (and actionable) from a network/model
/// problem; everything else is treated as a download failure.
fn classify_fetch_error(model: &str, msg: &str) -> EmbedderError {
    let lower = msg.to_lowercase();
    let unwritable = lower.contains("permission denied")
        || lower.contains("read-only")
        || lower.contains("no space")
        || lower.contains("os error 13") // EACCES
        || lower.contains("os error 28") // ENOSPC
        || lower.contains("os error 30"); // EROFS
    if unwritable {
        EmbedderError::CacheUnwritable {
            source: msg.to_string(),
        }
    } else {
        EmbedderError::Download {
            model: model.to_string(),
            source: msg.to_string(),
        }
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
    fn only_lock_contention_is_retried() {
        // The cold-cache download race: retry and wait for the winner.
        assert!(is_lock_contention(
            "Lock acquisition failed: /home/u/.cache/huggingface/hub/models--BAAI--bge-small-en-v1.5/blobs/abc.lock"
        ));
        // Everything else is terminal — classify, don't spin.
        assert!(!is_lock_contention("request error: connection refused"));
        assert!(!is_lock_contention("Http(reqwest::Error { status: 404 })"));
        assert!(!is_lock_contention(
            "No such file or directory (os error 2)"
        ));
    }

    #[test]
    fn classifies_cache_permission_and_space_as_unwritable() {
        assert!(matches!(
            classify_fetch_error("m", "Permission denied (os error 13)"),
            EmbedderError::CacheUnwritable { .. }
        ));
        assert!(matches!(
            classify_fetch_error("m", "No space left on device (os error 28)"),
            EmbedderError::CacheUnwritable { .. }
        ));
        assert!(matches!(
            classify_fetch_error("m", "Read-only file system (os error 30)"),
            EmbedderError::CacheUnwritable { .. }
        ));
    }

    #[test]
    fn classifies_network_and_http_as_download() {
        assert!(matches!(
            classify_fetch_error("m", "error sending request: dns error: failed to lookup"),
            EmbedderError::Download { .. }
        ));
        assert!(matches!(
            classify_fetch_error("m", "Http status client error (404 Not Found)"),
            EmbedderError::Download { .. }
        ));
    }

    #[test]
    fn error_display_carries_source_and_hint() {
        let s = EmbedderError::Download {
            model: "BAAI/x".into(),
            source: "connection refused".into(),
        }
        .to_string();
        assert!(s.contains("connection refused"), "got: {s}");
        assert!(s.contains("hint:"), "got: {s}");
    }

    #[test]
    fn get_or_load_does_not_cache_failure_and_reports_latency_once() {
        let slot: Mutex<Option<Arc<i32>>> = Mutex::new(None);
        // A failed load must NOT be cached.
        assert!(get_or_load(&slot, || Err::<i32, &str>("boom")).is_err());
        // The next call retries and loads; it reports the load latency.
        let (v, ms) = get_or_load(&slot, || Ok::<i32, &str>(7)).unwrap();
        assert_eq!(*v, 7);
        assert!(ms.is_some(), "the loading call reports latency");
        // Warm reuse keeps the first value and reports no latency.
        let (v2, ms2) = get_or_load(&slot, || Ok::<i32, &str>(999)).unwrap();
        assert_eq!(*v2, 7);
        assert!(ms2.is_none(), "warm reuse reports no load latency");
    }

    #[test]
    fn load_event_flags_slow_ok_failed_and_warm() {
        // Above the 5s default → slow (underpowered-machine flag).
        assert!(matches!(
            embedder_load_event(Some(10_000), None),
            Some(TraceEvent::EmbedderLoad {
                status: EmbedderLoadStatus::Slow,
                took_ms: 10_000,
                ..
            })
        ));
        // Comfortably under → ok.
        assert!(matches!(
            embedder_load_event(Some(5), None),
            Some(TraceEvent::EmbedderLoad {
                status: EmbedderLoadStatus::Ok,
                ..
            })
        ));
        // A load error → failed, carrying the reason.
        let err = EmbedderError::Inference { source: "x".into() };
        assert!(matches!(
            embedder_load_event(None, Some(&err)),
            Some(TraceEvent::EmbedderLoad {
                status: EmbedderLoadStatus::Failed,
                ..
            })
        ));
        // Warm reuse → no event.
        assert!(embedder_load_event(None, None).is_none());
    }

    #[test]
    fn embeds_to_unit_norm_384_vectors_deterministically() {
        let (e, _) = embedder().expect("load embedder");
        let a = e.embed_doc("read a file from disk").expect("embed");
        let b = e.embed_doc("read a file from disk").expect("embed");
        assert_eq!(a.len(), 384, "bge-small is 384-dim");
        assert_eq!(a, b, "same text must embed identically (determinism)");
        let norm = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-3, "expected unit norm, got {norm}");
    }

    #[test]
    fn query_prefix_changes_the_embedding() {
        let (e, _) = embedder().expect("load embedder");
        let doc = e.embed_doc("delete a file").expect("embed");
        let query = e.embed_query("delete a file").expect("embed");
        assert_ne!(doc, query, "query instruction prefix must shift the vector");
    }

    #[test]
    fn ranks_synonyms_above_lexically_unrelated_text() {
        // The "missing gold" case BM25 can't see: query and doc share no words.
        let (e, _) = embedder().expect("load embedder");
        let q = e.embed_query("remove a file").expect("embed");
        let delete = e
            .embed_doc("delete a path from the filesystem")
            .expect("embed");
        let weather = e
            .embed_doc("get the current weather forecast")
            .expect("embed");
        let dot = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
        assert!(
            dot(&q, &delete) > dot(&q, &weather),
            "semantic match should beat an unrelated tool"
        );
    }
}
