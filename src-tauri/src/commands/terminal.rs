use std::path::Path;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

use crate::pty::TerminalOutputPayload;
use crate::session::{SessionContext, SessionInfo};
use crate::sftp::{RemoteFileInfo, SftpListResult};
use crate::ssh::{
    drain_valid_utf8, expand_tilde_path, ExecStreamPayload, SshConnectOptions, SshConnectResult,
    SshExecResult,
};
use crate::AppState;

#[tauri::command]
pub fn start_local_terminal(
    state: State<Arc<AppState>>,
    session_id: String,
    cols: u16,
    rows: u16,
    channel: Channel<TerminalOutputPayload>,
) -> Result<u64, String> {
    state
        .pty
        .start_session(session_id, cols, rows, channel, state.sessions.clone())
}

#[tauri::command]
pub async fn connect_ssh_terminal(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    options: SshConnectOptions,
    channel: Channel<TerminalOutputPayload>,
) -> Result<SshConnectResult, String> {
    let ssh = state.ssh.clone();
    let sessions = state.sessions.clone();
    tokio::task::spawn_blocking(move || ssh.connect(session_id, options, channel, sessions))
        .await
        .map_err(|e| format!("执行 SSH 连接任务失败: {}", e))?
}

#[tauri::command]
pub async fn measure_ssh_latency(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Result<u64, String> {
    let ssh = state.ssh.clone();
    tokio::task::spawn_blocking(move || ssh.measure_latency(&session_id))
        .await
        .map_err(|e| format!("延迟探测任务异常: {}", e))?
}

#[tauri::command]
pub async fn send_terminal_input(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    is_ssh: bool,
    data: String,
) -> Result<(), String> {
    let app_state = Arc::clone(&state);
    tokio::task::spawn_blocking(move || {
        let bytes = data.as_bytes();
        if is_ssh {
            app_state.ssh.write_data(&session_id, bytes)
        } else {
            app_state.pty.write_data(&session_id, bytes)
        }
    })
    .await
    .map_err(|e| format!("发送终端输入任务失败: {}", e))?
}

#[tauri::command]
pub fn resize_terminal(
    state: State<Arc<AppState>>,
    session_id: String,
    is_ssh: bool,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.sessions.update_context(&session_id, |ctx| {
        ctx.terminal_width = cols;
        ctx.terminal_height = rows;
    });
    if is_ssh {
        state.ssh.resize(&session_id, cols, rows)
    } else {
        state.pty.resize(&session_id, cols, rows)
    }
}

#[tauri::command]
pub fn close_terminal(state: State<Arc<AppState>>, session_id: String, is_ssh: bool) {
    if is_ssh {
        state.ssh.close(&session_id);
    } else {
        state.pty.close(&session_id);
    }
    state.sessions.unregister_session(&session_id);
}

#[tauri::command]
pub fn get_session_context(
    state: State<Arc<AppState>>,
    session_id: String,
) -> Option<SessionContext> {
    state.sessions.get_context(&session_id)
}

#[tauri::command]
pub fn list_sessions(state: State<Arc<AppState>>) -> Vec<SessionInfo> {
    state.sessions.list_sessions()
}

#[tauri::command]
pub async fn ssh_exec_command(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    command: String,
    channel: Channel<ExecStreamPayload>,
) -> Result<SshExecResult, String> {
    let ssh = state.ssh.clone();
    tokio::task::spawn_blocking(move || ssh.exec_command(&session_id, &command, Some(channel)))
        .await
        .map_err(|e| format!("执行远程命令任务失败: {}", e))?
}

#[tauri::command]
pub async fn exec_local_command(
    command: String,
    cwd: Option<String>,
    channel: Channel<ExecStreamPayload>,
) -> Result<SshExecResult, String> {
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        use std::process::{Command, Stdio};

        let start = std::time::Instant::now();
        let mut process = if cfg!(target_os = "windows") {
            let utf8_cmd = format!(
                "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); {}",
                command
            );
            let mut c = Command::new("powershell");
            c.args(["-NoProfile", "-NonInteractive", "-Command", &utf8_cmd]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                c.creation_flags(0x08000000);
            }
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", &command]);
            c
        };

        if let Some(dir) = cwd {
            let expanded = expand_tilde_path(&dir);
            if expanded.exists() && expanded.is_dir() {
                process.current_dir(expanded);
            }
        }

        let mut child = process
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("执行本地命令失败: {}", e))?;

        let stdout_handle = child.stdout.take();
        let stderr_handle = child.stderr.take();

        let channel_out = channel.clone();
        let t_out = std::thread::spawn(move || {
            let mut out = Vec::new();
            let mut pending = Vec::new();
            if let Some(mut stream) = stdout_handle {
                let mut buf = [0u8; 2048];
                while let Ok(n) = stream.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    out.extend_from_slice(&buf[..n]);
                    pending.extend_from_slice(&buf[..n]);
                    if let Some(chunk) = drain_valid_utf8(&mut pending) {
                        let _ = channel_out.send(ExecStreamPayload {
                            stream: "stdout".to_string(),
                            data: chunk,
                        });
                    }
                }
            }
            if !pending.is_empty() {
                let _ = channel_out.send(ExecStreamPayload {
                    stream: "stdout".to_string(),
                    data: String::from_utf8_lossy(&pending).to_string(),
                });
            }
            out
        });

        let channel_err = channel.clone();
        let t_err = std::thread::spawn(move || {
            let mut err = Vec::new();
            let mut pending = Vec::new();
            if let Some(mut stream) = stderr_handle {
                let mut buf = [0u8; 2048];
                while let Ok(n) = stream.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    err.extend_from_slice(&buf[..n]);
                    pending.extend_from_slice(&buf[..n]);
                    if let Some(chunk) = drain_valid_utf8(&mut pending) {
                        let _ = channel_err.send(ExecStreamPayload {
                            stream: "stderr".to_string(),
                            data: chunk,
                        });
                    }
                }
            }
            if !pending.is_empty() {
                let _ = channel_err.send(ExecStreamPayload {
                    stream: "stderr".to_string(),
                    data: String::from_utf8_lossy(&pending).to_string(),
                });
            }
            err
        });

        let status = child
            .wait()
            .map_err(|e| format!("等待子进程退出失败: {}", e))?;
        let stdout_data = t_out.join().unwrap_or_default();
        let stderr_data = t_err.join().unwrap_or_default();

        let exit_code = status.code().unwrap_or(-1);
        let mut stderr_text = String::from_utf8_lossy(&stderr_data).to_string();
        if status.code().is_none() {
            if !stderr_text.is_empty() && !stderr_text.ends_with('\n') {
                stderr_text.push('\n');
            }
            stderr_text.push_str("[本地命令未正常退出，可能已被信号终止]");
        }

        Ok(SshExecResult {
            exit_code,
            stdout: String::from_utf8_lossy(&stdout_data).to_string(),
            stderr: stderr_text,
            duration_ms: start.elapsed().as_millis() as u64,
        })
    })
    .await
    .map_err(|e| format!("执行本地命令任务错误: {}", e))?
}

#[tauri::command]
pub async fn local_read_file(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let target = expand_tilde_path(&path);
        let meta = std::fs::metadata(&target)
            .map_err(|e| format!("无法访问本地文件 ({}): {}", target.display(), e))?;
        if meta.len() > 2 * 1024 * 1024 {
            return Err(format!(
                "本地文件体积过大 ({:.2} MB，超过 2MB 限制)",
                meta.len() as f64 / (1024.0 * 1024.0)
            ));
        }
        std::fs::read_to_string(&target)
            .map_err(|e| format!("读取本地文件失败 ({}): {}", target.display(), e))
    })
    .await
    .map_err(|e| format!("本地读文件任务失败: {}", e))?
}

#[tauri::command]
pub async fn local_write_file(path: String, content: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let target = expand_tilde_path(&path);
        if let Some(parent) = target.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("创建本地父目录失败: {}", e))?;
            }
        }
        std::fs::write(&target, content.as_bytes())
            .map_err(|e| format!("写入本地文件失败 ({}): {}", target.display(), e))
    })
    .await
    .map_err(|e| format!("本地写文件任务失败: {}", e))?
}

#[tauri::command]
pub async fn local_list_dir(path: String) -> Result<SftpListResult, String> {
    tokio::task::spawn_blocking(move || {
        let target = if path.trim().is_empty() || path.trim() == "." || path.trim() == "~" {
            dirs::home_dir().unwrap_or_else(|| Path::new(".").to_path_buf())
        } else {
            expand_tilde_path(&path)
        };
        let current_dir = target.to_string_lossy().to_string();
        let entries = std::fs::read_dir(&target)
            .map_err(|e| format!("读取本地目录失败 ({}): {}", current_dir, e))?;
        let mut files = Vec::new();
        for entry in entries.flatten() {
            let p = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let meta = std::fs::metadata(&p).ok();
            let sym_meta = std::fs::symlink_metadata(&p).ok();
            let is_symlink = sym_meta
                .as_ref()
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false);
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let mtime = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            #[cfg(unix)]
            let permissions = {
                use std::os::unix::fs::PermissionsExt;
                meta.as_ref().map(|m| m.permissions().mode()).unwrap_or(0)
            };
            #[cfg(not(unix))]
            let permissions = 0u32;

            files.push(RemoteFileInfo {
                name,
                path: p.to_string_lossy().to_string(),
                size,
                is_dir,
                is_symlink,
                permissions,
                mtime,
            });
        }
        files.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(SftpListResult { current_dir, files })
    })
    .await
    .map_err(|e| format!("本地目录列表任务失败: {}", e))?
}
