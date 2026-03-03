use std::sync::Arc;

use agentified_core::{app, NoopStorage, OpenAIEmbedding, SqliteStorage, Storage};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let port = std::env::var("AGENTIFIED_PORT").unwrap_or_else(|_| "9119".to_string());
    let addr = format!("0.0.0.0:{port}");

    let api_key = std::env::var("OPENAI_API_KEY").expect("OPENAI_API_KEY required");
    let embedding = Arc::new(OpenAIEmbedding::new(api_key));

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

    tracing::info!("agentified-core listening on {addr}");

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app(embedding, storage)).await.unwrap();
}
