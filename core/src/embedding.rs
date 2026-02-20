use anyhow::Context;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[async_trait]
pub trait EmbeddingService: Send + Sync {
    async fn embed(&self, text: &str) -> anyhow::Result<Vec<f32>>;
}

// OpenAI API types

#[derive(Serialize)]
struct EmbeddingRequest<'a> {
    input: &'a str,
    model: &'a str,
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingData>,
}

#[derive(Deserialize)]
struct EmbeddingData {
    embedding: Vec<f32>,
}

// OpenAI implementation

pub struct OpenAIEmbedding {
    client: reqwest::Client,
    api_key: String,
}

impl OpenAIEmbedding {
    pub fn new(api_key: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_key,
        }
    }
}

#[async_trait]
impl EmbeddingService for OpenAIEmbedding {
    async fn embed(&self, text: &str) -> anyhow::Result<Vec<f32>> {
        let response = self
            .client
            .post("https://api.openai.com/v1/embeddings")
            .bearer_auth(&self.api_key)
            .json(&EmbeddingRequest {
                input: text,
                model: "text-embedding-3-small",
            })
            .send()
            .await
            .context("failed to call OpenAI embeddings API")?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("OpenAI API error {status}: {body}");
        }

        let body: EmbeddingResponse = response
            .json()
            .await
            .context("failed to parse OpenAI response")?;

        body.data
            .into_iter()
            .next()
            .map(|d| d.embedding)
            .context("no embedding returned")
    }
}

#[cfg(test)]
pub struct FakeEmbedding {
    pub call_count: std::sync::atomic::AtomicUsize,
}

#[cfg(test)]
impl FakeEmbedding {
    pub fn new() -> Self {
        Self {
            call_count: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

#[cfg(test)]
#[async_trait]
impl EmbeddingService for FakeEmbedding {
    async fn embed(&self, _text: &str) -> anyhow::Result<Vec<f32>> {
        self.call_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(vec![0.1; 1536])
    }
}
