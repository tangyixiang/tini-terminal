use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::State;

use crate::sftp::{SftpListResult, SftpManager, TransferProgressPayload};
use crate::ssh::SshManager;
use crate::AppState;

fn is_sftp_conn_broken_err(err: &str) -> bool {
    let lower = err.to_lowercase();
    if lower.contains("permission denied")
        || lower.contains("no such file")
        || lower.contains("已取消")
        || lower.contains("体积过大")
        || lower.contains("二进制")
        || lower.contains("非 utf-8")
        || lower.contains("非空")
    {
        return false;
    }
    lower.contains("初始化 sftp 通道失败")
        || lower.contains("broken pipe")
        || lower.contains("connection reset")
        || lower.contains("connection aborted")
        || lower.contains("transport")
        || lower.contains("socket")
        || lower.contains("eof")
        || lower.contains("timeout")
}

async fn run_sftp_op<T, F>(ssh: SshManager, session_id: String, op: F) -> Result<T, String>
where
    T: Send + 'static,
    F: Fn(Arc<Mutex<ssh2::Session>>) -> Result<T, String> + Send + Sync + 'static,
{
    let sess = ssh.get_or_create_sftp_session(&session_id)?;
    let op_arc = Arc::new(op);
    let op1 = Arc::clone(&op_arc);
    let res = tokio::task::spawn_blocking(move || op1(sess))
        .await
        .map_err(|e| format!("执行 SFTP 任务失败: {}", e))?;

    match res {
        Ok(val) => Ok(val),
        Err(err) => {
            if is_sftp_conn_broken_err(&err) {
                ssh.invalidate_sftp_session(&session_id);
                if let Ok(new_sess) = ssh.get_or_create_sftp_session(&session_id) {
                    let op2 = Arc::clone(&op_arc);
                    if let Ok(retry_res) = tokio::task::spawn_blocking(move || op2(new_sess)).await
                    {
                        return retry_res;
                    }
                }
            }
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn sftp_list_dir(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    remote_path: String,
) -> Result<SftpListResult, String> {
    let ssh = state.ssh.clone();
    run_sftp_op(ssh, session_id, move |sess| {
        SftpManager::list_dir(sess, &remote_path)
    })
    .await
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    remote_path: String,
) -> Result<(), String> {
    let ssh = state.ssh.clone();
    run_sftp_op(ssh, session_id, move |sess| {
        SftpManager::mkdir(sess, &remote_path)
    })
    .await
}

#[tauri::command]
pub async fn sftp_create_file(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    remote_path: String,
) -> Result<(), String> {
    let ssh = state.ssh.clone();
    run_sftp_op(ssh, session_id, move |sess| {
        SftpManager::create_file(sess, &remote_path)
    })
    .await
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let ssh = state.ssh.clone();
    run_sftp_op(ssh, session_id, move |sess| {
        SftpManager::rename(sess, &old_path, &new_path)
    })
    .await
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    remote_path: String,
    mode: u32,
) -> Result<(), String> {
    let ssh = state.ssh.clone();
    run_sftp_op(ssh, session_id, move |sess| {
        SftpManager::chmod(sess, &remote_path, mode)
    })
    .await
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    remote_path: String,
    is_dir: bool,
    recursive: Option<bool>,
) -> Result<(), String> {
    let ssh = state.ssh.clone();
    let rec = recursive.unwrap_or(false);
    run_sftp_op(ssh, session_id, move |sess| {
        SftpManager::remove(sess, &remote_path, is_dir, rec)
    })
    .await
}

#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    remote_path: String,
    max_bytes: Option<u64>,
) -> Result<String, String> {
    let ssh = state.ssh.clone();
    run_sftp_op(ssh, session_id, move |sess| {
        SftpManager::read_file(sess, &remote_path, max_bytes)
    })
    .await
}

#[tauri::command]
pub async fn sftp_write_file(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    remote_path: String,
    content: String,
) -> Result<(), String> {
    let ssh = state.ssh.clone();
    run_sftp_op(ssh, session_id, move |sess| {
        SftpManager::write_file(sess, &remote_path, &content)
    })
    .await
}

#[tauri::command]
pub async fn sftp_get_home_dir(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Result<String, String> {
    let ssh = state.ssh.clone();
    run_sftp_op(ssh, session_id, move |sess| SftpManager::get_home_dir(sess)).await
}

#[tauri::command]
pub async fn sftp_upload_bytes(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    remote_dir: String,
    file_name: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let ssh = state.ssh.clone();
    run_sftp_op(ssh, session_id, move |sess| {
        SftpManager::upload_bytes(sess, &remote_dir, &file_name, &data)
    })
    .await
}

#[tauri::command]
pub async fn sftp_upload_chunk(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    remote_path: String,
    offset: u64,
    data: Vec<u8>,
) -> Result<(), String> {
    let ssh = state.ssh.clone();
    run_sftp_op(ssh, session_id, move |sess| {
        SftpManager::upload_chunk(sess, &remote_path, offset, &data)
    })
    .await
}

#[tauri::command]
pub async fn sftp_upload_file(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let ssh = state.ssh.clone();
    run_sftp_op(ssh, session_id, move |sess| {
        SftpManager::upload_local_file(sess, &local_path, &remote_path)
    })
    .await
}

#[tauri::command]
pub async fn sftp_upload_path(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    local_path: String,
    remote_dir: String,
    transfer_id: String,
    channel: Channel<TransferProgressPayload>,
) -> Result<usize, String> {
    let ssh = state.ssh.clone();
    let transfers = state.transfers.clone();
    let cancel_flag = transfers.register(&transfer_id);
    let tid = transfer_id.clone();

    let res = run_sftp_op(ssh, session_id, move |sess| {
        SftpManager::upload_local_path(
            sess,
            &local_path,
            &remote_dir,
            Some(tid.clone()),
            Some(Arc::clone(&cancel_flag)),
            Some(channel.clone()),
        )
    })
    .await;

    transfers.unregister(&transfer_id);
    res
}

#[tauri::command]
pub async fn sftp_download_file(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    remote_path: String,
) -> Result<String, String> {
    let ssh = state.ssh.clone();
    run_sftp_op(ssh, session_id, move |sess| {
        SftpManager::download_to_downloads_dir(sess, &remote_path, None, None, None)
    })
    .await
}

#[tauri::command]
pub async fn sftp_download_file_progress(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    remote_path: String,
    transfer_id: String,
    channel: Channel<TransferProgressPayload>,
) -> Result<String, String> {
    let ssh = state.ssh.clone();
    let transfers = state.transfers.clone();
    let cancel_flag = transfers.register(&transfer_id);
    let tid = transfer_id.clone();

    let res = run_sftp_op(ssh, session_id, move |sess| {
        SftpManager::download_to_downloads_dir(
            sess,
            &remote_path,
            Some(tid.clone()),
            Some(Arc::clone(&cancel_flag)),
            Some(channel.clone()),
        )
    })
    .await;

    transfers.unregister(&transfer_id);
    res
}

#[tauri::command]
pub fn sftp_cancel_transfer(state: State<Arc<AppState>>, transfer_id: String) {
    state.transfers.cancel(&transfer_id);
}
