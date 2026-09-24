use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use super::context::SessionContext;
use super::model::{SessionInfo, SessionKind, SessionStatus};

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
        let mut map = self.sessions.lock().unwrap();
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

        let mut ctx_map = self.contexts.lock().unwrap();
        ctx_map.entry(id).or_insert_with(SessionContext::default);
    }

    pub fn unregister_session(&self, id: &str) {
        self.sessions.lock().unwrap().remove(id);
        self.contexts.lock().unwrap().remove(id);
    }

    pub fn update_cwd(&self, id: &str, cwd: String) {
        let mut ctx_map = self.contexts.lock().unwrap();
        if let Some(ctx) = ctx_map.get_mut(id) {
            ctx.cwd = Some(cwd);
        }
    }

    pub fn update_context<F>(&self, id: &str, f: F)
    where
        F: FnOnce(&mut SessionContext),
    {
        let mut ctx_map = self.contexts.lock().unwrap();
        if let Some(ctx) = ctx_map.get_mut(id) {
            f(ctx);
        }
    }

    pub fn get_context(&self, id: &str) -> Option<SessionContext> {
        self.contexts.lock().unwrap().get(id).cloned()
    }

    pub fn list_sessions(&self) -> Vec<SessionInfo> {
        self.sessions.lock().unwrap().values().cloned().collect()
    }
}
