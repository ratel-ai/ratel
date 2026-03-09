pub mod embedding;
pub mod models;
pub mod ranking;
pub mod storage;

pub use embedding::{EmbeddingService, OpenAIEmbedding};
pub use storage::{NoopStorage, SqliteStorage, Storage};

#[cfg(any(test, feature = "test-utils"))]
pub use embedding::{FakeEmbedding, FailingEmbedding};

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use models::{
    CaptureTurnRequest, CaptureTurnResponse, CreateInstanceResponse, DiscoverRequest,
    DiscoverResponse, FieldEmbeddings, Instance, ListToolsResponse, RankedTool,
    RegisterToolsResponse, StoredTool, Tool, Turn,
};
use ranking::{bm25_scores, weighted_semantic_score};

// Error types

#[derive(Debug)]
pub enum CoreError {
    EmbeddingFailed(anyhow::Error),
    NotFound(String),
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CoreError::EmbeddingFailed(e) => write!(f, "embedding failed: {e}"),
            CoreError::NotFound(msg) => write!(f, "{msg}"),
        }
    }
}

// AgentifiedCore

pub struct AgentifiedCore {
    tools: RwLock<HashMap<String, StoredTool>>,
    turns: RwLock<HashMap<String, Turn>>,
    embedding_cache: RwLock<HashMap<String, Vec<f32>>>,
    embedding: Arc<dyn EmbeddingService>,
    storage: Arc<dyn Storage>,
}

impl AgentifiedCore {
    pub fn new(embedding: Arc<dyn EmbeddingService>, storage: Arc<dyn Storage>) -> Self {
        let tools_map = storage.load_all_tools().unwrap_or_default().into_iter().collect();
        let turns_map = storage.load_all_turns().unwrap_or_default().into_iter().collect();
        let cache_map = storage.load_all_embeddings().unwrap_or_default().into_iter().collect();

        Self {
            tools: RwLock::new(tools_map),
            turns: RwLock::new(turns_map),
            embedding_cache: RwLock::new(cache_map),
            embedding,
            storage,
        }
    }

    pub async fn register_tools(&self, tools: Vec<Tool>) -> Result<RegisterToolsResponse, CoreError> {
        let count = tools.len();

        struct ToolTexts {
            name: String,
            description: String,
            input_schema: Option<String>,
            output_schema: Option<String>,
        }

        let mut all_tool_texts = Vec::with_capacity(count);
        let mut unique_texts = Vec::new();

        {
            let cache = self.embedding_cache.read().await;
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

                for text in [Some(&texts.name), Some(&texts.description), texts.input_schema.as_ref(), texts.output_schema.as_ref()].into_iter().flatten() {
                    if !cache.contains_key(text) && !unique_texts.contains(text) {
                        unique_texts.push(text.clone());
                    }
                }

                all_tool_texts.push(texts);
            }
        }

        if !unique_texts.is_empty() {
            let embeddings = self.embedding.embed_batch(&unique_texts).await.map_err(CoreError::EmbeddingFailed)?;
            let mut cache = self.embedding_cache.write().await;
            for (text, emb) in unique_texts.into_iter().zip(embeddings) {
                cache.insert(text, emb);
            }
        }

        let cache = self.embedding_cache.read().await;
        let mut tool_data = Vec::with_capacity(count);
        for texts in &all_tool_texts {
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

            let bm25_text = [
                Some(texts.name.clone()),
                Some(texts.description.clone()),
                texts.input_schema.clone(),
                texts.output_schema.clone(),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");

            tool_data.push((
                FieldEmbeddings {
                    name: name_emb,
                    description: desc_emb,
                    input_schema: input_emb,
                    output_schema: output_emb,
                },
                bm25_text,
            ));
        }
        drop(cache);

        let mut tools_map = self.tools.write().await;
        for (tool, (embeddings, bm25_text)) in tools.into_iter().zip(tool_data) {
            tools_map.insert(tool.name.clone(), StoredTool { tool, embeddings, bm25_text });
        }

        // Write-through to storage
        {
            let storage = self.storage.clone();
            let tool_pairs: Vec<(String, StoredTool)> = tools_map.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            let cache = self.embedding_cache.read().await;
            let emb_pairs: Vec<(String, Vec<f32>)> = cache.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            drop(cache);
            tokio::task::spawn_blocking(move || {
                let refs: Vec<(&str, &StoredTool)> = tool_pairs.iter().map(|(k, v)| (k.as_str(), v)).collect();
                if let Err(e) = storage.save_tools(&refs) {
                    tracing::error!("storage save_tools failed: {e}");
                }
                let emb_refs: Vec<(&str, &[f32])> = emb_pairs.iter().map(|(k, v)| (k.as_str(), v.as_slice())).collect();
                if let Err(e) = storage.save_embeddings(&emb_refs) {
                    tracing::error!("storage save_embeddings failed: {e}");
                }
            });
        }

        Ok(RegisterToolsResponse { registered: count })
    }

    pub async fn list_tools(&self) -> ListToolsResponse {
        let tools = self.tools.read().await;
        let tool_list = tools.values().map(|st| st.tool.clone()).collect();
        ListToolsResponse { tools: tool_list }
    }

    pub async fn discover(&self, body: DiscoverRequest) -> Result<DiscoverResponse, CoreError> {
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

        let query_embedding = self.embed_cached(&body.query).await.map_err(CoreError::EmbeddingFailed)?;

        let tools = self.tools.read().await;
        if tools.is_empty() {
            return Ok(DiscoverResponse { tools: vec![] });
        }

        let mut base_tools: Vec<RankedTool> = base_tool_names.iter()
            .filter_map(|name| tools.get(name))
            .map(|st| RankedTool { tool: st.tool.clone(), score: 1.0, graph_expanded: None })
            .collect();

        let weights = body.embedding_weights.unwrap_or_default();
        let mut exclude = body.exclude.unwrap_or_default();
        exclude.extend(base_tool_names);

        let stored: Vec<&StoredTool> = tools
            .values()
            .filter(|t| !exclude.contains(&t.tool.name))
            .collect();

        if stored.is_empty() && !base_tools.is_empty() {
            return Ok(DiscoverResponse { tools: base_tools });
        }

        let semantic_scores: Vec<f32> = stored
            .iter()
            .map(|t| weighted_semantic_score(&query_embedding, &t.embeddings, &weights))
            .collect();

        let documents: Vec<String> = stored.iter().map(|t| t.bm25_text.clone()).collect();
        let raw_bm25 = bm25_scores(&body.query, &documents);

        let bm25_max = raw_bm25.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let bm25_min = raw_bm25.iter().cloned().fold(f32::INFINITY, f32::min);
        let bm25_range = bm25_max - bm25_min;
        let norm_bm25: Vec<f32> = raw_bm25
            .iter()
            .map(|s| if bm25_range > 0.0 { (s - bm25_min) / bm25_range } else { 0.0 })
            .collect();

        let mut ranked: Vec<RankedTool> = stored
            .iter()
            .enumerate()
            .map(|(i, t)| RankedTool {
                tool: t.tool.clone(),
                score: 0.7 * semantic_scores[i] + 0.3 * norm_bm25[i],
                graph_expanded: None,
            })
            .collect();

        ranked.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        ranked.truncate(limit);

        let ranked = expand_with_providers(ranked, &tools, limit);

        base_tools.extend(ranked);

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

    pub async fn create_instance(&self, dataset: &str) -> Result<CreateInstanceResponse, CoreError> {
        let instance_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let instance = Instance {
            instance_id: instance_id.clone(),
            dataset_id: dataset.to_string(),
            created_at: now.clone(),
            last_heartbeat: now,
        };

        let storage = self.storage.clone();
        let inst = instance.clone();
        tokio::task::spawn_blocking(move || {
            if let Err(e) = storage.save_instance(&inst) {
                tracing::error!("storage save_instance failed: {e}");
            }
        }).await.map_err(|e| CoreError::EmbeddingFailed(anyhow::anyhow!("spawn failed: {e}")))?;

        Ok(CreateInstanceResponse { instance_id })
    }

    pub async fn heartbeat_instance(&self, instance_id: &str) -> Result<(), CoreError> {
        let now = chrono::Utc::now().to_rfc3339();
        let storage = self.storage.clone();
        let id = instance_id.to_string();
        let updated = tokio::task::spawn_blocking(move || {
            storage.update_heartbeat(&id, &now)
        }).await.map_err(|e| CoreError::EmbeddingFailed(anyhow::anyhow!("spawn failed: {e}")))?
          .map_err(|e| CoreError::EmbeddingFailed(e))?;

        if !updated {
            return Err(CoreError::NotFound(format!("instance not found: {instance_id}")));
        }
        Ok(())
    }

    pub async fn delete_instance(&self, instance_id: &str) -> Result<(), CoreError> {
        let storage = self.storage.clone();
        let id = instance_id.to_string();
        let deleted = tokio::task::spawn_blocking(move || {
            storage.delete_instance(&id)
        }).await.map_err(|e| CoreError::EmbeddingFailed(anyhow::anyhow!("spawn failed: {e}")))?
          .map_err(|e| CoreError::EmbeddingFailed(e))?;

        if !deleted {
            return Err(CoreError::NotFound(format!("instance not found: {instance_id}")));
        }
        Ok(())
    }

    async fn embed_cached(&self, text: &str) -> anyhow::Result<Vec<f32>> {
        let cached = { self.embedding_cache.read().await.get(text).cloned() };
        if let Some(emb) = cached {
            return Ok(emb);
        }
        let emb = self.embedding.embed(text).await?;
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
