import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useServerStore } from '../../stores/useServerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { WORKSPACE_AGENT_TOOLS, checkSafety, executeWorkspaceToolCall } from './workspaceTools';
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
import type { ToolCallItem } from '../../types';

const abortControllers: Record<string, AbortController> = {};

export function abortWorkspaceAgentTask(targetWsId?: string): void {
  const wsStore = useWorkspaceStore.getState();
  const wsId = targetWsId || wsStore.activeWorkspaceId || 'default';

  const ctrl = abortControllers[wsId];
  if (ctrl) {
    ctrl.abort();
    delete abortControllers[wsId];
  }
  abortActiveStreamRequest(`workspace:${wsId}`);

  const state = wsStore.getAgentState(wsId);
  if (state.approvalResolver) {
    state.approvalResolver(false);
  }
  wsStore.setPendingApproval(wsId, null, null);
  wsStore.setIsThinking(wsId, false);

  wsStore.updateLastMessage(wsId, (m) => {
    const abortNote = '[工作区任务已手动中止]';
    if (!m.content?.includes(abortNote)) {
      return {
        ...m,
        content: m.content ? `${m.content}\n${abortNote}` : abortNote,
      };
    }
    return m;
  });
}

export async function runWorkspaceAgentTask(
  userPrompt: string,
  targetWsId?: string
): Promise<void> {
  const wsStore = useWorkspaceStore.getState();
  const serverStore = useServerStore.getState();
  const settingsStore = useSettingsStore.getState();

  const wsId = targetWsId || wsStore.activeWorkspaceId || 'default';

  if (abortControllers[wsId]) {
    abortWorkspaceAgentTask(wsId);
  }

  const abortCtrl = new AbortController();
  abortControllers[wsId] = abortCtrl;
  const signal = abortCtrl.signal;
  const scopeKey = `workspace:${wsId}`;

  const allServers = serverStore.servers;
  const selectedHostIds = wsStore.selectedHostIds;
  const visibleServers = allServers.filter((s) => selectedHostIds.includes(s.id));

  if (visibleServers.length === 0) {
    delete abortControllers[wsId];
    wsStore.addMessage(wsId, {
      id: 'msg-' + Date.now(),
      role: 'assistant',
      content: '当前工作区未勾选任何目标主机，请在左侧主机列表中勾选至少一台目标主机后再下达任务。',
      timestamp: Date.now(),
    });
    return;
  }

  const agentState = wsStore.getAgentState(wsId);
  const historyMessages = agentState.messages.slice(-HISTORY_MESSAGE_LIMIT);

  wsStore.addMessage(wsId, {
    id: 'msg-' + Date.now(),
    role: 'user',
    content: userPrompt,
    timestamp: Date.now(),
  });
  wsStore.setIsThinking(wsId, true);

  const hostDescriptions = visibleServers
    .map(
      (s) =>
        `- ${s.name}（标识: "${s.id}" 或 "${s.name}"，地址: ${s.host}:${s.port}，用户: ${s.username}${s.tags ? `，标签: ${s.tags}` : ''}）`
    )
    .join('\n');

  const systemPrompt = `你是一名专业的运维工作区智能体，具备多机协同编排与自主执行能力。

当前工作区可操作的主机节点：
${hostDescriptions}

执行准则：
1. 多机协同
   - host_id 参数支持传入主机 ID 或主机名称（如 ${visibleServers.map((s) => `"${s.name}"`).join(' / ')}）。
   - 可用工具：host_exec、host_file_read、host_file_write、host_system_info、host_transfer。
2. 真实执行与闭环验证
   - 不编造执行结果，所有查询、探测与文件操作必须真实调用工具；变更后必须在目标主机验证生效状态。
3. 清晰详尽的多机总结
   - 所有工具调用结束后，必须给出清晰完整的最终总结（支持 Markdown 列表或对比表格），包含：
     1) 总体达成情况与核心发现；
     2) 各主机节点的真实关键数据（服务状态、端口、PID、资源占用或配置差异）；
     3) 涉及的跨机同步、配置变更与风险建议（无则写“无”）。
   - 不使用 Emoji，省略客套话，不允许调用工具后空回复或草草一句话带过。
4. 以最终状态判定成败
   - 前置探测命令（grep、test、[ ]、pidof、which、diff、systemctl is-active 等）非零退出码属于正常判断，前期已被修复的报错不视为失败。`;

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
  wsStore.addMessage(wsId, {
    id: 'msg-' + (Date.now() + 1),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    toolCalls: toolCallItems,
  });

  const configError = validateAiRuntime(runtime);
  if (configError) {
    wsStore.updateLastMessage(wsId, (m) => ({ ...m, content: configError }));
    wsStore.setIsThinking(wsId, false);
    delete abortControllers[wsId];
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
        tools: WORKSPACE_AGENT_TOOLS,
        signal,
        scopeKey,
        accumulatedThinking,
        accumulatedContent,
        onUpdate: (patch) => {
          wsStore.updateLastMessage(wsId, (m) => ({
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
        wsStore.updateLastMessage(wsId, (m) => ({
          ...m,
          content: accumulatedContent,
        }));
      }

      if (turn.toolCalls.length === 0) {
        if (toolCallItems.length > 0 && !signal.aborted && !hasFreshConclusion()) {
          const { reportContent, finishNote: retryNote } = await requestStructuredConclusion({
            scope: 'workspace',
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
              wsStore.updateLastMessage(wsId, (m) => ({
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
            wsStore.updateLastMessage(wsId, (m) => ({
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
          wsStore.updateLastMessage(wsId, (m) => ({
            ...m,
            content: accumulatedContent,
          }));
        } else if (!signal.aborted && toolCallItems.length === 0 && !accumulatedContent.trim()) {
          wsStore.updateLastMessage(wsId, (m) => ({
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

        const targetHostIdent = fnArgs.host_id || fnArgs.dst_host_id || fnArgs.src_host_id || '';
        const matchedServer = visibleServers.find(
          (s) => s.id === targetHostIdent || s.name.toLowerCase() === String(targetHostIdent).toLowerCase()
        );
        const hostName = matchedServer?.name || targetHostIdent || '未知节点';
        const hostId = matchedServer?.id || targetHostIdent;

        const toolCallItem: ToolCallItem = {
          id: tc.id || 'tc-' + Date.now(),
          name: fnName,
          args: fnArgs,
          status: 'pending',
          riskLevel: 'safe',
          hostId,
          hostName,
        };

        if (fnName === 'host_exec') {
          const safety = await checkSafety(
            fnArgs.command || '',
            settingsStore.settings.danger_level
          );
          toolCallItem.riskLevel = safety.risk_level;
          toolCallItem.warningMessage = safety.message;
        } else if (fnName === 'host_file_write') {
          const targetPath = String(fnArgs.path || '');
          if (/(\/etc\/sudoers|authorized_keys|\/etc\/passwd|\/etc\/shadow|sshd_config)/i.test(targetPath)) {
            toolCallItem.riskLevel = 'dangerous';
            toolCallItem.warningMessage = `正在修改系统关键认证或权限文件: ${targetPath}`;
          }
        }

        toolCallItems.push(toolCallItem);
        wsStore.updateLastMessage(wsId, (m) => ({
          ...m,
          toolCalls: [...toolCallItems],
        }));

        if (signal.aborted) break;

        const permMode = useWorkspaceStore.getState().permissionMode;
        let allowed = true;

        if (permMode === 'read_only') {
          if (fnName === 'host_file_write' || fnName === 'host_transfer') {
            allowed = false;
            toolCallItem.status = 'rejected';
            toolCallItem.result = '拒绝执行：当前工作区处于只读模式';
          } else if (fnName === 'host_exec' && !isReadOnlyCommand(fnArgs.command || '')) {
            allowed = false;
            toolCallItem.status = 'rejected';
            toolCallItem.result = '拒绝执行：当前处于只读模式，禁止执行变更指令';
          }
        } else {
          let needsApproval = false;
          if (toolCallItem.riskLevel === 'dangerous') {
            needsApproval = true;
          } else if (permMode === 'full') {
            needsApproval = false;
          } else {
            if (fnName === 'host_file_write' || fnName === 'host_transfer') {
              needsApproval = true;
            } else if (fnName === 'host_exec') {
              if (toolCallItem.riskLevel === 'warning' || !isReadOnlyCommand(fnArgs.command || '')) {
                needsApproval = true;
              }
            }
          }

          if (needsApproval) {
            toolCallItem.status = 'pending';
            wsStore.updateLastMessage(wsId, (m) => ({
              ...m,
              toolCalls: [...toolCallItems],
            }));

            allowed = await new Promise<boolean>((resolve) => {
              wsStore.setPendingApproval(wsId, toolCallItem, resolve);
            });

            if (signal.aborted) break;
            if (!allowed) {
              toolCallItem.status = 'rejected';
              toolCallItem.result = '用户拒绝了本次主机操作';
            }
          }
        }

        if (signal.aborted) break;

        if (allowed) {
          toolCallItem.status = 'executing';
          toolCallItem.result = '';
          wsStore.updateLastMessage(wsId, (m) => ({
            ...m,
            toolCalls: [...toolCallItems],
          }));

          const startTime = Date.now();
          const execRes = await executeWorkspaceToolCall(fnName, fnArgs, (chunk: string) => {
            if (signal.aborted) return;
            toolCallItem.result = (toolCallItem.result || '') + chunk;
            toolCallItem.durationMs = Date.now() - startTime;
            wsStore.updateLastMessage(wsId, (m) => ({
              ...m,
              toolCalls: [...toolCallItems],
            }));
          });

          if (signal.aborted) break;

          toolCallItem.durationMs = Date.now() - startTime;
          toolCallItem.status = execRes.isError ? 'failed' : 'success';
          toolCallItem.result = execRes.stdout;
        }

        wsStore.updateLastMessage(wsId, (m) => ({
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
      wsStore.updateLastMessage(wsId, (m) => ({
        ...m,
        content: accumulatedContent,
      }));
    }
  } catch (err: any) {
    if (signal.aborted || err.name === 'AbortError') {
      wsStore.updateLastMessage(wsId, (m) => {
        const abortNote = '[工作区任务已手动中止]';
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
      wsStore.updateLastMessage(wsId, (m) => {
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
    delete abortControllers[wsId];
    wsStore.setIsThinking(wsId, false);
  }
}
