use std::sync::Arc;

use agentified_lib::{
    AgentifiedCore, CoreError, EmbeddingService, LlmService, NoopStorage, OpenAIEmbedding, OpenAILlm,
    SqliteStorage, Storage,
    models::{
        AppendMessagesRequest, AppendMessagesResponse, CaptureTurnRequest, CaptureTurnResponse,
        ContextRequest, ContextResponse,
        DiscoverRequest, DiscoverResponse, ErrorResponse, GetMessagesQuery,
        GetMessagesResponse, ListToolsResponse, RegisterToolsRequest, RegisterToolsResponse,
    },
};
use axum::{extract::{Path, Query, State}, http::StatusCode, routing::{get, post}, Json, Router};
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
        .route("/api/v1/datasets/{id}/tools", post(register_tools).get(list_tools))
        .route("/api/v1/datasets/{id}/discover", post(discover))
        .route("/api/v1/turns", post(capture_turn))
        .route("/api/v1/messages", post(append_messages).get(get_messages))
        .route("/api/v1/context", post(get_context))
        .with_state(core)
}

// Handlers

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn register_tools(
    State(core): State<Arc<AgentifiedCore>>,
    Path(id): Path<String>,
    Json(body): Json<RegisterToolsRequest>,
) -> Result<(StatusCode, Json<RegisterToolsResponse>), (StatusCode, Json<ErrorResponse>)> {
    let response = core.register_tools(&id, body.tools).await.map_err(map_error)?;
    Ok((StatusCode::CREATED, Json(response)))
}

async fn list_tools(
    State(core): State<Arc<AgentifiedCore>>,
    Path(id): Path<String>,
) -> Result<Json<ListToolsResponse>, (StatusCode, Json<ErrorResponse>)> {
    let response = core.list_tools(&id).await.map_err(map_error)?;
    Ok(Json(response))
}

async fn discover(
    State(core): State<Arc<AgentifiedCore>>,
    Path(id): Path<String>,
    Json(body): Json<DiscoverRequest>,
) -> Result<Json<DiscoverResponse>, (StatusCode, Json<ErrorResponse>)> {
    let response = core.discover(&id, body).await.map_err(map_error)?;
    Ok(Json(response))
}

async fn capture_turn(
    State(core): State<Arc<AgentifiedCore>>,
    Json(body): Json<CaptureTurnRequest>,
) -> (StatusCode, Json<CaptureTurnResponse>) {
    let response = core.capture_turn(body).await;
    (StatusCode::CREATED, Json(response))
}

async fn append_messages(
    State(core): State<Arc<AgentifiedCore>>,
    Json(body): Json<AppendMessagesRequest>,
) -> Result<Json<AppendMessagesResponse>, (StatusCode, Json<ErrorResponse>)> {
    let response = core.append_messages(body).await.map_err(map_error)?;
    Ok(Json(response))
}

async fn get_messages(
    State(core): State<Arc<AgentifiedCore>>,
    Query(query): Query<GetMessagesQuery>,
) -> Result<Json<GetMessagesResponse>, (StatusCode, Json<ErrorResponse>)> {
    let response = core.get_messages(query).await.map_err(map_error)?;
    Ok(Json(response))
}

async fn get_context(
    State(core): State<Arc<AgentifiedCore>>,
    Json(body): Json<ContextRequest>,
) -> Result<Json<ContextResponse>, (StatusCode, Json<ErrorResponse>)> {
    let response = core.get_context(body).await.map_err(map_error)?;
    Ok(Json(response))
}

// Helpers

fn map_error(e: CoreError) -> (StatusCode, Json<ErrorResponse>) {
    let (status, error) = match &e {
        CoreError::EmbeddingFailed(_) => (StatusCode::BAD_GATEWAY, e.to_string()),
        CoreError::NotFound(_) => (StatusCode::NOT_FOUND, e.to_string()),
        CoreError::BadRequest(_) => (StatusCode::BAD_REQUEST, e.to_string()),
        CoreError::UnsupportedStrategy(_) => (StatusCode::UNPROCESSABLE_ENTITY, e.to_string()),
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
    let embedding: Arc<dyn EmbeddingService> = Arc::new(OpenAIEmbedding::new(api_key.clone()));
    let llm: Arc<dyn LlmService> = Arc::new(OpenAILlm::new(api_key));

    let storage_mode = std::env::var("AGENTIFIED_STORAGE").unwrap_or_else(|_| "sqlite".into());
    let storage: Arc<dyn Storage> = match storage_mode.as_str() {
        "noop" => {
            tracing::info!("using noop storage (messages will not persist)");
            Arc::new(NoopStorage)
        }
        _ => {
            let path = std::env::var("AGENTIFIED_DB_PATH")
                .unwrap_or_else(|_| "./agentified.db".into());
            tracing::info!("using SQLite storage at {path}");
            Arc::new(SqliteStorage::new(&path).expect("failed to open SQLite"))
        }
    };

    let core = Arc::new(AgentifiedCore::new_with_llm(embedding, storage, llm));

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
        let app = test_app_with_storage();

        let body = serde_json::json!({
            "tools": [{
                "name": "getAccountInfo",
                "description": "Get customer account details",
                "parameters": { "type": "object", "properties": {} }
            }]
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/datasets/test-ds/tools")
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
        let app = test_app_with_storage();

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
                    .uri("/api/v1/datasets/test-ds/tools")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        let response = app
            .oneshot(Request::builder().uri("/api/v1/datasets/test-ds/tools").body(Body::empty()).unwrap())
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
        let storage = Arc::new(SqliteStorage::new(":memory:").unwrap());
        let core = Arc::new(AgentifiedCore::new(
            embedding.clone() as Arc<dyn EmbeddingService>,
            storage as Arc<dyn Storage>,
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
                        .uri("/api/v1/datasets/test-ds/tools")
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
        let app = test_app_with_storage();

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
                    .uri("/api/v1/datasets/test-ds/tools")
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
                    .uri("/api/v1/datasets/test-ds/discover")
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
        let storage = Arc::new(SqliteStorage::new(":memory:").unwrap());
        let core = Arc::new(AgentifiedCore::new(
            Arc::new(FailingEmbedding),
            storage as Arc<dyn Storage>,
        ));
        let app = app(core);

        let body = serde_json::json!({
            "tools": [{"name": "t", "description": "d", "parameters": {}}]
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/datasets/ds/tools")
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

        let storage = Arc::new(agentified_lib::SqliteStorage::new(":memory:").unwrap());
        storage.save_tools("ds", &[("test", &StoredTool {
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
                    .uri("/api/v1/datasets/ds/discover")
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
        let app = test_app_with_storage();

        let reg = serde_json::json!({
            "tools": [{"name": "t", "description": "d", "parameters": {}}]
        });
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/datasets/test-ds/tools")
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
                    .uri("/api/v1/datasets/test-ds/discover")
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
        let app = test_app_with_storage();

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
                    .uri("/api/v1/datasets/test-ds/tools")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);

        let response = app
            .oneshot(Request::builder().uri("/api/v1/datasets/test-ds/tools").body(Body::empty()).unwrap())
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
        let app = test_app_with_storage();

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
                    .uri("/api/v1/datasets/test-ds/tools")
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
                    .uri("/api/v1/datasets/test-ds/discover")
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
        let app = test_app_with_storage();

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
                    .uri("/api/v1/datasets/test-ds/tools")
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
                    .uri("/api/v1/datasets/test-ds/discover")
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
        let app = test_app_with_storage();

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
                    .uri("/api/v1/datasets/test-ds/tools")
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
                    .uri("/api/v1/datasets/test-ds/discover")
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
        let app = test_app_with_storage();

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
                    .uri("/api/v1/datasets/test-ds/tools")
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
                    .uri("/api/v1/datasets/test-ds/discover")
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
        let storage = Arc::new(SqliteStorage::new(":memory:").unwrap());
        let core = Arc::new(AgentifiedCore::new(
            embedding.clone() as Arc<dyn EmbeddingService>,
            storage as Arc<dyn Storage>,
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
                    .uri("/api/v1/datasets/test-ds/tools")
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
        let app = test_app_with_storage();

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
                    .uri("/api/v1/datasets/test-ds/tools")
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
                    .uri("/api/v1/datasets/test-ds/discover")
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
        let app = test_app_with_storage();

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
                    .uri("/api/v1/datasets/test-ds/tools")
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
                    .uri("/api/v1/datasets/test-ds/discover")
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
        let app = test_app_with_storage();

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
                .uri("/api/v1/datasets/test-ds/tools")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&reg).unwrap()))
                .unwrap(),
        ).await.unwrap();

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
                .uri("/api/v1/datasets/test-ds/discover")
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
        let app = test_app_with_storage();

        let reg = serde_json::json!({
            "tools": [{ "name": "t", "description": "d", "parameters": {} }]
        });
        app.clone().oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/datasets/test-ds/tools")
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
                .uri("/api/v1/datasets/test-ds/discover")
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
        let app = test_app_with_storage();

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
                    .uri("/api/v1/datasets/test-ds/tools")
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
                    .uri("/api/v1/datasets/test-ds/discover")
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

    fn test_app_with_storage() -> Router {
        let storage = Arc::new(SqliteStorage::new(":memory:").unwrap());
        let core = Arc::new(AgentifiedCore::new(
            Arc::new(FakeEmbedding::new()),
            storage as Arc<dyn Storage>,
        ));
        app(core)
    }

    // Dataset isolation: same tool name on different datasets -> separate entries
    #[tokio::test]
    async fn dataset_isolation_same_tool_name_separate_entries() {
        let app = test_app_with_storage();

        let tool = serde_json::json!({
            "tools": [{"name": "sharedName", "description": "tool on A", "parameters": {}}]
        });
        app.clone().oneshot(
            Request::builder().method("POST")
                .uri("/api/v1/datasets/ds-a/tools")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&tool).unwrap())).unwrap(),
        ).await.unwrap();

        let tool_b = serde_json::json!({
            "tools": [{"name": "sharedName", "description": "tool on B", "parameters": {}}]
        });
        app.clone().oneshot(
            Request::builder().method("POST")
                .uri("/api/v1/datasets/ds-b/tools")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&tool_b).unwrap())).unwrap(),
        ).await.unwrap();

        // List A -> 1 tool with A's description
        let resp = app.clone().oneshot(
            Request::builder().uri("/api/v1/datasets/ds-a/tools").body(Body::empty()).unwrap(),
        ).await.unwrap();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["tools"].as_array().unwrap().len(), 1);
        assert_eq!(json["tools"][0]["description"], "tool on A");

        // List B -> 1 tool with B's description
        let resp = app.oneshot(
            Request::builder().uri("/api/v1/datasets/ds-b/tools").body(Body::empty()).unwrap(),
        ).await.unwrap();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["tools"].as_array().unwrap().len(), 1);
        assert_eq!(json["tools"][0]["description"], "tool on B");
    }

    // Dataset isolation: discover scoped to dataset -- no cross-dataset results
    #[tokio::test]
    async fn dataset_isolation_discover_no_cross_dataset() {
        let app = test_app_with_storage();

        // Register tool only on ds-a
        let tool = serde_json::json!({
            "tools": [{"name": "processRefund", "description": "Process a refund", "parameters": {}}]
        });
        app.clone().oneshot(
            Request::builder().method("POST")
                .uri("/api/v1/datasets/ds-a/tools")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&tool).unwrap())).unwrap(),
        ).await.unwrap();

        // Discover on ds-b -> empty
        let query = serde_json::json!({ "query": "refund" });
        let resp = app.clone().oneshot(
            Request::builder().method("POST")
                .uri("/api/v1/datasets/ds-b/discover")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&query).unwrap())).unwrap(),
        ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["tools"].as_array().unwrap().len(), 0);

        // Discover on ds-a -> finds it
        let resp = app.oneshot(
            Request::builder().method("POST")
                .uri("/api/v1/datasets/ds-a/discover")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&query).unwrap())).unwrap(),
        ).await.unwrap();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["tools"].as_array().unwrap().len(), 1);
        assert_eq!(json["tools"][0]["name"], "processRefund");
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
                    .uri("/api/v1/datasets/ds/tools")
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

    // Messages tests

    #[tokio::test]
    async fn append_messages_returns_seq_range() {
        let app = test_app_with_storage();

        let body = serde_json::json!({
            "dataset": "ds",
            "namespace": "ns",
            "session": "s1",
            "messages": [
                { "role": "user", "content": "Hello" },
                { "role": "assistant", "content": "Hi there!" }
            ]
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/messages")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["appended"], 2);
        assert_eq!(json["first_seq"], 1);
        assert_eq!(json["last_seq"], 2);
    }

    #[tokio::test]
    async fn append_messages_seq_auto_increments() {
        let app = test_app_with_storage();

        let body = serde_json::json!({
            "dataset": "ds", "namespace": "ns", "session": "s1",
            "messages": [{ "role": "user", "content": "First" }]
        });
        let json_str = serde_json::to_string(&body).unwrap();

        let resp = app.clone().oneshot(
            Request::builder().method("POST").uri("/api/v1/messages")
                .header("content-type", "application/json")
                .body(Body::from(json_str)).unwrap(),
        ).await.unwrap();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["first_seq"], 1);
        assert_eq!(json["last_seq"], 1);

        // Second append -> seq continues
        let body2 = serde_json::json!({
            "dataset": "ds", "namespace": "ns", "session": "s1",
            "messages": [
                { "role": "assistant", "content": "Reply" },
                { "role": "user", "content": "Follow-up" }
            ]
        });
        let resp2 = app.oneshot(
            Request::builder().method("POST").uri("/api/v1/messages")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body2).unwrap())).unwrap(),
        ).await.unwrap();
        let bytes2 = axum::body::to_bytes(resp2.into_body(), usize::MAX).await.unwrap();
        let json2: serde_json::Value = serde_json::from_slice(&bytes2).unwrap();
        assert_eq!(json2["appended"], 2);
        assert_eq!(json2["first_seq"], 2);
        assert_eq!(json2["last_seq"], 3);
    }

    #[tokio::test]
    async fn get_messages_returns_last_n_ascending() {
        let app = test_app_with_storage();

        // Append 5 messages
        let body = serde_json::json!({
            "dataset": "ds", "namespace": "ns", "session": "s1",
            "messages": [
                { "role": "user", "content": "m1" },
                { "role": "assistant", "content": "m2" },
                { "role": "user", "content": "m3" },
                { "role": "assistant", "content": "m4" },
                { "role": "user", "content": "m5" }
            ]
        });
        app.clone().oneshot(
            Request::builder().method("POST").uri("/api/v1/messages")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap())).unwrap(),
        ).await.unwrap();

        // GET last 3
        let resp = app.oneshot(
            Request::builder().uri("/api/v1/messages?dataset=ds&namespace=ns&session=s1&limit=3")
                .body(Body::empty()).unwrap(),
        ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let msgs = json["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        // Ascending order: m3, m4, m5
        assert_eq!(msgs[0]["content"], "m3");
        assert_eq!(msgs[1]["content"], "m4");
        assert_eq!(msgs[2]["content"], "m5");
        assert_eq!(json["has_more"], true);
        assert_eq!(json["max_seq"], 5);
    }

    #[tokio::test]
    async fn get_messages_after_seq_forward() {
        let app = test_app_with_storage();
        append_test_messages(&app, "ds", "ns", "s1", &["m1", "m2", "m3", "m4", "m5"]).await;

        let resp = app.oneshot(
            Request::builder().uri("/api/v1/messages?dataset=ds&namespace=ns&session=s1&limit=2&after_seq=2")
                .body(Body::empty()).unwrap(),
        ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let msgs = json["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["content"], "m3");
        assert_eq!(msgs[1]["content"], "m4");
        assert_eq!(json["has_more"], true);
    }

    #[tokio::test]
    async fn get_messages_around_seq_centered() {
        let app = test_app_with_storage();
        append_test_messages(&app, "ds", "ns", "s1", &["m1", "m2", "m3", "m4", "m5"]).await;

        let resp = app.oneshot(
            Request::builder().uri("/api/v1/messages?dataset=ds&namespace=ns&session=s1&limit=3&around_seq=3")
                .body(Body::empty()).unwrap(),
        ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let msgs = json["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        // around_seq=3, limit=3 -> half=1, start=max(3-1,1)=2 -> m2,m3,m4
        assert_eq!(msgs[0]["content"], "m2");
        assert_eq!(msgs[1]["content"], "m3");
        assert_eq!(msgs[2]["content"], "m4");
    }

    #[tokio::test]
    async fn get_messages_both_params_returns_400() {
        let app = test_app_with_storage();

        let resp = app.oneshot(
            Request::builder().uri("/api/v1/messages?dataset=ds&namespace=ns&session=s1&after_seq=1&around_seq=2")
                .body(Body::empty()).unwrap(),
        ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn get_messages_limit_zero_returns_max_seq() {
        let app = test_app_with_storage();
        append_test_messages(&app, "ds", "ns", "s1", &["m1", "m2", "m3"]).await;

        let resp = app.oneshot(
            Request::builder().uri("/api/v1/messages?dataset=ds&namespace=ns&session=s1&limit=0")
                .body(Body::empty()).unwrap(),
        ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["messages"].as_array().unwrap().len(), 0);
        assert_eq!(json["max_seq"], 3);
    }

    async fn append_test_messages(app: &Router, dataset: &str, namespace: &str, session: &str, contents: &[&str]) {
        let messages: Vec<serde_json::Value> = contents.iter()
            .map(|c| serde_json::json!({ "role": "user", "content": c }))
            .collect();
        let body = serde_json::json!({
            "dataset": dataset, "namespace": namespace, "session": session,
            "messages": messages
        });
        app.clone().oneshot(
            Request::builder().method("POST").uri("/api/v1/messages")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap())).unwrap(),
        ).await.unwrap();
    }

    #[tokio::test]
    async fn messages_cross_session_isolation() {
        let app = test_app_with_storage();

        // Append to session A
        append_test_messages(&app, "ds", "ns", "session-a", &["a1", "a2"]).await;
        // Append to session B
        append_test_messages(&app, "ds", "ns", "session-b", &["b1"]).await;

        // GET session A -> only A's messages, seq starts at 1
        let resp = app.clone().oneshot(
            Request::builder().uri("/api/v1/messages?dataset=ds&namespace=ns&session=session-a")
                .body(Body::empty()).unwrap(),
        ).await.unwrap();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let msgs = json["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["content"], "a1");
        assert_eq!(msgs[0]["seq"], 1);

        // GET session B -> only B's messages, seq starts at 1
        let resp = app.oneshot(
            Request::builder().uri("/api/v1/messages?dataset=ds&namespace=ns&session=session-b")
                .body(Body::empty()).unwrap(),
        ).await.unwrap();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let msgs = json["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["content"], "b1");
        assert_eq!(msgs[0]["seq"], 1);
    }

    #[tokio::test]
    async fn context_recent_returns_messages_within_budget() {
        let app = test_app_with_storage();

        // Append 5 messages
        let content = "y".repeat(100); // 25 tokens each
        let messages: Vec<serde_json::Value> = (0..5).map(|_| serde_json::json!({
            "role": "user", "content": content
        })).collect();
        let body = serde_json::json!({
            "dataset": "ds", "namespace": "ns", "session": "s1",
            "messages": messages
        });
        app.clone().oneshot(
            Request::builder().method("POST").uri("/api/v1/messages")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap())).unwrap(),
        ).await.unwrap();

        // Context with budget=60 -> 2 most recent messages
        let ctx_body = serde_json::json!({
            "dataset": "ds", "namespace": "ns", "session": "s1",
            "messages": { "strategy": "recent", "max_tokens": 60 }
        });
        let resp = app.oneshot(
            Request::builder().method("POST").uri("/api/v1/context")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&ctx_body).unwrap())).unwrap(),
        ).await.unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["strategy_used"], "recent");
        assert_eq!(json["messages"].as_array().unwrap().len(), 2);
        assert_eq!(json["total_messages"], 5);
        assert_eq!(json["included_messages"], 2);
        assert_eq!(json["fallback"], false);
        assert!(json["recalled"]["tools"].as_array().unwrap().is_empty());
        assert!(json["recalled"]["memories"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn context_full_returns_from_oldest() {
        let app = test_app_with_storage();

        let content = "z".repeat(100);
        let messages: Vec<serde_json::Value> = (0..5).map(|_| serde_json::json!({
            "role": "user", "content": content
        })).collect();
        let body = serde_json::json!({
            "dataset": "ds", "namespace": "ns", "session": "s1",
            "messages": messages
        });
        app.clone().oneshot(
            Request::builder().method("POST").uri("/api/v1/messages")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap())).unwrap(),
        ).await.unwrap();

        let ctx_body = serde_json::json!({
            "dataset": "ds", "namespace": "ns", "session": "s1",
            "messages": { "strategy": "full", "max_tokens": 60 }
        });
        let resp = app.oneshot(
            Request::builder().method("POST").uri("/api/v1/context")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&ctx_body).unwrap())).unwrap(),
        ).await.unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["strategy_used"], "full");
        assert_eq!(json["messages"].as_array().unwrap().len(), 2);
        // Full takes from oldest -> seq 1
        assert_eq!(json["messages"][0]["seq"], 1);
    }

    #[tokio::test]
    async fn compacted_without_llm_returns_422() {
        let app = test_app_with_storage();

        let ctx_body = serde_json::json!({
            "dataset": "ds", "namespace": "ns", "session": "s1",
            "messages": { "strategy": "compacted" }
        });
        let resp = app.clone().oneshot(
            Request::builder().method("POST").uri("/api/v1/context")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&ctx_body).unwrap())).unwrap(),
        ).await.unwrap();

        assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(json["error"].as_str().unwrap().contains("Compacted strategy"));
    }

    #[tokio::test]
    async fn removed_strategies_return_400() {
        let app = test_app_with_storage();

        for strategy in &["summary", "recent+summary"] {
            let ctx_body = serde_json::json!({
                "dataset": "ds", "namespace": "ns", "session": "s1",
                "messages": { "strategy": strategy }
            });
            let resp = app.clone().oneshot(
                Request::builder().method("POST").uri("/api/v1/context")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&ctx_body).unwrap())).unwrap(),
            ).await.unwrap();

            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        }
    }

    #[tokio::test]
    async fn context_defaults_to_recent_4000() {
        let app = test_app_with_storage();

        // Append a message
        append_test_messages(&app, "ds", "ns", "s1", &["hello"]).await;

        // Send context request with minimal body (no messages config)
        let ctx_body = serde_json::json!({
            "dataset": "ds", "namespace": "ns", "session": "s1"
        });
        let resp = app.oneshot(
            Request::builder().method("POST").uri("/api/v1/context")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&ctx_body).unwrap())).unwrap(),
        ).await.unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["strategy_used"], "recent");
        assert_eq!(json["messages"].as_array().unwrap().len(), 1);
    }
}
