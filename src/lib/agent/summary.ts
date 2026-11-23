import type { ToolCallItem } from '../../types';

/** 单个工具输出进入结论摘要的字符上限与行数上限 */
const RESULT_PREVIEW_LIMIT = 2000;
const RESULT_OUTPUT_LINE_LIMIT = 40;
/** 结论摘要总长度上限 */
const DIGEST_TOTAL_LIMIT = 12000;
const DIGEST_ITEM_LIMIT = 20;

/** 实质性结论的最低有效字符数（过滤纯标点、极短过渡语或空壳模板） */
export const SUBSTANTIVE_CONCLUSION_MIN_CHARS = 24;

const STATUS_LABELS: Record<ToolCallItem['status'], string> = {
  pending: '待执行',
  executing: '执行中',
  success: '成功',
  failed: '失败',
  rejected: '已取消',
};

const WRITE_TOOL_NAMES = new Set(['file_write', 'host_file_write', 'host_transfer']);

/** 结论标题：兼容 Markdown 加粗与各级标题 */
const CONCLUSION_HEADING_SOURCE =
  '^[ \\t]*(?:#{1,6}[ \\t]*|\\*{2})[^\\n]{0,12}(?:执行结论|最终结论|运维结论|执行报告|任务总结|执行总结|排查结论|结果汇总)\\*{0,2}[ \\t]*$';

/** 兼容 `- **目标达成情况**: ...` / `- 目标达成情况：...` */
const ACHIEVEMENT_FIELD_PATTERN =
  /^[ \t]*(?:[-*+][ \t]*)?\*{0,2}(?:目标达成情况|总体达成情况|整体达成情况|达成情况|最终状态|任务状态)\*{0,2}[ \t]*[:：][ \t]*(.*)$/m;

/** 兼容多行列表/表格：冒号后同行内容或紧随其后的非空内容 */
const VERIFICATION_FIELD_PATTERN =
  /^[ \t]*(?:[-*+][ \t]*)?\*{0,2}(?:关键状态与验证|节点状态与验证|状态与验证|最终验证|验证结果|核心发现与数据|核查结果)\*{0,2}[ \t]*[:：][ \t]*(.*)$/m;

function describeToolTarget(toolCall: ToolCallItem): string {
  const args = toolCall.args || {};
  if (typeof args.command === 'string' && args.command.trim()) {
    return args.command.trim();
  }
  if (typeof args.path === 'string' && args.path.trim()) {
    return args.path.trim();
  }
  if (typeof args.src_path === 'string' && typeof args.dst_path === 'string') {
    return `${args.src_path} -> ${args.dst_path}`;
  }
  return '';
}

/** 去除 ANSI 控制码，避免终端着色污染结论摘要 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '');
}

/**
 * 保留工具输出的原始换行与表格结构，仅做行数/长度裁剪
 */
function describeToolOutput(toolCall: ToolCallItem, limit = RESULT_PREVIEW_LIMIT): string {
  const raw = stripAnsi(toolCall.result || '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return '';

  const allLines = raw.split('\n');
  let lines = allLines;
  if (lines.length > RESULT_OUTPUT_LINE_LIMIT) {
    lines = lines.slice(0, RESULT_OUTPUT_LINE_LIMIT);
    lines.push(`... 其余 ${allLines.length - RESULT_OUTPUT_LINE_LIMIT} 行已省略`);
  }

  let text = lines.join('\n');
  if (text.length > limit) {
    text = `${text.slice(0, limit)}\n... 其余 ${text.length - limit} 字符已省略`;
  }
  return text;
}

/**
 * 汇总本轮真实工具执行状态，作为模型判定最终结论的事实依据
 */
export function buildToolExecutionDigest(toolCalls: ToolCallItem[]): string {
  if (toolCalls.length === 0) return '（本轮未执行任何工具调用）';

  const success = toolCalls.filter((t) => t.status === 'success').length;
  const failed = toolCalls.filter((t) => t.status === 'failed').length;
  const rejected = toolCalls.filter((t) => t.status === 'rejected').length;

  const lines = [
    `共 ${toolCalls.length} 次工具调用: 成功 ${success}, 失败 ${failed}, 取消 ${rejected}`,
  ];

  const recent = toolCalls.slice(-DIGEST_ITEM_LIMIT);
  const offset = toolCalls.length - recent.length;
  let budget = DIGEST_TOTAL_LIMIT - lines[0].length;
  recent.forEach((toolCall, index) => {
    const host = toolCall.hostName ? `[${toolCall.hostName}] ` : '';
    const target = describeToolTarget(toolCall);
    const hasLaterSuccess =
      toolCall.status === 'failed' &&
      toolCalls.slice(offset + index + 1).some((t) => t.status === 'success');
    const header = `${offset + index + 1}. ${host}${toolCall.name}${target ? ` · ${target}` : ''} · ${STATUS_LABELS[toolCall.status]}${hasLaterSuccess ? '(过程项, 后续步骤已成功)' : ''}`;
    lines.push(header);
    budget -= header.length;

    if (budget <= 0) return;
    const output = describeToolOutput(toolCall, Math.min(RESULT_PREVIEW_LIMIT, budget));
    if (output) {
      const outputLines = output.split('\n').map((line) => `   ${line}`);
      lines.push(...outputLines, '');
      budget -= outputLines.reduce((sum, line) => sum + line.length + 1, 0);
    }
  });

  return lines.join('\n').trimEnd();
}

/** 模板占位符（如 [已完成 / 异常]）不算真实内容 */
function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return /^\[[^\]]*\]$/.test(trimmed);
}

export interface ConclusionCheckOptions {
  /** 本轮输出是否被服务端截断（finish_reason=length / content_filter） */
  truncated?: boolean;
}

/**
 * 提取某字段之后（包含同行与后续缩进/子列表行）的实质内容
 */
function extractFieldBody(content: string, pattern: RegExp): string {
  const match = pattern.exec(content);
  if (!match) return '';
  const sameLine = (match[1] || '').trim();
  if (sameLine && !isPlaceholderValue(sameLine)) {
    return sameLine;
  }
  // 兼容模型把验证结果写成冒号下一行的子列表或表格
  const afterStart = match.index + match[0].length;
  const restLines = content.slice(afterStart).split('\n').slice(1);
  const collected: string[] = [];
  for (const line of restLines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (collected.length > 0) break;
      continue;
    }
    // 遇到下一个顶层标题或下一个已知字段标题时停止
    if (/^#{1,6}\s/.test(trimmed)) break;
    if (ACHIEVEMENT_FIELD_PATTERN.test(line)) break;
    collected.push(trimmed);
    if (collected.join(' ').length >= 80) break;
  }
  return collected.join(' ').trim();
}

/**
 * 判断模型在工具执行后给出的最终回复是否有效闭环
 * 核心原则：尊重模型自由组织的清晰报告（含加粗、多行列表、表格），
 * 仅拦截空回复、明显被截断、纯占位符或过短的敷衍过渡句，绝不误杀正常总结。
 */
export function isConclusionComplete(
  content: string,
  options: ConclusionCheckOptions = {}
): boolean {
  if (!content) return false;
  if (options.truncated) return false;

  const cleaned = content
    .replace(/^>\s*模型输出.*$/gm, '')
    .trim();
  if (!cleaned) return false;

  // 若包含未填完的模板占位符（如 "[已完成 / 异常]"），判定未闭环
  if (/\[已完成\s*\/\s*异常\]/.test(cleaned)) return false;

  // 路径 1：按结构化结论格式校验（兼容加粗与多行列表）
  if (new RegExp(CONCLUSION_HEADING_SOURCE, 'm').test(cleaned)) {
    const achievement = extractFieldBody(cleaned, ACHIEVEMENT_FIELD_PATTERN);
    const verification = extractFieldBody(cleaned, VERIFICATION_FIELD_PATTERN);
    if (achievement && !isPlaceholderValue(achievement) && verification.length >= 10) {
      return true;
    }
    // 即使字段名略有变化，只要该标题下有足够实质内容也视为完整
    const lastIdx = findLastConclusionIndex(cleaned);
    const sectionBody = lastIdx >= 0 ? cleaned.slice(lastIdx) : cleaned;
    const bodyLines = sectionBody
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean);
    if (bodyLines.join('').length >= SUBSTANTIVE_CONCLUSION_MIN_CHARS) {
      return true;
    }
    return false;
  }

  // 路径 2：模型使用自由 Markdown（表格、分节分析、清晰结论）而非固定模板标题
  // 只要有效正文长度充足且不是一句“正在排查/让我看看”之类的过程预告，即认可为完整回复
  const plainLen = cleaned.replace(/[\s#*_`>-]/g, '').length;
  if (plainLen < SUBSTANTIVE_CONCLUSION_MIN_CHARS) return false;

  const isOnlyTransitionPhrase =
    /^(?:好的|明白|收到|正在|我来|接下来|下面|让我)[^。！？\n]{0,30}[。：:….]*$/.test(cleaned);
  if (isOnlyTransitionPhrase) return false;

  return true;
}

/** 定位正文中最后一段结论的起始位置，不存在时返回 -1 */
function findLastConclusionIndex(text: string): number {
  const headingPattern = new RegExp(CONCLUSION_HEADING_SOURCE, 'gm');
  let lastIndex = -1;
  for (const match of text.matchAll(headingPattern)) {
    lastIndex = match.index ?? lastIndex;
  }
  return lastIndex;
}

/** 仅在尾部确实是残缺模板片段时裁剪，不删除模型已产出的有效分析 */
export function dropIncompleteConclusion(content: string): string {
  const text = (content || '').trim();
  if (!text) return '';

  const lastIndex = findLastConclusionIndex(text);
  if (lastIndex < 0) return text;
  const tail = text.slice(lastIndex);
  // 只有当尾部结论本身长度很短或含占位符时才截掉
  if (tail.length < 120 || /\[已完成\s*\/\s*异常\]/.test(tail)) {
    return text.slice(0, lastIndex).trim();
  }
  return text;
}

export function isTrailingConclusionComplete(
  content: string,
  options: ConclusionCheckOptions = {}
): boolean {
  const text = (content || '').trim();
  if (!text) return false;
  if (options.truncated) return false;

  const lastIndex = findLastConclusionIndex(text);
  const tail = lastIndex < 0 ? text : text.slice(lastIndex);
  return isConclusionComplete(tail, options);
}

/**
 * 合并补充结论：若原有正文已有有效分析则保留并追加，仅替换明显残缺的半截结论
 */
export function upsertConclusion(
  content: string,
  conclusion: string,
  options: ConclusionCheckOptions = {}
): string {
  const trimmed = (content || '').trim();
  const report = (conclusion || '').trim();
  if (!report) return trimmed;
  if (!trimmed) return report;
  if (isTrailingConclusionComplete(trimmed, options)) return trimmed;

  const base = dropIncompleteConclusion(trimmed);
  return base ? `${base}\n\n${report}` : report;
}

export function appendConclusionSafely(
  content: string,
  conclusion: string,
  options: ConclusionCheckOptions = {}
): string {
  return upsertConclusion(content, conclusion, options);
}

const ABORT_MARKERS = ['[任务已手动中止]', '[工作区任务已手动中止]'];

export function sanitizeHistoryContent(content?: string): string {
  if (!content) return '';
  let text = content;
  for (const marker of ABORT_MARKERS) {
    text = text.split(marker).join('');
  }
  return text.trim();
}

export function buildHistoryToolResult(toolCall: ToolCallItem): string {
  if (toolCall.status === 'rejected') return '用户拒绝执行';
  const result = (toolCall.result || '').trim();
  if (!result) {
    return toolCall.status === 'failed' ? '(执行失败且无输出)' : '(无输出)';
  }
  return result;
}

export interface ThinkParseState {
  inThink: boolean;
  pending: string;
}

/**
 * 解析正文中的 <think> 标签，处理标签被拆分到多个流式片段的情况
 */
export function parseThinkTag(
  raw: string,
  state: ThinkParseState
): { thinking: string; content: string; state: ThinkParseState } {
  let text = state.pending + raw;
  let inThink = state.inThink;
  let thinking = '';
  let content = '';

  while (text.length > 0) {
    if (inThink) {
      const close = text.indexOf('</think>');
      if (close === -1) {
        const keep = longestTagSuffix(text, '</think>');
        thinking += text.slice(0, text.length - keep.length);
        return { thinking, content, state: { inThink, pending: keep } };
      }
      thinking += text.slice(0, close);
      text = text.slice(close + '</think>'.length);
      inThink = false;
    } else {
      const open = text.indexOf('<think>');
      if (open === -1) {
        const keep = longestTagSuffix(text, '<think>');
        content += text.slice(0, text.length - keep.length);
        return { thinking, content, state: { inThink, pending: keep } };
      }
      content += text.slice(0, open);
      text = text.slice(open + '<think>'.length);
      inThink = true;
    }
  }

  return { thinking, content, state: { inThink, pending: '' } };
}

/** 流结束时刷出未闭合的标签残片，避免丢字 */
export function flushThinkTag(state: ThinkParseState): { thinking: string; content: string } {
  if (!state.pending) return { thinking: '', content: '' };
  if (state.inThink) {
    return { thinking: state.pending, content: '' };
  }
  return { thinking: '', content: state.pending };
}

function longestTagSuffix(text: string, tag: string): string {
  const max = Math.min(text.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) {
      return text.slice(text.length - len);
    }
  }
  return '';
}

/**
 * 构造用于请求最终结论的消息序列：
 * 1. 移除 tool_calls 与 tool 消息，兼容不声明 tools 的总结请求
 * 2. 严格保证 user / assistant 角色交替，避免 DeepSeek-Reasoner / Qwen / vLLM 因连续两条 user 报 400 或空响应
 */
export function buildConclusionMessages(
  conversation: any[],
  conclusionPrompt: string
): any[] {
  const messages: any[] = [];

  for (const msg of conversation) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'tool') continue;
    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string' && msg.content.trim()) {
        if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
          messages[messages.length - 1] = {
            role: 'assistant',
            content: `${messages[messages.length - 1].content}\n\n${msg.content.trim()}`,
          };
        } else {
          messages.push({ role: 'assistant', content: msg.content.trim() });
        }
      }
      continue;
    }
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (!text) continue;
      if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
        messages[messages.length - 1] = {
          role: 'user',
          content: `${messages[messages.length - 1].content}\n\n${text}`,
        };
      } else {
        messages.push({ role: 'user', content: text });
      }
      continue;
    }
    messages.push(msg);
  }

  // 若末尾仍是 user，先插入一条简洁的 assistant 过渡消息以保证角色严格交替
  if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
    messages.push({
      role: 'assistant',
      content: '已完成本轮工具调用，正在依据执行结果汇总结论。',
    });
  }

  messages.push({ role: 'user', content: conclusionPrompt });
  return messages;
}

/**
 * 请求模型输出最终执行结论的提示词（会话级与工作区级共用）
 */
export function buildConclusionPrompt(
  scope: 'session' | 'workspace',
  toolCalls: ToolCallItem[]
): string {
  const digest = buildToolExecutionDigest(toolCalls);

  const common = `所有工具调用已结束。请依据下方真实执行输出，为用户提供一份清晰、完整、可直接阅读的最终总结：
1. 先用 1-2 句话直接给出最终结论（目标是否达成、当前状态或排查根因）。
2. 列出关键验证数据与事实（真实引用的指标、进程/PID、端口、配置路径、日志片段、退出码等），可使用无序列表或 Markdown 表格清晰呈现。
3. 如有配置修改、文件写入或服务变更，明确列出变更项与路径；无变更则简要说明。
4. 如有异常或待处理风险，指明具体环节与下一步建议。
5. 以最终状态判定成败：前置探测命令（grep/test/pidof/which/systemctl is-active 等）的非零退出码属于正常判断，前期已被修复的报错不视为失败。
6. 严禁虚构未在下方输出中出现的数据，严禁使用 Emoji。

本轮工具真实执行记录：
${digest}`;

  if (scope === 'workspace') {
    return `${common}

建议输出结构：
### 最终执行结论
- **总体达成情况**: 已完成 / 异常 + 核心概述
- **各节点状态与关键数据**: 逐主机列出真实指标、端口、服务状态或对比差异
- **变更与同步清单**: 涉及的脚本下发、配置修改或跨机同步（无则写无）`;
  }

  return `${common}

建议输出结构：
### 执行结论
- **目标达成情况**: 已完成 / 异常 + 核心概述
- **关键状态与验证**: 引用本轮真实数据（服务状态、端口、进程、资源占用、关键日志或配置项等）
- **变更与建议**: 本轮修改内容或后续建议（无则写无）`;
}

/**
 * 仅在模型完全无法产出有效回复（如网络中断/多次空响应）时的事实兜底汇总
 * 附带末尾关键步骤的真实输出摘录，避免空洞无信息
 */
export function buildDeterministicConclusion(toolCalls: ToolCallItem[]): string {
  const success = toolCalls.filter((t) => t.status === 'success').length;
  const rejected = toolCalls.filter((t) => t.status === 'rejected').length;

  const unresolvedFailures = toolCalls.filter(
    (toolCall, index) =>
      toolCall.status === 'failed' &&
      !toolCalls.slice(index + 1).some((later) => later.status === 'success')
  );

  let verdict: string;
  if (unresolvedFailures.length > 0) {
    verdict = '异常';
  } else if (success > 0) {
    verdict = '已完成';
  } else if (rejected > 0) {
    verdict = '已取消';
  } else {
    verdict = '未执行任何操作';
  }

  const lines = [
    '### 执行结论',
    `- **目标达成情况**: ${verdict}（本轮共 ${toolCalls.length} 步：成功 ${success}，取消 ${rejected}，未闭环失败 ${unresolvedFailures.length}）。`,
  ];

  // 提取最近最多 3 条带真实输出的执行结果作为事实证据
  const recentWithOutput = toolCalls
    .filter((t) => t.status === 'success' || t.status === 'failed')
    .slice(-3);

  if (recentWithOutput.length > 0) {
    lines.push('- **关键执行输出摘录**:');
    for (const tc of recentWithOutput) {
      const host = tc.hostName ? `[${tc.hostName}] ` : '';
      const target = describeToolTarget(tc) || tc.name;
      const snippet = stripAnsi(tc.result || '')
        .replace(/\r\n?/g, '\n')
        .trim()
        .split('\n')
        .slice(0, 6)
        .join('\n');
      lines.push(`  - \`${host}${target}\` (${STATUS_LABELS[tc.status]})`);
      if (snippet) {
        lines.push('```text');
        lines.push(snippet.slice(0, 600));
        lines.push('```');
      }
    }
  }

  const changes = toolCalls
    .filter((t) => WRITE_TOOL_NAMES.has(t.name) && t.status === 'success')
    .map((t) => `${t.hostName ? `[${t.hostName}] ` : ''}${describeToolTarget(t)}`.trim())
    .filter(Boolean)
    .slice(0, 10);
  lines.push(`- **重点变更说明**: ${changes.length > 0 ? changes.join('; ') : '无'}`);
  lines.push('> 注：模型未返回总结正文，以上为基于真实工具输出自动整理的事实摘录。');
  return lines.join('\n');
}
