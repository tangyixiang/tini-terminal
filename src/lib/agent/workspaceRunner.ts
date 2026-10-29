import { Channel, invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useServerStore } from '../../stores/useServerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { WORKSPACE_AGENT_TOOLS, checkSafety, executeWorkspaceToolCall } from './workspaceTools';
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
  wsId?: string
): Promise<void> {
  if (window.__TAURI_INTERNALS__) {
    const requestId = 'req-ws-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    if (wsId) currentRequestIds[wsId] = requestId;

    return new Promise<void>((resolve, reject) => {
      const channel = new Channel<StreamEventPayload>();

      const abortHandler = () => {
        invoke('abort_ai_chat', { requestId }).catch(() => {});
        if (wsId) delete currentRequestIds[wsId];
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
          if (wsId) delete currentRequestIds[wsId];
          reject(new Error(event.data || '大模型网络请求异常'));
        } else if (event.event_type === 'done') {
          signal.removeEventListener('abort', abortHandler);
          if (wsId) delete currentRequestIds[wsId];
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
        if (wsId) delete currentRequestIds[wsId];
        reject(new Error(err?.toString() || '启动大模型网络请求失败'));
      });
    });
  } else {
    // 浏览器环境回退
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

export function abortWorkspaceAgentTask(targetWsId?: string): void {
  const wsStore = useWorkspaceStore.getState();
  const wsId = targetWsId || wsStore.activeWorkspaceId || 'default';

  const ctrl = abortControllers[wsId];
  if (ctrl) {
    ctrl.abort();
    delete abortControllers[wsId];
  }

  const reqId = currentRequestIds[wsId];
  if (reqId && window.__TAURI_INTERNALS__) {
    invoke('abort_ai_chat', { requestId: reqId }).catch(() => {});
    delete currentRequestIds[wsId];
  }

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

  // 1. 获取工作区可见主机集群列表
  const allServers = serverStore.servers;
  const selectedHostIds = wsStore.selectedHostIds;
  const visibleServers = allServers.filter((s) => selectedHostIds.includes(s.id));

  // 2. 检查是否有勾选目标主机
  if (visibleServers.length === 0) {
    wsStore.addMessage(wsId, {
      id: 'msg-' + Date.now(),
      role: 'assistant',
      content: '当前工作区未勾选任何目标主机，请在左侧主机列表中勾选至少一台目标主机后再下达任务。',
      timestamp: Date.now(),
    });
    return;
  }

  // 3. 获取历史消息
  const agentState = wsStore.getAgentState(wsId);
  const historyMessages = agentState.messages.slice(-20);

  // 4. 追加用户消息
  const userMsgId = 'msg-' + Date.now();
  wsStore.addMessage(wsId, {
    id: userMsgId,
    role: 'user',
    content: userPrompt,
    timestamp: Date.now(),
  });

  wsStore.setIsThinking(wsId, true);

  // 5. 组装多机协同 System Prompt
  const hostDescriptions = visibleServers
    .map(
      (s) =>
        `- ${s.name} (唯一标识: "${s.id}" 或 "${s.name}", 地址: ${s.host}:${s.port}, 用户: ${s.username}${s.tags ? `, 标签: ${s.tags}` : ''})`
    )
    .join('\n');

  const systemPrompt = `你是一个具备多机协同编排与自主执行能力的专业 Linux 运维工作区智能体（Workspace Agent）。

你当前所处工作区包含以下可操作的集群主机节点:
${hostDescriptions}

核心能力与调用纪律:
1. 多机自主协同:
   - 你具有多台主机的全局视野，能够根据用户意图，自主规划步骤、访问不同的主机。
   - 工具调用中的 host_id 参数支持传入主机 ID 或主机名称（如 ${visibleServers.map((s) => `"${s.name}"`).join(' / ')}）。
   - 可用工具包括:
     * host_exec(host_id, command): 在指定主机上执行 shell 命令
     * host_file_read(host_id, path): 读取指定主机文件内容
     * host_file_write(host_id, path, content): 在指定主机写入文件
     * host_system_info(host_id): 获取指定主机的基础系统信息
     * host_transfer(src_host_id, src_path, dst_host_id, dst_path): 跨主机传输同步文件
2. 真实执行与闭环验证:
   - 严禁在回复中凭空编造执行结果，所有查询、探测、文件操作必须真实调用工具。
   - 涉及跨机同步或服务部署时，部署后必须主动在目标主机调用 host_exec 验证配置语法与服务状态。
3. 极致简洁专业:
   - 回复直接提炼关键事实与执行报告，严禁冗长过程性废话。
   - 严禁输出任何 Emoji 表情符号。
4. 必须输出最终结论报告（结论闭环）:
   - 在所有多机工具调用执行完毕后，必须在最终回复文本中向用户输出多机协同的最终结论与分析报告。
   - 格式建议：
### 最终执行结论
- 总体达成情况: [已完成 / 异常]
- 节点状态与验证: [提炼各主机执行结果、服务状态或对比差异]
- 重点变更与同步: [若有跨机配置同步、脚本下发请简要列出]
   - 明确提炼各主机的执行状态、配置对比差异或服务状态。严禁仅调用工具而不输出任何总结结论，严禁静默空答！
5. 整体目标与最终验证驱动，严禁误报未完成:
   - 多机协同运维以最终达成的集群业务目标与各节点最终验证状态为唯一评判准绳。
   - 凡是在执行过程中作为前置探测、环境排查、分支条件判断的命令（如 grep、test、[ ]、pidof、which、diff、systemctl is-active 等返回非零退出码），绝不属于操作失败。
   - 凡是前期报错或状态未就绪，但已被后续步骤成功修复、重新启动、正确配置或成功同步的，均属任务圆满完成，严禁将中间排查或自愈过程误判为"任务未完成"或"失败"。
   - 判定为未完成或异常时，必须明确指出是哪一台主机的哪一项最终验证结果不达标，禁止使用笼统模糊的表述。`;

  const conversation: any[] = [
    { role: 'system', content: systemPrompt },
  ];

  // 导入历史记录
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

  // 追加当前提示词
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

  wsStore.addMessage(wsId, {
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

            // 深度思考提取
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

            // Function calling 工具捕获
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
            // 忽略异常
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
          const flush = () => {
            wsStore.updateLastMessage(wsId, (m) => ({
              ...m,
              thinking: mergedThinking || m.thinking,
              thinkingTimeMs: thinkingDuration || m.thinkingTimeMs,
              content: mergedContent,
            }));
          };
          if (now - lastFlushAt >= STREAM_FLUSH_INTERVAL_MS) {
            lastFlushAt = now;
            flush();
          } else {
            pendingFlush = flush;
          }
        }
      };

      await streamChatCompletion(
        baseUrl,
        apiKey || '',
        {
          model,
          messages: conversation,
          tools: WORKSPACE_AGENT_TOOLS,
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
        wsId
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
        wsStore.updateLastMessage(wsId, (m) => ({
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

      // 汇总本次循环生成的 tool_calls
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
          const conclusionPrompt = buildConclusionPrompt('workspace', toolCallItems);
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
              wsId
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
            wsStore.updateLastMessage(wsId, (m) => ({
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
          wsStore.updateLastMessage(wsId, (m) => ({
            ...m,
            content: accumulatedContent,
          }));
        } else if (!signal.aborted && toolCallItems.length === 0 && !accumulatedContent.trim()) {
          // 模型未返回任何文本且未调用工具时明确呈现真实状态，避免空白消息
          wsStore.updateLastMessage(wsId, (m) => ({
            ...m,
            content: '模型未返回任何内容，请重试或检查模型配置。',
          }));
        }
        break;
      }

      // 追加 Assistant 的调用意图至对话记录
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

        // 解析目标主机名称与 ID
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

        // 安全检查
        if (fnName === 'host_exec') {
          const safety = await checkSafety(fnArgs.command || '');
          toolCallItem.riskLevel = safety.risk_level;
          toolCallItem.warningMessage = safety.message;
        }

        toolCallItems.push(toolCallItem);
        wsStore.updateLastMessage(wsId, (m) => ({
          ...m,
          toolCalls: [...toolCallItems],
        }));

        if (signal.aborted) break;

        // 权限判定
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
            // 确认模式 (ask)
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
      // 执行异常时仍需给出闭环结论：保留真实执行状态汇总并追加异常原因
      const errorNote = `任务执行异常: ${err?.message || err}`;
      const closure =
        toolCallItems.length > 0 && !hasFreshConclusion()
          ? buildDeterministicConclusion(toolCallItems)
          : '';
      wsStore.updateLastMessage(wsId, (m) => ({
        ...m,
        content: [m.content, closure, errorNote].filter((part) => part && part.trim()).join('\n\n'),
      }));
    }
  } finally {
    delete abortControllers[wsId];
    wsStore.setIsThinking(wsId, false);
  }
}
