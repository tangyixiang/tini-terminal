use serde::{Deserialize, Serialize};
use ssh2::{Channel as SshChannel, Session};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::ipc::Channel;

use crate::pty::TerminalOutputPayload;

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

pub struct SshSessionHandle {
    pub channel: Arc<Mutex<SshChannel>>,
    pub session: Arc<Mutex<Session>>,
    pub options: SshConnectOptions,
}

#[derive(Clone)]
pub struct SshManager {
    sessions: Arc<Mutex<HashMap<String, SshSessionHandle>>>,
    sftp_sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            sftp_sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn establish_connection(options: &SshConnectOptions) -> Result<Session, String> {
        let addr = format!("{}:{}", options.host, options.port);
        let tcp = TcpStream::connect_timeout(
            &addr
                .parse()
                .or_else(|_| {
                    use std::net::ToSocketAddrs;
                    addr.to_socket_addrs()
                        .map_err(|e| format!("解析主机地址失败: {}", e))?
                        .next()
                        .ok_or_else(|| "无法解析主机 IP 地址".to_string())
                })
                .map_err(|e| e.to_string())?,
            Duration::from_secs(6),
        )
        .map_err(|e| format!("无法连接至 {}: {}", addr, e))?;

        let _ = tcp.set_nodelay(true);

        let mut sess = Session::new().map_err(|e| format!("初始化 SSH 会话失败: {}", e))?;
        sess.set_tcp_stream(tcp);
        sess.set_timeout(6000); // 握手与认证超时设为 6 秒
        sess.handshake()
            .map_err(|e| format!("SSH 握手失败: {}", e))?;

        // 认证逻辑
        match options.auth_type.as_str() {
            "password" => {
                let pass = options.credential.clone().unwrap_or_default();
                sess.userauth_password(&options.username, &pass)
                    .map_err(|e| format!("密码认证失败: {}", e))?;
            }
            "key" => {
                let key_data = options.credential.clone().unwrap_or_default();
                let pass = options.passphrase.as_deref();
                let key_path = Path::new(&key_data);

                if key_path.exists() {
                    // 本地私钥文件
                    sess.userauth_pubkey_file(&options.username, None, key_path, pass)
                        .map_err(|e| format!("私钥文件认证失败: {}", e))?;
                } else {
                    // 密钥文本
                    #[cfg(unix)]
                    {
                        sess.userauth_pubkey_memory(&options.username, None, &key_data, pass)
                            .map_err(|e| format!("私钥内容认证失败: {}", e))?;
                    }
                    #[cfg(not(unix))]
                    {
                        let temp_key_path = std::env::temp_dir().join(format!("ssh_key_{}", uuid::Uuid::new_v4()));
                        std::fs::write(&temp_key_path, &key_data)
                            .map_err(|e| format!("写入临时私钥文件失败: {}", e))?;
                        let auth_res = sess.userauth_pubkey_file(&options.username, None, &temp_key_path, pass);
                        let _ = std::fs::remove_file(&temp_key_path);
                        auth_res.map_err(|e| format!("私钥内容认证失败: {}", e))?;
                    }
                }
            }
            "agent" => {
                sess.userauth_agent(&options.username)
                    .map_err(|e| format!("SSH Agent 认证失败: {}", e))?;
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

    pub fn connect(
        &self,
        session_id: String,
        options: SshConnectOptions,
        output_channel: Channel<TerminalOutputPayload>,
    ) -> Result<(), String> {
        let sess = Self::establish_connection(&options)?;

        // 打开交互式 PTY 通道
        let mut channel = sess
            .channel_session()
            .map_err(|e| format!("打开 SSH 通道失败: {}", e))?;

        channel
            .request_pty(
                "xterm-256color",
                None,
                Some((
                    options.cols as u32,
                    options.rows as u32,
                    0,
                    0,
                )),
            )
            .map_err(|e| format!("申请 PTY 失败: {}", e))?;

        channel
            .shell()
            .map_err(|e| format!("启动远程 Shell 失败: {}", e))?;

        // 切换至非阻塞模式，避免后台读线程独占互斥锁卡死主线程写入
        sess.set_blocking(false);

        let channel_arc = Arc::new(Mutex::new(channel));
        let sess_arc = Arc::new(Mutex::new(sess));

        // 启动后台流式读取线程（使用短暂锁与 try_lock，零死锁、零阻塞）
        let sid = session_id.clone();
        let ch_reader = Arc::clone(&channel_arc);
        let sess_reader = Arc::clone(&sess_arc);

        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut last_keepalive = std::time::Instant::now();
            loop {
                // 定期发送 SSH 心跳探测包
                if last_keepalive.elapsed() > Duration::from_secs(5) {
                    if let Ok(s) = sess_reader.try_lock() {
                        let _ = s.keepalive_send();
                    }
                    last_keepalive = std::time::Instant::now();
                }

                let read_res = {
                    if let Ok(mut ch) = ch_reader.try_lock() {
                        ch.read(&mut buf)
                    } else {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                };

                match read_res {
                    Ok(0) => {
                        // 确认是否真正收到 EOF，避免非阻塞返回 0 误杀死读取线程
                        if let Ok(ch) = ch_reader.try_lock() {
                            if ch.eof() {
                                break;
                            }
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]).to_string();
                        let payload = TerminalOutputPayload {
                            session_id: sid.clone(),
                            data: text,
                        };
                        if let Err(_) = output_channel.send(payload) {
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut
                        || e.kind() == std::io::ErrorKind::Interrupted => {
                        thread::sleep(Duration::from_millis(4));
                    }
                    Err(e) => {
                        if let Ok(ch) = ch_reader.try_lock() {
                            if ch.eof() {
                                break;
                            }
                        }
                        let kind = e.kind();
                        if kind == std::io::ErrorKind::BrokenPipe
                            || kind == std::io::ErrorKind::ConnectionReset
                            || kind == std::io::ErrorKind::ConnectionAborted {
                            break;
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                }
            }
        });

        let mut sessions = self.sessions.lock().unwrap();
        sessions.insert(
            session_id,
            SshSessionHandle {
                channel: channel_arc,
                session: sess_arc,
                options,
            },
        );

        Ok(())
    }

    pub fn write_data(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let channel_arc = {
            let sessions = self.sessions.lock().unwrap();
            if let Some(h) = sessions.get(session_id) {
                Arc::clone(&h.channel)
            } else {
                return Err("未找到对应的 SSH 会话".to_string());
            }
        };

        let mut ch = channel_arc.lock().unwrap();
        let mut written = 0;
        let start = std::time::Instant::now();
        while written < data.len() {
            match ch.write(&data[written..]) {
                Ok(0) => {
                    if start.elapsed() > Duration::from_secs(3) {
                        return Err("写入 SSH 通道超时".to_string());
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                Ok(n) => written += n,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if start.elapsed() > Duration::from_secs(3) {
                        return Err("写入 SSH 通道超时".to_string());
                    }
                    thread::sleep(Duration::from_millis(2));
                }
                Err(e) => {
                    if start.elapsed() < Duration::from_secs(1) {
                        thread::sleep(Duration::from_millis(5));
                        if let Ok(n) = ch.write(&data[written..]) {
                            written += n;
                            continue;
                        }
                    }
                    return Err(format!("写入 SSH 通道失败: {}", e));
                }
            }
        }
        // 严禁调用 ch.flush()！在 libssh2 中 channel_flush 会清空并丢弃接收缓冲区的数据，导致终端回显字符丢失！
        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if cols < 20 || rows < 5 {
            return Ok(());
        }
        let channel_arc = {
            let sessions = self.sessions.lock().unwrap();
            if let Some(h) = sessions.get(session_id) {
                Arc::clone(&h.channel)
            } else {
                return Err("未找到对应的 SSH 会话".to_string());
            }
        };

        if let Ok(mut ch) = channel_arc.lock() {
            let _ = ch.request_pty_size(cols as u32, rows as u32, None, None);
        }
        Ok(())
    }

    pub fn exec_command(
        &self,
        session_id: &str,
        command: &str,
    ) -> Result<SshExecResult, String> {
        let session_arc = {
            let sessions = self.sessions.lock().unwrap();
            let session_handle = sessions
                .get(session_id)
                .ok_or_else(|| "未找到指定主机连接会话".to_string())?;
            Arc::clone(&session_handle.session)
        };

        let sess = session_arc.lock().unwrap();
        // 保持 non-blocking 模式，严禁调用 sess.set_blocking(true)，避免破坏后台终端读取线程
        let mut ch = loop {
            match sess.channel_session() {
                Ok(c) => break c,
                Err(e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(e) => return Err(format!("创建执行通道失败: {}", e)),
            }
        };

        let start_time = std::time::Instant::now();
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

        let mut stdout_buf = Vec::new();
        let mut stderr_buf = Vec::new();
        let mut buf = [0u8; 4096];

        loop {
            let mut read_anything = false;
            match ch.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    stdout_buf.extend_from_slice(&buf[..n]);
                    read_anything = true;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => return Err(format!("读取标准输出失败: {}", e)),
            }

            match ch.stderr().read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    stderr_buf.extend_from_slice(&buf[..n]);
                    read_anything = true;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => {}
            }

            if !read_anything {
                if ch.eof() {
                    break;
                }
                if start_time.elapsed() > Duration::from_secs(30) {
                    return Err("命令执行超时 (30s)".to_string());
                }
                thread::sleep(Duration::from_millis(10));
            }
        }

        let _ = ch.wait_close();
        let exit_code = ch.exit_status().unwrap_or(0);

        Ok(SshExecResult {
            exit_code,
            stdout: String::from_utf8_lossy(&stdout_buf).to_string(),
            stderr: String::from_utf8_lossy(&stderr_buf).to_string(),
            duration_ms: start_time.elapsed().as_millis() as u64,
        })
    }

    pub fn close(&self, session_id: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(h) = sessions.remove(session_id) {
            if let Ok(mut ch) = h.channel.lock() {
                let _ = ch.close();
            }
            if let Ok(s) = h.session.lock() {
                let _ = s.disconnect(None, "user disconnect", None);
            }
        }
        let mut sftp_map = self.sftp_sessions.lock().unwrap();
        if let Some(sftp_sess) = sftp_map.remove(session_id) {
            if let Ok(s) = sftp_sess.lock() {
                let _ = s.disconnect(None, "user disconnect sftp", None);
            }
        }
    }

    pub fn get_session(&self, session_id: &str) -> Option<Arc<Mutex<Session>>> {
        let sessions = self.sessions.lock().unwrap();
        sessions.get(session_id).map(|h| Arc::clone(&h.session))
    }

    pub fn get_or_create_sftp_session(&self, session_id: &str) -> Result<Arc<Mutex<Session>>, String> {
        // 1. 优先复用已经建立且认证完好的独立 SFTP 专用连接
        {
            let sftp_map = self.sftp_sessions.lock().unwrap();
            if let Some(sess_arc) = sftp_map.get(session_id) {
                if let Ok(s) = sess_arc.lock() {
                    if s.authenticated() {
                        return Ok(Arc::clone(sess_arc));
                    }
                }
            }
        }

        // 2. 获取当前终端主机的连接配置参数
        let options = {
            let sessions = self.sessions.lock().unwrap();
            let handle = sessions.get(session_id).ok_or_else(|| "未找到对应的 SSH 会话".to_string())?;
            handle.options.clone()
        };

        // 3. 建立独立的 SSH 连接专用于 SFTP 操作，彻底与交互式终端的 PTY 通道解耦，杜绝报文与锁冲突
        match Self::establish_connection(&options) {
            Ok(new_sess) => {
                let sess_arc = Arc::new(Mutex::new(new_sess));
                let mut sftp_map = self.sftp_sessions.lock().unwrap();
                sftp_map.insert(session_id.to_string(), Arc::clone(&sess_arc));
                Ok(sess_arc)
            }
            Err(e) => {
                eprintln!("创建独立 SFTP 连接失败，尝试降级复用主连接: {}", e);
                let sessions = self.sessions.lock().unwrap();
                let handle = sessions.get(session_id).ok_or_else(|| "未找到对应的 SSH 会话".to_string())?;
                Ok(Arc::clone(&handle.session))
            }
        }
    }
}
