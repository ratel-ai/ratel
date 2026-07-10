//! Which embedding model backs a catalog's semantic/hybrid retrieval.
//!
//! The model is chosen per catalog and declared once, then used for both
//! document and query embedding so the two sides can never land in different
//! vector spaces. Four sources: the built-in default (`bge-small`), any
//! BERT-family HuggingFace repo or on-disk directory (loaded in-process via
//! Candle), and an OpenAI-compatible HTTP endpoint (any model, incl. Ollama).
//!
//! [`EmbeddingModel::resolve`] turns the cross-SDK [`EmbeddingSpec`] DTO into a
//! validated model. The source is named explicitly: a bare string is a **local
//! directory path**, and every other source is a keyed object
//! (`{huggingface}` / `{local}` / `{ollama}` / `{url, model}`), symmetric across
//! the board. Resolution/validation **lives here** (in the core) so both SDKs
//! share one implementation instead of two that could drift. See ADR-0012.

use std::path::{Path, PathBuf};

use crate::embedding::EmbedderError;

/// The built-in default: bge-small, pinned to a commit so embeddings are
/// reproducible. These are the canonical identity of the zero-config model;
/// `embedding.rs` loads against them.
pub(crate) const DEFAULT_REPO: &str = "BAAI/bge-small-en-v1.5";
pub(crate) const DEFAULT_REVISION: &str = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a";
/// bge asymmetric-retrieval query prefix; only the query side gets it.
pub(crate) const DEFAULT_QUERY_INSTRUCTION: &str =
    "Represent this sentence for searching relevant passages: ";

/// Default Ollama OpenAI-compatible embeddings route. The `{ollama: model}`
/// shortcut expands to this; a non-default host uses the full `{url, model}` form.
pub(crate) const OLLAMA_DEFAULT_URL: &str = "http://localhost:11434/v1/embeddings";

/// The embedding model backing a catalog's semantic/hybrid engines.
#[derive(Debug, Clone, PartialEq)]
pub enum EmbeddingModel {
    /// Built-in `bge-small-en-v1.5`, pinned. The zero-config default.
    Default,
    /// A BERT-family HuggingFace repo, loaded in-process via Candle. `revision`
    /// defaults to `main`.
    HuggingFace {
        repo: String,
        revision: Option<String>,
        query_prefix: Option<String>,
    },
    /// A BERT-family model directory on disk (`config.json` / `tokenizer.json` /
    /// `model.safetensors`), loaded in-process via Candle.
    Local {
        path: PathBuf,
        query_prefix: Option<String>,
    },
    /// An OpenAI-compatible `/embeddings` HTTP endpoint (OpenAI, Ollama, TEI,
    /// vLLM…). `api_key_env` names the env var holding the key (read at call time).
    Endpoint {
        url: String,
        model: String,
        api_key_env: Option<String>,
        query_prefix: Option<String>,
    },
}

/// Normalized, cross-SDK embedding config as forwarded by the native bindings.
/// Exactly one *primary* source must be set: either `spec` (the raw string
/// shortcut) or one of `huggingface` / `local` / `ollama` / `url`. The rest are
/// modifiers.
#[derive(Debug, Clone, Default)]
pub struct EmbeddingSpec {
    /// Raw string shortcut — a **local model directory path** only. A repo-id or
    /// URL string is rejected in favor of the explicit `huggingface`/`url` keys.
    pub spec: Option<String>,
    pub huggingface: Option<String>,
    pub local: Option<String>,
    pub ollama: Option<String>,
    pub url: Option<String>,
    pub model: Option<String>,
    pub revision: Option<String>,
    pub api_key_env: Option<String>,
    pub query_prefix: Option<String>,
}

fn cfg(message: impl Into<String>) -> EmbedderError {
    EmbedderError::Config {
        message: message.into(),
    }
}

impl EmbeddingModel {
    /// Validate and resolve a spec into a concrete model. Runs at catalog
    /// construction, so config mistakes surface immediately (not at first search).
    pub fn resolve(spec: EmbeddingSpec) -> Result<EmbeddingModel, EmbedderError> {
        let primaries = [
            ("spec", spec.spec.is_some()),
            ("huggingface", spec.huggingface.is_some()),
            ("local", spec.local.is_some()),
            ("ollama", spec.ollama.is_some()),
            ("url", spec.url.is_some()),
        ];
        let set: Vec<&str> = primaries
            .iter()
            .filter(|(_, present)| *present)
            .map(|(key, _)| *key)
            .collect();
        match set.len() {
            0 => {
                return Err(cfg(
                    "no embedding source given; pass a local directory path, or one of \
                     huggingface/local/ollama/url",
                ));
            }
            1 => {}
            _ => {
                return Err(cfg(format!(
                    "conflicting embedding keys {set:?}; give exactly one of \
                     spec/huggingface/local/ollama/url",
                )));
            }
        }

        match set[0] {
            "spec" => infer_from_string(spec.spec.as_deref().unwrap(), &spec),
            "huggingface" => {
                reject_endpoint_only(&spec, "a HuggingFace repo")?;
                Ok(EmbeddingModel::HuggingFace {
                    repo: spec.huggingface.unwrap(),
                    revision: spec.revision,
                    query_prefix: spec.query_prefix,
                })
            }
            "local" => {
                reject_endpoint_only(&spec, "a local model")?;
                if spec.revision.is_some() {
                    return Err(cfg("'revision' is only valid for a HuggingFace repo"));
                }
                Ok(EmbeddingModel::Local {
                    path: PathBuf::from(spec.local.unwrap()),
                    query_prefix: spec.query_prefix,
                })
            }
            "ollama" => {
                if spec.model.is_some() {
                    return Err(cfg(
                        "'model' is redundant with 'ollama' (the ollama value is the model name)",
                    ));
                }
                if spec.revision.is_some() {
                    return Err(cfg("'revision' is only valid for a HuggingFace repo"));
                }
                Ok(EmbeddingModel::Endpoint {
                    url: OLLAMA_DEFAULT_URL.to_string(),
                    model: spec.ollama.unwrap(),
                    api_key_env: None,
                    query_prefix: spec.query_prefix,
                })
            }
            "url" => {
                let model = spec
                    .model
                    .ok_or_else(|| cfg("endpoint embedding requires both 'url' and 'model'"))?;
                if spec.revision.is_some() {
                    return Err(cfg("'revision' is only valid for a HuggingFace repo"));
                }
                Ok(EmbeddingModel::Endpoint {
                    url: spec.url.unwrap(),
                    model,
                    api_key_env: spec.api_key_env,
                    query_prefix: spec.query_prefix,
                })
            }
            _ => unreachable!("primary key set is closed"),
        }
    }

    /// The query-side instruction prefix (bge is asymmetric). Empty unless the
    /// model sets one; the built-in default carries bge's instruction.
    pub(crate) fn query_prefix(&self) -> &str {
        match self {
            EmbeddingModel::Default => DEFAULT_QUERY_INSTRUCTION,
            EmbeddingModel::HuggingFace { query_prefix, .. }
            | EmbeddingModel::Local { query_prefix, .. }
            | EmbeddingModel::Endpoint { query_prefix, .. } => {
                query_prefix.as_deref().unwrap_or("")
            }
        }
    }

    /// Human-readable model name for telemetry (the `model` field of load
    /// events). Friendlier than the fingerprint.
    pub(crate) fn display_name(&self) -> String {
        match self {
            EmbeddingModel::Default => DEFAULT_REPO.to_string(),
            EmbeddingModel::HuggingFace { repo, .. } => repo.clone(),
            EmbeddingModel::Local { path, .. } => path.display().to_string(),
            EmbeddingModel::Endpoint { url, model, .. } => format!("{model} @ {url}"),
        }
    }

    /// Pre-load identity used to **key the process model cache** so two catalogs
    /// on the same model load it once. HF `revision` may still be `main` here;
    /// the resolved-with-SHA form is [`crate::embedding::Embedder::fingerprint`],
    /// stamped on the dense cache after load.
    pub(crate) fn configured_fingerprint(&self) -> String {
        match self {
            EmbeddingModel::Default => format!("hf:{DEFAULT_REPO}@{DEFAULT_REVISION}"),
            EmbeddingModel::HuggingFace { repo, revision, .. } => {
                format!("hf:{repo}@{}", revision.as_deref().unwrap_or("main"))
            }
            EmbeddingModel::Local { path, .. } => format!("local:{}", path.display()),
            EmbeddingModel::Endpoint { url, model, .. } => format!("endpoint:{url}#{model}"),
        }
    }
}

/// Reject endpoint-only modifiers on an in-process (HF/local) source.
fn reject_endpoint_only(spec: &EmbeddingSpec, what: &str) -> Result<(), EmbedderError> {
    if spec.model.is_some() {
        return Err(cfg(format!(
            "'model' is only valid with an endpoint 'url', not {what}"
        )));
    }
    if spec.api_key_env.is_some() {
        return Err(cfg(format!(
            "'api_key_env' is only valid with an endpoint 'url', not {what}"
        )));
    }
    Ok(())
}

/// Interpret the raw string shortcut, which is a **local model directory path
/// only** — every non-path source (HuggingFace, endpoint) uses the explicit
/// keyed object, symmetric with `{ollama}`/`{url}`. A URL or a repo-id-looking
/// string is rejected with a pointer to the right object form, so the source is
/// never guessed from an ambiguous string.
fn infer_from_string(s: &str, spec: &EmbeddingSpec) -> Result<EmbeddingModel, EmbedderError> {
    if spec.model.is_some() || spec.api_key_env.is_some() {
        return Err(cfg(
            "'model'/'api_key_env' are only valid with an endpoint 'url'; a bare string \
             is only a local model directory path",
        ));
    }
    if spec.revision.is_some() {
        return Err(cfg("'revision' is only valid for a HuggingFace repo; use \
             {\"huggingface\": \"…\", \"revision\": \"…\"}"));
    }
    if looks_like_url(s) {
        return Err(cfg(format!(
            "'{s}' looks like an endpoint URL but has no model name; use \
             {{\"url\": \"{s}\", \"model\": \"…\"}}"
        )));
    }
    if looks_like_path(s) || Path::new(s).is_dir() {
        return Ok(EmbeddingModel::Local {
            path: PathBuf::from(s),
            query_prefix: spec.query_prefix.clone(),
        });
    }
    // Not a path → most likely a HuggingFace repo id. The bare-string form is
    // local-only, so name the explicit object rather than guess the source.
    Err(cfg(format!(
        "'{s}' is not a local directory path; to use a HuggingFace repo pass \
         {{\"huggingface\": \"{s}\"}}, or give an absolute/relative directory \
         path for a local model"
    )))
}

/// A `scheme://…` URL. Requires `://`, so a Windows `C:\…` path never matches.
fn looks_like_url(s: &str) -> bool {
    match s.find("://") {
        Some(idx) if idx > 0 => {
            let scheme = &s[..idx];
            scheme
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
        }
        _ => false,
    }
}

/// An unambiguous local-path intent — even if the path doesn't exist yet, so a
/// mistyped local path errors as "not found" rather than a phantom HF repo.
fn looks_like_path(s: &str) -> bool {
    s.starts_with('/')
        || s.starts_with("./")
        || s.starts_with("../")
        || s.starts_with('~')
        || s.starts_with(r"\\") // UNC
        || s.starts_with(r".\")
        || s.starts_with(r"..\")
        || is_windows_drive(s)
}

/// `C:\` or `C:/` — a drive letter, colon, separator.
fn is_windows_drive(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn from_str(s: &str) -> Result<EmbeddingModel, EmbedderError> {
        EmbeddingModel::resolve(EmbeddingSpec {
            spec: Some(s.to_string()),
            ..Default::default()
        })
    }

    #[test]
    fn bare_repo_id_string_is_rejected_pointing_to_huggingface() {
        // A repo-id-looking string is not a path → rejected with a pointer to the
        // explicit object form, so the source is never guessed.
        let err = from_str("BAAI/bge-base-en-v1.5").unwrap_err();
        assert!(matches!(err, EmbedderError::Config { .. }));
        assert!(err.to_string().contains("huggingface"), "got: {err}");
    }

    #[test]
    fn huggingface_object_infers_default_revision() {
        assert_eq!(
            EmbeddingModel::resolve(EmbeddingSpec {
                huggingface: Some("BAAI/bge-base-en-v1.5".into()),
                ..Default::default()
            })
            .unwrap(),
            EmbeddingModel::HuggingFace {
                repo: "BAAI/bge-base-en-v1.5".into(),
                revision: None,
                query_prefix: None,
            }
        );
    }

    #[test]
    fn absolute_and_relative_paths_infer_local_even_when_absent() {
        for p in [
            "/opt/models/x",
            "./models/x",
            "../x",
            "~/models/x",
            r"\\host\share\x",
        ] {
            assert!(
                matches!(from_str(p).unwrap(), EmbeddingModel::Local { .. }),
                "{p} should infer Local"
            );
        }
    }

    #[test]
    fn windows_drive_path_is_local_not_url() {
        for p in [r"C:\models\bge", "C:/models/bge"] {
            assert!(
                matches!(from_str(p).unwrap(), EmbeddingModel::Local { .. }),
                "{p} should infer Local, not be mistaken for a URL"
            );
        }
    }

    #[test]
    fn existing_directory_infers_local() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        assert!(matches!(
            from_str(path).unwrap(),
            EmbeddingModel::Local { .. }
        ));
    }

    #[test]
    fn bare_url_string_is_rejected_needs_model() {
        let err = from_str("https://api.openai.com/v1/embeddings").unwrap_err();
        assert!(matches!(err, EmbedderError::Config { .. }));
        assert!(err.to_string().contains("model"), "got: {err}");
    }

    #[test]
    fn ollama_object_expands_to_localhost_endpoint() {
        let m = EmbeddingModel::resolve(EmbeddingSpec {
            ollama: Some("nomic-embed-text".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            m,
            EmbeddingModel::Endpoint {
                url: OLLAMA_DEFAULT_URL.into(),
                model: "nomic-embed-text".into(),
                api_key_env: None,
                query_prefix: None,
            }
        );
    }

    #[test]
    fn endpoint_object_requires_model() {
        let err = EmbeddingModel::resolve(EmbeddingSpec {
            url: Some("https://api.openai.com/v1/embeddings".into()),
            ..Default::default()
        })
        .unwrap_err();
        assert!(err.to_string().contains("'url' and 'model'"), "got: {err}");
    }

    #[test]
    fn ollama_and_url_together_conflict() {
        let err = EmbeddingModel::resolve(EmbeddingSpec {
            ollama: Some("nomic".into()),
            url: Some("http://host:11434/v1/embeddings".into()),
            model: Some("nomic".into()),
            ..Default::default()
        })
        .unwrap_err();
        assert!(err.to_string().contains("conflicting"), "got: {err}");
    }

    #[test]
    fn huggingface_object_with_revision() {
        let m = EmbeddingModel::resolve(EmbeddingSpec {
            huggingface: Some("BAAI/bge-base-en-v1.5".into()),
            revision: Some("abc123".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            m,
            EmbeddingModel::HuggingFace {
                repo: "BAAI/bge-base-en-v1.5".into(),
                revision: Some("abc123".into()),
                query_prefix: None,
            }
        );
    }

    #[test]
    fn empty_spec_is_rejected() {
        assert!(EmbeddingModel::resolve(EmbeddingSpec::default()).is_err());
    }

    #[test]
    fn default_query_prefix_is_bge_instruction() {
        assert_eq!(
            EmbeddingModel::Default.query_prefix(),
            DEFAULT_QUERY_INSTRUCTION
        );
        assert_eq!(
            EmbeddingModel::Endpoint {
                url: "u".into(),
                model: "m".into(),
                api_key_env: None,
                query_prefix: None,
            }
            .query_prefix(),
            ""
        );
    }

    #[test]
    fn fingerprints_are_distinct_per_source() {
        assert_eq!(
            EmbeddingModel::Default.configured_fingerprint(),
            format!("hf:{DEFAULT_REPO}@{DEFAULT_REVISION}")
        );
        assert_eq!(
            EmbeddingModel::HuggingFace {
                repo: "r".into(),
                revision: None,
                query_prefix: None,
            }
            .configured_fingerprint(),
            "hf:r@main"
        );
        assert_eq!(
            EmbeddingModel::Endpoint {
                url: "u".into(),
                model: "m".into(),
                api_key_env: None,
                query_prefix: None,
            }
            .configured_fingerprint(),
            "endpoint:u#m"
        );
    }
}
