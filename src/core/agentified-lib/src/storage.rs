use anyhow::Result;

use crate::models::{Instance, StoredTool, Turn};

// Trait

pub trait Storage: Send + Sync {
    fn save_tools(&self, instance_id: &str, tools: &[(&str, &StoredTool)]) -> Result<()>;
    fn load_tools_for_instance(&self, instance_id: &str) -> Result<Vec<(String, StoredTool)>>;
    fn save_turn(&self, id: &str, turn: &Turn) -> Result<()>;
    fn load_all_turns(&self) -> Result<Vec<(String, Turn)>>;
    fn save_embeddings(&self, entries: &[(&str, &[f32])]) -> Result<()>;
    fn load_all_embeddings(&self) -> Result<Vec<(String, Vec<f32>)>>;
    fn save_instance(&self, instance: &Instance) -> Result<()>;
    fn get_instance(&self, instance_id: &str) -> Result<Option<Instance>>;
    fn delete_instance(&self, instance_id: &str) -> Result<bool>;
    fn delete_tools_for_instance(&self, instance_id: &str) -> Result<()>;
    fn update_heartbeat(&self, instance_id: &str, heartbeat: &str) -> Result<bool>;
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
    fn save_tools(&self, _instance_id: &str, _tools: &[(&str, &StoredTool)]) -> Result<()> {
        Ok(())
    }
    fn load_tools_for_instance(&self, _instance_id: &str) -> Result<Vec<(String, StoredTool)>> {
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
    fn save_instance(&self, _instance: &Instance) -> Result<()> {
        Ok(())
    }
    fn get_instance(&self, _instance_id: &str) -> Result<Option<Instance>> {
        Ok(None)
    }
    fn delete_instance(&self, _instance_id: &str) -> Result<bool> {
        Ok(false)
    }
    fn delete_tools_for_instance(&self, _instance_id: &str) -> Result<()> {
        Ok(())
    }
    fn update_heartbeat(&self, _instance_id: &str, _heartbeat: &str) -> Result<bool> {
        Ok(false)
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
                instance_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                parameters TEXT NOT NULL,
                metadata TEXT,
                fields TEXT,
                emb_name BLOB NOT NULL,
                emb_description BLOB NOT NULL,
                emb_input_schema BLOB,
                emb_output_schema BLOB,
                bm25_text TEXT NOT NULL,
                PRIMARY KEY (instance_id, name)
            );
            CREATE INDEX IF NOT EXISTS idx_tools_instance ON tools(instance_id);
            CREATE TABLE IF NOT EXISTS turns (
                id TEXT PRIMARY KEY,
                tools_loaded TEXT NOT NULL,
                message TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS embedding_cache (
                text_content TEXT PRIMARY KEY,
                embedding BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS instances (
                instance_id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                last_heartbeat TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_instances_dataset ON instances(dataset_id);
            CREATE INDEX IF NOT EXISTS idx_instances_heartbeat ON instances(last_heartbeat);"
        )?;
        Ok(Self { conn: std::sync::Mutex::new(conn) })
    }
}

impl Storage for SqliteStorage {
    fn save_tools(&self, instance_id: &str, tools: &[(&str, &StoredTool)]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        for (name, stored) in tools {
            let params_json = serde_json::to_string(&stored.tool.parameters)?;
            let metadata_json = stored.tool.metadata.as_ref().map(|m| serde_json::to_string(m)).transpose()?;
            let fields_json = stored.tool.fields.as_ref().map(|f| serde_json::to_string(f)).transpose()?;
            let emb_name = vec_f32_to_blob(&stored.embeddings.name);
            let emb_desc = vec_f32_to_blob(&stored.embeddings.description);
            let emb_input = stored.embeddings.input_schema.as_ref().map(|v| vec_f32_to_blob(v));
            let emb_output = stored.embeddings.output_schema.as_ref().map(|v| vec_f32_to_blob(v));
            tx.execute(
                "INSERT OR REPLACE INTO tools (instance_id, name, description, parameters, metadata, fields, emb_name, emb_description, emb_input_schema, emb_output_schema, bm25_text)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                rusqlite::params![instance_id, name, stored.tool.description, params_json, metadata_json, fields_json, emb_name, emb_desc, emb_input, emb_output, stored.bm25_text],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn load_tools_for_instance(&self, instance_id: &str) -> Result<Vec<(String, StoredTool)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT name, description, parameters, metadata, fields, emb_name, emb_description, emb_input_schema, emb_output_schema, bm25_text FROM tools WHERE instance_id = ?1"
        )?;
        let rows = stmt.query_map(rusqlite::params![instance_id], |row| {
            let name: String = row.get(0)?;
            let description: String = row.get(1)?;
            let params_json: String = row.get(2)?;
            let metadata_json: Option<String> = row.get(3)?;
            let fields_json: Option<String> = row.get(4)?;
            let emb_name_blob: Vec<u8> = row.get(5)?;
            let emb_desc_blob: Vec<u8> = row.get(6)?;
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

            result.push((name.clone(), StoredTool {
                tool: crate::models::Tool {
                    name,
                    description,
                    parameters,
                    metadata,
                    fields,
                },
                embeddings: crate::models::FieldEmbeddings {
                    name: blob_to_vec_f32(&emb_name_blob),
                    description: blob_to_vec_f32(&emb_desc_blob),
                    input_schema: emb_input_blob.map(|b| blob_to_vec_f32(&b)),
                    output_schema: emb_output_blob.map(|b| blob_to_vec_f32(&b)),
                },
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

    fn save_instance(&self, instance: &Instance) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO instances (instance_id, dataset_id, created_at, last_heartbeat) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![instance.instance_id, instance.dataset_id, instance.created_at, instance.last_heartbeat],
        )?;
        Ok(())
    }

    fn get_instance(&self, instance_id: &str) -> Result<Option<Instance>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT instance_id, dataset_id, created_at, last_heartbeat FROM instances WHERE instance_id = ?1"
        )?;
        let mut rows = stmt.query(rusqlite::params![instance_id])?;
        match rows.next()? {
            Some(row) => Ok(Some(Instance {
                instance_id: row.get(0)?,
                dataset_id: row.get(1)?,
                created_at: row.get(2)?,
                last_heartbeat: row.get(3)?,
            })),
            None => Ok(None),
        }
    }

    fn delete_instance(&self, instance_id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM tools WHERE instance_id = ?1", rusqlite::params![instance_id])?;
        let affected = conn.execute(
            "DELETE FROM instances WHERE instance_id = ?1",
            rusqlite::params![instance_id],
        )?;
        Ok(affected > 0)
    }

    fn delete_tools_for_instance(&self, instance_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM tools WHERE instance_id = ?1", rusqlite::params![instance_id])?;
        Ok(())
    }

    fn update_heartbeat(&self, instance_id: &str, heartbeat: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let affected = conn.execute(
            "UPDATE instances SET last_heartbeat = ?1 WHERE instance_id = ?2",
            rusqlite::params![heartbeat, instance_id],
        )?;
        Ok(affected > 0)
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
        s.save_tools("inst-1", &[]).unwrap();
        assert!(s.load_tools_for_instance("inst-1").unwrap().is_empty());
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
            embeddings: FieldEmbeddings {
                name: vec![1.0; 4],
                description: vec![2.0; 4],
                input_schema: if with_fields { Some(vec![3.0; 4]) } else { None },
                output_schema: if with_fields { Some(vec![4.0; 4]) } else { None },
            },
            bm25_text: format!("{name} {desc}"),
        }
    }

    #[test]
    fn sqlite_roundtrip_tools() {
        let s = SqliteStorage::new(":memory:").unwrap();
        let tool = make_stored_tool("getThing", "Get a thing", true);
        s.save_tools("inst-1", &[("getThing", &tool)]).unwrap();
        let loaded = s.load_tools_for_instance("inst-1").unwrap();
        assert_eq!(loaded.len(), 1);
        let (name, st) = &loaded[0];
        assert_eq!(name, "getThing");
        assert_eq!(st.tool.name, "getThing");
        assert_eq!(st.tool.description, "Get a thing");
        assert_eq!(st.embeddings.name, vec![1.0; 4]);
        assert_eq!(st.embeddings.description, vec![2.0; 4]);
        assert_eq!(st.embeddings.input_schema.as_ref().unwrap(), &vec![3.0; 4]);
        assert_eq!(st.embeddings.output_schema.as_ref().unwrap(), &vec![4.0; 4]);
        assert_eq!(st.bm25_text, "getThing Get a thing");
        assert!(st.tool.fields.is_some());
        assert!(st.tool.metadata.is_some());
    }

    #[test]
    fn sqlite_tool_upsert_replaces() {
        let s = SqliteStorage::new(":memory:").unwrap();
        let t1 = make_stored_tool("t", "v1", false);
        s.save_tools("inst-1", &[("t", &t1)]).unwrap();
        let t2 = make_stored_tool("t", "v2", false);
        s.save_tools("inst-1", &[("t", &t2)]).unwrap();
        let loaded = s.load_tools_for_instance("inst-1").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].1.tool.description, "v2");
    }

    #[test]
    fn sqlite_tool_with_null_optional_fields() {
        let s = SqliteStorage::new(":memory:").unwrap();
        let mut tool = make_stored_tool("t", "d", false);
        tool.tool.metadata = None;
        tool.tool.fields = None;
        tool.embeddings.input_schema = None;
        tool.embeddings.output_schema = None;
        s.save_tools("inst-1", &[("t", &tool)]).unwrap();
        let loaded = s.load_tools_for_instance("inst-1").unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(loaded[0].1.tool.metadata.is_none());
        assert!(loaded[0].1.tool.fields.is_none());
        assert!(loaded[0].1.embeddings.input_schema.is_none());
        assert!(loaded[0].1.embeddings.output_schema.is_none());
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
}
