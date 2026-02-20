mod embedding;
mod models;

use std::collections::HashMap;
use std::sync::Arc;

use axum::{extract::State, http::StatusCode, routing::{get, post}, Json, Router};
use serde::Serialize;
use tokio::sync::RwLock;

pub use embedding::{EmbeddingService, OpenAIEmbedding};

use models::{ListToolsResponse, RegisterToolsRequest, RegisterToolsResponse, StoredTool};

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
}
