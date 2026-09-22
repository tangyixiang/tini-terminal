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

    pub fn check_command(&self, command: &str) -> SafetyCheckResult {
        let trimmed = command.trim();

        // 检查极度危险模式
        for (pattern, reason) in &self.danger_patterns {
            if pattern.is_match(trimmed) {
                return SafetyCheckResult {
                    is_dangerous: true,
                    risk_level: "dangerous".to_string(),
                    command: trimmed.to_string(),
                    message: reason.to_string(),
                };
            }
        }

        // 检查警告级别模式
        for (pattern, reason) in &self.warning_patterns {
            if pattern.is_match(trimmed) {
                return SafetyCheckResult {
                    is_dangerous: false,
                    risk_level: "warning".to_string(),
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
}
