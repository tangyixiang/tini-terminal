use std::sync::Arc;
use std::time::Instant;
use crate::ssh::{SshConnectOptions, SshManager};
use crate::storage::{ServerRecord, StorageManager};
use super::model::TaskStep;

pub struct TaskExecutor {
    storage: Arc<StorageManager>,
    ssh: SshManager,
}

impl TaskExecutor {
    pub fn new(storage: Arc<StorageManager>, ssh: SshManager) -> Self {
        Self { storage, ssh }
    }

    pub async fn execute_step_on_host(
        &self,
        server: &ServerRecord,
        command: &str,
    ) -> Result<(i32, String, String, u64), String> {
        let is_local = (server.host == "localhost" || server.host == "127.0.0.1") && server.username == "local";
        let start = Instant::now();

        if is_local {
            let cmd = command.to_string();
            tokio::task::spawn_blocking(move || {
                use std::io::Read;
                use std::process::{Command, Stdio};

                let (shell, flag) = if cfg!(target_os = "windows") {
                    ("powershell", "-Command")
                } else {
                    ("sh", "-c")
                };

                let mut child = Command::new(shell)
                    .arg(flag)
                    .arg(&cmd)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .map_err(|e| format!("执行本地任务失败: {}", e))?;

                let mut stdout_buf = Vec::new();
                let mut stderr_buf = Vec::new();

                if let Some(mut stream) = child.stdout.take() {
                    let _ = stream.read_to_end(&mut stdout_buf);
                }
                if let Some(mut stream) = child.stderr.take() {
                    let _ = stream.read_to_end(&mut stderr_buf);
                }

                let status = child.wait().map_err(|e| format!("等待子进程失败: {}", e))?;
                let code = status.code().unwrap_or(-1);
                let stdout = String::from_utf8_lossy(&stdout_buf).to_string();
                let stderr = String::from_utf8_lossy(&stderr_buf).to_string();
                let elapsed = start.elapsed().as_millis() as u64;

                Ok((code, stdout, stderr, elapsed))
            })
            .await
            .map_err(|e| format!("调度本地执行任务失败: {}", e))?
        } else {
            let options = SshConnectOptions {
                host: server.host.clone(),
                port: server.port,
                username: server.username.clone(),
                auth_type: server.auth_type.clone(),
                credential: server.credential.clone(),
                passphrase: server.passphrase.clone(),
                cols: 80,
                rows: 24,
            };

            let cmd = command.to_string();
            tokio::task::spawn_blocking(move || {
                let sess = SshManager::establish_connection(&options)?;
                sess.set_blocking(true);

                let mut ch = sess
                    .channel_session()
                    .map_err(|e| format!("创建执行通道失败: {}", e))?;
                ch.exec(&cmd).map_err(|e| format!("发送命令失败: {}", e))?;

                use std::io::Read;
                let mut stdout_buf = Vec::new();
                let mut stderr_buf = Vec::new();

                let _ = ch.read_to_end(&mut stdout_buf);
                let _ = ch.stderr().read_to_end(&mut stderr_buf);

                let _ = ch.wait_close();
                let code = ch.exit_status().unwrap_or(0);
                let stdout = String::from_utf8_lossy(&stdout_buf).to_string();
                let stderr = String::from_utf8_lossy(&stderr_buf).to_string();
                let elapsed = start.elapsed().as_millis() as u64;

                Ok((code, stdout, stderr, elapsed))
            })
            .await
            .map_err(|e| format!("调度远程执行任务失败: {}", e))?
        }
    }

    pub async fn execute_batch(
        &self,
        servers: Vec<ServerRecord>,
        command: String,
    ) -> Vec<TaskStep> {
        let mut handles = Vec::new();

        for srv in servers {
            let srv_id = srv.id.clone();
            let srv_name = srv.name.clone();
            let cmd = command.clone();
            let executor = Self {
                storage: Arc::clone(&self.storage),
                ssh: self.ssh.clone(),
            };

            handles.push(tokio::spawn(async move {
                let step_id = format!("step-{}", uuid::Uuid::new_v4().simple());
                match executor.execute_step_on_host(&srv, &cmd).await {
                    Ok((code, stdout, stderr, duration)) => TaskStep {
                        id: step_id,
                        host_id: srv_id,
                        host_name: srv_name,
                        command: cmd,
                        status: if code == 0 { "completed".to_string() } else { "failed".to_string() },
                        stdout,
                        stderr,
                        exit_code: Some(code),
                        duration_ms: duration,
                    },
                    Err(e) => TaskStep {
                        id: step_id,
                        host_id: srv_id,
                        host_name: srv_name,
                        command: cmd,
                        status: "failed".to_string(),
                        stdout: String::new(),
                        stderr: e,
                        exit_code: Some(-1),
                        duration_ms: 0,
                    },
                }
            }));
        }

        let mut results = Vec::new();
        for h in handles {
            if let Ok(res) = h.await {
                results.push(res);
            }
        }
        results
    }
}
