use std::sync::Arc;

use agentified_lib::{
    AgentifiedCore, CoreError, EmbeddingService, NoopStorage, OpenAIEmbedding,
    SqliteStorage, Storage,
    models::{
        CaptureTurnRequest, CaptureTurnResponse, DiscoverRequest, DiscoverResponse,
        ErrorResponse, ListToolsResponse, RegisterToolsRequest, RegisterToolsResponse,
    },
};
use axum::{extract::State, http::StatusCode, routing::{get, post}, Json, Router};
use serde::Serialize;

// Types

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

// Public API

pub fn app(core: Arc<AgentifiedCore>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/v1/tools", post(register_tools).get(list_tools))
        .route("/api/v1/discover", post(discover))
        .route("/api/v1/turns", post(capture_turn))
        .with_state(core)
}

// Handlers

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn register_tools(
    State(core): State<Arc<AgentifiedCore>>,
    Json(body): Json<RegisterToolsRequest>,
) -> Result<(StatusCode, Json<RegisterToolsResponse>), (StatusCode, Json<ErrorResponse>)> {
    let response = core.register_tools(body.tools).await.map_err(map_error)?;
    Ok((StatusCode::CREATED, Json(response)))
}

async fn list_tools(State(core): State<Arc<AgentifiedCore>>) -> Json<ListToolsResponse> {
    Json(core.list_tools().await)
}

async fn discover(
    State(core): State<Arc<AgentifiedCore>>,
    Json(body): Json<DiscoverRequest>,
) -> Result<Json<DiscoverResponse>, (StatusCode, Json<ErrorResponse>)> {
    let response = core.discover(body).await.map_err(map_error)?;
    Ok(Json(response))
}

async fn capture_turn(
    State(core): State<Arc<AgentifiedCore>>,
    Json(body): Json<CaptureTurnRequest>,
) -> (StatusCode, Json<CaptureTurnResponse>) {
    let response = core.capture_turn(body).await;
    (StatusCode::CREATED, Json(response))
}

// Helpers

fn map_error(e: CoreError) -> (StatusCode, Json<ErrorResponse>) {
    let (status, error) = match &e {
        CoreError::EmbeddingFailed(_) => (StatusCode::BAD_GATEWAY, e.to_string()),
        CoreError::NotFound(_) => (StatusCode::NOT_FOUND, e.to_string()),
    };
    (status, Json(ErrorResponse { error }))
}

// Entry point

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let port = std::env::var("AGENTIFIED_PORT").unwrap_or_else(|_| "9119".to_string());
    let addr = format!("0.0.0.0:{port}");

    let api_key = std::env::var("OPENAI_API_KEY").expect("OPENAI_API_KEY required");
    let embedding: Arc<dyn EmbeddingService> = Arc::new(OpenAIEmbedding::new(api_key));

    let storage_mode = std::env::var("AGENTIFIED_STORAGE").unwrap_or_else(|_| "memory".into());
    let storage: Arc<dyn Storage> = match storage_mode.as_str() {
        "sqlite" => {
            let path = std::env::var("AGENTIFIED_DB_PATH")
                .unwrap_or_else(|_| "./agentified.db".into());
            tracing::info!("using SQLite storage at {path}");
            Arc::new(SqliteStorage::new(&path).expect("failed to open SQLite"))
        }
        _ => Arc::new(NoopStorage),
    };

    let core = Arc::new(AgentifiedCore::new(embedding, storage));

    tracing::info!("agentified-core listening on {addr}");

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app(core)).await.unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentified_lib::{FakeEmbedding, FailingEmbedding};
    use agentified_lib::models::{FieldEmbeddings, StoredTool};
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    fn test_app() -> Router {
        let core = Arc::new(AgentifiedCore::new(
            Arc::new(FakeEmbedding::new()),
            Arc::new(NoopStorage),
        ));
        app(core)
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
        let core = Arc::new(AgentifiedCore::new(
            embedding.clone() as Arc<dyn EmbeddingService>,
            Arc::new(NoopStorage),
        ));
        let app = app(core);

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
        let core = Arc::new(AgentifiedCore::new(
            Arc::new(FailingEmbedding),
            Arc::new(NoopStorage),
        ));
        let app = app(core);

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

        // Pre-populate core with a tool via storage
        let storage = Arc::new(agentified_lib::SqliteStorage::new(":memory:").unwrap());
        storage.save_tools(&[("test", &StoredTool {
            tool: agentified_lib::models::Tool {
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
        })]).unwrap();

        let core = Arc::new(AgentifiedCore::new(
            Arc::new(FailingEmbedding),
            storage as Arc<dyn Storage>,
        ));
        let app = app(core);

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

        let response = app
            .oneshot(Request::builder().uri("/api/v1/tools").body(Body::empty()).unwrap())
            .await
            .unwrap();

        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["tools"].as_array().unwrap().len(), 1);
        assert_eq!(json["tools"][0]["name"], "getAccountInfo");
        assert!(json["tools"][0]["fields"].is_object());
        assert_eq!(json["tools"][0]["fields"]["input_schema"], "{ accountId: string }");
    }

    #[tokio::test]
    async fn register_backward_compat_no_fields() {
        let app = test_app();

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
        let core = Arc::new(AgentifiedCore::new(
            embedding.clone() as Arc<dyn EmbeddingService>,
            Arc::new(NoopStorage),
        ));
        let app = app(core);

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
        assert_eq!(tools[0]["name"], "processRefund");
    }

    #[tokio::test]
    async fn discover_graph_expansion_injects_providers() {
        let app = test_app();

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

        assert!(tools.len() >= 2, "expected at least 2 tools, got {}", tools.len());

        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"adjustSalary"));
        assert!(names.contains(&"searchEmployees"));

        let search_tool = tools.iter().find(|t| t["name"] == "searchEmployees").unwrap();
        assert_eq!(search_tool["graph_expanded"], true);
        assert_eq!(search_tool["score"].as_f64().unwrap(), 0.0);

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
        let core = Arc::new(AgentifiedCore::new(
            Arc::new(FakeEmbedding::new()),
            Arc::new(NoopStorage),
        ));
        let app = app(core);

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

        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"getAccountInfo"), "base tool must be present");

        let base_tool = tools.iter().find(|t| t["name"] == "getAccountInfo").unwrap();
        assert_eq!(base_tool["score"].as_f64().unwrap(), 1.0);
        assert!(base_tool.get("graph_expanded").is_none() || base_tool["graph_expanded"].is_null());

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

        let expanded: Vec<_> = tools.iter().filter(|t| t["graph_expanded"] == true).collect();
        assert!(expanded.is_empty(), "no tools should be graph_expanded");
    }

    #[tokio::test]
    async fn app_hydrates_tools_from_storage() {
        let storage = Arc::new(SqliteStorage::new(":memory:").unwrap());

        let fake = FakeEmbedding::new();
        let name_emb = fake.embed("getThing").await.unwrap();
        let desc_emb = fake.embed("Get a thing").await.unwrap();
        let tool = StoredTool {
            tool: agentified_lib::models::Tool {
                name: "getThing".into(),
                description: "Get a thing".into(),
                parameters: serde_json::json!({}),
                metadata: None,
                fields: None,
            },
            embeddings: FieldEmbeddings {
                name: name_emb,
                description: desc_emb,
                input_schema: None,
                output_schema: None,
            },
            bm25_text: "getThing Get a thing".into(),
        };
        storage.save_tools(&[("getThing", &tool)]).unwrap();

        let core = Arc::new(AgentifiedCore::new(
            Arc::new(FakeEmbedding::new()),
            storage as Arc<dyn Storage>,
        ));
        let app = app(core);

        let response = app
            .oneshot(Request::builder().uri("/api/v1/tools").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["tools"].as_array().unwrap().len(), 1);
        assert_eq!(json["tools"][0]["name"], "getThing");
    }

    #[tokio::test]
    async fn app_hydrates_embedding_cache() {
        let storage = Arc::new(SqliteStorage::new(":memory:").unwrap());

        let fake = FakeEmbedding::new();
        let emb = fake.embed("toolName").await.unwrap();
        storage.save_embeddings(&[("toolName", &emb)]).unwrap();
        let emb2 = fake.embed("tool description").await.unwrap();
        storage.save_embeddings(&[("tool description", &emb2)]).unwrap();

        let embedding = Arc::new(FakeEmbedding::new());
        let core = Arc::new(AgentifiedCore::new(
            embedding.clone() as Arc<dyn EmbeddingService>,
            storage as Arc<dyn Storage>,
        ));
        let app = app(core);

        let body = serde_json::json!({
            "tools": [{"name": "toolName", "description": "tool description", "parameters": {}}]
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

        assert_eq!(
            embedding.batch_call_count.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "should not call embed_batch when cache is hydrated"
        );
    }
}
