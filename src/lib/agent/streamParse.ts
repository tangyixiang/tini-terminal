/**
 * 流式响应解析工具
 * 兼容三类实际返回：
 * 1. 标准 SSE (data: {...})
 * 2. 网关忽略 stream 参数时返回的普通 JSON 响应体
 * 3. 流内错误事件 ({"error": {...}})
 */

export interface ParsedToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface StreamParseResult {
  content?: string;
  reasoning?: string;
  toolCalls?: ParsedToolCallDelta[];
  finishReason?: string;
  error?: string;
}

/** 判断缓冲区内容是否为非 SSE 的普通 JSON 响应 */
export function looksLikeNonSseJson(buffer: string): boolean {
  const trimmed = buffer.trimStart();
  return trimmed.startsWith('{') && !trimmed.includes('data:');
}

/** 提取错误对象中的可读信息 */
function extractErrorMessage(error: unknown): string {
  if (!error) return '大模型返回未知错误';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const message = record.message ?? record.msg ?? record.detail;
    if (typeof message === 'string' && message.trim()) return message.trim();
    try {
      return JSON.stringify(error);
    } catch {
      return '大模型返回未知错误';
    }
  }
  return String(error);
}

function extractReasoning(obj: any): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  if (typeof obj.reasoning_content === 'string' && obj.reasoning_content) {
    return obj.reasoning_content;
  }
  if (typeof obj.reasoning === 'string' && obj.reasoning) {
    return obj.reasoning;
  }
  return undefined;
}

function extractToolCalls(rawToolCalls: any): ParsedToolCallDelta[] | undefined {
  if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) return undefined;
  return rawToolCalls.map((tc: any, idx: number) => ({
    index: typeof tc.index === 'number' ? tc.index : idx,
    id: tc.id,
    name: tc.function?.name,
    arguments:
      typeof tc.function?.arguments === 'string'
        ? tc.function.arguments
        : tc.function?.arguments != null
          ? JSON.stringify(tc.function.arguments)
          : undefined,
  }));
}

/**
 * 解析 SSE 单行 data 载荷
 * 返回 null 表示该行不含可消费的有效数据（如心跳、[DONE]）
 */
export function parseSseDataLine(line: string): StreamParseResult | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data:')) return null;

  const jsonStr = trimmed.replace(/^data:\s*/, '').trim();
  if (!jsonStr || jsonStr === '[DONE]') return null;

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  // 流内错误事件
  if (parsed?.error) {
    return { error: extractErrorMessage(parsed.error) };
  }

  const choice = parsed?.choices?.[0];
  if (!choice) return null;

  const result: StreamParseResult = {};
  const delta = choice.delta;

  if (delta) {
    const reasoning = extractReasoning(delta);
    if (reasoning) result.reasoning = reasoning;
    if (typeof delta.content === 'string' && delta.content) {
      result.content = delta.content;
    }
    const toolCalls = extractToolCalls(delta.tool_calls);
    if (toolCalls) result.toolCalls = toolCalls;
  }

  // 部分实现把非流式结果按 choices[0].message 返回
  if (!delta && choice.message) {
    const reasoning = extractReasoning(choice.message);
    if (reasoning) result.reasoning = reasoning;
    if (typeof choice.message.content === 'string' && choice.message.content) {
      result.content = choice.message.content;
    }
    const toolCalls = extractToolCalls(choice.message.tool_calls);
    if (toolCalls) result.toolCalls = toolCalls;
  }

  if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
    result.finishReason = choice.finish_reason;
  }

  if (Object.keys(result).length === 0) return null;
  return result;
}

/**
 * 解析非 SSE 的完整 JSON 响应体
 * 若响应体本身携带错误，或模型返回了完整 message（含 tool_calls），则一次给出结果
 */
export function parseNonSseBody(body: string): StreamParseResult | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 非 JSON 且非 SSE，按原始文本错误上报，避免静默丢失
    return { error: trimmed.slice(0, 500) };
  }

  if (parsed?.error) {
    return { error: extractErrorMessage(parsed.error) };
  }

  const choice = parsed?.choices?.[0];
  if (!choice) {
    return { error: `大模型返回了无法识别的响应: ${trimmed.slice(0, 300)}` };
  }

  const result: StreamParseResult = {};
  const message = choice.message;
  if (message) {
    const reasoning = extractReasoning(message);
    if (reasoning) result.reasoning = reasoning;
    if (typeof message.content === 'string' && message.content) {
      result.content = message.content;
    }
    const toolCalls = extractToolCalls(message.tool_calls);
    if (toolCalls) result.toolCalls = toolCalls;
  }
  if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
    result.finishReason = choice.finish_reason;
  }
  return result;
}

/** 依据 finish_reason 生成需要向用户明示的提示，避免静默截断 */
export function describeFinishReason(reason?: string): string | null {
  switch (reason) {
    case 'length':
      return '> 模型输出已达长度上限被截断，如需完整结果请缩小任务范围或分步执行。';
    case 'content_filter':
      return '> 模型输出被内容安全策略拦截，本次未获得完整结果。';
    case 'insufficient_system_resource':
      return '> 模型服务端资源不足，输出被中断，请稍后重试。';
    default:
      return null;
  }
}
