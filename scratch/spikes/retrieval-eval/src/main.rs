//! Retrieval × embedding eval harness for ADR 0009.
//!
//! Runs a (retrieval method × embedding model) matrix over a tool corpus +
//! labeled query set, measures recall@5, recall@10, and per-query CPU latency.
//!
//! See ../README.md for run instructions and corpus/query format.

use anyhow::{Context, Result};
use clap::Parser;
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Instant;

#[derive(Parser)]
#[command(about = "Retrieval × embedding evaluation for ADR 0009")]
struct Cli {
    /// Path to tool corpus JSONL ({id, name, description} per line).
    #[arg(long, default_value = "data/corpus.jsonl")]
    corpus: PathBuf,

    /// Path to query set JSONL ({text, relevant_ids[]} per line).
    #[arg(long, default_value = "data/queries.jsonl")]
    queries: PathBuf,

    /// Comma-separated embedding model identifiers. Recognized:
    /// "bge-small", "minilm-l6", "gte-base", "jina-base".
    #[arg(long, default_value = "bge-small,minilm-l6,gte-base,jina-base")]
    models: String,
}

#[derive(Deserialize, Clone)]
struct Tool {
    id: String,
    name: String,
    description: String,
}

#[derive(Deserialize)]
struct Query {
    text: String,
    relevant_ids: Vec<String>,
}

#[derive(Serialize)]
struct Row {
    method: String,
    model: Option<String>,
    recall_at_5: f64,
    recall_at_10: f64,
    avg_query_ms: f64,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let corpus: Vec<Tool> = load_jsonl(&cli.corpus).context("loading corpus")?;
    let queries: Vec<Query> = load_jsonl(&cli.queries).context("loading queries")?;
    println!(
        "Loaded {} tools, {} queries\n",
        corpus.len(),
        queries.len()
    );

    let mut rows: Vec<Row> = Vec::new();
    rows.push(run_bm25(&corpus, &queries)?);

    for model_str in cli.models.split(',') {
        let model_str = model_str.trim();
        let model = parse_model(model_str)
            .with_context(|| format!("unrecognized model identifier: {model_str}"))?;
        let (vector_row, doc_emb, query_emb, query_ms) =
            run_vector(model_str, model.clone(), &corpus, &queries)?;
        rows.push(vector_row);
        rows.push(run_hybrid(
            model_str, &corpus, &queries, &doc_emb, &query_emb, query_ms,
        )?);
    }

    print_table(&rows);
    Ok(())
}

fn parse_model(s: &str) -> Result<EmbeddingModel> {
    // Variants spelled per the fastembed crate's EmbeddingModel enum (v5).
    // If a name fails to compile after a fastembed bump, fix here.
    Ok(match s {
        "bge-small" => EmbeddingModel::BGESmallENV15,
        "minilm-l6" => EmbeddingModel::AllMiniLML6V2,
        "gte-base" => EmbeddingModel::GTEBaseENV15,
        "jina-base" => EmbeddingModel::JinaEmbeddingsV2BaseEN,
        other => anyhow::bail!("unknown model alias: {other}"),
    })
}

fn load_jsonl<T: for<'de> Deserialize<'de>>(path: &PathBuf) -> Result<Vec<T>> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.display()))?;
    raw.lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(i, line)| {
            serde_json::from_str(line).with_context(|| format!("parsing line {} of jsonl", i + 1))
        })
        .collect()
}

fn run_bm25(corpus: &[Tool], queries: &[Query]) -> Result<Row> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(
        "CREATE VIRTUAL TABLE tools USING fts5(\
         id UNINDEXED, name, description, tokenize='porter unicode61'\
         )",
    )?;
    {
        let mut insert =
            conn.prepare("INSERT INTO tools (id, name, description) VALUES (?, ?, ?)")?;
        for tool in corpus {
            insert.execute([&tool.id, &tool.name, &tool.description])?;
        }
    }

    let mut total_r5 = 0.0_f64;
    let mut total_r10 = 0.0_f64;
    let mut total_ms = 0.0_f64;

    for q in queries {
        let start = Instant::now();
        let results = fts5_search(&conn, &q.text, 10)?;
        total_ms += start.elapsed().as_secs_f64() * 1000.0;
        let (r5, r10) = recall(&results, &q.relevant_ids);
        total_r5 += r5;
        total_r10 += r10;
    }
    let n = queries.len() as f64;
    Ok(Row {
        method: "BM25 (FTS5)".to_string(),
        model: None,
        recall_at_5: total_r5 / n,
        recall_at_10: total_r10 / n,
        avg_query_ms: total_ms / n,
    })
}

fn fts5_search(conn: &Connection, query: &str, k: usize) -> Result<Vec<String>> {
    // FTS5 MATCH chokes on bare keywords with apostrophes / control chars; sanitize naively.
    let sanitized = query
        .replace(['"', '\''], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if sanitized.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare("SELECT id FROM tools WHERE tools MATCH ? ORDER BY rank LIMIT ?")?;
    let rows = stmt.query_map(rusqlite::params![&sanitized, k as i64], |r| {
        r.get::<_, String>(0)
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

#[allow(clippy::type_complexity)]
fn run_vector(
    model_alias: &str,
    model: EmbeddingModel,
    corpus: &[Tool],
    queries: &[Query],
) -> Result<(Row, Vec<Vec<f32>>, Vec<Vec<f32>>, f64)> {
    let mut embedder = TextEmbedding::try_new(InitOptions::new(model))
        .context("initializing fastembed model (first run downloads weights)")?;

    let docs: Vec<String> = corpus
        .iter()
        .map(|t| format!("{}\n{}", t.name, t.description))
        .collect();
    let doc_emb = embedder.embed(docs, None)?;

    let mut query_emb: Vec<Vec<f32>> = Vec::with_capacity(queries.len());
    let mut total_ms = 0.0_f64;
    for q in queries {
        let start = Instant::now();
        let emb = embedder.embed(vec![q.text.clone()], None)?;
        total_ms += start.elapsed().as_secs_f64() * 1000.0;
        query_emb.push(emb.into_iter().next().unwrap());
    }
    let avg_query_ms = total_ms / queries.len() as f64;

    let mut total_r5 = 0.0_f64;
    let mut total_r10 = 0.0_f64;
    for (q, q_emb) in queries.iter().zip(&query_emb) {
        let ranked = vector_rank(corpus, &doc_emb, q_emb, 10);
        let (r5, r10) = recall(&ranked, &q.relevant_ids);
        total_r5 += r5;
        total_r10 += r10;
    }
    let n = queries.len() as f64;

    let row = Row {
        method: "Vector (cosine)".to_string(),
        model: Some(model_alias.to_string()),
        recall_at_5: total_r5 / n,
        recall_at_10: total_r10 / n,
        avg_query_ms,
    };
    Ok((row, doc_emb, query_emb, avg_query_ms))
}

fn vector_rank(corpus: &[Tool], doc_emb: &[Vec<f32>], q_emb: &[f32], k: usize) -> Vec<String> {
    let mut scored: Vec<(String, f32)> = corpus
        .iter()
        .zip(doc_emb)
        .map(|(t, e)| (t.id.clone(), cosine(q_emb, e)))
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().take(k).map(|(id, _)| id).collect()
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na * nb)
    }
}

fn run_hybrid(
    model_alias: &str,
    corpus: &[Tool],
    queries: &[Query],
    doc_emb: &[Vec<f32>],
    query_emb: &[Vec<f32>],
    vector_query_ms: f64,
) -> Result<Row> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(
        "CREATE VIRTUAL TABLE tools USING fts5(\
         id UNINDEXED, name, description, tokenize='porter unicode61'\
         )",
    )?;
    {
        let mut insert =
            conn.prepare("INSERT INTO tools (id, name, description) VALUES (?, ?, ?)")?;
        for tool in corpus {
            insert.execute([&tool.id, &tool.name, &tool.description])?;
        }
    }

    let mut total_r5 = 0.0_f64;
    let mut total_r10 = 0.0_f64;
    let mut total_ms = 0.0_f64;

    for (q, q_emb) in queries.iter().zip(query_emb) {
        let start = Instant::now();
        let bm25 = fts5_search(&conn, &q.text, 10)?;
        let vec_ranked = vector_rank(corpus, doc_emb, q_emb, 10);
        let fused = rrf(&[bm25, vec_ranked], 60);
        total_ms += start.elapsed().as_secs_f64() * 1000.0;
        let (r5, r10) = recall(&fused, &q.relevant_ids);
        total_r5 += r5;
        total_r10 += r10;
    }
    let n = queries.len() as f64;
    Ok(Row {
        method: "Hybrid (RRF)".to_string(),
        model: Some(model_alias.to_string()),
        recall_at_5: total_r5 / n,
        recall_at_10: total_r10 / n,
        // Hybrid latency includes the vector query embedding cost (which dominates) +
        // the FTS5 + fusion overhead measured here.
        avg_query_ms: vector_query_ms + total_ms / n,
    })
}

/// Reciprocal Rank Fusion. `k` is the standard RRF constant (60 in the original paper).
fn rrf(rankings: &[Vec<String>], k: usize) -> Vec<String> {
    let mut scores: HashMap<String, f64> = HashMap::new();
    for ranking in rankings {
        for (i, id) in ranking.iter().enumerate() {
            let s = 1.0 / (k as f64 + i as f64 + 1.0);
            *scores.entry(id.clone()).or_insert(0.0) += s;
        }
    }
    let mut sorted: Vec<(String, f64)> = scores.into_iter().collect();
    sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    sorted.into_iter().map(|(id, _)| id).collect()
}

/// Returns (recall@5, recall@10) for a single query — 1.0 if any relevant id appears
/// in the top-K, 0.0 otherwise. Pessimistic: counts a query as "found" only if at
/// least one ground-truth id is in top-K, regardless of how many are.
fn recall(ranked_ids: &[String], relevant: &[String]) -> (f64, f64) {
    let relevant_set: HashSet<&String> = relevant.iter().collect();
    let top5: HashSet<&String> = ranked_ids.iter().take(5).collect();
    let top10: HashSet<&String> = ranked_ids.iter().take(10).collect();
    let r5 = if top5.intersection(&relevant_set).next().is_some() {
        1.0
    } else {
        0.0
    };
    let r10 = if top10.intersection(&relevant_set).next().is_some() {
        1.0
    } else {
        0.0
    };
    (r5, r10)
}

fn print_table(rows: &[Row]) {
    println!(
        "{:<18} {:<14} {:>10} {:>10} {:>12}",
        "Method", "Model", "Recall@5", "Recall@10", "Avg ms/query"
    );
    println!("{}", "-".repeat(70));
    for r in rows {
        println!(
            "{:<18} {:<14} {:>10.3} {:>10.3} {:>12.2}",
            r.method,
            r.model.as_deref().unwrap_or("-"),
            r.recall_at_5,
            r.recall_at_10,
            r.avg_query_ms
        );
    }
}
