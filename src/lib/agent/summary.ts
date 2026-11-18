import type { ToolCallItem } from '../../types';

/** 单个工具输出进入结论摘要的字符上限与行数上限 */
const RESULT_PREVIEW_LIMIT = 2000;
const RESULT_OUTPUT_LINE_LIMIT = 40;
/** 结论摘要总长度上限 */
const DIGEST_TOTAL_LIMIT = 12000;
const DIGEST_ITEM_LIMIT = 20;

/** 结论中「状态与验证」字段的最低实质内容长度，低于该长度视为残句 */
export const CONCLUSION_DETAIL_MIN_CHARS = 20;

const STATUS_LABELS: Record<ToolCallItem['status'], string> = {
  pending: '待执行',
  executing: '执行中',
  success: '成功',
  failed: '失败',
  rejected: '已取消',
};

const WRITE_TOOL_NAMES = new Set(['file_write', 'host_file_write', 'host_transfer']);

/** 结论标题：任意层级，允许「最终/运维/执行」等修饰词 */
const CONCLUSION_HEADING_SOURCE =
  '^[ \\t]*#{1,6}[ \\t]*[^\\n]{0,10}(?:执行结论|最终结论|运维结论|执行报告|任务总结|执行总结)[ \\t]*$';

const ACHIEVEMENT_FIELD_PATTERN =
  /^[ \t]*(?:[-*+][ \t]*)?(?:目标达成情况|总体达成情况|整体达成情况|达成情况|最终状态|任务状态)[ \t]*[:：][ \t]*(.*)$/m;

const VERIFICATION_FIELD_PATTERN =
  /^[ \t]*(?:[-*+][ \t]*)?(?:关键状态与验证|节点状态与验证|状态与验证|最终验证|验证结果)[ \t]*[:：][ \t]*(.*)$/m;

function describeToolTarget(toolCall: ToolCallItem): string {
  const args = toolCall.args || {};
  if (typeof args.command === 'string' && args.command.trim()) {
    return args.command.trim();
  }
  if (typeof args.path === 'string' && args.path.trim()) {
    return args.path.trim();
  }
  return '';
}

/** 去除 ANSI 控制码，避免终端着色污染结论摘要 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * 保留工具输出的原始换行与表格结构
 * 表格、进程列表被压成单行后会丢失可引用的真实数据，因此仅做行数/长度裁剪
 */
function describeToolOutput(toolCall: ToolCallItem, limit = RESULT_PREVIEW_LIMIT): string {
  const raw = stripAnsi(toolCall.result || '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return '';

  let lines = raw.split('\n');
  if (lines.length > RESULT_OUTPUT_LINE_LIMIT) {
    lines = lines.slice(0, RESULT_OUTPUT_LINE_LIMIT);
    lines.push(`... 其余 ${raw.split('\n').length - RESULT_OUTPUT_LINE_LIMIT} 行已省略`);
  }

  let text = lines.join('\n');
  if (text.length > limit) {
    text = `${text.slice(0, limit)}\n... 其余 ${text.length - limit} 字符已省略`;
  }
  return text;
}

/**
 * 汇总本轮真实工具执行状态，作为模型判定最终结论的事实依据
 * 仅呈现真实执行结果，不注入任何主观定性
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
  // 摘要总长度上限，避免超长输出撑爆结论请求的上下文
  let budget = DIGEST_TOTAL_LIMIT - lines[0].length;
  recent.forEach((toolCall, index) => {
    const host = toolCall.hostName ? `[${toolCall.hostName}] ` : '';
    const target = describeToolTarget(toolCall);
    // 非末尾步骤的失败会标注后续仍有成功步骤，避免被误判为最终未完成
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
 * 判断结论是否真正闭环
 * 要求：存在结论标题、达成情况有实值、状态与验证有足够实质内容，且未被截断
 */
export function isConclusionComplete(
  content: string,
  options: ConclusionCheckOptions = {}
): boolean {
  if (!content) return false;
  if (options.truncated) return false;

  if (!new RegExp(CONCLUSION_HEADING_SOURCE, 'm').test(content)) return false;

  const achievement = content.match(new RegExp(ACHIEVEMENT_FIELD_PATTERN.source, 'm'))?.[1] || '';
  if (isPlaceholderValue(achievement)) return false;

  const verification =
    content.match(new RegExp(VERIFICATION_FIELD_PATTERN.source, 'm'))?.[1] || '';
  if (isPlaceholderValue(verification)) return false;
  if (verification.trim().length < CONCLUSION_DETAIL_MIN_CHARS) return false;

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

/** 截掉结尾那段不完整的结论，避免补充结论时残留半句 */
export function dropIncompleteConclusion(content: string): string {
  const text = (content || '').trim();
  if (!text) return '';

  const lastIndex = findLastConclusionIndex(text);
  if (lastIndex < 0) return text;
  return text.slice(0, lastIndex).trim();
}

/**
 * 判断正文结尾那段结论是否闭环
 * 多轮对话中历史轮次可能已有完整结论，因此必须只看最后一段
 */
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
 * 用补充结论替换结尾的不完整结论；结尾已闭环时不重复追加
 * 保证界面中始终只有一段有效结论
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

/** 在正文末尾安全追加兜底结论，结尾已闭环时不重复追加 */
export function appendConclusionSafely(
  content: string,
  conclusion: string,
  options: ConclusionCheckOptions = {}
): string {
  return upsertConclusion(content, conclusion, options);
}

const ABORT_MARKERS = ['[任务已手动中止]', '[工作区任务已手动中止]'];

/**
 * 清洗历史消息正文，剔除中止标记等运行时痕迹
 */
export function sanitizeHistoryContent(content?: string): string {
  if (!content) return '';
  let text = content;
  for (const marker of ABORT_MARKERS) {
    text = text.split(marker).join('');
  }
  return text.trim();
}

/**
 * 生成进入上下文的工具执行结果
 * 明确区分拒绝、无输出与真实输出，避免历史重放时语义漂移
 */
export function buildHistoryToolResult(toolCall: ToolCallItem): string {
  if (toolCall.status === 'rejected') return '用户拒绝执行';
  const result = (toolCall.result || '').trim();
  if (!result) {
    return toolCall.status === 'failed' ? '(执行失败且无输出)' : '(无输出)';
  }
  return result;
}

/**
 * 解析正文中的 <think> 标签，处理标签被拆分到多个流式片段的情况
 * 返回值中 thinking 为思考内容，content 为正文，pending 为尚未闭合的标签残片
 */
export function parseThinkTag(
  raw: string,
  state: { inThink: boolean; pending: string }
): { thinking: string; content: string; state: { inThink: boolean; pending: string } } {
  let text = state.pending + raw;
  let inThink = state.inThink;
  let thinking = '';
  let content = '';

  while (text.length > 0) {
    if (inThink) {
      const close = text.indexOf('</think>');
      if (close === -1) {
        // 保留可能为跨片段标签前缀的尾部
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

/** 求文本尾部与目标标签前缀重合的最长长度 */
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
 * 构造用于请求最终结论的消息序列
 * 丢弃 tool_calls 与 tool 消息，避免在未声明 tools 的请求中携带工具调用历史
 * 模型只会看到其自身的文本与用户的结论要求，兼容严格校验工具定义的实现
 */
export function buildConclusionMessages(conversation: any[], conclusionPrompt: string): any[] {
  const messages: any[] = [];

  for (const msg of conversation) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'tool') continue;
    if (msg.role === 'assistant') {
      // 保留有正文的 assistant 文本，丢弃纯工具调用占位
      if (typeof msg.content === 'string' && msg.content.trim()) {
        messages.push({ role: 'assistant', content: msg.content });
      }
      continue;
    }
    messages.push(msg);
  }

  messages.push({ role: 'user', content: conclusionPrompt });
  return messages;
}

/**
 * 请求模型输出最终执行结论的提示词（会话级与工作区级共用同一下沉实现）
 */
export function buildConclusionPrompt(
  scope: 'session' | 'workspace',
  toolCalls: ToolCallItem[]
): string {
  const digest = buildToolExecutionDigest(toolCalls);

  const common = `所有执行步骤与工具调用已结束。请依据下方真实执行状态，输出结构化最终结论：
1. 先给一句概述（整体目标是否达成、涉及对象与最终状态），再给关键事实。
2. 以整体目标是否达成、各节点最终验证状态为唯一评判依据。
3. 前置探测、分支判断、状态查询类命令返回的非零退出码属于正常判断结果，不应判定为失败。
4. 前期出现的报错或未就绪状态，只要已被后续步骤成功修复、启动、配置或同步，一律判定为已完成。
5. 仅当最终状态确实异常时才判定为异常，避免使用"未完成"等模糊表述。
6. 「状态与验证」必须引用真实执行数据，并非空泛描述：服务名、进程 PID、运行时长、内存占用、监听端口、版本号或退出码等，至少给出一项；数据来自下方执行状态。
7. 所有字段必须填写完整，无变更时写"无"；不得以半句或残句结尾。

真实执行状态：
${digest}`;

  if (scope === 'workspace') {
    return `${common}

请按以下格式输出：
### 最终执行结论
- 总体达成情况: [已完成 / 异常] + 一句话概述
- 节点状态与验证: [各主机真实数据：服务名/进程/端口/状态，逐节点列出]
- 重点变更与同步: [跨机同步、脚本下发或配置变更；无则写"无"]`;
  }

  return `${common}

请按以下格式输出：
### 执行结论
- 目标达成情况: [已完成 / 异常] + 一句话概述
- 关键状态与验证: [真实数据：服务名、进程 PID、运行时长、内存占用、监听端口或退出码等]
- 重点变更说明: [配置修改或脚本部署；无则写"无"]`;
}

/**
 * 模型未产出结论文本时，基于真实执行状态生成确定性结论
 * 数据全部来源于真实工具调用记录，不做任何虚构
 */
export function buildDeterministicConclusion(toolCalls: ToolCallItem[]): string {
  const success = toolCalls.filter((t) => t.status === 'success').length;
  const rejected = toolCalls.filter((t) => t.status === 'rejected').length;

  // 仅统计执行末尾仍未被后续成功步骤覆盖的失败，避免前置探测失败被误判为最终异常
  const unresolvedFailures = toolCalls.filter(
    (toolCall, index) =>
      toolCall.status === 'failed' &&
      !toolCalls.slice(index + 1).some((later) => later.status === 'success')
  );

  // 判定顺序：存在未闭环失败 → 异常；有成功步骤 → 已完成；全部被取消 → 已取消；否则未执行
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

  const executedSummary = toolCalls
    .filter((t) => t.status === 'success')
    .map((t) => describeToolTarget(t) || t.name)
    .filter(Boolean)
    .slice(0, 5)
    .join('; ');

  const lines = [
    '### 执行结论',
    `- 目标达成情况: ${verdict}，本轮共执行 ${toolCalls.length} 个步骤。`,
    `- 关键状态与验证: 共 ${toolCalls.length} 次调用，成功 ${success}，已取消 ${rejected}，未闭环失败 ${unresolvedFailures.length}${executedSummary ? `；已成功执行: ${executedSummary}` : ''}`,
  ];

  if (unresolvedFailures.length > 0) {
    const failedItems = unresolvedFailures
      .map((t) => `${t.hostName ? `[${t.hostName}] ` : ''}${t.name} ${describeToolTarget(t)}`.trim())
      .slice(0, 5);
    lines.push(`- 失败项: ${failedItems.join('; ')}`);
  }

  const changes = toolCalls
    .filter((t) => WRITE_TOOL_NAMES.has(t.name) && t.status === 'success')
    .map((t) => `${t.hostName ? `[${t.hostName}] ` : ''}${describeToolTarget(t)}`.trim())
    .filter(Boolean)
    .slice(0, 10);
  lines.push(`- 重点变更说明: ${changes.length > 0 ? changes.join('; ') : '无'}`);

  lines.push('- 说明: 以上结论依据真实工具执行记录汇总，未做任何推测补充');
  return lines.join('\n');
}
