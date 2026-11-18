import { Channel, invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useServerStore } from '../../stores/useServerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { WORKSPACE_AGENT_TOOLS, checkSafety, executeWorkspaceToolCall } from './workspaceTools';
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
  dropIncompleteConclusion,
  isConclusionComplete,
  isTrailingConclusionComplete,
  parseThinkTag,
  sanitizeHistoryContent,
  upsertConclusion,
} from './summary';
import type { ToolCallItem } from '../../types';

const abortControllers: Record<string, AbortController> = {};
const currentRequestIds: Record<string, string> = {};

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
      // 保证 Promise 只被结算一次，避免解析异常后再被 done 事件覆盖
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abortHandler);
        if (wsId) delete currentRequestIds[wsId];
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
  const historyMessages = agentState.messages.slice(-HISTORY_MESSAGE_LIMIT);

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
        `- ${s.name}（标识: "${s.id}" 或 "${s.name}"，地址: ${s.host}:${s.port}，用户: ${s.username}${s.tags ? `，标签: ${s.tags}` : ''}）`
    )
    .join('\n');

  const systemPrompt = `你是一名专业的 Linux 运维工作区智能体，具备多机协同编排与自主执行能力。

当前工作区可操作的主机节点：
${hostDescriptions}

执行准则：
1. 多机协同
   - 你拥有多台主机的全局视野，可按用户意图自主规划步骤并访问不同主机。
   - host_id 参数支持传入主机 ID 或主机名称（如 ${visibleServers.map((s) => `"${s.name}"`).join(' / ')}）。
   - 可用工具：
     * host_exec(host_id, command)：在指定主机执行 shell 命令
     * host_file_read(host_id, path)：读取指定主机文件内容
     * host_file_write(host_id, path, content)：在指定主机写入文件
     * host_system_info(host_id)：获取指定主机的基础系统信息
     * host_transfer(src_host_id, src_path, dst_host_id, dst_path)：跨主机传输同步文件
2. 真实执行与闭环验证
   - 不编造执行结果，所有查询、探测与文件操作必须真实调用工具。
   - 跨机同步或服务部署后，必须在目标主机调用 host_exec 验证配置与服务状态。
3. 表达风格
   - 直接给出关键事实与执行报告，省略过程性叙述。
   - 不使用 Emoji。
4. 必须给出最终结论
   - 所有工具调用结束后，必须在回复正文中给出多机协同结论，格式如下：
### 最终执行结论
- 总体达成情况: [已完成 / 异常] + 一句话概述
- 节点状态与验证: [各主机真实数据：服务名/进程 PID/端口/状态，逐节点列出]
- 重点变更与同步: [跨机配置同步或脚本下发；无则写"无"]
   - 「节点状态与验证」必须引用本轮工具返回的真实数据，不能只写"运行正常"之类的空泛描述，也不要写成半句。
   - 不允许只调用工具而无任何总结，也不允许空回复。
5. 以最终状态判定成败
   - 判断依据是集群业务目标与各节点最终验证状态，而非中间过程。
   - 前置探测、条件判断类命令（grep、test、[ ]、pidof、which、diff、systemctl is-active 等）返回非零退出码属于正常结果，不代表失败。
   - 中间出现的报错若已被后续步骤修复或成功同步，应判定为已完成；不要因为过程曲折就写成"任务未完成"或"失败"。
   - 确实异常时，需指明是哪台主机的哪项最终验证未达标，避免笼统表述。`;

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

  const runtime = resolveAiRuntime(settingsStore.settings);
  const baseUrl = runtime.baseUrl;
  const apiKey = runtime.apiKey;
  const model = runtime.model;

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

  // 模型未配置完整时直接给出明确配置提示，不再用厂商默认值静默兜底
  const configError = validateAiRuntime(runtime);
  if (configError) {
    wsStore.updateLastMessage(wsId, (m) => ({ ...m, content: configError }));
    wsStore.setIsThinking(wsId, false);
    delete abortControllers[wsId];
    return;
  }

  const maxLoops = MAX_AGENT_LOOPS;
  let loopCount = 0;

  let accumulatedThinking = '';
  let accumulatedContent = '';
  // 每次工具执行完毕后重置结论基线，确保只认最近一次执行之后的结论文本
  let conclusionBaseline = 0;
  // 最近一次输出的结束原因是否属于被截断，截断的结论一律视为未闭环
  let lastSegmentTruncated = false;
  // 截断提示独立保存：兜底替换残句后仍需向用户明示输出被截断
  let conclusionFinishNote = '';
  const hasFreshConclusion = () =>
    isConclusionComplete(accumulatedContent.slice(conclusionBaseline), {
      truncated: lastSegmentTruncated,
    });

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
        wsId
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
        wsStore.updateLastMessage(wsId, (m) => ({
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

      // 服务端明确的截断/拦截视为未闭环；内容本身的完整性由 isConclusionComplete 兜底校验
      lastSegmentTruncated =
        lastFinishReason === 'length' || lastFinishReason === 'content_filter';

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

      // 输出被截断/被拦截必须明示，避免用户误以为任务正常结束
      const finishNote = describeFinishReason(lastFinishReason);
      if (finishNote) {
        accumulatedContent = accumulatedContent.trim()
          ? `${accumulatedContent.trim()}\n\n${finishNote}`
          : finishNote;
        wsStore.updateLastMessage(wsId, (m) => ({
          ...m,
          content: accumulatedContent,
        }));
      }

      if (finalToolCalls.length === 0) {
        // 无更多工具调用
        // 已执行过工具但结论缺失/不完整（字段不全或被截断）时，显式请求模型补充最终结论
        if (
          toolCallItems.length > 0 &&
          !signal.aborted &&
          !hasFreshConclusion()
        ) {
          // 结论请求基于独立消息序列构造，不改动原对话上下文
          const conclusionPrompt = buildConclusionPrompt('workspace', toolCallItems);
          loopThinking = '';
          loopContent = '';
          thinkState = { inThink: false, pending: '' };
          // 预览基于去掉残句结论的正文，避免失败轮次的半句结论残留在界面
          const conclusionBase = isTrailingConclusionComplete(accumulatedContent)
            ? accumulatedContent
            : dropIncompleteConclusion(accumulatedContent);

          let reportContent = '';
          for (let attempt = 0; attempt <= CONCLUSION_RETRY_TIMES; attempt++) {
            // 每个 attempt 使用独立缓冲：失败的残句直接丢弃，不拼接进最终结论
            let attemptContent = '';
            let summaryBuffer = '';
            let summaryFinishReason: string | undefined;

            const collectAttempt = (lines: string[]) => {
              for (const line of lines) {
                const parsedLine = parseSseDataLine(line);
                if (!parsedLine) continue;
                if (parsedLine.error) {
                  throw new Error(parsedLine.error);
                }
                if (parsedLine.reasoning) {
                  loopThinking += parsedLine.reasoning;
                }
                if (parsedLine.content) {
                  const parsedThink = parseThinkTag(parsedLine.content, thinkState);
                  thinkState = parsedThink.state;
                  loopThinking += parsedThink.thinking;
                  attemptContent += parsedThink.content;
                }
                if (parsedLine.finishReason) {
                  summaryFinishReason = parsedLine.finishReason;
                }
              }

              if (attemptContent.trim()) {
                const mergedThinking = accumulatedThinking
                  ? `${accumulatedThinking}\n\n${loopThinking}`.trim()
                  : loopThinking;
                const mergedContent = conclusionBase
                  ? `${conclusionBase}\n\n${attemptContent}`.trim()
                  : attemptContent;
                wsStore.updateLastMessage(wsId, (m) => ({
                  ...m,
                  thinking: mergedThinking || m.thinking,
                  content: mergedContent,
                }));
              }
            };

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
                  collectAttempt(lines);
                },
                wsId
              );
              if (summaryBuffer.trim()) {
                collectAttempt([summaryBuffer.trim()]);
              }
            } catch (err: any) {
              if (signal.aborted) break;
              // 最后一次重试仍失败才交由确定性兜底，同时保留失败说明避免静默
              if (attempt === CONCLUSION_RETRY_TIMES) {
                conclusionFinishNote = `> 结论请求失败: ${err?.message || err}`;
              }
              continue;
            }

            if (signal.aborted) break;

            const attemptTruncated =
              summaryFinishReason === 'length' || summaryFinishReason === 'content_filter';
            const attemptComplete = isConclusionComplete(attemptContent, {
              truncated: attemptTruncated,
            });

            // 内容不完整时保留本轮结果用于最后兜底，字段齐全才采纳并停止重试
            if (attemptContent.trim()) {
              reportContent = attemptContent.trim();
              const retryNote = describeFinishReason(summaryFinishReason);
              if (retryNote && !attemptComplete) {
                conclusionFinishNote = retryNote;
              }
            }
            if (attemptComplete) break;
          }

          if (reportContent.trim()) {
            accumulatedContent = upsertConclusion(accumulatedContent, reportContent);
            lastSegmentTruncated = !isTrailingConclusionComplete(accumulatedContent);
            wsStore.updateLastMessage(wsId, (m) => ({
              ...m,
              content: accumulatedContent,
            }));
          }
        }

        // 兜底闭环：模型未产出完整结论时，基于真实执行状态补齐，杜绝静默空答或残句结论
        if (
          !signal.aborted &&
          toolCallItems.length > 0 &&
          !hasFreshConclusion()
        ) {
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
          const safety = await checkSafety(
            fnArgs.command || '',
            settingsStore.settings.danger_level
          );
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

    // 轮次耗尽闭环：达到最大循环仍无完整结论时，依据真实执行状态补齐，避免静默结束
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
      // 执行异常时仍需给出闭环结论：保留真实执行状态汇总并追加异常原因
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
