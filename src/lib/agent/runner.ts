import { invoke } from '@tauri-apps/api/core';
import { useAgentStore } from '../../stores/useAgentStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { isWindowsPlatform } from '../platform';
import { getTerminalSnapshot } from '../terminal/ptyBridge';
import { AGENT_TOOLS, checkSafety, executeToolCall } from './tools';
import { isReadOnlyCommand, truncateToolResult } from './commandUtils';
import { resolveAiRuntime, validateAiRuntime } from '../aiProviders';
import { HISTORY_MESSAGE_LIMIT, MAX_AGENT_LOOPS } from './constants';
import { describeFinishReason } from './streamParse';
import {
  appendConclusionSafely,
  buildDeterministicConclusion,
  buildHistoryToolResult,
  isConclusionComplete,
  isTrailingConclusionComplete,
  sanitizeHistoryContent,
  upsertConclusion,
} from './summary';
import {
  abortActiveStreamRequest,
  executeLlmTurn,
  requestStructuredConclusion,
} from './streamLoop';
import type { SessionContext, ToolCallItem } from '../../types';

const abortControllers: Record<string, AbortController> = {};

/** 判断指定会话是否存在进行中的任务 */
export function isAgentTaskRunning(tabId: string): boolean {
  return Boolean(abortControllers[tabId]);
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
  abortActiveStreamRequest(`session:${tabId}`);

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

export interface RunAgentOptions {
  /** 附加给本轮任务的终端实时上下文（用户、目录、屏幕快照等） */
  terminalContextPrompt?: string;
}

export async function runAgentTask(
  userPrompt: string,
  targetTabId?: string,
  options?: RunAgentOptions
): Promise<void> {
  const terminalStore = useTerminalStore.getState();
  const tabId = targetTabId || terminalStore.activeTabId;
  if (!tabId) return;

  if (abortControllers[tabId]) {
    abortAgentTask(tabId);
  }

  const abortCtrl = new AbortController();
  abortControllers[tabId] = abortCtrl;
  const signal = abortCtrl.signal;
  const scopeKey = `session:${tabId}`;

  const agentStore = useAgentStore.getState();
  const settingsStore = useSettingsStore.getState();

  const activeTab = terminalStore.tabs.find((t) => t.id === tabId);
  if (!activeTab) {
    delete abortControllers[tabId];
    return;
  }
  const sessionId = activeTab.sessionId;

  const sessionState = agentStore.getSessionState(tabId);
  const historyMessages = sessionState.messages.slice(-HISTORY_MESSAGE_LIMIT);

  agentStore.addMessage(tabId, {
    id: 'msg-' + Date.now(),
    role: 'user',
    content: userPrompt,
    timestamp: Date.now(),
  });
  agentStore.setIsThinking(tabId, true);

  const isLocalWindows = !activeTab.isSsh && isWindowsPlatform();

  const envLabel = activeTab.isSsh
    ? `远程 SSH 主机：${activeTab.title}（登录用户: ${activeTab.server?.username || '未知'}，会话 ${activeTab.sessionId}）`
    : isLocalWindows
      ? `本地 Windows PowerShell 终端（会话 ${activeTab.sessionId}）`
      : `本地终端：${activeTab.title}（会话 ${activeTab.sessionId}）`;

  // 自动采集当前终端实时上下文（含 su 切换后的用户、cwd、最近退出码与屏幕输出快照）
  const liveContextParts: string[] = [];
  if (options?.terminalContextPrompt) {
    liveContextParts.push(options.terminalContextPrompt);
  }
  const execMode = useAgentStore.getState().executionMode;
  const attachCtx = useAgentStore.getState().attachTerminalContext;

  if (attachCtx) {
    let sessionCtx: SessionContext | null = null;
    if (window.__TAURI_INTERNALS__) {
      try {
        sessionCtx = await invoke<SessionContext | null>('get_session_context', { sessionId });
      } catch {}
    }
    const statusLines: string[] = [];
    if (sessionCtx?.user) {
      const loginUser = activeTab.server?.username;
      if (activeTab.isSsh && loginUser && sessionCtx.user !== loginUser) {
        statusLines.push(
          `- 当前交互终端有效用户: ${sessionCtx.user}（用户已通过 su/sudo 从初始登录账号 ${loginUser} 切换身份）`
        );
      } else {
        statusLines.push(`- 当前终端用户: ${sessionCtx.user}`);
      }
    }
    if (sessionCtx?.hostname) {
      statusLines.push(`- 当前终端主机名: ${sessionCtx.hostname}`);
    }
    if (sessionCtx?.cwd) {
      statusLines.push(`- 当前终端工作目录: ${sessionCtx.cwd}`);
    }
    if (sessionCtx?.last_exit_code !== null && sessionCtx?.last_exit_code !== undefined) {
      statusLines.push(`- 最近命令退出码: ${sessionCtx.last_exit_code}`);
    }
    statusLines.push(
      execMode === 'pty'
        ? '- 当前工具执行通道: 终端内联 PTY（命令直接运行在当前交互式 Shell 中，自动继承 su/sudo 身份、cwd、环境变量与跳板机上下文）'
        : '- 当前工具执行通道: 独立隔离 Exec 通道（自动切换至当前 cwd，但默认使用 SSH 初始登录账号；若需在 su 后的身份下执行，请使用 sudo -u <用户> 或提示用户切换到「终端内联」模式）'
    );
    liveContextParts.push(statusLines.join('\n'));

    const snapshot = getTerminalSnapshot(sessionId, 40) || sessionCtx?.recent_output?.slice(-1800) || '';
    if (snapshot.trim()) {
      liveContextParts.push(
        `当前终端最近屏幕输出摘录:\n\`\`\`text\n${snapshot.trim().slice(-1800)}\n\`\`\``
      );
    }
  }

  const contextSection =
    liveContextParts.length > 0
      ? `\n\n当前交互式终端实时状态：\n${liveContextParts.join('\n\n')}`
      : '';

  const systemPrompt = `你是一名专业的运维与 SRE 智能体，具备真实工具调用与排障执行能力。
当前连接环境：${envLabel}${contextSection}

执行准则：
1. 真实执行，禁止口头承诺
   - 环境探测、日志排查、服务操作必须调用 terminal_exec、file_read、file_list、system_info 完成。
   - 编写脚本与配置文件必须通过 file_write 真实写入磁盘，不能只在回复中贴代码。
2. 脚本写入规范
   - 避免在 terminal_exec 中拼接超长多行脚本或复杂 heredoc；先用 file_write 写入完整内容，再用 terminal_exec 赋权并执行。
3. 闭环验证
   - 部署、重启或修改配置后，必须再调用 terminal_exec 验证最终状态，确认生效后再汇报。
4. 清晰详尽的最终结论
   - 所有工具调用结束后，务必给出清晰、直观的最终总结，包含：
     1) 目标达成情况或排查根因（1-2 句直奔结论）；
     2) 关键验证数据与事实（真实引用的端口、进程/PID、资源指标、日志片段或配置值，支持 Markdown 列表或表格）；
     3) 重点变更项与后续建议（无变更则写“无”）。
   - 不使用 Emoji，省略过程性套话；不允许调用完工具后空回复或草草一句话带过。
5. 以最终状态判定成败
   - 前置探测、条件判断类命令（grep、test、[ ]、pidof、which、diff、systemctl is-active 等）返回非零退出码属于正常判断结果，不代表失败。
   - 中间报错若已被后续步骤修复，最终结论应判定为已完成。`;

  const conversation: any[] = [{ role: 'system', content: systemPrompt }];

  for (const m of historyMessages) {
    if (m.role === 'user') {
      if (m.content) conversation.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
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
        conversation.push({ role: 'assistant', content: historyText });
      }
    }
  }

  conversation.push({ role: 'user', content: userPrompt });

  const runtime = resolveAiRuntime(settingsStore.settings);
  const { baseUrl, apiKey, model } = runtime;

  const toolCallItems: ToolCallItem[] = [];
  agentStore.addMessage(tabId, {
    id: 'msg-' + (Date.now() + 1),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    toolCalls: toolCallItems,
  });

  const configError = validateAiRuntime(runtime);
  if (configError) {
    agentStore.updateLastMessage(tabId, (m) => ({ ...m, content: configError }));
    agentStore.setIsThinking(tabId, false);
    delete abortControllers[tabId];
    return;
  }

  let loopCount = 0;
  let accumulatedThinking = '';
  let accumulatedContent = '';
  let conclusionBaseline = 0;
  let lastSegmentTruncated = false;
  let conclusionFinishNote = '';

  const hasFreshConclusion = () =>
    isConclusionComplete(accumulatedContent.slice(conclusionBaseline), {
      truncated: lastSegmentTruncated,
    });

  try {
    while (loopCount < MAX_AGENT_LOOPS) {
      if (signal.aborted) break;
      loopCount++;

      const turn = await executeLlmTurn({
        baseUrl,
        apiKey: apiKey || '',
        model,
        messages: conversation,
        tools: AGENT_TOOLS,
        signal,
        scopeKey,
        accumulatedThinking,
        accumulatedContent,
        onUpdate: (patch) => {
          agentStore.updateLastMessage(tabId, (m) => ({
            ...m,
            thinking: patch.thinking || m.thinking,
            thinkingTimeMs: patch.thinkingTimeMs || m.thinkingTimeMs,
            content: patch.content,
          }));
        },
      });

      if (signal.aborted) break;

      if (turn.loopThinking) {
        accumulatedThinking = accumulatedThinking
          ? `${accumulatedThinking}\n\n${turn.loopThinking}`
          : turn.loopThinking;
      }
      if (turn.loopContent) {
        accumulatedContent = accumulatedContent
          ? `${accumulatedContent}\n\n${turn.loopContent}`
          : turn.loopContent;
      }

      lastSegmentTruncated =
        turn.finishReason === 'length' || turn.finishReason === 'content_filter';

      const finishNote = describeFinishReason(turn.finishReason);
      if (finishNote) {
        accumulatedContent = accumulatedContent.trim()
          ? `${accumulatedContent.trim()}\n\n${finishNote}`
          : finishNote;
        agentStore.updateLastMessage(tabId, (m) => ({
          ...m,
          content: accumulatedContent,
        }));
      }

      if (turn.toolCalls.length === 0) {
        if (toolCallItems.length > 0 && !signal.aborted && !hasFreshConclusion()) {
          const { reportContent, finishNote: retryNote } = await requestStructuredConclusion({
            scope: 'session',
            baseUrl,
            apiKey: apiKey || '',
            model,
            conversation,
            toolCallItems,
            accumulatedThinking,
            accumulatedContent,
            signal,
            scopeKey,
            onUpdate: (patch) => {
              agentStore.updateLastMessage(tabId, (m) => ({
                ...m,
                thinking: patch.thinking || m.thinking,
                content: patch.content,
              }));
            },
          });
          if (retryNote) conclusionFinishNote = retryNote;
          if (reportContent.trim()) {
            accumulatedContent = upsertConclusion(accumulatedContent, reportContent);
            lastSegmentTruncated = !isTrailingConclusionComplete(accumulatedContent);
            agentStore.updateLastMessage(tabId, (m) => ({
              ...m,
              content: accumulatedContent,
            }));
          }
        }

        if (!signal.aborted && toolCallItems.length > 0 && !hasFreshConclusion()) {
          const fallback = buildDeterministicConclusion(toolCallItems);
          accumulatedContent = upsertConclusion(accumulatedContent, fallback);
          if (conclusionFinishNote && !accumulatedContent.includes(conclusionFinishNote)) {
            accumulatedContent = `${accumulatedContent}\n\n${conclusionFinishNote}`;
          }
          agentStore.updateLastMessage(tabId, (m) => ({
            ...m,
            content: accumulatedContent,
          }));
        } else if (!signal.aborted && toolCallItems.length === 0 && !accumulatedContent.trim()) {
          agentStore.updateLastMessage(tabId, (m) => ({
            ...m,
            content: '模型未返回任何内容，请重试或检查模型配置。',
          }));
        }
        break;
      }

      conversation.push({
        role: 'assistant',
        content: turn.loopContent || null,
        tool_calls: turn.toolCalls,
      });

      for (const tc of turn.toolCalls) {
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

        if (fnName === 'terminal_exec') {
          const safety = await checkSafety(
            fnArgs.command || '',
            settingsStore.settings.danger_level
          );
          toolCallItem.riskLevel = safety.risk_level;
          toolCallItem.warningMessage = safety.message;
        } else if (fnName === 'file_write') {
          const targetPath = String(fnArgs.path || '');
          if (/(\/etc\/sudoers|authorized_keys|\/etc\/passwd|\/etc\/shadow|sshd_config)/i.test(targetPath)) {
            toolCallItem.riskLevel = 'dangerous';
            toolCallItem.warningMessage = `正在修改系统关键认证或权限文件: ${targetPath}`;
          }
        }

        toolCallItems.push(toolCallItem);
        agentStore.updateLastMessage(tabId, (m) => ({
          ...m,
          toolCalls: [...toolCallItems],
        }));

        if (signal.aborted) break;

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
            if (fnName === 'file_write') {
              needsApproval = true;
            } else if (fnName === 'terminal_exec') {
              if (toolCallItem.riskLevel === 'warning' || !isReadOnlyCommand(fnArgs.command || '')) {
                needsApproval = true;
              }
            }
          }

          if (needsApproval) {
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

        conversation.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: truncateToolResult(toolCallItem.result || '(无输出)'),
        });
      }

      conclusionBaseline = accumulatedContent.length;
    }

    if (!signal.aborted && toolCallItems.length > 0 && !hasFreshConclusion()) {
      const fallback = buildDeterministicConclusion(toolCallItems);
      accumulatedContent = upsertConclusion(accumulatedContent, fallback);
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
      const errorNote = `任务执行异常: ${err?.message || err}`;
      agentStore.updateLastMessage(tabId, (m) => {
        const closure =
          toolCallItems.length > 0 && !hasFreshConclusion()
            ? buildDeterministicConclusion(toolCallItems)
            : '';
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
    const persistKey = activeTab.isSsh && activeTab.server ? `srv:${activeTab.server.id}` : 'local';
    agentStore.persistHistory(tabId, persistKey).catch(() => {});
  }
}
