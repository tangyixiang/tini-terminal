import { Channel, invoke } from '@tauri-apps/api/core';
import { useAgentStore } from '../../stores/useAgentStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { AGENT_TOOLS, checkSafety, executeToolCall } from './tools';
import type { ToolCallItem } from '../../types';

let currentAbortController: AbortController | null = null;
let currentRequestId: string | null = null;

interface StreamEventPayload {
  event_type: 'chunk' | 'error' | 'done';
  data?: string;
}

async function streamChatCompletion(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onChunk: (chunkText: string) => void,
): Promise<void> {
  if (window.__TAURI_INTERNALS__) {
    const requestId = 'req-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    currentRequestId = requestId;

    return new Promise<void>((resolve, reject) => {
      const channel = new Channel<StreamEventPayload>();

      const abortHandler = () => {
        invoke('abort_ai_chat', { requestId }).catch(() => {});
        currentRequestId = null;
        resolve();
      };

      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });

      channel.onmessage = (event) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        if (event.event_type === 'chunk' && event.data) {
          onChunk(event.data);
        } else if (event.event_type === 'error') {
          signal.removeEventListener('abort', abortHandler);
          currentRequestId = null;
          reject(new Error(event.data || '大模型网络请求异常'));
        } else if (event.event_type === 'done') {
          signal.removeEventListener('abort', abortHandler);
          currentRequestId = null;
          resolve();
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
        signal.removeEventListener('abort', abortHandler);
        currentRequestId = null;
        reject(new Error(err?.toString() || '启动大模型网络请求失败'));
      });
    });
  } else {
    // 浏览器环境兜底
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
      const text = decoder.decode(value, { stream: true });
      onChunk(text);
    }
  }
}

export function abortAgentTask(): void {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  if (currentRequestId && window.__TAURI_INTERNALS__) {
    invoke('abort_ai_chat', { requestId: currentRequestId }).catch(() => {});
    currentRequestId = null;
  }
  const agentStore = useAgentStore.getState();
  if (agentStore.approvalResolver) {
    agentStore.approvalResolver(false);
  }
  agentStore.setPendingApproval(null, null);
  agentStore.setIsThinking(false);

  agentStore.updateLastMessage((m) => {
    const abortNote = '[任务已手动中止]';
    if (!m.content?.includes(abortNote)) {
      return {
        ...m,
        content: m.content ? `${m.content}\n${abortNote}` : abortNote,
      };
    }
    return m;
  });
}

export async function runAgentTask(userPrompt: string): Promise<void> {
  if (currentAbortController) {
    abortAgentTask();
  }

  const abortCtrl = new AbortController();
  currentAbortController = abortCtrl;
  const signal = abortCtrl.signal;

  const agentStore = useAgentStore.getState();
  const settingsStore = useSettingsStore.getState();
  const terminalStore = useTerminalStore.getState();

  const activeTab = terminalStore.tabs.find((t) => t.id === terminalStore.activeTabId);
  const sessionId = activeTab?.sessionId || 'local-session';

  // 1. 添加用户消息
  const userMsgId = 'msg-' + Date.now();
  agentStore.addMessage({
    id: userMsgId,
    role: 'user',
    content: userPrompt,
    timestamp: Date.now(),
  });

  agentStore.setIsThinking(true);

  // 2. 准备系统提示词与历史记录
  const systemPrompt = `你是一个专业的 Linux 运维 AI Agent 助手。
你的目标是根据用户的指令，自主分析问题、制订排错或运维计划，并调用提供的工具完成操作。
系统当前连接主机: ${activeTab ? `${activeTab.title} (Session: ${activeTab.sessionId})` : '本地终端'}
执行原则:
1. 先查看现状（如端口、进程、系统状态），不要盲目执行破坏性变更。
2. 每次工具调用前简明阐述目的，执行后根据结果继续下一步，直至达成用户目标。
3. 界面文案保持精炼专业，杜绝无意义冗长寒暄。
4. 严禁输出任何 Emoji。`;

  const conversation: any[] = [
    { role: 'system', content: systemPrompt },
  ];

  // 导入最近历史消息
  for (const m of agentStore.messages) {
    if (m.role === 'user' || m.role === 'assistant') {
      conversation.push({
        role: m.role,
        content: m.content || '',
      });
    }
  }
  conversation.push({ role: 'user', content: userPrompt });

  const aiSettings = settingsStore.settings;
  const activeProvider =
    aiSettings.providers?.find((p) => p.id === aiSettings.active_provider_id) ||
    aiSettings.providers?.[0];
  const baseUrl = (
    activeProvider?.base_url ||
    aiSettings.ai_base_url ||
    'https://api.deepseek.com/v1'
  ).replace(/\/+$/, '');
  const apiKey = activeProvider ? activeProvider.api_key : aiSettings.ai_api_key;
  const model = activeProvider?.model || aiSettings.ai_model || 'deepseek-chat';

  // 创建 Assistant 消息占位
  const assistantMsgId = 'msg-' + (Date.now() + 1);
  const toolCallItems: ToolCallItem[] = [];

  agentStore.addMessage({
    id: assistantMsgId,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    toolCalls: toolCallItems,
  });

  const maxLoops = 8;
  let loopCount = 0;

  let accumulatedThinking = '';
  let accumulatedContent = '';

  try {
    while (loopCount < maxLoops) {
      if (signal.aborted) break;
      loopCount++;

      let buffer = '';
      let loopThinking = '';
      let loopContent = '';
      const toolCallsMap: Map<number, { id: string; name: string; args: string }> = new Map();
      let isInThinkTag = false;
      const loopStartTime = Date.now();
      let thinkingDuration: number | undefined = undefined;

      const handleLines = (lines: string[]) => {
        let updated = false;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') continue;

          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            try {
              const chunk = JSON.parse(jsonStr);
              const choice = chunk.choices?.[0];
              if (!choice) continue;
              const delta = choice.delta;
              if (!delta) continue;

              // 1. 解析思考推理字段 (DeepSeek reasoning_content / reasoning / thinking)
              const reasoningChunk = delta.reasoning_content || delta.reasoning || delta.thinking;
              if (reasoningChunk) {
                loopThinking += reasoningChunk;
                updated = true;
              }

              // 2. 解析正文（同时兼容内联 <think>...</think> 标签）
              if (delta.content) {
                let remaining = delta.content;
                while (remaining.length > 0) {
                  if (!isInThinkTag) {
                    const startIdx = remaining.indexOf('<think>');
                    if (startIdx !== -1) {
                      const textBefore = remaining.slice(0, startIdx);
                      if (textBefore) {
                        loopContent += textBefore;
                        updated = true;
                      }
                      isInThinkTag = true;
                      remaining = remaining.slice(startIdx + 7);
                    } else {
                      loopContent += remaining;
                      updated = true;
                      remaining = '';
                    }
                  } else {
                    const endIdx = remaining.indexOf('</think>');
                    if (endIdx !== -1) {
                      const thinkBefore = remaining.slice(0, endIdx);
                      if (thinkBefore) {
                        loopThinking += thinkBefore;
                        updated = true;
                      }
                      isInThinkTag = false;
                      remaining = remaining.slice(endIdx + 8);
                    } else {
                      loopThinking += remaining;
                      updated = true;
                      remaining = '';
                    }
                  }
                }
              }

              // 当首个正文 token 或工具调用到达，且存在思考内容时，结算思考耗时
              if (loopThinking && (loopContent || delta.tool_calls) && !thinkingDuration) {
                thinkingDuration = Date.now() - loopStartTime;
              }

              // 3. 收集工具调用碎片
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  const item = toolCallsMap.get(idx) || { id: '', name: '', args: '' };
                  if (tc.id) item.id = tc.id;
                  if (tc.function?.name) item.name += tc.function.name;
                  if (tc.function?.arguments) item.args += tc.function.arguments;
                  toolCallsMap.set(idx, item);
                }
              }
            } catch {
              // 忽略解析非标准片段
            }
          }
        }

        if (updated) {
          const mergedThinking = accumulatedThinking
            ? (loopThinking ? `${accumulatedThinking}\n\n${loopThinking}` : accumulatedThinking)
            : loopThinking;
          const mergedContent = accumulatedContent
            ? (loopContent ? `${accumulatedContent}\n\n${loopContent}` : accumulatedContent)
            : loopContent;

          agentStore.updateLastMessage((m) => ({
            ...m,
            thinking: mergedThinking || m.thinking,
            thinkingTimeMs: thinkingDuration || m.thinkingTimeMs,
            content: mergedContent,
          }));
        }
      };

      await streamChatCompletion(
        baseUrl,
        apiKey || '',
        {
          model,
          messages: conversation,
          tools: AGENT_TOOLS,
          tool_choice: 'auto',
          temperature: 0.2,
          stream: true,
        },
        signal,
        (chunkText) => {
          buffer += chunkText;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          handleLines(lines);
        },
      );

      if (buffer.trim()) {
        handleLines([buffer.trim()]);
        buffer = '';
      }

      if (signal.aborted) break;

      if (loopThinking && !thinkingDuration) {
        thinkingDuration = Date.now() - loopStartTime;
        agentStore.updateLastMessage((m) => ({
          ...m,
          thinkingTimeMs: thinkingDuration,
        }));
      }

      if (loopThinking) {
        accumulatedThinking = accumulatedThinking
          ? `${accumulatedThinking}\n\n${loopThinking}`
          : loopThinking;
      }
      if (loopContent) {
        accumulatedContent = accumulatedContent
          ? `${accumulatedContent}\n\n${loopContent}`
          : loopContent;
      }

      // 汇总最终的 tool_calls
      const finalToolCalls = Array.from(toolCallsMap.values())
        .filter((tc) => tc.name)
        .map((tc) => ({
          id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: tc.args,
          },
        }));

      // 构建 Assistant 历史上下文记录
      const assistantMsgObj: any = {
        role: 'assistant',
        content: loopContent || null,
      };
      if (finalToolCalls.length > 0) {
        assistantMsgObj.tool_calls = finalToolCalls;
      }
      conversation.push(assistantMsgObj);

      // 如果没有工具调用，本轮 Agent 任务结束
      if (finalToolCalls.length === 0) {
        break;
      }

      // 处理工具调用
      for (const tc of finalToolCalls) {
        if (signal.aborted) break;

        const fnName = tc.function.name;
        let fnArgs: Record<string, any> = {};
        try {
          fnArgs = JSON.parse(tc.function.arguments || '{}');
        } catch {
          fnArgs = {};
        }

        const toolCallItem: ToolCallItem = {
          id: tc.id || 'tc-' + Date.now(),
          name: fnName,
          args: fnArgs,
          status: 'pending',
          riskLevel: 'safe',
        };

        // 检查安全性
        if (fnName === 'terminal_exec') {
          const safety = await checkSafety(fnArgs.command || '');
          toolCallItem.riskLevel = safety.risk_level;
          toolCallItem.warningMessage = safety.message;
        }

        toolCallItems.push(toolCallItem);
        agentStore.updateLastMessage((m) => ({
          ...m,
          toolCalls: [...toolCallItems],
        }));

        if (signal.aborted) break;

        // 权限判定
        const permMode = useAgentStore.getState().permissionMode;
        let allowed = true;

        if (permMode === 'read_only') {
          if (fnName === 'terminal_exec' || fnName === 'file_write') {
            allowed = false;
            toolCallItem.status = 'rejected';
            toolCallItem.result = '拒绝执行：当前处于只读权限模式';
          }
        } else if (permMode === 'ask' || toolCallItem.riskLevel === 'dangerous') {
          // 挂起等待用户确认
          toolCallItem.status = 'pending';
          agentStore.updateLastMessage((m) => ({
            ...m,
            toolCalls: [...toolCallItems],
          }));

          allowed = await new Promise<boolean>((resolve) => {
            agentStore.setPendingApproval(toolCallItem, resolve);
          });

          if (signal.aborted) break;

          if (!allowed) {
            toolCallItem.status = 'rejected';
            toolCallItem.result = '用户取消了本次工具执行';
          }
        }

        if (signal.aborted) break;

        if (allowed) {
          toolCallItem.status = 'executing';
          agentStore.updateLastMessage((m) => ({
            ...m,
            toolCalls: [...toolCallItems],
          }));

          const startTime = Date.now();
          const execRes = await executeToolCall(sessionId, fnName, fnArgs);
          if (signal.aborted) break;

          toolCallItem.durationMs = Date.now() - startTime;
          toolCallItem.status = execRes.isError ? 'failed' : 'success';
          toolCallItem.result = execRes.stdout;
        }

        agentStore.updateLastMessage((m) => ({
          ...m,
          toolCalls: [...toolCallItems],
        }));

        if (signal.aborted) break;

        // 反馈工具执行结果给模型
        conversation.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: toolCallItem.result || '(无输出)',
        });
      }
    }
  } catch (err: any) {
    if (signal.aborted || err.name === 'AbortError') {
      agentStore.updateLastMessage((m) => {
        const abortNote = '[任务已手动中止]';
        if (!m.content?.includes(abortNote)) {
          return {
            ...m,
            content: m.content ? `${m.content}\n${abortNote}` : abortNote,
          };
        }
        return m;
      });
    } else {
      agentStore.updateLastMessage((m) => ({
        ...m,
        content:
          (m.content ? m.content + '\n' : '') +
          `任务执行异常: ${err?.message || err}`,
      }));
    }
  } finally {
    if (currentAbortController === abortCtrl) {
      currentAbortController = null;
    }
    agentStore.setIsThinking(false);
  }
}
