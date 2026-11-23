import { Channel, invoke } from '@tauri-apps/api/core';
import { CONCLUSION_RETRY_TIMES, STREAM_FLUSH_INTERVAL_MS } from './constants';
import {
  describeFinishReason,
  looksLikeNonSseJson,
  parseNonSseBody,
  parseSseDataLine,
} from './streamParse';
import {
  buildConclusionMessages,
  buildConclusionPrompt,
  dropIncompleteConclusion,
  flushThinkTag,
  isConclusionComplete,
  isTrailingConclusionComplete,
  parseThinkTag,
  type ThinkParseState,
} from './summary';
import type { ToolCallItem } from '../../types';

interface StreamEventPayload {
  event_type: 'chunk' | 'error' | 'done';
  data?: string;
}

const activeRequestIds: Record<string, string> = {};

/** 主动中止指定会话/工作区当前进行中的模型 HTTP 流 */
export function abortActiveStreamRequest(scopeKey: string): void {
  const reqId = activeRequestIds[scopeKey];
  if (reqId && window.__TAURI_INTERNALS__) {
    invoke('abort_ai_chat', { requestId: reqId }).catch(() => {});
  }
  delete activeRequestIds[scopeKey];
}

export async function streamChatCompletion(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onChunk: (chunkText: string) => void,
  scopeKey?: string
): Promise<void> {
  if (window.__TAURI_INTERNALS__) {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    if (scopeKey) activeRequestIds[scopeKey] = requestId;

    return new Promise<void>((resolve, reject) => {
      const channel = new Channel<StreamEventPayload>();
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abortHandler);
        if (scopeKey && activeRequestIds[scopeKey] === requestId) {
          delete activeRequestIds[scopeKey];
        }
        fn();
      };

      const abortHandler = () => {
        invoke('abort_ai_chat', { requestId }).catch(() => {});
        settle(resolve);
      };

      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });

      channel.onmessage = (event) => {
        if (settled) return;
        if (signal.aborted) {
          settle(resolve);
          return;
        }
        if (event.event_type === 'chunk' && event.data) {
          try {
            onChunk(event.data);
          } catch (err: any) {
            invoke('abort_ai_chat', { requestId }).catch(() => {});
            settle(() => reject(err instanceof Error ? err : new Error(String(err))));
          }
        } else if (event.event_type === 'error') {
          settle(() => reject(new Error(event.data || '大模型网络请求异常')));
        } else if (event.event_type === 'done') {
          settle(resolve);
        }
      };

      invoke('stream_ai_chat', {
        req: {
          request_id: requestId,
          base_url: baseUrl,
          api_key: apiKey || '',
          body,
        },
        channel,
      }).catch((err) => {
        settle(() => reject(new Error(err?.toString() || '启动大模型网络请求失败')));
      });
    });
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM API 响应错误 (HTTP ${res.status}): ${errText}`);
  }
  if (!res.body) {
    throw new Error('未获取到流式响应数据主体');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  while (true) {
    if (signal.aborted) {
      reader.cancel().catch(() => {});
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true }));
  }
}

export interface ParsedFinalToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LlmTurnResult {
  loopThinking: string;
  loopContent: string;
  thinkingDuration?: number;
  finishReason?: string;
  toolCalls: ParsedFinalToolCall[];
}

/**
 * 裁剪超长上下文，保留 system prompt 与最新消息，压缩早期过长工具输出防止超窗报错
 */
export function trimConversationForBudget(conversation: any[], maxChars = 64000): any[] {
  const estimateLen = (list: any[]) =>
    list.reduce((sum, m) => {
      const c = typeof m.content === 'string' ? m.content.length : 0;
      const tc = m.tool_calls ? JSON.stringify(m.tool_calls).length : 0;
      return sum + c + tc;
    }, 0);

  if (estimateLen(conversation) <= maxChars) return conversation;

  const cloned = conversation.map((m) => ({ ...m }));
  // 第一阶段：把早期 tool 消息（保留最后 4 条完整）压缩到 800 字符
  let toolSeenFromEnd = 0;
  for (let i = cloned.length - 1; i >= 1; i--) {
    if (cloned[i].role === 'tool') {
      toolSeenFromEnd++;
      if (toolSeenFromEnd > 4 && typeof cloned[i].content === 'string' && cloned[i].content.length > 800) {
        cloned[i].content = `${cloned[i].content.slice(0, 600)}\n[... 早期输出已压缩 ...]\n${cloned[i].content.slice(-150)}`;
      }
    }
  }
  if (estimateLen(cloned) <= maxChars) return cloned;

  // 第二阶段：从最早的非 system 消息按完整轮次淘汰，确保不留下孤立的 tool 消息
  const result = [cloned[0]];
  let tail = cloned.slice(1);
  while (tail.length > 4 && estimateLen([result[0], ...tail]) > maxChars) {
    tail.shift();
    while (tail.length > 2 && tail[0].role === 'tool') {
      tail.shift();
    }
  }
  return [result[0], ...tail];
}

/**
 * 执行单轮模型流式调用（兼容 SSE 与非 SSE JSON 网关，处理 <think> 标签及尾部残片）
 */
export async function executeLlmTurn(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: any[];
  tools?: any[];
  signal: AbortSignal;
  scopeKey: string;
  accumulatedThinking: string;
  accumulatedContent: string;
  onUpdate: (patch: { thinking?: string; thinkingTimeMs?: number; content: string }) => void;
}): Promise<LlmTurnResult> {
  const {
    baseUrl,
    apiKey,
    model,
    messages,
    tools,
    signal,
    scopeKey,
    accumulatedThinking,
    accumulatedContent,
    onUpdate,
  } = options;

  let buffer = '';
  let loopThinking = '';
  let loopContent = '';
  const toolCallsMap: Map<number, { id: string; name: string; args: string }> = new Map();
  let thinkState: ThinkParseState = { inThink: false, pending: '' };
  let lastFinishReason: string | undefined;
  let sawAnyChunk = false;
  const loopStartTime = Date.now();
  let thinkingDuration: number | undefined;
  let lastFlushAt = 0;
  let pendingFlush: (() => void) | null = null;

  const flushPending = () => {
    if (pendingFlush) {
      pendingFlush();
      pendingFlush = null;
    }
  };

  const applyParsed = (parsed: {
    reasoning?: string;
    content?: string;
    toolCalls?: { index: number; id?: string; name?: string; arguments?: string }[];
    finishReason?: string;
    error?: string;
  }): boolean => {
    if (parsed.error) {
      throw new Error(parsed.error);
    }
    let updated = false;
    if (parsed.reasoning) {
      loopThinking += parsed.reasoning;
      updated = true;
    }
    if (parsed.content) {
      const parsedThink = parseThinkTag(parsed.content, thinkState);
      thinkState = parsedThink.state;
      if (parsedThink.thinking) {
        loopThinking += parsedThink.thinking;
        thinkingDuration = Date.now() - loopStartTime;
      }
      if (parsedThink.content) {
        loopContent += parsedThink.content;
      }
      updated = true;
    }
    if (parsed.toolCalls) {
      for (const tc of parsed.toolCalls) {
        const index = tc.index ?? 0;
        const existing = toolCallsMap.get(index) || { id: '', name: '', args: '' };
        if (tc.id) existing.id = tc.id;
        if (tc.name) existing.name += tc.name;
        if (tc.arguments) existing.args += tc.arguments;
        toolCallsMap.set(index, existing);
      }
      updated = true;
    }
    if (parsed.finishReason) {
      lastFinishReason = parsed.finishReason;
    }
    return updated;
  };

  const emitProgress = (immediate = false) => {
    const mergedThinking = accumulatedThinking
      ? loopThinking
        ? `${accumulatedThinking}\n\n${loopThinking}`
        : accumulatedThinking
      : loopThinking;
    const mergedContent = accumulatedContent
      ? loopContent
        ? `${accumulatedContent}\n\n${loopContent}`
        : accumulatedContent
      : loopContent;

    const doFlush = () => {
      onUpdate({
        thinking: mergedThinking || undefined,
        thinkingTimeMs: thinkingDuration,
        content: mergedContent,
      });
    };

    const now = Date.now();
    if (immediate || now - lastFlushAt >= STREAM_FLUSH_INTERVAL_MS) {
      lastFlushAt = now;
      pendingFlush = null;
      doFlush();
    } else {
      pendingFlush = doFlush;
    }
  };

  const handleLines = (lines: string[]) => {
    let updated = false;
    for (const line of lines) {
      const parsed = parseSseDataLine(line);
      if (!parsed) continue;
      if (applyParsed(parsed)) updated = true;
    }
    if (updated) emitProgress(false);
  };

  const requestBody: Record<string, unknown> = {
    model,
    messages: trimConversationForBudget(messages),
    temperature: 0.2,
    stream: true,
  };
  if (tools && tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = 'auto';
  }

  await streamChatCompletion(
    baseUrl,
    apiKey,
    requestBody,
    signal,
    (chunkText) => {
      buffer += chunkText;
      if (!sawAnyChunk && looksLikeNonSseJson(buffer)) {
        return;
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      if (lines.some((line) => line.trim().startsWith('data:'))) {
        sawAnyChunk = true;
      }
      handleLines(lines);
    },
    scopeKey
  );

  // 非 SSE 完整 JSON 响应处理（包含 tool_calls）
  if (!sawAnyChunk && buffer.trim()) {
    const wholeBody = parseNonSseBody(buffer);
    buffer = '';
    if (wholeBody) {
      applyParsed(wholeBody);
    }
  } else if (buffer.trim()) {
    handleLines([buffer.trim()]);
    buffer = '';
  }

  // 刷出未闭合的 <think> 标签残片，避免丢字
  const flushed = flushThinkTag(thinkState);
  if (flushed.thinking) loopThinking += flushed.thinking;
  if (flushed.content) loopContent += flushed.content;

  if (loopThinking && !thinkingDuration) {
    thinkingDuration = Date.now() - loopStartTime;
  }

  flushPending();
  emitProgress(true);

  const finalToolCalls: ParsedFinalToolCall[] = Array.from(toolCallsMap.values())
    .filter((tc) => tc.name)
    .map((tc) => ({
      id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type: 'function' as const,
      function: {
        name: tc.name,
        arguments: tc.args,
      },
    }));

  return {
    loopThinking,
    loopContent,
    thinkingDuration,
    finishReason: lastFinishReason,
    toolCalls: finalToolCalls,
  };
}

/**
 * 仅在模型未产出有效总结或被服务端截断时发起补充总结请求
 * 每次重试使用全新的 thinkState，且完整兼容非 SSE 网关与严格角色交替约束
 */
export async function requestStructuredConclusion(options: {
  scope: 'session' | 'workspace';
  baseUrl: string;
  apiKey: string;
  model: string;
  conversation: any[];
  toolCallItems: ToolCallItem[];
  accumulatedThinking: string;
  accumulatedContent: string;
  signal: AbortSignal;
  scopeKey: string;
  onUpdate: (patch: { thinking?: string; content: string }) => void;
}): Promise<{ reportContent: string; finishNote: string }> {
  const {
    scope,
    baseUrl,
    apiKey,
    model,
    conversation,
    toolCallItems,
    accumulatedThinking,
    accumulatedContent,
    signal,
    scopeKey,
    onUpdate,
  } = options;

  const conclusionPrompt = buildConclusionPrompt(scope, toolCallItems);
  const conclusionMessages = buildConclusionMessages(conversation, conclusionPrompt);
  const conclusionBase = isTrailingConclusionComplete(accumulatedContent)
    ? accumulatedContent
    : dropIncompleteConclusion(accumulatedContent);

  let reportContent = '';
  let finishNote = '';

  for (let attempt = 0; attempt <= CONCLUSION_RETRY_TIMES; attempt++) {
    if (signal.aborted) break;

    let attemptThinking = '';
    let attemptContent = '';
    let summaryBuffer = '';
    let summaryFinishReason: string | undefined;
    let sawSse = false;
    // 每次重试重置独立的 thinkState，杜绝上一次未闭合 <think> 污染本次输出
    let thinkState: ThinkParseState = { inThink: false, pending: '' };

    const applyAttemptResult = (parsed: {
      reasoning?: string;
      content?: string;
      finishReason?: string;
      error?: string;
    }) => {
      if (parsed.error) throw new Error(parsed.error);
      if (parsed.reasoning) attemptThinking += parsed.reasoning;
      if (parsed.content) {
        const parsedThink = parseThinkTag(parsed.content, thinkState);
        thinkState = parsedThink.state;
        attemptThinking += parsedThink.thinking;
        attemptContent += parsedThink.content;
      }
      if (parsed.finishReason) summaryFinishReason = parsed.finishReason;

      if (attemptContent.trim()) {
        const mergedThinking = accumulatedThinking
          ? attemptThinking
            ? `${accumulatedThinking}\n\n${attemptThinking}`
            : accumulatedThinking
          : attemptThinking;
        const mergedContent = conclusionBase
          ? `${conclusionBase}\n\n${attemptContent}`.trim()
          : attemptContent;
        onUpdate({
          thinking: mergedThinking || undefined,
          content: mergedContent,
        });
      }
    };

    try {
      await streamChatCompletion(
        baseUrl,
        apiKey,
        {
          model,
          messages: trimConversationForBudget(conclusionMessages),
          temperature: 0.2,
          stream: true,
        },
        signal,
        (chunkText) => {
          summaryBuffer += chunkText;
          if (!sawSse && looksLikeNonSseJson(summaryBuffer)) return;
          const lines = summaryBuffer.split('\n');
          summaryBuffer = lines.pop() || '';
          if (lines.some((l) => l.trim().startsWith('data:'))) sawSse = true;
          for (const line of lines) {
            const parsed = parseSseDataLine(line);
            if (parsed) applyAttemptResult(parsed);
          }
        },
        scopeKey
      );

      if (!sawSse && summaryBuffer.trim()) {
        const whole = parseNonSseBody(summaryBuffer);
        if (whole) applyAttemptResult(whole);
      } else if (summaryBuffer.trim()) {
        const parsed = parseSseDataLine(summaryBuffer.trim());
        if (parsed) applyAttemptResult(parsed);
      }

      const flushed = flushThinkTag(thinkState);
      if (flushed.thinking) attemptThinking += flushed.thinking;
      if (flushed.content) attemptContent += flushed.content;
    } catch (err: any) {
      if (signal.aborted) break;
      if (attempt === CONCLUSION_RETRY_TIMES) {
        finishNote = `> 结论请求失败: ${err?.message || err}`;
      }
      continue;
    }

    if (signal.aborted) break;

    const attemptTruncated =
      summaryFinishReason === 'length' || summaryFinishReason === 'content_filter';
    const attemptComplete = isConclusionComplete(attemptContent, {
      truncated: attemptTruncated,
    });

    if (attemptContent.trim()) {
      reportContent = attemptContent.trim();
      const retryNote = describeFinishReason(summaryFinishReason);
      if (retryNote && !attemptComplete) {
        finishNote = retryNote;
      }
    }
    if (attemptComplete) break;
  }

  return { reportContent, finishNote };
}
