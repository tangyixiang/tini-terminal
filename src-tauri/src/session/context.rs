use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SessionContext {
    pub cwd: Option<String>,
    pub shell: Option<String>,
    pub user: Option<String>,
    pub os: Option<String>,
    pub hostname: Option<String>,
    pub foreground_process: Option<String>,
    pub last_command: Option<String>,
    pub last_exit_code: Option<i32>,
    pub terminal_width: u16,
    pub terminal_height: u16,
    /// 最近终端输出滚动缓冲（已去除 ANSI 码，供 AI 智能体感知当前终端现场）
    pub recent_output: String,
}
