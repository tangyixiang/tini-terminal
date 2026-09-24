use std::sync::Arc;
use crate::storage::{StorageManager, WorkspaceRecord};
use super::model::Workspace;

#[derive(Clone)]
pub struct WorkspaceManager {
    storage: Arc<StorageManager>,
}

impl WorkspaceManager {
    pub fn new(storage: Arc<StorageManager>) -> Self {
        Self { storage }
    }

    pub fn list(&self) -> Result<Vec<Workspace>, String> {
        let records = self.storage.list_workspaces().map_err(|e| e.to_string())?;
        Ok(records
            .into_iter()
            .map(|r| Workspace {
                id: r.id,
                name: r.name,
                description: r.description,
                host_ids: r.host_ids,
                created_at: r.created_at,
                updated_at: r.updated_at,
            })
            .collect())
    }

    pub fn save(&self, ws: Workspace) -> Result<(), String> {
        let record = WorkspaceRecord {
            id: ws.id,
            name: ws.name,
            description: ws.description,
            host_ids: ws.host_ids,
            created_at: ws.created_at,
            updated_at: ws.updated_at,
        };
        self.storage.save_workspace(&record).map_err(|e| e.to_string())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        self.storage.delete_workspace(id).map_err(|e| e.to_string())
    }

    pub fn get_hosts(&self, id: &str) -> Result<Vec<String>, String> {
        self.storage.get_workspace_hosts(id).map_err(|e| e.to_string())
    }

    pub fn set_hosts(&self, id: &str, host_ids: &[String]) -> Result<(), String> {
        self.storage.set_workspace_hosts(id, host_ids).map_err(|e| e.to_string())
    }
}
