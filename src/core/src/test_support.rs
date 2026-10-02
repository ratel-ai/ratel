//! Shared test helpers for artifact/warm embedder stubs (crate-internal, tests only).

use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use crate::dense_cache::Embeddable;
use crate::embedding::{Embedded, Embedder, EmbedderError};
use crate::embedding_artifact::{ArtifactEntryKind, build_artifact};

/// L2-normalizes a fixed-dimension vector for deterministic artifact tests.
pub(crate) fn unit<const N: usize>(values: [f32; N]) -> Vec<f32> {
    let norm = values.iter().map(|x| x * x).sum::<f32>().sqrt();
    values.iter().map(|x| x / norm).collect()
}

/// Builds artifacts with a fixed identity and explicit per-item vectors.
pub(crate) struct ArtifactBuildStub {
    fingerprint: String,
    vectors: Vec<Vec<f32>>,
}

impl ArtifactBuildStub {
    pub(crate) fn new(fingerprint: impl Into<String>, vectors: Vec<Vec<f32>>) -> Self {
        Self {
            fingerprint: fingerprint.into(),
            vectors,
        }
    }
}

impl Embedder for ArtifactBuildStub {
    fn embed_doc(&self, _text: &str) -> Result<Vec<f32>, EmbedderError> {
        unreachable!("artifact build uses batch")
    }
    fn embed_query(&self, _text: &str) -> Result<Vec<f32>, EmbedderError> {
        unreachable!("artifact build uses batch")
    }
    fn embed_batch_with_identity(
        &self,
        texts: &[String],
    ) -> Result<Embedded<Vec<Vec<f32>>>, EmbedderError> {
        assert_eq!(texts.len(), self.vectors.len());
        Ok(Embedded {
            value: self.vectors.clone(),
            fingerprint: self.fingerprint.clone(),
        })
    }
    fn fingerprint(&self) -> String {
        self.fingerprint.clone()
    }
}

/// Resolves identity without inference — panics if any embed path is hit.
pub(crate) struct PanicOnEmbedStub {
    fingerprint: String,
}

impl PanicOnEmbedStub {
    pub(crate) fn new(fingerprint: impl Into<String>) -> Self {
        Self {
            fingerprint: fingerprint.into(),
        }
    }
}

impl Embedder for PanicOnEmbedStub {
    fn embed_doc(&self, _text: &str) -> Result<Vec<f32>, EmbedderError> {
        panic!("embed_doc must not be called")
    }
    fn embed_query(&self, _text: &str) -> Result<Vec<f32>, EmbedderError> {
        panic!("embed_query must not be called")
    }
    fn embed_batch(&self, _texts: &[String]) -> Result<Vec<Vec<f32>>, EmbedderError> {
        panic!("embed_batch must not be called")
    }
    fn embed_batch_with_identity(
        &self,
        _texts: &[String],
    ) -> Result<Embedded<Vec<Vec<f32>>>, EmbedderError> {
        panic!("embed_batch_with_identity must not be called")
    }
    fn fingerprint(&self) -> String {
        self.fingerprint.clone()
    }
}

/// Identity matches the artifact; every embed path fails (post-warm Embed policy).
pub(crate) struct FailOnEmbedStub {
    fingerprint: String,
}

impl FailOnEmbedStub {
    pub(crate) fn new(fingerprint: impl Into<String>) -> Self {
        Self {
            fingerprint: fingerprint.into(),
        }
    }
}

impl Embedder for FailOnEmbedStub {
    fn embed_doc(&self, _text: &str) -> Result<Vec<f32>, EmbedderError> {
        Err(EmbedderError::Inference {
            source: "forced embed failure".into(),
        })
    }
    fn embed_query(&self, _text: &str) -> Result<Vec<f32>, EmbedderError> {
        Err(EmbedderError::Inference {
            source: "forced embed failure".into(),
        })
    }
    fn fingerprint(&self) -> String {
        self.fingerprint.clone()
    }
}

/// Counts embeds under a fixed fingerprint (warm + extend chains).
pub(crate) struct FpCountingEmbedder {
    fingerprint: String,
    doc_calls: AtomicUsize,
    vec_for: fn(&str) -> Vec<f32>,
}

impl FpCountingEmbedder {
    pub(crate) fn new(fingerprint: &str, vec_for: fn(&str) -> Vec<f32>) -> Self {
        Self {
            fingerprint: fingerprint.into(),
            doc_calls: AtomicUsize::new(0),
            vec_for,
        }
    }

    pub(crate) fn docs(&self) -> usize {
        self.doc_calls.load(Ordering::SeqCst)
    }
}

impl Embedder for FpCountingEmbedder {
    fn embed_doc(&self, text: &str) -> Result<Vec<f32>, EmbedderError> {
        self.doc_calls.fetch_add(1, Ordering::SeqCst);
        Ok((self.vec_for)(text))
    }
    fn embed_query(&self, text: &str) -> Result<Vec<f32>, EmbedderError> {
        Ok((self.vec_for)(text))
    }
    fn fingerprint(&self) -> String {
        self.fingerprint.clone()
    }
}

pub(crate) fn build_test_artifact<'a, T: Embeddable + 'a>(
    kind: ArtifactEntryKind,
    items: impl IntoIterator<Item = &'a T>,
    fingerprint: &str,
    vectors: Vec<Vec<f32>>,
) -> Vec<u8> {
    build_artifact(kind, items, &ArtifactBuildStub::new(fingerprint, vectors)).unwrap()
}

/// One request as a mock server saw it.
pub(crate) struct MockHttpRequest {
    /// `"PUT /api/v1/catalog/snapshot HTTP/1.1"`.
    pub(crate) request_line: String,
    pub(crate) body: serde_json::Value,
    pub(crate) authorization: Option<String>,
}

/// Read one HTTP/1.1 request from a mock-server connection: the JSON body and
/// the `authorization` header, if any. Shared by the endpoint-embedder and
/// cloud client tests.
pub(crate) fn read_http_request(
    stream: &mut std::net::TcpStream,
) -> (serde_json::Value, Option<String>) {
    let request = read_http_request_full(stream);
    (request.body, request.authorization)
}

/// [`read_http_request`], keeping the request line too.
pub(crate) fn read_http_request_full(stream: &mut std::net::TcpStream) -> MockHttpRequest {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut request = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let read = stream.read(&mut buffer).unwrap();
        assert!(read > 0, "connection closed before request body");
        request.extend_from_slice(&buffer[..read]);
        if let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            let body_start = header_end + 4;
            let headers = std::str::from_utf8(&request[..header_end]).unwrap();
            let content_len = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .expect("content-length");
            if request.len() >= body_start + content_len {
                let authorization = headers.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("authorization")
                        .then(|| value.trim().to_string())
                });
                let body =
                    serde_json::from_slice(&request[body_start..body_start + content_len]).unwrap();
                return MockHttpRequest {
                    request_line: headers.lines().next().unwrap_or_default().to_string(),
                    body,
                    authorization,
                };
            }
        }
    }
}

/// A [`crate::cloud::CloudApi`] that answers from a script and records every
/// call — registry tests use it in place of HTTP.
pub(crate) struct ScriptedCloud {
    pick_reply: std::sync::Mutex<Result<crate::cloud::Picked, crate::CloudError>>,
    sync_reply: std::sync::Mutex<Result<crate::SyncOutcome, crate::CloudError>>,
    /// `(query, mode, top_k)` per pick.
    pub(crate) picks: std::sync::Mutex<Vec<(String, crate::PickMode, usize)>>,
    /// `(source_id, tools)` per snapshot sent.
    pub(crate) snapshots: std::sync::Mutex<Vec<(String, Vec<crate::cloud::SnapshotTool>)>>,
}

impl ScriptedCloud {
    pub(crate) fn new() -> Self {
        Self {
            pick_reply: std::sync::Mutex::new(Ok(crate::cloud::Picked {
                ranked: Vec::new(),
                confident: None,
            })),
            sync_reply: std::sync::Mutex::new(Ok(crate::SyncOutcome {
                catalog_version: "v1".into(),
                tools: 0,
                unchanged: false,
                skipped: false,
            })),
            picks: std::sync::Mutex::new(Vec::new()),
            snapshots: std::sync::Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn picking(self, ranked: &[(&str, f32)], confident: Option<bool>) -> Self {
        *self.pick_reply.lock().unwrap() = Ok(crate::cloud::Picked {
            ranked: ranked.iter().map(|(id, s)| ((*id).into(), *s)).collect(),
            confident,
        });
        self
    }

    pub(crate) fn failing_picks(self, error: crate::CloudError) -> Self {
        *self.pick_reply.lock().unwrap() = Err(error);
        self
    }

    pub(crate) fn set_sync_reply(&self, reply: Result<crate::SyncOutcome, crate::CloudError>) {
        *self.sync_reply.lock().unwrap() = reply;
    }

    pub(crate) fn snapshot_count(&self) -> usize {
        self.snapshots.lock().unwrap().len()
    }
}

impl crate::cloud::CloudApi for ScriptedCloud {
    fn pick(
        &self,
        query: &str,
        mode: crate::PickMode,
        top_k: usize,
    ) -> Result<crate::cloud::Picked, crate::CloudError> {
        self.picks
            .lock()
            .unwrap()
            .push((query.to_string(), mode, top_k));
        let mut reply = self.pick_reply.lock().unwrap().clone()?;
        reply.ranked.truncate(top_k);
        Ok(reply)
    }

    fn put_snapshot(
        &self,
        source_id: &str,
        tools: &[crate::cloud::SnapshotTool],
    ) -> Result<crate::SyncOutcome, crate::CloudError> {
        self.snapshots
            .lock()
            .unwrap()
            .push((source_id.to_string(), tools.to_vec()));
        let mut outcome = self.sync_reply.lock().unwrap().clone()?;
        outcome.tools = tools.len();
        Ok(outcome)
    }
}
/// A [`crate::system_one::SystemOne`] that answers from a script and records
/// the candidate ids it was offered — registry tests use it in place of the
/// HTTP client.
pub(crate) struct ScriptedSystemOne {
    reply: Result<Vec<(String, f32)>, crate::SystemOneError>,
    offered: std::sync::Mutex<Vec<Vec<String>>>,
    kinds: std::sync::Mutex<Vec<crate::CandidateKind>>,
}

impl ScriptedSystemOne {
    /// Answers every call with `ranked`, cut at the call's `top_k`.
    pub(crate) fn ranking(ranked: &[(&str, f32)]) -> Self {
        Self {
            reply: Ok(ranked.iter().map(|(id, s)| ((*id).into(), *s)).collect()),
            offered: std::sync::Mutex::new(Vec::new()),
            kinds: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Fails every call with `error`.
    pub(crate) fn failing(error: crate::SystemOneError) -> Self {
        Self {
            reply: Err(error),
            offered: std::sync::Mutex::new(Vec::new()),
            kinds: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// The candidate ids of each call, in call order.
    pub(crate) fn offered(&self) -> Vec<Vec<String>> {
        self.offered.lock().unwrap().clone()
    }

    /// The kind each call asked about, in call order.
    pub(crate) fn kinds(&self) -> Vec<crate::CandidateKind> {
        self.kinds.lock().unwrap().clone()
    }
}

impl crate::system_one::SystemOne for ScriptedSystemOne {
    fn rank(
        &self,
        _query: &str,
        candidates: &[crate::system_one::Candidate],
        top_k: usize,
        kind: crate::CandidateKind,
    ) -> Result<Vec<(String, f32)>, crate::SystemOneError> {
        self.kinds.lock().unwrap().push(kind);
        self.offered
            .lock()
            .unwrap()
            .push(candidates.iter().map(|c| c.id.clone()).collect());
        let mut ranked = self.reply.clone()?;
        ranked.truncate(top_k);
        Ok(ranked)
    }
}
