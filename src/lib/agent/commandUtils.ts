/**
 * 判断是否为只读命令
 * 严禁包含写入重定向、写管道以及任何可能修改系统状态的关键字
 */
export function isReadOnlyCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return true;

  // 严禁包含写入重定向或写管道
  if (/>|>>|\|\s*(tee|dd)\b/i.test(trimmed)) return false;

  // 匹配状态修改与变更命令
  const modifyingKeywords = [
    'rm', 'mv', 'cp', 'chmod', 'chown', 'chgrp', 'mkdir', 'touch', 'truncate',
    'sed -i', 'useradd', 'usermod', 'userdel', 'groupadd', 'groupdel', 'passwd',
    'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'apk', 'systemctl start',
    'systemctl stop', 'systemctl restart', 'systemctl enable', 'systemctl disable',
    'service', 'kill', 'pkill', 'killall', 'reboot', 'shutdown', 'poweroff', 'mkfs', 'fdisk', 'dd',
    'git commit', 'git push', 'git checkout', 'git reset', 'git clean',
  ];

  const lower = trimmed.toLowerCase();
  for (const kw of modifyingKeywords) {
    const regex = new RegExp(`(^|[;&|\\s])${kw}(\\s|[;&|]|$)`, 'i');
    if (regex.test(lower)) {
      return false;
    }
  }

  return true;
}

/**
 * 判断是否为探测诊断或条件判断类命令
 * 此类命令返回非零退出码通常代表匹配结果或分支判断条件，不代表运维指令执行失败
 */
export function isDiagnosticCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;

  // 1. 命令本身属于探测、排查、测试或状态判断
  const directDiagnosticPatterns = [
    /^(grep|egrep|fgrep)\b/i,
    /^(test|\[\s|\[\[\s)/i,
    /^(pidof|pgrep)\b/i,
    /^(diff|cmp)\b/i,
    /^systemctl\s+(is-active|is-enabled|is-failed)\b/i,
    /^(which|type|command\s+-v|whereis)\b/i,
    /^find\b/i,
    /^curl\s+.*(-I|--head|-s|-f|-m|--connect-timeout)/i,
    /^(nc|netcat)\s+.*-z/i,
    /^ping\s+.*-c/i,
    /^(ss|netstat|lsof)\b/i,
  ];

  if (directDiagnosticPatterns.some((p) => p.test(trimmed))) {
    return true;
  }

  // 2. 管道命令末尾为过滤、计数或探测命令（如 ps aux | grep nginx、ss -tlnp | grep 80 等）
  const pipeSegments = trimmed.split('|');
  if (pipeSegments.length > 1) {
    const lastSegment = pipeSegments[pipeSegments.length - 1].trim();
    const pipeFilterPatterns = [
      /^(grep|egrep|fgrep)\b/i,
      /^(awk|sed|cut|head|tail|wc|sort|uniq)\b/i,
    ];
    if (pipeFilterPatterns.some((p) => p.test(lastSegment))) {
      return true;
    }
  }

  return false;
}


