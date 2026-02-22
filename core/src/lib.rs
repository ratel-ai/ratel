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
    DiscoverRequest, DiscoverResponse, ErrorResponse, FieldEmbeddings, ListToolsResponse,
    RankedTool, RegisterToolsRequest, RegisterToolsResponse, StoredTool,
};
use ranking::{bm25_scores, weighted_semantic_score};

// Types

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

pub struct AppState {
    tools: RwLock<HashMap<String, StoredTool>>,
    embedding_cache: RwLock<HashMap<String, Vec<f32>>>,
    embedding: Arc<dyn EmbeddingService>,
}

// Public API

pub fn app(embedding: Arc<dyn EmbeddingService>) -> Router {
    let state = Arc::new(AppState {
        tools: RwLock::new(HashMap::new()),
        embedding_cache: RwLock::new(HashMap::new()),
        embedding,
    });

    Router::new()
        .route("/health", get(health))
        .route("/api/v1/tools", post(register_tools).get(list_tools))
        .route("/api/v1/discover", post(discover))
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

    // Compute embeddings outside the tools write lock
    let mut tool_data = Vec::with_capacity(count);
    for tool in &body.tools {
        let (name_text, desc_text, input_text, output_text) = if let Some(ref fields) = tool.fields {
            (
                fields.name.clone(),
                fields.description.clone(),
                fields.input_schema.clone(),
                fields.output_schema.clone(),
            )
        } else {
            (tool.name.clone(), tool.description.clone(), None, None)
        };

        let name_emb = embed_cached(&state, &name_text).await.map_err(embed_err)?;
        let desc_emb = embed_cached(&state, &desc_text).await.map_err(embed_err)?;
        let input_emb = match &input_text {
            Some(t) => Some(embed_cached(&state, t).await.map_err(embed_err)?),
            None => None,
        };
        let output_emb = match &output_text {
            Some(t) => Some(embed_cached(&state, t).await.map_err(embed_err)?),
            None => None,
        };

        let bm25_text = [
            Some(name_text),
            Some(desc_text),
            input_text,
            output_text,
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

    // Batch insert with write lock
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
    // Compute query embedding before acquiring tools lock
    let query_embedding = embed_cached(&state, &body.query).await.map_err(embed_err)?;

    let tools = state.tools.read().await;
    if tools.is_empty() {
        return Ok(Json(DiscoverResponse { tools: vec![] }));
    }

    let weights = body.embedding_weights.unwrap_or_default();
    let stored: Vec<&StoredTool> = tools.values().collect();

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
        })
        .collect();

    ranked.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    let limit = body.limit.unwrap_or(5).min(100);
    ranked.truncate(limit);

    Ok(Json(DiscoverResponse { tools: ranked }))
}

// Helpers

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
}
