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
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("failed to build HTTP client"),
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
    async fn embed(&self, text: &str) -> anyhow::Result<Vec<f32>> {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        self.call_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        const DIMS: usize = 256;
        let mut vec = Vec::with_capacity(DIMS);
        for i in 0..DIMS {
            let mut hasher = DefaultHasher::new();
            text.hash(&mut hasher);
            i.hash(&mut hasher);
            let h = hasher.finish();
            // Map hash to [-1, 1]
            vec.push((h as f64 / u64::MAX as f64) * 2.0 - 1.0);
        }

        // Normalize to unit vector
        let norm: f64 = vec.iter().map(|x| x * x).sum::<f64>().sqrt();
        Ok(vec.into_iter().map(|x| (x / norm) as f32).collect())
    }
}

#[cfg(test)]
pub struct FailingEmbedding;

#[cfg(test)]
#[async_trait]
impl EmbeddingService for FailingEmbedding {
    async fn embed(&self, _text: &str) -> anyhow::Result<Vec<f32>> {
        anyhow::bail!("embedding service unavailable")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fake_embedding_returns_distinct_vectors() {
        let fake = FakeEmbedding::new();
        let a = fake.embed("hello world").await.unwrap();
        let b = fake.embed("goodbye moon").await.unwrap();

        // Cosine similarity should be < 1.0 for distinct inputs
        let dot: f32 = a.iter().zip(&b).map(|(x, y)| x * y).sum();
        let norm_a = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        let norm_b = b.iter().map(|x| x * x).sum::<f32>().sqrt();
        let cosine = dot / (norm_a * norm_b);
        assert!(cosine < 0.99, "distinct texts should produce cosine < 0.99, got {cosine}");
    }

    #[tokio::test]
    async fn fake_embedding_is_deterministic() {
        let fake = FakeEmbedding::new();
        let a = fake.embed("same text").await.unwrap();
        let b = fake.embed("same text").await.unwrap();
        assert_eq!(a, b);
    }

    #[tokio::test]
    async fn failing_embedding_returns_error() {
        let failing = FailingEmbedding;
        let result = failing.embed("anything").await;
        assert!(result.is_err());
    }
}
