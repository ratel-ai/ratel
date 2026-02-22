use std::sync::Arc;

use agentified_core::{app, OpenAIEmbedding};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let port = std::env::var("AGENTIFIED_PORT").unwrap_or_else(|_| "9119".to_string());
    let addr = format!("0.0.0.0:{port}");

    let api_key = std::env::var("OPENAI_API_KEY").expect("OPENAI_API_KEY required");
    let embedding = Arc::new(OpenAIEmbedding::new(api_key));

    tracing::info!("agentified-core listening on {addr}");

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app(embedding)).await.unwrap();
}
