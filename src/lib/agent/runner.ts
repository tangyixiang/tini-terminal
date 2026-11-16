import { Channel, invoke } from '@tauri-apps/api/core';
import { useAgentStore } from '../../stores/useAgentStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { AGENT_TOOLS, checkSafety, executeToolCall } from './tools';
import { isReadOnlyCommand, truncateToolResult } from './commandUtils';
import { resolveAiRuntime, validateAiRuntime } from '../aiProviders';
import {
  CONCLUSION_RETRY_TIMES,
  HISTORY_MESSAGE_LIMIT,
  MAX_AGENT_LOOPS,
  STREAM_FLUSH_INTERVAL_MS,
} from './constants';
import {
  describeFinishReason,
  looksLikeNonSseJson,
  parseNonSseBody,
  parseSseDataLine,
} from './streamParse';
import {
  appendConclusionSafely,
  buildConclusionMessages,
  buildConclusionPrompt,
  buildDeterministicConclusion,
  buildHistoryToolResult,
  hasConclusionReport,
  parseThinkTag,
  sanitizeHistoryContent,
} from './summary';
import type { ToolCallItem } from '../../types';

const abortControllers: Record<string, AbortController> = {};
const currentRequestIds: Record<string, string> = {};

/** 判断指定会话是否存在进行中的任务 */
export function isAgentTaskRunning(tabId: string): boolean {
  return Boolean(abortControllers[tabId]);
}

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
  tabId?: string,
): Promise<void> {
  if (window.__TAURI_INTERNALS__) {
    const requestId = 'req-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    if (tabId) currentRequestIds[tabId] = requestId;

    return new Promise<void>((resolve, reject) => {
      const channel = new Channel<StreamEventPayload>();
      // 保证 Promise 只被结算一次，避免解析异常后再被 done 事件覆盖
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abortHandler);
        if (tabId) delete currentRequestIds[tabId];
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
          // 解析阶段抛出的错误必须转成 Promise 拒绝，否则上层会永久挂起
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

export function abortAgentTask(targetTabId?: string): void {
  const terminalStore = useTerminalStore.getState();
  const tabId = targetTabId || terminalStore.activeTabId;

  if (!tabId) return;

  const ctrl = abortControllers[tabId];
  if (ctrl) {
    ctrl.abort();
    delete abortControllers[tabId];
  }

  const reqId = currentRequestIds[tabId];
  if (reqId && window.__TAURI_INTERNALS__) {
    invoke('abort_ai_chat', { requestId: reqId }).catch(() => {});
    delete currentRequestIds[tabId];
  }

  const agentStore = useAgentStore.getState();
  const session = agentStore.getSessionState(tabId);
  if (session.approvalResolver) {
    session.approvalResolver(false);
  }
  agentStore.setPendingApproval(tabId, null, null);
  agentStore.setIsThinking(tabId, false);

  agentStore.updateLastMessage(tabId, (m) => {
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



export async function runAgentTask(userPrompt: string, targetTabId?: string): Promise<void> {
  const terminalStore = useTerminalStore.getState();
  const tabId = targetTabId || terminalStore.activeTabId;

  // 无有效终端会话时拒绝执行，避免多个调用共用兜底键导致中止错乱
  if (!tabId) {
    return;
  }

  if (abortControllers[tabId]) {
    abortAgentTask(tabId);
  }

  const abortCtrl = new AbortController();
  abortControllers[tabId] = abortCtrl;
  const signal = abortCtrl.signal;

  const agentStore = useAgentStore.getState();
  const settingsStore = useSettingsStore.getState();

  const activeTab = terminalStore.tabs.find((t) => t.id === tabId);
  if (!activeTab) {
    delete abortControllers[tabId];
    return;
  }
  const sessionId = activeTab.sessionId;

  // 1. 获取该会话专属历史消息（最多保留最近若干条）
  const sessionState = agentStore.getSessionState(tabId);
  const historyMessages = sessionState.messages.slice(-HISTORY_MESSAGE_LIMIT);

  // 2. 添加用户消息到当前会话
  const userMsgId = 'msg-' + Date.now();
  agentStore.addMessage(tabId, {
    id: userMsgId,
    role: 'user',
    content: userPrompt,
    timestamp: Date.now(),
  });

  agentStore.setIsThinking(tabId, true);

  // 3. 准备系统提示词与历史记录
  const systemPrompt = `你是一名专业的 Linux 运维与 SRE 智能体，具备完整的工具调用与执行能力。
当前连接主机：${activeTab ? `${activeTab.title}（会话 ${activeTab.sessionId}）` : '本地终端'}

执行准则：
1. 真实执行，不允许口头承诺
   - 环境探测、状态排查、服务操作必须通过 terminal_exec、file_read、file_list、system_info 实际调用。
   - 脚本与配置文件必须通过 file_write 写入目标路径，不能只在回复文本中展示代码就视为已部署。
2. 脚本编写方式
   - 不要在 terminal_exec 中拼接超长多行文本或复杂的 heredoc，容易引出转义与语法问题。
   - 推荐做法：先用 file_write 写入完整脚本到绝对路径（如 /usr/local/bin/xxx），再用 terminal_exec 执行 chmod +x 并运行。
3. 闭环验证
   - 部署、重启或配置变更后，必须再调用 terminal_exec 验证最终状态（如 docker ps、ss -lntp、systemctl status、curl），确认生效后再向用户汇报。
4. 表达风格
   - 直接给结论与关键事实，省略过程性叙述和客套话。
   - 不使用 Emoji。
5. 必须给出最终结论
   - 所有工具调用结束后，必须在回复正文中给出结构化结论，格式如下：
### 执行结论
- 目标达成情况: [已完成 / 异常]
- 关键状态与验证: [最终检查结果、服务状态或端口情况]
- 重点变更说明: [配置修改或脚本部署]
   - 不允许只调用工具而无任何文字结论，也不允许空回复。
6. 以最终状态判定成败
   - 判断依据是业务目标和最终验证状态，而非中间过程。
   - 前置探测、条件判断类命令（grep、test、[ ]、pidof、which、diff、systemctl is-active 等）返回非零退出码属于正常结果，不代表失败。
   - 中间出现的报错若已被后续步骤修复或成功绕过，应判定为已完成；不要因为过程曲折就写成"任务未完成"或"操作失败"。
   - 确实异常时，需要指明是哪一项最终验证未达标，避免使用笼统表述。`;

  const conversation: any[] = [
    { role: 'system', content: systemPrompt },
  ];

  // 导入最近历史消息
  for (const m of historyMessages) {
    if (m.role === 'user') {
      if (m.content) {
        conversation.push({ role: 'user', content: m.content });
      }
    } else if (m.role === 'assistant') {
      // 中止标记属于历史痕迹，不得进入模型上下文，避免复述为"未完成"
      const historyText = sanitizeHistoryContent(m.content);
      if (m.toolCalls && m.toolCalls.length > 0) {
        const validCalls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args || {}),
          },
        }));
        conversation.push({
          role: 'assistant',
          content: historyText || null,
          tool_calls: validCalls,
        });
        for (const tc of m.toolCalls) {
          conversation.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: buildHistoryToolResult(tc),
          });
        }
      } else if (historyText) {
        conversation.push({
          role: 'assistant',
          content: historyText,
        });
      }
    }
  }

  // 追加当前用户提示词
  conversation.push({ role: 'user', content: userPrompt });

  const runtime = resolveAiRuntime(settingsStore.settings);
  const baseUrl = runtime.baseUrl;
  const apiKey = runtime.apiKey;
  const model = runtime.model;

  // 创建 Assistant 消息占位
  const assistantMsgId = 'msg-' + (Date.now() + 1);
  const toolCallItems: ToolCallItem[] = [];

  agentStore.addMessage(tabId, {
    id: assistantMsgId,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    toolCalls: toolCallItems,
  });

  // 模型未配置完整时直接给出明确配置提示，不再用厂商默认值静默兜底
  const configError = validateAiRuntime(runtime);
  if (configError) {
    agentStore.updateLastMessage(tabId, (m) => ({ ...m, content: configError }));
    agentStore.setIsThinking(tabId, false);
    delete abortControllers[tabId];
    return;
  }

  const maxLoops = MAX_AGENT_LOOPS;
  let loopCount = 0;

  let accumulatedThinking = '';
  let accumulatedContent = '';
  // 每次工具执行完毕后重置结论基线，确保只认最近一次执行之后的结论文本
  let conclusionBaseline = 0;
  const hasFreshConclusion = () =>
    hasConclusionReport(accumulatedContent.slice(conclusionBaseline));

  try {
    while (loopCount < maxLoops) {
      if (signal.aborted) break;
      loopCount++;

      let buffer = '';
      let loopThinking = '';
      let loopContent = '';
      const toolCallsMap: Map<number, { id: string; name: string; args: string }> = new Map();
      let thinkState: { inThink: boolean; pending: string } = { inThink: false, pending: '' };
      let lastFinishReason: string | undefined;
      let sawAnyChunk = false;
      const loopStartTime = Date.now();
      let thinkingDuration: number | undefined = undefined;
      // 流式刷新节流状态
      let lastFlushAt = 0;
      let pendingFlush: (() => void) | null = null;
      const flushPending = () => {
        if (pendingFlush) {
          pendingFlush();
          pendingFlush = null;
        }
      };

      const handleLines = (lines: string[]) => {
        let updated = false;
        let streamError: string | null = null;

        for (const line of lines) {
          const parsedLine = parseSseDataLine(line);
          if (!parsedLine) continue;

          if (parsedLine.error) {
            streamError = parsedLine.error;
            continue;
          }

          if (parsedLine.reasoning) {
            loopThinking += parsedLine.reasoning;
            updated = true;
          }

          if (parsedLine.content) {
            const parsedThink = parseThinkTag(parsedLine.content, thinkState);
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

          if (parsedLine.toolCalls) {
            for (const tc of parsedLine.toolCalls) {
              const index = tc.index ?? 0;
              const existing = toolCallsMap.get(index) || { id: '', name: '', args: '' };
              if (tc.id) existing.id = tc.id;
              if (tc.name) existing.name += tc.name;
              if (tc.arguments) existing.args += tc.arguments;
              toolCallsMap.set(index, existing);
            }
            updated = true;
          }

          if (parsedLine.finishReason) {
            lastFinishReason = parsedLine.finishReason;
          }
        }

        if (streamError) {
          throw new Error(streamError);
        }

        if (updated) {
          const mergedThinking = accumulatedThinking
            ? (loopThinking ? `${accumulatedThinking}\n\n${loopThinking}` : accumulatedThinking)
            : loopThinking;
          const mergedContent = accumulatedContent
            ? (loopContent ? `${accumulatedContent}\n\n${loopContent}` : accumulatedContent)
            : loopContent;

          // 流式高频刷新做节流，避免每个 token 都复制整个消息数组导致卡顿
          const now = Date.now();
          const shouldFlush = now - lastFlushAt >= STREAM_FLUSH_INTERVAL_MS;
          if (shouldFlush) {
            lastFlushAt = now;
            agentStore.updateLastMessage(tabId, (m) => ({
              ...m,
              thinking: mergedThinking || m.thinking,
              thinkingTimeMs: thinkingDuration || m.thinkingTimeMs,
              content: mergedContent,
            }));
          } else {
            pendingFlush = () => {
              agentStore.updateLastMessage(tabId, (m) => ({
                ...m,
                thinking: mergedThinking || m.thinking,
                thinkingTimeMs: thinkingDuration || m.thinkingTimeMs,
                content: mergedContent,
              }));
            };
          }
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
          // 兼容网关忽略 stream 参数、直接返回完整 JSON 的情形
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
        tabId,
      );

      // 非 SSE 完整响应：一次性解析，避免静默丢弃
      if (!sawAnyChunk && buffer.trim()) {
        const wholeBody = parseNonSseBody(buffer);
        buffer = '';
        if (wholeBody?.error) {
          throw new Error(wholeBody.error);
        }
        if (wholeBody) {
          if (wholeBody.reasoning) loopThinking += wholeBody.reasoning;
          if (wholeBody.content) {
            const parsedThink = parseThinkTag(wholeBody.content, thinkState);
            thinkState = parsedThink.state;
            loopThinking += parsedThink.thinking;
            loopContent += parsedThink.content;
          }
          if (wholeBody.finishReason) lastFinishReason = wholeBody.finishReason;
        }
        const mergedThinking = accumulatedThinking
          ? `${accumulatedThinking}\n\n${loopThinking}`.trim()
          : loopThinking;
        const mergedContent = accumulatedContent
          ? `${accumulatedContent}\n\n${loopContent}`.trim()
          : loopContent;
        agentStore.updateLastMessage(tabId, (m) => ({
          ...m,
          thinking: mergedThinking || m.thinking,
          content: mergedContent,
        }));
      } else if (buffer.trim()) {
        handleLines([buffer.trim()]);
        buffer = '';
      }

      // 流式结束前落地最后一次未刷新的增量
      flushPending();

      if (signal.aborted) break;

      if (loopThinking && !thinkingDuration) {
        thinkingDuration = Date.now() - loopStartTime;
        agentStore.updateLastMessage(tabId, (m) => ({
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

      // 输出被截断/被拦截必须明示，避免用户误以为任务正常结束
      const finishNote = describeFinishReason(lastFinishReason);
      if (finishNote) {
        accumulatedContent = accumulatedContent.trim()
          ? `${accumulatedContent.trim()}\n\n${finishNote}`
          : finishNote;
        agentStore.updateLastMessage(tabId, (m) => ({
          ...m,
          content: accumulatedContent,
        }));
      }

      // 结论阶段的流式累积：结果同样实时呈现，异常不再被静默吞掉
      const collectConclusionLine = (
        lines: string[],
        onFinish: (reason: string) => void
      ): string | null => {
        let latestFinish: string | null = null;
        let updated = false;

        for (const line of lines) {
          const parsedLine = parseSseDataLine(line);
          if (!parsedLine) continue;
          if (parsedLine.error) {
            throw new Error(parsedLine.error);
          }
          if (parsedLine.reasoning) {
            loopThinking += parsedLine.reasoning;
            updated = true;
          }
          if (parsedLine.content) {
            const parsedThink = parseThinkTag(parsedLine.content, thinkState);
            thinkState = parsedThink.state;
            loopThinking += parsedThink.thinking;
            loopContent += parsedThink.content;
            updated = true;
          }
          if (parsedLine.finishReason) {
            latestFinish = parsedLine.finishReason;
            onFinish(parsedLine.finishReason);
          }
        }

        if (updated) {
          const mergedThinking = accumulatedThinking
            ? `${accumulatedThinking}\n\n${loopThinking}`.trim()
            : loopThinking;
          const mergedContent = accumulatedContent
            ? `${accumulatedContent}\n\n${loopContent}`.trim()
            : loopContent;
          agentStore.updateLastMessage(tabId, (m) => ({
            ...m,
            thinking: mergedThinking || m.thinking,
            content: mergedContent,
          }));
        }

        return latestFinish;
      };

      if (finalToolCalls.length === 0) {
        // 无更多工具调用
        // 已执行过工具但尚未产出结构化结论时，补齐上下文并显式请求模型输出最终结论报告
        if (
          toolCallItems.length > 0 &&
          !signal.aborted &&
          !hasFreshConclusion()
        ) {
          // 结论请求基于独立消息序列构造，不改动原对话上下文
          const conclusionPrompt = buildConclusionPrompt('session', toolCallItems);
          loopThinking = '';
          loopContent = '';
          thinkState = { inThink: false, pending: '' };

          for (let attempt = 0; attempt <= CONCLUSION_RETRY_TIMES; attempt++) {
            let summaryBuffer = '';
            let summaryFinishReason: string | undefined;
            try {
              await streamChatCompletion(
                baseUrl,
                apiKey || '',
                {
                  model,
                  messages: buildConclusionMessages(conversation, conclusionPrompt),
                  temperature: 0.2,
                  stream: true,
                },
                signal,
                (chunkText) => {
                  summaryBuffer += chunkText;
                  const lines = summaryBuffer.split('\n');
                  summaryBuffer = lines.pop() || '';
                  const finish = collectConclusionLine(lines, (reason) => {
                    summaryFinishReason = reason;
                  });
                  if (finish) summaryFinishReason = finish;
                },
                tabId
              );
              if (summaryBuffer.trim()) {
                const finish = collectConclusionLine([summaryBuffer.trim()], (reason) => {
                  summaryFinishReason = reason;
                });
                if (finish) summaryFinishReason = finish;
              }
              flushPending();
            } catch (err: any) {
              if (signal.aborted) break;
              // 最后一次重试仍失败才交由确定性兜底，避免静默无结论
              if (attempt === CONCLUSION_RETRY_TIMES) {
                loopContent += `\n\n> 结论请求失败: ${err?.message || err}`;
              }
              continue;
            }

            if (signal.aborted) break;

            const retryNote = describeFinishReason(summaryFinishReason);
            if (retryNote) {
              loopContent += `\n\n${retryNote}`;
            }
            if (loopContent.trim() || hasConclusionReport(loopContent)) break;
          }

          if (loopContent.trim()) {
            accumulatedContent = accumulatedContent.trim()
              ? `${accumulatedContent.trim()}\n\n${loopContent.trim()}`
              : loopContent.trim();
            // 重置基线，使本段结论文本参与后续判定
            agentStore.updateLastMessage(tabId, (m) => ({
              ...m,
              content: accumulatedContent,
            }));
          }
        }

        // 兜底闭环：模型未产出结构化结论时，基于真实执行状态生成结论，杜绝静默空答
        if (
          !signal.aborted &&
          toolCallItems.length > 0 &&
          !hasFreshConclusion()
        ) {
          const fallback = buildDeterministicConclusion(toolCallItems);
          accumulatedContent = appendConclusionSafely(accumulatedContent, fallback);
          agentStore.updateLastMessage(tabId, (m) => ({
            ...m,
            content: accumulatedContent,
          }));
        } else if (!signal.aborted && toolCallItems.length === 0 && !accumulatedContent.trim()) {
          // 模型未返回任何文本且未调用工具时明确呈现真实状态，避免空白消息
          agentStore.updateLastMessage(tabId, (m) => ({
            ...m,
            content: '模型未返回任何内容，请重试或检查模型配置。',
          }));
        }
        break;
      }

      // 追加 Assistant 的调用意图至上下文
      conversation.push({
        role: 'assistant',
        content: loopContent || null,
        tool_calls: finalToolCalls,
      });

      // 逐个执行工具调用
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
          const safety = await checkSafety(
            fnArgs.command || '',
            settingsStore.settings.danger_level
          );
          toolCallItem.riskLevel = safety.risk_level;
          toolCallItem.warningMessage = safety.message;
        }

        toolCallItems.push(toolCallItem);
        agentStore.updateLastMessage(tabId, (m) => ({
          ...m,
          toolCalls: [...toolCallItems],
        }));

        if (signal.aborted) break;

        // 权限判定
        const permMode = useAgentStore.getState().permissionMode;
        let allowed = true;

        if (permMode === 'read_only') {
          if (fnName === 'file_write') {
            allowed = false;
            toolCallItem.status = 'rejected';
            toolCallItem.result = '拒绝执行：当前处于只读权限模式';
          } else if (fnName === 'terminal_exec' && !isReadOnlyCommand(fnArgs.command || '')) {
            allowed = false;
            toolCallItem.status = 'rejected';
            toolCallItem.result = '拒绝执行：当前处于只读权限模式，不可执行状态修改指令';
          }
        } else {
          let needsApproval = false;

          if (toolCallItem.riskLevel === 'dangerous') {
            needsApproval = true;
          } else if (permMode === 'full') {
            needsApproval = false;
          } else {
            // 需确认模式 (ask)：写操作与高风险命令需人工确认，只读探测自主放行
            if (fnName === 'file_write') {
              needsApproval = true;
            } else if (fnName === 'terminal_exec') {
              if (toolCallItem.riskLevel === 'warning' || !isReadOnlyCommand(fnArgs.command || '')) {
                needsApproval = true;
              }
            }
          }

          if (needsApproval) {
            // 挂起等待用户确认
            toolCallItem.status = 'pending';
            agentStore.updateLastMessage(tabId, (m) => ({
              ...m,
              toolCalls: [...toolCallItems],
            }));

            allowed = await new Promise<boolean>((resolve) => {
              agentStore.setPendingApproval(tabId, toolCallItem, resolve);
            });

            if (signal.aborted) break;

            if (!allowed) {
              toolCallItem.status = 'rejected';
              toolCallItem.result = '用户取消了本次工具执行';
            }
          }
        }

        if (signal.aborted) break;

        if (allowed) {
          toolCallItem.status = 'executing';
          toolCallItem.result = '';
          agentStore.updateLastMessage(tabId, (m) => ({
            ...m,
            toolCalls: [...toolCallItems],
          }));

          const startTime = Date.now();
          const execRes = await executeToolCall(sessionId, fnName, fnArgs, (chunk: string) => {
            if (signal.aborted) return;
            toolCallItem.result = (toolCallItem.result || '') + chunk;
            toolCallItem.durationMs = Date.now() - startTime;
            agentStore.updateLastMessage(tabId, (m) => ({
              ...m,
              toolCalls: [...toolCallItems],
            }));
          });
          if (signal.aborted) break;

          toolCallItem.durationMs = Date.now() - startTime;
          toolCallItem.status = execRes.isError ? 'failed' : 'success';
          toolCallItem.result = execRes.stdout;
        }

        agentStore.updateLastMessage(tabId, (m) => ({
          ...m,
          toolCalls: [...toolCallItems],
        }));

        if (signal.aborted) break;

        // 反馈工具执行结果给模型
        conversation.push({
          role: 'tool',
          tool_call_id: tc.id,
          // 界面保留完整输出，送入模型的上下文按长度截断，避免撑爆窗口
          content: truncateToolResult(toolCallItem.result || '(无输出)'),
        });
      }

      // 本轮工具执行完毕，后续结论文本必须基于最新执行状态重新生成
      conclusionBaseline = accumulatedContent.length;
    }

    // 轮次耗尽闭环：达到最大循环仍无结构化结论时，依据真实执行状态补齐，避免静默结束
    if (!signal.aborted && toolCallItems.length > 0 && !hasFreshConclusion()) {
      const fallback = buildDeterministicConclusion(toolCallItems);
      accumulatedContent = appendConclusionSafely(accumulatedContent, fallback);
      agentStore.updateLastMessage(tabId, (m) => ({
        ...m,
        content: accumulatedContent,
      }));
    }

  } catch (err: any) {
    if (signal.aborted || err.name === 'AbortError') {
      agentStore.updateLastMessage(tabId, (m) => {
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
      // 执行异常时仍需给出闭环结论：保留真实执行状态汇总并追加异常原因
      const errorNote = `任务执行异常: ${err?.message || err}`;
      const closure =
        toolCallItems.length > 0 && !hasFreshConclusion()
          ? buildDeterministicConclusion(toolCallItems)
          : '';
      agentStore.updateLastMessage(tabId, (m) => {
        const body = appendConclusionSafely(m.content || '', closure);
        return {
          ...m,
          content: [body, errorNote].filter((part) => part && part.trim()).join('\n\n'),
        };
      });
    }
  } finally {
    delete abortControllers[tabId];
    agentStore.setIsThinking(tabId, false);
  }
}
