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
    DiscoverRequest, DiscoverResponse, ListToolsResponse, RankedTool, RegisterToolsRequest,
    RegisterToolsResponse, StoredTool,
};
use ranking::{bm25_scores, cosine_similarity};

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
) -> (StatusCode, Json<RegisterToolsResponse>) {
    let mut tools = state.tools.write().await;
    let mut cache = state.embedding_cache.write().await;
    let count = body.tools.len();

    for tool in body.tools {
        let embed_text = format!("{}: {}", tool.name, tool.description);

        let embedding = if let Some(cached) = cache.get(&embed_text) {
            cached.clone()
        } else {
            let emb = state.embedding.embed(&embed_text).await.unwrap_or_default();
            cache.insert(embed_text, emb.clone());
            emb
        };

        tools.insert(tool.name.clone(), StoredTool { tool, embedding });
    }

    (StatusCode::CREATED, Json(RegisterToolsResponse { registered: count }))
}

async fn list_tools(State(state): State<Arc<AppState>>) -> Json<ListToolsResponse> {
    let tools = state.tools.read().await;
    let tool_list = tools.values().map(|st| st.tool.clone()).collect();
    Json(ListToolsResponse { tools: tool_list })
}

async fn discover(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DiscoverRequest>,
) -> Json<DiscoverResponse> {
    let tools = state.tools.read().await;
    if tools.is_empty() {
        return Json(DiscoverResponse { tools: vec![] });
    }

    // Compute query embedding (use cache)
    let mut cache = state.embedding_cache.write().await;
    let query_embedding = if let Some(cached) = cache.get(&body.query) {
        cached.clone()
    } else {
        let emb = state.embedding.embed(&body.query).await.unwrap_or_default();
        cache.insert(body.query.clone(), emb.clone());
        emb
    };
    drop(cache);

    let stored: Vec<&StoredTool> = tools.values().collect();

    // Semantic scores
    let semantic_scores: Vec<f32> = stored
        .iter()
        .map(|t| cosine_similarity(&query_embedding, &t.embedding))
        .collect();

    // BM25 scores
    let documents: Vec<String> = stored
        .iter()
        .map(|t| format!("{} {}", t.tool.name, t.tool.description))
        .collect();
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

    let limit = body.limit.unwrap_or(5);
    ranked.truncate(limit);

    Json(DiscoverResponse { tools: ranked })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use embedding::FakeEmbedding;
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

        // Register a tool
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

        // List tools
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

        // Register same tool twice
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

        // Embedding computed only once (cached on second call)
        assert_eq!(
            embedding.call_count.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }

    #[tokio::test]
    async fn discover_ranks_matching_tool_first() {
        let app = test_app();

        // Register two tools
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

        // Discover with refund query
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
}
