use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::ipc::Channel;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TerminalOutputPayload {
    pub session_id: String,
    pub data: String,
}

struct LocalSession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, LocalSession>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn start_session(
        &self,
        session_id: String,
        cols: u16,
        rows: u16,
        channel: Channel<TerminalOutputPayload>,
    ) -> Result<(), String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("无法创建虚拟终端: {}", e))?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".to_string()
            } else {
                "/bin/bash".to_string()
            }
        });

        let mut cmd = CommandBuilder::new(shell);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

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

        let sid = session_id.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]).to_string();
                        let payload = TerminalOutputPayload {
                            session_id: sid.clone(),
                            data: text,
                        };
                        if let Err(_) = channel.send(payload) {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let mut sessions = self.sessions.lock().unwrap();
        sessions.insert(
            session_id,
            LocalSession {
                writer,
                master: pair.master,
            },
        );

        Ok(())
    }

    pub fn write_data(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
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
        let sessions = self.sessions.lock().unwrap();
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
        let mut sessions = self.sessions.lock().unwrap();
        sessions.remove(session_id);
    }
}
