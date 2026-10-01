//! System-one ranking: a hosted model picks the best candidates for a query
//! from a closed set (ADR-0026).
//!
//! Core speaks one wire contract — Ratel Cloud's `POST /v1/systemone` — and
//! never a provider's: the provider adapters (Jev, later OpenAI Decisions) live
//! behind that endpoint, so adding one needs no core or SDK release. The client
//! sits behind the crate-private [`SystemOne`] trait so a test (or a later
//! direct-to-provider client) can stand in for it.

use std::collections::HashSet;
use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Where the system-one endpoint lives unless a catalog overrides it.
pub const DEFAULT_SYSTEM_ONE_URL: &str = "https://app.ratel.sh/v1/systemone";

/// The environment variable holding the bearer key unless overridden.
pub const DEFAULT_SYSTEM_ONE_API_KEY_ENV: &str = "RATEL_API_KEY";

/// Generous next to the ~100–400 ms the endpoint takes for one round: a
/// catalog above the provider's candidate limit costs a second round, and a
/// cold provider can be slow. A search that hangs longer than this is broken,
/// not slow.
const SYSTEM_ONE_TIMEOUT_SECS: u64 = 15;

/// A ranking response is a list of ids and scores; anything near this size is
/// not one.
const SYSTEM_ONE_RESPONSE_LIMIT_BYTES: u64 = 8 * 1024 * 1024;

/// Which system-one endpoint a registry calls, and where its key comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemOneConfig {
    url: String,
    api_key_env: String,
}

impl Default for SystemOneConfig {
    fn default() -> Self {
        Self {
            url: DEFAULT_SYSTEM_ONE_URL.into(),
            api_key_env: DEFAULT_SYSTEM_ONE_API_KEY_ENV.into(),
        }
    }
}

impl SystemOneConfig {
    /// Call `url` instead of Ratel Cloud's endpoint (staging, a self-hosted
    /// proxy, tests).
    #[must_use]
    pub fn with_url(mut self, url: impl Into<String>) -> Self {
        self.url = url.into();
        self
    }

    /// Read the bearer key from the environment variable `name` instead of
    /// `RATEL_API_KEY`. Read at search time, so it may be set after
    /// construction.
    #[must_use]
    pub fn with_api_key_env(mut self, name: impl Into<String>) -> Self {
        self.api_key_env = name.into();
        self
    }

    /// The endpoint URL.
    #[must_use]
    pub fn url(&self) -> &str {
        &self.url
    }

    /// The name of the environment variable holding the key.
    #[must_use]
    pub fn api_key_env(&self) -> &str {
        &self.api_key_env
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
    /// The endpoint rejected the key (401/403).
    Unauthorized {
        /// The HTTP status.
        status: u16,
    },
    /// The endpoint or its provider is rate limiting (429).
    RateLimited,
    /// The endpoint answered with another non-success status.
    Http {
        /// The HTTP status.
        status: u16,
    },
    /// The endpoint could not be reached: DNS, TLS, connection refused, timeout.
    Unreachable {
        /// The underlying transport error.
        source: String,
    },
    /// The endpoint answered with something that is not a ranking.
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
                "system-one endpoint rejected the key ({status}); check the key in api_key_env"
            ),
            SystemOneError::RateLimited => {
                write!(f, "system-one endpoint is rate limiting (429); retry later")
            }
            SystemOneError::Http { status } => {
                write!(f, "system-one endpoint returned HTTP {status}")
            }
            SystemOneError::Unreachable { source } => {
                write!(f, "could not reach the system-one endpoint: {source}")
            }
            SystemOneError::Malformed { source } => {
                write!(f, "malformed system-one response: {source}")
            }
        }
    }
}

impl std::error::Error for SystemOneError {}

/// One option the model may pick: an id and the text it is judged on.
#[derive(Debug, Clone, Serialize)]
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

#[derive(Serialize)]
struct RankRequest<'a> {
    query: &'a str,
    candidates: &'a [Candidate],
    top_k: usize,
}

#[derive(Deserialize)]
struct RankResponse {
    ranked: Vec<RankedEntry>,
}

#[derive(Deserialize)]
struct RankedEntry {
    id: String,
    score: f32,
}

/// The shipped [`SystemOne`]: Ratel Cloud's `/v1/systemone` over HTTP.
pub(crate) struct RatelCloudSystemOne {
    config: SystemOneConfig,
    agent: ureq::Agent,
}

impl RatelCloudSystemOne {
    pub(crate) fn new(config: SystemOneConfig) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(SYSTEM_ONE_TIMEOUT_SECS)))
            .build()
            .into();
        Self { config, agent }
    }

    /// Read the key at call time, so it may be set after construction. An
    /// unset variable is a clear `Config` error, not a downstream 401.
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
}

impl SystemOne for RatelCloudSystemOne {
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
        let body = RankRequest {
            query,
            candidates,
            top_k,
        };
        let mut resp = self
            .agent
            .post(&self.config.url)
            .header("content-type", "application/json")
            .header("authorization", &format!("Bearer {key}"))
            .send_json(&body)
            .map_err(Self::classify)?;
        let parsed: RankResponse = resp
            .body_mut()
            .with_config()
            .limit(SYSTEM_ONE_RESPONSE_LIMIT_BYTES)
            .read_json()
            .map_err(|e| SystemOneError::Malformed {
                source: e.to_string(),
            })?;
        Ok(sanitize(parsed.ranked, candidates, top_k))
    }
}

/// Hold the endpoint to the contract: ids it was not offered are dropped, a
/// repeated id keeps its first (best) entry, non-finite scores are dropped and
/// the rest clamped to `[0, 1]`, and the list is cut at `top_k`. The order is
/// the endpoint's — it is the ranking.
fn sanitize(
    ranked: Vec<RankedEntry>,
    candidates: &[Candidate],
    top_k: usize,
) -> Vec<(String, f32)> {
    let offered: HashSet<&str> = candidates.iter().map(|c| c.id.as_str()).collect();
    let mut seen: HashSet<String> = HashSet::new();
    ranked
        .into_iter()
        .filter(|e| offered.contains(e.id.as_str()))
        .filter(|e| e.score.is_finite())
        .filter(|e| seen.insert(e.id.clone()))
        .map(|e| (e.id, e.score.clamp(0.0, 1.0)))
        .take(top_k)
        .collect()
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::time::Instant;

    use super::*;
    use crate::test_support::read_http_request;

    fn cands(ids: &[&str]) -> Vec<Candidate> {
        ids.iter()
            .map(|id| Candidate {
                id: (*id).into(),
                text: format!("text of {id}"),
            })
            .collect()
    }

    fn entry(id: &str, score: f32) -> RankedEntry {
        RankedEntry {
            id: id.into(),
            score,
        }
    }

    #[test]
    fn sanitize_drops_unknown_and_repeated_ids_and_clamps() {
        let out = sanitize(
            vec![
                entry("b", 1.7),
                entry("ghost", 0.9),
                entry("a", 0.4),
                entry("b", 0.1),
                entry("c", f32::NAN),
                entry("c", -0.2),
            ],
            &cands(&["a", "b", "c"]),
            10,
        );
        assert_eq!(
            out,
            vec![("b".into(), 1.0), ("a".into(), 0.4), ("c".into(), 0.0)]
        );
    }

    #[test]
    fn sanitize_cuts_at_top_k() {
        let out = sanitize(
            vec![entry("a", 0.9), entry("b", 0.5), entry("c", 0.1)],
            &cands(&["a", "b", "c"]),
            2,
        );
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn config_defaults_to_ratel_cloud() {
        let c = SystemOneConfig::default();
        assert_eq!(c.url(), "https://app.ratel.sh/v1/systemone");
        assert_eq!(c.api_key_env(), "RATEL_API_KEY");
    }

    /// What the mock saw: each request's JSON body and `authorization` header.
    type Seen = mpsc::Receiver<Vec<(serde_json::Value, Option<String>)>>;

    /// One-shot mock endpoint: answers each connection with the next
    /// `(status, body)` and reports the requests it saw.
    fn mock(replies: Vec<(u16, String)>) -> (String, Seen) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/v1/systemone", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut replies = std::collections::VecDeque::from(replies);
            let mut seen = Vec::new();
            while let Some((status, body)) = replies.front().cloned() {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        seen.push(read_http_request(&mut stream));
                        let response = format!(
                            "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n\
                             content-length: {}\r\nconnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        stream.write_all(response.as_bytes()).unwrap();
                        replies.pop_front();
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        if Instant::now() >= deadline {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("accept failed: {e}"),
                }
            }
            tx.send(seen).unwrap();
        });
        (url, rx)
    }

    fn client(url: &str, key_env: &str) -> RatelCloudSystemOne {
        RatelCloudSystemOne::new(
            SystemOneConfig::default()
                .with_url(url)
                .with_api_key_env(key_env),
        )
    }

    const KEY: &str = "RATEL_CORE_SYSTEM_ONE_TEST_KEY";

    fn set_key() {
        // A unique test-only name no other thread reads.
        unsafe { std::env::set_var(KEY, "s1-token") };
    }

    #[test]
    fn sends_the_contract_and_returns_the_ranking() {
        set_key();
        let (url, rx) = mock(vec![(
            200,
            r#"{"ranked":[{"id":"b","score":0.88},{"id":"a","score":0.07}],
                "provider":"jev","model":"jev-1.13.0"}"#
                .into(),
        )]);
        let ranked = client(&url, KEY)
            .rank("refund the order", &cands(&["a", "b"]), 5)
            .unwrap();
        assert_eq!(ranked, vec![("b".into(), 0.88), ("a".into(), 0.07)]);

        let seen = rx.recv().unwrap();
        let (body, auth) = &seen[0];
        assert_eq!(auth.as_deref(), Some("Bearer s1-token"));
        assert_eq!(body["query"], "refund the order");
        assert_eq!(body["top_k"], 5);
        assert_eq!(body["candidates"][1]["id"], "b");
        assert_eq!(body["candidates"][1]["text"], "text of b");
    }

    #[test]
    fn an_unset_key_env_fails_before_any_request() {
        let err = client(
            "http://127.0.0.1:9/never",
            "RATEL_CORE_SYSTEM_ONE_UNSET_KEY",
        )
        .rank("q", &cands(&["a"]), 1)
        .unwrap_err();
        assert!(matches!(err, SystemOneError::Config { .. }), "{err}");
    }

    #[test]
    fn statuses_map_to_typed_errors() {
        set_key();
        let (url, _rx) = mock(vec![
            (401, "{}".into()),
            (429, "{}".into()),
            (503, "{}".into()),
            (200, r#"{"nope":true}"#.into()),
        ]);
        let c = client(&url, KEY);
        let call = || c.rank("q", &cands(&["a"]), 1).unwrap_err();
        assert_eq!(call(), SystemOneError::Unauthorized { status: 401 });
        assert_eq!(call(), SystemOneError::RateLimited);
        assert_eq!(call(), SystemOneError::Http { status: 503 });
        assert!(matches!(call(), SystemOneError::Malformed { .. }));
    }

    #[test]
    fn an_unreachable_endpoint_is_typed() {
        set_key();
        // Bind then drop: nothing listens on the port.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let err = client(&format!("http://127.0.0.1:{port}/v1/systemone"), KEY)
            .rank("q", &cands(&["a"]), 1)
            .unwrap_err();
        assert!(matches!(err, SystemOneError::Unreachable { .. }), "{err}");
    }

    #[test]
    fn no_candidates_means_no_request() {
        let ranked = client(
            "http://127.0.0.1:9/never",
            "RATEL_CORE_SYSTEM_ONE_UNSET_KEY",
        )
        .rank("q", &[], 5)
        .unwrap();
        assert!(ranked.is_empty());
    }
}
