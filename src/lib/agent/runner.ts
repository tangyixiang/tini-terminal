import { Channel, invoke } from '@tauri-apps/api/core';
import { useAgentStore } from '../../stores/useAgentStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { AGENT_TOOLS, checkSafety, executeToolCall } from './tools';
import { isReadOnlyCommand, truncateToolResult } from './commandUtils';
import {
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

/** 流式渲染节流间隔，兼顾流畅度与渲染开销 */
const STREAM_FLUSH_INTERVAL_MS = 50;

/** 单次任务最大工具调用轮次 */
const MAX_AGENT_LOOPS = 20;

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

      const abortHandler = () => {
        invoke('abort_ai_chat', { requestId }).catch(() => {});
        if (tabId) delete currentRequestIds[tabId];
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
          if (tabId) delete currentRequestIds[tabId];
          reject(new Error(event.data || '大模型网络请求异常'));
        } else if (event.event_type === 'done') {
          signal.removeEventListener('abort', abortHandler);
          if (tabId) delete currentRequestIds[tabId];
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
        if (tabId) delete currentRequestIds[tabId];
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

  // 1. 获取该会话专属历史消息（最多保留最近 20 条）
  const sessionState = agentStore.getSessionState(tabId);
  const historyMessages = sessionState.messages.slice(-20);

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
  const systemPrompt = `你是一个具备完整工具调用执行能力的专业 Linux 运维与 SRE Agent 助手。
系统当前连接主机: ${activeTab ? `${activeTab.title} (Session: ${activeTab.sessionId})` : '本地终端'}

核心原则与执行纪律:
1. 真实工具调用，严禁口头伪造执行:
   - 严禁在回复中以文本口头宣称"正在检查..."、"正在编写脚本..."、"服务已部署完成"而实际不调用工具！
   - 所有环境探测、状态排查、服务启动等必须通过 terminal_exec、file_read、file_list、system_info 工具实际调用。
   - 所有运维脚本、配置文件的创建或更新必须通过 file_write 工具实际写入目标路径，严禁仅在回复文本中展示脚本代码就假装已经部署。
2. 脚本编写与执行规范:
   - 严禁在 terminal_exec 中使用超长多行文本或复杂 heredoc (cat << 'EOF') 拼装脚本，这极易引发转义与语法错误。
   - 正确流程: 优先使用 file_write 将完整脚本写入目标绝对路径 (如 /usr/local/bin/xxx 或项目目录)，随后使用 terminal_exec 执行 chmod +x 并运行。
3. 闭环验证原则:
   - 任何部署、重启或变更操作完成后，必须主动调用 terminal_exec 进行状态闭环验证 (如检查 docker ps、ss -lntp、systemctl status、curl 探测等)，确保真实生效后才向用户确认。
4. 极致简洁专业:
   - 交互文案直观精炼、直奔主题，杜绝冗长过程性废话和无意义寒暄。
   - 严禁输出任何 Emoji 表情符号。
5. 必须输出最终结论报告（结论闭环）:
   - 在所有工具调用执行完毕后，必须在最终回复文本中对执行结果给出清晰精炼的结论与分析报告。
   - 格式建议：
### 执行结论
- 目标达成情况: [已完成 / 异常]
- 关键状态与验证: [提炼最终检查结果、服务状态或端口情况]
- 重点变更说明: [若有配置修改或脚本部署请简要列出]
   - 明确指出服务状态、健康检查结果或配置变更情况。严禁仅调用工具而不输出任何文字结论，严禁静默空回复！
6. 整体目标与最终验证驱动，严禁误报未完成:
   - 运维任务以最终达成的业务目标与最终验证状态为唯一评判准绳。
   - 凡是在执行过程中作为前置探测、环境排查、分支条件判断的命令（如 grep、test、[ ]、pidof、which、diff、systemctl is-active 等返回非零退出码），绝不属于操作失败。
   - 凡是前期报错或状态未就绪，但已被后续步骤成功修复、重新启动、正确配置或成功创建的，均属任务圆满完成，严禁将中间排查或自愈过程误判为"任务未完成"或"操作失败"。
   - 判定为未完成或异常时，必须明确指出是哪一项最终验证结果不达标，禁止使用笼统模糊的表述。`;

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

  agentStore.addMessage(tabId, {
    id: assistantMsgId,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    toolCalls: toolCallItems,
  });

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

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const jsonStr = trimmed.replace(/^data:\s*/, '');
          if (jsonStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;

            // 深度思考标签识别与提取（正确处理跨片段标签）
            if (delta.reasoning_content) {
              loopThinking += delta.reasoning_content;
              updated = true;
            } else if (delta.content) {
              const parsed = parseThinkTag(delta.content, thinkState);
              thinkState = parsed.state;
              if (parsed.thinking) {
                loopThinking += parsed.thinking;
                thinkingDuration = Date.now() - loopStartTime;
              }
              if (parsed.content) {
                loopContent += parsed.content;
              }
              updated = true;
            }

            // Function calling 工具调用片段捕获
            if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const index = tc.index ?? 0;
                const existing = toolCallsMap.get(index) || { id: '', name: '', args: '' };
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name += tc.function.name;
                if (tc.function?.arguments) existing.args += tc.function.arguments;
                toolCallsMap.set(index, existing);
              }
              updated = true;
            }
          } catch {
            // 忽略流式片段解析异常
          }
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
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          handleLines(lines);
        },
        tabId,
      );

      if (buffer.trim()) {
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
          let summaryBuffer = '';
          loopThinking = '';
          loopContent = '';
          thinkState = { inThink: false, pending: '' };
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
                handleLines(lines);
              },
              tabId
            );
          } catch {
            // 结论请求异常交由下方兜底逻辑保证必出结论
          }
          if (summaryBuffer.trim()) {
            handleLines([summaryBuffer.trim()]);
          }
          flushPending();
          if (loopContent.trim()) {
            accumulatedContent = accumulatedContent.trim()
              ? `${accumulatedContent.trim()}\n\n${loopContent.trim()}`
              : loopContent.trim();
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
          accumulatedContent = accumulatedContent.trim()
            ? `${accumulatedContent.trim()}\n\n${fallback}`
            : fallback;
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
          const safety = await checkSafety(fnArgs.command || '');
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
      accumulatedContent = accumulatedContent.trim()
        ? `${accumulatedContent.trim()}\n\n${fallback}`
        : fallback;
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
      agentStore.updateLastMessage(tabId, (m) => ({
        ...m,
        content: [m.content, closure, errorNote].filter((part) => part && part.trim()).join('\n\n'),
      }));
    }
  } finally {
    delete abortControllers[tabId];
    agentStore.setIsThinking(tabId, false);
  }
}
