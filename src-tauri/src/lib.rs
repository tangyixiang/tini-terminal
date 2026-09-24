mod agent;
mod pty;
mod safety;
mod session;
mod sftp;
mod ssh;
mod storage;
mod task;
mod workspace;

use agent::{AgentService, AiStreamEvent, StreamAiChatRequest, TestAiRequest, TestAiResponse};
use pty::{PtyManager, TerminalOutputPayload};
use safety::{SafetyCheckResult, SafetyManager};
use session::{SessionContext, SessionInfo, SessionManager};
use sftp::{SftpListResult, SftpManager};
use ssh::{ExecStreamPayload, SshConnectOptions, SshExecResult, SshManager};
use storage::{ServerRecord, StorageManager};
use task::{HostExecResult, TaskPlan, TaskManager};
use workspace::{Workspace, WorkspaceManager};

use std::collections::HashMap;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

pub struct AppState {
    pub storage: Arc<StorageManager>,
    pub pty: PtyManager,
    pub ssh: SshManager,
    pub safety: SafetyManager,
    pub agent: AgentService,
    pub sessions: SessionManager,
    pub workspaces: WorkspaceManager,
    pub tasks: TaskManager,
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
    channel: Channel<ExecStreamPayload>,
) -> Result<SshExecResult, String> {
    let ssh = state.ssh.clone();
    tokio::task::spawn_blocking(move || {
        ssh.exec_command(&session_id, &command, Some(channel))
    })
    .await
    .map_err(|e| format!("执行远程命令任务失败: {}", e))?
}

#[tauri::command]
async fn exec_local_command(
    command: String,
    channel: Channel<ExecStreamPayload>,
) -> Result<SshExecResult, String> {
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        use std::process::{Command, Stdio};

        let start = std::time::Instant::now();
        let (shell, flag) = if cfg!(target_os = "windows") {
            ("powershell", "-Command")
        } else {
            ("sh", "-c")
        };

        let mut child = Command::new(shell)
            .arg(flag)
            .arg(&command)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("执行本地命令失败: {}", e))?;

        let stdout_handle = child.stdout.take();
        let stderr_handle = child.stderr.take();

        let channel_out = channel.clone();
        let t_out = std::thread::spawn(move || {
            let mut out = Vec::new();
            if let Some(mut stream) = stdout_handle {
                let mut buf = [0u8; 2048];
                while let Ok(n) = stream.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    out.extend_from_slice(&buf[..n]);
                    let _ = channel_out.send(ExecStreamPayload {
                        stream: "stdout".to_string(),
                        data: chunk,
                    });
                }
            }
            out
        });

        let channel_err = channel.clone();
        let t_err = std::thread::spawn(move || {
            let mut err = Vec::new();
            if let Some(mut stream) = stderr_handle {
                let mut buf = [0u8; 2048];
                while let Ok(n) = stream.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    err.extend_from_slice(&buf[..n]);
                    let _ = channel_err.send(ExecStreamPayload {
                        stream: "stderr".to_string(),
                        data: chunk,
                    });
                }
            }
            err
        });

        let status = child.wait().map_err(|e| format!("等待子进程退出失败: {}", e))?;
        let stdout_data = t_out.join().unwrap_or_default();
        let stderr_data = t_err.join().unwrap_or_default();

        Ok(SshExecResult {
            exit_code: status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&stdout_data).to_string(),
            stderr: String::from_utf8_lossy(&stderr_data).to_string(),
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
fn set_window_theme(window: tauri::Window, is_dark: bool) -> Result<(), String> {
    let theme = if is_dark {
        Some(tauri::Theme::Dark)
    } else {
        Some(tauri::Theme::Light)
    };
    window.set_theme(theme).map_err(|e| e.to_string())
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

// ---------------- 工作区管理命令 ----------------

#[tauri::command]
fn list_workspaces(state: State<Arc<AppState>>) -> Result<Vec<Workspace>, String> {
    state.workspaces.list()
}

#[tauri::command]
fn save_workspace(state: State<Arc<AppState>>, workspace: Workspace) -> Result<(), String> {
    state.workspaces.save(workspace)
}

#[tauri::command]
fn delete_workspace(state: State<Arc<AppState>>, id: String) -> Result<(), String> {
    state.workspaces.delete(&id)
}

#[tauri::command]
fn get_workspace_hosts(state: State<Arc<AppState>>, workspace_id: String) -> Result<Vec<String>, String> {
    state.workspaces.get_hosts(&workspace_id)
}

#[tauri::command]
fn set_workspace_hosts(
    state: State<Arc<AppState>>,
    workspace_id: String,
    host_ids: Vec<String>,
) -> Result<(), String> {
    state.workspaces.set_hosts(&workspace_id, &host_ids)
}

// ---------------- 会话与多机任务命令 ----------------

#[tauri::command]
fn get_session_context(state: State<Arc<AppState>>, session_id: String) -> Option<SessionContext> {
    state.sessions.get_context(&session_id)
}

#[tauri::command]
fn list_sessions(state: State<Arc<AppState>>) -> Vec<SessionInfo> {
    state.sessions.list_sessions()
}

#[tauri::command]
fn list_workspace_tasks(
    state: State<Arc<AppState>>,
    workspace_id: Option<String>,
) -> Result<Vec<TaskPlan>, String> {
    state.tasks.list_tasks(workspace_id.as_deref())
}

#[tauri::command]
async fn run_workspace_task(
    state: State<'_, Arc<AppState>>,
    workspace_id: String,
    prompt: String,
    target_host_ids: Vec<String>,
    command: String,
) -> Result<TaskPlan, String> {
    let tasks = state.tasks.clone();
    tasks.run_workspace_task(&workspace_id, &prompt, &target_host_ids, &command).await
}

#[tauri::command]
async fn execute_host_command(
    state: State<'_, Arc<AppState>>,
    host_id: String,
    command: String,
) -> Result<HostExecResult, String> {
    let tasks = state.tasks.clone();
    tasks.execute_on_host(&host_id, &command).await
}

#[tauri::command]
async fn execute_host_file_read(
    state: State<'_, Arc<AppState>>,
    host_id: String,
    file_path: String,
) -> Result<String, String> {
    let tasks = state.tasks.clone();
    tasks.read_host_file(&host_id, &file_path).await
}

#[tauri::command]
async fn execute_host_file_write(
    state: State<'_, Arc<AppState>>,
    host_id: String,
    file_path: String,
    content: String,
) -> Result<(), String> {
    let tasks = state.tasks.clone();
    tasks.write_host_file(&host_id, &file_path, &content).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let storage = Arc::new(StorageManager::new());
    let ssh = SshManager::new();
    let sessions = SessionManager::new();
    let workspaces = WorkspaceManager::new(Arc::clone(&storage));
    let tasks = TaskManager::new(Arc::clone(&storage), ssh.clone());

    let app_state = Arc::new(AppState {
        storage,
        pty: PtyManager::new(),
        ssh,
        safety: SafetyManager::new(),
        agent: AgentService::new(),
        sessions,
        workspaces,
        tasks,
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
            toggle_maximize_window,
            set_window_theme,
            list_workspaces,
            save_workspace,
            delete_workspace,
            get_workspace_hosts,
            set_workspace_hosts,
            get_session_context,
            list_sessions,
            list_workspace_tasks,
            run_workspace_task,
            execute_host_command,
            execute_host_file_read,
            execute_host_file_write
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
