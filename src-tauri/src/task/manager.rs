use std::sync::{Arc, Mutex};
use crate::sftp::SftpManager;
use crate::ssh::{SshConnectOptions, SshManager};
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

    fn resolve_server(&self, host_id: &str) -> Result<ServerRecord, String> {
        let all_servers = self.storage.list_servers().map_err(|e| e.to_string())?;
        if host_id == "local" || host_id == "localhost" {
            all_servers
                .into_iter()
                .find(|s| s.host == "localhost" || s.host == "127.0.0.1")
                .ok_or_else(|| {
                    "未配置本机主机：请先在主机列表中添加 host 为 localhost 或 127.0.0.1 的条目"
                        .to_string()
                })
        } else {
            all_servers
                .into_iter()
                .find(|s| s.id == host_id || s.name.eq_ignore_ascii_case(host_id))
                .ok_or_else(|| format!("未找到目标主机: {}", host_id))
        }
    }

    pub async fn execute_on_host(
        &self,
        host_id: &str,
        command: &str,
    ) -> Result<HostExecResult, String> {
        let server = self.resolve_server(host_id)?;
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

    /// 通过原生 SFTP（或本地 std::fs）读取主机文件，避免 shell 拼接与平台命令差异
    pub async fn read_host_file(&self, host_id: &str, file_path: &str) -> Result<String, String> {
        let server = self.resolve_server(host_id)?;
        let is_local =
            (server.host == "localhost" || server.host == "127.0.0.1") && server.username == "local";
        let path = file_path.to_string();

        if is_local {
            return tokio::task::spawn_blocking(move || {
                std::fs::read_to_string(&path)
                    .map_err(|e| format!("读取本地文件失败 ({}): {}", path, e))
            })
            .await
            .map_err(|e| format!("调度本地读文件失败: {}", e))?;
        }

        let options = SshConnectOptions {
            host: server.host,
            port: server.port,
            username: server.username,
            auth_type: server.auth_type,
            credential: server.credential,
            passphrase: server.passphrase,
            cols: 80,
            rows: 24,
        };
        tokio::task::spawn_blocking(move || {
            let sess = SshManager::establish_connection(&options)?;
            let sess_arc = Arc::new(Mutex::new(sess));
            SftpManager::read_file(sess_arc, &path, None)
        })
        .await
        .map_err(|e| format!("调度远程读文件失败: {}", e))?
    }

    /// 通过原生 SFTP（或本地 std::fs）写入主机文件，彻底规避 ARG_MAX 长度限制与 base64 参数差异
    pub async fn write_host_file(
        &self,
        host_id: &str,
        file_path: &str,
        content: &str,
    ) -> Result<(), String> {
        let server = self.resolve_server(host_id)?;
        let is_local =
            (server.host == "localhost" || server.host == "127.0.0.1") && server.username == "local";
        let path = file_path.to_string();
        let data = content.to_string();

        if is_local {
            return tokio::task::spawn_blocking(move || {
                let p = std::path::Path::new(&path);
                if let Some(parent) = p.parent() {
                    if !parent.as_os_str().is_empty() {
                        std::fs::create_dir_all(parent)
                            .map_err(|e| format!("创建父级目录失败: {}", e))?;
                    }
                }
                std::fs::write(p, data.as_bytes())
                    .map_err(|e| format!("写入本地文件失败 ({}): {}", path, e))
            })
            .await
            .map_err(|e| format!("调度本地写文件失败: {}", e))?;
        }

        let options = SshConnectOptions {
            host: server.host,
            port: server.port,
            username: server.username,
            auth_type: server.auth_type,
            credential: server.credential,
            passphrase: server.passphrase,
            cols: 80,
            rows: 24,
        };
        tokio::task::spawn_blocking(move || {
            let sess = SshManager::establish_connection(&options)?;
            let sess_arc = Arc::new(Mutex::new(sess));
            SftpManager::write_file(sess_arc, &path, &data)
        })
        .await
        .map_err(|e| format!("调度远程写文件失败: {}", e))?
    }

    pub fn list_tasks(&self, workspace_id: Option<&str>) -> Result<Vec<TaskPlan>, String> {
        let records = self.storage.list_tasks(workspace_id).map_err(|e| e.to_string())?;
        let mut list = Vec::new();
        for r in records {
            let steps: Vec<TaskStep> = r
                .plan_json
                .as_deref()
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
            status: if is_all_ok {
                "Completed".to_string()
            } else {
                "Failed".to_string()
            },
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
