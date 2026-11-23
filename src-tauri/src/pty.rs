use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::ipc::Channel;

use crate::session::{CwdTracker, SessionKind, SessionManager};
use crate::ssh::drain_valid_utf8;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TerminalOutputPayload {
    pub session_id: String,
    pub data: String,
    #[serde(default)]
    pub closed: bool,
    #[serde(default)]
    pub latency_ms: Option<u64>,
    #[serde(default)]
    pub generation: u64,
}

struct LocalSession {
    generation: u64,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    _child: Box<dyn Child + Send + Sync>,
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, LocalSession>>>,
    next_generation: Arc<AtomicU64>,
}

fn resolve_local_shell() -> (String, Vec<String>) {
    if cfg!(target_os = "windows") {
        let has_pwsh = std::process::Command::new("where")
            .arg("pwsh.exe")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if has_pwsh {
            ("pwsh.exe".to_string(), vec!["-NoLogo".to_string()])
        } else {
            ("powershell.exe".to_string(), vec!["-NoLogo".to_string()])
        }
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".to_string()
            } else {
                "/bin/bash".to_string()
            }
        });
        (shell, vec!["-l".to_string()])
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_generation: Arc::new(AtomicU64::new(1)),
        }
    }

    pub fn start_session(
        &self,
        session_id: String,
        cols: u16,
        rows: u16,
        channel: Channel<TerminalOutputPayload>,
        session_manager: SessionManager,
    ) -> Result<u64, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("无法创建虚拟终端: {}", e))?;

        let (shell, args) = resolve_local_shell();
        let mut cmd = CommandBuilder::new(&shell);
        for arg in &args {
            cmd.arg(arg);
        }
        if let Some(home) = dirs::home_dir() {
            cmd.cwd(home);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        if !cfg!(target_os = "windows") && std::env::var("LANG").is_err() {
            cmd.env("LANG", "en_US.UTF-8");
        }

        let _child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("启动 Shell 进程失败: {}", e))?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("创建 PTY 读取器失败: {}", e))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("获取 PTY 写入器失败: {}", e))?;

        let generation = self.next_generation.fetch_add(1, Ordering::SeqCst);

        // 幂等替换旧本地 PTY 实例
        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "本地终端会话锁异常".to_string())?;
            sessions.insert(
                session_id.clone(),
                LocalSession {
                    generation,
                    writer,
                    master: pair.master,
                    _child,
                },
            );
        }

        session_manager.register_session(
            session_id.clone(),
            "local".to_string(),
            SessionKind::Interactive,
        );
        session_manager.update_context(&session_id, |ctx| {
            ctx.shell = Some(shell);
            ctx.os = Some(std::env::consts::OS.to_string());
            ctx.user = std::env::var("USER")
                .or_else(|_| std::env::var("USERNAME"))
                .ok();
            ctx.cwd = dirs::home_dir().map(|p| p.to_string_lossy().to_string());
            ctx.terminal_width = cols;
            ctx.terminal_height = rows;
        });

        let sid = session_id.clone();
        let sm_reader = session_manager.clone();
        let sessions_ref = Arc::clone(&self.sessions);

        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut utf8_pending: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
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
                            if channel.send(payload).is_err() {
                                break;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            if !utf8_pending.is_empty() {
                let _ = channel.send(TerminalOutputPayload {
                    session_id: sid.clone(),
                    data: String::from_utf8_lossy(&utf8_pending).to_string(),
                    closed: false,
                    latency_ms: None,
                    generation,
                });
            }

            let is_still_current = if let Ok(mut map) = sessions_ref.lock() {
                if map.get(&sid).map(|s| s.generation) == Some(generation) {
                    map.remove(&sid);
                    true
                } else {
                    false
                }
            } else {
                false
            };

            if is_still_current {
                let _ = channel.send(TerminalOutputPayload {
                    session_id: sid.clone(),
                    data: "\r\n\x1b[33m[本地 Shell 已退出]\x1b[0m\r\n".to_string(),
                    closed: true,
                    latency_ms: None,
                    generation,
                });
                sm_reader.mark_disconnected(&sid);
            }
        });

        Ok(generation)
    }

    pub fn write_data(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "本地终端会话锁异常".to_string())?;
        if let Some(session) = sessions.get_mut(session_id) {
            session
                .writer
                .write_all(data)
                .map_err(|e| format!("写入 PTY 失败: {}", e))?;
            session
                .writer
                .flush()
                .map_err(|e| format!("刷新 PTY 失败: {}", e))?;
            Ok(())
        } else {
            Err("未找到对应终端会话".to_string())
        }
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if cols < 20 || rows < 5 {
            return Ok(());
        }
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "本地终端会话锁异常".to_string())?;
        if let Some(session) = sessions.get(session_id) {
            session
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| format!("调整 PTY 尺寸失败: {}", e))?;
            Ok(())
        } else {
            Err("未找到对应终端会话".to_string())
        }
    }

    pub fn close(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id);
        }
    }
}
