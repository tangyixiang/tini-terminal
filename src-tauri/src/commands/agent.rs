use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

use crate::agent::{AgentService, AiStreamEvent, StreamAiChatRequest, TestAiRequest, TestAiResponse};
use crate::safety::{SafetyCheckResult, SafetyLevel};
use crate::storage::ChatHistoryRecord;
use crate::AppState;

#[tauri::command]
pub fn check_command_safety(
    state: State<Arc<AppState>>,
    command: String,
    danger_level: Option<String>,
) -> SafetyCheckResult {
    let level = SafetyLevel::from_str(danger_level.as_deref().unwrap_or("high"));
    state.safety.check_command_with_level(&command, level)
}

#[tauri::command]
pub async fn test_ai_connection(req: TestAiRequest) -> TestAiResponse {
    AgentService::test_connection(req).await
}

#[tauri::command]
pub async fn stream_ai_chat(
    state: State<'_, Arc<AppState>>,
    req: StreamAiChatRequest,
    channel: Channel<AiStreamEvent>,
) -> Result<(), String> {
    let agent = state.agent.clone();
    agent.stream_chat(req, channel).await
}

#[tauri::command]
pub fn abort_ai_chat(state: State<Arc<AppState>>, request_id: String) -> Result<(), String> {
    state.agent.abort_chat(&request_id);
    Ok(())
}

#[tauri::command]
pub fn load_chat_history(
    state: State<Arc<AppState>>,
    session_key: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    state
        .storage
        .load_chat_history(&session_key, limit.unwrap_or(60))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_chat_history(
    state: State<Arc<AppState>>,
    session_key: String,
    messages: Vec<ChatHistoryRecord>,
) -> Result<(), String> {
    state
        .storage
        .save_chat_history(&session_key, &messages)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_chat_history(state: State<Arc<AppState>>, session_key: String) -> Result<(), String> {
    state
        .storage
        .clear_chat_history(&session_key)
        .map_err(|e| e.to_string())
}
