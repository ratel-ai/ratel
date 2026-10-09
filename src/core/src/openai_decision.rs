//! A client for OpenAI's Decisions API, the ranker behind the SDKs' OpenAI
//! Decisions plugin (ADR-0027).
//!
//! Decisions answers a `choice` question over `{value, description}` choices
//! with a probability per choice. Only that wire format lives here; the
//! limits (OpenAI documents none, so Jev's are used), the tournament for large
//! candidate sets and the error type are shared in [`crate::choice_ranker`].
//! The API is in public beta: a change to it stays in this file.
//!
//! Text only: the query is sent as a plain string, never images.

use std::collections::HashMap;

use crate::choice_ranker::{self, AskChoice, CandidateKind, RankerError, from_probabilities};
use crate::rerank::RankCandidate as Candidate;

use serde::Deserialize;

/// Where the Decisions API lives unless overridden.
pub const DEFAULT_OPENAI_DECISION_URL: &str = "https://api.openai.com";

/// The environment variable holding the OpenAI key unless overridden.
pub const DEFAULT_OPENAI_DECISION_API_KEY_ENV: &str = "OPENAI_API_KEY";

/// The Decisions model unless overridden: the only one the beta supports.
pub const DEFAULT_OPENAI_DECISION_MODEL: &str = "gpt-6-luna";

/// Which Decisions endpoint, key and model a ranker uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAIDecisionConfig {
    url: String,
    api_key_env: String,
    model: String,
}

impl Default for OpenAIDecisionConfig {
    fn default() -> Self {
        Self {
            url: DEFAULT_OPENAI_DECISION_URL.into(),
            api_key_env: DEFAULT_OPENAI_DECISION_API_KEY_ENV.into(),
            model: DEFAULT_OPENAI_DECISION_MODEL.into(),
        }
    }
}

impl OpenAIDecisionConfig {
    /// Use another base URL (a proxy, tests); `/v1/decisions` is appended and
    /// a trailing slash is ignored.
    #[must_use]
    pub fn with_url(mut self, url: impl Into<String>) -> Self {
        self.url = url.into().trim_end_matches('/').to_string();
        self
    }

    /// Read the key from the environment variable `name`. Read at search time,
    /// so it may be set after construction.
    #[must_use]
    pub fn with_api_key_env(mut self, name: impl Into<String>) -> Self {
        self.api_key_env = name.into();
        self
    }

    /// Use another Decisions model.
    #[must_use]
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }

    /// The base URL.
    #[must_use]
    pub fn url(&self) -> &str {
        &self.url
    }

    /// The name of the environment variable holding the key.
    #[must_use]
    pub fn api_key_env(&self) -> &str {
        &self.api_key_env
    }

    /// The Decisions model.
    #[must_use]
    pub fn model(&self) -> &str {
        &self.model
    }
}

#[derive(Deserialize)]
struct DecisionResponse {
    answers: Vec<DecisionAnswer>,
}

#[derive(Deserialize)]
struct DecisionAnswer {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    probabilities: Vec<DecisionProbability>,
}

#[derive(Deserialize)]
struct DecisionProbability {
    value: String,
    probability: f32,
}

/// OpenAI's `/v1/decisions`, called directly. Building one opens no connection.
pub struct OpenAIDecisionRanker {
    config: OpenAIDecisionConfig,
    agent: ureq::Agent,
    /// A key that bypasses the environment; tests set it rather than mutate
    /// the process environment other threads are reading.
    key_override: Option<String>,
}

impl OpenAIDecisionRanker {
    /// A ranker for `config`; the key is read from its env var at call time.
    #[must_use]
    pub fn new(config: OpenAIDecisionConfig) -> Self {
        Self {
            config,
            agent: choice_ranker::agent(),
            key_override: None,
        }
    }

    /// Use `key` instead of reading the environment.
    #[cfg(test)]
    pub(crate) fn with_key(mut self, key: impl Into<String>) -> Self {
        self.key_override = Some(key.into());
        self
    }

    /// Rank `candidates` for `query`: `(id, probability)` best first, every id
    /// one of `candidates`, at most `top_k`. Picks below probability 0.01 are
    /// dropped, except the best one. `kind` is what the candidates are; the
    /// model is asked about tools or skills accordingly.
    ///
    /// # Errors
    /// [`RankerError`] when the key is unset, OpenAI refuses the request or the
    /// model declines to answer (`Refused`), or it cannot be reached or
    /// understood.
    pub fn rank(
        &self,
        query: &str,
        candidates: &[Candidate],
        top_k: usize,
        kind: CandidateKind,
    ) -> Result<Vec<(String, f32)>, RankerError> {
        if candidates.is_empty() || top_k == 0 {
            return Ok(Vec::new());
        }
        let key = choice_ranker::api_key(
            self.key_override.as_deref(),
            &self.config.api_key_env,
            "OpenAI",
        )?;
        choice_ranker::rank(self, &key, query, candidates, top_k, kind)
    }
}

impl AskChoice for OpenAIDecisionRanker {
    fn ask(
        &self,
        key: &str,
        query: &str,
        candidates: &[&Candidate],
        kind: CandidateKind,
    ) -> Result<Vec<(String, f32)>, RankerError> {
        // Index values (`t0`…) rather than ids: an id may be long or odd, and
        // values must be distinct.
        let choices: Vec<serde_json::Value> = candidates
            .iter()
            .enumerate()
            .map(|(i, c)| {
                serde_json::json!({
                    "value": format!("t{i}"),
                    "description": choice_ranker::option_text(c),
                })
            })
            .collect();
        let body = serde_json::json!({
            "model": self.config.model,
            "input": query,
            "questions": [{
                "type": "choice",
                "name": kind.noun(),
                "instructions": kind.instructions(),
                "choices": choices
            }]
        });
        let url = format!("{}/v1/decisions", self.config.url);
        let text = choice_ranker::post_json(&self.agent, &url, key, &body)?;
        let parsed: DecisionResponse =
            serde_json::from_str(&text).map_err(|e| RankerError::Malformed {
                source: e.to_string(),
            })?;
        let answer = parsed
            .answers
            .iter()
            .find(|a| a.name.as_deref() == Some(kind.noun()))
            .ok_or_else(|| RankerError::Malformed {
                source: format!("no answer to the \"{}\" question", kind.noun()),
            })?;
        match answer.kind.as_str() {
            "choice" => {
                let probs: HashMap<String, f32> = answer
                    .probabilities
                    .iter()
                    .map(|p| (p.value.clone(), p.probability))
                    .collect();
                Ok(from_probabilities(&probs, candidates))
            }
            "refusal" => Err(RankerError::Refused),
            other => Err(RankerError::Malformed {
                source: format!("a \"{other}\" answer to a choice question"),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use super::*;
    use crate::choice_ranker::MAX_OPTIONS;
    use crate::test_support::{MockHttpRequest, read_http_request_full};

    /// An environment variable no test sets: tests inject the key instead.
    const KEY: &str = "RATEL_CORE_OPENAI_DECISION_TEST_KEY";

    fn cands(ids: &[&str]) -> Vec<Candidate> {
        ids.iter()
            .map(|id| Candidate {
                id: (*id).into(),
                text: format!("text of {id}"),
            })
            .collect()
    }

    /// `(status, extra header lines, body)` for one request, from the
    /// question it asked.
    type Answer = Box<dyn Fn(&serde_json::Value) -> (u16, String, String) + Send>;

    /// A Decisions stand-in: `answer` maps each request's first question to a
    /// reply; every request is recorded.
    fn mock(answer: Answer, expected: usize) -> (String, Arc<Mutex<Vec<MockHttpRequest>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut served = 0;
            while served < expected {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        let request = read_http_request_full(&mut stream);
                        let question = request.body["questions"][0].clone();
                        let (status, headers, body) = answer(&question);
                        log.lock().unwrap().push(request);
                        let response = format!(
                            "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n{headers}\
                             content-length: {}\r\nconnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        stream.write_all(response.as_bytes()).unwrap();
                        served += 1;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        if Instant::now() >= deadline {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(e) => panic!("accept failed: {e}"),
                }
            }
        });
        (url, seen)
    }

    /// A `choice` answer scoring each choice from a per-description table,
    /// unlisted choices at 0.
    fn by_text(scores: HashMap<String, f32>) -> Answer {
        Box::new(move |question| {
            let probabilities: Vec<serde_json::Value> = question["choices"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| {
                    let p = scores
                        .get(c["description"].as_str().unwrap())
                        .copied()
                        .unwrap_or(0.0);
                    serde_json::json!({"value": c["value"], "probability": p})
                })
                .collect();
            let best = probabilities
                .iter()
                .max_by(|a, b| {
                    a["probability"]
                        .as_f64()
                        .partial_cmp(&b["probability"].as_f64())
                        .unwrap()
                })
                .map(|p| p["value"].clone());
            (
                200,
                String::new(),
                serde_json::json!({"answers": [{
                    "type": "choice", "name": question["name"], "choice": best,
                    "probabilities": probabilities, "confidence": 0.9
                }]})
                .to_string(),
            )
        })
    }

    fn client(url: &str) -> OpenAIDecisionRanker {
        OpenAIDecisionRanker::new(
            OpenAIDecisionConfig::default()
                .with_url(url)
                .with_api_key_env(KEY),
        )
        .with_key("sk-test")
    }

    #[test]
    fn config_defaults_to_openai() {
        let c = OpenAIDecisionConfig::default();
        assert_eq!(c.url(), "https://api.openai.com");
        assert_eq!(c.api_key_env(), "OPENAI_API_KEY");
        assert_eq!(c.model(), "gpt-6-luna");
        assert_eq!(
            OpenAIDecisionConfig::default()
                .with_url("http://proxy/")
                .url(),
            "http://proxy"
        );
    }

    #[test]
    fn asks_one_choice_question_and_ranks_by_probability() {
        let scores = HashMap::from([
            ("text of refund".to_string(), 0.93),
            ("text of list".to_string(), 0.07),
        ]);
        let (url, seen) = mock(by_text(scores), 1);
        let ranked = client(&url)
            .rank(
                "money back",
                &cands(&["charge", "list", "refund"]),
                5,
                CandidateKind::Tool,
            )
            .unwrap();
        assert_eq!(
            ranked,
            vec![("refund".into(), 0.93), ("list".into(), 0.07)],
            "the 0.0 choice is filler and is dropped"
        );
        let request = &seen.lock().unwrap()[0];
        assert_eq!(request.request_line, "POST /v1/decisions HTTP/1.1");
        assert_eq!(request.authorization.as_deref(), Some("Bearer sk-test"));
        assert_eq!(request.body["model"], "gpt-6-luna");
        assert_eq!(request.body["input"], "money back");
        let questions = request.body["questions"].as_array().unwrap();
        assert_eq!(questions.len(), 1);
        let q = &questions[0];
        assert_eq!(q["type"], "choice");
        assert_eq!(q["name"], "tool");
        assert_eq!(
            q["choices"][2],
            serde_json::json!({"value": "t2", "description": "text of refund"})
        );
    }

    #[test]
    fn each_kind_asks_its_own_question() {
        for kind in [CandidateKind::Tool, CandidateKind::Skill] {
            let noun = kind.noun();
            let scores = HashMap::from([("text of b".to_string(), 0.9)]);
            let (url, seen) = mock(by_text(scores), 1);
            let ranked = client(&url)
                .rank("q", &cands(&["a", "b"]), 2, kind)
                .unwrap();
            assert_eq!(ranked[0].0, "b", "{noun}");
            let q = &seen.lock().unwrap()[0].body["questions"][0];
            assert_eq!(q["name"], noun);
            assert!(q["instructions"].as_str().unwrap().contains(noun), "{noun}");
        }
    }

    #[test]
    fn a_refusal_is_a_transient_refused_error() {
        let (url, _seen) = mock(
            Box::new(|q| {
                (
                    200,
                    String::new(),
                    serde_json::json!({"answers": [{"type": "refusal", "name": q["name"]}]})
                        .to_string(),
                )
            }),
            1,
        );
        let err = client(&url)
            .rank("q", &cands(&["a", "b"]), 1, CandidateKind::Tool)
            .unwrap_err();
        assert_eq!(err, RankerError::Refused);
        assert!(err.is_transient());
    }

    #[test]
    fn an_answer_to_another_question_or_of_another_type_is_malformed() {
        let replies = [
            serde_json::json!({"answers": [{"type": "choice", "name": "skill", "probabilities": []}]}),
            serde_json::json!({"answers": [{"type": "score", "name": "tool", "score": 1.5}]}),
            serde_json::json!({"nope": true}),
        ];
        let n = replies.len();
        let queue = Arc::new(Mutex::new(replies.to_vec()));
        let (url, _seen) = mock(
            Box::new(move |_| {
                (
                    200,
                    String::new(),
                    queue.lock().unwrap().remove(0).to_string(),
                )
            }),
            n,
        );
        let c = client(&url);
        for _ in 0..n {
            assert!(matches!(
                c.rank("q", &cands(&["a"]), 1, CandidateKind::Tool),
                Err(RankerError::Malformed { .. })
            ));
        }
    }

    #[test]
    fn statuses_map_to_typed_errors() {
        let err = |msg: &str| format!(r#"{{"error":{{"message":"{msg}","type":"x"}}}}"#);
        let replies: Vec<(u16, &str, String)> = vec![
            (400, "", err("unknown model")),
            (401, "", err("bad key")),
            (429, "retry-after: 3\r\n", err("slow down")),
            (500, "", err("boom")),
            (503, "", err("busy")),
        ];
        let n = replies.len();
        let queue = Arc::new(Mutex::new(replies));
        let (url, _seen) = mock(
            Box::new(move |_| {
                let (status, headers, body) = queue.lock().unwrap().remove(0);
                (status, headers.to_string(), body)
            }),
            n,
        );
        let c = client(&url);
        let call = || {
            c.rank("q", &cands(&["a"]), 1, CandidateKind::Tool)
                .unwrap_err()
        };
        assert_eq!(
            call(),
            RankerError::InvalidRequest {
                status: 400,
                message: "unknown model".into()
            }
        );
        assert_eq!(call(), RankerError::Unauthorized { status: 401 });
        assert_eq!(
            call(),
            RankerError::RateLimited {
                retry_after_secs: Some(3)
            }
        );
        assert_eq!(
            call(),
            RankerError::Http {
                status: 500,
                message: "boom".into()
            }
        );
        assert_eq!(call(), RankerError::Overloaded { status: 503 });
    }

    #[test]
    fn a_large_catalog_runs_as_a_tournament() {
        // 400 candidates → three groups of ≤150, then a final round.
        let ids: Vec<String> = (0..400).map(|i| format!("tool{i:03}")).collect();
        let id_refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let scores = HashMap::from([
            ("text of tool123".to_string(), 0.9),
            ("text of tool321".to_string(), 0.6),
        ]);
        let (url, seen) = mock(by_text(scores), 4);
        let ranked = client(&url)
            .rank("q", &cands(&id_refs), 2, CandidateKind::Tool)
            .unwrap();
        assert_eq!(ranked[0].0, "tool123");
        assert_eq!(ranked[1].0, "tool321");
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 4, "three groups and a final round");
        assert!(seen.iter().all(|r| {
            r.body["questions"][0]["choices"].as_array().unwrap().len() <= MAX_OPTIONS
        }));
    }

    #[test]
    fn an_unset_key_env_fails_before_any_request() {
        let c = OpenAIDecisionRanker::new(
            OpenAIDecisionConfig::default()
                .with_url("http://127.0.0.1:9")
                .with_api_key_env("RATEL_CORE_OPENAI_DECISION_UNSET_KEY"),
        );
        let err = c
            .rank("q", &cands(&["a"]), 1, CandidateKind::Tool)
            .unwrap_err();
        assert!(matches!(err, RankerError::Config { .. }));
        assert!(err.to_string().contains("OpenAI key"), "{err}");
    }

    #[test]
    fn no_candidates_means_no_request() {
        let c = client("http://127.0.0.1:9");
        assert!(c.rank("q", &[], 5, CandidateKind::Tool).unwrap().is_empty());
    }
}
