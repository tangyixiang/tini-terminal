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

function isReadOnlyCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return true;
  // 严禁包含写入重定向或写管道
  if (/>|>>|\|\s*(tee|dd)\b/i.test(trimmed)) return false;
  // 匹配状态修改与变更命令
  const modifyingKeywords = [
    'rm', 'mv', 'cp', 'chmod', 'chown', 'mkdir', 'rmdir', 'touch', 'truncate',
    'sed -i', 'apt', 'yum', 'dnf', 'pacman', 'apk', 'pip', 'npm', 'yarn', 'pnpm',
    'docker run', 'docker rm', 'docker stop', 'docker start', 'docker restart', 'docker compose', 'docker build',
    'systemctl start', 'systemctl stop', 'systemctl restart', 'systemctl enable', 'systemctl disable',
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

  // 1. 获取现有历史消息（最多保留最近 20 条）
  const historyMessages = agentStore.messages.slice(-20);

  // 2. 添加用户消息到 store
  const userMsgId = 'msg-' + Date.now();
  agentStore.addMessage({
    id: userMsgId,
    role: 'user',
    content: userPrompt,
    timestamp: Date.now(),
  });

  agentStore.setIsThinking(true);

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
   - 交互文案直观精炼、直奔主题，杜绝解释性套话、过程性废话和无意义寒暄。
   - 严禁输出任何 Emoji 表情符号。`;

  const conversation: any[] = [
    { role: 'system', content: systemPrompt },
  ];

  // 导入最近历史消息（完整保留 tool_calls 与 tool 返回结果，避免多轮丢失工具状态）
  for (const m of historyMessages) {
    if (m.role === 'user') {
      if (m.content) {
        conversation.push({ role: 'user', content: m.content });
      }
    } else if (m.role === 'assistant') {
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
          content: m.content || null,
          tool_calls: validCalls,
        });
        for (const tc of m.toolCalls) {
          conversation.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: tc.result || (tc.status === 'rejected' ? '用户拒绝执行' : '(无输出)'),
          });
        }
      } else if (m.content && m.content.trim()) {
        conversation.push({
          role: 'assistant',
          content: m.content,
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

  agentStore.addMessage({
    id: assistantMsgId,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    toolCalls: toolCallItems,
  });

  const maxLoops = 15;
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
