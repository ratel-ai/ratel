use anyhow::Result;

use crate::models::{MessageInput, StoredMessage, StoredTool, Turn};

// Trait

pub trait Storage: Send + Sync {
    fn save_tools(&self, dataset_id: &str, tools: &[(&str, &StoredTool)]) -> Result<()>;
    fn load_tools_for_dataset(&self, dataset_id: &str) -> Result<Vec<(String, StoredTool)>>;
    fn save_turn(&self, id: &str, turn: &Turn) -> Result<()>;
    fn load_all_turns(&self) -> Result<Vec<(String, Turn)>>;
    fn save_embeddings(&self, entries: &[(&str, &[f32])]) -> Result<()>;
    fn load_all_embeddings(&self) -> Result<Vec<(String, Vec<f32>)>>;
    fn append_messages(&self, dataset: &str, namespace: &str, session: &str, messages: &[MessageInput]) -> Result<(i64, i64)>;
    fn get_messages(&self, dataset: &str, namespace: &str, session: &str, limit: i64, after_seq: Option<i64>, around_seq: Option<i64>) -> Result<(Vec<StoredMessage>, bool, i64)>;
    fn save_session_tools(&self, dataset: &str, namespace: &str, session: &str, tool_names: &[&str]) -> Result<()>;
    fn load_session_tools(&self, dataset: &str, namespace: &str, session: &str) -> Result<Vec<String>>;
}

// Blob helpers

fn vec_f32_to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

fn blob_to_vec_f32(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

// NoopStorage

pub struct NoopStorage;

impl Storage for NoopStorage {
    fn save_tools(&self, _dataset_id: &str, _tools: &[(&str, &StoredTool)]) -> Result<()> {
        Ok(())
    }
    fn load_tools_for_dataset(&self, _dataset_id: &str) -> Result<Vec<(String, StoredTool)>> {
        Ok(vec![])
    }
    fn save_turn(&self, _id: &str, _turn: &Turn) -> Result<()> {
        Ok(())
    }
    fn load_all_turns(&self) -> Result<Vec<(String, Turn)>> {
        Ok(vec![])
    }
    fn save_embeddings(&self, _entries: &[(&str, &[f32])]) -> Result<()> {
        Ok(())
    }
    fn load_all_embeddings(&self) -> Result<Vec<(String, Vec<f32>)>> {
        Ok(vec![])
    }
    fn append_messages(&self, _dataset: &str, _namespace: &str, _session: &str, _messages: &[MessageInput]) -> Result<(i64, i64)> {
        Ok((0, 0))
    }
    fn get_messages(&self, _dataset: &str, _namespace: &str, _session: &str, _limit: i64, _after_seq: Option<i64>, _around_seq: Option<i64>) -> Result<(Vec<StoredMessage>, bool, i64)> {
        Ok((vec![], false, 0))
    }
    fn save_session_tools(&self, _dataset: &str, _namespace: &str, _session: &str, _tool_names: &[&str]) -> Result<()> {
        Ok(())
    }
    fn load_session_tools(&self, _dataset: &str, _namespace: &str, _session: &str) -> Result<Vec<String>> {
        Ok(vec![])
    }
}

// SqliteStorage

pub struct SqliteStorage {
    conn: std::sync::Mutex<rusqlite::Connection>,
}

impl SqliteStorage {
    pub fn new(path: &str) -> Result<Self> {
        let conn = rusqlite::Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;"
        )?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS tools (
                dataset_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                parameters TEXT NOT NULL,
                metadata TEXT,
                fields TEXT,
                emb_name BLOB,
                emb_description BLOB,
                emb_input_schema BLOB,
                emb_output_schema BLOB,
                bm25_text TEXT NOT NULL,
                PRIMARY KEY (dataset_id, name)
            );
            CREATE INDEX IF NOT EXISTS idx_tools_dataset ON tools(dataset_id);
            CREATE TABLE IF NOT EXISTS turns (
                id TEXT PRIMARY KEY,
                tools_loaded TEXT NOT NULL,
                message TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS embedding_cache (
                text_content TEXT PRIMARY KEY,
                embedding BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL DEFAULT 'default',
                namespace_id TEXT NOT NULL DEFAULT 'default',
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                tool_call_id TEXT,
                tool_calls TEXT,
                created_at TEXT NOT NULL,
                seq INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(dataset_id, namespace_id, session_id, seq);
            CREATE TABLE IF NOT EXISTS session_tools (
                dataset_id TEXT NOT NULL,
                namespace_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                PRIMARY KEY (dataset_id, namespace_id, session_id, tool_name)
            );"
        )?;
        Ok(Self { conn: std::sync::Mutex::new(conn) })
    }
}

impl Storage for SqliteStorage {
    fn save_tools(&self, dataset_id: &str, tools: &[(&str, &StoredTool)]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        for (name, stored) in tools {
            let params_json = serde_json::to_string(&stored.tool.parameters)?;
            let metadata_json = stored.tool.metadata.as_ref().map(|m| serde_json::to_string(m)).transpose()?;
            let fields_json = stored.tool.fields.as_ref().map(|f| serde_json::to_string(f)).transpose()?;
            let (emb_name, emb_desc, emb_input, emb_output) = match &stored.embeddings {
                Some(emb) => (
                    Some(vec_f32_to_blob(&emb.name)),
                    Some(vec_f32_to_blob(&emb.description)),
                    emb.input_schema.as_ref().map(|v| vec_f32_to_blob(v)),
                    emb.output_schema.as_ref().map(|v| vec_f32_to_blob(v)),
                ),
                None => (None, None, None, None),
            };
            tx.execute(
                "INSERT OR REPLACE INTO tools (dataset_id, name, description, parameters, metadata, fields, emb_name, emb_description, emb_input_schema, emb_output_schema, bm25_text)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                rusqlite::params![dataset_id, name, stored.tool.description, params_json, metadata_json, fields_json, emb_name, emb_desc, emb_input, emb_output, stored.bm25_text],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn load_tools_for_dataset(&self, dataset_id: &str) -> Result<Vec<(String, StoredTool)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT name, description, parameters, metadata, fields, emb_name, emb_description, emb_input_schema, emb_output_schema, bm25_text FROM tools WHERE dataset_id = ?1"
        )?;
        let rows = stmt.query_map(rusqlite::params![dataset_id], |row| {
            let name: String = row.get(0)?;
            let description: String = row.get(1)?;
            let params_json: String = row.get(2)?;
            let metadata_json: Option<String> = row.get(3)?;
            let fields_json: Option<String> = row.get(4)?;
            let emb_name_blob: Option<Vec<u8>> = row.get(5)?;
            let emb_desc_blob: Option<Vec<u8>> = row.get(6)?;
            let emb_input_blob: Option<Vec<u8>> = row.get(7)?;
            let emb_output_blob: Option<Vec<u8>> = row.get(8)?;
            let bm25_text: String = row.get(9)?;
            Ok((name, description, params_json, metadata_json, fields_json, emb_name_blob, emb_desc_blob, emb_input_blob, emb_output_blob, bm25_text))
        })?;

        let mut result = Vec::new();
        for row in rows {
            let (name, description, params_json, metadata_json, fields_json, emb_name_blob, emb_desc_blob, emb_input_blob, emb_output_blob, bm25_text) = row?;
            let parameters: serde_json::Value = serde_json::from_str(&params_json)?;
            let metadata: Option<serde_json::Value> = metadata_json.map(|s| serde_json::from_str(&s)).transpose()?;
            let fields: Option<crate::models::ToolFields> = fields_json.map(|s| serde_json::from_str(&s)).transpose()?;

            let embeddings = match (emb_name_blob, emb_desc_blob) {
                (Some(name_b), Some(desc_b)) => Some(crate::models::FieldEmbeddings {
                    name: blob_to_vec_f32(&name_b),
                    description: blob_to_vec_f32(&desc_b),
                    input_schema: emb_input_blob.map(|b| blob_to_vec_f32(&b)),
                    output_schema: emb_output_blob.map(|b| blob_to_vec_f32(&b)),
                }),
                _ => None,
            };

            result.push((name.clone(), StoredTool {
                tool: crate::models::Tool {
                    name,
                    description,
                    parameters,
                    metadata,
                    fields,
                },
                embeddings,
                bm25_text,
            }));
        }
        Ok(result)
    }

    fn save_turn(&self, id: &str, turn: &Turn) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let tools_json = serde_json::to_string(&turn.tools_loaded)?;
        conn.execute(
            "INSERT OR REPLACE INTO turns (id, tools_loaded, message) VALUES (?1, ?2, ?3)",
            rusqlite::params![id, tools_json, turn.message],
        )?;
        Ok(())
    }

    fn load_all_turns(&self) -> Result<Vec<(String, Turn)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, tools_loaded, message FROM turns")?;
        let rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let tools_json: String = row.get(1)?;
            let message: String = row.get(2)?;
            Ok((id, tools_json, message))
        })?;

        let mut result = Vec::new();
        for row in rows {
            let (id, tools_json, message) = row?;
            let tools_loaded: Vec<String> = serde_json::from_str(&tools_json)?;
            result.push((id, Turn { tools_loaded, message }));
        }
        Ok(result)
    }

    fn save_embeddings(&self, entries: &[(&str, &[f32])]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        for (text, emb) in entries {
            let blob = vec_f32_to_blob(emb);
            tx.execute(
                "INSERT OR REPLACE INTO embedding_cache (text_content, embedding) VALUES (?1, ?2)",
                rusqlite::params![text, blob],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn load_all_embeddings(&self) -> Result<Vec<(String, Vec<f32>)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT text_content, embedding FROM embedding_cache")?;
        let rows = stmt.query_map([], |row| {
            let text: String = row.get(0)?;
            let blob: Vec<u8> = row.get(1)?;
            Ok((text, blob))
        })?;

        let mut result = Vec::new();
        for row in rows {
            let (text, blob) = row?;
            result.push((text, blob_to_vec_f32(&blob)));
        }
        Ok(result)
    }

    fn append_messages(&self, dataset: &str, namespace: &str, session: &str, messages: &[MessageInput]) -> Result<(i64, i64)> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;

        let max_seq: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM messages WHERE dataset_id = ?1 AND namespace_id = ?2 AND session_id = ?3",
            rusqlite::params![dataset, namespace, session],
            |row| row.get(0),
        )?;

        let first_seq = max_seq + 1;
        let now = chrono::Utc::now().to_rfc3339();

        for (i, msg) in messages.iter().enumerate() {
            let seq = first_seq + i as i64;
            let id = uuid::Uuid::new_v4().to_string();
            let tool_calls_json = msg.tool_calls.as_ref().map(|v| serde_json::to_string(v)).transpose()?;
            tx.execute(
                "INSERT INTO messages (id, dataset_id, namespace_id, session_id, role, content, tool_call_id, tool_calls, created_at, seq)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                rusqlite::params![id, dataset, namespace, session, msg.role, msg.content, msg.tool_call_id, tool_calls_json, now, seq],
            )?;
        }

        tx.commit()?;
        let last_seq = first_seq + messages.len() as i64 - 1;
        Ok((first_seq, last_seq))
    }

    fn get_messages(&self, dataset: &str, namespace: &str, session: &str, limit: i64, after_seq: Option<i64>, around_seq: Option<i64>) -> Result<(Vec<StoredMessage>, bool, i64)> {
        let conn = self.conn.lock().unwrap();

        let max_seq: i64 = conn.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM messages WHERE dataset_id = ?1 AND namespace_id = ?2 AND session_id = ?3",
            rusqlite::params![dataset, namespace, session],
            |row| row.get(0),
        )?;

        if limit == 0 {
            return Ok((vec![], false, max_seq));
        }

        let (query, params): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = if let Some(after) = after_seq {
            (
                format!("SELECT id, role, content, tool_call_id, tool_calls, created_at, seq FROM messages WHERE dataset_id = ?1 AND namespace_id = ?2 AND session_id = ?3 AND seq > ?4 ORDER BY seq ASC LIMIT ?5"),
                vec![Box::new(dataset.to_string()), Box::new(namespace.to_string()), Box::new(session.to_string()), Box::new(after), Box::new(limit + 1)],
            )
        } else if let Some(around) = around_seq {
            let half = limit / 2;
            let start = (around - half).max(1);
            let fetch = limit + 1;
            (
                format!("SELECT id, role, content, tool_call_id, tool_calls, created_at, seq FROM messages WHERE dataset_id = ?1 AND namespace_id = ?2 AND session_id = ?3 AND seq >= ?4 ORDER BY seq ASC LIMIT ?5"),
                vec![Box::new(dataset.to_string()), Box::new(namespace.to_string()), Box::new(session.to_string()), Box::new(start), Box::new(fetch)],
            )
        } else {
            // Default: last N messages ascending
            // Fetch limit+1 desc, reverse to asc, then check has_more
            (
                format!("SELECT id, role, content, tool_call_id, tool_calls, created_at, seq FROM (SELECT id, role, content, tool_call_id, tool_calls, created_at, seq FROM messages WHERE dataset_id = ?1 AND namespace_id = ?2 AND session_id = ?3 ORDER BY seq DESC LIMIT ?4) sub ORDER BY seq ASC"),
                vec![Box::new(dataset.to_string()), Box::new(namespace.to_string()), Box::new(session.to_string()), Box::new(limit + 1)],
            )
        };

        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&query)?;
        let rows = stmt.query_map(param_refs.as_slice(), |row| {
            let tool_calls_str: Option<String> = row.get(4)?;
            Ok(StoredMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                tool_call_id: row.get(3)?,
                tool_calls: tool_calls_str.and_then(|s| serde_json::from_str(&s).ok()),
                created_at: row.get(5)?,
                seq: row.get(6)?,
            })
        })?;

        let mut messages: Vec<StoredMessage> = Vec::new();
        for row in rows {
            messages.push(row?);
        }

        let has_more = messages.len() as i64 > limit;
        if has_more {
            if after_seq.is_some() || around_seq.is_some() {
                // Forward/around: drop last extra
                messages.truncate(limit as usize);
            } else {
                // Default (last N): drop first extra (oldest)
                messages.remove(0);
            }
        }

        Ok((messages, has_more, max_seq))
    }

    fn save_session_tools(&self, dataset: &str, namespace: &str, session: &str, tool_names: &[&str]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM session_tools WHERE dataset_id = ?1 AND namespace_id = ?2 AND session_id = ?3",
            rusqlite::params![dataset, namespace, session],
        )?;
        for name in tool_names {
            tx.execute(
                "INSERT INTO session_tools (dataset_id, namespace_id, session_id, tool_name) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![dataset, namespace, session, name],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn load_session_tools(&self, dataset: &str, namespace: &str, session: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT tool_name FROM session_tools WHERE dataset_id = ?1 AND namespace_id = ?2 AND session_id = ?3"
        )?;
        let names: Vec<String> = stmt.query_map(rusqlite::params![dataset, namespace, session], |row| {
            row.get(0)
        })?.filter_map(|r| r.ok()).collect();
        Ok(names)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{FieldEmbeddings, Tool, ToolFields};

    // Phase 1: blob helpers + NoopStorage

    #[test]
    fn blob_roundtrip() {
        let v = vec![1.0_f32, -2.5, 0.0, std::f32::consts::PI];
        let blob = vec_f32_to_blob(&v);
        let back = blob_to_vec_f32(&blob);
        assert_eq!(v, back);
    }

    #[test]
    fn noop_save_load_tools_returns_empty() {
        let s = NoopStorage;
        s.save_tools("ds-1", &[]).unwrap();
        assert!(s.load_tools_for_dataset("ds-1").unwrap().is_empty());
    }

    #[test]
    fn noop_save_load_turns_returns_empty() {
        let s = NoopStorage;
        s.save_turn("id", &Turn { tools_loaded: vec![], message: "m".into() }).unwrap();
        assert!(s.load_all_turns().unwrap().is_empty());
    }

    // Phase 2: SqliteStorage

    fn make_stored_tool(name: &str, desc: &str, with_fields: bool) -> StoredTool {
        StoredTool {
            tool: Tool {
                name: name.into(),
                description: desc.into(),
                parameters: serde_json::json!({"type": "object"}),
                metadata: Some(serde_json::json!({"tag": "test"})),
                fields: if with_fields {
                    Some(ToolFields {
                        name: name.into(),
                        description: desc.into(),
                        input_schema: Some("{ id: string }".into()),
                        output_schema: Some("{ ok: bool }".into()),
                    })
                } else {
                    None
                },
            },
            embeddings: Some(FieldEmbeddings {
                name: vec![1.0; 4],
                description: vec![2.0; 4],
                input_schema: if with_fields { Some(vec![3.0; 4]) } else { None },
                output_schema: if with_fields { Some(vec![4.0; 4]) } else { None },
            }),
            bm25_text: format!("{name} {desc}"),
        }
    }

    #[test]
    fn sqlite_roundtrip_tools() {
        let s = SqliteStorage::new(":memory:").unwrap();
        let tool = make_stored_tool("getThing", "Get a thing", true);
        s.save_tools("ds-1", &[("getThing", &tool)]).unwrap();
        let loaded = s.load_tools_for_dataset("ds-1").unwrap();
        assert_eq!(loaded.len(), 1);
        let (name, st) = &loaded[0];
        assert_eq!(name, "getThing");
        assert_eq!(st.tool.name, "getThing");
        assert_eq!(st.tool.description, "Get a thing");
        let emb = st.embeddings.as_ref().unwrap();
        assert_eq!(emb.name, vec![1.0; 4]);
        assert_eq!(emb.description, vec![2.0; 4]);
        assert_eq!(emb.input_schema.as_ref().unwrap(), &vec![3.0; 4]);
        assert_eq!(emb.output_schema.as_ref().unwrap(), &vec![4.0; 4]);
        assert_eq!(st.bm25_text, "getThing Get a thing");
        assert!(st.tool.fields.is_some());
        assert!(st.tool.metadata.is_some());
    }

    #[test]
    fn sqlite_tool_upsert_replaces() {
        let s = SqliteStorage::new(":memory:").unwrap();
        let t1 = make_stored_tool("t", "v1", false);
        s.save_tools("ds-1", &[("t", &t1)]).unwrap();
        let t2 = make_stored_tool("t", "v2", false);
        s.save_tools("ds-1", &[("t", &t2)]).unwrap();
        let loaded = s.load_tools_for_dataset("ds-1").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].1.tool.description, "v2");
    }

    #[test]
    fn sqlite_tool_with_null_optional_fields() {
        let s = SqliteStorage::new(":memory:").unwrap();
        let mut tool = make_stored_tool("t", "d", false);
        tool.tool.metadata = None;
        tool.tool.fields = None;
        tool.embeddings.as_mut().unwrap().input_schema = None;
        tool.embeddings.as_mut().unwrap().output_schema = None;
        s.save_tools("ds-1", &[("t", &tool)]).unwrap();
        let loaded = s.load_tools_for_dataset("ds-1").unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(loaded[0].1.tool.metadata.is_none());
        assert!(loaded[0].1.tool.fields.is_none());
        let emb = loaded[0].1.embeddings.as_ref().unwrap();
        assert!(emb.input_schema.is_none());
        assert!(emb.output_schema.is_none());
    }

    #[test]
    fn sqlite_roundtrip_tool_without_embeddings() {
        let s = SqliteStorage::new(":memory:").unwrap();
        let tool = StoredTool {
            tool: Tool {
                name: "bm25only".into(),
                description: "A BM25-only tool".into(),
                parameters: serde_json::json!({"type": "object"}),
                metadata: None,
                fields: None,
            },
            embeddings: None,
            bm25_text: "bm25only A BM25-only tool".into(),
        };
        s.save_tools("ds-1", &[("bm25only", &tool)]).unwrap();
        let loaded = s.load_tools_for_dataset("ds-1").unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(loaded[0].1.embeddings.is_none());
        assert_eq!(loaded[0].1.bm25_text, "bm25only A BM25-only tool");
    }

    #[test]
    fn sqlite_roundtrip_turn() {
        let s = SqliteStorage::new(":memory:").unwrap();
        let turn = Turn { tools_loaded: vec!["a".into(), "b".into()], message: "hello".into() };
        s.save_turn("t1", &turn).unwrap();
        let loaded = s.load_all_turns().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].0, "t1");
        assert_eq!(loaded[0].1.tools_loaded, vec!["a", "b"]);
        assert_eq!(loaded[0].1.message, "hello");
    }

    #[test]
    fn sqlite_load_missing_turn() {
        let s = SqliteStorage::new(":memory:").unwrap();
        let loaded = s.load_all_turns().unwrap();
        assert!(loaded.is_empty());
    }

    #[test]
    fn sqlite_roundtrip_embeddings() {
        let s = SqliteStorage::new(":memory:").unwrap();
        let emb = vec![0.1_f32, 0.2, 0.3];
        s.save_embeddings(&[("hello", &emb)]).unwrap();
        let loaded = s.load_all_embeddings().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].0, "hello");
        assert_eq!(loaded[0].1, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn sqlite_embedding_upsert() {
        let s = SqliteStorage::new(":memory:").unwrap();
        s.save_embeddings(&[("txt", &[1.0, 2.0])]).unwrap();
        s.save_embeddings(&[("txt", &[3.0, 4.0])]).unwrap();
        let loaded = s.load_all_embeddings().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].1, vec![3.0, 4.0]);
    }

    #[test]
    fn sqlite_session_tools_roundtrip() {
        let s = SqliteStorage::new(":memory:").unwrap();
        s.save_session_tools("ds", "ns", "s1", &["tool_a", "tool_b"]).unwrap();
        let loaded = s.load_session_tools("ds", "ns", "s1").unwrap();
        assert_eq!(loaded.len(), 2);
        assert!(loaded.contains(&"tool_a".to_string()));
        assert!(loaded.contains(&"tool_b".to_string()));
    }

    #[test]
    fn sqlite_session_tools_scoped() {
        let s = SqliteStorage::new(":memory:").unwrap();
        s.save_session_tools("ds", "ns", "s1", &["tool_a"]).unwrap();
        s.save_session_tools("ds", "ns", "s2", &["tool_b"]).unwrap();
        assert_eq!(s.load_session_tools("ds", "ns", "s1").unwrap(), vec!["tool_a"]);
        assert_eq!(s.load_session_tools("ds", "ns", "s2").unwrap(), vec!["tool_b"]);
    }

    #[test]
    fn noop_session_tools_returns_empty() {
        let s = NoopStorage;
        assert!(s.load_session_tools("ds", "ns", "s1").unwrap().is_empty());
    }
}
