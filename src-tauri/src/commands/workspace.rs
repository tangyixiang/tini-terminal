use std::sync::Arc;
use tauri::State;

use crate::task::{HostExecResult, TaskPlan};
use crate::workspace::Workspace;
use crate::AppState;

#[tauri::command]
pub fn list_workspaces(state: State<Arc<AppState>>) -> Result<Vec<Workspace>, String> {
    state.workspaces.list()
}

#[tauri::command]
pub fn save_workspace(state: State<Arc<AppState>>, workspace: Workspace) -> Result<(), String> {
    state.workspaces.save(workspace)
}

#[tauri::command]
pub fn delete_workspace(state: State<Arc<AppState>>, id: String) -> Result<(), String> {
    state.workspaces.delete(&id)
}

#[tauri::command]
pub fn get_workspace_hosts(
    state: State<Arc<AppState>>,
    workspace_id: String,
) -> Result<Vec<String>, String> {
    state.workspaces.get_hosts(&workspace_id)
}

#[tauri::command]
pub fn set_workspace_hosts(
    state: State<Arc<AppState>>,
    workspace_id: String,
    host_ids: Vec<String>,
) -> Result<(), String> {
    state.workspaces.set_hosts(&workspace_id, &host_ids)
}

#[tauri::command]
pub fn list_workspace_tasks(
    state: State<Arc<AppState>>,
    workspace_id: Option<String>,
) -> Result<Vec<TaskPlan>, String> {
    state.tasks.list_tasks(workspace_id.as_deref())
}

#[tauri::command]
pub async fn run_workspace_task(
    state: State<'_, Arc<AppState>>,
    workspace_id: String,
    prompt: String,
    target_host_ids: Vec<String>,
    command: String,
) -> Result<TaskPlan, String> {
    let tasks = state.tasks.clone();
    tasks
        .run_workspace_task(&workspace_id, &prompt, &target_host_ids, &command)
        .await
}

#[tauri::command]
pub async fn execute_host_command(
    state: State<'_, Arc<AppState>>,
    host_id: String,
    command: String,
) -> Result<HostExecResult, String> {
    let tasks = state.tasks.clone();
    tasks.execute_on_host(&host_id, &command).await
}

#[tauri::command]
pub async fn execute_host_file_read(
    state: State<'_, Arc<AppState>>,
    host_id: String,
    file_path: String,
) -> Result<String, String> {
    let tasks = state.tasks.clone();
    tasks.read_host_file(&host_id, &file_path).await
}

#[tauri::command]
pub async fn execute_host_file_write(
    state: State<'_, Arc<AppState>>,
    host_id: String,
    file_path: String,
    content: String,
) -> Result<(), String> {
    let tasks = state.tasks.clone();
    tasks.write_host_file(&host_id, &file_path, &content).await
}
