mod agent;
mod commands;
mod crypto;
mod pty;
mod safety;
mod session;
mod sftp;
mod ssh;
mod storage;
mod task;
mod workspace;

use agent::AgentService;
use pty::PtyManager;
use safety::SafetyManager;
use session::SessionManager;
use sftp::TransferRegistry;
use ssh::SshManager;
use storage::StorageManager;
use task::TaskManager;
use workspace::WorkspaceManager;

use std::sync::Arc;
#[cfg(not(target_os = "macos"))]
use tauri::Manager;

pub struct AppState {
    pub storage: Arc<StorageManager>,
    pub pty: PtyManager,
    pub ssh: SshManager,
    pub safety: SafetyManager,
    pub agent: AgentService,
    pub sessions: SessionManager,
    pub workspaces: WorkspaceManager,
    pub tasks: TaskManager,
    pub transfers: TransferRegistry,
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
        transfers: TransferRegistry::new(),
    });

    tauri::Builder::default()
        .manage(app_state)
        .setup(|app| {
            // 方案 A：Windows / Linux 关闭系统装饰，统一使用自绘无边框标题栏；macOS 保留 Overlay 交通灯
            #[cfg(not(target_os = "macos"))]
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_decorations(false);
            }
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
            commands::server::list_servers,
            commands::server::save_server,
            commands::server::delete_server,
            commands::server::get_settings,
            commands::server::save_settings,
            commands::server::list_snippets,
            commands::server::save_snippet,
            commands::server::delete_snippet,
            commands::terminal::start_local_terminal,
            commands::terminal::connect_ssh_terminal,
            commands::terminal::measure_ssh_latency,
            commands::terminal::send_terminal_input,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            commands::terminal::get_session_context,
            commands::terminal::list_sessions,
            commands::terminal::ssh_exec_command,
            commands::terminal::exec_local_command,
            commands::terminal::local_read_file,
            commands::terminal::local_write_file,
            commands::terminal::local_list_dir,
            commands::sftp::sftp_list_dir,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_create_file,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_chmod,
            commands::sftp::sftp_remove,
            commands::sftp::sftp_read_file,
            commands::sftp::sftp_write_file,
            commands::sftp::sftp_get_home_dir,
            commands::sftp::sftp_upload_bytes,
            commands::sftp::sftp_upload_chunk,
            commands::sftp::sftp_upload_file,
            commands::sftp::sftp_upload_path,
            commands::sftp::sftp_download_file,
            commands::sftp::sftp_download_file_progress,
            commands::sftp::sftp_cancel_transfer,
            commands::agent::check_command_safety,
            commands::agent::test_ai_connection,
            commands::agent::stream_ai_chat,
            commands::agent::abort_ai_chat,
            commands::agent::load_chat_history,
            commands::agent::save_chat_history,
            commands::agent::clear_chat_history,
            commands::window::drag_window,
            commands::window::minimize_window,
            commands::window::close_window,
            commands::window::is_window_maximized,
            commands::window::toggle_maximize_window,
            commands::window::set_window_theme,
            commands::window::open_external_url,
            commands::workspace::list_workspaces,
            commands::workspace::save_workspace,
            commands::workspace::delete_workspace,
            commands::workspace::get_workspace_hosts,
            commands::workspace::set_workspace_hosts,
            commands::workspace::list_workspace_tasks,
            commands::workspace::run_workspace_task,
            commands::workspace::execute_host_command,
            commands::workspace::execute_host_file_read,
            commands::workspace::execute_host_file_write
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
