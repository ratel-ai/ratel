//! The usage-ranking read model: clusters of past queries, each carrying
//! weighted edges to the capabilities users actually invoked after them
//! (ADR-0013).
//!
//! A query is matched to at most one cluster, and that cluster's capabilities
//! become an extra ranked arm for [`crate::fusion::rrf_fuse_weighted`] beside
//! BM25 and dense retrieval. Two things follow from that and are easy to lose:
//!
//! - **Only the arm's *order* is used.** Edge weights choose the order and are
//!   then discarded; RRF fuses on rank position, so a weight never has to be
//!   reconciled with a BM25 or cosine score.
//! - **A miss produces no arm at all**, not a zero-weighted one. A query that
//!   matches nothing ranks bit-identically to a registry with no graph.
//!
//! Matching has two tiers, because the graph must work on a `Bm25` catalog that
//! has no embedder ([`crate::SearchMethod`], ADR-0011):
//!
//! - [`IntentGraph::arm_dense`] — cosine against a cluster's stored centroid.
//!   Groups phrasings that share no words. Used by semantic/hybrid, where the
//!   query embedding was already computed for the dense arm, so it costs nothing.
//! - [`IntentGraph::arm_lexical`] — token overlap against a cluster's member
//!   bag. No model is ever loaded. Reaches repeats and near-repeats only; it
//!   cannot connect "why is the build broken" to "did CI pass".
//!
//! The wire shape is `protocol/v1/schema/intent-graph.schema.json`; this is its
//! consumer. An edge weight is a plain count of confirmed invocations: it orders
//! the arm and nothing more, since RRF then fuses on rank position.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::fusion::sort_and_truncate;

/// Fraction of the usage arm's full weight granted per unit of support, capped
/// at 1.0 once `SUPPORT_FULL` observations agree. One confirmed observation
/// nudges the ranking; it must never dictate it, or a single misclick becomes
/// policy (ADR-0013).
pub(crate) const SUPPORT_FULL: u32 = 3;

/// The usage arm's full weight, relative to the BM25/dense arms at 1.0.
///
/// **Deliberately below 1.0**: at the same rank, a capability the query
/// lexically matched outranks one only usage history supports. The arm still
/// promotes a deeply-ranked capability past another arm's top hit, because that
/// id accumulates from both arms — sub-unit damps the arm without disabling it.
/// Like `BM25_K1` / `RRF_K`, this is fixed tuning, not a public knob (ADR-0004).
pub(crate) const USAGE_WEIGHT: f32 = 0.5;

/// Minimum cosine between a query and a cluster centroid to count as a match.
pub(crate) const TAU_COSINE: f32 = 0.70;

/// Minimum share of a query's content tokens a cluster must already know to
/// count as a lexical match.
pub(crate) const TAU_LEXICAL: f32 = 0.5;

/// How many c-TF-IDF terms a cluster's display label carries.
const MAX_TERMS: usize = 5;

/// The effective weight of the usage arm for a cluster with `support`
/// observations: `USAGE_WEIGHT · min(1, support / SUPPORT_FULL)`.
pub(crate) fn usage_weight(support: u32) -> f32 {
    let ramp = (support as f32 / SUPPORT_FULL as f32).min(1.0);
    USAGE_WEIGHT * ramp
}

/// Which edge map of a cluster to rank.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Capability {
    /// Rank the cluster's `tools` edges.
    Tool,
    /// Rank the cluster's `skills` edges.
    Skill,
}

/// A matched cluster's contribution to one search: the capabilities it
/// remembers, best-first, plus what is needed to weight and trace the arm.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct UsageArm {
    /// Id of the cluster that matched — carried into `TraceEvent::UsageBoost`.
    pub intent_id: String,
    /// How well the query matched: cosine against the centroid on the dense
    /// tier, share of query tokens known on the lexical one. Both are in
    /// `[0, 1]`, but they are **different scales** — compare within a tier, not
    /// across. Reported so near-misses are visible, not just hits.
    pub similarity: f32,
    /// The cluster's observation count, which sets the arm's weight.
    pub support: u32,
    /// Capability ids, best-first. Already filtered to ids the registry knows.
    pub ids: Vec<String>,
}

impl UsageArm {
    /// This arm's fusion weight — see [`usage_weight`].
    pub(crate) fn weight(&self) -> f32 {
        usage_weight(self.support)
    }
}

/// A graph that could not be adopted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IntentGraphError {
    /// The bytes were not the expected JSON shape.
    Malformed(String),
    /// The graph declares a schema version this build does not know. A consumer
    /// rejects rather than degrading, since an unknown version may have changed
    /// what the fields mean.
    UnsupportedVersion(u32),
}

impl std::fmt::Display for IntentGraphError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IntentGraphError::Malformed(e) => write!(f, "malformed intent graph: {e}"),
            IntentGraphError::UnsupportedVersion(v) => {
                write!(
                    f,
                    "unsupported intent graph version {v} (this build reads 1)"
                )
            }
        }
    }
}

impl std::error::Error for IntentGraphError {}

/// The schema version this build reads.
const GRAPH_VERSION: u32 = 1;

/// The most recent query and its embedding, stashed by the search path so the
/// learner can grow a real centroid.
///
/// Transient scratch, **not part of the graph's value**: skipped on the wire,
/// empty after a clone, and ignored by equality — two graphs that differ only
/// here are the same graph. It lives on [`IntentGraph`] because the search path
/// and the learner share nothing else, and it is a `Mutex` so the search path
/// can write it while holding only a read lock.
#[derive(Debug, Default)]
struct PendingQuery(Mutex<Option<(String, Vec<f32>)>>);

impl Clone for PendingQuery {
    /// A clone starts empty: a half-finished search is not worth copying.
    fn clone(&self) -> Self {
        Self::default()
    }
}

impl PartialEq for PendingQuery {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}

impl PendingQuery {
    fn set(&self, query: &str, vector: &[f32]) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some((query.to_string(), vector.to_vec()));
        }
    }

    /// The stashed vector, but **only if it belongs to `query`**.
    ///
    /// Sessions share a graph, so a concurrent search can overwrite the slot
    /// between one session's search and its invoke. Keying by the query text
    /// means a clobbered slot degrades to lexical clustering rather than
    /// attaching one session's embedding to another's question.
    fn take_for(&self, query: &str) -> Option<Vec<f32>> {
        let slot = self.0.lock().ok()?;
        match slot.as_ref() {
            Some((q, v)) if q == query => Some(v.clone()),
            _ => None,
        }
    }
}

/// One cluster: the queries it covers and the capabilities invoked after them.
///
/// `label` and `terms` are **derived**, not stored: they are computed from the
/// members at read time and deliberately excluded from equality. c-TF-IDF scores
/// a term against *the other clusters*, so a value frozen when this cluster was
/// last written is wrong the moment another cluster appears.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Intent {
    /// Cluster id, unique within the graph. Opaque — it names a row.
    pub id: String,
    /// Display name (the medoid member). Never affects ranking.
    pub label: String,
    /// Distinguishing keywords. Never affects ranking.
    #[serde(default)]
    pub terms: Vec<String>,
    /// The texts this cluster covers — **the match key**.
    pub members: Vec<String>,
    /// Optional precomputed L2-normalized mean of the members' embeddings.
    /// Absent when the producer clustered lexically.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub centroid: Option<Vec<f32>>,
    /// Confirmed search-then-invoke observations behind this cluster.
    pub support: u32,
    /// Tool id → count of confirmed invocations. Orders the arm; the
    /// magnitude is discarded by the fusion.
    #[serde(default)]
    pub tools: BTreeMap<String, f32>,
    /// Skill id → count of confirmed invocations. Orders the arm; the
    /// magnitude is discarded by the fusion.
    #[serde(default)]
    pub skills: BTreeMap<String, f32>,
    /// Every distinct content token across `members`, cached.
    ///
    /// Derived from `members` and kept in step with them, so it is never
    /// serialized and never part of identity. It exists because lexical
    /// matching needs this set on **every search**, and rebuilding it from the
    /// member strings each time cost ~99% of that search — the set does not
    /// change between searches, so it is built once and extended in place.
    /// Rebuilt after deserialization by [`IntentGraph::rebuild_caches`].
    #[serde(skip)]
    bag: std::collections::HashSet<String>,
}

/// Identity is the evidence — members, centroid, support, edges. The derived
/// display fields are ignored, so a graph compares equal to its own round-trip
/// whether or not labels have been materialized.
impl PartialEq for Intent {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
            && self.members == other.members
            && self.centroid == other.centroid
            && self.support == other.support
            && self.tools == other.tools
            && self.skills == other.skills
    }
}

impl Intent {
    fn edges(&self, kind: Capability) -> &BTreeMap<String, f32> {
        match kind {
            Capability::Tool => &self.tools,
            Capability::Skill => &self.skills,
        }
    }

    /// The cluster's capabilities of `kind`, best-first, dropping any id the
    /// registry does not currently define. Ordered `(weight desc, id asc)` —
    /// the same total order the rankers use, so the arm is deterministic.
    fn ranked(&self, kind: Capability, known: &dyn Fn(&str) -> bool) -> Vec<String> {
        let mut ranked: Vec<(String, f32)> = self
            .edges(kind)
            .iter()
            .filter(|(id, _)| known(id.as_str()))
            .map(|(id, w)| (id.clone(), *w))
            .collect();
        let len = ranked.len();
        sort_and_truncate(&mut ranked, len);
        ranked.into_iter().map(|(id, _)| id).collect()
    }

    /// Fold `vector` into this cluster's centroid as a running mean over its
    /// members, renormalized so cosine stays a plain dot product.
    ///
    /// The mean of unit vectors falls inside the sphere, so skipping the
    /// renormalize would depress every later similarity by the cluster's own
    /// spread. A first vector — or one of a different width, meaning the
    /// embedding model changed — replaces the centroid rather than being
    /// averaged into a space it does not share.
    fn absorb_vector(&mut self, vector: &[f32]) {
        let n = self.members.len().max(1) as f32;
        let merged: Vec<f32> = match self.centroid.as_deref() {
            Some(c) if c.len() == vector.len() => c
                .iter()
                .zip(vector)
                .map(|(c, v)| c * (n - 1.0) + v)
                .collect(),
            _ => vector.to_vec(),
        };
        self.centroid = Some(normalize(merged));
    }

    /// Every distinct content token across this cluster's members.
    fn token_bag(&self) -> &std::collections::HashSet<String> {
        &self.bag
    }

    /// Fold a newly added member's tokens into the cache. O(tokens in that one
    /// member) — the other members are already accounted for.
    fn absorb_tokens(&mut self, member: &str) {
        self.bag.extend(tokenize(member));
    }

    /// Rebuild the cache from `members` — after deserialization, where the
    /// cache is skipped on the wire.
    fn rebuild_bag(&mut self) {
        self.bag = self.members.iter().flat_map(|m| tokenize(m)).collect();
    }
}

/// The usage-ranking read model — a set of query clusters with capability edges.
///
/// Built either in-process by the local learner or offline by Ratel Cloud; both
/// emit the shape in `protocol/v1`. Attach one to a registry to add the usage
/// arm to its ranking.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct IntentGraph {
    /// Schema version. Always [`GRAPH_VERSION`] for a graph this build accepts.
    pub v: u32,
    /// Epoch-millis of the newest event folded in. Provenance only — it says how
    /// current the graph is, and nothing reads it during ranking.
    pub built_from_ts: u64,
    /// The clusters. Order is not significant.
    pub intents: Vec<Intent>,
    /// Scratch for the search path → learner handoff; never serialized.
    #[serde(skip)]
    pending: PendingQuery,
}

/// Serializing materializes the derived display fields, so the wire form always
/// carries labels computed against the graph being written — never a stale
/// snapshot from whenever a cluster last happened to change.
impl Serialize for IntentGraph {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut out = serializer.serialize_struct("IntentGraph", 3)?;
        out.serialize_field("v", &self.v)?;
        out.serialize_field("built_from_ts", &self.built_from_ts)?;
        out.serialize_field("intents", &self.labeled())?;
        out.end()
    }
}

impl Default for IntentGraph {
    fn default() -> Self {
        Self::empty()
    }
}

impl IntentGraph {
    /// Parse a graph from its JSON wire form.
    ///
    /// # Errors
    ///
    /// [`IntentGraphError::Malformed`] if the bytes are not the expected shape,
    /// or [`IntentGraphError::UnsupportedVersion`] if `v` is not 1.
    pub fn from_json(json: &str) -> Result<Self, IntentGraphError> {
        let mut graph: IntentGraph =
            serde_json::from_str(json).map_err(|e| IntentGraphError::Malformed(e.to_string()))?;
        if graph.v != GRAPH_VERSION {
            return Err(IntentGraphError::UnsupportedVersion(graph.v));
        }
        graph.rebuild_caches();
        Ok(graph)
    }

    /// Rebuild every cluster's derived token cache. The cache is skipped on the
    /// wire, so a deserialized graph must restore it before it can match
    /// lexically.
    fn rebuild_caches(&mut self) {
        for it in &mut self.intents {
            it.rebuild_bag();
        }
    }

    /// An empty graph at the current version — the starting state of a learner.
    pub fn empty() -> Self {
        Self {
            v: GRAPH_VERSION,
            built_from_ts: 0,
            intents: Vec::new(),
            pending: PendingQuery::default(),
        }
    }

    /// Number of clusters.
    pub fn len(&self) -> usize {
        self.intents.len()
    }

    /// Whether the graph holds no clusters — the cold-start state, in which it
    /// contributes no arm to any query.
    pub fn is_empty(&self) -> bool {
        self.intents.is_empty()
    }

    /// Stash the embedded query so a later [`Self::observe`] can grow a real
    /// centroid from it.
    ///
    /// Called on the search path of a semantic/hybrid registry, which has
    /// already embedded the query for its own ranking — so this costs nothing
    /// beyond a copy. Takes `&self`: the slot is a `Mutex`, so the search path
    /// never needs the write lock.
    pub(crate) fn note_query_vector(&self, query: &str, vector: &[f32]) {
        self.pending.set(query, vector);
    }

    /// Fold one confirmed observation — a query, and the capability invoked
    /// after it — into the graph.
    ///
    /// This is the whole learning step (ADR-0013). It:
    ///
    /// 1. finds the cluster this query belongs to — by centroid when the search
    ///    path stashed an embedding, else by token overlap — or **seeds a new
    ///    one**;
    /// 2. adds the query as a member, bumps `support`, and adds `1.0` to the
    ///    invoked capability's edge;
    /// 3. recomputes the cluster's display label and terms.
    ///
    /// `ts_ms` records how current the graph is; it never affects ranking.
    /// Traces are loosely ordered (ADR-0007), so a late-arriving older event
    /// leaves the recorded high-water mark alone.
    pub(crate) fn observe(
        &mut self,
        query: &str,
        kind: Capability,
        capability_id: &str,
        ts_ms: u64,
    ) {
        // A query vector is available only when the search path was
        // semantic/hybrid AND the slot still belongs to this query.
        let vector = self.pending.take_for(query);
        if vector.is_none() && tokenize(query).is_empty() {
            return; // no words to cluster on and no embedding either
        }
        self.built_from_ts = self.built_from_ts.max(ts_ms);

        let idx = match self.best_match(query, vector.as_deref()) {
            Some(i) => i,
            None => {
                let id = format!("intent_{}", self.next_intent_seq());
                self.intents.push(Intent {
                    id,
                    // Derived on read — see `labeled`. Never written while learning.
                    label: String::new(),
                    terms: Vec::new(),
                    members: Vec::new(),
                    centroid: None,
                    support: 0,
                    tools: BTreeMap::new(),
                    skills: BTreeMap::new(),
                    bag: std::collections::HashSet::new(),
                });
                self.intents.len() - 1
            }
        };

        {
            let it = &mut self.intents[idx];
            // Members are the match key, so a repeated phrasing must not inflate
            // the token bag — dedupe. `support` still counts every observation.
            if !it.members.iter().any(|m| m == query) {
                it.members.push(query.to_string());
                it.absorb_tokens(query);
            }
            it.support = it.support.saturating_add(1);
            if let Some(v) = vector.as_deref() {
                it.absorb_vector(v);
            }
            let edges = match kind {
                Capability::Tool => &mut it.tools,
                Capability::Skill => &mut it.skills,
            };
            *edges.entry(capability_id.to_string()).or_insert(0.0) += 1.0;
        }
    }

    /// The cluster this query belongs to: by cosine when an embedding is
    /// available and some cluster carries a centroid, otherwise by token
    /// overlap.
    ///
    /// Dense first, lexical as a fallback — a graph can hold both kinds while
    /// centroids are still being filled in, and a query that no centroid
    /// recognizes may still share words with a cluster.
    fn best_match(&self, query: &str, vector: Option<&[f32]>) -> Option<usize> {
        if let Some(v) = vector
            && let Some(i) = self.best_dense_match(v)
        {
            return Some(i);
        }
        self.best_lexical_match(query)
    }

    /// Index of the nearest cluster centroid clearing [`TAU_COSINE`]. Ties break
    /// by cluster id so growth does not depend on `Vec` order.
    fn best_dense_match(&self, vector: &[f32]) -> Option<usize> {
        self.intents
            .iter()
            .enumerate()
            .filter_map(|(i, it)| {
                let c = it.centroid.as_deref()?;
                if c.len() != vector.len() {
                    return None; // a different embedding model — not comparable
                }
                Some((i, cosine(vector, c)))
            })
            .filter(|(_, sim)| *sim >= TAU_COSINE)
            .max_by(|a, b| {
                a.1.partial_cmp(&b.1)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| self.intents[b.0].id.cmp(&self.intents[a.0].id))
            })
            .map(|(i, _)| i)
    }

    /// Index of the cluster whose member-token bag best covers `query`, if any
    /// clears [`TAU_LEXICAL`]. Ties break by cluster id so growth does not
    /// depend on `Vec` order.
    fn best_lexical_match(&self, query: &str) -> Option<usize> {
        let q = tokenize(query);
        if q.is_empty() {
            return None;
        }
        self.intents
            .iter()
            .enumerate()
            .map(|(i, it)| {
                let bag = it.token_bag();
                let hits = q.iter().filter(|t| bag.contains(*t)).count();
                (i, hits as f32 / q.len() as f32)
            })
            .filter(|(_, score)| *score >= TAU_LEXICAL)
            .max_by(|a, b| {
                a.1.partial_cmp(&b.1)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| self.intents[b.0].id.cmp(&self.intents[a.0].id))
            })
            .map(|(i, _)| i)
    }

    /// The next free `intent_N` sequence number, so ids stay unique even after
    /// clusters are merged away by a future compaction.
    fn next_intent_seq(&self) -> usize {
        self.intents
            .iter()
            .filter_map(|i| i.id.strip_prefix("intent_")?.parse::<usize>().ok())
            .max()
            .map_or(0, |m| m + 1)
    }

    /// The member that best covers the cluster's own token bag — a real past
    /// query rather than a generated summary, so it can never misdescribe the
    /// cluster. Ties break by the member text.
    fn medoid(&self, idx: usize) -> String {
        let it = &self.intents[idx];
        let bag = it.token_bag();
        it.members
            .iter()
            .map(|m| {
                let t = tokenize(m);
                let hits = t.iter().filter(|x| bag.contains(*x)).count();
                (
                    m,
                    if t.is_empty() {
                        0.0
                    } else {
                        hits as f32 / t.len() as f32
                    },
                )
            })
            .max_by(|a, b| {
                a.1.partial_cmp(&b.1)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| b.0.cmp(a.0))
            })
            .map(|(m, _)| m.clone())
            .unwrap_or_default()
    }

    /// Class-based TF-IDF: terms frequent in this cluster and rare across the
    /// others. Each cluster is treated as one document (BERTopic's method), so
    /// the result is what distinguishes this cluster rather than what is merely
    /// common in it.
    fn c_tf_idf(&self, idx: usize) -> Vec<String> {
        use std::collections::HashMap;
        let per_cluster: Vec<Vec<String>> = self
            .intents
            .iter()
            .map(|it| it.members.iter().flat_map(|m| tokenize(m)).collect())
            .collect();
        let total: usize = per_cluster.iter().map(|c| c.len()).sum();
        if total == 0 || per_cluster[idx].is_empty() {
            return Vec::new();
        }
        let avg = total as f32 / per_cluster.len() as f32;

        let mut global: HashMap<&str, usize> = HashMap::new();
        for c in &per_cluster {
            for t in c {
                *global.entry(t.as_str()).or_insert(0) += 1;
            }
        }
        let mut local: HashMap<&str, usize> = HashMap::new();
        for t in &per_cluster[idx] {
            *local.entry(t.as_str()).or_insert(0) += 1;
        }
        let len = per_cluster[idx].len() as f32;

        let mut scored: Vec<(String, f32)> = local
            .into_iter()
            .map(|(t, count)| {
                let f = global[t] as f32;
                (t.to_string(), (count as f32 / len) * (1.0 + avg / f).ln())
            })
            .collect();
        sort_and_truncate(&mut scored, MAX_TERMS);
        scored.into_iter().map(|(t, _)| t).collect()
    }

    /// The clusters with their display fields materialized against the graph as
    /// it is **now**.
    ///
    /// Labels are derived rather than stored for two reasons. c-TF-IDF ranks a
    /// term by how rare it is across the *other* clusters, so a value computed
    /// when a cluster was last written goes stale as soon as the graph grows.
    /// And computing them on write meant re-tokenizing every member of every
    /// cluster on every invocation — for strings ranking never reads.
    pub fn labeled(&self) -> Vec<Intent> {
        self.intents
            .iter()
            .enumerate()
            .map(|(i, it)| Intent {
                label: self.medoid(i),
                terms: self.c_tf_idf(i),
                ..it.clone()
            })
            .collect()
    }

    /// Resolve the usage arm, choosing the match tier from **what this graph
    /// carries** rather than from the caller's search method.
    ///
    /// Dense matching needs both a query vector *and* stored centroids. A
    /// producer that clustered lexically — the in-process learner, or Ratel
    /// Cloud's Jaccard clusterer — emits no centroids, so a semantic catalog
    /// handed such a graph must still match it lexically rather than see nothing
    /// at all. Falling back here is what makes the format portable across
    /// producers in practice, not just on paper.
    pub(crate) fn arm(
        &self,
        query: &str,
        query_vec: Option<&[f32]>,
        kind: Capability,
        known: &dyn Fn(&str) -> bool,
    ) -> Option<UsageArm> {
        match query_vec {
            Some(v) if self.has_centroids() => self.arm_dense(v, kind, known),
            _ => self.arm_lexical(query, kind, known),
        }
    }

    /// Whether any cluster carries a centroid, i.e. whether dense matching is
    /// possible at all against this graph.
    fn has_centroids(&self) -> bool {
        self.intents.iter().any(|i| i.centroid.is_some())
    }

    /// Match `query_vec` to the nearest cluster centroid and return its arm.
    ///
    /// `None` when nothing clears [`TAU_COSINE`], when the matched cluster has
    /// no surviving edges of `kind`, or when no cluster carries a centroid of
    /// the query's dimension (a changed embedding model — mismatched vector
    /// spaces are skipped, never compared).
    pub(crate) fn arm_dense(
        &self,
        query_vec: &[f32],
        kind: Capability,
        known: &dyn Fn(&str) -> bool,
    ) -> Option<UsageArm> {
        let best = self
            .intents
            .iter()
            .filter_map(|it| {
                let c = it.centroid.as_deref()?;
                if c.len() != query_vec.len() {
                    return None; // different embedding model — not comparable
                }
                Some((it, cosine(query_vec, c)))
            })
            .filter(|(_, sim)| *sim >= TAU_COSINE)
            .max_by(pick_best)?;
        arm_from(best.0, best.1, kind, known)
    }

    /// Match `query` lexically against each cluster's member-token bag and
    /// return the best cluster's arm.
    ///
    /// The score is the share of the query's content tokens the cluster already
    /// knows, so it is bounded in `[0, 1]` and thresholds meaningfully — unlike
    /// a raw BM25 score, which is unbounded and corpus-relative. `None` when
    /// nothing clears [`TAU_LEXICAL`] or the match has no surviving edges.
    pub(crate) fn arm_lexical(
        &self,
        query: &str,
        kind: Capability,
        known: &dyn Fn(&str) -> bool,
    ) -> Option<UsageArm> {
        let q = tokenize(query);
        if q.is_empty() {
            return None;
        }
        let best = self
            .intents
            .iter()
            .map(|it| {
                let bag = it.token_bag();
                let hits = q.iter().filter(|t| bag.contains(*t)).count();
                (it, hits as f32 / q.len() as f32)
            })
            .filter(|(_, score)| *score >= TAU_LEXICAL)
            .max_by(pick_best)?;
        arm_from(best.0, best.1, kind, known)
    }
}

/// Break a score tie by id ascending, so the chosen cluster does not depend on
/// iteration order. (`max_by` keeps the last maximum, so the comparison is
/// reversed on id to leave the alphabetically-first winner in place.)
fn pick_best(a: &(&Intent, f32), b: &(&Intent, f32)) -> std::cmp::Ordering {
    a.1.partial_cmp(&b.1)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| b.0.id.cmp(&a.0.id))
}

fn arm_from(
    intent: &Intent,
    similarity: f32,
    kind: Capability,
    known: &dyn Fn(&str) -> bool,
) -> Option<UsageArm> {
    let ids = intent.ranked(kind, known);
    if ids.is_empty() {
        return None; // matched, but nothing it remembers still exists
    }
    Some(UsageArm {
        intent_id: intent.id.clone(),
        similarity,
        support: intent.support,
        ids,
    })
}

/// Scale to unit length. A zero vector is returned unchanged — there is no
/// direction to preserve, and dividing would produce NaNs that would poison
/// every later comparison.
fn normalize(mut v: Vec<f32>) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in &mut v {
            *x /= norm;
        }
    }
    v
}

/// Cosine similarity. Computed in full rather than as a bare dot product: the
/// contract says centroids are L2-normalized, but a producer that rounds or
/// truncates would otherwise silently depress every score.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let mut dot = 0.0;
    let mut na = 0.0;
    let mut nb = 0.0;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// Content tokens of a text: lowercased alphanumeric runs, minus a small
/// closed-class stopword list. Deliberately tiny — the lexical tier is a
/// fallback for catalogs with no embedder, not a search engine.
fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_lowercase())
        .filter(|t| !STOPWORDS.contains(&t.as_str()))
        .collect()
}

const STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "did", "do", "does", "for", "from",
    "how", "i", "if", "in", "is", "it", "my", "of", "on", "or", "that", "the", "this", "to", "was",
    "what", "when", "where", "which", "why", "with", "you", "your",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn intent(id: &str, members: &[&str], tools: &[(&str, f32)]) -> Intent {
        let mut it = Intent {
            id: id.into(),
            label: members.first().copied().unwrap_or_default().into(),
            terms: Vec::new(),
            members: members.iter().map(|m| m.to_string()).collect(),
            centroid: None,
            support: 5,
            tools: tools.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
            skills: BTreeMap::new(),
            bag: std::collections::HashSet::new(),
        };
        it.rebuild_bag(); // the cache is derived from members — keep them in step
        it
    }

    fn graph(intents: Vec<Intent>) -> IntentGraph {
        IntentGraph {
            v: 1,
            built_from_ts: 1_753_000_000_000,
            intents,
            pending: PendingQuery::default(),
        }
    }

    fn all_known(_: &str) -> bool {
        true
    }

    // ---- support ramp ------------------------------------------------------

    #[test]
    fn support_ramps_the_arm_weight_then_caps() {
        assert!((usage_weight(1) - USAGE_WEIGHT / 3.0).abs() < 1e-6);
        assert!((usage_weight(2) - USAGE_WEIGHT * 2.0 / 3.0).abs() < 1e-6);
        assert!((usage_weight(3) - USAGE_WEIGHT).abs() < 1e-6);
        assert!((usage_weight(900) - USAGE_WEIGHT).abs() < 1e-6);
    }

    #[test]
    fn a_single_observation_is_weaker_than_a_confirmed_cluster() {
        // The whole point of the ramp: one misclick must not rank like a pattern.
        assert!(usage_weight(1) < usage_weight(3));
    }

    // ---- parsing -----------------------------------------------------------

    #[test]
    fn parses_a_graph_without_a_centroid() {
        // The Bm25 / Jaccard-producer case: `centroid` is optional by contract.
        let json = r#"{"v":1,"built_from_ts":1,
            "intents":[{"id":"i0","label":"l","members":["q"],"support":2,
            "tools":{"t":1.0},"skills":{}}]}"#;
        let g = IntentGraph::from_json(json).expect("valid graph");
        assert_eq!(g.len(), 1);
        assert!(g.intents[0].centroid.is_none());
    }

    #[test]
    fn rejects_an_unknown_version_instead_of_degrading() {
        let json = r#"{"v":2,"built_from_ts":1,"intents":[]}"#;
        assert_eq!(
            IntentGraph::from_json(json),
            Err(IntentGraphError::UnsupportedVersion(2))
        );
    }

    #[test]
    fn rejects_malformed_bytes() {
        assert!(matches!(
            IntentGraph::from_json("not json"),
            Err(IntentGraphError::Malformed(_))
        ));
    }

    #[test]
    fn an_empty_graph_contributes_no_arm() {
        let g = IntentGraph::empty();
        assert!(g.is_empty());
        assert_eq!(
            g.arm_lexical("anything", Capability::Tool, &all_known),
            None
        );
        assert_eq!(g.arm_dense(&[1.0], Capability::Tool, &all_known), None);
    }

    // ---- dense matching ----------------------------------------------------

    #[test]
    fn dense_match_returns_edges_best_first() {
        let mut it = intent("i0", &["why is the build broken"], &[]);
        it.centroid = Some(vec![1.0, 0.0, 0.0]);
        it.tools = [
            ("gh_run_view".to_string(), 0.2),
            ("gh_run_list".to_string(), 0.8),
        ]
        .into_iter()
        .collect();
        let g = graph(vec![it]);
        let arm = g
            .arm_dense(&[1.0, 0.0, 0.0], Capability::Tool, &all_known)
            .expect("exact match");
        assert_eq!(arm.ids, vec!["gh_run_list", "gh_run_view"]);
        assert_eq!(arm.intent_id, "i0");
    }

    #[test]
    fn dense_match_below_tau_yields_no_arm() {
        let mut it = intent("i0", &["q"], &[("t", 1.0)]);
        it.centroid = Some(vec![1.0, 0.0]);
        let g = graph(vec![it]);
        // Orthogonal query: cosine 0, far below TAU_COSINE.
        assert_eq!(g.arm_dense(&[0.0, 1.0], Capability::Tool, &all_known), None);
    }

    #[test]
    fn dense_match_skips_centroids_of_a_different_dimension() {
        // A changed embedding model must never be compared across vector spaces.
        let mut it = intent("i0", &["q"], &[("t", 1.0)]);
        it.centroid = Some(vec![1.0, 0.0, 0.0]);
        let g = graph(vec![it]);
        assert_eq!(g.arm_dense(&[1.0, 0.0], Capability::Tool, &all_known), None);
    }

    #[test]
    fn dense_match_picks_the_closest_of_several_clusters() {
        let mut a = intent("a", &["q"], &[("ta", 1.0)]);
        a.centroid = Some(vec![1.0, 0.0]);
        let mut b = intent("b", &["q"], &[("tb", 1.0)]);
        b.centroid = Some(vec![0.8, 0.6]);
        let g = graph(vec![a, b]);
        let arm = g
            .arm_dense(&[0.8, 0.6], Capability::Tool, &all_known)
            .expect("match");
        assert_eq!(arm.intent_id, "b");
    }

    // ---- lexical matching --------------------------------------------------

    #[test]
    fn lexical_match_finds_a_repeat_phrasing() {
        let g = graph(vec![intent(
            "i0",
            &["why is the build broken", "is the build green"],
            &[("gh_run_list", 1.0)],
        )]);
        let arm = g
            .arm_lexical("is the build broken", Capability::Tool, &all_known)
            .expect("shares 'build' and 'broken'");
        assert_eq!(arm.ids, vec!["gh_run_list"]);
    }

    #[test]
    fn lexical_match_cannot_bridge_disjoint_vocabulary() {
        // The documented ceiling of the Bm25 tier (ADR-0013): no shared content
        // tokens means no match, however semantically close the two queries are.
        // This is what the dense tier exists to fix — pinned so the boundary is a
        // test, not a claim in prose.
        let g = graph(vec![intent(
            "i0",
            &["why is the build broken"],
            &[("gh_run_list", 1.0)],
        )]);
        assert_eq!(
            g.arm_lexical("did CI pass", Capability::Tool, &all_known),
            None
        );
    }

    #[test]
    fn lexical_match_ignores_stopwords_only_queries() {
        let g = graph(vec![intent("i0", &["build"], &[("t", 1.0)])]);
        assert_eq!(g.arm_lexical("is the", Capability::Tool, &all_known), None);
    }

    // ---- edge filtering ----------------------------------------------------

    #[test]
    fn edges_naming_capabilities_the_registry_lacks_are_dropped() {
        // A graph outlives a catalog change; ranking a ghost id would surface a
        // capability that cannot be invoked.
        let g = graph(vec![intent(
            "i0",
            &["build broken"],
            &[("gh_run_list", 0.8), ("since_deleted", 0.9)],
        )]);
        let arm = g
            .arm_lexical("build broken", Capability::Tool, &|id| {
                id != "since_deleted"
            })
            .expect("match");
        assert_eq!(arm.ids, vec!["gh_run_list"]);
    }

    #[test]
    fn a_match_whose_every_edge_is_gone_yields_no_arm() {
        let g = graph(vec![intent("i0", &["build broken"], &[("gone", 1.0)])]);
        assert_eq!(
            g.arm_lexical("build broken", Capability::Tool, &|_| false),
            None
        );
    }

    #[test]
    fn tool_and_skill_edges_are_ranked_independently() {
        let mut it = intent("i0", &["build broken"], &[("a_tool", 1.0)]);
        it.skills = [("a_skill".to_string(), 1.0)].into_iter().collect();
        let g = graph(vec![it]);
        assert_eq!(
            g.arm_lexical("build broken", Capability::Tool, &all_known)
                .unwrap()
                .ids,
            vec!["a_tool"]
        );
        assert_eq!(
            g.arm_lexical("build broken", Capability::Skill, &all_known)
                .unwrap()
                .ids,
            vec!["a_skill"]
        );
    }

    #[test]
    fn edges_rank_by_weight_not_by_id() {
        // The edges live in a BTreeMap, which already iterates id-ascending — so a
        // fixture whose weight order happens to agree with alphabetical order proves
        // nothing about the sort. Here they DISAGREE: `zulu` is the strongest edge
        // and must lead despite sorting last by id.
        let g = graph(vec![intent(
            "i0",
            &["build broken"],
            &[("alpha", 0.1), ("mike", 0.5), ("zulu", 0.9)],
        )]);
        let arm = g
            .arm_lexical("build broken", Capability::Tool, &all_known)
            .unwrap();
        assert_eq!(arm.ids, vec!["zulu", "mike", "alpha"]);
    }

    #[test]
    fn tied_edge_weights_break_by_id_ascending() {
        let g = graph(vec![intent(
            "i0",
            &["build broken"],
            &[("zeta", 1.0), ("alpha", 1.0), ("mid", 1.0)],
        )]);
        let arm = g
            .arm_lexical("build broken", Capability::Tool, &all_known)
            .unwrap();
        assert_eq!(arm.ids, vec!["alpha", "mid", "zeta"]);
    }

    #[test]
    fn round_trips_through_json() {
        let mut it = intent("i0", &["q"], &[("t", 1.0)]);
        it.centroid = Some(vec![0.8, 0.6]);
        let g = graph(vec![it]);
        let back = IntentGraph::from_json(&serde_json::to_string(&g).unwrap()).unwrap();
        assert_eq!(g, back);
    }

    // ---- observe: the online learning step ---------------------------------

    const T0: u64 = 1_753_000_000_000;

    #[test]
    fn the_first_observation_seeds_a_cluster() {
        let mut g = IntentGraph::empty();
        g.observe(
            "why is the build broken",
            Capability::Tool,
            "gh_run_list",
            T0,
        );

        assert_eq!(g.len(), 1);
        assert_eq!(g.intents[0].support, 1);
        assert_eq!(g.intents[0].members, vec!["why is the build broken"]);
        assert_eq!(g.intents[0].tools.get("gh_run_list"), Some(&1.0));
        // Grown lexically, so no centroid — `arm` must still match it.
        assert!(g.intents[0].centroid.is_none());
    }

    #[test]
    fn a_similar_query_joins_the_existing_cluster() {
        let mut g = IntentGraph::empty();
        g.observe(
            "why is the build broken",
            Capability::Tool,
            "gh_run_list",
            T0,
        );
        g.observe(
            "is the build broken now",
            Capability::Tool,
            "gh_run_list",
            T0,
        );

        assert_eq!(g.len(), 1, "should not have seeded a second cluster");
        assert_eq!(g.intents[0].support, 2);
        assert_eq!(g.intents[0].tools.get("gh_run_list"), Some(&2.0));
    }

    #[test]
    fn a_dissimilar_query_seeds_its_own_cluster() {
        let mut g = IntentGraph::empty();
        g.observe(
            "why is the build broken",
            Capability::Tool,
            "gh_run_list",
            T0,
        );
        g.observe(
            "rotate the signing key",
            Capability::Tool,
            "vault_rotate",
            T0,
        );

        assert_eq!(g.len(), 2);
        let ids: Vec<&str> = g.intents.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["intent_0", "intent_1"]);
    }

    #[test]
    fn a_repeated_phrasing_is_not_duplicated_in_members() {
        // Members are the match key; repeating one must not inflate the token
        // bag and make the cluster match ever more loosely.
        let mut g = IntentGraph::empty();
        for _ in 0..3 {
            g.observe(
                "why is the build broken",
                Capability::Tool,
                "gh_run_list",
                T0,
            );
        }
        assert_eq!(g.intents[0].members.len(), 1);
        assert_eq!(
            g.intents[0].support, 3,
            "support still counts every observation"
        );
    }

    #[test]
    fn learning_then_searching_closes_the_loop() {
        // The whole feature in one assertion: observe, then match a query that
        // was never observed verbatim.
        let mut g = IntentGraph::empty();
        g.observe(
            "why is the build broken",
            Capability::Tool,
            "gh_run_list",
            T0,
        );
        g.observe("did the build pass", Capability::Tool, "gh_run_list", T0);

        let arm = g
            .arm("is the build ok", None, Capability::Tool, &all_known)
            .expect("shares 'build' with the cluster");
        assert_eq!(arm.ids, vec!["gh_run_list"]);
        assert_eq!(arm.support, 2);
    }

    #[test]
    fn a_lexically_grown_graph_is_matchable_even_when_a_query_vector_is_offered() {
        // A semantic catalog hands `arm` a query vector, but a locally-learned
        // graph has no centroids to compare it against. It must fall back to
        // lexical matching rather than silently returning nothing.
        let mut g = IntentGraph::empty();
        g.observe(
            "why is the build broken",
            Capability::Tool,
            "gh_run_list",
            T0,
        );

        let arm = g.arm(
            "why is the build broken",
            Some(&[0.1, 0.2, 0.3]),
            Capability::Tool,
            &all_known,
        );
        assert!(arm.is_some(), "must not be invisible to a semantic catalog");
    }

    #[test]
    fn edges_rank_by_how_often_a_capability_was_chosen() {
        let mut g = IntentGraph::empty();
        for _ in 0..3 {
            g.observe(
                "why is the build broken",
                Capability::Tool,
                "chosen_often",
                T0,
            );
        }
        g.observe(
            "why is the build broken",
            Capability::Tool,
            "chosen_once",
            T0,
        );

        let arm = g
            .arm(
                "why is the build broken",
                None,
                Capability::Tool,
                &all_known,
            )
            .unwrap();
        assert_eq!(arm.ids, vec!["chosen_often", "chosen_once"]);
    }

    #[test]
    fn built_from_ts_tracks_the_newest_event_and_never_rewinds() {
        // Provenance only — it says how current the graph is. Traces are loosely
        // ordered (ADR-0007), so a late-arriving older event must not drag it back.
        let mut g = IntentGraph::empty();
        g.observe("build broken", Capability::Tool, "a", T0 + 10);
        g.observe("build broken", Capability::Tool, "b", T0);
        assert_eq!(g.built_from_ts, T0 + 10);
    }

    #[test]
    fn the_token_cache_stays_in_step_with_members() {
        // The cache is derived from `members`; if the two drift, a query stops
        // matching a cluster that plainly covers it. Silent, and invisible to
        // every other test — so pin it directly.
        let mut g = IntentGraph::empty();
        g.observe("why is the build broken", Capability::Tool, "t", T0);
        g.observe("the pipeline is broken", Capability::Tool, "t", T0);

        let it = &g.intents[0];
        let fresh: std::collections::HashSet<String> =
            it.members.iter().flat_map(|m| tokenize(m)).collect();
        assert_eq!(it.token_bag(), &fresh, "cache drifted from members");
    }

    #[test]
    fn a_deserialized_graph_can_still_match_lexically() {
        // The cache is skipped on the wire, so `from_json` must rebuild it —
        // otherwise a reloaded graph silently matches nothing.
        let mut g = IntentGraph::empty();
        g.observe(
            "why is the build broken",
            Capability::Tool,
            "gh_run_list",
            T0,
        );
        let back = IntentGraph::from_json(&serde_json::to_string(&g).unwrap()).unwrap();

        assert!(
            back.arm(
                "why is the build broken",
                None,
                Capability::Tool,
                &all_known
            )
            .is_some(),
            "a reloaded graph must still match"
        );
    }

    // ---- labels ------------------------------------------------------------

    #[test]
    fn the_label_is_always_one_of_the_members() {
        // Counted from the data, so it cannot describe the cluster wrongly.
        let mut g = IntentGraph::empty();
        g.observe("why is the build broken", Capability::Tool, "t", T0);
        g.observe("is the build broken now", Capability::Tool, "t", T0);

        let it = &g.labeled()[0];
        assert!(
            it.members.contains(&it.label),
            "label {:?} not a member",
            it.label
        );
    }

    #[test]
    fn terms_distinguish_a_cluster_from_its_neighbours() {
        let mut g = IntentGraph::empty();
        g.observe("why is the build broken", Capability::Tool, "t", T0);
        g.observe("the build is broken again", Capability::Tool, "t", T0);
        g.observe("rotate the signing key", Capability::Tool, "v", T0);

        let build = &g.labeled()[0];
        assert!(
            build.terms.contains(&"build".to_string()),
            "got {:?}",
            build.terms
        );
        assert!(!build.terms.contains(&"rotate".to_string()));
    }

    #[test]
    fn terms_are_scored_against_the_graph_as_it_is_now() {
        // c-TF-IDF ranks a term by how rare it is across the OTHER clusters, so a
        // value frozen when a cluster was last written goes stale the moment the
        // graph grows. This used to be computed inside `observe`, which made every
        // label describe a graph that no longer existed.
        let mut g = IntentGraph::empty();
        g.observe("why is the build broken", Capability::Tool, "t", T0);
        g.observe("the build broken again", Capability::Tool, "t", T0);
        let alone = g.labeled()[0].terms.clone();

        // A second cluster that also uses "again" makes that term less
        // distinguishing for the first — which must be reflected even though the
        // first cluster was never touched again.
        g.observe("tail the service log again", Capability::Tool, "u", T0);
        let with_neighbour = g.labeled()[0].terms.clone();

        let rank = |terms: &[String], t: &str| terms.iter().position(|x| x == t);
        assert!(
            rank(&with_neighbour, "again") >= rank(&alone, "again"),
            "\"again\" should not gain rank once a neighbour shares it: {alone:?} -> {with_neighbour:?}"
        );
    }

    #[test]
    fn the_label_is_derived_not_stored() {
        // Nothing writes `label` during learning; it is materialized on read, so
        // two graphs holding the same evidence are equal regardless.
        let mut g = IntentGraph::empty();
        g.observe("why is the build broken", Capability::Tool, "t", T0);
        assert!(
            g.intents[0].label.is_empty(),
            "not stored on the write path"
        );
        assert!(!g.labeled()[0].label.is_empty(), "materialized on read");
    }

    #[test]
    fn a_stopword_only_query_teaches_nothing() {
        let mut g = IntentGraph::empty();
        g.observe("is the", Capability::Tool, "t", T0);
        assert!(g.is_empty());
    }

    #[test]
    fn tool_and_skill_observations_land_on_separate_edge_maps() {
        let mut g = IntentGraph::empty();
        g.observe(
            "why is the build broken",
            Capability::Tool,
            "gh_run_list",
            T0,
        );
        g.observe(
            "why is the build broken",
            Capability::Skill,
            "ci-triage",
            T0,
        );

        assert_eq!(g.len(), 1);
        assert_eq!(g.intents[0].tools.len(), 1);
        assert_eq!(g.intents[0].skills.len(), 1);
    }

    #[test]
    fn a_learned_graph_round_trips_through_the_wire_form() {
        let mut g = IntentGraph::empty();
        g.observe(
            "why is the build broken",
            Capability::Tool,
            "gh_run_list",
            T0,
        );
        let back = IntentGraph::from_json(&serde_json::to_string(&g).unwrap()).unwrap();
        assert_eq!(g, back);
    }
}
