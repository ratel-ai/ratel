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

/// What kind of catalog item a system-one question picks among. It sets the
/// question's wording, so the model judges a tool, a skill or a fact as what
/// it is, and the question's id in Jev's request and answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum CandidateKind {
    /// A callable tool: the model picks the one to call.
    Tool,
    /// A skill: the model picks the playbook whose instructions help most.
    Skill,
    /// A fact: the model picks the piece of grounding most relevant.
    Fact,
}

impl CandidateKind {
    /// The singular noun: `"tool"`, `"skill"`, `"fact"`. Also the question id.
    #[must_use]
    pub fn noun(&self) -> &'static str {
        match self {
            CandidateKind::Tool => "tool",
            CandidateKind::Skill => "skill",
            CandidateKind::Fact => "fact",
        }
    }

    fn instructions(&self) -> &'static str {
        match self {
            CandidateKind::Tool => "Which tool should be called to handle this request?",
            CandidateKind::Skill => "Which skill's instructions best help with this request?",
            CandidateKind::Fact => "Which fact is most relevant to this request?",
        }
    }
}

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

/// A system-one ranking failed. [`code`](Self::code) is the stable name the
/// SDKs expose; [`is_transient`](Self::is_transient) splits failures a retry
/// may cure from misconfiguration that will fail every time.
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
    /// Jev refused the request itself (400/404/413/422): an unknown model,
    /// options too long, a malformed question. Retrying sends the same thing.
    InvalidRequest {
        /// The HTTP status.
        status: u16,
        /// Jev's explanation, when it gave one.
        message: String,
    },
    /// Jev is rate limiting (429).
    RateLimited {
        /// Seconds to wait, from `Retry-After`, when Jev sent one.
        retry_after_secs: Option<u64>,
    },
    /// Jev is up but cannot take the request now (503/529).
    Overloaded {
        /// The HTTP status.
        status: u16,
    },
    /// The request timed out, locally or at a gateway (504).
    Timeout,
    /// Jev could not be reached: DNS, TLS, connection refused, a bad gateway
    /// (502).
    Unreachable {
        /// The underlying error.
        source: String,
    },
    /// Jev answered with another non-success status.
    Http {
        /// The HTTP status.
        status: u16,
        /// Jev's explanation, when it gave one.
        message: String,
    },
    /// Jev answered success with something that is not a ranking.
    Malformed {
        /// What could not be read.
        source: String,
    },
}

impl SystemOneError {
    /// A stable, machine-readable discriminant for the SDKs.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            SystemOneError::Config { .. } => "Config",
            SystemOneError::Unauthorized { .. } => "Unauthorized",
            SystemOneError::InvalidRequest { .. } => "InvalidRequest",
            SystemOneError::RateLimited { .. } => "RateLimited",
            SystemOneError::Overloaded { .. } => "Overloaded",
            SystemOneError::Timeout => "Timeout",
            SystemOneError::Unreachable { .. } => "Unreachable",
            SystemOneError::Http { .. } => "Http",
            SystemOneError::Malformed { .. } => "Malformed",
        }
    }

    /// Whether a later attempt may succeed. `Config`, `Unauthorized` and
    /// `InvalidRequest` fail the same way every time, so a reranker raises
    /// them instead of silently falling back on every search.
    #[must_use]
    pub fn is_transient(&self) -> bool {
        !matches!(
            self,
            SystemOneError::Config { .. }
                | SystemOneError::Unauthorized { .. }
                | SystemOneError::InvalidRequest { .. }
        )
    }

    /// The HTTP status, when Jev answered with one.
    #[must_use]
    pub fn status(&self) -> Option<u16> {
        match self {
            SystemOneError::Unauthorized { status }
            | SystemOneError::InvalidRequest { status, .. }
            | SystemOneError::Overloaded { status }
            | SystemOneError::Http { status, .. } => Some(*status),
            _ => None,
        }
    }
}

impl fmt::Display for SystemOneError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SystemOneError::Config { message } => write!(f, "system-one config: {message}"),
            SystemOneError::Unauthorized { status } => write!(
                f,
                "jev rejected the key ({status}); check the key in api_key_env"
            ),
            SystemOneError::InvalidRequest { status, message } => {
                write!(f, "jev refused the request ({status}): {message}")
            }
            SystemOneError::RateLimited { retry_after_secs } => match retry_after_secs {
                Some(secs) => write!(f, "jev is rate limiting (429); retry in {secs}s"),
                None => write!(f, "jev is rate limiting (429); retry later"),
            },
            SystemOneError::Overloaded { status } => {
                write!(f, "jev is overloaded ({status}); retry later")
            }
            SystemOneError::Timeout => write!(f, "jev request timed out"),
            SystemOneError::Unreachable { source } => write!(f, "could not reach jev: {source}"),
            SystemOneError::Http { status, message } => {
                write!(f, "jev returned HTTP {status}: {message}")
            }
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
    /// `[0, 1]`, at most `top_k` entries. `kind` is what the candidates are.
    fn rank(
        &self,
        query: &str,
        candidates: &[Candidate],
        top_k: usize,
        kind: CandidateKind,
    ) -> Result<Vec<(String, f32)>, SystemOneError>;
}

#[derive(Deserialize)]
struct JevResponse {
    answers: HashMap<String, JevChoice>,
}

#[derive(Deserialize)]
struct JevChoice {
    probabilities: HashMap<String, f32>,
}

/// The shipped [`SystemOne`]: Jev's `/v1/systemone`, called directly.
pub(crate) struct JevSystemOne {
    config: SystemOneConfig,
    agent: ureq::Agent,
    /// A key that bypasses the environment; tests set it rather than mutate
    /// the process environment other threads are reading.
    key_override: Option<String>,
}

impl JevSystemOne {
    pub(crate) fn new(config: SystemOneConfig) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(SYSTEM_ONE_TIMEOUT_SECS)))
            // Read the status ourselves: error bodies carry Jev's explanation
            // and 429 carries Retry-After.
            .http_status_as_error(false)
            .build()
            .into();
        Self {
            config,
            agent,
            key_override: None,
        }
    }

    /// Use `key` instead of reading the environment.
    #[cfg(test)]
    pub(crate) fn with_key(mut self, key: impl Into<String>) -> Self {
        self.key_override = Some(key.into());
        self
    }

    /// Read the key at call time; an unset variable is a clear `Config` error,
    /// not a downstream 401.
    fn api_key(&self) -> Result<String, SystemOneError> {
        if let Some(key) = &self.key_override {
            return Ok(key.clone());
        }
        let var = &self.config.api_key_env;
        std::env::var(var).map_err(|_| SystemOneError::Config {
            message: format!("api_key_env=\"{var}\" but that environment variable is not set"),
        })
    }

    /// A transport failure: no HTTP status to read.
    fn classify_transport(e: ureq::Error) -> SystemOneError {
        match e {
            ureq::Error::Timeout(_) => SystemOneError::Timeout,
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
        kind: CandidateKind,
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
                kind.noun(): {
                    "type": "choice",
                    "instructions": kind.instructions(),
                    "criteria": criteria
                }
            }
        });
        let url = format!("{}/v1/systemone", self.config.url);
        let mut resp = self
            .agent
            .post(&url)
            .header("content-type", "application/json")
            .header("authorization", &format!("Bearer {key}"))
            .send_json(&body)
            .map_err(Self::classify_transport)?;
        let status = resp.status().as_u16();
        let retry_after = retry_after_secs(resp.headers());
        let text = resp
            .body_mut()
            .with_config()
            .limit(SYSTEM_ONE_RESPONSE_LIMIT_BYTES)
            .read_to_string();
        if !(200..300).contains(&status) {
            // The status decides the error; an unreadable error body only
            // costs the explanation.
            let message = text.map(|t| error_message(&t)).unwrap_or_default();
            return Err(classify_status(status, message, retry_after));
        }
        let text = text.map_err(|e| match e {
            ureq::Error::Timeout(_) => SystemOneError::Timeout,
            other => SystemOneError::Malformed {
                source: format!("unreadable response body: {other}"),
            },
        })?;
        let parsed: JevResponse =
            serde_json::from_str(&text).map_err(|e| SystemOneError::Malformed {
                source: e.to_string(),
            })?;
        let answer = parsed
            .answers
            .get(kind.noun())
            .ok_or_else(|| SystemOneError::Malformed {
                source: format!("no answer to the \"{}\" question", kind.noun()),
            })?;
        Ok(from_probabilities(&answer.probabilities, candidates))
    }

    /// Rank more candidates than one question holds: rank groups in parallel,
    /// advance the best of each, and repeat until the field fits one question.
    ///
    /// Winners are drawn round-robin by rank — every group's best, then every
    /// group's second, … — until one question is full (`MAX_OPTIONS` options,
    /// `MAX_QUESTION_CHARS` characters), so room a small group cannot use goes
    /// to the others and the final question holds as many contenders as it
    /// can. A group advances at most `keep` (the caller's `top_k`: a group's
    /// `keep + 1`-th cannot make the final cut) and at most all but one of its
    /// members, so every round shrinks the field. When even one winner per
    /// group would not fit one question, each group advances only its best and
    /// another round runs.
    fn tournament(
        &self,
        key: &str,
        query: &str,
        candidates: Vec<&Candidate>,
        keep: usize,
        kind: CandidateKind,
    ) -> Result<Vec<(String, f32)>, SystemOneError> {
        let mut field = candidates;
        loop {
            if fits_one_question(&field) {
                return self.ask(key, query, &field, kind);
            }
            let groups = split_into_questions(&field);
            let mut ranked_groups: Vec<Vec<&Candidate>> = Vec::with_capacity(groups.len());
            for batch in groups.chunks(TOURNAMENT_CONCURRENCY) {
                let results: Vec<Result<Vec<(String, f32)>, SystemOneError>> =
                    std::thread::scope(|scope| {
                        let handles: Vec<_> = batch
                            .iter()
                            .map(|group| scope.spawn(|| self.ask(key, query, group, kind)))
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
                    let by_id: HashMap<&str, &Candidate> =
                        group.iter().map(|c| (c.id.as_str(), *c)).collect();
                    let cap = keep.min(group.len().saturating_sub(1)).max(1);
                    let best: Vec<&Candidate> = result?
                        .iter()
                        .filter_map(|(id, _)| by_id.get(id.as_str()).copied())
                        .take(cap)
                        .collect();
                    ranked_groups.push(best);
                }
            }
            let winners = advance(&ranked_groups);
            // Every group of two or more lost at least one member, and a field
            // that needs a tournament has such a group, so this cannot trigger;
            // it guards the loop against a future change to `advance`.
            if winners.len() >= field.len() {
                return Err(SystemOneError::Malformed {
                    source: "tournament made no progress".into(),
                });
            }
            field = winners;
        }
    }
}

/// The candidates that go on to the next round, from each group's ranked,
/// capped contenders: round-robin by rank while one question has room, or just
/// each group's best when even those do not fit one question.
fn advance<'a>(ranked_groups: &[Vec<&'a Candidate>]) -> Vec<&'a Candidate> {
    let firsts: Vec<&Candidate> = ranked_groups
        .iter()
        .filter_map(|g| g.first().copied())
        .collect();
    if !fits_one_question(&firsts) {
        return firsts;
    }
    let (mut winners, mut chars) = (Vec::new(), 0);
    let depth = ranked_groups.iter().map(Vec::len).max().unwrap_or(0);
    for rank in 0..depth {
        for group in ranked_groups {
            let Some(c) = group.get(rank).copied() else {
                continue;
            };
            let len = option_chars(c);
            if winners.len() == MAX_OPTIONS || chars + len > MAX_QUESTION_CHARS {
                return winners;
            }
            winners.push(c);
            chars += len;
        }
    }
    winners
}

impl SystemOne for JevSystemOne {
    fn rank(
        &self,
        query: &str,
        candidates: &[Candidate],
        top_k: usize,
        kind: CandidateKind,
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
        let mut ranked = self.tournament(&key, query, unique, top_k.max(1), kind)?;
        ranked.truncate(top_k);
        Ok(ranked)
    }
}

/// Map a non-2xx Jev status to its error.
fn classify_status(status: u16, message: String, retry_after: Option<u64>) -> SystemOneError {
    match status {
        401 | 403 => SystemOneError::Unauthorized { status },
        400 | 404 | 413 | 422 => SystemOneError::InvalidRequest { status, message },
        429 => SystemOneError::RateLimited {
            retry_after_secs: retry_after,
        },
        503 | 529 => SystemOneError::Overloaded { status },
        504 => SystemOneError::Timeout,
        502 => SystemOneError::Unreachable {
            source: format!("bad gateway (502): {message}"),
        },
        _ => SystemOneError::Http { status, message },
    }
}

/// `Retry-After` in seconds, when sent in that form.
pub(crate) fn retry_after_secs(headers: &ureq::http::HeaderMap) -> Option<u64> {
    headers
        .get("retry-after")?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
}

/// An error body's explanation: `{"error":{"message"}}`, `{"error":"…"}`,
/// `{"detail":"…"}` or `{"message":"…"}`, else the start of the raw body.
pub(crate) fn error_message(body: &str) -> String {
    let parsed: Option<serde_json::Value> = serde_json::from_str(body).ok();
    parsed
        .as_ref()
        .and_then(|v| {
            v["error"]["message"]
                .as_str()
                .or_else(|| v["error"].as_str())
                .or_else(|| v["detail"].as_str())
                .or_else(|| v["message"].as_str())
        })
        .map(str::to_string)
        .unwrap_or_else(|| body.chars().take(500).collect())
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
                String::new(),
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
        .with_key("jev-token")
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
        let (url, seen) = mock(by_text(scores), 3);
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
        let (url, seen) = mock(by_text(HashMap::from([(best, 0.8)])), 3);
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
        let invalid = |status, message: &str| SystemOneError::InvalidRequest {
            status,
            message: message.into(),
        };
        assert_eq!(call(), invalid(400, "bad question"));
        assert_eq!(call(), SystemOneError::Unauthorized { status: 401 });
        assert_eq!(call(), SystemOneError::Unauthorized { status: 403 });
        assert_eq!(call(), invalid(404, "no such model"));
        assert_eq!(call(), invalid(413, "too long"));
        assert_eq!(call(), invalid(422, "too many options"));
        assert_eq!(
            call(),
            SystemOneError::RateLimited {
                retry_after_secs: Some(7)
            }
        );
        assert_eq!(
            call(),
            SystemOneError::RateLimited {
                retry_after_secs: None
            }
        );
        assert_eq!(
            call(),
            SystemOneError::Http {
                status: 500,
                message: "boom".into()
            }
        );
        assert!(matches!(call(), SystemOneError::Unreachable { .. }));
        assert_eq!(call(), SystemOneError::Overloaded { status: 503 });
        assert_eq!(call(), SystemOneError::Timeout);
        assert_eq!(call(), SystemOneError::Overloaded { status: 529 });
    }

    #[test]
    fn codes_and_transience_split_misconfiguration_from_outages() {
        let cases = [
            (
                SystemOneError::Config {
                    message: String::new(),
                },
                "Config",
                false,
            ),
            (
                SystemOneError::Unauthorized { status: 401 },
                "Unauthorized",
                false,
            ),
            (
                SystemOneError::InvalidRequest {
                    status: 422,
                    message: String::new(),
                },
                "InvalidRequest",
                false,
            ),
            (
                SystemOneError::RateLimited {
                    retry_after_secs: None,
                },
                "RateLimited",
                true,
            ),
            (
                SystemOneError::Overloaded { status: 529 },
                "Overloaded",
                true,
            ),
            (SystemOneError::Timeout, "Timeout", true),
            (
                SystemOneError::Unreachable {
                    source: String::new(),
                },
                "Unreachable",
                true,
            ),
            (
                SystemOneError::Http {
                    status: 500,
                    message: String::new(),
                },
                "Http",
                true,
            ),
            (
                SystemOneError::Malformed {
                    source: String::new(),
                },
                "Malformed",
                true,
            ),
        ];
        for (error, code, transient) in cases {
            assert_eq!(error.code(), code);
            assert_eq!(error.is_transient(), transient, "{code}");
        }
        assert_eq!(
            SystemOneError::Overloaded { status: 529 }.status(),
            Some(529)
        );
        assert_eq!(SystemOneError::Timeout.status(), None);
    }

    #[test]
    fn a_non_ranking_answer_is_malformed() {
        let (url, _seen) = mock(
            Box::new(|_| (200, String::new(), r#"{"nope":true}"#.into())),
            1,
        );
        assert!(matches!(
            client(&url).rank("q", &cands(&["a"]), 1, CandidateKind::Tool),
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
            c.rank("q", &cands(&["a"]), 1, CandidateKind::Tool),
            Err(SystemOneError::Config { .. })
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
        assert!(matches!(err, SystemOneError::Unreachable { .. }), "{err}");
    }

    #[test]
    fn no_candidates_means_no_request() {
        let c = client("http://127.0.0.1:9");
        assert!(c.rank("q", &[], 5, CandidateKind::Tool).unwrap().is_empty());
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
