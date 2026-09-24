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
}
