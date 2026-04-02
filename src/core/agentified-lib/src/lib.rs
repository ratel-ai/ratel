pub mod embedding;
pub mod models;
pub mod ranking;
pub mod storage;

pub use embedding::{EmbeddingService, LlmService, OpenAIEmbedding, OpenAILlm};
pub use storage::{NoopStorage, SqliteStorage, Storage};

#[cfg(any(test, feature = "test-utils"))]
pub use embedding::{FakeEmbedding, FailingEmbedding, FakeLlm, FailingLlm};

use std::collections::HashMap;
use std::sync::Arc;

/// Extract argument names and descriptions from a JSON Schema `parameters` object.
/// Parses the `properties` field to get property keys (arg names) and their `description` values.
/// Returns a space-separated string like: "employee_id The employee's unique identifier salary Annual salary amount"
fn extract_arg_text(parameters: &serde_json::Value) -> String {
    let Some(properties) = parameters.get("properties").and_then(|p| p.as_object()) else {
        return String::new();
    };
    let mut parts = Vec::new();
    for (key, value) in properties {
        parts.push(key.as_str());
        if let Some(desc) = value.get("description").and_then(|d| d.as_str()) {
            parts.push(desc);
        }
    }
    parts.join(" ")
}

use tokio::sync::RwLock;

use models::{
    AppendMessagesRequest, AppendMessagesResponse, CaptureTurnRequest, CaptureTurnResponse,
    ContextRequest, ContextResponse, DiscoverRequest, DiscoverResponse,
    FieldEmbeddings, GetMessagesQuery, GetMessagesResponse, ListToolsResponse,
    RankedTool, RecalledContext, RegisterToolsResponse, StoredMessage, StoredTool, Tool, Turn,
};
use models::SearchStrategy;
use ranking::{bm25_scores, normalize_min_max, weighted_semantic_score};

// Error types

#[derive(Debug)]
pub enum CoreError {
    EmbeddingFailed(anyhow::Error),
    NotFound(String),
    BadRequest(String),
    UnsupportedStrategy(String),
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CoreError::EmbeddingFailed(e) => write!(f, "embedding failed: {e}"),
            CoreError::NotFound(msg) => write!(f, "{msg}"),
            CoreError::BadRequest(msg) => write!(f, "{msg}"),
            CoreError::UnsupportedStrategy(msg) => write!(f, "{msg}"),
        }
    }
}

// AgentifiedCore

pub struct AgentifiedCore {
    tools: RwLock<HashMap<String, HashMap<String, StoredTool>>>,
    turns: RwLock<HashMap<String, Turn>>,
    embedding_cache: RwLock<HashMap<String, Vec<f32>>>,
    embedding: Option<Arc<dyn EmbeddingService>>,
    storage: Arc<dyn Storage>,
    llm: Option<Arc<dyn embedding::LlmService>>,
}

impl AgentifiedCore {
    pub fn new(embedding: Arc<dyn EmbeddingService>, storage: Arc<dyn Storage>) -> Self {
        Self::build(Some(embedding), storage, None)
    }

    pub fn new_with_llm(embedding: Arc<dyn EmbeddingService>, storage: Arc<dyn Storage>, llm: Arc<dyn embedding::LlmService>) -> Self {
        Self::build(Some(embedding), storage, Some(llm))
    }

    pub fn new_bm25_only(storage: Arc<dyn Storage>) -> Self {
        Self::build(None, storage, None)
    }

    fn build(embedding: Option<Arc<dyn EmbeddingService>>, storage: Arc<dyn Storage>, llm: Option<Arc<dyn embedding::LlmService>>) -> Self {
        let turns_map = storage.load_all_turns().unwrap_or_default().into_iter().collect();
        let cache_map = storage.load_all_embeddings().unwrap_or_default().into_iter().collect();

        Self {
            tools: RwLock::new(HashMap::new()),
            turns: RwLock::new(turns_map),
            embedding_cache: RwLock::new(cache_map),
            embedding,
            storage,
            llm,
        }
    }

    pub async fn register_tools(&self, dataset_id: &str, tools: Vec<Tool>) -> Result<RegisterToolsResponse, CoreError> {
        let count = tools.len();

        struct ToolTexts {
            name: String,
            description: String,
            input_schema: Option<String>,
            output_schema: Option<String>,
        }

        let mut all_tool_texts = Vec::with_capacity(count);

        for tool in &tools {
            let texts = if let Some(ref fields) = tool.fields {
                ToolTexts {
                    name: fields.name.clone(),
                    description: fields.description.clone(),
                    input_schema: fields.input_schema.clone(),
                    output_schema: fields.output_schema.clone(),
                }
            } else {
                ToolTexts {
                    name: tool.name.clone(),
                    description: tool.description.clone(),
                    input_schema: None,
                    output_schema: None,
                }
            };
            all_tool_texts.push(texts);
        }

        // Compute embeddings only if embedding service is available
        let has_embeddings = if let Some(ref embedding_svc) = self.embedding {
            let mut unique_texts = Vec::new();
            {
                let cache = self.embedding_cache.read().await;
                for texts in &all_tool_texts {
                    for text in [Some(&texts.name), Some(&texts.description), texts.input_schema.as_ref(), texts.output_schema.as_ref()].into_iter().flatten() {
                        if !cache.contains_key(text) && !unique_texts.contains(text) {
                            unique_texts.push(text.clone());
                        }
                    }
                }
            }

            if !unique_texts.is_empty() {
                let embeddings = embedding_svc.embed_batch(&unique_texts).await.map_err(CoreError::EmbeddingFailed)?;
                let mut cache = self.embedding_cache.write().await;
                for (text, emb) in unique_texts.into_iter().zip(embeddings) {
                    cache.insert(text, emb);
                }
            }
            true
        } else {
            false
        };

        let mut tool_data: Vec<(Option<FieldEmbeddings>, String)> = Vec::with_capacity(count);
        for (idx, texts) in all_tool_texts.iter().enumerate() {
            let arg_text = extract_arg_text(&tools[idx].parameters);
            let bm25_text = if arg_text.is_empty() {
                format!("{} {}", texts.name, texts.description)
            } else {
                format!("{} {} {}", texts.name, texts.description, arg_text)
            };

            let embeddings = if has_embeddings {
                let cache = self.embedding_cache.read().await;
                let name_emb = cache.get(&texts.name).cloned()
                    .ok_or_else(|| CoreError::EmbeddingFailed(anyhow::anyhow!("missing cached embedding for name")))?;
                let desc_emb = cache.get(&texts.description).cloned()
                    .ok_or_else(|| CoreError::EmbeddingFailed(anyhow::anyhow!("missing cached embedding for description")))?;
                let input_emb = texts.input_schema.as_ref().map(|t| {
                    cache.get(t).cloned()
                        .ok_or_else(|| CoreError::EmbeddingFailed(anyhow::anyhow!("missing cached embedding for input_schema")))
                }).transpose()?;
                let output_emb = texts.output_schema.as_ref().map(|t| {
                    cache.get(t).cloned()
                        .ok_or_else(|| CoreError::EmbeddingFailed(anyhow::anyhow!("missing cached embedding for output_schema")))
                }).transpose()?;
                Some(FieldEmbeddings {
                    name: name_emb,
                    description: desc_emb,
                    input_schema: input_emb,
                    output_schema: output_emb,
                })
            } else {
                None
            };

            tool_data.push((embeddings, bm25_text));
        }

        let mut tools_map = self.tools.write().await;
        let dataset_tools = tools_map.entry(dataset_id.to_string()).or_default();
        for (tool, (embeddings, bm25_text)) in tools.into_iter().zip(tool_data) {
            dataset_tools.insert(tool.name.clone(), StoredTool { tool, embeddings, bm25_text });
        }

        // Write-through to storage
        {
            let storage = self.storage.clone();
            let did = dataset_id.to_string();
            let tool_pairs: Vec<(String, StoredTool)> = dataset_tools.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            let has_emb = has_embeddings;
            let emb_pairs: Vec<(String, Vec<f32>)> = if has_emb {
                let cache = self.embedding_cache.read().await;
                cache.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
            } else {
                vec![]
            };
            tokio::task::spawn_blocking(move || {
                let refs: Vec<(&str, &StoredTool)> = tool_pairs.iter().map(|(k, v)| (k.as_str(), v)).collect();
                if let Err(e) = storage.save_tools(&did, &refs) {
                    tracing::error!("storage save_tools failed: {e}");
                }
                if has_emb {
                    let emb_refs: Vec<(&str, &[f32])> = emb_pairs.iter().map(|(k, v)| (k.as_str(), v.as_slice())).collect();
                    if let Err(e) = storage.save_embeddings(&emb_refs) {
                        tracing::error!("storage save_embeddings failed: {e}");
                    }
                }
            });
        }

        Ok(RegisterToolsResponse { registered: count })
    }

    pub async fn list_tools(&self, dataset_id: &str) -> Result<ListToolsResponse, CoreError> {
        let tools = self.tools.read().await;
        let tool_list = tools.get(dataset_id)
            .map(|m| m.values().map(|st| st.tool.clone()).collect())
            .unwrap_or_default();
        Ok(ListToolsResponse { tools: tool_list })
    }

    pub async fn discover(&self, dataset_id: &str, body: DiscoverRequest) -> Result<DiscoverResponse, CoreError> {
        let limit = body.limit.unwrap_or(5).min(100);

        let base_tool_names: Vec<String> = if let Some(ref turn_id) = body.turn_id {
            let turns = self.turns.read().await;
            let turn = turns.get(turn_id).ok_or_else(|| {
                CoreError::NotFound(format!("turn not found: {turn_id}"))
            })?;
            turn.tools_loaded.clone()
        } else {
            vec![]
        };

        // Load previously discovered tools from session for cross-turn accumulation
        let session_tool_names: Vec<String> = match (&body.namespace, &body.session) {
            (Some(ns), Some(sess)) => {
                let storage = self.storage.clone();
                let ds = dataset_id.to_string();
                let ns = ns.clone();
                let sess = sess.clone();
                tokio::task::spawn_blocking(move || storage.load_session_tools(&ds, &ns, &sess))
                    .await
                    .map_err(|e| CoreError::EmbeddingFailed(anyhow::anyhow!("spawn failed: {e}")))?
                    .map_err(CoreError::EmbeddingFailed)?
            }
            _ => vec![],
        };

        let tools = self.tools.read().await;
        let dataset_tools = tools.get(dataset_id);
        let empty = HashMap::new();
        let dataset_tools = dataset_tools.unwrap_or(&empty);

        if dataset_tools.is_empty() {
            return Ok(DiscoverResponse { tools: vec![] });
        }

        let mut base_tools: Vec<RankedTool> = base_tool_names.iter()
            .filter_map(|name| dataset_tools.get(name))
            .map(|st| RankedTool { tool: st.tool.clone(), score: 1.0, graph_expanded: None })
            .collect();

        let weights = body.embedding_weights.unwrap_or_default();
        let mut exclude = body.exclude.unwrap_or_default();
        exclude.extend(base_tool_names);
        // Exclude session-persisted tools from search (they're already in context)
        exclude.extend(session_tool_names.clone());

        let stored: Vec<&StoredTool> = dataset_tools
            .values()
            .filter(|t| !exclude.contains(&t.tool.name) && !t.tool.always_include)
            .collect();

        if stored.is_empty() && !base_tools.is_empty() {
            return Ok(DiscoverResponse { tools: base_tools });
        }

        // Determine effective strategy — fallback to BM25 if embeddings unavailable
        let effective_strategy = match body.strategy {
            SearchStrategy::Bm25 => SearchStrategy::Bm25,
            SearchStrategy::Semantic | SearchStrategy::Hybrid => {
                if self.can_use_embeddings(&stored) {
                    body.strategy
                } else {
                    tracing::warn!(
                        "requested {:?} strategy but embeddings unavailable, falling back to bm25",
                        body.strategy
                    );
                    SearchStrategy::Bm25
                }
            }
        };

        let mut ranked: Vec<RankedTool> = match effective_strategy {
            SearchStrategy::Bm25 => {
                let documents: Vec<String> = stored.iter().map(|t| t.bm25_text.clone()).collect();
                let raw_bm25 = bm25_scores(&body.query, &documents);
                let norm_bm25 = normalize_min_max(&raw_bm25);
                stored.iter().enumerate().map(|(i, t)| RankedTool {
                    tool: t.tool.clone(),
                    score: norm_bm25[i],
                    graph_expanded: None,
                }).collect()
            }
            SearchStrategy::Semantic => {
                let query_embedding = self.embed_cached(&body.query).await.map_err(CoreError::EmbeddingFailed)?;
                stored.iter().map(|t| {
                    let emb = t.embeddings.as_ref().unwrap();
                    RankedTool {
                        tool: t.tool.clone(),
                        score: weighted_semantic_score(&query_embedding, emb, &weights),
                        graph_expanded: None,
                    }
                }).collect()
            }
            SearchStrategy::Hybrid => {
                let query_embedding = self.embed_cached(&body.query).await.map_err(CoreError::EmbeddingFailed)?;
                let semantic_scores: Vec<f32> = stored.iter()
                    .map(|t| weighted_semantic_score(&query_embedding, t.embeddings.as_ref().unwrap(), &weights))
                    .collect();
                let documents: Vec<String> = stored.iter().map(|t| t.bm25_text.clone()).collect();
                let raw_bm25 = bm25_scores(&body.query, &documents);
                let norm_bm25 = normalize_min_max(&raw_bm25);
                stored.iter().enumerate().map(|(i, t)| RankedTool {
                    tool: t.tool.clone(),
                    score: 0.7 * semantic_scores[i] + 0.3 * norm_bm25[i],
                    graph_expanded: None,
                }).collect()
            }
        };

        ranked.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        ranked.truncate(limit);

        let ranked = expand_with_providers(ranked, dataset_tools, limit);

        base_tools.extend(ranked);

        // Persist discovered tool names to session for cross-turn accumulation
        if let (Some(ns), Some(sess)) = (&body.namespace, &body.session) {
            let new_names: Vec<String> = base_tools.iter().map(|t| t.tool.name.clone()).collect();
            let mut all_names = session_tool_names;
            for name in &new_names {
                if !all_names.contains(name) {
                    all_names.push(name.clone());
                }
            }
            self.save_session_tools_async(dataset_id, ns, sess, &all_names.iter().map(|n| RankedTool {
                tool: models::Tool { name: n.clone(), description: String::new(), parameters: serde_json::Value::Null, metadata: None, fields: None, always_include: false },
                score: 1.0,
                graph_expanded: None,
            }).collect::<Vec<_>>());
        }

        Ok(DiscoverResponse { tools: base_tools })
    }

    pub async fn capture_turn(&self, body: CaptureTurnRequest) -> CaptureTurnResponse {
        let turn_id = uuid::Uuid::new_v4().to_string();
        let turn = Turn {
            tools_loaded: body.tools_loaded,
            message: body.message,
        };
        self.turns.write().await.insert(turn_id.clone(), turn.clone());

        // Write-through to storage
        {
            let storage = self.storage.clone();
            let id = turn_id.clone();
            tokio::task::spawn_blocking(move || {
                if let Err(e) = storage.save_turn(&id, &turn) {
                    tracing::error!("storage save_turn failed: {e}");
                }
            });
        }

        CaptureTurnResponse { turn_id }
    }

    pub async fn append_messages(&self, req: AppendMessagesRequest) -> Result<AppendMessagesResponse, CoreError> {
        let storage = self.storage.clone();
        let (first_seq, last_seq) = tokio::task::spawn_blocking(move || {
            storage.append_messages(&req.dataset, &req.namespace, &req.session, &req.messages)
        }).await.map_err(|e| CoreError::EmbeddingFailed(anyhow::anyhow!("spawn failed: {e}")))?
          .map_err(|e| CoreError::EmbeddingFailed(e))?;

        Ok(AppendMessagesResponse {
            appended: (last_seq - first_seq + 1) as usize,
            first_seq,
            last_seq,
        })
    }

    pub async fn get_messages(&self, query: GetMessagesQuery) -> Result<GetMessagesResponse, CoreError> {
        if query.after_seq.is_some() && query.around_seq.is_some() {
            return Err(CoreError::BadRequest("cannot specify both after_seq and around_seq".into()));
        }

        let storage = self.storage.clone();
        let (messages, has_more, max_seq) = tokio::task::spawn_blocking(move || {
            storage.get_messages(&query.dataset, &query.namespace, &query.session, query.limit, query.after_seq, query.around_seq)
        }).await.map_err(|e| CoreError::EmbeddingFailed(anyhow::anyhow!("spawn failed: {e}")))?
          .map_err(|e| CoreError::EmbeddingFailed(e))?;

        Ok(GetMessagesResponse { messages, has_more, max_seq })
    }

    pub async fn get_context(&self, req: ContextRequest) -> Result<ContextResponse, CoreError> {
        let strategy = &req.messages.strategy;
        let is_compacted = strategy == "compacted";

        if is_compacted && self.llm.is_none() {
            return Err(CoreError::UnsupportedStrategy(
                "Compacted strategy requires LLM configuration".into(),
            ));
        }
        if !is_compacted && strategy != "recent" && strategy != "full" {
            return Err(CoreError::BadRequest(format!("unknown strategy: {strategy}")));
        }

        let storage = self.storage.clone();
        let ds = req.dataset.clone();
        let ns = req.namespace.clone();
        let sess = req.session.clone();
        let (all_messages, _, max_seq) = tokio::task::spawn_blocking(move || {
            storage.get_messages(&ds, &ns, &sess, i64::MAX - 1, None, None)
        }).await.map_err(|e| CoreError::EmbeddingFailed(anyhow::anyhow!("spawn failed: {e}")))?
          .map_err(|e| CoreError::EmbeddingFailed(e))?;

        let total_messages = max_seq;

        if all_messages.is_empty() {
            return Ok(ContextResponse {
                messages: vec![],
                strategy_used: strategy.clone(),
                total_messages: 0,
                included_messages: 0,
                recalled: RecalledContext { tools: vec![], memories: vec![] },
                token_estimate: 0,
                conversation_messages: 0,
                fallback: false,
                summary: None,
                summary_range: None,
            });
        }

        // Tool recall
        let recalled_tools = self.recall_tools(&req.dataset, &req.namespace, &req.session, &all_messages, &req.recall).await?;

        // Compute effective message budget
        let tool_tokens: usize = recalled_tools.iter().map(|t| {
            let params_str = serde_json::to_string(&t.tool.parameters).unwrap_or_default();
            (t.tool.name.len() + t.tool.description.len() + params_str.len()) / 4
        }).sum();
        let max_tokens = match req.limit_tokens {
            Some(limit) => {
                let remaining = limit.saturating_sub(tool_tokens);
                remaining.min(req.messages.max_tokens)
            }
            None => req.messages.max_tokens,
        };
        if max_tokens == 0 {
            tracing::warn!("effective message token budget is 0 — tools consumed entire limit_tokens budget");
        }

        let keep_first = req.messages.keep_first;
        let prune_threshold = req.messages.prune_threshold;
        match strategy.as_str() {
            "compacted" => self.get_context_compacted(&all_messages, max_tokens, total_messages, recalled_tools, keep_first, prune_threshold).await,
            _ => {
                let messages = select_messages(&all_messages, strategy, max_tokens, keep_first);
                let token_estimate: usize = messages.iter().map(|m| m.content.len() / 4).sum();
                let included = messages.len();
                Ok(ContextResponse {
                    messages,
                    strategy_used: strategy.clone(),
                    total_messages,
                    included_messages: included,
                    recalled: RecalledContext { tools: recalled_tools, memories: vec![] },
                    token_estimate,
                    conversation_messages: included,
                    fallback: false,
                    summary: None,
                    summary_range: None,
                })
            }
        }
    }

    async fn get_context_compacted(
        &self,
        all_messages: &[StoredMessage],
        max_tokens: usize,
        total_messages: i64,
        recalled_tools: Vec<RankedTool>,
        keep_first: bool,
        prune_threshold: usize,
    ) -> Result<ContextResponse, CoreError> {
        let llm = self.llm.as_ref()
            .ok_or_else(|| CoreError::UnsupportedStrategy("LLM not configured".into()))?;

        // 60% budget for recent, 40% for summary
        let recent_budget = (max_tokens as f64 * 0.6) as usize;
        let summary_budget = max_tokens.saturating_sub(recent_budget);

        let recent_messages = select_messages(all_messages, "recent", recent_budget, keep_first);

        // Find the min seq of the "recent" portion (excluding the keep_first message)
        // so that the summary covers messages between keep_first and the recent window.
        let first_user_seq = if keep_first {
            all_messages.iter().find(|m| m.role == "user").map(|m| m.seq)
        } else {
            None
        };
        let recent_min_seq = recent_messages.iter()
            .filter(|m| Some(m.seq) != first_user_seq)
            .map(|m| m.seq)
            .min()
            .unwrap_or(i64::MAX);

        // Older messages to summarize (between keep_first and recent window)
        let older: Vec<&StoredMessage> = all_messages.iter()
            .filter(|m| m.seq < recent_min_seq && Some(m.seq) != first_user_seq)
            .collect();

        if older.is_empty() {
            let token_estimate: usize = recent_messages.iter().map(|m| m.content.len() / 4).sum();
            let included = recent_messages.len();
            return Ok(ContextResponse {
                messages: recent_messages,
                strategy_used: "compacted".into(),
                total_messages,
                included_messages: included,
                recalled: RecalledContext { tools: recalled_tools, memories: vec![] },
                token_estimate,
                conversation_messages: included,
                fallback: false,
                summary: None,
                summary_range: None,
            });
        }

        let older_owned: Vec<StoredMessage> = older.into_iter().cloned().collect();
        // Phase 1: Prune long tool results before summarization
        let pruned: Vec<StoredMessage> = older_owned.iter().map(|m| {
            if m.role == "tool" && m.content.len() > prune_threshold {
                StoredMessage { content: "[pruned]".into(), ..m.clone() }
            } else {
                m.clone()
            }
        }).collect();
        let conversation_text = format_conversation(&pruned);
        let system_prompt = "Summarize this conversation concisely. Focus on key decisions, facts, and action items.";

        match llm.chat(system_prompt, &conversation_text, summary_budget).await {
            Ok(summary_text) => {
                tracing::debug!("LLM summary generated: {} chars", summary_text.len());
                let first_seq = older_owned.first().map(|m| m.seq).unwrap_or(0);
                let last_seq = older_owned.last().map(|m| m.seq).unwrap_or(0);
                let count = older_owned.len();

                let msg_tokens: usize = recent_messages.iter().map(|m| m.content.len() / 4).sum();
                let token_estimate = msg_tokens + summary_text.len() / 4;
                let included = recent_messages.len();
                Ok(ContextResponse {
                    messages: recent_messages,
                    strategy_used: "compacted".into(),
                    total_messages,
                    included_messages: included,
                    recalled: RecalledContext { tools: recalled_tools, memories: vec![] },
                    token_estimate,
                    conversation_messages: all_messages.len(),
                    fallback: false,
                    summary: Some(summary_text),
                    summary_range: Some(models::SummaryRange { first_seq, last_seq, count }),
                })
            }
            Err(e) => {
                tracing::warn!("LLM summary failed, falling back to recent: {e}");
                let messages = select_messages(all_messages, "recent", max_tokens, false);
                let token_estimate: usize = messages.iter().map(|m| m.content.len() / 4).sum();
                let included = messages.len();
                Ok(ContextResponse {
                    messages,
                    strategy_used: "compacted".into(),
                    total_messages,
                    included_messages: included,
                    recalled: RecalledContext { tools: recalled_tools, memories: vec![] },
                    token_estimate,
                    conversation_messages: included,
                    fallback: true,
                    summary: None,
                    summary_range: None,
                })
            }
        }
    }

    async fn recall_tools(
        &self,
        dataset_id: &str,
        namespace_id: &str,
        session_id: &str,
        messages: &[StoredMessage],
        recall: &Option<models::RecallConfig>,
    ) -> Result<Vec<RankedTool>, CoreError> {
        let recall = match recall {
            Some(r) => r,
            None => return Ok(vec![]),
        };

        let (limit, min_similarity) = match &recall.tools {
            Some(models::RecallToolsOption::Bool(true)) => (5usize, None),
            Some(models::RecallToolsOption::Config(c)) => (c.limit, c.min_similarity),
            Some(models::RecallToolsOption::Bool(false)) | None => return Ok(vec![]),
        };

        // Load previous session tools for continuity
        let prev_tool_names = {
            let storage = self.storage.clone();
            let ds = dataset_id.to_string();
            let ns = namespace_id.to_string();
            let sess = session_id.to_string();
            tokio::task::spawn_blocking(move || storage.load_session_tools(&ds, &ns, &sess))
                .await
                .map_err(|e| CoreError::EmbeddingFailed(anyhow::anyhow!("spawn failed: {e}")))?
                .map_err(CoreError::EmbeddingFailed)?
        };

        // Build base tools from previous session (score 1.0)
        let mut base_tools: Vec<RankedTool> = Vec::new();
        {
            let tools_map = self.tools.read().await;
            if let Some(dataset_tools) = tools_map.get(dataset_id) {
                for name in &prev_tool_names {
                    if let Some(st) = dataset_tools.get(name) {
                        if !st.tool.always_include {
                            base_tools.push(RankedTool {
                                tool: st.tool.clone(),
                                score: 1.0,
                                graph_expanded: None,
                            });
                        }
                    }
                }
            }
        }

        // Find last user message as query
        let query: String = match messages.iter().rev().find(|m| m.role == "user") {
            Some(m) if !m.content.is_empty() => m.content.clone(),
            _ => {
                // No query but we have previous tools — return those
                if !base_tools.is_empty() {
                    self.save_session_tools_async(dataset_id, namespace_id, session_id, &base_tools);
                }
                return Ok(base_tools);
            }
        };

        // Exclude previous session tools from discovery (they're already in base)
        let exclude: Vec<String> = prev_tool_names.clone();

        let discover_resp = self.discover(dataset_id, DiscoverRequest {
            query,
            limit: Some(limit),
            strategy: SearchStrategy::default(),
            embedding_weights: None,
            exclude: if exclude.is_empty() { None } else { Some(exclude) },
            turn_id: None,
            namespace: None,
            session: None,
        }).await?;

        let mut new_tools = discover_resp.tools;
        if let Some(min_sim) = min_similarity {
            new_tools.retain(|t| t.score >= min_sim);
        }

        // Merge: base tools first, then new discoveries
        let mut all_tools = base_tools;
        all_tools.extend(new_tools);

        // Save merged tool names for next turn
        self.save_session_tools_async(dataset_id, namespace_id, session_id, &all_tools);

        Ok(all_tools)
    }

    fn save_session_tools_async(&self, dataset_id: &str, namespace_id: &str, session_id: &str, tools: &[RankedTool]) {
        let storage = self.storage.clone();
        let ds = dataset_id.to_string();
        let ns = namespace_id.to_string();
        let sess = session_id.to_string();
        let names: Vec<String> = tools.iter().map(|t| t.tool.name.clone()).collect();
        tokio::task::spawn_blocking(move || {
            let name_refs: Vec<&str> = names.iter().map(|s| s.as_str()).collect();
            if let Err(e) = storage.save_session_tools(&ds, &ns, &sess, &name_refs) {
                tracing::error!("storage save_session_tools failed: {e}");
            }
        });
    }

    fn can_use_embeddings(&self, tools: &[&StoredTool]) -> bool {
        self.embedding.is_some() && tools.iter().all(|t| t.embeddings.is_some())
    }

    async fn embed_cached(&self, text: &str) -> anyhow::Result<Vec<f32>> {
        let cached = { self.embedding_cache.read().await.get(text).cloned() };
        if let Some(emb) = cached {
            return Ok(emb);
        }
        let embedding_svc = self.embedding.as_ref()
            .ok_or_else(|| anyhow::anyhow!("embedding service not configured"))?;
        let emb = embedding_svc.embed(text).await?;
        self.embedding_cache.write().await.insert(text.to_string(), emb.clone());

        // Write-through to storage
        {
            let storage = self.storage.clone();
            let key = text.to_string();
            let val = emb.clone();
            tokio::task::spawn_blocking(move || {
                if let Err(e) = storage.save_embeddings(&[(&key, &val)]) {
                    tracing::error!("storage save_embeddings failed: {e}");
                }
            });
        }

        Ok(emb)
    }

}

// Helpers

fn format_conversation(messages: &[StoredMessage]) -> String {
    messages.iter().map(|m| format!("{}: {}", m.role, m.content)).collect::<Vec<_>>().join("\n")
}

fn select_messages(all_messages: &[StoredMessage], strategy: &str, max_tokens: usize, keep_first: bool) -> Vec<StoredMessage> {
    match strategy {
        "full" => {
            let mut selected = Vec::new();
            let mut tokens_used = 0usize;
            for msg in all_messages {
                let msg_tokens = msg.content.len() / 4;
                if tokens_used + msg_tokens > max_tokens && !selected.is_empty() {
                    break;
                }
                tokens_used += msg_tokens;
                selected.push(msg.clone());
            }
            selected
        }
        _ => {
            let first_user_msg = if keep_first {
                all_messages.iter().find(|m| m.role == "user")
            } else {
                None
            };

            let mut tokens_used = 0usize;
            if let Some(first) = first_user_msg {
                tokens_used += first.content.len() / 4;
            }

            let first_user_seq = first_user_msg.map(|m| m.seq);
            let mut recent = Vec::new();
            for msg in all_messages.iter().rev() {
                if Some(msg.seq) == first_user_seq { continue; }
                let msg_tokens = msg.content.len() / 4;
                if tokens_used + msg_tokens > max_tokens && !recent.is_empty() {
                    break;
                }
                tokens_used += msg_tokens;
                recent.push(msg.clone());
            }
            recent.reverse();

            let mut selected = Vec::new();
            if let Some(first) = first_user_msg {
                selected.push(first.clone());
            }
            selected.extend(recent);
            selected
        }
    }
}

fn get_string_array(metadata: &serde_json::Value, key: &str) -> Vec<String> {
    metadata.get(key)
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn expand_with_providers(
    mut ranked: Vec<RankedTool>,
    all_tools: &HashMap<String, StoredTool>,
    limit: usize,
) -> Vec<RankedTool> {
    let mut required_params: std::collections::HashSet<String> = std::collections::HashSet::new();
    let ranked_names: std::collections::HashSet<String> = ranked.iter().map(|r| r.tool.name.clone()).collect();

    for rt in &ranked {
        if let Some(ref meta) = rt.tool.metadata {
            for param in get_string_array(meta, "requires") {
                required_params.insert(param);
            }
        }
    }

    if required_params.is_empty() {
        return ranked;
    }

    let mut providers: Vec<(String, usize, &StoredTool)> = Vec::new();
    for stored in all_tools.values() {
        if ranked_names.contains(&stored.tool.name) {
            continue;
        }
        if let Some(ref meta) = stored.tool.metadata {
            let provides = get_string_array(meta, "provides");
            let coverage = provides.iter().filter(|p| required_params.contains(*p)).count();
            if coverage > 0 {
                providers.push((stored.tool.name.clone(), coverage, stored));
            }
        }
    }

    providers.sort_by(|a, b| b.1.cmp(&a.1));

    let max_extra = ((limit as f64) * 0.6).ceil() as usize;
    for (_, _, stored) in providers.into_iter().take(max_extra) {
        ranked.push(RankedTool {
            tool: stored.tool.clone(),
            score: 0.0,
            graph_expanded: Some(true),
        });
    }

    ranked
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn make_core() -> AgentifiedCore {
        let storage = Arc::new(SqliteStorage::new(":memory:").unwrap());
        let embedding: Arc<dyn EmbeddingService> = Arc::new(FakeEmbedding {
            call_count: Default::default(),
            batch_call_count: Default::default(),
        });
        AgentifiedCore::new(embedding, storage)
    }

    #[tokio::test]
    async fn context_recent_returns_messages_fitting_token_budget() {
        let core = make_core();

        // Append 5 messages with 100 chars each → 100/4 = 25 tokens each
        let content = "x".repeat(100);
        let msgs: Vec<models::MessageInput> = (0..5).map(|_| models::MessageInput {
            role: "user".into(),
            content: content.clone(),
            tool_call_id: None,
            tool_calls: None,
        }).collect();

        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(),
            namespace: "ns".into(),
            session: "s1".into(),
            messages: msgs,
        }).await.unwrap();

        // Budget = 60 tokens → fits 2 messages (25 tokens each = 50, 3rd would be 75)
        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(),
            namespace: "ns".into(),
            session: "s1".into(),
            messages: models::ContextMessagesConfig {
                strategy: "recent".into(),
                max_tokens: 60,
                ..Default::default()
            },
            recall: None,
            limit_tokens: None,
        }).await.unwrap();

        assert_eq!(resp.strategy_used, "recent");
        assert_eq!(resp.messages.len(), 2);
        assert_eq!(resp.total_messages, 5);
        assert_eq!(resp.included_messages, 2);
        assert_eq!(resp.conversation_messages, 2);
        assert!(resp.token_estimate <= 60);
        assert!(!resp.fallback);
        assert!(resp.recalled.tools.is_empty());
        assert!(resp.recalled.memories.is_empty());
        // Should be the last 2 messages (seq 4, 5)
        assert_eq!(resp.messages[0].seq, 4);
        assert_eq!(resp.messages[1].seq, 5);
    }

    #[tokio::test]
    async fn compacted_without_llm_returns_unsupported() {
        let core = make_core(); // no LLM
        let err = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: models::ContextMessagesConfig { strategy: "compacted".into(), max_tokens: 4000, ..Default::default() },
            recall: None, limit_tokens: None,
        }).await.unwrap_err();
        match err {
            CoreError::UnsupportedStrategy(_) => {}
            _ => panic!("expected UnsupportedStrategy, got {err:?}"),
        }
    }

    #[tokio::test]
    async fn summary_strategy_returns_bad_request() {
        let core = make_core_with_llm();
        let err = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: models::ContextMessagesConfig { strategy: "summary".into(), max_tokens: 4000, ..Default::default() },
            recall: None, limit_tokens: None,
        }).await.unwrap_err();
        match err {
            CoreError::BadRequest(msg) => assert!(msg.contains("unknown strategy")),
            _ => panic!("expected BadRequest, got {err:?}"),
        }
    }

    #[tokio::test]
    async fn recent_summary_strategy_returns_bad_request() {
        let core = make_core_with_llm();
        let err = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: models::ContextMessagesConfig { strategy: "recent+summary".into(), max_tokens: 4000, ..Default::default() },
            recall: None, limit_tokens: None,
        }).await.unwrap_err();
        match err {
            CoreError::BadRequest(msg) => assert!(msg.contains("unknown strategy")),
            _ => panic!("expected BadRequest, got {err:?}"),
        }
    }

    #[tokio::test]
    async fn context_empty_session_returns_zeros() {
        let core = make_core();
        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(),
            namespace: "ns".into(),
            session: "empty".into(),
            messages: models::ContextMessagesConfig {
                strategy: "recent".into(),
                max_tokens: 4000,
                ..Default::default()
            },
            recall: None,
            limit_tokens: None,
        }).await.unwrap();

        assert_eq!(resp.messages.len(), 0);
        assert_eq!(resp.total_messages, 0);
        assert_eq!(resp.included_messages, 0);
        assert_eq!(resp.token_estimate, 0);
        assert_eq!(resp.conversation_messages, 0);
    }

    #[tokio::test]
    async fn context_full_returns_all_messages_up_to_budget() {
        let core = make_core();

        let content = "x".repeat(100); // 25 tokens each
        let msgs: Vec<models::MessageInput> = (0..5).map(|_| models::MessageInput {
            role: "user".into(),
            content: content.clone(),
            tool_call_id: None,
            tool_calls: None,
        }).collect();

        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(),
            namespace: "ns".into(),
            session: "s1".into(),
            messages: msgs,
        }).await.unwrap();

        // Budget = 60 tokens → fits 2 messages from oldest (seq 1, 2)
        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(),
            namespace: "ns".into(),
            session: "s1".into(),
            messages: models::ContextMessagesConfig {
                strategy: "full".into(),
                max_tokens: 60,
                ..Default::default()
            },
            recall: None,
            limit_tokens: None,
        }).await.unwrap();

        assert_eq!(resp.strategy_used, "full");
        assert_eq!(resp.messages.len(), 2);
        // Full takes from oldest
        assert_eq!(resp.messages[0].seq, 1);
        assert_eq!(resp.messages[1].seq, 2);
        assert_eq!(resp.total_messages, 5);
    }

    #[tokio::test]
    async fn context_full_returns_all_when_within_budget() {
        let core = make_core();

        let msgs: Vec<models::MessageInput> = (0..3).map(|i| models::MessageInput {
            role: "user".into(),
            content: format!("msg {i}"),
            tool_call_id: None,
            tool_calls: None,
        }).collect();

        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(),
            namespace: "ns".into(),
            session: "s1".into(),
            messages: msgs,
        }).await.unwrap();

        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(),
            namespace: "ns".into(),
            session: "s1".into(),
            messages: models::ContextMessagesConfig {
                strategy: "full".into(),
                max_tokens: 4000,
                ..Default::default()
            },
            recall: None,
            limit_tokens: None,
        }).await.unwrap();

        assert_eq!(resp.messages.len(), 3);
        assert_eq!(resp.total_messages, 3);
        assert_eq!(resp.included_messages, 3);
    }

    #[tokio::test]
    async fn context_recent_keep_first_preserves_first_user_message() {
        let core = make_core();

        // 5 messages: user, assistant, user, assistant, user — each 100 chars (25 tokens)
        let content = "x".repeat(100);
        let roles = ["user", "assistant", "user", "assistant", "user"];
        let msgs: Vec<models::MessageInput> = roles.iter().map(|r| models::MessageInput {
            role: r.to_string(),
            content: content.clone(),
            tool_call_id: None,
            tool_calls: None,
        }).collect();

        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(),
            namespace: "ns".into(),
            session: "s1".into(),
            messages: msgs,
        }).await.unwrap();

        // Budget = 60 tokens → fits 2 messages (25 each).
        // With keep_first=true: first user msg (seq 1) + most recent (seq 5)
        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(),
            namespace: "ns".into(),
            session: "s1".into(),
            messages: models::ContextMessagesConfig {
                strategy: "recent".into(),
                max_tokens: 60,
                keep_first: true,
                ..Default::default()
            },
            recall: None,
            limit_tokens: None,
        }).await.unwrap();

        assert_eq!(resp.messages.len(), 2);
        assert_eq!(resp.messages[0].seq, 1); // first user message preserved
        assert_eq!(resp.messages[1].seq, 5); // most recent message
    }

    #[tokio::test]
    async fn context_recent_keep_first_no_duplication_when_in_window() {
        let core = make_core();

        // 3 short messages — all fit in budget
        let msgs: Vec<models::MessageInput> = vec![
            models::MessageInput { role: "user".into(), content: "hello".into(), tool_call_id: None, tool_calls: None },
            models::MessageInput { role: "assistant".into(), content: "hi".into(), tool_call_id: None, tool_calls: None },
            models::MessageInput { role: "user".into(), content: "bye".into(), tool_call_id: None, tool_calls: None },
        ];

        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(), messages: msgs,
        }).await.unwrap();

        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: models::ContextMessagesConfig {
                strategy: "recent".into(),
                max_tokens: 4000,
                keep_first: true,
                ..Default::default()
            },
            recall: None, limit_tokens: None,
        }).await.unwrap();

        // All 3 fit, first user msg (seq 1) already in window — no duplication
        assert_eq!(resp.messages.len(), 3);
        assert_eq!(resp.messages[0].seq, 1);
        assert_eq!(resp.messages[1].seq, 2);
        assert_eq!(resp.messages[2].seq, 3);
    }

    #[tokio::test]
    async fn context_recent_keep_first_no_user_messages() {
        let core = make_core();

        // Only system/assistant messages, no user
        let msgs: Vec<models::MessageInput> = vec![
            models::MessageInput { role: "system".into(), content: "x".repeat(100), tool_call_id: None, tool_calls: None },
            models::MessageInput { role: "assistant".into(), content: "x".repeat(100), tool_call_id: None, tool_calls: None },
            models::MessageInput { role: "system".into(), content: "x".repeat(100), tool_call_id: None, tool_calls: None },
            models::MessageInput { role: "assistant".into(), content: "x".repeat(100), tool_call_id: None, tool_calls: None },
        ];

        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(), messages: msgs,
        }).await.unwrap();

        // Budget fits 2. keep_first=true but no user msgs → same as keep_first=false
        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: models::ContextMessagesConfig {
                strategy: "recent".into(),
                max_tokens: 60,
                keep_first: true,
                ..Default::default()
            },
            recall: None, limit_tokens: None,
        }).await.unwrap();

        assert_eq!(resp.messages.len(), 2);
        assert_eq!(resp.messages[0].seq, 3);
        assert_eq!(resp.messages[1].seq, 4);
    }

    #[tokio::test]
    async fn context_full_keep_first_unchanged() {
        let core = make_core();

        let content = "x".repeat(100);
        let msgs: Vec<models::MessageInput> = (0..5).map(|_| models::MessageInput {
            role: "user".into(), content: content.clone(), tool_call_id: None, tool_calls: None,
        }).collect();

        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(), messages: msgs,
        }).await.unwrap();

        // full strategy with keep_first=true — should behave same as keep_first=false
        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: models::ContextMessagesConfig {
                strategy: "full".into(),
                max_tokens: 60,
                keep_first: true,
                ..Default::default()
            },
            recall: None, limit_tokens: None,
        }).await.unwrap();

        assert_eq!(resp.strategy_used, "full");
        assert_eq!(resp.messages.len(), 2);
        assert_eq!(resp.messages[0].seq, 1);
        assert_eq!(resp.messages[1].seq, 2);
    }

    #[tokio::test]
    async fn recall_tools_true_populates_recalled_tools() {
        let core = make_core();

        // Register some tools
        core.register_tools("ds", vec![
            models::Tool {
                name: "get_weather".into(),
                description: "Get weather forecast for a location".into(),
                parameters: serde_json::json!({}),
                metadata: None,
                fields: None,
                always_include: false,
            },
            models::Tool {
                name: "get_stock".into(),
                description: "Get stock price for a ticker symbol".into(),
                parameters: serde_json::json!({}),
                metadata: None,
                fields: None,
                always_include: false,
            },
        ]).await.unwrap();

        // Append a user message about weather
        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(),
            namespace: "ns".into(),
            session: "s1".into(),
            messages: vec![models::MessageInput {
                role: "user".into(),
                content: "What's the weather like in Paris?".into(),
                tool_call_id: None,
                tool_calls: None,
            }],
        }).await.unwrap();

        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(),
            namespace: "ns".into(),
            session: "s1".into(),
            messages: models::ContextMessagesConfig {
                strategy: "recent".into(),
                max_tokens: 4000,
                ..Default::default()
            },
            recall: Some(models::RecallConfig {
                tools: Some(models::RecallToolsOption::Bool(true)),
            }),
            limit_tokens: None,
        }).await.unwrap();

        assert!(!resp.recalled.tools.is_empty(), "recalled tools should not be empty");
        // Verify tools have names from our registered set
        let tool_names: Vec<&str> = resp.recalled.tools.iter().map(|t| t.tool.name.as_str()).collect();
        assert!(tool_names.contains(&"get_weather") || tool_names.contains(&"get_stock"));
    }

    #[tokio::test]
    async fn recall_tools_config_limits_results() {
        let core = make_core();

        // Register 3 tools
        core.register_tools("ds", vec![
            models::Tool { name: "tool_a".into(), description: "Alpha tool".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
            models::Tool { name: "tool_b".into(), description: "Beta tool".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
            models::Tool { name: "tool_c".into(), description: "Gamma tool".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
        ]).await.unwrap();

        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: vec![models::MessageInput { role: "user".into(), content: "alpha beta gamma".into(), tool_call_id: None, tool_calls: None }],
        }).await.unwrap();

        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: models::ContextMessagesConfig { strategy: "recent".into(), max_tokens: 4000, ..Default::default() },
            recall: Some(models::RecallConfig {
                tools: Some(models::RecallToolsOption::Config(models::RecallToolsConfig { limit: 1, min_similarity: None })),
            }),
            limit_tokens: None,
        }).await.unwrap();

        assert_eq!(resp.recalled.tools.len(), 1, "should limit to 1 tool");
    }

    #[tokio::test]
    async fn recall_tools_no_user_message_returns_empty() {
        let core = make_core();

        core.register_tools("ds", vec![
            models::Tool { name: "tool_a".into(), description: "Alpha".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
        ]).await.unwrap();

        // Only assistant messages, no user messages
        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: vec![models::MessageInput { role: "assistant".into(), content: "Hello!".into(), tool_call_id: None, tool_calls: None }],
        }).await.unwrap();

        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: models::ContextMessagesConfig { strategy: "recent".into(), max_tokens: 4000, ..Default::default() },
            recall: Some(models::RecallConfig { tools: Some(models::RecallToolsOption::Bool(true)) }),
            limit_tokens: None,
        }).await.unwrap();

        assert!(resp.recalled.tools.is_empty(), "no user message → no recalled tools");
    }

    #[tokio::test]
    async fn limit_tokens_reduces_message_budget_when_tools_recalled() {
        let core = make_core();

        core.register_tools("ds", vec![
            models::Tool {
                name: "my_tool".into(),
                description: "A tool with a description".into(),
                parameters: serde_json::json!({"type": "object"}),
                metadata: None,
                fields: None,
                always_include: false,
            },
        ]).await.unwrap();

        // 5 messages, 100 chars each = 25 tokens each
        let content = "x".repeat(100);
        let mut msgs: Vec<models::MessageInput> = (0..4).map(|_| models::MessageInput {
            role: "assistant".into(), content: content.clone(), tool_call_id: None, tool_calls: None,
        }).collect();
        msgs.push(models::MessageInput { role: "user".into(), content: "find my tool".into(), tool_call_id: None, tool_calls: None });

        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: msgs,
        }).await.unwrap();

        // Without limit_tokens, maxTokens=4000 → all 5 messages fit
        let resp_unlimited = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: models::ContextMessagesConfig { strategy: "recent".into(), max_tokens: 4000, ..Default::default() },
            recall: Some(models::RecallConfig { tools: Some(models::RecallToolsOption::Bool(true)) }),
            limit_tokens: None,
        }).await.unwrap();

        // With tight limit_tokens, tools eat into the budget → fewer messages
        let resp_limited = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: models::ContextMessagesConfig { strategy: "recent".into(), max_tokens: 4000, ..Default::default() },
            recall: Some(models::RecallConfig { tools: Some(models::RecallToolsOption::Bool(true)) }),
            limit_tokens: Some(60), // tight budget
        }).await.unwrap();

        assert!(resp_limited.included_messages < resp_unlimited.included_messages,
            "limited={} should be less than unlimited={}",
            resp_limited.included_messages, resp_unlimited.included_messages);
    }

    #[tokio::test]
    async fn limit_tokens_without_recall_uses_full_budget() {
        let core = make_core();

        let content = "x".repeat(100); // 25 tokens each
        let msgs: Vec<models::MessageInput> = (0..5).map(|_| models::MessageInput {
            role: "user".into(), content: content.clone(), tool_call_id: None, tool_calls: None,
        }).collect();

        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: msgs,
        }).await.unwrap();

        // limit_tokens=60, no recall → no tool tokens subtracted → same as max_tokens=60
        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: models::ContextMessagesConfig { strategy: "recent".into(), max_tokens: 4000, ..Default::default() },
            recall: None,
            limit_tokens: Some(60),
        }).await.unwrap();

        // 60 tokens fits 2 messages (25 tokens each)
        assert_eq!(resp.included_messages, 2);
    }

    #[tokio::test]
    async fn session_tools_persist_across_context_calls() {
        let core = make_core();

        // Register 3 tools with distinct descriptions
        core.register_tools("ds", vec![
            models::Tool { name: "get_weather".into(), description: "Get weather forecast for a location".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
            models::Tool { name: "get_stock".into(), description: "Get stock price for a ticker".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
            models::Tool { name: "send_email".into(), description: "Send an email message".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
        ]).await.unwrap();

        // First turn: user asks about weather, limit=1 so only weather tool is recalled
        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: vec![models::MessageInput { role: "user".into(), content: "What is the weather forecast?".into(), tool_call_id: None, tool_calls: None }],
        }).await.unwrap();

        let resp1 = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: models::ContextMessagesConfig { strategy: "recent".into(), max_tokens: 4000, ..Default::default() },
            recall: Some(models::RecallConfig {
                tools: Some(models::RecallToolsOption::Config(models::RecallToolsConfig { limit: 1, min_similarity: None })),
            }),
            limit_tokens: None,
        }).await.unwrap();
        let first_tool_names: Vec<String> = resp1.recalled.tools.iter().map(|t| t.tool.name.clone()).collect();
        assert_eq!(first_tool_names.len(), 1, "first turn should recall 1 tool");

        // Second turn: user asks about something different, limit=1
        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: vec![models::MessageInput { role: "user".into(), content: "Send an email now".into(), tool_call_id: None, tool_calls: None }],
        }).await.unwrap();

        let resp2 = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: models::ContextMessagesConfig { strategy: "recent".into(), max_tokens: 4000, ..Default::default() },
            recall: Some(models::RecallConfig {
                tools: Some(models::RecallToolsOption::Config(models::RecallToolsConfig { limit: 1, min_similarity: None })),
            }),
            limit_tokens: None,
        }).await.unwrap();
        let second_tool_names: Vec<String> = resp2.recalled.tools.iter().map(|t| t.tool.name.clone()).collect();

        // Session continuity: first turn's tool should persist + second turn's new discovery
        assert!(second_tool_names.len() > 1,
            "second turn should have tools from first turn + new discovery, got {:?}", second_tool_names);
        for name in &first_tool_names {
            assert!(second_tool_names.contains(name),
                "tool '{}' from first turn should persist. second={:?}", name, second_tool_names);
        }
    }

    fn make_core_with_llm() -> AgentifiedCore {
        let storage = Arc::new(SqliteStorage::new(":memory:").unwrap());
        let embedding: Arc<dyn EmbeddingService> = Arc::new(FakeEmbedding {
            call_count: Default::default(),
            batch_call_count: Default::default(),
        });
        let llm: Arc<dyn embedding::LlmService> = Arc::new(FakeLlm);
        AgentifiedCore::new_with_llm(embedding, storage, llm)
    }

    #[tokio::test]
    async fn compacted_empty_session_returns_empty() {
        let core = make_core_with_llm();

        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "empty".into(),
            messages: models::ContextMessagesConfig { strategy: "compacted".into(), max_tokens: 4000, ..Default::default() },
            recall: None, limit_tokens: None,
        }).await.unwrap();

        assert_eq!(resp.messages.len(), 0);
        assert_eq!(resp.total_messages, 0);
    }

    #[tokio::test]
    async fn compacted_strategy_returns_summary_plus_recent() {
        let core = make_core_with_llm();

        // Add enough messages that not all fit in 60% budget
        let content = "x".repeat(100); // 25 tokens each
        let mut msgs: Vec<models::MessageInput> = (0..5).map(|_| models::MessageInput {
            role: "assistant".into(), content: content.clone(), tool_call_id: None, tool_calls: None,
        }).collect();
        msgs.push(models::MessageInput { role: "user".into(), content: "summary please".into(), tool_call_id: None, tool_calls: None });

        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: msgs,
        }).await.unwrap();

        // Budget = 100 tokens. Recent 60% = 60 tokens → 2 messages. Summary 40% = 40 tokens.
        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: models::ContextMessagesConfig { strategy: "compacted".into(), max_tokens: 100, ..Default::default() },
            recall: None, limit_tokens: None,
        }).await.unwrap();

        assert_eq!(resp.strategy_used, "compacted");
        assert!(!resp.fallback);
        assert!(resp.summary.is_some());
        assert!(resp.summary_range.is_some());
        assert!(!resp.messages.is_empty());
        assert!(resp.messages.iter().all(|m| m.seq > 0));
    }

    #[tokio::test]
    async fn compacted_falls_back_on_llm_failure() {
        let storage = Arc::new(SqliteStorage::new(":memory:").unwrap());
        let embedding: Arc<dyn EmbeddingService> = Arc::new(FakeEmbedding {
            call_count: Default::default(),
            batch_call_count: Default::default(),
        });
        let llm: Arc<dyn embedding::LlmService> = Arc::new(FailingLlm);
        let core = AgentifiedCore::new_with_llm(embedding, storage, llm);

        let content = "x".repeat(100);
        let msgs: Vec<models::MessageInput> = (0..5).map(|_| models::MessageInput {
            role: "user".into(), content: content.clone(), tool_call_id: None, tool_calls: None,
        }).collect();

        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: msgs,
        }).await.unwrap();

        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: models::ContextMessagesConfig { strategy: "compacted".into(), max_tokens: 100, ..Default::default() },
            recall: None, limit_tokens: None,
        }).await.unwrap();

        assert!(resp.fallback);
        assert!(resp.summary.is_none());
        assert!(!resp.messages.is_empty());
    }

    #[tokio::test]
    async fn compacted_returns_summary_range_for_older_messages() {
        let core = make_core_with_llm();

        let content = "x".repeat(100); // 25 tokens each
        let msgs: Vec<models::MessageInput> = (0..6).map(|i| models::MessageInput {
            role: if i % 2 == 0 { "user" } else { "assistant" }.into(),
            content: content.clone(),
            tool_call_id: None, tool_calls: None,
        }).collect();

        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: msgs,
        }).await.unwrap();

        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: models::ContextMessagesConfig { strategy: "compacted".into(), max_tokens: 100, ..Default::default() },
            recall: None, limit_tokens: None,
        }).await.unwrap();

        assert!(!resp.fallback);
        assert!(resp.summary.is_some());
        assert!(resp.messages.iter().all(|m| m.seq > 0));
        let range = resp.summary_range.unwrap();
        assert_eq!(range.first_seq, 1);
        assert_eq!(range.last_seq, 4);
        assert_eq!(range.count, 4);
    }

    #[tokio::test]
    async fn compacted_prunes_long_tool_results() {
        let core = make_core_with_llm();

        // Create messages: old tool msg with long content (>500 chars), then recent user msg
        let long_tool_content = "x".repeat(600); // > default prune_threshold of 500
        let msgs = vec![
            models::MessageInput { role: "user".into(), content: "call tool".into(), tool_call_id: None, tool_calls: None },
            models::MessageInput { role: "tool".into(), content: long_tool_content.clone(), tool_call_id: Some("tc1".into()), tool_calls: None },
            models::MessageInput { role: "assistant".into(), content: "got it".into(), tool_call_id: None, tool_calls: None },
            models::MessageInput { role: "user".into(), content: "x".repeat(100), tool_call_id: None, tool_calls: None },
            models::MessageInput { role: "assistant".into(), content: "x".repeat(100), tool_call_id: None, tool_calls: None },
            models::MessageInput { role: "user".into(), content: "summarize".into(), tool_call_id: None, tool_calls: None },
        ];

        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: msgs,
        }).await.unwrap();

        // Budget 100 → recent gets last ~2 msgs, older msgs (including tool) get summarized
        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: models::ContextMessagesConfig { strategy: "compacted".into(), max_tokens: 100, ..Default::default() },
            recall: None, limit_tokens: None,
        }).await.unwrap();

        assert!(resp.summary.is_some());
        // FakeLlm echoes first 100 chars of input. The tool content should be [pruned], not the 600-char original.
        let summary = resp.summary.unwrap();
        assert!(!summary.contains(&long_tool_content), "long tool content should have been pruned before summarization");
        assert!(summary.contains("[pruned]"), "summary should contain [pruned] marker from pruned tool result");
    }

    #[tokio::test]
    async fn compacted_preserves_short_tool_results() {
        let core = make_core_with_llm();

        let short_tool_content = "result: 42"; // < 500 chars
        // Need enough bulk so recent window doesn't fit everything → older msgs get summarized
        let mut msgs = vec![
            models::MessageInput { role: "user".into(), content: "call tool".into(), tool_call_id: None, tool_calls: None },
            models::MessageInput { role: "tool".into(), content: short_tool_content.into(), tool_call_id: Some("tc1".into()), tool_calls: None },
            models::MessageInput { role: "assistant".into(), content: "x".repeat(100), tool_call_id: None, tool_calls: None },
        ];
        for _ in 0..4 {
            msgs.push(models::MessageInput { role: "user".into(), content: "x".repeat(100), tool_call_id: None, tool_calls: None });
            msgs.push(models::MessageInput { role: "assistant".into(), content: "x".repeat(100), tool_call_id: None, tool_calls: None });
        }

        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: msgs,
        }).await.unwrap();

        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: models::ContextMessagesConfig { strategy: "compacted".into(), max_tokens: 100, ..Default::default() },
            recall: None, limit_tokens: None,
        }).await.unwrap();

        assert!(resp.summary.is_some());
        let summary = resp.summary.unwrap();
        assert!(!summary.contains("[pruned]"), "short tool content should not be pruned");
    }

    #[tokio::test]
    async fn compacted_custom_prune_threshold() {
        let core = make_core_with_llm();

        let tool_content = "x".repeat(200); // > custom threshold of 100, but < default 500
        let msgs = vec![
            models::MessageInput { role: "user".into(), content: "call tool".into(), tool_call_id: None, tool_calls: None },
            models::MessageInput { role: "tool".into(), content: tool_content.clone(), tool_call_id: Some("tc1".into()), tool_calls: None },
            models::MessageInput { role: "assistant".into(), content: "got it".into(), tool_call_id: None, tool_calls: None },
            models::MessageInput { role: "user".into(), content: "x".repeat(100), tool_call_id: None, tool_calls: None },
            models::MessageInput { role: "assistant".into(), content: "x".repeat(100), tool_call_id: None, tool_calls: None },
            models::MessageInput { role: "user".into(), content: "summarize".into(), tool_call_id: None, tool_calls: None },
        ];

        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: msgs,
        }).await.unwrap();

        // Custom prune_threshold = 100 → 200-char tool content should be pruned
        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(), namespace: "ns".into(), session: "s1".into(),
            messages: models::ContextMessagesConfig {
                strategy: "compacted".into(),
                max_tokens: 100,
                prune_threshold: 100,
                ..Default::default()
            },
            recall: None, limit_tokens: None,
        }).await.unwrap();

        assert!(resp.summary.is_some());
        let summary = resp.summary.unwrap();
        assert!(summary.contains("[pruned]"), "tool content >100 chars should be pruned with custom threshold");
    }

    // Strategy tests

    fn make_bm25_core() -> AgentifiedCore {
        let storage = Arc::new(SqliteStorage::new(":memory:").unwrap());
        AgentifiedCore::new_bm25_only(storage)
    }

    #[tokio::test]
    async fn register_tools_without_embedding_service() {
        let core = make_bm25_core();
        let tools = vec![
            Tool { name: "refund".into(), description: "Process a refund".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
        ];
        let resp = core.register_tools("ds", tools).await.unwrap();
        assert_eq!(resp.registered, 1);

        let listed = core.list_tools("ds").await.unwrap();
        assert_eq!(listed.tools.len(), 1);

        // Verify the stored tool has no embeddings but has bm25_text
        let tools_map = core.tools.read().await;
        let stored = tools_map.get("ds").unwrap().get("refund").unwrap();
        assert!(stored.embeddings.is_none());
        assert!(!stored.bm25_text.is_empty());
    }

    #[tokio::test]
    async fn discover_bm25_without_embedding_service() {
        let core = make_bm25_core();
        let tools = vec![
            Tool { name: "refund".into(), description: "Process a refund for invoice".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
            Tool { name: "getUser".into(), description: "Get user account details".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
        ];
        core.register_tools("ds", tools).await.unwrap();

        let resp = core.discover("ds", DiscoverRequest {
            query: "refund".into(),
            limit: Some(5),
            strategy: SearchStrategy::Bm25,
            embedding_weights: None,
            exclude: None,
            turn_id: None,
            namespace: None,
            session: None,
        }).await.unwrap();

        assert!(!resp.tools.is_empty());
        assert_eq!(resp.tools[0].tool.name, "refund");
    }

    #[tokio::test]
    async fn discover_semantic_falls_back_to_bm25_without_embeddings() {
        let core = make_bm25_core();
        let tools = vec![
            Tool { name: "refund".into(), description: "Process a refund".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
        ];
        core.register_tools("ds", tools).await.unwrap();

        // Request semantic but no embedding service → should fallback to BM25
        let resp = core.discover("ds", DiscoverRequest {
            query: "refund".into(),
            limit: Some(5),
            strategy: SearchStrategy::Semantic,
            embedding_weights: None,
            exclude: None,
            turn_id: None,
            namespace: None,
            session: None,
        }).await.unwrap();

        assert!(!resp.tools.is_empty());
        assert_eq!(resp.tools[0].tool.name, "refund");
    }

    #[tokio::test]
    async fn discover_bm25_skips_embedding_call() {
        let fake = Arc::new(FakeEmbedding::new());
        let storage = Arc::new(SqliteStorage::new(":memory:").unwrap());
        let core = AgentifiedCore::new(fake.clone() as Arc<dyn EmbeddingService>, storage);

        let tools = vec![
            Tool { name: "refund".into(), description: "Process a refund".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
        ];
        core.register_tools("ds", tools).await.unwrap();

        let batch_before = fake.batch_call_count.load(std::sync::atomic::Ordering::Relaxed);
        let call_before = fake.call_count.load(std::sync::atomic::Ordering::Relaxed);

        let _resp = core.discover("ds", DiscoverRequest {
            query: "refund".into(),
            limit: Some(5),
            strategy: SearchStrategy::Bm25,
            embedding_weights: None,
            exclude: None,
            turn_id: None,
            namespace: None,
            session: None,
        }).await.unwrap();

        // No new embedding calls should have been made for the query
        let batch_after = fake.batch_call_count.load(std::sync::atomic::Ordering::Relaxed);
        let call_after = fake.call_count.load(std::sync::atomic::Ordering::Relaxed);
        assert_eq!(batch_before, batch_after, "BM25 strategy should not call embed_batch");
        assert_eq!(call_before, call_after, "BM25 strategy should not call embed");
    }

    #[tokio::test]
    async fn discover_hybrid_blends_semantic_and_bm25() {
        let core = make_core();
        let tools = vec![
            Tool { name: "refund".into(), description: "Process a refund".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
            Tool { name: "getUser".into(), description: "Get user details".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
        ];
        core.register_tools("ds", tools).await.unwrap();

        let resp = core.discover("ds", DiscoverRequest {
            query: "refund".into(),
            limit: Some(5),
            strategy: SearchStrategy::Hybrid,
            embedding_weights: None,
            exclude: None,
            turn_id: None,
            namespace: None,
            session: None,
        }).await.unwrap();

        assert!(!resp.tools.is_empty());
        // Scores should be in [0, 1] range (blend of semantic + bm25)
        for tool in &resp.tools {
            assert!(tool.score >= 0.0 && tool.score <= 1.0, "score out of range: {}", tool.score);
        }
    }

    #[tokio::test]
    async fn discover_default_strategy_is_bm25() {
        // Default DiscoverRequest (no strategy field) should use BM25
        let req: DiscoverRequest = serde_json::from_str(r#"{"query": "test"}"#).unwrap();
        assert_eq!(req.strategy, SearchStrategy::Bm25);
    }

    #[tokio::test]
    async fn discover_excludes_always_include_tools() {
        let core = make_bm25_core();
        let tools = vec![
            Tool { name: "escalate".into(), description: "Escalate to human agent".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: true },
            Tool { name: "get_employee".into(), description: "Get employee details".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
            Tool { name: "update_employee".into(), description: "Update employee record".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
        ];
        core.register_tools("ds", tools).await.unwrap();

        let resp = core.discover("ds", DiscoverRequest {
            query: "employee".into(),
            limit: Some(10),
            strategy: SearchStrategy::Bm25,
            embedding_weights: None,
            exclude: None,
            turn_id: None,
            namespace: None,
            session: None,
        }).await.unwrap();

        let names: Vec<&str> = resp.tools.iter().map(|t| t.tool.name.as_str()).collect();
        assert!(!names.contains(&"escalate"), "alwaysInclude tool should be excluded from discover results");
        assert!(names.contains(&"get_employee"));
        assert!(names.contains(&"update_employee"));
    }

    #[tokio::test]
    async fn discover_with_session_persists_tools_across_calls() {
        let core = make_bm25_core();
        let tools = vec![
            Tool { name: "get_employee".into(), description: "Get employee details".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
            Tool { name: "update_employee".into(), description: "Update employee record".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
            Tool { name: "delete_employee".into(), description: "Delete employee from system".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
        ];
        core.register_tools("ds", tools).await.unwrap();

        // Turn 1: discover with session — should find get_employee
        let resp1 = core.discover("ds", DiscoverRequest {
            query: "get employee".into(),
            limit: Some(1),
            strategy: SearchStrategy::Bm25,
            embedding_weights: None,
            exclude: None,
            turn_id: None,
            namespace: Some("ns".into()),
            session: Some("sess1".into()),
        }).await.unwrap();
        assert_eq!(resp1.tools.len(), 1);
        assert_eq!(resp1.tools[0].tool.name, "get_employee");

        // Turn 2: discover with same session — get_employee should be excluded (already persisted)
        let resp2 = core.discover("ds", DiscoverRequest {
            query: "employee".into(),
            limit: Some(5),
            strategy: SearchStrategy::Bm25,
            embedding_weights: None,
            exclude: None,
            turn_id: None,
            namespace: Some("ns".into()),
            session: Some("sess1".into()),
        }).await.unwrap();
        let names: Vec<&str> = resp2.tools.iter().map(|t| t.tool.name.as_str()).collect();
        assert!(!names.contains(&"get_employee"), "previously discovered tool should be excluded");
        assert!(names.contains(&"update_employee") || names.contains(&"delete_employee"));
    }

    #[tokio::test]
    async fn discover_without_session_does_not_persist() {
        let core = make_bm25_core();
        let tools = vec![
            Tool { name: "get_employee".into(), description: "Get employee details".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
            Tool { name: "update_employee".into(), description: "Update employee record".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
        ];
        core.register_tools("ds", tools).await.unwrap();

        // Discover without session
        core.discover("ds", DiscoverRequest {
            query: "get employee".into(),
            limit: Some(1),
            strategy: SearchStrategy::Bm25,
            embedding_weights: None,
            exclude: None,
            turn_id: None,
            namespace: None,
            session: None,
        }).await.unwrap();

        // Second discover without session — should still return get_employee (not persisted)
        let resp2 = core.discover("ds", DiscoverRequest {
            query: "get employee".into(),
            limit: Some(1),
            strategy: SearchStrategy::Bm25,
            embedding_weights: None,
            exclude: None,
            turn_id: None,
            namespace: None,
            session: None,
        }).await.unwrap();
        assert_eq!(resp2.tools[0].tool.name, "get_employee");
    }

    #[tokio::test]
    async fn discover_session_tools_loaded_via_recall() {
        let core = make_bm25_core();
        let tools = vec![
            Tool { name: "get_employee".into(), description: "Get employee details".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
            Tool { name: "update_employee".into(), description: "Update employee record".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
        ];
        core.register_tools("ds", tools).await.unwrap();

        // Discover with session to persist get_employee
        core.discover("ds", DiscoverRequest {
            query: "get employee".into(),
            limit: Some(1),
            strategy: SearchStrategy::Bm25,
            embedding_weights: None,
            exclude: None,
            turn_id: None,
            namespace: Some("ns".into()),
            session: Some("sess1".into()),
        }).await.unwrap();

        // Wait briefly for async session save
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Now add a user message and call getContext with recall — should load get_employee at score 1.0
        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(),
            namespace: "ns".into(),
            session: "sess1".into(),
            messages: vec![models::MessageInput {
                role: "user".into(),
                content: "update employee salary".into(),
                tool_call_id: None,
                tool_calls: None,
            }],
        }).await.unwrap();

        let ctx = core.get_context(models::ContextRequest {
            dataset: "ds".into(),
            namespace: "ns".into(),
            session: "sess1".into(),
            messages: models::ContextMessagesConfig {
                strategy: "recent".into(),
                max_tokens: 4000,
                ..Default::default()
            },
            recall: Some(models::RecallConfig {
                tools: Some(models::RecallToolsOption::Bool(true)),
            }),
            limit_tokens: None,
        }).await.unwrap();

        let recalled_names: Vec<&str> = ctx.recalled.tools.iter().map(|t| t.tool.name.as_str()).collect();
        assert!(recalled_names.contains(&"get_employee"), "previously discovered tool should be recalled at score 1.0");
    }

    #[tokio::test]
    async fn recall_excludes_always_include_tools() {
        let core = make_bm25_core();
        let tools = vec![
            Tool { name: "escalate".into(), description: "Escalate to human agent".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: true },
            Tool { name: "get_employee".into(), description: "Get employee details".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
            Tool { name: "update_employee".into(), description: "Update employee record".into(), parameters: serde_json::json!({}), metadata: None, fields: None, always_include: false },
        ];
        core.register_tools("ds", tools).await.unwrap();

        core.append_messages(models::AppendMessagesRequest {
            dataset: "ds".into(),
            namespace: "ns".into(),
            session: "sess".into(),
            messages: vec![models::MessageInput {
                role: "user".into(),
                content: "Tell me about employee escalation".into(),
                tool_call_id: None,
                tool_calls: None,
            }],
        }).await.unwrap();

        let resp = core.get_context(models::ContextRequest {
            dataset: "ds".into(),
            namespace: "ns".into(),
            session: "sess".into(),
            messages: models::ContextMessagesConfig {
                strategy: "recent".into(),
                max_tokens: 4000,
                ..Default::default()
            },
            recall: Some(models::RecallConfig {
                tools: Some(models::RecallToolsOption::Bool(true)),
            }),
            limit_tokens: None,
        }).await.unwrap();

        let tool_names: Vec<&str> = resp.recalled.tools.iter().map(|t| t.tool.name.as_str()).collect();
        assert!(!tool_names.contains(&"escalate"), "alwaysInclude tool should be excluded from recall results");
    }

    #[test]
    fn extract_arg_text_from_schema_properties() {
        let params = serde_json::json!({
            "type": "object",
            "properties": {
                "employee_id": {
                    "type": "string",
                    "description": "The employee's unique identifier"
                },
                "salary": {
                    "type": "number",
                    "description": "Annual salary amount"
                }
            }
        });
        let text = extract_arg_text(&params);
        assert!(text.contains("employee_id"));
        assert!(text.contains("The employee's unique identifier"));
        assert!(text.contains("salary"));
        assert!(text.contains("Annual salary amount"));
        // Should NOT contain JSON structural tokens
        assert!(!text.contains("{"));
        assert!(!text.contains("}"));
        assert!(!text.contains("\"type\""));
        assert!(!text.contains("\"object\""));
    }

    #[test]
    fn extract_arg_text_no_properties() {
        let params = serde_json::json!({});
        let text = extract_arg_text(&params);
        assert!(text.is_empty());
    }

    #[test]
    fn extract_arg_text_property_without_description() {
        let params = serde_json::json!({
            "type": "object",
            "properties": {
                "id": { "type": "string" }
            }
        });
        let text = extract_arg_text(&params);
        assert_eq!(text, "id");
    }

    #[tokio::test]
    async fn bm25_text_uses_arg_names_not_raw_json() {
        let core = make_bm25_core();
        let tools = vec![
            Tool {
                name: "get_employee".into(),
                description: "Retrieve employee details".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "employee_id": {
                            "type": "string",
                            "description": "The employee's unique identifier"
                        }
                    }
                }),
                metadata: None,
                fields: None,
                always_include: false,
            },
        ];
        core.register_tools("ds", tools).await.unwrap();

        let tools_map = core.tools.read().await;
        let stored = tools_map.get("ds").unwrap().get("get_employee").unwrap();
        assert!(stored.bm25_text.contains("employee_id"));
        assert!(stored.bm25_text.contains("The employee's unique identifier"));
        assert!(!stored.bm25_text.contains("{"));
        assert!(!stored.bm25_text.contains("\"type\""));
    }

}
