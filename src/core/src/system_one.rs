//! System-one ranking with Jev, called directly (ADR-0027).
//!
//! Jev (TypeSafe AI) answers a `choice` question over named options with a
//! probability per option, so one call ranks up to [`MAX_OPTIONS`] candidates.
//! A larger candidate set runs as a tournament: groups that fit one question
//! are ranked in parallel, their winners advance, and the last round fits one
//! question. This is the SDK-side path, for a catalog the SDK owns; a
//! Cloud-owned catalog reaches Jev through the Tool Picker instead
//! (`crate::cloud`).
//!
//! The client sits behind the crate-private [`SystemOne`] trait so registry
//! tests can stand a script in for HTTP.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::time::Duration;

use serde::Deserialize;

/// Where Jev lives unless a catalog overrides it.
pub const DEFAULT_SYSTEM_ONE_URL: &str = "https://api.typesafe.ai";

/// The environment variable holding the Jev key unless overridden.
pub const DEFAULT_SYSTEM_ONE_API_KEY_ENV: &str = "TYPESAFE_API_KEY";

/// The Jev model unless overridden.
pub const DEFAULT_SYSTEM_ONE_MODEL: &str = "jev-latest";

/// Options per question. Jev accepts 255; Ratel Cloud's picker judges at most
/// 150 per question, and the SDK matches it so both paths rank alike.
const MAX_OPTIONS: usize = 150;

/// Characters of option text per question, and per option. A question's
/// options and the query must fit Jev's 32k-token budget; Cloud's picker uses
/// the same 80k-character cap.
const MAX_QUESTION_CHARS: usize = 80_000;
const MAX_OPTION_CHARS: usize = 2_000;

/// How many tournament groups run at once.
const TOURNAMENT_CONCURRENCY: usize = 6;

/// Jev answers one question in ~100–300 ms; a call that takes this long is
/// broken, not slow.
const SYSTEM_ONE_TIMEOUT_SECS: u64 = 15;

/// A Jev answer is a probability map; anything near this size is not one.
const SYSTEM_ONE_RESPONSE_LIMIT_BYTES: u64 = 4 * 1024 * 1024;

const INSTRUCTIONS: &str = "Which tool best handles this request?";

/// Which Jev endpoint, key and model a registry uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemOneConfig {
    url: String,
    api_key_env: String,
    model: String,
}

impl Default for SystemOneConfig {
    fn default() -> Self {
        Self {
            url: DEFAULT_SYSTEM_ONE_URL.into(),
            api_key_env: DEFAULT_SYSTEM_ONE_API_KEY_ENV.into(),
            model: DEFAULT_SYSTEM_ONE_MODEL.into(),
        }
    }
}

impl SystemOneConfig {
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

/// A system-one ranking failed.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SystemOneError {
    /// Misconfigured before any request was sent — e.g. the key's
    /// environment variable is not set.
    Config {
        /// What is wrong.
        message: String,
    },
    /// Jev rejected the key (401/403).
    Unauthorized {
        /// The HTTP status.
        status: u16,
    },
    /// Jev is rate limiting (429).
    RateLimited,
    /// Jev answered with another non-success status (e.g. 422, 529).
    Http {
        /// The HTTP status.
        status: u16,
    },
    /// Jev could not be reached: DNS, TLS, connection refused, timeout.
    Unreachable {
        /// The underlying transport error.
        source: String,
    },
    /// Jev answered with something that is not a ranking.
    Malformed {
        /// What could not be read.
        source: String,
    },
}

impl fmt::Display for SystemOneError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SystemOneError::Config { message } => write!(f, "system-one config: {message}"),
            SystemOneError::Unauthorized { status } => write!(
                f,
                "jev rejected the key ({status}); check the key in api_key_env"
            ),
            SystemOneError::RateLimited => write!(f, "jev is rate limiting (429); retry later"),
            SystemOneError::Http { status } => write!(f, "jev returned HTTP {status}"),
            SystemOneError::Unreachable { source } => write!(f, "could not reach jev: {source}"),
            SystemOneError::Malformed { source } => write!(f, "malformed jev response: {source}"),
        }
    }
}

impl std::error::Error for SystemOneError {}

/// One option the model may pick: an id and the text it is judged on.
#[derive(Debug, Clone)]
pub(crate) struct Candidate {
    pub(crate) id: String,
    pub(crate) text: String,
}

/// Rank `candidates` for `query`, best first, keeping at most `top_k`.
pub(crate) trait SystemOne: Send + Sync {
    /// `(id, score)` best-first, every id one of `candidates`, scores in
    /// `[0, 1]`, at most `top_k` entries.
    fn rank(
        &self,
        query: &str,
        candidates: &[Candidate],
        top_k: usize,
    ) -> Result<Vec<(String, f32)>, SystemOneError>;
}

#[derive(Deserialize)]
struct JevResponse {
    answers: JevAnswers,
}

#[derive(Deserialize)]
struct JevAnswers {
    tool: JevChoice,
}

#[derive(Deserialize)]
struct JevChoice {
    probabilities: HashMap<String, f32>,
}

/// The shipped [`SystemOne`]: Jev's `/v1/systemone`, called directly.
pub(crate) struct JevSystemOne {
    config: SystemOneConfig,
    agent: ureq::Agent,
}

impl JevSystemOne {
    pub(crate) fn new(config: SystemOneConfig) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(SYSTEM_ONE_TIMEOUT_SECS)))
            .build()
            .into();
        Self { config, agent }
    }

    /// Read the key at call time; an unset variable is a clear `Config` error,
    /// not a downstream 401.
    fn api_key(&self) -> Result<String, SystemOneError> {
        let var = &self.config.api_key_env;
        std::env::var(var).map_err(|_| SystemOneError::Config {
            message: format!("api_key_env=\"{var}\" but that environment variable is not set"),
        })
    }

    fn classify(e: ureq::Error) -> SystemOneError {
        match e {
            ureq::Error::StatusCode(status @ (401 | 403)) => {
                SystemOneError::Unauthorized { status }
            }
            ureq::Error::StatusCode(429) => SystemOneError::RateLimited,
            ureq::Error::StatusCode(status) => SystemOneError::Http { status },
            other => SystemOneError::Unreachable {
                source: other.to_string(),
            },
        }
    }

    /// One `choice` question over `candidates` (which fit one question):
    /// every candidate with its probability, best first, ties in input order.
    fn ask(
        &self,
        key: &str,
        query: &str,
        candidates: &[&Candidate],
    ) -> Result<Vec<(String, f32)>, SystemOneError> {
        // Index keys (`t0`…) rather than ids: an id may be long or odd, and the
        // option name is part of what Jev reads.
        let criteria: serde_json::Map<String, serde_json::Value> = candidates
            .iter()
            .enumerate()
            .map(|(i, c)| (format!("t{i}"), option_text(c).into()))
            .collect();
        let body = serde_json::json!({
            "model": self.config.model,
            "state": query,
            "questions": {
                "tool": { "type": "choice", "instructions": INSTRUCTIONS, "criteria": criteria }
            }
        });
        let url = format!("{}/v1/systemone", self.config.url);
        let mut resp = self
            .agent
            .post(&url)
            .header("content-type", "application/json")
            .header("authorization", &format!("Bearer {key}"))
            .send_json(&body)
            .map_err(Self::classify)?;
        let parsed: JevResponse = resp
            .body_mut()
            .with_config()
            .limit(SYSTEM_ONE_RESPONSE_LIMIT_BYTES)
            .read_json()
            .map_err(|e| SystemOneError::Malformed {
                source: e.to_string(),
            })?;
        Ok(from_probabilities(
            &parsed.answers.tool.probabilities,
            candidates,
        ))
    }

    /// Rank more candidates than one question holds: rank groups in parallel,
    /// keep each group's best few, and repeat until the field fits.
    ///
    /// A group keeps at most `keep` (the caller's `top_k`), at most its share
    /// of one question — `MAX_OPTIONS / groups` options and
    /// `MAX_QUESTION_CHARS / groups` characters — so the winners fit one
    /// question and the next round is the last, and at most all but one of its
    /// members so every round eliminates someone. Keeping the full `keep` from each group would
    /// advance the whole field whenever `keep` is as large as a group.
    fn tournament(
        &self,
        key: &str,
        query: &str,
        candidates: Vec<&Candidate>,
        keep: usize,
    ) -> Result<Vec<(String, f32)>, SystemOneError> {
        let mut field = candidates;
        loop {
            if fits_one_question(&field) {
                return self.ask(key, query, &field);
            }
            let groups = split_into_questions(&field);
            let per_group = keep.min(MAX_OPTIONS / groups.len()).max(1);
            let chars_share = MAX_QUESTION_CHARS / groups.len();
            let mut winners: Vec<&Candidate> = Vec::new();
            for batch in groups.chunks(TOURNAMENT_CONCURRENCY) {
                let results: Vec<Result<Vec<(String, f32)>, SystemOneError>> =
                    std::thread::scope(|scope| {
                        let handles: Vec<_> = batch
                            .iter()
                            .map(|group| scope.spawn(|| self.ask(key, query, group)))
                            .collect();
                        handles
                            .into_iter()
                            .map(|h| {
                                h.join().unwrap_or_else(|_| {
                                    Err(SystemOneError::Malformed {
                                        source: "a tournament round panicked".into(),
                                    })
                                })
                            })
                            .collect()
                    });
                for (group, result) in batch.iter().zip(results) {
                    let ranked = result?;
                    let by_id: HashMap<&str, &Candidate> =
                        group.iter().map(|c| (c.id.as_str(), *c)).collect();
                    let quota = per_group.min(group.len().saturating_sub(1)).max(1);
                    let (mut taken, mut chars) = (0, 0);
                    for (id, _) in &ranked {
                        let Some(c) = by_id.get(id.as_str()).copied() else {
                            continue;
                        };
                        let len = option_chars(c);
                        if taken == quota || (taken > 0 && chars + len > chars_share) {
                            break;
                        }
                        winners.push(c);
                        taken += 1;
                        chars += len;
                    }
                }
            }
            // Every group of two or more lost at least one member, and a field
            // that needs a tournament has such a group, so this cannot trigger;
            // it guards the loop against a future change to the quotas.
            if winners.len() >= field.len() {
                return Err(SystemOneError::Malformed {
                    source: "tournament made no progress".into(),
                });
            }
            field = winners;
        }
    }
}

impl SystemOne for JevSystemOne {
    fn rank(
        &self,
        query: &str,
        candidates: &[Candidate],
        top_k: usize,
    ) -> Result<Vec<(String, f32)>, SystemOneError> {
        if candidates.is_empty() || top_k == 0 {
            return Ok(Vec::new());
        }
        let key = self.api_key()?;
        let mut seen = HashSet::new();
        let unique: Vec<&Candidate> = candidates
            .iter()
            .filter(|c| seen.insert(c.id.as_str()))
            .collect();
        let mut ranked = self.tournament(&key, query, unique, top_k.max(1))?;
        ranked.truncate(top_k);
        Ok(ranked)
    }
}

fn option_text(c: &Candidate) -> String {
    c.text.chars().take(MAX_OPTION_CHARS).collect()
}

fn option_chars(c: &Candidate) -> usize {
    c.text.chars().count().min(MAX_OPTION_CHARS)
}

fn fits_one_question(field: &[&Candidate]) -> bool {
    field.len() <= MAX_OPTIONS
        && field.iter().map(|c| option_chars(c)).sum::<usize>() <= MAX_QUESTION_CHARS
}

/// Cut `field` into consecutive groups that each fit one question.
fn split_into_questions<'a>(field: &[&'a Candidate]) -> Vec<Vec<&'a Candidate>> {
    let mut groups: Vec<Vec<&Candidate>> = Vec::new();
    let mut current: Vec<&Candidate> = Vec::new();
    let mut chars = 0;
    for c in field {
        let len = option_chars(c);
        if !current.is_empty() && (current.len() == MAX_OPTIONS || chars + len > MAX_QUESTION_CHARS)
        {
            groups.push(std::mem::take(&mut current));
            chars = 0;
        }
        current.push(c);
        chars += len;
    }
    if !current.is_empty() {
        groups.push(current);
    }
    groups
}

/// Map Jev's `t{i}` probabilities back to candidate ids: best first, ties in
/// input order, non-finite values dropped, the rest clamped to `[0, 1]`.
/// Options Jev did not score rank last at `0`.
fn from_probabilities(
    probs: &HashMap<String, f32>,
    candidates: &[&Candidate],
) -> Vec<(String, f32)> {
    let mut ranked: Vec<(usize, f32)> = candidates
        .iter()
        .enumerate()
        .filter_map(|(i, _)| match probs.get(&format!("t{i}")) {
            Some(p) if p.is_finite() => Some((i, p.clamp(0.0, 1.0))),
            Some(_) => None,
            None => Some((i, 0.0)),
        })
        .collect();
    ranked.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    ranked
        .into_iter()
        .map(|(i, p)| (candidates[i].id.clone(), p))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use super::*;
    use crate::test_support::{MockHttpRequest, read_http_request_full};

    const KEY: &str = "RATEL_CORE_JEV_TEST_KEY";

    fn set_key() {
        // A unique test-only name no other thread reads.
        unsafe { std::env::set_var(KEY, "jev-token") };
    }

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
    type Answer = Box<dyn Fn(&serde_json::Map<String, serde_json::Value>) -> (u16, String) + Send>;

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
                        let criteria = request.body["questions"]["tool"]["criteria"]
                            .as_object()
                            .cloned()
                            .unwrap_or_default();
                        let (status, body) = answer(&criteria);
                        log.lock().unwrap().push(request);
                        let response = format!(
                            "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n\
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
        Box::new(move |criteria| {
            let probs: serde_json::Map<String, serde_json::Value> = criteria
                .iter()
                .map(|(k, text)| {
                    let p = scores.get(text.as_str().unwrap()).copied().unwrap_or(0.0);
                    (k.clone(), serde_json::json!(p))
                })
                .collect();
            (
                200,
                serde_json::json!({"model": "jev-1.13.0",
                    "answers": {"tool": {"type": "choice", "probabilities": probs}}})
                .to_string(),
            )
        })
    }

    fn client(url: &str) -> JevSystemOne {
        JevSystemOne::new(
            SystemOneConfig::default()
                .with_url(url)
                .with_api_key_env(KEY),
        )
    }

    #[test]
    fn config_defaults_to_jev() {
        let c = SystemOneConfig::default();
        assert_eq!(c.url(), "https://api.typesafe.ai");
        assert_eq!(c.api_key_env(), "TYPESAFE_API_KEY");
        assert_eq!(c.model(), "jev-latest");
    }

    #[test]
    fn asks_one_choice_question_and_ranks_by_probability() {
        set_key();
        let scores = HashMap::from([
            ("text of refund".to_string(), 0.93),
            ("text of list".to_string(), 0.07),
        ]);
        let (url, seen) = mock(by_text(scores), 1);
        let ranked = client(&url)
            .rank("money back", &cands(&["charge", "list", "refund"]), 5)
            .unwrap();
        assert_eq!(
            ranked,
            vec![
                ("refund".into(), 0.93),
                ("list".into(), 0.07),
                ("charge".into(), 0.0)
            ]
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
    fn a_large_catalog_runs_as_a_tournament() {
        set_key();
        // 400 candidates → three groups of ≤150, then a final round.
        let ids: Vec<String> = (0..400).map(|i| format!("tool{i:03}")).collect();
        let id_refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let scores = HashMap::from([
            ("text of tool123".to_string(), 0.9),
            ("text of tool321".to_string(), 0.6),
        ]);
        let (url, seen) = mock(by_text(scores), 4);
        let ranked = client(&url).rank("q", &cands(&id_refs), 2).unwrap();
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
        set_key();
        // 160 candidates in groups of [150, 10]; keeping the top 150 of each
        // would advance the whole field and never finish.
        let ids: Vec<String> = (0..160).map(|i| format!("tool{i:03}")).collect();
        let id_refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let scores = HashMap::from([("text of tool155".to_string(), 0.9)]);
        let (url, seen) = mock(by_text(scores), 3);
        let ranked = client(&url).rank("q", &cands(&id_refs), 150).unwrap();
        assert_eq!(
            ranked[0].0, "tool155",
            "the group-2 winner survives the cut"
        );
        assert!(ranked.len() <= MAX_OPTIONS);
        assert_eq!(
            seen.lock().unwrap().len(),
            3,
            "two groups and one final round"
        );
    }

    #[test]
    fn a_char_budget_split_still_converges() {
        set_key();
        // 50 options of 2,000 chars split [40, 10] by the 80,000-char budget;
        // a reranker depth of 45 would keep every candidate of both groups.
        let many: Vec<Candidate> = (0..50)
            .map(|i| Candidate {
                id: format!("c{i:02}"),
                text: format!("{i:02}{}", "y".repeat(MAX_OPTION_CHARS - 2)),
            })
            .collect();
        let best = many[42].text.clone();
        let (url, seen) = mock(by_text(HashMap::from([(best, 0.8)])), 3);
        let ranked = client(&url).rank("q", &many, 45).unwrap();
        assert_eq!(ranked[0].0, "c42");
        assert_eq!(
            seen.lock().unwrap().len(),
            3,
            "two groups and one final round"
        );
    }

    #[test]
    fn statuses_map_to_typed_errors() {
        set_key();
        let statuses = Arc::new(Mutex::new(vec![401_u16, 429, 529]));
        let answer: Answer = {
            let statuses = statuses.clone();
            Box::new(move |_| (statuses.lock().unwrap().remove(0), "{}".to_string()))
        };
        let (url, _seen) = mock(answer, 3);
        let c = client(&url);
        let call = || c.rank("q", &cands(&["a"]), 1).unwrap_err();
        assert_eq!(call(), SystemOneError::Unauthorized { status: 401 });
        assert_eq!(call(), SystemOneError::RateLimited);
        assert_eq!(call(), SystemOneError::Http { status: 529 });
    }

    #[test]
    fn a_non_ranking_answer_is_malformed() {
        set_key();
        let (url, _seen) = mock(Box::new(|_| (200, r#"{"nope":true}"#.into())), 1);
        assert!(matches!(
            client(&url).rank("q", &cands(&["a"]), 1),
            Err(SystemOneError::Malformed { .. })
        ));
    }

    #[test]
    fn an_unset_key_env_fails_before_any_request() {
        let c = JevSystemOne::new(
            SystemOneConfig::default()
                .with_url("http://127.0.0.1:9")
                .with_api_key_env("RATEL_CORE_JEV_UNSET_KEY"),
        );
        assert!(matches!(
            c.rank("q", &cands(&["a"]), 1),
            Err(SystemOneError::Config { .. })
        ));
    }

    #[test]
    fn an_unreachable_endpoint_is_typed() {
        set_key();
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let err = client(&format!("http://127.0.0.1:{port}"))
            .rank("q", &cands(&["a"]), 1)
            .unwrap_err();
        assert!(matches!(err, SystemOneError::Unreachable { .. }), "{err}");
    }

    #[test]
    fn no_candidates_means_no_request() {
        let c = client("http://127.0.0.1:9");
        assert!(c.rank("q", &[], 5).unwrap().is_empty());
    }

    #[test]
    fn long_option_text_is_capped() {
        let long = Candidate {
            id: "a".into(),
            text: "x".repeat(5_000),
        };
        assert_eq!(option_text(&long).len(), MAX_OPTION_CHARS);
        let many: Vec<Candidate> = (0..60)
            .map(|i| Candidate {
                id: format!("c{i}"),
                text: "y".repeat(MAX_OPTION_CHARS),
            })
            .collect();
        let refs: Vec<&Candidate> = many.iter().collect();
        assert!(!fits_one_question(&refs), "60 × 2,000 chars exceeds 80,000");
        assert_eq!(split_into_questions(&refs).len(), 2);
    }
}
