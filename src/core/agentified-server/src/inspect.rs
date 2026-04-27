//! `agentified inspect` — serves a self-contained HTML inspector that visualizes recordings
//! from a directory. Pairs with the FinanceBot showcase, which writes recordings into
//! `examples/financebot-showcase/recordings/`.
//!
//! The HTML is embedded at compile time via `include_str!` so there's no asset-path resolution
//! at runtime. The page calls `/api/recordings` to list and inline-fetch all recording JSON.

use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::State,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Serialize;

const INDEX_HTML: &str = include_str!("../assets/inspector.html");

#[derive(Clone)]
struct InspectState {
    recordings_dir: Arc<PathBuf>,
}

pub fn router(recordings_dir: PathBuf) -> Router {
    let state = InspectState {
        recordings_dir: Arc::new(recordings_dir),
    };
    Router::new()
        .route("/", get(serve_index))
        .route("/api/recordings", get(list_recordings))
        .with_state(state)
}

async fn serve_index() -> impl IntoResponse {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(INDEX_HTML.to_string())
        .unwrap()
}

#[derive(Serialize)]
struct RecordingsResponse {
    dir: String,
    recordings: Vec<serde_json::Value>,
}

async fn list_recordings(State(state): State<InspectState>) -> Json<RecordingsResponse> {
    let dir = state.recordings_dir.as_ref();
    let mut recordings: Vec<serde_json::Value> = Vec::new();

    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut paths: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.extension().map(|e| e == "json").unwrap_or(false))
            .collect();
        paths.sort();

        for path in paths {
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("recording")
                .to_string();
            match std::fs::read_to_string(&path) {
                Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
                    Ok(mut value) => {
                        if let Some(obj) = value.as_object_mut() {
                            obj.entry("name".to_string())
                                .or_insert(serde_json::Value::String(name.clone()));
                        }
                        recordings.push(value);
                    }
                    Err(e) => recordings.push(serde_json::json!({
                        "name": name,
                        "label": format!("{} (parse error)", name),
                        "error": e.to_string(),
                    })),
                },
                Err(e) => recordings.push(serde_json::json!({
                    "name": name,
                    "label": format!("{} (read error)", name),
                    "error": e.to_string(),
                })),
            }
        }
    }

    Json(RecordingsResponse {
        dir: dir.display().to_string(),
        recordings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tempfile::tempdir;
    use tower::ServiceExt;

    #[tokio::test]
    async fn serves_index_html() {
        let dir = tempdir().unwrap();
        let app = router(dir.path().to_path_buf());
        let res = app
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let html = String::from_utf8(body.to_vec()).unwrap();
        assert!(html.contains("Agentified Inspector"));
    }

    #[tokio::test]
    async fn lists_recordings_from_directory() {
        let dir = tempdir().unwrap();
        let raw_path = dir.path().join("raw.json");
        std::fs::write(
            &raw_path,
            r#"{"label":"Raw 100 tools","metrics":{"tools_loaded":100}}"#,
        )
        .unwrap();
        let curated_path = dir.path().join("agentified.json");
        std::fs::write(
            &curated_path,
            r#"{"label":"Agentified-curated","metrics":{"tools_loaded":7}}"#,
        )
        .unwrap();

        let app = router(dir.path().to_path_buf());
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/recordings")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let recs = json["recordings"].as_array().unwrap();
        assert_eq!(recs.len(), 2);
        // Sorted alphabetically: agentified.json, then raw.json
        assert_eq!(recs[0]["label"], "Agentified-curated");
        assert_eq!(recs[1]["label"], "Raw 100 tools");
    }

    #[tokio::test]
    async fn missing_recordings_dir_returns_empty_list() {
        let app = router(PathBuf::from("/nonexistent/path/that/does/not/exist"));
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/recordings")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let recs = json["recordings"].as_array().unwrap();
        assert_eq!(recs.len(), 0);
    }
}
