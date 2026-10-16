//! NAPI binding to `ratel-ai-rankers`: the decision-model rankers behind
//! `@ratel-ai/rankers-plugin` (ADR-0028). One class serves every vendor; the
//! TS plugins wrap its `rankAsync` into retrieve/rerank functions.

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;
use ratel_ai_rankers as rankers;
use serde_json::json;

/// Private NAPI→TypeScript transport prefix for ranker errors. Must stay
/// identical to the constant in `src/rankers/ts/src/adapter.ts`.
const RETRIEVER_ERROR_PREFIX: &str = "RATEL_RETRIEVER_ERROR:";

/// A catalog item offered to a ranker.
#[napi(object)]
pub struct RankCandidate {
    pub id: String,
    pub text: String,
}

/// One id a ranker scored.
#[napi(object)]
pub struct RankedId {
    pub id: String,
    pub score: f64,
}

/// Where a ranker sends requests; unset fields keep the vendor's defaults.
#[napi(object)]
pub struct ChoiceRankerConfig {
    pub url: Option<String>,
    pub api_key_env: Option<String>,
    pub model: Option<String>,
}

/// The Jev model asked by default.
#[napi]
pub const DEFAULT_JEV_MODEL: &str = rankers::DEFAULT_JEV_MODEL;

/// The Decisions model the OpenAI Decisions plugin asks by default, the only
/// one the beta supports.
#[napi]
pub const DEFAULT_OPENAI_DECISION_MODEL: &str = rankers::DEFAULT_OPENAI_DECISION_MODEL;

/// The vendor ids this build ships.
#[napi]
pub fn vendors() -> Vec<String> {
    rankers::vendors().into_iter().map(String::from).collect()
}

/// A failure travels in a private envelope so TS can raise a typed
/// `RetrieverError` without parsing prose. `service` names it in the message.
fn map_ranker_error(error: &rankers::RankerError, service: &str) -> napi::Error {
    let retry_after = match error {
        rankers::RankerError::RateLimited { retry_after_secs } => *retry_after_secs,
        _ => None,
    };
    let payload = json!({
        "code": error.code(),
        "message": error.describe(service),
        "status": error.status(),
        "retryAfterSecs": retry_after,
        "transient": error.is_transient(),
    });
    napi::Error::from_reason(format!("{RETRIEVER_ERROR_PREFIX}{payload}"))
}

/// A decision-model ranker for one vendor (`"jev"`, `"openai-decision"`).
/// Building one opens no connection.
#[napi]
pub struct ChoiceRanker {
    inner: std::sync::Arc<dyn rankers::AnyRanker>,
}

#[napi]
impl ChoiceRanker {
    #[napi(constructor)]
    pub fn new(vendor: String, config: Option<ChoiceRankerConfig>) -> napi::Result<Self> {
        let config =
            config.map_or_else(rankers::VendorConfig::default, |c| rankers::VendorConfig {
                url: c.url,
                api_key_env: c.api_key_env,
                model: c.model,
            });
        let inner = rankers::ranker_for(&vendor, config)
            .map_err(|e| map_ranker_error(&e, "rankers plugin"))?;
        Ok(Self {
            inner: inner.into(),
        })
    }

    /// Rank `candidates` for `query` on a libuv worker: `(id, probability)`
    /// best first, at most `topK`. `kind` is `"tool"`, `"skill"` or `"fact"`.
    #[napi(ts_return_type = "Promise<Array<RankedId>>")]
    pub fn rank_async(
        &self,
        query: String,
        candidates: Vec<RankCandidate>,
        top_k: u32,
        kind: String,
    ) -> napi::Result<AsyncTask<ChoiceRankTask>> {
        let kind = kind
            .parse()
            .map_err(|e: rankers::ParseCandidateKindError| {
                napi::Error::from_reason(e.to_string())
            })?;
        Ok(AsyncTask::new(ChoiceRankTask {
            ranker: self.inner.clone(),
            query,
            candidates: candidates
                .into_iter()
                .map(|c| rankers::Candidate {
                    id: c.id,
                    text: c.text,
                })
                .collect(),
            top_k: top_k as usize,
            kind,
        }))
    }
}

pub struct ChoiceRankTask {
    ranker: std::sync::Arc<dyn rankers::AnyRanker>,
    query: String,
    candidates: Vec<rankers::Candidate>,
    top_k: usize,
    kind: rankers::CandidateKind,
}

impl Task for ChoiceRankTask {
    type Output = Vec<(String, f32)>;
    type JsValue = Vec<RankedId>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        self.ranker
            .rank(&self.query, &self.candidates, self.top_k, self.kind)
            .map_err(|e| map_ranker_error(&e, self.ranker.service()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output
            .into_iter()
            .map(|(id, score)| RankedId {
                id,
                score: f64::from(score),
            })
            .collect())
    }
}
