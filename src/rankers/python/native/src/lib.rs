//! pyo3 binding to `ratel-ai-rankers`: the decision-model rankers behind
//! `ratel-ai-rankers-plugin` (ADR-0028). One class serves every vendor; the
//! Python plugins wrap its `rank` into retrieve/rerank functions.

use pyo3::create_exception;
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use ratel_ai_rankers as rankers;

create_exception!(
    _native,
    RankerError,
    PyRuntimeError,
    "A decision-model ranking failed; carries `code`, `status`, `retry_after_secs` and `transient`. The plugins re-raise it as `ratel_ai.RetrieverError`."
);

/// A ranker failure as `RankerError`, its message naming `service`, with the
/// typed attributes set.
fn ranker_pyerr(e: &rankers::RankerError, service: &str) -> PyErr {
    let retry_after = match e {
        rankers::RankerError::RateLimited { retry_after_secs } => *retry_after_secs,
        _ => None,
    };
    Python::with_gil(|py| {
        let err = PyErr::from_type(py.get_type::<RankerError>(), e.describe(service));
        let value = err.value(py);
        if let Err(attr_err) = value.setattr("code", e.code()) {
            return attr_err;
        }
        if let Err(attr_err) = value.setattr("status", e.status()) {
            return attr_err;
        }
        if let Err(attr_err) = value.setattr("retry_after_secs", retry_after) {
            return attr_err;
        }
        if let Err(attr_err) = value.setattr("transient", e.is_transient()) {
            return attr_err;
        }
        err
    })
}

/// A decision-model ranker for one vendor (`"jev"`, `"openai-decision"`).
/// Building one opens no connection.
#[pyclass(frozen)]
pub struct ChoiceRanker {
    inner: Box<dyn rankers::AnyRanker>,
}

#[pymethods]
impl ChoiceRanker {
    /// A ranker for `vendor`; unset fields keep the vendor's defaults. An
    /// unknown vendor raises `RankerError` (`code="Config"`).
    #[new]
    #[pyo3(signature = (vendor, url=None, api_key_env=None, model=None))]
    fn new(
        vendor: &str,
        url: Option<String>,
        api_key_env: Option<String>,
        model: Option<String>,
    ) -> PyResult<Self> {
        let config = rankers::VendorConfig {
            url,
            api_key_env,
            model,
        };
        let inner =
            rankers::ranker_for(vendor, config).map_err(|e| ranker_pyerr(&e, "rankers plugin"))?;
        Ok(Self { inner })
    }

    /// The service as errors name it: `"jev"`, `"openai decisions"`.
    #[getter]
    fn service(&self) -> &'static str {
        self.inner.service()
    }

    /// Rank `(id, text)` candidates for `query` with the GIL released:
    /// `(id, probability)` best first, at most `top_k`. `kind` is `"tool"`,
    /// `"skill"` or `"fact"`. Failures raise `RankerError`.
    fn rank(
        &self,
        py: Python<'_>,
        query: String,
        candidates: Vec<(String, String)>,
        top_k: u32,
        kind: &str,
    ) -> PyResult<Vec<(String, f64)>> {
        let kind: rankers::CandidateKind = kind
            .parse()
            .map_err(|e: rankers::ParseCandidateKindError| PyValueError::new_err(e.to_string()))?;
        let candidates: Vec<rankers::Candidate> = candidates
            .into_iter()
            .map(|(id, text)| rankers::Candidate { id, text })
            .collect();
        let ranked = py
            .allow_threads(|| self.inner.rank(&query, &candidates, top_k as usize, kind))
            .map_err(|e| ranker_pyerr(&e, self.inner.service()))?;
        Ok(ranked
            .into_iter()
            .map(|(id, score)| (id, f64::from(score)))
            .collect())
    }
}

/// The vendor ids this build ships.
#[pyfunction]
fn vendors() -> Vec<&'static str> {
    rankers::vendors()
}

#[pymodule]
fn _native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("RankerError", m.py().get_type::<RankerError>())?;
    m.add_class::<ChoiceRanker>()?;
    m.add_function(wrap_pyfunction!(vendors, m)?)?;
    m.add("DEFAULT_JEV_MODEL", rankers::DEFAULT_JEV_MODEL)?;
    m.add(
        "DEFAULT_OPENAI_DECISION_MODEL",
        rankers::DEFAULT_OPENAI_DECISION_MODEL,
    )?;
    Ok(())
}
