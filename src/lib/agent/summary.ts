import type { ToolCallItem } from '../../types';

const RESULT_PREVIEW_LIMIT = 320;
const DIGEST_ITEM_LIMIT = 20;

const STATUS_LABELS: Record<ToolCallItem['status'], string> = {
  pending: '待执行',
  executing: '执行中',
  success: '成功',
  failed: '失败',
  rejected: '已取消',
};

const WRITE_TOOL_NAMES = new Set(['file_write', 'host_file_write', 'host_transfer']);

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

function describeToolOutput(toolCall: ToolCallItem): string {
  const raw = (toolCall.result || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  return raw.length > RESULT_PREVIEW_LIMIT
    ? `${raw.slice(0, RESULT_PREVIEW_LIMIT)}...`
    : raw;
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
  recent.forEach((toolCall, index) => {
    const host = toolCall.hostName ? `[${toolCall.hostName}] ` : '';
    const target = describeToolTarget(toolCall);
    const output = describeToolOutput(toolCall);
    // 非末尾步骤的失败会标注后续仍有成功步骤，避免被误判为最终未完成
    const hasLaterSuccess =
      toolCall.status === 'failed' &&
      toolCalls.slice(offset + index + 1).some((t) => t.status === 'success');
    lines.push(
      `${offset + index + 1}. ${host}${toolCall.name}${target ? ` · ${target}` : ''} · ${STATUS_LABELS[toolCall.status]}${hasLaterSuccess ? '(过程项, 后续步骤已成功)' : ''}${output ? ` · 输出: ${output}` : ''}`
    );
  });

  return lines.join('\n');
}

/**
 * 判断文本中是否已包含结构化结论报告，避免重复请求结论
 * 兼容模型可能采用的不同标题措辞与字段名，不过度收紧导致误判为「无结论」
 */
export function hasConclusionReport(content: string): boolean {
  if (!content) return false;

  // 标题形态：允许任意层级、可选修饰词
  const headingPattern =
    /#{1,6}\s*[^\n]{0,8}(执行结论|最终结论|运维结论|执行报告|任务总结|执行总结|结论|总结)/;
  if (headingPattern.test(content)) return true;

  // 字段形态：即使未使用标题，只要给出达成情况等结构化字段也视为已闭环
  const fieldPattern = /(目标达成情况|总体达成情况|整体达成情况|达成情况|最终状态|任务状态)\s*[:：]/;
  return fieldPattern.test(content);
}

/** 在正文末尾安全追加兜底结论，已存在结论时不重复追加 */
export function appendConclusionSafely(content: string, conclusion: string): string {
  const trimmed = (content || '').trim();
  if (!trimmed) return conclusion;
  if (hasConclusionReport(trimmed)) return trimmed;
  return `${trimmed}\n\n${conclusion}`;
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

  const common = `所有执行步骤与工具调用已结束。请依据下方真实执行状态，输出清晰精炼的最终结论：
1. 以整体目标是否达成、各节点最终验证状态为唯一评判依据。
2. 前置探测、分支判断、状态查询类命令返回的非零退出码属于正常判断结果，不应判定为失败。
3. 前期出现的报错或未就绪状态，只要已被后续步骤成功修复、启动、配置或同步，一律判定为已完成。
4. 仅当最终状态确实异常时才判定为异常，避免使用"未完成"等模糊表述。

真实执行状态：
${digest}`;

  if (scope === 'workspace') {
    return `${common}

请按以下格式输出：
### 最终执行结论
- 总体达成情况: [已完成 / 异常]
- 节点状态与验证: [各主机最终检查结果、服务状态或对比差异]
- 重点变更与同步: [跨机同步、脚本下发或配置变更]`;
  }

  return `${common}

请按以下格式输出：
### 执行结论
- 目标达成情况: [已完成 / 异常]
- 关键状态与验证: [最终检查结果、服务状态或端口情况]
- 重点变更说明: [配置修改或脚本部署]`;
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

  const lines = [
    '### 执行结论',
    `- 目标达成情况: ${verdict}`,
    `- 关键状态与验证: 共 ${toolCalls.length} 次调用，成功 ${success}，已取消 ${rejected}，未闭环失败 ${unresolvedFailures.length}`,
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
  if (changes.length > 0) {
    lines.push(`- 重点变更说明: ${changes.join('; ')}`);
  }

  lines.push('- 说明: 以上结论依据真实工具执行记录汇总，未做任何推测补充');
  return lines.join('\n');
}
