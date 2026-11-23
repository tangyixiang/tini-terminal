use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

use crate::pty::TerminalOutputPayload;
use crate::session::{CwdTracker, SessionManager};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SshConnectOptions {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String, // "password" | "key" | "agent"
    pub credential: Option<String>,
    pub passphrase: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SshExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExecStreamPayload {
    pub stream: String,
    pub data: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SshConnectResult {
    pub latency_ms: u64,
    pub generation: u64,
}

enum SshActorCmd {
    Write(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

pub struct SshSessionHandle {
    pub generation: u64,
    cmd_tx: Sender<SshActorCmd>,
    pub options: SshConnectOptions,
}

#[derive(Clone)]
pub struct SshManager {
    sessions: Arc<Mutex<HashMap<String, SshSessionHandle>>>,
    /// SFTP 专用长连接池（与 AI exec 及交互 PTY 彻底隔离，杜绝锁竞争与阻塞态污染）
    sftp_sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
    /// AI 命令执行专用长连接池
    exec_sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
    next_generation: Arc<AtomicU64>,
}

/// 跨平台展开私钥路径中的 ~ 前缀（兼容 Unix ~/ 与 Windows ~\）
pub fn expand_tilde_path(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if trimmed == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    } else if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(trimmed)
}

/// 从字节流安全解码完整 UTF-8 文本，将跨包截断的不完整多字节尾部留待下一次读取
pub fn drain_valid_utf8(pending: &mut Vec<u8>) -> Option<String> {
    if pending.is_empty() {
        return None;
    }
    match std::str::from_utf8(pending) {
        Ok(valid) => {
            let out = valid.to_string();
            pending.clear();
            Some(out)
        }
        Err(e) => {
            let valid_up_to = e.valid_up_to();
            if let Some(err_len) = e.error_len() {
                let end = (valid_up_to + err_len).min(pending.len());
                let out = String::from_utf8_lossy(&pending[..end]).to_string();
                pending.drain(..end);
                Some(out)
            } else if valid_up_to > 0 {
                let out = std::str::from_utf8(&pending[..valid_up_to])
                    .unwrap_or("")
                    .to_string();
                pending.drain(..valid_up_to);
                Some(out)
            } else {
                None
            }
        }
    }
}

fn spawn_keepalive_reaper(pool: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(15));
        let dead_ids: Vec<String> = {
            if let Ok(map) = pool.lock() {
                let mut dead = Vec::new();
                for (id, sess_arc) in map.iter() {
                    if let Ok(s) = sess_arc.try_lock() {
                        if !s.authenticated() || s.keepalive_send().is_err() {
                            dead.push(id.clone());
                        }
                    }
                }
                dead
            } else {
                Vec::new()
            }
        };

        if !dead_ids.is_empty() {
            if let Ok(mut map) = pool.lock() {
                for id in dead_ids {
                    if let Some(dead_sess) = map.remove(&id) {
                        if let Ok(s) = dead_sess.lock() {
                            let _ = s.disconnect(None, "keepalive timeout", None);
                        }
                    }
                }
            }
        }
    });
}

/// 在单一 Actor 线程内安全写入非阻塞 SSH 通道，避免跨线程争抢 libssh2 Session
fn write_all_nonblocking(channel: &mut ssh2::Channel, data: &[u8]) -> Result<(), String> {
    let mut written = 0;
    let start = Instant::now();
    while written < data.len() {
        match channel.write(&data[written..]) {
            Ok(0) => {
                if start.elapsed() > Duration::from_secs(3) {
                    return Err("写入 SSH 通道超时".to_string());
                }
                thread::sleep(Duration::from_millis(2));
            }
            Ok(n) => written += n,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if start.elapsed() > Duration::from_secs(3) {
                    return Err("写入 SSH 通道超时".to_string());
                }
                thread::sleep(Duration::from_millis(1));
            }
            Err(e) => {
                return Err(format!("写入 SSH 通道失败: {}", e));
            }
        }
    }
    Ok(())
}

impl SshManager {
    pub fn new() -> Self {
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        let sftp_sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let exec_sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        spawn_keepalive_reaper(Arc::clone(&sftp_sessions));
        spawn_keepalive_reaper(Arc::clone(&exec_sessions));

        Self {
            sessions,
            sftp_sessions,
            exec_sessions,
            next_generation: Arc::new(AtomicU64::new(1)),
        }
    }

    fn alloc_generation(&self) -> u64 {
        self.next_generation.fetch_add(1, Ordering::SeqCst)
    }

    pub fn establish_connection(options: &SshConnectOptions) -> Result<Session, String> {
        let addr = format!("{}:{}", options.host, options.port);
        let sock_addr = addr
            .parse()
            .or_else(|_| {
                use std::net::ToSocketAddrs;
                addr.to_socket_addrs()
                    .map_err(|e| format!("解析主机地址失败: {}", e))?
                    .next()
                    .ok_or_else(|| "无法解析主机 IP 地址".to_string())
            })
            .map_err(|e| e.to_string())?;

        let tcp = TcpStream::connect_timeout(&sock_addr, Duration::from_secs(8))
            .map_err(|e| format!("无法连接至 {}: {}", addr, e))?;

        let _ = tcp.set_nodelay(true);

        let mut sess = Session::new().map_err(|e| format!("初始化 SSH 会话失败: {}", e))?;
        sess.set_tcp_stream(tcp);
        sess.set_timeout(8000);
        sess.handshake()
            .map_err(|e| format!("SSH 握手失败: {}", e))?;

        match options.auth_type.as_str() {
            "password" => {
                let pass = options.credential.clone().unwrap_or_default();
                if pass.is_empty() {
                    return Err(format!(
                        "未填写登录密码：请为主机 {} 补充密码或改用私钥认证",
                        options.host
                    ));
                }
                sess.userauth_password(&options.username, &pass)
                    .map_err(|e| format!("密码认证失败: {}", e))?;
            }
            "key" => {
                let key_data = options.credential.clone().unwrap_or_default();
                if key_data.trim().is_empty() {
                    return Err(format!(
                        "未配置私钥：请为主机 {} 填写私钥路径或私钥内容",
                        options.host
                    ));
                }
                let pass = options.passphrase.as_deref();
                let expanded_path = expand_tilde_path(&key_data);

                if expanded_path.exists() && expanded_path.is_file() {
                    sess.userauth_pubkey_file(&options.username, None, &expanded_path, pass)
                        .map_err(|e| format!("私钥文件认证失败: {}", e))?;
                } else if key_data.contains("PRIVATE KEY") {
                    match sess.userauth_pubkey_memory(&options.username, None, &key_data, pass) {
                        Ok(()) => {}
                        Err(mem_err) => {
                            let temp_key_path = std::env::temp_dir()
                                .join(format!("tini_key_{}.pem", uuid::Uuid::new_v4()));
                            std::fs::write(&temp_key_path, &key_data).map_err(|e| {
                                format!("内存私钥认证失败 ({}) 且写入临时私钥失败: {}", mem_err, e)
                            })?;
                            #[cfg(unix)]
                            {
                                use std::os::unix::fs::PermissionsExt;
                                if let Ok(meta) = std::fs::metadata(&temp_key_path) {
                                    let mut p = meta.permissions();
                                    p.set_mode(0o600);
                                    let _ = std::fs::set_permissions(&temp_key_path, p);
                                }
                            }
                            let auth_res =
                                sess.userauth_pubkey_file(&options.username, None, &temp_key_path, pass);
                            let _ = std::fs::remove_file(&temp_key_path);
                            auth_res.map_err(|e| format!("私钥内容认证失败: {}", e))?;
                        }
                    }
                } else {
                    return Err(format!(
                        "未找到私钥文件: {}（若填写的是私钥内容请包含完整 BEGIN/END PRIVATE KEY 头尾）",
                        expanded_path.display()
                    ));
                }
            }
            "agent" => {
                sess.userauth_agent(&options.username).map_err(|e| {
                    if cfg!(target_os = "windows") {
                        format!(
                            "SSH Agent 认证失败: {}（Windows 下请确认 Pageant 或兼容 Agent 服务已启动，或改用私钥文件认证）",
                            e
                        )
                    } else {
                        format!("SSH Agent 认证失败: {}（请确认 ssh-agent 已运行且已 ssh-add 密钥）", e)
                    }
                })?;
            }
            _ => {
                return Err("未知的认证类型".to_string());
            }
        }

        if !sess.authenticated() {
            return Err("SSH 认证未通过，请检查用户名或密码/私钥".to_string());
        }

        sess.set_timeout(0);
        sess.set_keepalive(true, 10);
        Ok(sess)
    }

    /// 建立交互式 SSH PTY 会话（Single-Actor 架构：单线程独占 Session 与 Channel，零锁竞态）
    pub fn connect(
        &self,
        session_id: String,
        options: SshConnectOptions,
        output_channel: Channel<TerminalOutputPayload>,
        session_manager: SessionManager,
    ) -> Result<SshConnectResult, String> {
        let connect_start = Instant::now();
        let sess = Self::establish_connection(&options)?;
        let latency_ms = connect_start.elapsed().as_millis() as u64;

        let mut channel = sess
            .channel_session()
            .map_err(|e| format!("打开 SSH 通道失败: {}", e))?;

        channel
            .request_pty(
                "xterm-256color",
                None,
                Some((options.cols as u32, options.rows as u32, 0, 0)),
            )
            .map_err(|e| format!("申请 PTY 失败: {}", e))?;

        channel
            .shell()
            .map_err(|e| format!("启动远程 Shell 失败: {}", e))?;

        sess.set_blocking(false);

        let generation = self.alloc_generation();
        let (cmd_tx, cmd_rx) = mpsc::channel::<SshActorCmd>();

        // 幂等替换：若同 session_id 已有旧 Actor，先发 Close 回收，杜绝双连接冲突
        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "SSH 会话锁状态异常".to_string())?;
            if let Some(old_handle) = sessions.insert(
                session_id.clone(),
                SshSessionHandle {
                    generation,
                    cmd_tx,
                    options: options.clone(),
                },
            ) {
                let _ = old_handle.cmd_tx.send(SshActorCmd::Close);
            }
        }

        session_manager.register_session(
            session_id.clone(),
            options.host.clone(),
            crate::session::SessionKind::Interactive,
        );
        session_manager.update_context(&session_id, |ctx| {
            ctx.user = Some(options.username.clone());
            ctx.hostname = Some(options.host.clone());
            ctx.terminal_width = options.cols;
            ctx.terminal_height = options.rows;
        });

        let sid = session_id.clone();
        let sm_reader = session_manager.clone();
        let sessions_ref = Arc::clone(&self.sessions);

        // Single-Actor 专属 I/O 线程：完整拥有 sess 与 channel，顺序处理写入/尺寸/读取/心跳
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut utf8_pending: Vec<u8> = Vec::new();
            let mut last_keepalive = Instant::now();
            let mut idle_streak: u32 = 0;
            let mut closed_by_user = false;

            'actor: loop {
                let mut did_work = false;

                // 1. 优先排空所有待发送的用户按键与尺寸调整命令，保证极低输入延迟
                loop {
                    match cmd_rx.try_recv() {
                        Ok(SshActorCmd::Write(bytes)) => {
                            did_work = true;
                            if write_all_nonblocking(&mut channel, &bytes).is_err() {
                                break 'actor;
                            }
                        }
                        Ok(SshActorCmd::Resize { cols, rows }) => {
                            did_work = true;
                            let _ = channel.request_pty_size(cols as u32, rows as u32, None, None);
                        }
                        Ok(SshActorCmd::Close) => {
                            closed_by_user = true;
                            break 'actor;
                        }
                        Err(TryRecvError::Empty) => break,
                        Err(TryRecvError::Disconnected) => {
                            closed_by_user = true;
                            break 'actor;
                        }
                    }
                }

                // 2. 同线程安全心跳保活，不与其他线程争抢 libssh2 Session
                if last_keepalive.elapsed() > Duration::from_secs(10) {
                    if sess.keepalive_send().is_err() {
                        break 'actor;
                    }
                    last_keepalive = Instant::now();
                }

                // 3. 非阻塞读取远端 PTY 输出
                match channel.read(&mut buf) {
                    Ok(0) => {
                        if channel.eof() {
                            break 'actor;
                        }
                    }
                    Ok(n) => {
                        did_work = true;
                        utf8_pending.extend_from_slice(&buf[..n]);
                        if let Some(text) = drain_valid_utf8(&mut utf8_pending) {
                            CwdTracker::observe_output(&sm_reader, &sid, &text);
                            let payload = TerminalOutputPayload {
                                session_id: sid.clone(),
                                data: text,
                                closed: false,
                                latency_ms: None,
                                generation,
                            };
                            if output_channel.send(payload).is_err() {
                                break 'actor;
                            }
                        }
                    }
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            || e.kind() == std::io::ErrorKind::TimedOut
                            || e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(e) => {
                        if channel.eof() {
                            break 'actor;
                        }
                        let kind = e.kind();
                        if kind == std::io::ErrorKind::BrokenPipe
                            || kind == std::io::ErrorKind::ConnectionReset
                            || kind == std::io::ErrorKind::ConnectionAborted
                        {
                            break 'actor;
                        }
                    }
                }

                if did_work {
                    idle_streak = 0;
                } else {
                    idle_streak = idle_streak.saturating_add(1);
                    let sleep_ms = if idle_streak > 25 { 10 } else { 2 };
                    thread::sleep(Duration::from_millis(sleep_ms));
                }
            }

            let _ = channel.close();
            let _ = sess.disconnect(None, "actor exit", None);

            if !utf8_pending.is_empty() && !closed_by_user {
                let tail = String::from_utf8_lossy(&utf8_pending).to_string();
                let _ = output_channel.send(TerminalOutputPayload {
                    session_id: sid.clone(),
                    data: tail,
                    closed: false,
                    latency_ms: None,
                    generation,
                });
            }

            // 仅当本 Actor 仍为该 session_id 的最新代际时，清理句柄并上报断连
            let is_still_current = if let Ok(mut map) = sessions_ref.lock() {
                if map.get(&sid).map(|h| h.generation) == Some(generation) {
                    map.remove(&sid);
                    true
                } else {
                    false
                }
            } else {
                false
            };

            if is_still_current && !closed_by_user {
                let _ = output_channel.send(TerminalOutputPayload {
                    session_id: sid.clone(),
                    data: "\r\n\x1b[33m[SSH 会话已断开]\x1b[0m\r\n".to_string(),
                    closed: true,
                    latency_ms: None,
                    generation,
                });
                sm_reader.mark_disconnected(&sid);
            }
        });

        Ok(SshConnectResult {
            latency_ms,
            generation,
        })
    }

    pub fn write_data(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let tx = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "SSH 会话锁状态异常".to_string())?;
            sessions
                .get(session_id)
                .map(|h| h.cmd_tx.clone())
                .ok_or_else(|| "未找到对应的 SSH 会话".to_string())?
        };

        tx.send(SshActorCmd::Write(data.to_vec()))
            .map_err(|_| "SSH 会话已断开，无法发送输入".to_string())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if cols < 20 || rows < 5 {
            return Ok(());
        }
        let tx = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "SSH 会话锁状态异常".to_string())?;
            sessions
                .get(session_id)
                .map(|h| h.cmd_tx.clone())
                .ok_or_else(|| "未找到对应的 SSH 会话".to_string())?
        };

        let _ = tx.send(SshActorCmd::Resize { cols, rows });
        Ok(())
    }

    pub fn measure_latency(&self, session_id: &str) -> Result<u64, String> {
        let options = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "SSH 会话锁状态异常".to_string())?;
            sessions
                .get(session_id)
                .map(|h| h.options.clone())
                .ok_or_else(|| "未找到对应的 SSH 会话".to_string())?
        };
        let addr = format!("{}:{}", options.host, options.port);
        let sock_addr = addr
            .parse()
            .or_else(|_| {
                use std::net::ToSocketAddrs;
                addr.to_socket_addrs()
                    .map_err(|e| e.to_string())?
                    .next()
                    .ok_or_else(|| "解析失败".to_string())
            })
            .map_err(|e| e.to_string())?;
        let start = Instant::now();
        TcpStream::connect_timeout(&sock_addr, Duration::from_secs(3))
            .map_err(|e| format!("延迟探测失败: {}", e))?;
        Ok(start.elapsed().as_millis() as u64)
    }

    pub fn exec_command(
        &self,
        session_id: &str,
        command: &str,
        channel: Option<Channel<ExecStreamPayload>>,
    ) -> Result<SshExecResult, String> {
        let session_arc = self.get_or_create_exec_session(session_id)?;

        let sess = session_arc
            .lock()
            .map_err(|_| "SSH 执行连接锁异常".to_string())?;
        sess.set_blocking(false);

        let open_start = Instant::now();
        let mut ch = loop {
            match sess.channel_session() {
                Ok(c) => break c,
                Err(e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                    if open_start.elapsed() > Duration::from_secs(10) {
                        return Err("创建执行通道超时".to_string());
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                Err(e) => {
                    drop(sess);
                    self.invalidate_exec_session(session_id);
                    return Err(format!("创建执行通道失败: {}", e));
                }
            }
        };

        let start_time = Instant::now();
        loop {
            match ch.exec(command) {
                Ok(()) => break,
                Err(e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                    if start_time.elapsed() > Duration::from_secs(10) {
                        return Err("发送远程命令超时".to_string());
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                Err(e) => return Err(format!("发送远程命令失败: {}", e)),
            }
        }

        let timeout = Duration::from_secs(120);
        let mut stdout_buf = Vec::new();
        let mut stderr_buf = Vec::new();
        let mut stdout_pending = Vec::new();
        let mut stderr_pending = Vec::new();
        let mut buf = [0u8; 4096];

        loop {
            let mut read_anything = false;

            match ch.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    stdout_buf.extend_from_slice(&buf[..n]);
                    stdout_pending.extend_from_slice(&buf[..n]);
                    if let Some(chunk) = drain_valid_utf8(&mut stdout_pending) {
                        if let Some(ref ch_ipc) = channel {
                            let _ = ch_ipc.send(ExecStreamPayload {
                                stream: "stdout".to_string(),
                                data: chunk,
                            });
                        }
                    }
                    read_anything = true;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => return Err(format!("读取标准输出失败: {}", e)),
            }

            match ch.stderr().read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    stderr_buf.extend_from_slice(&buf[..n]);
                    stderr_pending.extend_from_slice(&buf[..n]);
                    if let Some(chunk) = drain_valid_utf8(&mut stderr_pending) {
                        if let Some(ref ch_ipc) = channel {
                            let _ = ch_ipc.send(ExecStreamPayload {
                                stream: "stderr".to_string(),
                                data: chunk,
                            });
                        }
                    }
                    read_anything = true;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => {}
            }

            if ch.eof() {
                loop {
                    let mut drained = false;
                    if let Ok(n) = ch.read(&mut buf) {
                        if n > 0 {
                            stdout_buf.extend_from_slice(&buf[..n]);
                            stdout_pending.extend_from_slice(&buf[..n]);
                            if let Some(chunk) = drain_valid_utf8(&mut stdout_pending) {
                                if let Some(ref ch_ipc) = channel {
                                    let _ = ch_ipc.send(ExecStreamPayload {
                                        stream: "stdout".to_string(),
                                        data: chunk,
                                    });
                                }
                            }
                            drained = true;
                        }
                    }
                    if let Ok(n) = ch.stderr().read(&mut buf) {
                        if n > 0 {
                            stderr_buf.extend_from_slice(&buf[..n]);
                            stderr_pending.extend_from_slice(&buf[..n]);
                            if let Some(chunk) = drain_valid_utf8(&mut stderr_pending) {
                                if let Some(ref ch_ipc) = channel {
                                    let _ = ch_ipc.send(ExecStreamPayload {
                                        stream: "stderr".to_string(),
                                        data: chunk,
                                    });
                                }
                            }
                            drained = true;
                        }
                    }
                    if !drained {
                        break;
                    }
                }
                break;
            }

            if !read_anything {
                if start_time.elapsed() > timeout {
                    return Err(format!("命令执行超时 ({}s)", timeout.as_secs()));
                }
                thread::sleep(Duration::from_millis(10));
            }
        }

        if let Some(ref ch_ipc) = channel {
            if !stdout_pending.is_empty() {
                let _ = ch_ipc.send(ExecStreamPayload {
                    stream: "stdout".to_string(),
                    data: String::from_utf8_lossy(&stdout_pending).to_string(),
                });
            }
            if !stderr_pending.is_empty() {
                let _ = ch_ipc.send(ExecStreamPayload {
                    stream: "stderr".to_string(),
                    data: String::from_utf8_lossy(&stderr_pending).to_string(),
                });
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
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }

        let (exit_code, stderr_text) = match ch.exit_status() {
            Ok(code) => (code, String::from_utf8_lossy(&stderr_buf).to_string()),
            Err(e) => {
                let mut text = String::from_utf8_lossy(&stderr_buf).to_string();
                if !text.is_empty() && !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push_str(&format!("[无法获取远程命令退出码: {}]", e));
                (-1, text)
            }
        };

        Ok(SshExecResult {
            exit_code,
            stdout: String::from_utf8_lossy(&stdout_buf).to_string(),
            stderr: stderr_text,
            duration_ms: start_time.elapsed().as_millis() as u64,
        })
    }

    pub fn close(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(h) = sessions.remove(session_id) {
                let _ = h.cmd_tx.send(SshActorCmd::Close);
            }
        }
        self.invalidate_sftp_session(session_id);
        self.invalidate_exec_session(session_id);
    }

    pub fn invalidate_sftp_session(&self, session_id: &str) {
        if let Ok(mut map) = self.sftp_sessions.lock() {
            if let Some(sess_arc) = map.remove(session_id) {
                if let Ok(s) = sess_arc.lock() {
                    let _ = s.disconnect(None, "invalidate sftp session", None);
                }
            }
        }
    }

    pub fn invalidate_exec_session(&self, session_id: &str) {
        if let Ok(mut map) = self.exec_sessions.lock() {
            if let Some(sess_arc) = map.remove(session_id) {
                if let Ok(s) = sess_arc.lock() {
                    let _ = s.disconnect(None, "invalidate exec session", None);
                }
            }
        }
    }

    fn get_or_create_aux_session(
        &self,
        pool: &Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
        session_id: &str,
        purpose: &str,
    ) -> Result<Arc<Mutex<Session>>, String> {
        {
            let mut is_dead = false;
            let mut map = pool
                .lock()
                .map_err(|_| format!("{} 连接池锁异常", purpose))?;
            if let Some(sess_arc) = map.get(session_id) {
                if let Ok(s) = sess_arc.try_lock() {
                    if s.authenticated() && s.keepalive_send().is_ok() {
                        return Ok(Arc::clone(sess_arc));
                    } else {
                        is_dead = true;
                    }
                } else {
                    return Ok(Arc::clone(sess_arc));
                }
            }
            if is_dead {
                map.remove(session_id);
            }
        }

        let options = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "SSH 会话锁异常".to_string())?;
            let handle = sessions
                .get(session_id)
                .ok_or_else(|| "未找到对应的 SSH 会话".to_string())?;
            handle.options.clone()
        };

        let new_sess = Self::establish_connection(&options)
            .map_err(|e| format!("建立独立 {} 通道失败: {}", purpose, e))?;
        let sess_arc = Arc::new(Mutex::new(new_sess));
        if let Ok(mut map) = pool.lock() {
            map.insert(session_id.to_string(), Arc::clone(&sess_arc));
        }
        Ok(sess_arc)
    }

    pub fn get_or_create_sftp_session(
        &self,
        session_id: &str,
    ) -> Result<Arc<Mutex<Session>>, String> {
        self.get_or_create_aux_session(&self.sftp_sessions, session_id, "SFTP")
    }

    pub fn get_or_create_exec_session(
        &self,
        session_id: &str,
    ) -> Result<Arc<Mutex<Session>>, String> {
        self.get_or_create_aux_session(&self.exec_sessions, session_id, "Exec")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_drain_valid_utf8_across_chunks() {
        let full = "你好世界-测试".as_bytes();
        let mut pending = Vec::new();
        pending.extend_from_slice(&full[..4]);
        let part1 = drain_valid_utf8(&mut pending).unwrap();
        assert_eq!(part1, "你");
        assert_eq!(pending.len(), 1);

        pending.extend_from_slice(&full[4..]);
        let part2 = drain_valid_utf8(&mut pending).unwrap();
        assert_eq!(part2, "好世界-测试");
        assert!(pending.is_empty());
    }

    #[test]
    fn test_expand_tilde_path() {
        let p = expand_tilde_path("~/test_key");
        if let Some(home) = dirs::home_dir() {
            assert_eq!(p, home.join("test_key"));
        }
        let abs = expand_tilde_path("/etc/ssh/key");
        assert_eq!(abs, std::path::Path::new("/etc/ssh/key"));
    }

    #[test]
    fn test_generation_monotonic() {
        let mgr = SshManager::new();
        let g1 = mgr.alloc_generation();
        let g2 = mgr.alloc_generation();
        assert!(g2 > g1);
    }
}
