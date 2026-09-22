mod agent;
mod pty;
mod safety;
mod sftp;
mod ssh;
mod storage;

use agent::{AgentService, AiStreamEvent, StreamAiChatRequest, TestAiRequest, TestAiResponse};
use pty::{PtyManager, TerminalOutputPayload};
use safety::{SafetyCheckResult, SafetyManager};
use sftp::{SftpListResult, SftpManager};
use ssh::{SshConnectOptions, SshExecResult, SshManager};
use storage::{ServerRecord, StorageManager};

use std::collections::HashMap;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

pub struct AppState {
    pub storage: StorageManager,
    pub pty: PtyManager,
    pub ssh: SshManager,
    pub safety: SafetyManager,
    pub agent: AgentService,
}

// ---------------- 服务器管理命令 ----------------

#[tauri::command]
fn list_servers(state: State<Arc<AppState>>) -> Result<Vec<ServerRecord>, String> {
    state.storage.list_servers().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_server(state: State<Arc<AppState>>, server: ServerRecord) -> Result<(), String> {
    state.storage.save_server(&server).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_server(state: State<Arc<AppState>>, id: String) -> Result<(), String> {
    state.storage.delete_server(&id).map_err(|e| e.to_string())
}

// ---------------- 设置管理命令 ----------------

#[tauri::command]
fn get_settings(state: State<Arc<AppState>>) -> Result<HashMap<String, String>, String> {
    state.storage.get_settings().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_settings(
    state: State<Arc<AppState>>,
    settings: HashMap<String, String>,
) -> Result<(), String> {
    state.storage.save_settings(&settings).map_err(|e| e.to_string())
}

// ---------------- 本地与远程终端命令 ----------------

#[tauri::command]
fn start_local_terminal(
    state: State<Arc<AppState>>,
    session_id: String,
    cols: u16,
    rows: u16,
    channel: Channel<TerminalOutputPayload>,
) -> Result<(), String> {
    state.pty.start_session(session_id, cols, rows, channel)
}

#[tauri::command]
async fn connect_ssh_terminal(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    options: SshConnectOptions,
    channel: Channel<TerminalOutputPayload>,
) -> Result<(), String> {
    let ssh = state.ssh.clone();
    tokio::task::spawn_blocking(move || {
        ssh.connect(session_id, options, channel)
    })
    .await
    .map_err(|e| format!("执行 SSH 连接任务失败: {}", e))?
}

#[tauri::command]
async fn send_terminal_input(
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
fn resize_terminal(
    state: State<Arc<AppState>>,
    session_id: String,
    is_ssh: bool,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if is_ssh {
        state.ssh.resize(&session_id, cols, rows)
    } else {
        state.pty.resize(&session_id, cols, rows)
    }
}

#[tauri::command]
fn close_terminal(state: State<Arc<AppState>>, session_id: String, is_ssh: bool) {
    if is_ssh {
        state.ssh.close(&session_id);
    } else {
        state.pty.close(&session_id);
    }
}

#[tauri::command]
async fn ssh_exec_command(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    command: String,
) -> Result<SshExecResult, String> {
    let ssh = state.ssh.clone();
    tokio::task::spawn_blocking(move || {
        ssh.exec_command(&session_id, &command)
    })
    .await
    .map_err(|e| format!("执行远程命令任务失败: {}", e))?
}

#[tauri::command]
async fn exec_local_command(command: String) -> Result<SshExecResult, String> {
    tokio::task::spawn_blocking(move || {
        let start = std::time::Instant::now();
        let (shell, flag) = if cfg!(target_os = "windows") {
            ("powershell", "-Command")
        } else {
            ("sh", "-c")
        };
        let output = std::process::Command::new(shell)
            .arg(flag)
            .arg(&command)
            .output()
            .map_err(|e| format!("执行本地命令失败: {}", e))?;
        Ok(SshExecResult {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            duration_ms: start.elapsed().as_millis() as u64,
        })
    })
    .await
    .map_err(|e| format!("执行本地命令任务错误: {}", e))?
}

// ---------------- SFTP 文件管理命令 ----------------

#[tauri::command]
async fn sftp_list_dir(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    remote_path: String,
) -> Result<SftpListResult, String> {
    let sess = state
        .ssh
        .get_or_create_sftp_session(&session_id)?;
    tokio::task::spawn_blocking(move || {
        SftpManager::list_dir(sess, &remote_path)
    })
    .await
    .map_err(|e| format!("执行 SFTP 读取目录失败: {}", e))?
}

#[tauri::command]
async fn sftp_mkdir(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    remote_path: String,
) -> Result<(), String> {
    let sess = state
        .ssh
        .get_or_create_sftp_session(&session_id)?;
    tokio::task::spawn_blocking(move || {
        SftpManager::mkdir(sess, &remote_path)
    })
    .await
    .map_err(|e| format!("新建文件夹失败: {}", e))?
}

#[tauri::command]
async fn sftp_create_file(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    remote_path: String,
) -> Result<(), String> {
    let sess = state
        .ssh
        .get_or_create_sftp_session(&session_id)?;
    tokio::task::spawn_blocking(move || {
        SftpManager::create_file(sess, &remote_path)
    })
    .await
    .map_err(|e| format!("新建文件失败: {}", e))?
}

#[tauri::command]
async fn sftp_rename(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let sess = state
        .ssh
        .get_or_create_sftp_session(&session_id)?;
    tokio::task::spawn_blocking(move || {
        SftpManager::rename(sess, &old_path, &new_path)
    })
    .await
    .map_err(|e| format!("重命名失败: {}", e))?
}

#[tauri::command]
async fn sftp_remove(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    remote_path: String,
    is_dir: bool,
) -> Result<(), String> {
    let sess = state
        .ssh
        .get_or_create_sftp_session(&session_id)?;
    tokio::task::spawn_blocking(move || {
        SftpManager::remove(sess, &remote_path, is_dir)
    })
    .await
    .map_err(|e| format!("删除失败: {}", e))?
}

#[tauri::command]
async fn sftp_read_file(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    remote_path: String,
) -> Result<String, String> {
    let sess = state
        .ssh
        .get_or_create_sftp_session(&session_id)?;
    tokio::task::spawn_blocking(move || {
        SftpManager::read_file(sess, &remote_path)
    })
    .await
    .map_err(|e| format!("执行 SFTP 读取文件失败: {}", e))?
}

#[tauri::command]
async fn sftp_write_file(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    remote_path: String,
    content: String,
) -> Result<(), String> {
    let sess = state
        .ssh
        .get_or_create_sftp_session(&session_id)?;
    tokio::task::spawn_blocking(move || {
        SftpManager::write_file(sess, &remote_path, &content)
    })
    .await
    .map_err(|e| format!("执行 SFTP 写入文件失败: {}", e))?
}

#[tauri::command]
async fn sftp_get_home_dir(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Result<String, String> {
    let sess = state
        .ssh
        .get_or_create_sftp_session(&session_id)?;
    tokio::task::spawn_blocking(move || {
        SftpManager::get_home_dir(sess)
    })
    .await
    .map_err(|e| format!("获取 SFTP 用户根目录失败: {}", e))?
}

#[tauri::command]
async fn sftp_upload_bytes(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    remote_dir: String,
    file_name: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let sess = state
        .ssh
        .get_or_create_sftp_session(&session_id)?;
    tokio::task::spawn_blocking(move || {
        SftpManager::upload_bytes(sess, &remote_dir, &file_name, &data)
    })
    .await
    .map_err(|e| format!("执行 SFTP 上传文件失败: {}", e))?
}

#[tauri::command]
async fn sftp_download_file(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    remote_path: String,
) -> Result<String, String> {
    let sess = state
        .ssh
        .get_or_create_sftp_session(&session_id)?;
    tokio::task::spawn_blocking(move || {
        SftpManager::download_to_downloads_dir(sess, &remote_path)
    })
    .await
    .map_err(|e| format!("执行 SFTP 下载文件失败: {}", e))?
}

#[tauri::command]
async fn sftp_upload_file(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let sess = state
        .ssh
        .get_or_create_sftp_session(&session_id)?;
    tokio::task::spawn_blocking(move || {
        SftpManager::upload_local_file(sess, &local_path, &remote_path)
    })
    .await
    .map_err(|e| format!("执行 SFTP 本地文件上传失败: {}", e))?
}

// ---------------- 危险命令拦截与 AI 命令 ----------------

#[tauri::command]
fn check_command_safety(
    state: State<Arc<AppState>>,
    command: String,
) -> SafetyCheckResult {
    state.safety.check_command(&command)
}

#[tauri::command]
fn log_debug(msg: String) {
    use std::fs::OpenOptions;
    use std::io::Write;
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open("/tmp/tauri_drag.log") {
        let _ = writeln!(file, "[FRONTEND] {}", msg);
    }
}

#[tauri::command]
fn drag_window(window: tauri::Window) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::io::Write;
    let mut file = OpenOptions::new().create(true).append(true).open("/tmp/tauri_drag.log").ok();
    if let Some(ref mut f) = file {
        let _ = writeln!(f, "[RUST] drag_window invoked for window: {}", window.label());
    }
    let res = window.start_dragging();
    if let Some(ref mut f) = file {
        let _ = writeln!(f, "[RUST] window.start_dragging() result: {:?}", res);
    }
    res.map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_maximize_window(window: tauri::Window) -> Result<(), String> {
    let maximized = window.is_maximized().map_err(|e| e.to_string())?;
    if maximized {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn test_ai_connection(req: TestAiRequest) -> TestAiResponse {
    AgentService::test_connection(req).await
}

#[tauri::command]
async fn stream_ai_chat(
    state: State<'_, Arc<AppState>>,
    req: StreamAiChatRequest,
    channel: Channel<AiStreamEvent>,
) -> Result<(), String> {
    let agent = state.agent.clone();
    agent.stream_chat(req, channel).await
}

#[tauri::command]
fn abort_ai_chat(state: State<Arc<AppState>>, request_id: String) -> Result<(), String> {
    state.agent.abort_chat(&request_id);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = Arc::new(AppState {
        storage: StorageManager::new(),
        pty: PtyManager::new(),
        ssh: SshManager::new(),
        safety: SafetyManager::new(),
        agent: AgentService::new(),
    });

    tauri::Builder::default()
        .manage(app_state)
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_servers,
            save_server,
            delete_server,
            get_settings,
            save_settings,
            start_local_terminal,
            connect_ssh_terminal,
            send_terminal_input,
            resize_terminal,
            close_terminal,
            ssh_exec_command,
            exec_local_command,
            sftp_list_dir,
            sftp_mkdir,
            sftp_create_file,
            sftp_rename,
            sftp_remove,
            sftp_read_file,
            sftp_write_file,
            sftp_get_home_dir,
            sftp_upload_bytes,
            sftp_upload_file,
            sftp_download_file,
            check_command_safety,
            test_ai_connection,
            stream_ai_chat,
            abort_ai_chat,
            log_debug,
            drag_window,
            toggle_maximize_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
