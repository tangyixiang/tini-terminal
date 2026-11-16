use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SafetyCheckResult {
    pub is_dangerous: bool,
    pub risk_level: String, // "safe" | "warning" | "dangerous"
    pub command: String,
    pub message: String,
}

pub struct SafetyManager {
    danger_patterns: Vec<(Regex, &'static str)>,
    warning_patterns: Vec<(Regex, &'static str)>,
}

/// 危险命令拦截等级
/// - high: 拦截全部危险与警告模式（默认）
/// - medium: 仅拦截极度危险模式，警告模式降级为提示
/// - low: 仅记录而不阻断，风险级别统一按 safe 返回
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SafetyLevel {
    High,
    Medium,
    Low,
}

impl SafetyLevel {
    pub fn from_str(value: &str) -> Self {
        match value.trim().to_lowercase().as_str() {
            "low" => SafetyLevel::Low,
            "medium" => SafetyLevel::Medium,
            _ => SafetyLevel::High,
        }
    }
}

impl SafetyManager {
    pub fn new() -> Self {
        let danger_patterns = vec![
            (
                Regex::new(r"(?i)\brm\s+-[rfRF]{1,4}\s+(/|/\*|\.\.|\./\*|~|~\*)").unwrap(),
                "检测到根目录或大范围强力递归删除指令 (rm -rf /)",
            ),
            (
                Regex::new(r"(?i)\bmkfs(\.\w+)?\b").unwrap(),
                "检测到磁盘文件系统格式化指令 (mkfs)",
            ),
            (
                Regex::new(r"(?i)\bdd\s+if=.*of=/dev/(sd[a-z]|nvme|vd[a-z]|disk)").unwrap(),
                "检测到裸磁盘块设备覆写指令 (dd)",
            ),
            (
                Regex::new(r"(?i)\b(shutdown|reboot|poweroff|halt|init\s+0|init\s+6)\b").unwrap(),
                "检测到系统停机或关机重启指令",
            ),
            (
                Regex::new(r"(?i)\biptables\s+(-F|-X|--flush)\b").unwrap(),
                "检测到防火墙规则清空指令，可能导致远程连接断开",
            ),
            (
                Regex::new(r"(?i)\bdrop\s+(database|schema)\b").unwrap(),
                "检测到数据库级删除指令 (DROP DATABASE)",
            ),
            (
                Regex::new(r"(?i):\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:").unwrap(),
                "检测到 Fork 炸弹攻击代码",
            ),
        ];

        let warning_patterns = vec![
            (
                Regex::new(r"(?i)\b(systemctl|service)\s+(stop|restart)\s+(ssh|sshd)\b").unwrap(),
                "警告：正在停止或重启 SSH 服务，可能导致当前会话中断",
            ),
            (
                Regex::new(r"(?i)\b(chmod|chown)\s+-[rR]\s+777\b").unwrap(),
                "警告：正在大范围修改文件权限为 777，存在安全隐患",
            ),
            (
                Regex::new(r"(?i)\bkill\s+-9\s+(-1|1)\b").unwrap(),
                "警告：正在强制终止 init/systemd 进程",
            ),
            (
                Regex::new(r"(?i)\bdrop\s+table\b").unwrap(),
                "警告：检测到数据表删除指令 (DROP TABLE)",
            ),
        ];

        Self {
            danger_patterns,
            warning_patterns,
        }
    }

    pub fn check_command_with_level(
        &self,
        command: &str,
        level: SafetyLevel,
    ) -> SafetyCheckResult {
        let trimmed = command.trim();

        // 极度危险模式：除低等级仅记录外，其余等级均强制拦截
        for (pattern, reason) in &self.danger_patterns {
            if pattern.is_match(trimmed) {
                let blocked = level != SafetyLevel::Low;
                return SafetyCheckResult {
                    is_dangerous: blocked,
                    risk_level: if blocked { "dangerous" } else { "safe" }.to_string(),
                    command: trimmed.to_string(),
                    message: if blocked {
                        reason.to_string()
                    } else {
                        format!("已记录高危指令但不拦截: {}", reason)
                    },
                };
            }
        }

        // 警告级别模式：高等级按 warning 拦截，中低等级仅作提示
        for (pattern, reason) in &self.warning_patterns {
            if pattern.is_match(trimmed) {
                return SafetyCheckResult {
                    is_dangerous: false,
                    risk_level: if level == SafetyLevel::High {
                        "warning"
                    } else {
                        "safe"
                    }
                    .to_string(),
                    command: trimmed.to_string(),
                    message: reason.to_string(),
                };
            }
        }

        SafetyCheckResult {
            is_dangerous: false,
            risk_level: "safe".to_string(),
            command: trimmed.to_string(),
            message: "命令合规".to_string(),
        }
    }

    pub fn check_command(&self, command: &str) -> SafetyCheckResult {
        self.check_command_with_level(command, SafetyLevel::High)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_safe_commands() {
        let manager = SafetyManager::new();
        assert_eq!(manager.check_command("ls -la /var/log").risk_level, "safe");
        assert_eq!(manager.check_command("docker ps").risk_level, "safe");
        assert_eq!(manager.check_command("systemctl status nginx").risk_level, "safe");
        assert_eq!(manager.check_command("cat /etc/hosts").risk_level, "safe");
    }

    #[test]
    fn test_dangerous_commands() {
        let manager = SafetyManager::new();
        let res1 = manager.check_command("rm -rf /");
        assert!(res1.is_dangerous);
        assert_eq!(res1.risk_level, "dangerous");

        let res2 = manager.check_command("rm -rf /*");
        assert!(res2.is_dangerous);

        let res3 = manager.check_command("mkfs.ext4 /dev/sda1");
        assert!(res3.is_dangerous);

        let res4 = manager.check_command("reboot");
        assert!(res4.is_dangerous);

        let res5 = manager.check_command("iptables -F");
        assert!(res5.is_dangerous);
    }

    #[test]
    fn test_warning_commands() {
        let manager = SafetyManager::new();
        let res = manager.check_command("chmod -R 777 /var/www");
        assert!(!res.is_dangerous);
        assert_eq!(res.risk_level, "warning");
    }

    #[test]
    fn test_safety_levels_take_effect() {
        let manager = SafetyManager::new();

        // 高等级：拦截危险与警告
        let high_danger = manager.check_command_with_level("rm -rf /", SafetyLevel::High);
        assert!(high_danger.is_dangerous);
        let high_warn = manager.check_command_with_level("chmod -R 777 /var/www", SafetyLevel::High);
        assert_eq!(high_warn.risk_level, "warning");

        // 中等级：警告降级为安全，危险仍拦截
        let medium_warn =
            manager.check_command_with_level("chmod -R 777 /var/www", SafetyLevel::Medium);
        assert_eq!(medium_warn.risk_level, "safe");
        let medium_danger = manager.check_command_with_level("mkfs.ext4 /dev/sda1", SafetyLevel::Medium);
        assert!(medium_danger.is_dangerous);

        // 低等级：仅记录，不拦截
        let low_danger = manager.check_command_with_level("rm -rf /", SafetyLevel::Low);
        assert!(!low_danger.is_dangerous);
        assert_eq!(low_danger.risk_level, "safe");
        assert!(low_danger.message.contains("已记录"));
    }

    #[test]
    fn test_safety_level_from_str() {
        assert_eq!(SafetyLevel::from_str("high"), SafetyLevel::High);
        assert_eq!(SafetyLevel::from_str("medium"), SafetyLevel::Medium);
        assert_eq!(SafetyLevel::from_str("low"), SafetyLevel::Low);
        assert_eq!(SafetyLevel::from_str("unknown"), SafetyLevel::High);
        assert_eq!(SafetyLevel::from_str(""), SafetyLevel::High);
    }
}
