//! Decision-model rankers for Ratel's ranking hooks (ADR-0027, ADR-0028).
//!
//! The Ratel SDKs rank through caller-supplied functions and know no model's
//! interface. This crate holds the vendor clients those functions wrap, bound
//! by `@ratel-ai/rankers-plugin` (napi) and `ratel-ai-rankers-plugin` (pyo3),
//! so core and the SDKs stay vendor-free.
//!
//! A vendor is a [`ChoiceBackend`] (its wire format); a [`ChoiceRanker`]
//! drives any backend with the shared limits, tournament and error type. Each
//! vendor sits behind a cargo feature:
//!
//! - `jev`: [`JevConfig`] / [`JevRanker`], Jev (TypeSafe AI).
//! - `openai-decision`: [`OpenAIDecisionConfig`] / [`OpenAIDecisionRanker`],
//!   OpenAI's Decisions API (public beta).

#![warn(missing_docs)]

mod choice;
#[cfg(feature = "jev")]
mod jev;
#[cfg(feature = "openai-decision")]
mod openai_decision;
#[cfg(all(test, any(feature = "jev", feature = "openai-decision")))]
mod test_support;
mod vendor;

pub use choice::{
    Candidate, CandidateKind, ChoiceBackend, ChoiceRanker, Http, MAX_OPTION_CHARS, MAX_OPTIONS,
    MAX_QUESTION_CHARS, MIN_OPTIONS, MIN_PROBABILITY, ParseCandidateKindError, RankerError,
    from_probabilities, option_text,
};
#[cfg(feature = "jev")]
pub use jev::{
    DEFAULT_JEV_API_KEY_ENV, DEFAULT_JEV_MODEL, DEFAULT_JEV_URL, JevConfig, JevError, JevRanker,
};
#[cfg(feature = "openai-decision")]
pub use openai_decision::{
    DEFAULT_OPENAI_DECISION_API_KEY_ENV, DEFAULT_OPENAI_DECISION_MODEL,
    DEFAULT_OPENAI_DECISION_URL, OpenAIDecisionConfig, OpenAIDecisionRanker,
};
pub use vendor::{AnyRanker, VendorConfig, ranker_for, vendors};
