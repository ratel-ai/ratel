//! Ratel Cloud as the catalog's owner (ADR-0027, ADR-0028): the Tool Picker
//! ranks tools Cloud holds, and the catalog snapshot keeps that copy current.
//!
//! Two endpoints, one client:
//!
//! - `POST {url}/v1/tools/pick` — `{ query, mode, top_k }` → ranked tool ids.
//!   No tools in the request: Cloud ranks the project's synced catalog.
//! - `PUT {url}/api/v1/catalog/snapshot` — `{ source_id, tools }`, the source's
//!   complete executor-free tool list, replaced atomically.
//!
//! The client sits behind the crate-private [`CloudApi`] trait so registry tests
//! can stand a script in for HTTP.

use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Where Cloud lives unless a catalog overrides it.
pub const DEFAULT_CLOUD_URL: &str = "https://cloud.ratel.sh";

/// The environment variable holding the project key unless overridden.
pub const DEFAULT_CLOUD_API_KEY_ENV: &str = "RATEL_API_KEY";

/// The most tools one pick returns; larger requests are clamped to it.
pub const MAX_PICK_TOP_K: usize = 20;

/// Cloud's per-request limits on a catalog snapshot, checked before sending so
/// an oversized catalog fails with a clear error instead of a bare 413.
const MAX_SNAPSHOT_TOOLS: usize = 5_000;
const MAX_SNAPSHOT_BYTES: usize = 4_000_000;
const MAX_SOURCE_ID_CHARS: usize = 512;
const MAX_QUERY_CHARS: usize = 2_000;

/// `instant` and `precise` answer in well under a second; a slower answer is a
/// fault. `exhaustive` runs a tournament that Cloud bounds at 45 s, so its
/// timeout sits above that rather than cutting off a pick Cloud would finish;
/// a snapshot upload (up to 4 MB) takes the same long timeout.
const FAST_TIMEOUT_SECS: u64 = 15;
const SLOW_TIMEOUT_SECS: u64 = 60;

/// A pick or snapshot response is small; anything near this size is not one.
const RESPONSE_LIMIT_BYTES: u64 = 4 * 1024 * 1024;

/// How the Tool Picker ranks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PickMode {
    /// BM25 over the synced catalog: milliseconds, free.
    Instant,
    /// A BM25 shortlist judged by a system-one model: ~300 ms, metered.
    #[default]
    Precise,
    /// The system-one model over the whole catalog: seconds, metered.
    Exhaustive,
}

impl PickMode {
    /// The wire identifier: `"instant"`, `"precise"`, `"exhaustive"`.
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            PickMode::Instant => "instant",
            PickMode::Precise => "precise",
            PickMode::Exhaustive => "exhaustive",
        }
    }
}

impl fmt::Display for PickMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The identifier did not name a pick mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsePickModeError(pub String);

impl fmt::Display for ParsePickModeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "unknown pick mode {:?} (expected \"instant\", \"precise\", or \"exhaustive\")",
            self.0
        )
    }
}

impl std::error::Error for ParsePickModeError {}

impl FromStr for PickMode {
    type Err = ParsePickModeError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "instant" => Ok(PickMode::Instant),
            "precise" => Ok(PickMode::Precise),
            "exhaustive" => Ok(PickMode::Exhaustive),
            other => Err(ParsePickModeError(other.to_string())),
        }
    }
}

/// Which Cloud a registry talks to, and where its key comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudConfig {
    url: String,
    api_key_env: String,
}

impl Default for CloudConfig {
    fn default() -> Self {
        Self {
            url: DEFAULT_CLOUD_URL.into(),
            api_key_env: DEFAULT_CLOUD_API_KEY_ENV.into(),
        }
    }
}

impl CloudConfig {
    /// Use another base URL (staging, a self-hosted proxy, tests). Endpoint
    /// paths are appended to it; a trailing slash is ignored.
    #[must_use]
    pub fn with_url(mut self, url: impl Into<String>) -> Self {
        self.url = url.into().trim_end_matches('/').to_string();
        self
    }

    /// Read the project key from the environment variable `name`. Read at call
    /// time, so it may be set after construction.
    #[must_use]
    pub fn with_api_key_env(mut self, name: impl Into<String>) -> Self {
        self.api_key_env = name.into();
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
}

/// A Cloud request failed.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum CloudError {
    /// Misconfigured before any request was sent — no Cloud configured, the
    /// key's environment variable unset, a query or source id too long.
    Config {
        /// What is wrong.
        message: String,
    },
    /// Cloud rejected the key (401/403).
    Unauthorized {
        /// The HTTP status.
        status: u16,
    },
    /// The project has no credit for metered picks (402).
    InsufficientCredits {
        /// Cloud's explanation.
        message: String,
    },
    /// The project has no synced tools to pick from (409).
    NoSyncedTools {
        /// Cloud's explanation.
        message: String,
    },
    /// Rate limited (429).
    RateLimited {
        /// Seconds to wait, from `Retry-After`, when Cloud sent one.
        retry_after_secs: Option<u64>,
    },
    /// The snapshot exceeds Cloud's limits (checked locally, or a 413).
    TooLarge {
        /// Which limit.
        message: String,
    },
    /// The request timed out, locally or at Cloud (504).
    Timeout,
    /// Cloud could not be reached or is down: DNS, TLS, refused, 502/503.
    Unavailable {
        /// The underlying error or status.
        source: String,
    },
    /// Cloud answered with another non-success status.
    Http {
        /// The HTTP status.
        status: u16,
        /// Cloud's explanation, when it sent one.
        message: String,
    },
    /// Cloud answered with something that is not the expected response.
    Malformed {
        /// What could not be read.
        source: String,
    },
}

impl CloudError {
    /// A stable, machine-readable discriminant for the SDKs.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            CloudError::Config { .. } => "Config",
            CloudError::Unauthorized { .. } => "Unauthorized",
            CloudError::InsufficientCredits { .. } => "InsufficientCredits",
            CloudError::NoSyncedTools { .. } => "NoSyncedTools",
            CloudError::RateLimited { .. } => "RateLimited",
            CloudError::TooLarge { .. } => "TooLarge",
            CloudError::Timeout => "Timeout",
            CloudError::Unavailable { .. } => "Unavailable",
            CloudError::Http { .. } => "Http",
            CloudError::Malformed { .. } => "Malformed",
        }
    }
}

impl fmt::Display for CloudError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CloudError::Config { message } => write!(f, "ratel cloud config: {message}"),
            CloudError::Unauthorized { status } => write!(
                f,
                "ratel cloud rejected the key ({status}); check the key in api_key_env"
            ),
            CloudError::InsufficientCredits { message } => {
                write!(f, "ratel cloud: insufficient credits (402): {message}")
            }
            CloudError::NoSyncedTools { message } => {
                write!(f, "ratel cloud: no synced tools (409): {message}")
            }
            CloudError::RateLimited { retry_after_secs } => match retry_after_secs {
                Some(secs) => write!(f, "ratel cloud is rate limiting (429); retry in {secs}s"),
                None => write!(f, "ratel cloud is rate limiting (429)"),
            },
            CloudError::TooLarge { message } => {
                write!(f, "catalog too large for ratel cloud: {message}")
            }
            CloudError::Timeout => write!(f, "ratel cloud request timed out"),
            CloudError::Unavailable { source } => write!(f, "ratel cloud unavailable: {source}"),
            CloudError::Http { status, message } => {
                write!(f, "ratel cloud returned HTTP {status}: {message}")
            }
            CloudError::Malformed { source } => {
                write!(f, "malformed ratel cloud response: {source}")
            }
        }
    }
}

impl std::error::Error for CloudError {}

/// One tool as the catalog snapshot carries it: executor-free.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct SnapshotTool {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) searchable_description: Option<String>,
    pub(crate) input_schema: serde_json::Value,
    pub(crate) output_schema: serde_json::Value,
}

/// What a pick returned, before the registry checks ids against its corpus.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Picked {
    /// `(id, score)` best-first, no repeats, scores in `[0, 1]`, at most `top_k`.
    pub(crate) ranked: Vec<(String, f32)>,
    /// Whether the judge was confident in its top pick; `None` for `instant`.
    pub(crate) confident: Option<bool>,
}

/// What a catalog sync did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncOutcome {
    /// Cloud's version of this source's catalog after the sync.
    pub catalog_version: String,
    /// How many tools the snapshot held.
    pub tools: usize,
    /// Cloud already held exactly this snapshot.
    pub unchanged: bool,
    /// No request was sent: the snapshot matches the last one Cloud
    /// acknowledged for this source.
    pub skipped: bool,
}

/// The two Cloud calls a registry makes.
pub(crate) trait CloudApi: Send + Sync {
    fn pick(&self, query: &str, mode: PickMode, top_k: usize) -> Result<Picked, CloudError>;
    fn put_snapshot(
        &self,
        source_id: &str,
        tools: &[SnapshotTool],
    ) -> Result<SyncOutcome, CloudError>;
}

/// The shipped [`CloudApi`]: Ratel Cloud over HTTP.
pub(crate) struct HttpCloud {
    config: CloudConfig,
    fast: ureq::Agent,
    slow: ureq::Agent,
    /// A key that bypasses the environment; tests set it rather than mutate
    /// the process environment other threads are reading.
    key_override: Option<String>,
}

impl HttpCloud {
    pub(crate) fn new(config: CloudConfig) -> Self {
        let agent = |secs| -> ureq::Agent {
            ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(secs)))
                // Read the status ourselves: error bodies carry Cloud's
                // explanation and 429 carries Retry-After.
                .http_status_as_error(false)
                .build()
                .into()
        };
        Self {
            config,
            fast: agent(FAST_TIMEOUT_SECS),
            slow: agent(SLOW_TIMEOUT_SECS),
            key_override: None,
        }
    }
}

impl HttpCloud {
    /// Use `key` instead of reading the environment.
    #[cfg(test)]
    pub(crate) fn with_key(mut self, key: impl Into<String>) -> Self {
        self.key_override = Some(key.into());
        self
    }

    /// Read the key at call time; an unset variable is a clear `Config` error,
    /// not a downstream 401.
    fn bearer(&self) -> Result<String, CloudError> {
        if let Some(key) = &self.key_override {
            return Ok(format!("Bearer {key}"));
        }
        let var = &self.config.api_key_env;
        std::env::var(var)
            .map(|key| format!("Bearer {key}"))
            .map_err(|_| CloudError::Config {
                message: format!("api_key_env=\"{var}\" but that environment variable is not set"),
            })
    }

    /// Send one request and hand back a 2xx body; anything else becomes a
    /// typed error carrying Cloud's explanation where it gave one.
    fn send(
        &self,
        agent: &ureq::Agent,
        method: &str,
        path: &str,
        body: &[u8],
    ) -> Result<String, CloudError> {
        let bearer = self.bearer()?;
        let url = format!("{}{path}", self.config.url);
        let request = match method {
            "PUT" => agent.put(&url),
            _ => agent.post(&url),
        };
        let mut response = request
            .header("content-type", "application/json")
            .header("authorization", &bearer)
            .send(body)
            .map_err(classify_transport)?;
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok());
        let text = response
            .body_mut()
            .with_config()
            .limit(RESPONSE_LIMIT_BYTES)
            .read_to_string();
        if (200..300).contains(&status) {
            return text.map_err(|e| match e {
                ureq::Error::Timeout(_) => CloudError::Timeout,
                other => CloudError::Malformed {
                    source: format!("unreadable response body: {other}"),
                },
            });
        }
        // The status decides the error; an unreadable error body (a gateway's
        // HTML page, a cut connection) only costs the explanation.
        let message = text.map(|t| error_message(&t)).unwrap_or_default();
        Err(match status {
            401 | 403 => CloudError::Unauthorized { status },
            402 => CloudError::InsufficientCredits { message },
            409 => CloudError::NoSyncedTools { message },
            413 => CloudError::TooLarge { message },
            429 => CloudError::RateLimited {
                retry_after_secs: retry_after,
            },
            504 => CloudError::Timeout,
            502 | 503 => CloudError::Unavailable {
                source: format!("HTTP {status}: {message}"),
            },
            _ => CloudError::Http { status, message },
        })
    }
}

/// A transport failure: no HTTP status to read.
fn classify_transport(e: ureq::Error) -> CloudError {
    match e {
        ureq::Error::Timeout(_) => CloudError::Timeout,
        other => CloudError::Unavailable {
            source: other.to_string(),
        },
    }
}

/// Cloud's `{"error":{"message":"…"}}`, or the raw body when it is not that.
fn error_message(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| body.chars().take(500).collect())
}

#[derive(Serialize)]
struct PickRequest<'a> {
    query: &'a str,
    mode: &'a str,
    top_k: usize,
}

#[derive(Deserialize)]
struct PickResponse {
    tools: Vec<PickedTool>,
    #[serde(default)]
    confident: Option<bool>,
}

#[derive(Deserialize)]
struct PickedTool {
    id: String,
    score: f32,
}

#[derive(Serialize)]
struct SnapshotRequest<'a> {
    source_id: &'a str,
    tools: &'a [SnapshotTool],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotResponse {
    catalog_version: String,
    tools: usize,
    #[serde(default)]
    unchanged: bool,
}

fn malformed(e: impl fmt::Display) -> CloudError {
    CloudError::Malformed {
        source: e.to_string(),
    }
}

impl CloudApi for HttpCloud {
    fn pick(&self, query: &str, mode: PickMode, top_k: usize) -> Result<Picked, CloudError> {
        if query.chars().count() > MAX_QUERY_CHARS {
            return Err(CloudError::Config {
                message: format!("query is longer than {MAX_QUERY_CHARS} characters"),
            });
        }
        let top_k = top_k.clamp(1, MAX_PICK_TOP_K);
        let body = serde_json::to_vec(&PickRequest {
            query,
            mode: mode.as_str(),
            top_k,
        })
        .map_err(malformed)?;
        let agent = match mode {
            PickMode::Exhaustive => &self.slow,
            PickMode::Instant | PickMode::Precise => &self.fast,
        };
        let text = self.send(agent, "POST", "/v1/tools/pick", &body)?;
        let response: PickResponse = serde_json::from_str(&text).map_err(malformed)?;
        let mut seen = std::collections::HashSet::new();
        let ranked = response
            .tools
            .into_iter()
            .filter(|t| t.score.is_finite() && seen.insert(t.id.clone()))
            .map(|t| (t.id, t.score.clamp(0.0, 1.0)))
            .take(top_k)
            .collect();
        Ok(Picked {
            ranked,
            confident: response.confident,
        })
    }

    fn put_snapshot(
        &self,
        source_id: &str,
        tools: &[SnapshotTool],
    ) -> Result<SyncOutcome, CloudError> {
        if source_id.is_empty() || source_id.chars().count() > MAX_SOURCE_ID_CHARS {
            return Err(CloudError::Config {
                message: format!("source_id must be 1 to {MAX_SOURCE_ID_CHARS} characters"),
            });
        }
        if tools.len() > MAX_SNAPSHOT_TOOLS {
            return Err(CloudError::TooLarge {
                message: format!(
                    "{} tools; a snapshot holds at most {MAX_SNAPSHOT_TOOLS}",
                    tools.len()
                ),
            });
        }
        let body = serde_json::to_vec(&SnapshotRequest { source_id, tools }).map_err(malformed)?;
        if body.len() > MAX_SNAPSHOT_BYTES {
            return Err(CloudError::TooLarge {
                message: format!(
                    "{} bytes; a snapshot holds at most {MAX_SNAPSHOT_BYTES}",
                    body.len()
                ),
            });
        }
        // Up to 4 MB going up: the long timeout, not the one sized for a pick.
        let text = self.send(&self.slow, "PUT", "/api/v1/catalog/snapshot", &body)?;
        let response: SnapshotResponse = serde_json::from_str(&text).map_err(malformed)?;
        Ok(SyncOutcome {
            catalog_version: response.catalog_version,
            tools: response.tools,
            unchanged: response.unchanged,
            skipped: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::time::Instant;

    use super::*;
    use crate::test_support::{MockHttpRequest, read_http_request_full};

    /// An environment variable no test sets: tests inject the key instead.
    const KEY: &str = "RATEL_CORE_CLOUD_TEST_KEY";

    /// Answers each connection with the next `(status, extra headers, body)`
    /// and reports the requests it saw.
    fn mock(
        replies: Vec<(u16, &'static str, Vec<u8>)>,
    ) -> (String, mpsc::Receiver<Vec<MockHttpRequest>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut replies = std::collections::VecDeque::from(replies);
            let mut seen = Vec::new();
            while let Some((status, headers, body)) = replies.front().cloned() {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        seen.push(read_http_request_full(&mut stream));
                        let head = format!(
                            "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n{headers}\
                             content-length: {}\r\nconnection: close\r\n\r\n",
                            body.len()
                        );
                        stream.write_all(head.as_bytes()).unwrap();
                        stream.write_all(&body).unwrap();
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

    fn client(url: &str) -> HttpCloud {
        HttpCloud::new(CloudConfig::default().with_url(url).with_api_key_env(KEY))
            .with_key("cloud-token")
    }

    fn tool(id: &str) -> SnapshotTool {
        SnapshotTool {
            id: id.into(),
            name: id.into(),
            description: format!("does {id}"),
            searchable_description: None,
            input_schema: serde_json::json!({}),
            output_schema: serde_json::json!({}),
        }
    }

    #[test]
    fn modes_parse_and_default_to_precise() {
        assert_eq!("exhaustive".parse::<PickMode>(), Ok(PickMode::Exhaustive));
        assert!("fast".parse::<PickMode>().is_err());
        assert_eq!(PickMode::default(), PickMode::Precise);
        assert_eq!(PickMode::Instant.as_str(), "instant");
    }

    #[test]
    fn config_defaults_to_ratel_cloud_and_trims_the_url() {
        let c = CloudConfig::default();
        assert_eq!(c.url(), "https://cloud.ratel.sh");
        assert_eq!(c.api_key_env(), "RATEL_API_KEY");
        assert_eq!(
            CloudConfig::default().with_url("http://x/").url(),
            "http://x"
        );
    }

    #[test]
    fn pick_sends_the_contract_and_reads_the_ranking() {
        let (url, rx) = mock(vec![(
            200,
            "",
            r#"{"mode":"precise","tools":[
                {"id":"refund","name":"refund","description":"d","score":0.93},
                {"id":"list","name":"list","description":"d","score":0.07}],
                "confident":true,"usage":{"candidates":7,"questions":1,"input_tokens":394}}"#
                .into(),
        )]);
        let picked = client(&url)
            .pick("money back", PickMode::Precise, 5)
            .unwrap();
        assert_eq!(
            picked.ranked,
            vec![("refund".into(), 0.93), ("list".into(), 0.07)]
        );
        assert_eq!(picked.confident, Some(true));

        let seen = rx.recv().unwrap();
        assert_eq!(seen[0].request_line, "POST /v1/tools/pick HTTP/1.1");
        assert_eq!(seen[0].authorization.as_deref(), Some("Bearer cloud-token"));
        assert_eq!(
            seen[0].body,
            serde_json::json!({"query": "money back", "mode": "precise", "top_k": 5})
        );
    }

    #[test]
    fn pick_drops_repeats_and_clamps_scores() {
        let (url, _rx) = mock(vec![(
            200,
            "",
            r#"{"tools":[{"id":"a","score":1.4},{"id":"a","score":0.2},
                {"id":"b","score":-1}],"confident":null}"#
                .into(),
        )]);
        let picked = client(&url).pick("q", PickMode::Instant, 5).unwrap();
        assert_eq!(picked.ranked, vec![("a".into(), 1.0), ("b".into(), 0.0)]);
        assert_eq!(picked.confident, None);
    }

    #[test]
    fn statuses_map_to_typed_errors() {
        let err = |msg: &str| format!(r#"{{"error":{{"message":"{msg}"}}}}"#);
        let (url, _rx) = mock(vec![
            (401, "", err("bad key").into()),
            (402, "", err("no credits").into()),
            (409, "", err("no tools").into()),
            (429, "retry-after: 7\r\n", err("slow down").into()),
            (504, "", err("deadline").into()),
            (503, "", err("down").into()),
            (418, "", err("teapot").into()),
            (200, "", "not json".into()),
        ]);
        let c = client(&url);
        let pick = || c.pick("q", PickMode::Precise, 5).unwrap_err();
        assert_eq!(pick(), CloudError::Unauthorized { status: 401 });
        assert_eq!(
            pick(),
            CloudError::InsufficientCredits {
                message: "no credits".into()
            }
        );
        assert_eq!(
            pick(),
            CloudError::NoSyncedTools {
                message: "no tools".into()
            }
        );
        assert_eq!(
            pick(),
            CloudError::RateLimited {
                retry_after_secs: Some(7)
            }
        );
        assert_eq!(pick(), CloudError::Timeout);
        assert!(matches!(pick(), CloudError::Unavailable { .. }));
        assert_eq!(
            pick(),
            CloudError::Http {
                status: 418,
                message: "teapot".into()
            }
        );
        assert!(matches!(pick(), CloudError::Malformed { .. }));
    }

    #[test]
    fn forbidden_too_large_and_a_bare_rate_limit_are_typed() {
        let err = |msg: &str| format!(r#"{{"error":{{"message":"{msg}"}}}}"#);
        let (url, _rx) = mock(vec![
            (403, "", err("wrong project").into()),
            (413, "", err("snapshot too big").into()),
            (429, "", err("slow down").into()),
        ]);
        let c = client(&url);
        let pick = || c.pick("q", PickMode::Precise, 5).unwrap_err();
        assert_eq!(pick(), CloudError::Unauthorized { status: 403 });
        assert_eq!(
            pick(),
            CloudError::TooLarge {
                message: "snapshot too big".into()
            }
        );
        assert_eq!(
            pick(),
            CloudError::RateLimited {
                retry_after_secs: None
            },
            "no Retry-After header, no wait hint"
        );
    }

    #[test]
    fn the_status_decides_even_when_the_body_is_unreadable() {
        // Not UTF-8: an error page that cannot be read as text.
        let garbage = vec![0xff, 0xfe, b'<', b'h', 0xc3];
        let (url, _rx) = mock(vec![
            (502, "", garbage.clone()),
            (429, "retry-after: 3\r\n", garbage.clone()),
            (200, "", garbage),
        ]);
        let c = client(&url);
        let pick = || c.pick("q", PickMode::Precise, 5).unwrap_err();
        assert!(
            matches!(pick(), CloudError::Unavailable { .. }),
            "502 stays Unavailable"
        );
        assert_eq!(
            pick(),
            CloudError::RateLimited {
                retry_after_secs: Some(3)
            }
        );
        assert!(
            matches!(pick(), CloudError::Malformed { .. }),
            "an unreadable success is still Malformed"
        );
    }

    #[test]
    fn an_unset_key_or_long_query_fails_before_any_request() {
        let c = HttpCloud::new(
            CloudConfig::default()
                .with_url("http://127.0.0.1:9")
                .with_api_key_env("RATEL_CORE_CLOUD_UNSET_KEY"),
        );
        assert!(matches!(
            c.pick("q", PickMode::Instant, 5),
            Err(CloudError::Config { .. })
        ));
        let long = "x".repeat(2_001);
        assert!(matches!(
            client("http://127.0.0.1:9").pick(&long, PickMode::Instant, 5),
            Err(CloudError::Config { .. })
        ));
    }

    #[test]
    fn put_snapshot_sends_the_contract_and_reads_the_version() {
        let (url, rx) = mock(vec![(
            200,
            "etag: \"abc\"\r\n",
            r#"{"sourceId":"svc","catalogVersion":"abc","tools":2,"unchanged":false}"#.into(),
        )]);
        let outcome = client(&url)
            .put_snapshot("svc", &[tool("a"), tool("b")])
            .unwrap();
        assert_eq!(
            outcome,
            SyncOutcome {
                catalog_version: "abc".into(),
                tools: 2,
                unchanged: false,
                skipped: false,
            }
        );
        let seen = rx.recv().unwrap();
        assert_eq!(
            seen[0].request_line,
            "PUT /api/v1/catalog/snapshot HTTP/1.1"
        );
        assert_eq!(seen[0].body["source_id"], "svc");
        assert_eq!(seen[0].body["tools"][1]["id"], "b");
        assert_eq!(
            seen[0].body["tools"][0]["input_schema"],
            serde_json::json!({})
        );
        assert!(
            seen[0].body["tools"][0]
                .get("searchable_description")
                .is_none()
        );
    }

    #[test]
    fn an_oversized_snapshot_fails_before_any_request() {
        let many: Vec<SnapshotTool> = (0..5_001).map(|i| tool(&format!("t{i}"))).collect();
        assert!(matches!(
            client("http://127.0.0.1:9").put_snapshot("svc", &many),
            Err(CloudError::TooLarge { .. })
        ));
        assert!(matches!(
            client("http://127.0.0.1:9").put_snapshot(&"s".repeat(513), &[tool("a")]),
            Err(CloudError::Config { .. })
        ));
    }

    #[test]
    fn an_unreachable_cloud_is_typed() {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let err = client(&format!("http://127.0.0.1:{port}"))
            .pick("q", PickMode::Instant, 5)
            .unwrap_err();
        assert!(matches!(err, CloudError::Unavailable { .. }), "{err}");
    }
}
