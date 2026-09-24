use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ServerRecord {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String, // "password" | "key" | "agent"
    pub credential: Option<String>,
    pub passphrase: Option<String>,
    pub group_name: Option<String>,
    pub tags: Option<String>,
    pub jump_host_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkspaceRecord {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub host_ids: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskRecord {
    pub id: String,
    pub workspace_id: String,
    pub prompt: String,
    pub status: String,
    pub plan_json: Option<String>,
    pub result_json: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct StorageManager {
    db_path: PathBuf,
}

impl StorageManager {
    pub fn new() -> Self {
        let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
        let old_dir = base.join("ai-terminal");
        let new_dir = base.join("tini-terminal");

        let dir = if new_dir.exists() {
            new_dir
        } else if old_dir.exists() {
            let _ = fs::rename(&old_dir, &new_dir);
            if new_dir.exists() {
                new_dir
            } else {
                old_dir
            }
        } else {
            new_dir
        };

        if !dir.exists() {
            let _ = fs::create_dir_all(&dir);
        }
        let db_path = dir.join("terminal_data.db");
        let manager = Self { db_path };
        if let Err(e) = manager.init_db() {
            eprintln!("[Storage] Database initialization error: {}", e);
        }
        manager
    }

    fn get_connection(&self) -> Result<Connection> {
        Connection::open(&self.db_path)
    }

    fn init_db(&self) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS servers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                username TEXT NOT NULL,
                auth_type TEXT NOT NULL,
                credential TEXT,
                passphrase TEXT,
                group_name TEXT,
                tags TEXT,
                jump_host_id TEXT,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS history_logs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS workspaces (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS workspace_hosts (
                workspace_id TEXT NOT NULL,
                host_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (workspace_id, host_id)
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                prompt TEXT NOT NULL,
                status TEXT NOT NULL,
                plan_json TEXT,
                result_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            ",
        )?;

        // Seed initial default workspaces if none exists
        let ws_count: i64 = conn.query_row(
            "SELECT count(*) FROM workspaces",
            [],
            |r| r.get(0),
        ).unwrap_or(0);

        if ws_count == 0 {
            let now = chrono::Utc::now().timestamp_millis();
            let _ = conn.execute(
                "INSERT INTO workspaces (id, name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params!["ws-default-prod", "Production (生产集群)", "核心生产服务器集群", now, now],
            );
            let _ = conn.execute(
                "INSERT INTO workspaces (id, name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params!["ws-default-staging", "Staging (预发集群)", "预发布与测试验证环境", now, now],
            );
        }

        // Seed initial default settings if not exists
        let has_ai: i64 = conn.query_row(
            "SELECT count(*) FROM settings WHERE key = 'ai_provider'",
            [],
            |r| r.get(0),
        ).unwrap_or(0);

        if has_ai == 0 {
            let _ = conn.execute("INSERT INTO settings (key, value) VALUES ('ai_provider', 'DeepSeek')", []);
            let _ = conn.execute("INSERT INTO settings (key, value) VALUES ('ai_base_url', 'https://api.deepseek.com/v1')", []);
            let _ = conn.execute("INSERT INTO settings (key, value) VALUES ('ai_api_key', '')", []);
            let _ = conn.execute("INSERT INTO settings (key, value) VALUES ('ai_model', 'deepseek-chat')", []);
            let _ = conn.execute("INSERT INTO settings (key, value) VALUES ('danger_level', 'high')", []);
        }

        Ok(())
    }

    pub fn list_servers(&self) -> Result<Vec<ServerRecord>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, name, host, port, username, auth_type, credential, passphrase, group_name, tags, jump_host_id, created_at FROM servers ORDER BY created_at DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(ServerRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                host: row.get(2)?,
                port: row.get(3)?,
                username: row.get(4)?,
                auth_type: row.get(5)?,
                credential: row.get(6)?,
                passphrase: row.get(7)?,
                group_name: row.get(8)?,
                tags: row.get(9)?,
                jump_host_id: row.get(10)?,
                created_at: row.get(11)?,
            })
        })?;

        let mut list = Vec::new();
        for r in rows {
            if let Ok(server) = r {
                list.push(server);
            }
        }
        Ok(list)
    }

    pub fn save_server(&self, server: &ServerRecord) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "
            INSERT INTO servers (id, name, host, port, username, auth_type, credential, passphrase, group_name, tags, jump_host_id, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                host = excluded.host,
                port = excluded.port,
                username = excluded.username,
                auth_type = excluded.auth_type,
                credential = excluded.credential,
                passphrase = excluded.passphrase,
                group_name = excluded.group_name,
                tags = excluded.tags,
                jump_host_id = excluded.jump_host_id;
            ",
            params![
                server.id,
                server.name,
                server.host,
                server.port,
                server.username,
                server.auth_type,
                server.credential,
                server.passphrase,
                server.group_name,
                server.tags,
                server.jump_host_id,
                server.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn delete_server(&self, id: &str) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute("DELETE FROM servers WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn get_settings(&self) -> Result<HashMap<String, String>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |row| {
            let k: String = row.get(0)?;
            let v: String = row.get(1)?;
            Ok((k, v))
        })?;

        let mut map = HashMap::new();
        for r in rows {
            if let Ok((k, v)) = r {
                map.insert(k, v);
            }
        }
        Ok(map)
    }

    pub fn save_settings(&self, settings: &HashMap<String, String>) -> Result<()> {
        let mut conn = self.get_connection()?;
        let tx = conn.transaction()?;
        for (k, v) in settings {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![k, v],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_workspaces(&self) -> Result<Vec<WorkspaceRecord>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, name, description, created_at, updated_at FROM workspaces ORDER BY created_at ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;

        let mut list = Vec::new();
        for r in rows {
            if let Ok((id, name, description, created_at, updated_at)) = r {
                let host_ids = self.get_workspace_hosts(&id).unwrap_or_default();
                list.push(WorkspaceRecord {
                    id,
                    name,
                    description,
                    host_ids,
                    created_at,
                    updated_at,
                });
            }
        }
        Ok(list)
    }

    pub fn save_workspace(&self, ws: &WorkspaceRecord) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "INSERT INTO workspaces (id, name, description, created_at, updated_at) 
             VALUES (?1, ?2, ?3, ?4, ?5) 
             ON CONFLICT(id) DO UPDATE SET 
                name = excluded.name, 
                description = excluded.description, 
                updated_at = excluded.updated_at",
            params![ws.id, ws.name, ws.description, ws.created_at, ws.updated_at],
        )?;

        self.set_workspace_hosts(&ws.id, &ws.host_ids)?;
        Ok(())
    }

    pub fn delete_workspace(&self, id: &str) -> Result<()> {
        let mut conn = self.get_connection()?;
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        tx.execute("DELETE FROM workspace_hosts WHERE workspace_id = ?1", params![id])?;
        tx.execute("DELETE FROM tasks WHERE workspace_id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn get_workspace_hosts(&self, workspace_id: &str) -> Result<Vec<String>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT host_id FROM workspace_hosts WHERE workspace_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![workspace_id], |row| row.get(0))?;
        let mut list = Vec::new();
        for r in rows {
            if let Ok(host_id) = r {
                list.push(host_id);
            }
        }
        Ok(list)
    }

    pub fn set_workspace_hosts(&self, workspace_id: &str, host_ids: &[String]) -> Result<()> {
        let mut conn = self.get_connection()?;
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM workspace_hosts WHERE workspace_id = ?1", params![workspace_id])?;
        let now = chrono::Utc::now().timestamp_millis();
        for hid in host_ids {
            tx.execute(
                "INSERT OR IGNORE INTO workspace_hosts (workspace_id, host_id, created_at) VALUES (?1, ?2, ?3)",
                params![workspace_id, hid, now],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_tasks(&self, workspace_id: Option<&str>) -> Result<Vec<TaskRecord>> {
        let conn = self.get_connection()?;
        let mut list = Vec::new();
        if let Some(ws_id) = workspace_id {
            let mut stmt = conn.prepare(
                "SELECT id, workspace_id, prompt, status, plan_json, result_json, created_at, updated_at 
                 FROM tasks WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT 50",
            )?;
            let rows = stmt.query_map(params![ws_id], |row| {
                Ok(TaskRecord {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    prompt: row.get(2)?,
                    status: row.get(3)?,
                    plan_json: row.get(4)?,
                    result_json: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })?;
            for r in rows {
                if let Ok(item) = r {
                    list.push(item);
                }
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, workspace_id, prompt, status, plan_json, result_json, created_at, updated_at 
                 FROM tasks ORDER BY created_at DESC LIMIT 50",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(TaskRecord {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    prompt: row.get(2)?,
                    status: row.get(3)?,
                    plan_json: row.get(4)?,
                    result_json: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })?;
            for r in rows {
                if let Ok(item) = r {
                    list.push(item);
                }
            }
        }
        Ok(list)
    }

    pub fn save_task(&self, task: &TaskRecord) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "INSERT INTO tasks (id, workspace_id, prompt, status, plan_json, result_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                status = excluded.status,
                plan_json = excluded.plan_json,
                result_json = excluded.result_json,
                updated_at = excluded.updated_at",
            params![
                task.id,
                task.workspace_id,
                task.prompt,
                task.status,
                task.plan_json,
                task.result_json,
                task.created_at,
                task.updated_at
            ],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_storage_crud() {
        let temp_dir = std::env::temp_dir().join(format!("ai_terminal_test_{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);
        let db_path = temp_dir.join("test.db");
        let storage = StorageManager { db_path: db_path.clone() };
        storage.init_db().expect("init_db should succeed");

        // 1. 测试设置存储
        let mut settings = HashMap::new();
        settings.insert("ai_model".to_string(), "deepseek-reasoner".to_string());
        settings.insert("danger_level".to_string(), "high".to_string());
        storage.save_settings(&settings).expect("save_settings should succeed");

        let loaded_settings = storage.get_settings().expect("get_settings should succeed");
        assert_eq!(loaded_settings.get("ai_model").unwrap(), "deepseek-reasoner");

        // 2. 测试服务器添加与查询
        let server = ServerRecord {
            id: "test-srv-1".to_string(),
            name: "Test Prod".to_string(),
            host: "10.0.0.1".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_type: "key".to_string(),
            credential: Some("/root/.ssh/id_rsa".to_string()),
            passphrase: None,
            group_name: Some("生产集群".to_string()),
            tags: Some("test,prod".to_string()),
            jump_host_id: None,
            created_at: 1700000000,
        };

        storage.save_server(&server).expect("save_server should succeed");

        let list = storage.list_servers().expect("list_servers should succeed");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Test Prod");
        assert_eq!(list[0].host, "10.0.0.1");

        // 3. 测试删除
        storage.delete_server("test-srv-1").expect("delete_server should succeed");
        let list_after = storage.list_servers().expect("list_servers should succeed");
        assert_eq!(list_after.len(), 0);

        let _ = fs::remove_dir_all(&temp_dir);
    }
}

