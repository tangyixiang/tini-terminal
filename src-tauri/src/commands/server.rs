use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;

use crate::storage::{ServerRecord, SnippetRecord};
use crate::AppState;

#[tauri::command]
pub fn list_servers(state: State<Arc<AppState>>) -> Result<Vec<ServerRecord>, String> {
    state.storage.list_servers().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_server(state: State<Arc<AppState>>, server: ServerRecord) -> Result<(), String> {
    state.storage.save_server(&server).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_server(state: State<Arc<AppState>>, id: String) -> Result<(), String> {
    state.storage.delete_server(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_settings(state: State<Arc<AppState>>) -> Result<HashMap<String, String>, String> {
    state.storage.get_settings().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_settings(
    state: State<Arc<AppState>>,
    settings: HashMap<String, String>,
) -> Result<(), String> {
    state
        .storage
        .save_settings(&settings)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_snippets(state: State<Arc<AppState>>) -> Result<Vec<SnippetRecord>, String> {
    state.storage.list_snippets().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_snippet(state: State<Arc<AppState>>, snippet: SnippetRecord) -> Result<(), String> {
    state
        .storage
        .save_snippet(&snippet)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_snippet(state: State<Arc<AppState>>, id: String) -> Result<(), String> {
    state.storage.delete_snippet(&id).map_err(|e| e.to_string())
}
