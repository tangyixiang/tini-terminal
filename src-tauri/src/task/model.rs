use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum TaskStatus {
    Planning,
    WaitingApproval,
    Running,
    Verifying,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskStep {
    pub id: String,
    pub host_id: String,
    pub host_name: String,
    pub command: String,
    pub status: String, // "pending" | "running" | "completed" | "failed" | "blocked"
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskPlan {
    pub id: String,
    pub workspace_id: String,
    pub prompt: String,
    pub status: TaskStatus,
    pub steps: Vec<TaskStep>,
    pub summary: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}
