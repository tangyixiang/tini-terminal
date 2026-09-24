use std::sync::Arc;
use crate::ssh::SshManager;
use crate::storage::{ServerRecord, StorageManager, TaskRecord};
use super::executor::TaskExecutor;
use super::model::{TaskPlan, TaskStatus, TaskStep};

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct HostExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

#[derive(Clone)]
pub struct TaskManager {
    storage: Arc<StorageManager>,
    executor: Arc<TaskExecutor>,
}

impl TaskManager {
    pub fn new(storage: Arc<StorageManager>, ssh: SshManager) -> Self {
        let executor = Arc::new(TaskExecutor::new(Arc::clone(&storage), ssh));
        Self { storage, executor }
    }

    pub async fn execute_on_host(
        &self,
        host_id: &str,
        command: &str,
    ) -> Result<HostExecResult, String> {
        let all_servers = self.storage.list_servers().map_err(|e| e.to_string())?;

        let server = if host_id == "local" || host_id == "localhost" {
            all_servers
                .into_iter()
                .find(|s| s.host == "localhost" || s.host == "127.0.0.1")
                .unwrap_or_else(|| ServerRecord {
                    id: "local".to_string(),
                    name: "本地终端".to_string(),
                    host: "127.0.0.1".to_string(),
                    port: 22,
                    username: "local".to_string(),
                    auth_type: "password".to_string(),
                    credential: None,
                    passphrase: None,
                    group_name: None,
                    tags: None,
                    jump_host_id: None,
                    created_at: 0,
                })
        } else {
            all_servers
                .into_iter()
                .find(|s| s.id == host_id || s.name.eq_ignore_ascii_case(host_id))
                .ok_or_else(|| format!("未找到目标主机: {}", host_id))?
        };

        let (exit_code, stdout, stderr, duration_ms) = self
            .executor
            .execute_step_on_host(&server, command)
            .await?;

        Ok(HostExecResult {
            exit_code,
            stdout,
            stderr,
            duration_ms,
        })
    }

    pub async fn read_host_file(&self, host_id: &str, file_path: &str) -> Result<String, String> {
        let cmd = format!("cat '{}'", file_path.replace('\'', "'\\''"));
        let res = self.execute_on_host(host_id, &cmd).await?;
        if res.exit_code != 0 {
            return Err(if !res.stderr.is_empty() {
                res.stderr
            } else {
                format!("读取文件失败，退出码: {}", res.exit_code)
            });
        }
        Ok(res.stdout)
    }

    pub async fn write_host_file(
        &self,
        host_id: &str,
        file_path: &str,
        content: &str,
    ) -> Result<(), String> {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());
        let escaped_path = file_path.replace('\'', "'\\''");
        let cmd = format!(
            "mkdir -p \"$(dirname '{}')\" && echo '{}' | base64 -d > '{}'",
            escaped_path, b64, escaped_path
        );
        let res = self.execute_on_host(host_id, &cmd).await?;
        if res.exit_code != 0 {
            return Err(if !res.stderr.is_empty() {
                res.stderr
            } else {
                format!("写入文件失败，退出码: {}", res.exit_code)
            });
        }
        Ok(())
    }

    pub fn list_tasks(&self, workspace_id: Option<&str>) -> Result<Vec<TaskPlan>, String> {
        let records = self.storage.list_tasks(workspace_id).map_err(|e| e.to_string())?;
        let mut list = Vec::new();
        for r in records {
            let steps: Vec<TaskStep> = r.plan_json.as_deref()
                .and_then(|j| serde_json::from_str(j).ok())
                .unwrap_or_default();
            let status = match r.status.as_str() {
                "Planning" => TaskStatus::Planning,
                "WaitingApproval" => TaskStatus::WaitingApproval,
                "Running" => TaskStatus::Running,
                "Verifying" => TaskStatus::Verifying,
                "Completed" => TaskStatus::Completed,
                "Failed" => TaskStatus::Failed,
                _ => TaskStatus::Cancelled,
            };

            list.push(TaskPlan {
                id: r.id,
                workspace_id: r.workspace_id,
                prompt: r.prompt,
                status,
                steps,
                summary: r.result_json,
                created_at: r.created_at,
                updated_at: r.updated_at,
            });
        }
        Ok(list)
    }

    pub async fn run_workspace_task(
        &self,
        workspace_id: &str,
        prompt: &str,
        target_host_ids: &[String],
        command: &str,
    ) -> Result<TaskPlan, String> {
        let all_servers = self.storage.list_servers().map_err(|e| e.to_string())?;
        let servers: Vec<ServerRecord> = all_servers
            .into_iter()
            .filter(|s| target_host_ids.contains(&s.id))
            .collect();

        if servers.is_empty() {
            return Err("未指定或未找到有效的目标服务器".to_string());
        }

        let task_id = format!("task-{}", uuid::Uuid::new_v4().simple());
        let now = chrono::Utc::now().timestamp_millis();

        let initial_record = TaskRecord {
            id: task_id.clone(),
            workspace_id: workspace_id.to_string(),
            prompt: prompt.to_string(),
            status: "Running".to_string(),
            plan_json: None,
            result_json: None,
            created_at: now,
            updated_at: now,
        };
        let _ = self.storage.save_task(&initial_record);

        // 并发执行各主机任务步骤
        let steps = self.executor.execute_batch(servers, command.to_string()).await;

        let total = steps.len();
        let success_count = steps.iter().filter(|s| s.exit_code == Some(0)).count();
        let fail_count = total - success_count;
        let is_all_ok = fail_count == 0;

        let summary = format!(
            "多机执行完成: {} 节点成功，{} 节点失败 (总数: {})",
            success_count, fail_count, total
        );

        let final_status = if is_all_ok {
            TaskStatus::Completed
        } else {
            TaskStatus::Failed
        };

        let steps_json = serde_json::to_string(&steps).ok();
        let final_record = TaskRecord {
            id: task_id.clone(),
            workspace_id: workspace_id.to_string(),
            prompt: prompt.to_string(),
            status: if is_all_ok { "Completed".to_string() } else { "Failed".to_string() },
            plan_json: steps_json,
            result_json: Some(summary.clone()),
            created_at: now,
            updated_at: chrono::Utc::now().timestamp_millis(),
        };
        let _ = self.storage.save_task(&final_record);

        Ok(TaskPlan {
            id: task_id,
            workspace_id: workspace_id.to_string(),
            prompt: prompt.to_string(),
            status: final_status,
            steps,
            summary: Some(summary),
            created_at: now,
            updated_at: chrono::Utc::now().timestamp_millis(),
        })
    }
}
