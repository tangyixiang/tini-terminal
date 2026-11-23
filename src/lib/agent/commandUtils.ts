/**
 * 判断是否为只读命令（兼容 Linux / macOS / Windows PowerShell & CMD）
 * 严格拦截写入重定向、脚本解释器内联执行、包管理/容器/数据库变更及任何状态修改关键字
 */
export function isReadOnlyCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return true;

  if (hasWriteRedirection(trimmed)) return false;

  // 禁止脚本解释器 / 嵌套 shell 绕过只读检查（如 python -c / bash -c / eval）
  const bypassPatterns = [
    /\b(bash|sh|zsh|dash|ksh|fish|powershell|pwsh|cmd)\s+(-c|-command|\/c)\b/i,
    /\b(python|python3|perl|ruby|node|php|lua)\s+(-c|-e|-r)\b/i,
    /\b(eval|exec|xargs)\b/i,
    /\bcurl\b.*\s(-X|--request)\s+(POST|PUT|DELETE|PATCH)\b/i,
    /\bcurl\b.*\s(-d|--data|--data-raw|--data-binary|-F|--form|-o|--output|-O)\b/i,
    /\bwget\b(?!.*(--spider|-O\s*-))/i,
    /\bfind\b.*\s(-delete|-exec|-execdir|-ok)\b/i,
    /\b(docker|podman)\s+(rm|rmi|stop|kill|start|restart|pause|unpause|exec|run|pull|push|build|prune|compose\s+(up|down|restart|rm))\b/i,
    /\bkubectl\s+(apply|create|delete|patch|edit|replace|scale|rollout|cordon|drain|taint|exec)\b/i,
    /\b(mysql|psql|sqlite3|mongosh|mongo)\b.*\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i,
    /\bredis-cli\b.*\b(set|del|flushdb|flushall|expire|hset|lpush|rpush|rename|config\s+set)\b/i,
    /\b(tar\s+[^|;]*-[a-z]*[xc]|unzip|gunzip|bzip2|gzip|7z\s+[ax])\b/i,
  ];

  if (bypassPatterns.some((p) => p.test(trimmed))) {
    return false;
  }

  // Linux / macOS + Windows 常见状态修改关键字
  const modifyingKeywords = [
    'rm', 'mv', 'cp', 'ln', 'chmod', 'chown', 'chgrp', 'mkdir', 'rmdir', 'touch', 'truncate', 'install',
    'sed -i', 'useradd', 'usermod', 'userdel', 'groupadd', 'groupdel', 'passwd', 'visudo',
    'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'apk', 'brew install', 'brew uninstall', 'pip install', 'npm install',
    'systemctl start', 'systemctl stop', 'systemctl restart', 'systemctl reload', 'systemctl enable', 'systemctl disable',
    'service', 'kill', 'pkill', 'killall', 'reboot', 'shutdown', 'poweroff', 'halt', 'mkfs', 'fdisk', 'parted', 'dd',
    'iptables', 'ufw', 'firewall-cmd', 'mount', 'umount', 'crontab -e', 'crontab -r',
    'git commit', 'git push', 'git checkout', 'git reset', 'git clean', 'git merge', 'git rebase',
    // Windows PowerShell / CMD 变更命令
    'remove-item', 'set-content', 'add-content', 'out-file', 'new-item', 'move-item', 'copy-item', 'rename-item',
    'stop-service', 'start-service', 'restart-service', 'stop-process', 'stop-computer', 'restart-computer',
    'clear-disk', 'format', 'del', 'erase', 'rd', 'move', 'copy', 'xcopy', 'robocopy', 'sc stop', 'sc delete', 'taskkill',
  ];

  const lower = trimmed.toLowerCase();
  for (const kw of modifyingKeywords) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(^|[;&|\\s])${escaped}(\\s|[;&|]|$)`, 'i');
    if (regex.test(lower)) {
      return false;
    }
  }

  return true;
}

function hasWriteRedirection(cmd: string): boolean {
  const normalized = cmd
    .replace(/\d?>&\d/g, ' ')
    .replace(/&>\s*\/dev\/null/g, ' ')
    .replace(/\d?>\s*\/dev\/null/g, ' ')
    .replace(/\d?>\s*\$null/gi, ' ');

  if (/\|\s*(tee|dd|out-file|set-content|add-content)\b/i.test(normalized)) return true;
  return /(^|[^0-9])>>?\s*(?!&)/.test(normalized);
}

function stripCommandWrapper(cmd: string): string {
  const wrapperPattern =
    /^(?:sudo(?:\s+-\S+(?:\s+\S+)?)?|doas|command|nohup|env|exec|timeout\s+[\d.]+[smhd]?|nice(?:\s+-n\s+-?\d+)?|ionice)\s+/i;

  let rest = cmd.trim();
  for (let i = 0; i < 3 && wrapperPattern.test(rest); i++) {
    rest = rest.replace(wrapperPattern, '').trim();
  }
  return rest;
}

export function formatCommandExitOutput(
  exitCode: number,
  stdout: string,
  stderr: string,
  isDiagnostic: boolean
): string {
  if (isDiagnostic) {
    return `探测结果: 退出码 ${exitCode} 仅代表条件判断结果 (条件不成立或无匹配项)，不属于执行失败\n${stdout ? `标准输出:\n${stdout}\n` : ''}${stderr ? `错误输出:\n${stderr}` : ''}`;
  }
  return `命令执行失败: 退出码 ${exitCode}\n${stdout ? `标准输出:\n${stdout}\n` : ''}${stderr ? `错误输出:\n${stderr}` : ''}`;
}

function containsMutation(cmd: string): boolean {
  const normalized = cmd
    .replace(/\d?>&\d/g, ' ')
    .replace(/\d?>\s*\/dev\/null/g, ' ')
    .replace(/&>\s*\/dev\/null/g, ' ');

  const mutationPatterns = [
    /\b(rm|mv|cp|chmod|chown|chgrp|mkdir|rmdir|touch|truncate|dd|mkfs|fdisk|tee)\b/i,
    /\bsed\s+-i\b/i,
    /\bsystemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask)\b/i,
    /\bservice\s+\S+\s+(start|stop|restart|reload)\b/i,
    /\b(kill|pkill|killall|reboot|shutdown|poweroff|halt)\b/i,
    /\b(apt|apt-get|yum|dnf|pacman|apk|pip|npm|docker|kubectl)\s+\S*(install|remove|upgrade|stop|start|restart|rm|delete|apply|create|patch)\b/i,
    /\bfind\b.*\s(-delete|-exec|-execdir|-ok)\b/i,
    />|\|\s*(tee|dd)\b/,
  ];
  return mutationPatterns.some((p) => p.test(normalized));
}

const DIAGNOSTIC_PATTERNS = [
  /^(grep|egrep|fgrep)\b/i,
  /^(test|\[\s|\[\[\s)/i,
  /^(pidof|pgrep)\b/i,
  /^(diff|cmp)\b/i,
  /^systemctl\s+(status|show|is-active|is-enabled|is-failed|list-units|list-unit-files|cat)\b/i,
  /^service\s+\S+\s+status\b/i,
  /^(which|type|command\s+-v|whereis|where)\b/i,
  /^find\b/i,
  /^curl\s+.*(-I|--head|-s|-f|-m|--connect-timeout)/i,
  /^(nc|netcat)\s+.*-z/i,
  /^ping\s+.*(-c|-n)/i,
  /^(ss|netstat|lsof)\b/i,
];

const NEUTRAL_PATTERNS = [/^(echo|printf|true|:|sleep|wait)\b/i];

function isDiagnosticSegment(segment: string): boolean {
  const trimmed = stripCommandWrapper(segment);
  if (!trimmed) return false;

  if (DIAGNOSTIC_PATTERNS.some((p) => p.test(trimmed))) return true;

  const pipeSegments = trimmed.split('|');
  if (pipeSegments.length > 1) {
    const lastSegment = stripCommandWrapper(pipeSegments[pipeSegments.length - 1].trim());
    const pipeFilterPatterns = [
      /^(grep|egrep|fgrep|select-string|findstr)\b/i,
      /^(awk|sed|cut|head|tail|wc|sort|uniq)\b/i,
    ];
    return pipeFilterPatterns.some((p) => p.test(lastSegment));
  }

  return false;
}

export function isDiagnosticCommand(cmd: string): boolean {
  const trimmed = stripCommandWrapper(cmd);
  if (!trimmed) return false;
  if (containsMutation(trimmed)) return false;

  const segments = trimmed
    .split(/&&|\|\||;/)
    .map((s) => s.trim())
    .filter((s) => s && !NEUTRAL_PATTERNS.some((p) => p.test(stripCommandWrapper(s))));

  if (segments.length === 0) return false;
  return segments.every((segment) => isDiagnosticSegment(segment));
}

const TOOL_RESULT_LIMIT = 8000;
const TOOL_RESULT_HEAD = 6000;
const TOOL_RESULT_TAIL = 1500;

export function truncateToolResult(text: string, limit = TOOL_RESULT_LIMIT): string {
  if (!text || text.length <= limit) return text;
  const head = text.slice(0, TOOL_RESULT_HEAD);
  const tail = text.slice(-TOOL_RESULT_TAIL);
  const omitted = text.length - TOOL_RESULT_HEAD - TOOL_RESULT_TAIL;
  return `${head}\n\n[... 输出过长, 已省略中间 ${omitted} 字符 ...]\n\n${tail}`;
}
