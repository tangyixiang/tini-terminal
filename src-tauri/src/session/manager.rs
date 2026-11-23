use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use super::context::SessionContext;
use super::model::{SessionInfo, SessionKind, SessionStatus};

/// 每个会话保留的最近纯文本输出字符数上限
const MAX_RECENT_OUTPUT_CHARS: usize = 4000;

#[derive(Clone)]
pub struct SessionManager {
    contexts: Arc<Mutex<HashMap<String, SessionContext>>>,
    sessions: Arc<Mutex<HashMap<String, SessionInfo>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            contexts: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn register_session(&self, id: String, host_id: String, kind: SessionKind) {
        let now = chrono::Utc::now().timestamp_millis();
        if let Ok(mut map) = self.sessions.lock() {
            map.insert(
                id.clone(),
                SessionInfo {
                    id: id.clone(),
                    host_id,
                    kind,
                    status: SessionStatus::Connected,
                    shell: None,
                    user: None,
                    created_at: now,
                    updated_at: now,
                },
            );
        }

        if let Ok(mut ctx_map) = self.contexts.lock() {
            ctx_map.entry(id).or_insert_with(SessionContext::default);
        }
    }

    pub fn mark_disconnected(&self, id: &str) {
        if let Ok(mut map) = self.sessions.lock() {
            if let Some(info) = map.get_mut(id) {
                info.status = SessionStatus::Disconnected;
                info.updated_at = chrono::Utc::now().timestamp_millis();
            }
        }
    }

    pub fn unregister_session(&self, id: &str) {
        if let Ok(mut map) = self.sessions.lock() {
            map.remove(id);
        }
        if let Ok(mut ctx_map) = self.contexts.lock() {
            ctx_map.remove(id);
        }
    }

    pub fn update_cwd(&self, id: &str, cwd: String) {
        if let Ok(mut ctx_map) = self.contexts.lock() {
            if let Some(ctx) = ctx_map.get_mut(id) {
                ctx.cwd = Some(cwd);
            }
        }
    }

    pub fn update_context<F>(&self, id: &str, f: F)
    where
        F: FnOnce(&mut SessionContext),
    {
        if let Ok(mut ctx_map) = self.contexts.lock() {
            if let Some(ctx) = ctx_map.get_mut(id) {
                f(ctx);
            }
        }
    }

    pub fn append_recent_output(&self, id: &str, clean_text: &str) {
        if clean_text.is_empty() {
            return;
        }
        if let Ok(mut ctx_map) = self.contexts.lock() {
            if let Some(ctx) = ctx_map.get_mut(id) {
                ctx.recent_output.push_str(clean_text);
                if ctx.recent_output.len() > MAX_RECENT_OUTPUT_CHARS * 2 {
                    // 按 char 边界安全裁剪，保留末尾最近输出
                    let target_len = MAX_RECENT_OUTPUT_CHARS;
                    let mut start = ctx.recent_output.len().saturating_sub(target_len);
                    while start < ctx.recent_output.len() && !ctx.recent_output.is_char_boundary(start) {
                        start += 1;
                    }
                    ctx.recent_output = ctx.recent_output[start..].to_string();
                }
            }
        }
    }

    pub fn get_context(&self, id: &str) -> Option<SessionContext> {
        self.contexts.lock().ok()?.get(id).cloned()
    }

    pub fn list_sessions(&self) -> Vec<SessionInfo> {
        self.sessions
            .lock()
            .ok()
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default()
    }
}
