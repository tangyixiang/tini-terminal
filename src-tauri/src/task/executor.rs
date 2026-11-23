use std::io::Read;
use std::sync::Arc;
use std::time::{Duration, Instant};

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
        let is_local =
            (server.host == "localhost" || server.host == "127.0.0.1") && server.username == "local";
        let start = Instant::now();

        if is_local {
            let cmd = command.to_string();
            tokio::task::spawn_blocking(move || {
                use std::process::{Command, Stdio};

                let mut process = if cfg!(target_os = "windows") {
                    let utf8_cmd = format!(
                        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); {}",
                        cmd
                    );
                    let mut c = Command::new("powershell");
                    c.args(["-NoProfile", "-NonInteractive", "-Command", &utf8_cmd]);
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
                    }
                    c
                } else {
                    let mut c = Command::new("sh");
                    c.args(["-c", &cmd]);
                    c
                };

                let mut child = process
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
                sess.set_blocking(false);

                let open_start = Instant::now();
                let mut ch = loop {
                    match sess.channel_session() {
                        Ok(c) => break c,
                        Err(e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                            if open_start.elapsed() > Duration::from_secs(10) {
                                return Err("创建执行通道超时".to_string());
                            }
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(e) => return Err(format!("创建执行通道失败: {}", e)),
                    }
                };

                let exec_start = Instant::now();
                loop {
                    match ch.exec(&cmd) {
                        Ok(()) => break,
                        Err(e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                            if exec_start.elapsed() > Duration::from_secs(10) {
                                return Err("发送命令超时".to_string());
                            }
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(e) => return Err(format!("发送命令失败: {}", e)),
                    }
                }

                let timeout = Duration::from_secs(120);
                let mut stdout_buf = Vec::new();
                let mut stderr_buf = Vec::new();
                let mut buf = [0u8; 4096];

                loop {
                    let mut read_any = false;
                    match ch.read(&mut buf) {
                        Ok(n) if n > 0 => {
                            stdout_buf.extend_from_slice(&buf[..n]);
                            read_any = true;
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                        Err(e) => return Err(format!("读取标准输出失败: {}", e)),
                        _ => {}
                    }
                    match ch.stderr().read(&mut buf) {
                        Ok(n) if n > 0 => {
                            stderr_buf.extend_from_slice(&buf[..n]);
                            read_any = true;
                        }
                        _ => {}
                    }
                    if ch.eof() {
                        while let Ok(n) = ch.read(&mut buf) {
                            if n == 0 {
                                break;
                            }
                            stdout_buf.extend_from_slice(&buf[..n]);
                        }
                        while let Ok(n) = ch.stderr().read(&mut buf) {
                            if n == 0 {
                                break;
                            }
                            stderr_buf.extend_from_slice(&buf[..n]);
                        }
                        break;
                    }
                    if !read_any {
                        if exec_start.elapsed() > timeout {
                            return Err(format!("远程命令执行超时 ({}s)", timeout.as_secs()));
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }

                let close_start = Instant::now();
                loop {
                    match ch.wait_close() {
                        Ok(()) => break,
                        Err(e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                            if close_start.elapsed() > Duration::from_secs(5) {
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        Err(_) => break,
                    }
                }

                let code = ch.exit_status().map_err(|e| {
                    format!("无法获取远程命令退出码，通道可能已异常关闭: {}", e)
                })?;
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
                        status: if code == 0 {
                            "completed".to_string()
                        } else {
                            "failed".to_string()
                        },
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
