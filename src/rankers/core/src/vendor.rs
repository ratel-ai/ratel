//! Pick a backend by vendor id at runtime: what the napi and pyo3 bindings
//! hold, so neither repeats per-vendor code (ADR-0028).
//! A new vendor is a backend plus one arm in [`ranker_for`].

use crate::{Candidate, CandidateKind, ChoiceBackend, ChoiceRanker, RankerError};

/// A ranker of any backend behind one object, as the bindings hold it.
pub trait AnyRanker: Send + Sync {
    /// The service as errors name it: `"jev"`, `"openai decisions"`.
    fn service(&self) -> &'static str;

    /// [`ChoiceRanker::rank`].
    ///
    /// # Errors
    /// See [`ChoiceRanker::rank`].
    fn rank(
        &self,
        query: &str,
        candidates: &[Candidate],
        top_k: usize,
        kind: CandidateKind,
    ) -> Result<Vec<(String, f32)>, RankerError>;
}

impl<B: ChoiceBackend + Send> AnyRanker for ChoiceRanker<B> {
    fn service(&self) -> &'static str {
        self.backend().service()
    }

    fn rank(
        &self,
        query: &str,
        candidates: &[Candidate],
        top_k: usize,
        kind: CandidateKind,
    ) -> Result<Vec<(String, f32)>, RankerError> {
        ChoiceRanker::rank(self, query, candidates, top_k, kind)
    }
}

/// Overrides for a vendor's endpoint, key variable and model; `None` keeps the
/// vendor's default.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VendorConfig {
    /// Base URL (a proxy, tests).
    pub url: Option<String>,
    /// The environment variable holding the key, read at call time.
    pub api_key_env: Option<String>,
    /// The model to ask.
    pub model: Option<String>,
}

/// Apply `config`'s overrides to a vendor config with the usual builders.
#[cfg(any(feature = "jev", feature = "openai-decision"))]
macro_rules! configured {
    ($default:expr, $config:expr) => {{
        let config = $config;
        let mut c = $default;
        if let Some(url) = config.url {
            c = c.with_url(url);
        }
        if let Some(name) = config.api_key_env {
            c = c.with_api_key_env(name);
        }
        if let Some(model) = config.model {
            c = c.with_model(model);
        }
        c
    }};
}

/// The vendor ids this build ships, in [`ranker_for`]'s spelling.
#[must_use]
pub fn vendors() -> Vec<&'static str> {
    let mut all = Vec::new();
    if cfg!(feature = "jev") {
        all.push("jev");
    }
    if cfg!(feature = "openai-decision") {
        all.push("openai-decision");
    }
    all
}

/// A ranker for `vendor` (`"jev"`, `"openai-decision"`) with `config`'s
/// overrides. Opens no connection.
///
/// # Errors
/// [`RankerError::Config`] when this build ships no such vendor.
#[cfg_attr(
    not(any(feature = "jev", feature = "openai-decision")),
    allow(unused_variables)
)]
pub fn ranker_for(vendor: &str, config: VendorConfig) -> Result<Box<dyn AnyRanker>, RankerError> {
    match vendor {
        #[cfg(feature = "jev")]
        "jev" => Ok(Box::new(crate::JevRanker::new(configured!(
            crate::JevConfig::default(),
            config
        )))),
        #[cfg(feature = "openai-decision")]
        "openai-decision" => Ok(Box::new(crate::OpenAIDecisionRanker::new(configured!(
            crate::OpenAIDecisionConfig::default(),
            config
        )))),
        other => Err(RankerError::Config {
            message: format!(
                "unknown ranker vendor {other:?} (this build ships: {})",
                vendors().join(", ")
            ),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_vendors_build_their_backend() {
        #[cfg(feature = "jev")]
        assert_eq!(
            ranker_for("jev", VendorConfig::default())
                .unwrap()
                .service(),
            "jev"
        );
        #[cfg(feature = "openai-decision")]
        assert_eq!(
            ranker_for("openai-decision", VendorConfig::default())
                .unwrap()
                .service(),
            "openai decisions"
        );
    }

    #[test]
    fn vendors_lists_the_enabled_ones() {
        let all = vendors();
        assert_eq!(all.contains(&"jev"), cfg!(feature = "jev"));
        assert_eq!(
            all.contains(&"openai-decision"),
            cfg!(feature = "openai-decision")
        );
    }

    #[test]
    fn an_unknown_vendor_is_a_config_error_listing_the_known_ones() {
        let Err(err) = ranker_for("acme", VendorConfig::default()) else {
            panic!("acme is no vendor");
        };
        assert_eq!(err.code(), "Config");
        assert!(err.to_string().contains("\"acme\""), "{err}");
        for vendor in vendors() {
            assert!(err.to_string().contains(vendor), "{err}");
        }
    }

    #[cfg(feature = "jev")]
    #[test]
    fn the_config_reaches_the_backend() {
        let ranker = ranker_for(
            "jev",
            VendorConfig {
                url: Some("http://127.0.0.1:9".into()),
                api_key_env: Some("RATEL_RANKERS_VENDOR_UNSET_KEY".into()),
                model: None,
            },
        )
        .unwrap();
        let candidates = [Candidate {
            id: "a".into(),
            text: "a".into(),
        }];
        let err = ranker
            .rank("q", &candidates, 1, CandidateKind::Tool)
            .unwrap_err();
        assert!(
            err.to_string().contains("RATEL_RANKERS_VENDOR_UNSET_KEY"),
            "the key env came from the config: {err}"
        );
    }

    #[test]
    fn candidate_kinds_parse_from_their_nouns() {
        for kind in [
            CandidateKind::Tool,
            CandidateKind::Skill,
            CandidateKind::Fact,
        ] {
            assert_eq!(kind.noun().parse::<CandidateKind>(), Ok(kind));
        }
        let err = "widget".parse::<CandidateKind>().unwrap_err();
        assert!(err.to_string().contains("\"widget\""), "{err}");
    }
}
