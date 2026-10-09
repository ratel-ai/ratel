//! A client for Jev (TypeSafe AI), the ranker behind the SDKs' Jev plugin
//! (ADR-0027).
//!
//! Jev answers a `choice` question over named options with a probability per
//! option. Only that wire format lives here; the limits, the tournament for
//! large candidate sets and the error type are shared with the other
//! decision-model clients in [`crate::choice_ranker`].
//!
//! Nothing in the registries calls this: search knows only caller-supplied
//! ranking functions ([`crate::RankCandidate`]). The SDKs wrap [`JevRanker`]
//! into such a function, so a change to Jev's interface stays in this file.

use std::collections::HashMap;

use crate::choice_ranker::{self, AskChoice, CandidateKind, RankerError, from_probabilities};
use crate::rerank::RankCandidate as Candidate;

use serde::Deserialize;

/// Where Jev lives unless a catalog overrides it.
pub const DEFAULT_JEV_URL: &str = "https://api.typesafe.ai";

/// The environment variable holding the Jev key unless overridden.
pub const DEFAULT_JEV_API_KEY_ENV: &str = "TYPESAFE_API_KEY";

/// The Jev model unless overridden.
pub const DEFAULT_JEV_MODEL: &str = "jev-latest";

/// A Jev ranking failed: the error every decision-model client shares.
pub type JevError = RankerError;

/// Which Jev endpoint, key and model a registry uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JevConfig {
    url: String,
    api_key_env: String,
    model: String,
}

impl Default for JevConfig {
    fn default() -> Self {
        Self {
            url: DEFAULT_JEV_URL.into(),
            api_key_env: DEFAULT_JEV_API_KEY_ENV.into(),
            model: DEFAULT_JEV_MODEL.into(),
        }
    }
}

impl JevConfig {
    /// Use another base URL (a proxy, tests); `/v1/systemone` is appended and a
    /// trailing slash is ignored.
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

    /// Use another Jev model (e.g. a pinned `jev-1.13.0`).
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

    /// The Jev model.
    #[must_use]
    pub fn model(&self) -> &str {
        &self.model
    }
}

#[derive(Deserialize)]
struct JevResponse {
    answers: HashMap<String, JevChoice>,
}

#[derive(Deserialize)]
struct JevChoice {
    probabilities: HashMap<String, f32>,
}

/// Jev's `/v1/systemone`, called directly. Building one opens no connection.
pub struct JevRanker {
    config: JevConfig,
    agent: ureq::Agent,
    /// A key that bypasses the environment; tests set it rather than mutate
    /// the process environment other threads are reading.
    key_override: Option<String>,
}

impl JevRanker {
    /// A ranker for `config`; the key is read from its env var at call time.
    #[must_use]
    pub fn new(config: JevConfig) -> Self {
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
    /// dropped, except the best one. `kind` is what the candidates are; Jev is
    /// asked about tools or skills accordingly.
    ///
    /// # Errors
    /// [`JevError`] when the key is unset, Jev refuses the request, or it
    /// cannot be reached or understood.
    pub fn rank(
        &self,
        query: &str,
        candidates: &[Candidate],
        top_k: usize,
        kind: CandidateKind,
    ) -> Result<Vec<(String, f32)>, JevError> {
        if candidates.is_empty() || top_k == 0 {
            return Ok(Vec::new());
        }
        let key = choice_ranker::api_key(
            self.key_override.as_deref(),
            &self.config.api_key_env,
            "Jev",
        )?;
        choice_ranker::rank(self, &key, query, candidates, top_k, kind)
    }
}

impl AskChoice for JevRanker {
    fn ask(
        &self,
        key: &str,
        query: &str,
        candidates: &[&Candidate],
        kind: CandidateKind,
    ) -> Result<Vec<(String, f32)>, RankerError> {
        // Index keys (`t0`…) rather than ids: an id may be long or odd, and the
        // option name is part of what Jev reads.
        let criteria: serde_json::Map<String, serde_json::Value> = candidates
            .iter()
            .enumerate()
            .map(|(i, c)| (format!("t{i}"), choice_ranker::option_text(c).into()))
            .collect();
        let body = serde_json::json!({
            "model": self.config.model,
            "state": query,
            "questions": {
                kind.noun(): {
                    "type": "choice",
                    "instructions": kind.instructions(),
                    "criteria": criteria
                }
            }
        });
        let url = format!("{}/v1/systemone", self.config.url);
        let text = choice_ranker::post_json(&self.agent, &url, key, &body)?;
        let parsed: JevResponse =
            serde_json::from_str(&text).map_err(|e| RankerError::Malformed {
                source: e.to_string(),
            })?;
        let answer = parsed
            .answers
            .get(kind.noun())
            .ok_or_else(|| RankerError::Malformed {
                source: format!("no answer to the \"{}\" question", kind.noun()),
            })?;
        Ok(from_probabilities(&answer.probabilities, candidates))
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use super::*;
    use crate::choice_ranker::{MAX_OPTION_CHARS, MAX_OPTIONS};
    use crate::test_support::{MockHttpRequest, read_http_request_full};

    /// An environment variable no test sets: tests inject the key instead.
    const KEY: &str = "RATEL_CORE_JEV_TEST_KEY";

    fn cands(ids: &[&str]) -> Vec<Candidate> {
        ids.iter()
            .map(|id| Candidate {
                id: (*id).into(),
                text: format!("text of {id}"),
            })
            .collect()
    }

    /// A Jev stand-in. `answer` maps the criteria a request carries to the
    /// probabilities it returns; every request is recorded.
    /// `(status, extra header lines, body)` for one request.
    type Answer =
        Box<dyn Fn(&serde_json::Map<String, serde_json::Value>) -> (u16, String, String) + Send>;

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
                        // Whichever question was asked: its id depends on the kind.
                        let criteria = request.body["questions"]
                            .as_object()
                            .and_then(|qs| qs.values().next())
                            .and_then(|q| q["criteria"].as_object())
                            .cloned()
                            .unwrap_or_default();
                        let (status, headers, body) = answer(&criteria);
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

    /// Answers with probabilities from a fixed per-text score table, so the
    /// same candidate scores the same in any group or round.
    fn by_text(scores: HashMap<String, f32>) -> Answer {
        by_text_or(scores, 0.0)
    }

    /// [`by_text`], scoring every unlisted option `floor` rather than 0, for
    /// tests that count the options a ranking keeps.
    fn by_text_or(scores: HashMap<String, f32>, floor: f32) -> Answer {
        Box::new(move |criteria| {
            let probs: serde_json::Map<String, serde_json::Value> = criteria
                .iter()
                .map(|(k, text)| {
                    let p = scores.get(text.as_str().unwrap()).copied().unwrap_or(floor);
                    (k.clone(), serde_json::json!(p))
                })
                .collect();
            (
                200,
                String::new(),
                serde_json::json!({"model": "jev-1.13.0",
                    "answers": {"tool": {"type": "choice", "probabilities": probs}}})
                .to_string(),
            )
        })
    }

    fn client(url: &str) -> JevRanker {
        JevRanker::new(JevConfig::default().with_url(url).with_api_key_env(KEY))
            .with_key("jev-token")
    }

    #[test]
    fn config_defaults_to_jev() {
        let c = JevConfig::default();
        assert_eq!(c.url(), "https://api.typesafe.ai");
        assert_eq!(c.api_key_env(), "TYPESAFE_API_KEY");
        assert_eq!(c.model(), "jev-latest");
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
            "the 0.0 option is filler and is dropped"
        );
        let request = &seen.lock().unwrap()[0];
        assert_eq!(request.request_line, "POST /v1/systemone HTTP/1.1");
        assert_eq!(request.authorization.as_deref(), Some("Bearer jev-token"));
        assert_eq!(request.body["model"], "jev-latest");
        assert_eq!(request.body["state"], "money back");
        let tool = &request.body["questions"]["tool"];
        assert_eq!(tool["type"], "choice");
        assert_eq!(tool["criteria"]["t2"], "text of refund");
    }

    #[test]
    fn near_zero_picks_are_dropped() {
        let scores = HashMap::from([
            ("text of refund".to_string(), 0.9),
            ("text of list".to_string(), 0.08),
            ("text of charge".to_string(), 0.005),
        ]);
        let (url, _seen) = mock(by_text(scores), 1);
        let ranked = client(&url)
            .rank(
                "money back",
                &cands(&["charge", "list", "refund", "email"]),
                5,
                CandidateKind::Tool,
            )
            .unwrap();
        assert_eq!(
            ranked,
            vec![("refund".into(), 0.9), ("list".into(), 0.08)],
            "picks below MIN_PROBABILITY are filler, not picks"
        );
    }

    #[test]
    fn the_best_pick_survives_even_when_every_probability_is_low() {
        // A thin spread: no option reaches MIN_PROBABILITY.
        let scores = HashMap::from([
            ("text of a".to_string(), 0.008),
            ("text of b".to_string(), 0.006),
        ]);
        let (url, _seen) = mock(by_text(scores), 1);
        let ranked = client(&url)
            .rank("q", &cands(&["a", "b", "c"]), 5, CandidateKind::Tool)
            .unwrap();
        assert_eq!(ranked, vec![("a".into(), 0.008)]);
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
            r.body["questions"]["tool"]["criteria"]
                .as_object()
                .unwrap()
                .len()
                <= MAX_OPTIONS
        }));
    }

    #[test]
    fn a_top_k_as_large_as_a_group_still_converges() {
        // 160 candidates in groups of [150, 10]; keeping the top 150 of each
        // would advance the whole field and never finish.
        let ids: Vec<String> = (0..160).map(|i| format!("tool{i:03}")).collect();
        let id_refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let scores = HashMap::from([("text of tool155".to_string(), 0.9)]);
        let (url, seen) = mock(by_text_or(scores, 0.02), 3);
        let ranked = client(&url)
            .rank("q", &cands(&id_refs), 150, CandidateKind::Tool)
            .unwrap();
        assert_eq!(
            ranked[0].0, "tool155",
            "the group-2 winner survives the cut"
        );
        assert_eq!(
            ranked.len(),
            150,
            "the final question is filled up to top_k"
        );
        assert_eq!(
            seen.lock().unwrap().len(),
            3,
            "two groups and one final round"
        );
    }

    #[test]
    fn a_char_budget_split_still_converges() {
        // 50 options of 2,000 chars split [40, 10] by the 80,000-char budget;
        // a reranker depth of 45 would keep every candidate of both groups.
        let many: Vec<Candidate> = (0..50)
            .map(|i| Candidate {
                id: format!("c{i:02}"),
                text: format!("{i:02}{}", "y".repeat(MAX_OPTION_CHARS - 2)),
            })
            .collect();
        let best = many[42].text.clone();
        let (url, seen) = mock(by_text_or(HashMap::from([(best, 0.8)]), 0.02), 3);
        let ranked = client(&url)
            .rank("q", &many, 45, CandidateKind::Tool)
            .unwrap();
        assert_eq!(ranked[0].0, "c42");
        assert_eq!(
            ranked.len(),
            40,
            "one question holds 40 options of 2,000 chars"
        );
        assert_eq!(
            seen.lock().unwrap().len(),
            3,
            "two groups and one final round"
        );
    }

    #[test]
    fn a_catalog_whose_group_winners_overflow_one_question_runs_another_round() {
        // 1,640 options of 2,000 chars split into 41 groups of 40. Their 41
        // best still exceed one question's 80,000 chars, so they play a second
        // round of groups before the final: 41 + 2 + 1 requests.
        let many: Vec<Candidate> = (0..1_640)
            .map(|i| Candidate {
                id: format!("c{i:04}"),
                text: format!("{i:04}{}", "y".repeat(MAX_OPTION_CHARS - 4)),
            })
            .collect();
        let best = many[1_234].text.clone();
        let (url, seen) = mock(by_text(HashMap::from([(best, 0.9)])), 44);
        let ranked = client(&url)
            .rank("q", &many, 5, CandidateKind::Tool)
            .unwrap();
        assert_eq!(ranked[0].0, "c1234");
        assert_eq!(
            seen.lock().unwrap().len(),
            44,
            "41 groups, a 2-group round, the final"
        );
    }

    #[test]
    fn each_kind_asks_its_own_question() {
        for kind in [
            CandidateKind::Tool,
            CandidateKind::Skill,
            CandidateKind::Fact,
        ] {
            let noun = kind.noun();
            let answer: Answer = Box::new(move |criteria| {
                let probs: serde_json::Map<String, serde_json::Value> = criteria
                    .keys()
                    .map(|k| {
                        (
                            k.clone(),
                            serde_json::json!(if k == "t1" { 0.9 } else { 0.1 }),
                        )
                    })
                    .collect();
                (
                    200,
                    String::new(),
                    serde_json::json!({"answers": {noun: {"type": "choice", "probabilities": probs}}})
                        .to_string(),
                )
            });
            let (url, seen) = mock(answer, 1);
            let ranked = client(&url)
                .rank("q", &cands(&["a", "b"]), 2, kind)
                .unwrap();
            assert_eq!(
                ranked[0].0, "b",
                "{noun}: the answer is read under its own key"
            );
            let body = &seen.lock().unwrap()[0].body;
            let question = &body["questions"][noun];
            assert_eq!(question["type"], "choice", "{noun}");
            let instructions = question["instructions"].as_str().unwrap();
            assert!(instructions.contains(noun), "{noun}: {instructions}");
        }
    }

    #[test]
    fn statuses_map_to_typed_errors() {
        let err = |msg: &str| format!(r#"{{"error":{{"message":"{msg}"}}}}"#);
        let replies: Vec<(u16, &str, String)> = vec![
            (400, "", err("bad question")),
            (401, "", err("bad key")),
            (403, "", err("forbidden")),
            (404, "", err("no such model")),
            (413, "", err("too long")),
            (422, "", err("too many options")),
            (429, "retry-after: 7\r\n", err("slow down")),
            (429, "", err("slow down")),
            (500, "", err("boom")),
            (502, "", "<html>bad gateway</html>".into()),
            (503, "", err("busy")),
            (504, "", err("deadline")),
            (529, "", err("overloaded")),
        ];
        let n = replies.len();
        let queue = Arc::new(Mutex::new(replies));
        let answer: Answer = Box::new(move |_| {
            let (status, headers, body) = queue.lock().unwrap().remove(0);
            (status, headers.to_string(), body)
        });
        let (url, _seen) = mock(answer, n);
        let c = client(&url);
        let call = || {
            c.rank("q", &cands(&["a"]), 1, CandidateKind::Tool)
                .unwrap_err()
        };
        let invalid = |status, message: &str| JevError::InvalidRequest {
            status,
            message: message.into(),
        };
        assert_eq!(call(), invalid(400, "bad question"));
        assert_eq!(call(), JevError::Unauthorized { status: 401 });
        assert_eq!(call(), JevError::Unauthorized { status: 403 });
        assert_eq!(call(), invalid(404, "no such model"));
        assert_eq!(call(), invalid(413, "too long"));
        assert_eq!(call(), invalid(422, "too many options"));
        assert_eq!(
            call(),
            JevError::RateLimited {
                retry_after_secs: Some(7)
            }
        );
        assert_eq!(
            call(),
            JevError::RateLimited {
                retry_after_secs: None
            }
        );
        assert_eq!(
            call(),
            JevError::Http {
                status: 500,
                message: "boom".into()
            }
        );
        assert!(matches!(call(), JevError::Unreachable { .. }));
        assert_eq!(call(), JevError::Overloaded { status: 503 });
        assert_eq!(call(), JevError::Timeout);
        assert_eq!(call(), JevError::Overloaded { status: 529 });
    }

    #[test]
    fn a_non_ranking_answer_is_malformed() {
        let (url, _seen) = mock(
            Box::new(|_| (200, String::new(), r#"{"nope":true}"#.into())),
            1,
        );
        assert!(matches!(
            client(&url).rank("q", &cands(&["a"]), 1, CandidateKind::Tool),
            Err(JevError::Malformed { .. })
        ));
    }

    #[test]
    fn an_unset_key_env_fails_before_any_request() {
        let c = JevRanker::new(
            JevConfig::default()
                .with_url("http://127.0.0.1:9")
                .with_api_key_env("RATEL_CORE_JEV_UNSET_KEY"),
        );
        assert!(matches!(
            c.rank("q", &cands(&["a"]), 1, CandidateKind::Tool),
            Err(JevError::Config { .. })
        ));
    }

    #[test]
    fn an_unreachable_endpoint_is_typed() {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let err = client(&format!("http://127.0.0.1:{port}"))
            .rank("q", &cands(&["a"]), 1, CandidateKind::Tool)
            .unwrap_err();
        assert!(matches!(err, JevError::Unreachable { .. }), "{err}");
    }

    #[test]
    fn no_candidates_means_no_request() {
        let c = client("http://127.0.0.1:9");
        assert!(c.rank("q", &[], 5, CandidateKind::Tool).unwrap().is_empty());
    }
}
