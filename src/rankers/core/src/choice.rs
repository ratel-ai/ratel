//! What every decision-model backend shares (ADR-0028): the [`ChoiceRanker`]
//! that drives a [`ChoiceBackend`], the limits, the tournament, the HTTP status
//! mapping and the error type.
//!
//! A backend answers a `choice` question over named options with a probability
//! per option, so one call ranks up to [`MAX_OPTIONS`] candidates. A larger
//! candidate set runs as a tournament: groups that fit one question are ranked
//! in parallel, their winners advance, and the last round fits one question.
//! A backend supplies only its wire format ([`ChoiceBackend::ask`]).

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::time::Duration;

/// Options per question. Jev and OpenAI both accept 2 to 255; 150 keeps each
/// question well inside Jev's token budget, and OpenAI gets the same.
pub const MAX_OPTIONS: usize = 150;

/// The fewest options a question may offer: OpenAI refuses a one-choice
/// question. A lone candidate is the pick without asking.
pub const MIN_OPTIONS: usize = 2;

/// Characters of option text per question. A question's options and the query
/// must fit Jev's 32k-token budget.
pub const MAX_QUESTION_CHARS: usize = 80_000;
/// Characters of option text per option; longer text is cut ([`option_text`]).
pub const MAX_OPTION_CHARS: usize = 2_000;

/// Below this probability the model is saying "not this one": such options pad
/// `top_k` as filler rather than being picks, so a ranking drops them (the
/// best pick always stays).
pub const MIN_PROBABILITY: f32 = 0.01;

/// How many tournament groups run at once.
const TOURNAMENT_CONCURRENCY: usize = 6;

/// Per request. Jev answers a question in well under a second and OpenAI
/// Decisions in about 2 s (median); a call that takes this long is broken, not
/// slow. A tournament runs its rounds back to back, so a large catalog's search
/// takes a few calls' latency, each under this limit.
const TIMEOUT_SECS: u64 = 15;

/// An answer is a probability per option; anything near this size is not one.
const RESPONSE_LIMIT_BYTES: u64 = 4 * 1024 * 1024;

/// A catalog item offered to a ranker: its id, returned to rank it, and the
/// text the model reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    /// The item's id; rankings name candidates by it.
    pub id: String,
    /// What the model reads (capped at [`MAX_OPTION_CHARS`]).
    pub text: String,
}

/// What kind of catalog item a question picks among. It sets the question's
/// wording, so the model judges a tool, a skill or a fact as what it is, and
/// the question's name in the request and answer.
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
    /// The singular noun: `"tool"`, `"skill"`, `"fact"`. Also the question's name.
    #[must_use]
    pub fn noun(&self) -> &'static str {
        match self {
            CandidateKind::Tool => "tool",
            CandidateKind::Skill => "skill",
            CandidateKind::Fact => "fact",
        }
    }

    /// The question a backend asks: which candidate of this kind fits best.
    #[must_use]
    pub fn instructions(&self) -> &'static str {
        match self {
            CandidateKind::Tool => "Which tool should be called to handle this request?",
            CandidateKind::Skill => "Which skill's instructions best help with this request?",
            CandidateKind::Fact => "Which fact is most relevant to this request?",
        }
    }
}

impl std::str::FromStr for CandidateKind {
    type Err = ParseCandidateKindError;

    /// From its [`noun`](Self::noun): `"tool"`, `"skill"`, `"fact"`.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "tool" => Ok(CandidateKind::Tool),
            "skill" => Ok(CandidateKind::Skill),
            "fact" => Ok(CandidateKind::Fact),
            other => Err(ParseCandidateKindError(other.to_string())),
        }
    }
}

/// A string that names no [`CandidateKind`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseCandidateKindError(String);

impl fmt::Display for ParseCandidateKindError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "unknown candidate kind {:?} (expected \"tool\", \"skill\" or \"fact\")",
            self.0
        )
    }
}

impl std::error::Error for ParseCandidateKindError {}

/// A decision-model ranking failed. [`code`](Self::code) is the stable name
/// the SDKs expose; [`is_transient`](Self::is_transient) splits failures a
/// retry may cure from misconfiguration that will fail every time.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum RankerError {
    /// Misconfigured before any request was sent — e.g. the key's
    /// environment variable is not set.
    Config {
        /// What is wrong.
        message: String,
    },
    /// The service rejected the key (401/403).
    Unauthorized {
        /// The HTTP status.
        status: u16,
    },
    /// The service refused the request itself (400/404/413/422): an unknown
    /// model, options too long, a malformed question. Retrying sends the same
    /// thing.
    InvalidRequest {
        /// The HTTP status.
        status: u16,
        /// The service's explanation, when it gave one.
        message: String,
    },
    /// The service is rate limiting (429).
    RateLimited {
        /// Seconds to wait, from `Retry-After`, when the service sent one.
        retry_after_secs: Option<u64>,
    },
    /// The service is up but cannot take the request now (503/529).
    Overloaded {
        /// The HTTP status.
        status: u16,
    },
    /// The request timed out, locally or at a gateway (504).
    Timeout,
    /// The service could not be reached: DNS, TLS, connection refused, a bad
    /// gateway (502).
    Unreachable {
        /// The underlying error.
        source: String,
    },
    /// The service answered with another non-success status.
    Http {
        /// The HTTP status.
        status: u16,
        /// The service's explanation, when it gave one.
        message: String,
    },
    /// The service answered success with something that is not a ranking.
    Malformed {
        /// What could not be read.
        source: String,
    },
    /// The model declined to answer the question (OpenAI's `refusal` answer).
    /// It says no reason; a reranker keeps the first stage's order.
    Refused,
}

impl RankerError {
    /// A stable, machine-readable discriminant for the SDKs.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            RankerError::Config { .. } => "Config",
            RankerError::Unauthorized { .. } => "Unauthorized",
            RankerError::InvalidRequest { .. } => "InvalidRequest",
            RankerError::RateLimited { .. } => "RateLimited",
            RankerError::Overloaded { .. } => "Overloaded",
            RankerError::Timeout => "Timeout",
            RankerError::Unreachable { .. } => "Unreachable",
            RankerError::Http { .. } => "Http",
            RankerError::Malformed { .. } => "Malformed",
            RankerError::Refused => "Refused",
        }
    }

    /// Whether a later attempt may succeed. `Config`, `Unauthorized` and
    /// `InvalidRequest` fail the same way every time, so a reranker raises
    /// them instead of silently falling back on every search.
    #[must_use]
    pub fn is_transient(&self) -> bool {
        !matches!(
            self,
            RankerError::Config { .. }
                | RankerError::Unauthorized { .. }
                | RankerError::InvalidRequest { .. }
        )
    }

    /// The HTTP status, when the service answered with one.
    #[must_use]
    pub fn status(&self) -> Option<u16> {
        match self {
            RankerError::Unauthorized { status }
            | RankerError::InvalidRequest { status, .. }
            | RankerError::Overloaded { status }
            | RankerError::Http { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// The error as a sentence naming `service` (e.g. `"jev"`), which
    /// [`Display`](fmt::Display) leaves generic.
    #[must_use]
    pub fn describe(&self, service: &str) -> String {
        match self {
            RankerError::Config { message } => format!("{service} config: {message}"),
            RankerError::Unauthorized { status } => {
                format!("{service} rejected the key ({status}); check the key its env var holds")
            }
            RankerError::InvalidRequest { status, message } => {
                format!("{service} refused the request ({status}): {message}")
            }
            RankerError::RateLimited { retry_after_secs } => match retry_after_secs {
                Some(secs) => format!("{service} is rate limiting (429); retry in {secs}s"),
                None => format!("{service} is rate limiting (429); retry later"),
            },
            RankerError::Overloaded { status } => {
                format!("{service} is overloaded ({status}); retry later")
            }
            RankerError::Timeout => format!("{service} request timed out"),
            RankerError::Unreachable { source } => format!("could not reach {service}: {source}"),
            RankerError::Http { status, message } => {
                format!("{service} returned HTTP {status}: {message}")
            }
            RankerError::Malformed { source } => format!("malformed {service} response: {source}"),
            RankerError::Refused => format!("{service} declined to answer the question"),
        }
    }
}

impl fmt::Display for RankerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.describe("decision model"))
    }
}

impl std::error::Error for RankerError {}

/// One decision model's wire format (ADR-0028): its endpoint, key and request
/// shape. A [`ChoiceRanker`] drives it, and owns everything else: the key
/// lookup, limits, tournament and filtering. A new vendor is one backend.
pub trait ChoiceBackend: Sync {
    /// The service as errors name it, lower case: `"jev"`, `"openai decisions"`.
    fn service(&self) -> &'static str;

    /// Whose key the backend sends, for the unset-key message: `"Jev"`, `"OpenAI"`.
    fn key_owner(&self) -> &'static str;

    /// The environment variable holding the key, read at call time.
    fn key_env(&self) -> &str;

    /// Ask one `choice` question over `candidates`, which fit one question
    /// (between [`MIN_OPTIONS`] and [`MAX_OPTIONS`], at most
    /// [`MAX_QUESTION_CHARS`]), and return every candidate with its
    /// probability, best first, ties in input order — [`from_probabilities`]
    /// does that last step.
    ///
    /// # Errors
    /// A [`RankerError`] when the request fails or the answer is not a ranking.
    fn ask(
        &self,
        http: &Http,
        key: &str,
        query: &str,
        candidates: &[&Candidate],
        kind: CandidateKind,
    ) -> Result<Vec<(String, f32)>, RankerError>;
}

/// The HTTP client a backend sends with: a global timeout, and statuses mapped
/// to [`RankerError`]s (error bodies carry the explanation; 429 carries
/// `Retry-After`).
pub struct Http {
    agent: ureq::Agent,
}

impl Http {
    fn new() -> Self {
        Self {
            agent: ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(TIMEOUT_SECS)))
                .http_status_as_error(false)
                .build()
                .into(),
        }
    }

    /// POST `body` to `url` with a bearer `key`; the success body as text, or
    /// the failure as a typed error.
    ///
    /// # Errors
    /// A [`RankerError`] for a transport failure, a non-2xx status or an
    /// unreadable body.
    pub fn post_json(
        &self,
        url: &str,
        key: &str,
        body: &serde_json::Value,
    ) -> Result<String, RankerError> {
        let mut resp = self
            .agent
            .post(url)
            .header("content-type", "application/json")
            .header("authorization", &format!("Bearer {key}"))
            .send_json(body)
            .map_err(classify_transport)?;
        let status = resp.status().as_u16();
        let retry_after = retry_after_secs(resp.headers());
        let text = resp
            .body_mut()
            .with_config()
            .limit(RESPONSE_LIMIT_BYTES)
            .read_to_string();
        if !(200..300).contains(&status) {
            // The status decides the error; an unreadable error body only costs
            // the explanation.
            let message = text.map(|t| error_message(&t)).unwrap_or_default();
            return Err(classify_status(status, message, retry_after));
        }
        text.map_err(|e| match e {
            ureq::Error::Timeout(_) => RankerError::Timeout,
            other => RankerError::Malformed {
                source: format!("unreadable response body: {other}"),
            },
        })
    }
}

/// A decision model as a ranker: `B`'s wire format behind the shared limits,
/// tournament and filtering. Building one opens no connection.
pub struct ChoiceRanker<B> {
    backend: B,
    http: Http,
    /// A key that bypasses the environment; tests set it rather than mutate
    /// the process environment other threads are reading.
    key_override: Option<String>,
}

impl<B: ChoiceBackend> ChoiceRanker<B> {
    /// A ranker over `backend`; the key is read from its env var at call time.
    #[must_use]
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            http: Http::new(),
            key_override: None,
        }
    }

    /// The backend this ranker drives.
    #[must_use]
    pub fn backend(&self) -> &B {
        &self.backend
    }

    /// Use `key` instead of reading the environment.
    #[cfg(test)]
    pub(crate) fn with_key(mut self, key: impl Into<String>) -> Self {
        self.key_override = Some(key.into());
        self
    }

    /// Rank `candidates` for `query`: `(id, probability)` best first, every id
    /// one of `candidates`, at most `top_k`. Picks below [`MIN_PROBABILITY`]
    /// are dropped, except the best one. `kind` is what the candidates are;
    /// the model is asked about tools, skills or facts accordingly.
    ///
    /// # Errors
    /// [`RankerError`] when the key is unset, the service refuses the request
    /// or the model declines to answer, or it cannot be reached or understood.
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
        let key = api_key(
            self.key_override.as_deref(),
            self.backend.key_env(),
            self.backend.key_owner(),
        )?;
        rank(self, &key, query, candidates, top_k, kind)
    }
}

/// The tournament's view of a ranker: one question, the key already read.
trait AskChoice: Sync {
    fn ask(
        &self,
        key: &str,
        query: &str,
        candidates: &[&Candidate],
        kind: CandidateKind,
    ) -> Result<Vec<(String, f32)>, RankerError>;
}

impl<B: ChoiceBackend> AskChoice for ChoiceRanker<B> {
    fn ask(
        &self,
        key: &str,
        query: &str,
        candidates: &[&Candidate],
        kind: CandidateKind,
    ) -> Result<Vec<(String, f32)>, RankerError> {
        self.backend.ask(&self.http, key, query, candidates, kind)
    }
}

/// The key, from `key_override` (tests) or the environment variable `var` at
/// call time; an unset variable is a clear `Config` error, not a downstream 401.
fn api_key(key_override: Option<&str>, var: &str, whose: &str) -> Result<String, RankerError> {
    if let Some(key) = key_override {
        return Ok(key.to_string());
    }
    std::env::var(var).map_err(|_| RankerError::Config {
        message: format!("{var} is not set; put the {whose} key in it"),
    })
}

/// Rank `candidates` for `query` through `asker`: `(id, probability)` best
/// first, every id one of `candidates`, at most `top_k`. Picks below
/// [`MIN_PROBABILITY`] are dropped, except the best one.
fn rank(
    asker: &impl AskChoice,
    key: &str,
    query: &str,
    candidates: &[Candidate],
    top_k: usize,
    kind: CandidateKind,
) -> Result<Vec<(String, f32)>, RankerError> {
    if candidates.is_empty() || top_k == 0 {
        return Ok(Vec::new());
    }
    let mut seen = HashSet::new();
    let unique: Vec<&Candidate> = candidates
        .iter()
        .filter(|c| seen.insert(c.id.as_str()))
        .collect();
    let mut ranked = tournament(asker, key, query, unique, top_k.max(1), kind)?;
    // Keep the best pick even when every probability is low (a large,
    // uncertain field spreads probability thin), and drop the near-zero tail.
    let mut position = 0;
    ranked.retain(|(_, p)| {
        position += 1;
        position == 1 || *p >= MIN_PROBABILITY
    });
    ranked.truncate(top_k);
    Ok(ranked)
}

/// Rank more candidates than one question holds: rank groups in parallel,
/// advance the best of each, and repeat until the field fits one question.
///
/// Winners are drawn round-robin by rank — every group's best, then every
/// group's second, … — until one question is full (`MAX_OPTIONS` options,
/// `MAX_QUESTION_CHARS` characters), so room a small group cannot use goes to
/// the others and the final question holds as many contenders as it can. A
/// group advances at most `keep` (the caller's `top_k`: a group's `keep + 1`-th
/// cannot make the final cut) and at most all but one of its members, so every
/// round shrinks the field. When even one winner per group would not fit one
/// question, each group advances only its best and another round runs.
fn tournament(
    asker: &impl AskChoice,
    key: &str,
    query: &str,
    candidates: Vec<&Candidate>,
    keep: usize,
    kind: CandidateKind,
) -> Result<Vec<(String, f32)>, RankerError> {
    let mut field = candidates;
    loop {
        if fits_one_question(&field) {
            return ask(asker, key, query, &field, kind);
        }
        let groups = split_into_questions(&field);
        let mut ranked_groups: Vec<Vec<&Candidate>> = Vec::with_capacity(groups.len());
        for batch in groups.chunks(TOURNAMENT_CONCURRENCY) {
            let results: Vec<Result<Vec<(String, f32)>, RankerError>> =
                std::thread::scope(|scope| {
                    let handles: Vec<_> = batch
                        .iter()
                        .map(|group| scope.spawn(|| ask(asker, key, query, group, kind)))
                        .collect();
                    handles
                        .into_iter()
                        .map(|h| {
                            h.join().unwrap_or_else(|_| {
                                Err(RankerError::Malformed {
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
            return Err(RankerError::Malformed {
                source: "tournament made no progress".into(),
            });
        }
        field = winners;
    }
}

/// Ask one question over `field`, which fits one: a lone candidate is the
/// pick at probability 1 without a request.
fn ask(
    asker: &impl AskChoice,
    key: &str,
    query: &str,
    field: &[&Candidate],
    kind: CandidateKind,
) -> Result<Vec<(String, f32)>, RankerError> {
    if let [only] = field {
        return Ok(vec![(only.id.clone(), 1.0)]);
    }
    debug_assert!(
        (MIN_OPTIONS..=MAX_OPTIONS).contains(&field.len()),
        "a question offers {} options",
        field.len()
    );
    asker.ask(key, query, field, kind)
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

/// A transport failure: no HTTP status to read.
fn classify_transport(e: ureq::Error) -> RankerError {
    match e {
        ureq::Error::Timeout(_) => RankerError::Timeout,
        other => RankerError::Unreachable {
            source: other.to_string(),
        },
    }
}

/// Map a non-2xx status to its error.
fn classify_status(status: u16, message: String, retry_after: Option<u64>) -> RankerError {
    match status {
        401 | 403 => RankerError::Unauthorized { status },
        400 | 404 | 413 | 422 => RankerError::InvalidRequest { status, message },
        429 => RankerError::RateLimited {
            retry_after_secs: retry_after,
        },
        503 | 529 => RankerError::Overloaded { status },
        504 => RankerError::Timeout,
        502 => RankerError::Unreachable {
            source: format!("bad gateway (502): {message}"),
        },
        _ => RankerError::Http { status, message },
    }
}

/// `Retry-After` in seconds, when sent in that form.
fn retry_after_secs(headers: &ureq::http::HeaderMap) -> Option<u64> {
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
fn error_message(body: &str) -> String {
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

/// A candidate's option text, capped at [`MAX_OPTION_CHARS`].
#[must_use]
pub fn option_text(c: &Candidate) -> String {
    c.text.chars().take(MAX_OPTION_CHARS).collect()
}

fn option_chars(c: &Candidate) -> usize {
    c.text.chars().count().min(MAX_OPTION_CHARS)
}

fn fits_one_question(field: &[&Candidate]) -> bool {
    field.len() <= MAX_OPTIONS
        && field.iter().map(|c| option_chars(c)).sum::<usize>() <= MAX_QUESTION_CHARS
}

/// Cut `field` into consecutive groups that each fit one question, none a
/// lone option ([`MIN_OPTIONS`]).
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
    // Only the last group can be a lone option: an earlier one closed full,
    // and a full group holds at least `MAX_QUESTION_CHARS / MAX_OPTION_CHARS`
    // (40) options. Its predecessor lends it one, and both still fit.
    if current.len() == 1
        && let Some(lent) = groups.last_mut().and_then(Vec::pop)
    {
        current.insert(0, lent);
    }
    if !current.is_empty() {
        groups.push(current);
    }
    groups
}

/// Map `t{i}` probabilities back to candidate ids: best first, ties in input
/// order, non-finite values dropped, the rest clamped to `[0, 1]`. Options the
/// model did not score rank last at `0`. Backends name option `i` `t{i}`.
#[must_use]
pub fn from_probabilities(
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
    use super::*;

    /// A vendor-free backend: scores option `i` by a table keyed on text and
    /// counts its questions. No HTTP, so it shows the trait alone suffices.
    struct Table {
        scores: HashMap<&'static str, f32>,
        asked: std::sync::Mutex<Vec<usize>>,
    }

    impl ChoiceBackend for Table {
        fn service(&self) -> &'static str {
            "table"
        }
        fn key_owner(&self) -> &'static str {
            "Table"
        }
        fn key_env(&self) -> &str {
            "RATEL_RANKERS_TABLE_UNSET_KEY"
        }
        fn ask(
            &self,
            _http: &Http,
            key: &str,
            _query: &str,
            candidates: &[&Candidate],
            _kind: CandidateKind,
        ) -> Result<Vec<(String, f32)>, RankerError> {
            assert_eq!(key, "k");
            self.asked.lock().unwrap().push(candidates.len());
            let probs = candidates
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    let p = self.scores.get(c.text.as_str()).copied().unwrap_or(0.0);
                    (format!("t{i}"), p)
                })
                .collect();
            Ok(from_probabilities(&probs, candidates))
        }
    }

    fn table(scores: &[(&'static str, f32)]) -> ChoiceRanker<Table> {
        ChoiceRanker::new(Table {
            scores: scores.iter().copied().collect(),
            asked: std::sync::Mutex::new(Vec::new()),
        })
    }

    fn field(n: usize) -> Vec<Candidate> {
        (0..n)
            .map(|i| Candidate {
                id: format!("c{i}"),
                text: format!("text {i}"),
            })
            .collect()
    }

    #[test]
    fn any_backend_gets_the_tournament_and_filtering() {
        let ranker = table(&[("text 7", 0.9), ("text 299", 0.5)]).with_key("k");
        let ranked = ranker
            .rank("q", &field(300), 3, CandidateKind::Tool)
            .unwrap();
        assert_eq!(ranked, vec![("c7".into(), 0.9), ("c299".into(), 0.5)]);
        let asked = ranker.backend().asked.lock().unwrap().clone();
        assert_eq!(asked.len(), 3, "two groups and a final: {asked:?}");
        assert!(
            asked
                .iter()
                .all(|n| (MIN_OPTIONS..=MAX_OPTIONS).contains(n))
        );
    }

    #[test]
    fn a_backends_unset_key_is_a_config_error_naming_it() {
        let err = table(&[])
            .rank("q", &field(2), 1, CandidateKind::Tool)
            .unwrap_err();
        assert_eq!(err.code(), "Config");
        assert!(err.to_string().contains("put the Table key"), "{err}");
    }

    #[test]
    fn codes_and_transience_split_misconfiguration_from_outages() {
        let cases = [
            (
                RankerError::Config {
                    message: String::new(),
                },
                "Config",
                false,
            ),
            (
                RankerError::Unauthorized { status: 401 },
                "Unauthorized",
                false,
            ),
            (
                RankerError::InvalidRequest {
                    status: 422,
                    message: String::new(),
                },
                "InvalidRequest",
                false,
            ),
            (
                RankerError::RateLimited {
                    retry_after_secs: None,
                },
                "RateLimited",
                true,
            ),
            (RankerError::Overloaded { status: 529 }, "Overloaded", true),
            (RankerError::Timeout, "Timeout", true),
            (
                RankerError::Unreachable {
                    source: String::new(),
                },
                "Unreachable",
                true,
            ),
            (
                RankerError::Http {
                    status: 500,
                    message: String::new(),
                },
                "Http",
                true,
            ),
            (
                RankerError::Malformed {
                    source: String::new(),
                },
                "Malformed",
                true,
            ),
            (RankerError::Refused, "Refused", true),
        ];
        for (error, code, transient) in cases {
            assert_eq!(error.code(), code);
            assert_eq!(error.is_transient(), transient, "{code}");
        }
        assert_eq!(RankerError::Overloaded { status: 529 }.status(), Some(529));
        assert_eq!(RankerError::Timeout.status(), None);
        assert_eq!(RankerError::Refused.status(), None);
    }

    #[test]
    fn errors_name_the_service_they_came_from() {
        assert_eq!(
            RankerError::Timeout.describe("jev"),
            "jev request timed out"
        );
        assert_eq!(
            RankerError::Refused.describe("openai decisions"),
            "openai decisions declined to answer the question"
        );
        assert_eq!(
            RankerError::Timeout.to_string(),
            "decision model request timed out"
        );
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

    #[test]
    fn a_split_leaves_no_one_option_group() {
        let many: Vec<Candidate> = (0..151)
            .map(|i| Candidate {
                id: format!("c{i}"),
                text: "y".into(),
            })
            .collect();
        let refs: Vec<&Candidate> = many.iter().collect();
        let sizes: Vec<usize> = split_into_questions(&refs).iter().map(Vec::len).collect();
        assert_eq!(sizes, vec![149, 2]);
        let order: Vec<&str> = split_into_questions(&refs)
            .concat()
            .iter()
            .map(|c| c.id.as_str())
            .collect();
        let ids: Vec<&str> = many.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(order, ids, "rebalancing keeps the field's order");
    }
}
