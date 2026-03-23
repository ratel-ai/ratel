use anyhow::Context;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[async_trait]
pub trait EmbeddingService: Send + Sync {
    async fn embed(&self, text: &str) -> anyhow::Result<Vec<f32>>;
    async fn embed_batch(&self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>>;
}

// OpenAI API types

#[derive(Serialize)]
struct EmbeddingRequest<'a> {
    input: &'a str,
    model: &'a str,
}

#[derive(Serialize)]
struct BatchEmbeddingRequest<'a> {
    input: &'a [String],
    model: &'a str,
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingData>,
}

#[derive(Deserialize)]
struct EmbeddingData {
    index: usize,
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
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .expect("failed to build HTTP client"),
            api_key,
        }
    }
}

#[async_trait]
impl EmbeddingService for OpenAIEmbedding {
    async fn embed_batch(&self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(vec![]);
        }

        let response = self
            .client
            .post("https://api.openai.com/v1/embeddings")
            .bearer_auth(&self.api_key)
            .json(&BatchEmbeddingRequest {
                input: texts,
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

        // Sort by index to guarantee order matches input
        let mut data = body.data;
        data.sort_by_key(|d| d.index);

        Ok(data.into_iter().map(|d| d.embedding).collect())
    }

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

// LLM service trait (for summary generation)

#[async_trait]
pub trait LlmService: Send + Sync {
    async fn chat(&self, system: &str, user: &str, max_tokens: usize) -> anyhow::Result<String>;
}

pub struct OpenAILlm {
    client: reqwest::Client,
    api_key: String,
}

impl OpenAILlm {
    pub fn new(api_key: String) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("failed to build HTTP client"),
            api_key,
        }
    }
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
    max_completion_tokens: usize,
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(Deserialize)]
struct ChatChoiceMessage {
    content: String,
}

#[async_trait]
impl LlmService for OpenAILlm {
    async fn chat(&self, system: &str, user: &str, max_tokens: usize) -> anyhow::Result<String> {
        let response = self
            .client
            .post("https://api.openai.com/v1/chat/completions")
            .bearer_auth(&self.api_key)
            .json(&ChatRequest {
                model: "gpt-5-mini",
                messages: vec![
                    ChatMessage { role: "system", content: system },
                    ChatMessage { role: "user", content: user },
                ],
                max_completion_tokens: max_tokens,
            })
            .send()
            .await
            .context("failed to call OpenAI chat API")?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("OpenAI API error {status}: {body}");
        }

        let body: ChatResponse = response
            .json()
            .await
            .context("failed to parse OpenAI chat response")?;

        body.choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .context("no chat completion returned")
    }
}

// Test utilities (available via `test-utils` feature or in tests)

#[cfg(any(test, feature = "test-utils"))]
pub struct FakeEmbedding {
    pub call_count: std::sync::atomic::AtomicUsize,
    pub batch_call_count: std::sync::atomic::AtomicUsize,
}

#[cfg(any(test, feature = "test-utils"))]
impl FakeEmbedding {
    pub fn new() -> Self {
        Self {
            call_count: std::sync::atomic::AtomicUsize::new(0),
            batch_call_count: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

#[cfg(any(test, feature = "test-utils"))]
#[async_trait]
impl EmbeddingService for FakeEmbedding {
    async fn embed_batch(&self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        self.batch_call_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut results = Vec::with_capacity(texts.len());
        for text in texts {
            results.push(self.embed(text).await?);
        }
        Ok(results)
    }

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

#[cfg(any(test, feature = "test-utils"))]
pub struct FakeLlm;

#[cfg(any(test, feature = "test-utils"))]
#[async_trait]
impl LlmService for FakeLlm {
    async fn chat(&self, _system: &str, user: &str, _max_tokens: usize) -> anyhow::Result<String> {
        let truncated: String = user.chars().take(100).collect();
        Ok(format!("Summary: {truncated}"))
    }
}

#[cfg(any(test, feature = "test-utils"))]
pub struct FailingLlm;

#[cfg(any(test, feature = "test-utils"))]
#[async_trait]
impl LlmService for FailingLlm {
    async fn chat(&self, _system: &str, _user: &str, _max_tokens: usize) -> anyhow::Result<String> {
        anyhow::bail!("LLM service unavailable")
    }
}

#[cfg(any(test, feature = "test-utils"))]
pub struct FailingEmbedding;

#[cfg(any(test, feature = "test-utils"))]
#[async_trait]
impl EmbeddingService for FailingEmbedding {
    async fn embed_batch(&self, _texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        anyhow::bail!("embedding service unavailable")
    }

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

    #[tokio::test]
    async fn failing_embedding_batch_returns_error() {
        let failing = FailingEmbedding;
        let texts = vec!["anything".to_string()];
        let result = failing.embed_batch(&texts).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn fake_embedding_batch_empty_input_returns_empty() {
        let fake = FakeEmbedding::new();
        let results = fake.embed_batch(&[]).await.unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn fake_embedding_batch_results_match_individual() {
        let fake = FakeEmbedding::new();
        let texts = vec![
            "hello world".to_string(),
            "foo bar".to_string(),
            "baz qux".to_string(),
        ];

        let batch_results = fake.embed_batch(&texts).await.unwrap();

        // Each batch result should match calling embed individually
        for (i, text) in texts.iter().enumerate() {
            let individual = fake.embed(text).await.unwrap();
            assert_eq!(batch_results[i], individual, "mismatch at index {i}");
        }
    }

    #[tokio::test]
    async fn fake_llm_returns_deterministic_output() {
        let llm = super::FakeLlm;
        let result = llm.chat("system prompt", "user input", 100).await.unwrap();
        assert!(result.contains("user input"));
    }

    #[tokio::test]
    async fn failing_llm_returns_error() {
        let llm = super::FailingLlm;
        let result = llm.chat("system", "user", 100).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn fake_embedding_batch_returns_correct_count() {
        let fake = FakeEmbedding::new();
        let texts = vec![
            "hello world".to_string(),
            "foo bar".to_string(),
            "baz qux".to_string(),
        ];
        let results = fake.embed_batch(&texts).await.unwrap();
        assert_eq!(results.len(), 3);
        // Each embedding should have the expected dimensionality
        for emb in &results {
            assert_eq!(emb.len(), 256);
        }
    }
}
