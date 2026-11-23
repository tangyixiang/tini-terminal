use regex::Regex;
use std::sync::OnceLock;

use super::manager::SessionManager;

static OSC7_RE: OnceLock<Regex> = OnceLock::new();
static ITERM_RE: OnceLock<Regex> = OnceLock::new();
static ANSI_RE: OnceLock<Regex> = OnceLock::new();
/// 匹配标准 Linux/Unix 提示符：user@host:cwd$ / [user@host cwd]#
static UNIX_PROMPT_RE: OnceLock<Regex> = OnceLock::new();
static BRACKET_PROMPT_RE: OnceLock<Regex> = OnceLock::new();
/// 匹配 Windows PowerShell 提示符：PS C:\Users\...>
static PS_PROMPT_RE: OnceLock<Regex> = OnceLock::new();
/// 匹配 OSC 133;D;<exit_code> 命令结束退出码
static OSC133_EXIT_RE: OnceLock<Regex> = OnceLock::new();

pub struct CwdTracker;

impl CwdTracker {
    pub fn strip_ansi(data: &str) -> String {
        let re = ANSI_RE.get_or_init(|| {
            Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]").unwrap()
        });
        re.replace_all(data, "").replace('\r', "")
    }

    pub fn parse_cwd(data: &str) -> Option<String> {
        let osc7 = OSC7_RE.get_or_init(|| {
            Regex::new(r"\x1b\]7;file://[^/]*([^\x07\x1b]+)(?:\x07|\x1b\\)").unwrap()
        });
        if let Some(caps) = osc7.captures(data) {
            if let Some(m) = caps.get(1) {
                let path = percent_decode(m.as_str().trim());
                if !path.is_empty() {
                    return Some(path);
                }
            }
        }

        let iterm = ITERM_RE.get_or_init(|| {
            Regex::new(r"\x1b\]1337;CurrentDir=([^\x07\x1b]+)(?:\x07|\x1b\\)").unwrap()
        });
        if let Some(caps) = iterm.captures(data) {
            if let Some(m) = caps.get(1) {
                let path = m.as_str().trim();
                if !path.is_empty() {
                    return Some(path.to_string());
                }
            }
        }

        None
    }

    /// 实时观测交互式终端输出流，自动提取目录、切换后的用户（su / sudo -i）、主机名、退出码与最近输出
    pub fn observe_output(session_manager: &SessionManager, session_id: &str, raw_data: &str) {
        if let Some(cwd) = Self::parse_cwd(raw_data) {
            session_manager.update_cwd(session_id, cwd);
        }

        // 解析 OSC 133 退出码
        let osc133 = OSC133_EXIT_RE.get_or_init(|| {
            Regex::new(r"\x1b\]133;D;(-?\d+)(?:\x07|\x1b\\)").unwrap()
        });
        if let Some(caps) = osc133.captures(raw_data) {
            if let Ok(code) = caps[1].parse::<i32>() {
                session_manager.update_context(session_id, |ctx| {
                    ctx.last_exit_code = Some(code);
                });
            }
        }

        let clean = Self::strip_ansi(raw_data);
        session_manager.append_recent_output(session_id, &clean);

        // 从最新几行非空文本中解析提示符变化，准确捕捉 su / sudo -i / ssh 跳板机 / cd 状态
        let unix_re = UNIX_PROMPT_RE.get_or_init(|| {
            Regex::new(r"(?:^|\n)(?:\([^)]+\)\s*)?([a-zA-Z0-9._-]+)@([a-zA-Z0-9._-]+):([~/][^\s$#]*)\s*([$#])\s*$").unwrap()
        });
        let bracket_re = BRACKET_PROMPT_RE.get_or_init(|| {
            Regex::new(r"(?:^|\n)(?:\([^)]+\)\s*)?\[([a-zA-Z0-9._-]+)@([a-zA-Z0-9._-]+)\s+([^\]]+)\]\s*([$#])\s*$").unwrap()
        });
        let ps_re = PS_PROMPT_RE.get_or_init(|| {
            Regex::new(r"(?:^|\n)PS\s+([A-Za-z]:\\[^>\r\n]*)>\s*$").unwrap()
        });

        let tail = if clean.len() > 512 {
            let mut idx = clean.len() - 512;
            while idx < clean.len() && !clean.is_char_boundary(idx) {
                idx += 1;
            }
            &clean[idx..]
        } else {
            &clean
        };

        if let Some(caps) = unix_re.captures(tail) {
            let user = caps[1].to_string();
            let host = caps[2].to_string();
            let cwd = caps[3].to_string();
            session_manager.update_context(session_id, |ctx| {
                ctx.user = Some(user);
                ctx.hostname = Some(host);
                ctx.cwd = Some(cwd);
            });
        } else if let Some(caps) = bracket_re.captures(tail) {
            let user = caps[1].to_string();
            let host = caps[2].to_string();
            let dir_part = caps[3].trim().to_string();
            session_manager.update_context(session_id, |ctx| {
                ctx.user = Some(user);
                ctx.hostname = Some(host);
                if dir_part.starts_with('/') || dir_part == "~" {
                    ctx.cwd = Some(dir_part);
                }
            });
        } else if let Some(caps) = ps_re.captures(tail) {
            let cwd = caps[1].trim().to_string();
            session_manager.update_context(session_id, |ctx| {
                ctx.cwd = Some(cwd);
                ctx.os = Some("windows".to_string());
            });
        }
    }
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_observe_su_prompt_change() {
        let sm = SessionManager::new();
        sm.register_session("s1".into(), "host1".into(), crate::session::SessionKind::Interactive);
        CwdTracker::observe_output(&sm, "s1", "\x1b[32mdeploy@prod-web:/opt/app$ \x1b[0m");
        let ctx = sm.get_context("s1").unwrap();
        assert_eq!(ctx.user.as_deref(), Some("deploy"));
        assert_eq!(ctx.hostname.as_deref(), Some("prod-web"));
        assert_eq!(ctx.cwd.as_deref(), Some("/opt/app"));

        // 模拟 su - root 切换用户
        CwdTracker::observe_output(&sm, "s1", "Password:\n[root@prod-web /etc/nginx]# ");
        let ctx2 = sm.get_context("s1").unwrap();
        assert_eq!(ctx2.user.as_deref(), Some("root"));
        assert_eq!(ctx2.cwd.as_deref(), Some("/etc/nginx"));
    }

    #[test]
    fn test_observe_windows_ps_prompt() {
        let sm = SessionManager::new();
        sm.register_session("win1".into(), "local".into(), crate::session::SessionKind::Interactive);
        CwdTracker::observe_output(&sm, "win1", "PS C:\\Users\\dev\\project> ");
        let ctx = sm.get_context("win1").unwrap();
        assert_eq!(ctx.cwd.as_deref(), Some("C:\\Users\\dev\\project"));
        assert_eq!(ctx.os.as_deref(), Some("windows"));
    }
}
