mod embedding;
mod models;
mod ranking;

use std::collections::HashMap;
use std::sync::Arc;

use axum::{extract::State, http::StatusCode, routing::{get, post}, Json, Router};
use serde::Serialize;
use tokio::sync::RwLock;

pub use embedding::{EmbeddingService, OpenAIEmbedding};

use models::{
    CaptureTurnRequest, CaptureTurnResponse, DiscoverRequest, DiscoverResponse, ErrorResponse,
    FieldEmbeddings, ListToolsResponse, RankedTool, RegisterToolsRequest, RegisterToolsResponse,
    StoredTool, Turn,
};
use ranking::{bm25_scores, weighted_semantic_score};

// Types

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

pub struct AppState {
    tools: RwLock<HashMap<String, StoredTool>>,
    turns: RwLock<HashMap<String, Turn>>,
    embedding_cache: RwLock<HashMap<String, Vec<f32>>>,
    embedding: Arc<dyn EmbeddingService>,
}

// Public API

pub fn app(embedding: Arc<dyn EmbeddingService>) -> Router {
    let state = Arc::new(AppState {
        tools: RwLock::new(HashMap::new()),
        turns: RwLock::new(HashMap::new()),
        embedding_cache: RwLock::new(HashMap::new()),
        embedding,
    });

    Router::new()
        .route("/health", get(health))
        .route("/api/v1/tools", post(register_tools).get(list_tools))
        .route("/api/v1/discover", post(discover))
        .route("/api/v1/turns", post(capture_turn))
        .with_state(state)
}

// Handlers

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn register_tools(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RegisterToolsRequest>,
) -> Result<(StatusCode, Json<RegisterToolsResponse>), (StatusCode, Json<ErrorResponse>)> {
    let count = body.tools.len();

    // 1. Collect all texts per tool and gather unique uncached texts
    struct ToolTexts {
        name: String,
        description: String,
        input_schema: Option<String>,
        output_schema: Option<String>,
    }

    let mut all_tool_texts = Vec::with_capacity(count);
    let mut unique_texts = Vec::new();

    {
        let cache = state.embedding_cache.read().await;
        for tool in &body.tools {
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

            // Collect uncached texts (deduped)
            for text in [Some(&texts.name), Some(&texts.description), texts.input_schema.as_ref(), texts.output_schema.as_ref()].into_iter().flatten() {
                if !cache.contains_key(text) && !unique_texts.contains(text) {
                    unique_texts.push(text.clone());
                }
            }

            all_tool_texts.push(texts);
        }
    }

    // 2. Batch-embed all uncached texts in a single API call
    if !unique_texts.is_empty() {
        let embeddings = state.embedding.embed_batch(&unique_texts).await.map_err(embed_err)?;
        let mut cache = state.embedding_cache.write().await;
        for (text, emb) in unique_texts.into_iter().zip(embeddings) {
            cache.insert(text, emb);
        }
    }

    // 3. Build FieldEmbeddings from cache
    let cache = state.embedding_cache.read().await;
    let mut tool_data = Vec::with_capacity(count);
    for texts in &all_tool_texts {
        let name_emb = cache.get(&texts.name).cloned()
            .ok_or_else(|| embed_err(anyhow::anyhow!("missing cached embedding for name")))?;
        let desc_emb = cache.get(&texts.description).cloned()
            .ok_or_else(|| embed_err(anyhow::anyhow!("missing cached embedding for description")))?;
        let input_emb = texts.input_schema.as_ref().map(|t| {
            cache.get(t).cloned()
                .ok_or_else(|| embed_err(anyhow::anyhow!("missing cached embedding for input_schema")))
        }).transpose()?;
        let output_emb = texts.output_schema.as_ref().map(|t| {
            cache.get(t).cloned()
                .ok_or_else(|| embed_err(anyhow::anyhow!("missing cached embedding for output_schema")))
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

    // 4. Batch insert with write lock
    let mut tools = state.tools.write().await;
    for (tool, (embeddings, bm25_text)) in body.tools.into_iter().zip(tool_data) {
        tools.insert(tool.name.clone(), StoredTool { tool, embeddings, bm25_text });
    }

    Ok((StatusCode::CREATED, Json(RegisterToolsResponse { registered: count })))
}

async fn list_tools(State(state): State<Arc<AppState>>) -> Json<ListToolsResponse> {
    let tools = state.tools.read().await;
    let tool_list = tools.values().map(|st| st.tool.clone()).collect();
    Json(ListToolsResponse { tools: tool_list })
}

async fn discover(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DiscoverRequest>,
) -> Result<Json<DiscoverResponse>, (StatusCode, Json<ErrorResponse>)> {
    let limit = body.limit.unwrap_or(5).min(100);

    // If turn_id present, load turn and prepend base tools
    let base_tool_names: Vec<String> = if let Some(ref turn_id) = body.turn_id {
        let turns = state.turns.read().await;
        let turn = turns.get(turn_id).ok_or_else(|| {
            (StatusCode::NOT_FOUND, Json(ErrorResponse { error: format!("turn not found: {turn_id}") }))
        })?;
        turn.tools_loaded.clone()
    } else {
        vec![]
    };

    // Compute query embedding before acquiring tools lock
    let query_embedding = embed_cached(&state, &body.query).await.map_err(embed_err)?;

    let tools = state.tools.read().await;
    if tools.is_empty() {
        return Ok(Json(DiscoverResponse { tools: vec![] }));
    }

    // Build base tools from turn (score=1.0, no graph_expanded)
    let mut base_tools: Vec<RankedTool> = base_tool_names.iter()
        .filter_map(|name| tools.get(name))
        .map(|st| RankedTool { tool: st.tool.clone(), score: 1.0, graph_expanded: None })
        .collect();

    let weights = body.embedding_weights.unwrap_or_default();
    let mut exclude = body.exclude.unwrap_or_default();
    // Exclude base tools from semantic+BM25 ranking
    exclude.extend(base_tool_names);

    let stored: Vec<&StoredTool> = tools
        .values()
        .filter(|t| !exclude.contains(&t.tool.name))
        .collect();

    if stored.is_empty() && !base_tools.is_empty() {
        return Ok(Json(DiscoverResponse { tools: base_tools }));
    }

    // Semantic scores (weighted multi-field)
    let semantic_scores: Vec<f32> = stored
        .iter()
        .map(|t| weighted_semantic_score(&query_embedding, &t.embeddings, &weights))
        .collect();

    // BM25 scores
    let documents: Vec<String> = stored.iter().map(|t| t.bm25_text.clone()).collect();
    let raw_bm25 = bm25_scores(&body.query, &documents);

    // Normalize BM25 to [0, 1]
    let bm25_max = raw_bm25.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let bm25_min = raw_bm25.iter().cloned().fold(f32::INFINITY, f32::min);
    let bm25_range = bm25_max - bm25_min;
    let norm_bm25: Vec<f32> = raw_bm25
        .iter()
        .map(|s| if bm25_range > 0.0 { (s - bm25_min) / bm25_range } else { 0.0 })
        .collect();

    // Hybrid scoring: 0.7 * semantic + 0.3 * bm25
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

    // Graph-expand only additional tools (not base tools)
    let ranked = expand_with_providers(ranked, &tools, limit);

    // Prepend base tools
    base_tools.extend(ranked);

    Ok(Json(DiscoverResponse { tools: base_tools }))
}

async fn capture_turn(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CaptureTurnRequest>,
) -> (StatusCode, Json<CaptureTurnResponse>) {
    let turn_id = uuid::Uuid::new_v4().to_string();
    let turn = Turn {
        tools_loaded: body.tools_loaded,
        message: body.message,
    };
    state.turns.write().await.insert(turn_id.clone(), turn);
    (StatusCode::CREATED, Json(CaptureTurnResponse { turn_id }))
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
    // Collect required params from ranked tools
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

    // Build provides index from all tools
    let mut providers: Vec<(String, usize, &StoredTool)> = Vec::new(); // (name, coverage_count, tool)
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

    // Sort by coverage (most params provided first)
    providers.sort_by(|a, b| b.1.cmp(&a.1));

    // Append up to ceil(limit * 0.6) extra provider slots
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

async fn embed_cached(state: &AppState, text: &str) -> anyhow::Result<Vec<f32>> {
    let cached = { state.embedding_cache.read().await.get(text).cloned() };
    if let Some(emb) = cached {
        return Ok(emb);
    }
    let emb = state.embedding.embed(text).await?;
    state.embedding_cache.write().await.insert(text.to_string(), emb.clone());
    Ok(emb)
}

fn embed_err(e: anyhow::Error) -> (StatusCode, Json<ErrorResponse>) {
    (StatusCode::BAD_GATEWAY, Json(ErrorResponse { error: format!("embedding failed: {e}") }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use embedding::{FailingEmbedding, FakeEmbedding};
    use tower::ServiceExt;

    fn test_app() -> Router {
        app(Arc::new(FakeEmbedding::new()))
    }

    #[tokio::test]
    async fn health_returns_ok() {
        let response = test_app()
            .oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json, serde_json::json!({"status": "ok"}));
    }

    #[tokio::test]
    async fn register_tools_returns_created() {
        let body = serde_json::json!({
            "tools": [{
                "name": "getAccountInfo",
                "description": "Get customer account details",
                "parameters": { "type": "object", "properties": {} }
            }]
        });

        let response = test_app()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/tools")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
    }

    #[tokio::test]
    async fn list_tools_returns_registered_tools() {
        let app = test_app();

        let body = serde_json::json!({
            "tools": [{
                "name": "getAccountInfo",
                "description": "Get customer account details",
                "parameters": { "type": "object", "properties": {} }
            }]
        });

        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/tools")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        let response = app
            .oneshot(Request::builder().uri("/api/v1/tools").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["tools"].as_array().unwrap().len(), 1);
        assert_eq!(json["tools"][0]["name"], "getAccountInfo");
    }

    #[tokio::test]
    async fn embedding_cached_for_same_content() {
        let embedding = Arc::new(FakeEmbedding::new());
        let app = app(embedding.clone() as Arc<dyn EmbeddingService>);

        let body = serde_json::json!({
            "tools": [{
                "name": "getAccountInfo",
                "description": "Get customer account details",
                "parameters": {}
            }]
        });

        let json_str = serde_json::to_string(&body).unwrap();

        for _ in 0..2 {
            app.clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/v1/tools")
                        .header("content-type", "application/json")
                        .body(Body::from(json_str.clone()))
                        .unwrap(),
                )
                .await
                .unwrap();
        }

        // 2 fields (name + description) embedded once each, cached on second call
        assert_eq!(
            embedding.call_count.load(std::sync::atomic::Ordering::SeqCst),
            2
        );
    }

    #[tokio::test]
    async fn discover_ranks_matching_tool_first() {
        let app = test_app();

        let register = serde_json::json!({
            "tools": [
                {
                    "name": "processRefund",
                    "description": "Process a refund for a specific invoice",
                    "parameters": {}
                },
                {
                    "name": "getAccountInfo",
                    "description": "Get customer account details including name and email",
                    "parameters": {}
                }
            ]
        });

        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/tools")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&register).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        let query = serde_json::json!({ "query": "I want a refund", "limit": 5 });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/discover")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&query).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let tools = json["tools"].as_array().unwrap();

        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["name"], "processRefund");
        assert!(tools[0]["score"].as_f64().unwrap() > tools[1]["score"].as_f64().unwrap());
    }

    #[tokio::test]
    async fn register_tools_returns_error_on_embedding_failure() {
        let app = app(Arc::new(FailingEmbedding));

        let body = serde_json::json!({
            "tools": [{"name": "t", "description": "d", "parameters": {}}]
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/tools")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["error"].as_str().unwrap().contains("embedding"));
    }

    #[tokio::test]
    async fn discover_returns_error_on_embedding_failure() {
        let fake = FakeEmbedding::new();
        let name_emb = fake.embed("test").await.unwrap();
        let desc_emb = fake.embed("test desc").await.unwrap();

        let mut tools_map = HashMap::new();
        tools_map.insert(
            "test".to_string(),
            StoredTool {
                tool: models::Tool {
                    name: "test".to_string(),
                    description: "test desc".to_string(),
                    parameters: serde_json::Value::Null,
                    metadata: None,
                    fields: None,
                },
                embeddings: FieldEmbeddings {
                    name: name_emb,
                    description: desc_emb,
                    input_schema: None,
                    output_schema: None,
                },
                bm25_text: "test test desc".to_string(),
            },
        );

        let state = Arc::new(AppState {
            tools: RwLock::new(tools_map),
            turns: RwLock::new(HashMap::new()),
            embedding_cache: RwLock::new(HashMap::new()),
            embedding: Arc::new(FailingEmbedding),
        });

        let app = Router::new()
            .route("/api/v1/discover", post(discover))
            .with_state(state);

        let query = serde_json::json!({ "query": "anything" });
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/discover")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&query).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["error"].as_str().unwrap().contains("embedding"));
    }

    #[tokio::test]
    async fn discover_limit_capped() {
        let app = test_app();

        let reg = serde_json::json!({
            "tools": [{"name": "t", "description": "d", "parameters": {}}]
        });
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/tools")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&reg).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        let query = serde_json::json!({ "query": "test", "limit": 500 });
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/discover")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&query).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["tools"].as_array().unwrap().len() <= 100);
    }

    #[tokio::test]
    async fn register_with_multi_field_embeddings() {
        let app = test_app();

        let body = serde_json::json!({
            "tools": [{
                "name": "getAccountInfo",
                "description": "Get customer account details",
                "parameters": {},
                "fields": {
                    "name": "getAccountInfo",
                    "description": "Get customer account details including name and email",
                    "input_schema": "{ accountId: string }",
                    "output_schema": "{ name: string, email: string }"
                }
            }]
        });

        let response = app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/tools")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);

        // List and verify tool is stored
        let response = app
            .oneshot(Request::builder().uri("/api/v1/tools").body(Body::empty()).unwrap())
            .await
            .unwrap();

        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["tools"].as_array().unwrap().len(), 1);
        assert_eq!(json["tools"][0]["name"], "getAccountInfo");
        // Verify fields are stored
        assert!(json["tools"][0]["fields"].is_object());
        assert_eq!(json["tools"][0]["fields"]["input_schema"], "{ accountId: string }");
    }

    #[tokio::test]
    async fn register_backward_compat_no_fields() {
        let app = test_app();

        // Register without fields — should still work (backward compat)
        let body = serde_json::json!({
            "tools": [{
                "name": "processRefund",
                "description": "Process a refund",
                "parameters": {}
            }]
        });

        let response = app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/tools")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);

        // Discover should still work
        let query = serde_json::json!({ "query": "refund" });
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/discover")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&query).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["tools"].as_array().unwrap().len(), 1);
        assert_eq!(json["tools"][0]["name"], "processRefund");
    }

    #[tokio::test]
    async fn discover_with_multi_field_weights() {
        let app = test_app();

        // Register two tools with distinct field content
        let reg = serde_json::json!({
            "tools": [
                {
                    "name": "processRefund",
                    "description": "Process a refund for a specific invoice",
                    "parameters": {},
                    "fields": {
                        "name": "processRefund",
                        "description": "Process a refund for a specific invoice",
                        "input_schema": "{ invoiceId: string, amount: number }",
                        "output_schema": "{ success: boolean, refundId: string }"
                    }
                },
                {
                    "name": "getAccountInfo",
                    "description": "Get customer account details including name and email",
                    "parameters": {},
                    "fields": {
                        "name": "getAccountInfo",
                        "description": "Get customer account details including name and email",
                        "input_schema": "{ accountId: string }",
                        "output_schema": "{ name: string, email: string, plan: string }"
                    }
                }
            ]
        });

        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/tools")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&reg).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        // Discover with refund query
        let query = serde_json::json!({ "query": "I need a refund on my invoice", "limit": 5 });
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/discover")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&query).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let tools = json["tools"].as_array().unwrap();
        assert_eq!(tools[0]["name"], "processRefund");
    }

    #[tokio::test]
    async fn discover_with_exclude_filters_out_named_tools() {
        let app = test_app();

        let reg = serde_json::json!({
            "tools": [
                { "name": "serverTool", "description": "A server-side tool", "parameters": {} },
                { "name": "frontendTool", "description": "A frontend tool", "parameters": {} },
                { "name": "anotherServer", "description": "Another server tool", "parameters": {} }
            ]
        });

        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/tools")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&reg).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        let query = serde_json::json!({
            "query": "tool",
            "limit": 10,
            "exclude": ["frontendTool"]
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/discover")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&query).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let tools = json["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 2);
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(!names.contains(&"frontendTool"));
    }

    #[tokio::test]
    async fn discover_with_empty_exclude_returns_all() {
        let app = test_app();

        let reg = serde_json::json!({
            "tools": [
                { "name": "tool1", "description": "First tool", "parameters": {} },
                { "name": "tool2", "description": "Second tool", "parameters": {} }
            ]
        });

        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/tools")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&reg).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        let query = serde_json::json!({ "query": "tool", "exclude": [] });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/discover")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&query).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["tools"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn register_tools_uses_batch_embedding() {
        let embedding = Arc::new(FakeEmbedding::new());
        let app = app(embedding.clone() as Arc<dyn EmbeddingService>);

        let body = serde_json::json!({
            "tools": [
                { "name": "tool1", "description": "desc1", "parameters": {} },
                { "name": "tool2", "description": "desc2", "parameters": {} },
                { "name": "tool3", "description": "desc3", "parameters": {} }
            ]
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/tools")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);

        // Should use embed_batch (at least one batch call)
        assert!(
            embedding.batch_call_count.load(std::sync::atomic::Ordering::SeqCst) >= 1,
            "register_tools should use embed_batch"
        );
    }

    #[tokio::test]
    async fn discover_with_custom_weights() {
        let app = test_app();

        let reg = serde_json::json!({
            "tools": [
                {
                    "name": "processRefund",
                    "description": "Process a refund for a specific invoice",
                    "parameters": {},
                    "fields": {
                        "name": "processRefund",
                        "description": "Process a refund for a specific invoice"
                    }
                },
                {
                    "name": "getAccountInfo",
                    "description": "Get customer account details",
                    "parameters": {},
                    "fields": {
                        "name": "getAccountInfo",
                        "description": "Get customer account details"
                    }
                }
            ]
        });

        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/tools")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&reg).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        // Discover with custom weights (high name weight)
        let query = serde_json::json!({
            "query": "refund",
            "limit": 5,
            "embedding_weights": {
                "name": 0.8,
                "description": 0.2,
                "input_schema": 0.0,
                "output_schema": 0.0
            }
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/discover")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&query).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let tools = json["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 2);
        // processRefund name matches "refund" better
        assert_eq!(tools[0]["name"], "processRefund");
    }

    #[tokio::test]
    async fn discover_graph_expansion_injects_providers() {
        let app = test_app();

        // Register: adjustSalary requires employeeId, searchEmployees provides employeeId
        let reg = serde_json::json!({
            "tools": [
                {
                    "name": "adjustSalary",
                    "description": "Adjust employee salary",
                    "parameters": {},
                    "metadata": { "requires": ["employeeId"] }
                },
                {
                    "name": "searchEmployees",
                    "description": "Search employees by name",
                    "parameters": {},
                    "metadata": { "provides": ["employeeId"] }
                },
                {
                    "name": "unrelatedTool",
                    "description": "Does something unrelated",
                    "parameters": {}
                }
            ]
        });

        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/tools")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&reg).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        // Query for salary adjustment — limit=1 so only adjustSalary is semantically matched
        let query = serde_json::json!({ "query": "adjust employee salary", "limit": 1 });
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/discover")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&query).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let tools = json["tools"].as_array().unwrap();

        // Should have adjustSalary (semantic) + searchEmployees (graph expanded)
        assert!(tools.len() >= 2, "expected at least 2 tools, got {}", tools.len());

        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"adjustSalary"));
        assert!(names.contains(&"searchEmployees"));

        // searchEmployees should be marked as graph_expanded
        let search_tool = tools.iter().find(|t| t["name"] == "searchEmployees").unwrap();
        assert_eq!(search_tool["graph_expanded"], true);
        assert_eq!(search_tool["score"].as_f64().unwrap(), 0.0);

        // adjustSalary should NOT have graph_expanded
        let salary_tool = tools.iter().find(|t| t["name"] == "adjustSalary").unwrap();
        assert!(salary_tool.get("graph_expanded").is_none() || salary_tool["graph_expanded"].is_null());
    }

    #[tokio::test]
    async fn capture_turn_stores_and_returns_id() {
        let app = test_app();

        let body = serde_json::json!({
            "tools_loaded": ["getAccountInfo", "processRefund"],
            "message": "I need account info"
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/turns")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["turn_id"].as_str().unwrap().len() > 0);
    }

    #[tokio::test]
    async fn discover_with_turn_id_includes_base_tools() {
        let embedding = Arc::new(FakeEmbedding::new());
        let state = Arc::new(AppState {
            tools: RwLock::new(HashMap::new()),
            turns: RwLock::new(HashMap::new()),
            embedding_cache: RwLock::new(HashMap::new()),
            embedding: embedding.clone(),
        });

        let app = Router::new()
            .route("/api/v1/tools", post(register_tools))
            .route("/api/v1/discover", post(discover))
            .route("/api/v1/turns", post(capture_turn))
            .with_state(state);

        // Register 3 tools
        let reg = serde_json::json!({
            "tools": [
                { "name": "getAccountInfo", "description": "Get customer account details", "parameters": {} },
                { "name": "processRefund", "description": "Process a refund for invoice", "parameters": {} },
                { "name": "sendEmail", "description": "Send an email to a customer", "parameters": {} }
            ]
        });

        app.clone().oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/tools")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&reg).unwrap()))
                .unwrap(),
        ).await.unwrap();

        // Capture a turn with getAccountInfo as loaded tool
        let turn_body = serde_json::json!({
            "tools_loaded": ["getAccountInfo"],
            "message": "I need account info"
        });

        let turn_resp = app.clone().oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/turns")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&turn_body).unwrap()))
                .unwrap(),
        ).await.unwrap();

        let turn_bytes = axum::body::to_bytes(turn_resp.into_body(), usize::MAX).await.unwrap();
        let turn_json: serde_json::Value = serde_json::from_slice(&turn_bytes).unwrap();
        let turn_id = turn_json["turn_id"].as_str().unwrap();

        // Discover with turn_id — base tool (getAccountInfo) should appear with score=1.0
        let query = serde_json::json!({
            "query": "I want a refund",
            "limit": 1,
            "turn_id": turn_id
        });

        let response = app.oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/discover")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&query).unwrap()))
                .unwrap(),
        ).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let tools = json["tools"].as_array().unwrap();

        // Should have base tool (getAccountInfo) + at least 1 additional tool
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"getAccountInfo"), "base tool must be present");

        // Base tool should be first and have score 1.0
        let base_tool = tools.iter().find(|t| t["name"] == "getAccountInfo").unwrap();
        assert_eq!(base_tool["score"].as_f64().unwrap(), 1.0);
        assert!(base_tool.get("graph_expanded").is_none() || base_tool["graph_expanded"].is_null());

        // Additional tools should NOT include the base tool name
        let additional: Vec<&serde_json::Value> = tools.iter()
            .filter(|t| t["name"] != "getAccountInfo")
            .collect();
        assert!(!additional.is_empty(), "should have additional tools beyond base");
    }

    #[tokio::test]
    async fn discover_with_invalid_turn_id_returns_error() {
        let app = test_app();

        let reg = serde_json::json!({
            "tools": [{ "name": "t", "description": "d", "parameters": {} }]
        });
        app.clone().oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/tools")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&reg).unwrap()))
                .unwrap(),
        ).await.unwrap();

        let query = serde_json::json!({
            "query": "test",
            "turn_id": "nonexistent-id"
        });

        let response = app.oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/discover")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&query).unwrap()))
                .unwrap(),
        ).await.unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["error"].as_str().unwrap().contains("turn"));
    }

    #[tokio::test]
    async fn discover_no_graph_expansion_without_requires() {
        let app = test_app();

        let reg = serde_json::json!({
            "tools": [
                {
                    "name": "listEmployees",
                    "description": "List all employees",
                    "parameters": {},
                    "metadata": { "provides": ["employeeId"] }
                },
                {
                    "name": "getOrgChart",
                    "description": "Get org chart",
                    "parameters": {}
                }
            ]
        });

        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/tools")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&reg).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        let query = serde_json::json!({ "query": "org chart", "limit": 2 });
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/discover")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&query).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let tools = json["tools"].as_array().unwrap();

        // No tool requires anything, so no graph expansion
        let expanded: Vec<_> = tools.iter().filter(|t| t["graph_expanded"] == true).collect();
        assert!(expanded.is_empty(), "no tools should be graph_expanded");
    }
}
