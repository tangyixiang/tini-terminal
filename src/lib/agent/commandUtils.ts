/**
 * 判断是否为只读命令
 * 严禁包含写入重定向、写管道以及任何可能修改系统状态的关键字
 */
export function isReadOnlyCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return true;

  // 仅识别真实文件写入重定向，2>/dev/null 与 2>&1 属于输出丢弃与流合并，不构成写入
  if (hasWriteRedirection(trimmed)) return false;

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
 * 识别真实的文件写入重定向
 * 排除 2>/dev/null、2>&1、&>/dev/null 等仅影响输出流向的写法
 */
function hasWriteRedirection(cmd: string): boolean {
  const normalized = cmd
    .replace(/\d?>&\d/g, ' ')
    .replace(/&>\s*\/dev\/null/g, ' ')
    .replace(/\d?>\s*\/dev\/null/g, ' ');

  // 管道写入
  if (/\|\s*(tee|dd)\b/i.test(normalized)) return true;

  // 文件写入重定向
  return /(^|[^0-9])>>?\s*(?!&)/.test(normalized);
}

/**
 * 剥离 sudo、timeout 等命令包装前缀，使真实指令参与匹配
 */
function stripCommandWrapper(cmd: string): string {
  const wrapperPattern =
    /^(?:sudo(?:\s+-\S+(?:\s+\S+)?)?|doas|command|nohup|env|exec|timeout\s+[\d.]+[smhd]?|nice(?:\s+-n\s+-?\d+)?|ionice)\s+/i;

  let rest = cmd.trim();
  for (let i = 0; i < 3 && wrapperPattern.test(rest); i++) {
    rest = rest.replace(wrapperPattern, '').trim();
  }
  return rest;
}

/**
 * 统一格式化非零退出码的命令输出
 * 探测判断类命令的结果仅代表条件成立与否，必须与真实执行失败明确区分
 */
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

/**
 * 判断指令中是否包含真实状态变更动作
 * 用于防止带过滤管道的变更命令被误判为探测类命令
 */
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

/** 探测命令匹配规则 */
const DIAGNOSTIC_PATTERNS = [
  /^(grep|egrep|fgrep)\b/i,
  /^(test|\[\s|\[\[\s)/i,
  /^(pidof|pgrep)\b/i,
  /^(diff|cmp)\b/i,
  /^systemctl\s+(status|show|is-active|is-enabled|is-failed|list-units|list-unit-files|cat)\b/i,
  /^service\s+\S+\s+status\b/i,
  /^(which|type|command\s+-v|whereis)\b/i,
  /^find\b/i,
  /^curl\s+.*(-I|--head|-s|-f|-m|--connect-timeout)/i,
  /^(nc|netcat)\s+.*-z/i,
  /^ping\s+.*-c/i,
  /^(ss|netstat|lsof)\b/i,
];

/** 无副作用的中性补充命令，不改变判定语义 */
const NEUTRAL_PATTERNS = [
  /^(echo|printf|true|:|sleep|wait)\b/i,
];

/**
 * 判断单段命令是否为探测诊断类
 */
function isDiagnosticSegment(segment: string): boolean {
  const trimmed = stripCommandWrapper(segment);
  if (!trimmed) return false;

  if (DIAGNOSTIC_PATTERNS.some((p) => p.test(trimmed))) return true;

  // 管道命令以末尾段语义为准（如 ps aux | grep nginx、ss -tlnp | grep 80）
  const pipeSegments = trimmed.split('|');
  if (pipeSegments.length > 1) {
    const lastSegment = stripCommandWrapper(pipeSegments[pipeSegments.length - 1].trim());
    const pipeFilterPatterns = [
      /^(grep|egrep|fgrep)\b/i,
      /^(awk|sed|cut|head|tail|wc|sort|uniq)\b/i,
    ];
    return pipeFilterPatterns.some((p) => p.test(lastSegment));
  }

  return false;
}

/**
 * 判断是否为探测诊断或条件判断类命令
 * 此类命令返回非零退出码通常代表匹配结果或分支判断条件，不代表运维指令执行失败
 */
export function isDiagnosticCommand(cmd: string): boolean {
  const trimmed = stripCommandWrapper(cmd);
  if (!trimmed) return false;

  // 含真实状态变更动作的指令一律按执行类处理，不得豁免失败判定
  if (containsMutation(trimmed)) return false;

  // 先按逻辑运算符拆分为独立命令段，管道保留在各段内部整体判定
  const segments = trimmed
    .split(/&&|\|\||;/)
    .map((s) => s.trim())
    .filter((s) => s && !NEUTRAL_PATTERNS.some((p) => p.test(stripCommandWrapper(s))));

  if (segments.length === 0) return false;
  return segments.every((segment) => isDiagnosticSegment(segment));
}

/** 单个工具结果进入上下文的长度上限 */
const TOOL_RESULT_LIMIT = 8000;
const TOOL_RESULT_HEAD = 6000;
const TOOL_RESULT_TAIL = 1500;

/**
 * 截断超长工具输出，避免撑爆上下文窗口
 * 保留首尾关键信息并明确标注截断，不做任何内容伪造
 */
export function truncateToolResult(text: string, limit = TOOL_RESULT_LIMIT): string {
  if (!text || text.length <= limit) return text;
  const head = text.slice(0, TOOL_RESULT_HEAD);
  const tail = text.slice(-TOOL_RESULT_TAIL);
  const omitted = text.length - TOOL_RESULT_HEAD - TOOL_RESULT_TAIL;
  return `${head}\n\n[... 输出过长, 已省略中间 ${omitted} 字符 ...]\n\n${tail}`;
}
