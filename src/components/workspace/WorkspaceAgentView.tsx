import React, { useState, useEffect, useRef } from 'react';
import {
  Send,
  Square,
  ChevronDown,
  ChevronRight,
  Clock,
  Terminal,
  FileCode,
  Cpu,
  ArrowRightLeft,
  Copy,
  Check,
  Loader2,
  CheckCircle2,
  XCircle,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { useWorkspaceStore, createDefaultWorkspaceAgentState } from '../../stores/useWorkspaceStore';
import { useServerStore } from '../../stores/useServerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { BUILTIN_THEMES } from '../../types/theme';
import { runWorkspaceAgentTask, abortWorkspaceAgentTask } from '../../lib/agent/workspaceRunner';
import { MarkdownView } from '../agent/MarkdownView';
import type { ToolCallItem } from '../../types';

export const WorkspaceAgentView: React.FC = () => {
  const {
    activeWorkspaceId,
    selectedHostIds,
    permissionMode,
    workspaceStates,
    setPermissionMode,
    respondApproval,
    clearMessages,
  } = useWorkspaceStore();

  const { servers } = useServerStore();
  const { themeId, terminalFontSize } = useSettingsStore();
  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

  // 动态字体大小联动（由系统全局字体配置统一驱动）
  const baseFontSize = terminalFontSize || 14;
  const subFontSize = Math.max(11, Math.round(baseFontSize * 0.86));
  const smallFontSize = Math.max(10, Math.round(baseFontSize * 0.75));
  const codeFontSize = Math.max(11, Math.round(baseFontSize * 0.9));

  const currentWsId = activeWorkspaceId || 'default';
  const agentState = workspaceStates[currentWsId] || createDefaultWorkspaceAgentState();
  const { messages, isThinking, pendingToolCall } = agentState;

  const [inputPrompt, setInputPrompt] = useState('');
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 任务耗时实时计时器（用于思考过程与执行状态）
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!isThinking) {
      setElapsedMs(0);
      return;
    }
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsedMs(Date.now() - start);
    }, 150);
    return () => clearInterval(interval);
  }, [isThinking]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const visibleServers = selectedHostIds.length > 0
    ? servers.filter((s) => selectedHostIds.includes(s.id))
    : servers;

  // 自动滚动至最新消息
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isThinking, pendingToolCall]);

  const handleSend = () => {
    const text = inputPrompt.trim();
    if (!text || isThinking) return;
    setInputPrompt('');
    runWorkspaceAgentTask(text, currentWsId);
  };

  const handleAbort = () => {
    abortWorkspaceAgentTask(currentWsId);
  };

  const handleClear = () => {
    if (isThinking) {
      abortWorkspaceAgentTask(currentWsId);
    }
    clearMessages(currentWsId);
  };

  const isMac =
    typeof navigator !== 'undefined' &&
    /(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent || navigator.platform || '');

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Mac 支持 Cmd + Enter 与 Ctrl + Enter，Windows 支持 Ctrl + Enter
    const isSendKey = isMac
      ? (e.metaKey || e.ctrlKey) && e.key === 'Enter'
      : e.ctrlKey && e.key === 'Enter';

    if (isSendKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleThinking = (msgId: string, currentVal: boolean) => {
    setExpandedThinking((prev) => ({
      ...prev,
      [msgId]: !currentVal,
    }));
  };

  const copyText = async (id: string, text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 2000);
    } catch {
      // 忽略复制失败
    }
  };

  const renderToolIcon = (name: string) => {
    switch (name) {
      case 'host_exec':
        return <Terminal className="w-3.5 h-3.5 text-indigo-400" />;
      case 'host_file_read':
        return <FileCode className="w-3.5 h-3.5 text-emerald-400" />;
      case 'host_file_write':
        return <FileCode className="w-3.5 h-3.5 text-amber-400" />;
      case 'host_transfer':
        return <ArrowRightLeft className="w-3.5 h-3.5 text-cyan-400" />;
      case 'host_system_info':
        return <Cpu className="w-3.5 h-3.5 text-purple-400" />;
      default:
        return <Terminal className="w-3.5 h-3.5 text-indigo-400" />;
    }
  };

  return (
    <section
      className="flex-1 flex flex-col overflow-hidden relative font-sans select-none transition-colors duration-200"
      style={{
        backgroundColor: currentTheme.ui.appBg,
        color: currentTheme.ui.text,
      }}
    >
      {/* 顶部工作区对话 Header */}
      <div
        className="h-10 border-b px-4 flex items-center justify-between shrink-0"
        style={{
          borderColor: currentTheme.ui.border,
          backgroundColor: currentTheme.ui.headerBg,
        }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-1.5 font-semibold shrink-0">
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: currentTheme.ui.accent }}
            />
            <span style={{ fontSize: `${subFontSize}px` }}>运维工作区</span>
          </div>
          <span className="opacity-30">|</span>
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
            <span
              className="font-mono opacity-60 shrink-0"
              style={{ fontSize: `${smallFontSize}px` }}
            >
              AI 可见主机 ({visibleServers.length} 台):
            </span>
            {visibleServers.length === 0 ? (
              <span
                className="text-amber-400/80 font-mono"
                style={{ fontSize: `${smallFontSize}px` }}
              >
                未在左侧勾选主机，点击左侧复选框添加目标
              </span>
            ) : (
              visibleServers.map((srv) => (
                <span
                  key={srv.id}
                  className="px-2 py-0.5 rounded font-mono border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 font-semibold shrink-0"
                  style={{ fontSize: `${smallFontSize}px` }}
                >
                  {srv.name}
                </span>
              ))
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* 权限模式三档切换：尺寸高度与清空按钮完全对齐 */}
          <div
            className="h-7 flex items-center rounded border p-0.5 font-mono"
            style={{
              borderColor: currentTheme.ui.border,
              backgroundColor: currentTheme.ui.cardBg,
            }}
          >
            <button
              onClick={() => setPermissionMode('read_only')}
              className={`h-full px-2.5 rounded transition-colors cursor-pointer flex items-center justify-center font-medium ${
                permissionMode === 'read_only'
                  ? 'bg-white/10 font-bold text-emerald-400'
                  : 'opacity-60 hover:opacity-100'
              }`}
              style={{ fontSize: `${subFontSize}px` }}
            >
              只读
            </button>
            <button
              onClick={() => setPermissionMode('ask')}
              className={`h-full px-2.5 rounded transition-colors cursor-pointer flex items-center justify-center font-medium ${
                permissionMode === 'ask'
                  ? 'bg-white/10 font-bold text-emerald-400'
                  : 'opacity-60 hover:opacity-100'
              }`}
              style={{ fontSize: `${subFontSize}px` }}
            >
              确认
            </button>
            <button
              onClick={() => setPermissionMode('full')}
              className={`h-full px-2.5 rounded transition-colors cursor-pointer flex items-center justify-center font-medium ${
                permissionMode === 'full'
                  ? 'bg-white/10 font-bold text-emerald-400'
                  : 'opacity-60 hover:opacity-100'
              }`}
              style={{ fontSize: `${subFontSize}px` }}
            >
              自动
            </button>
          </div>

          {/* 清空对话按钮：与权限按钮保持同高同字号 */}
          <button
            onClick={handleClear}
            className="h-7 px-2.5 rounded border cursor-pointer opacity-70 hover:opacity-100 transition-opacity flex items-center gap-1 font-medium"
            style={{
              borderColor: currentTheme.ui.border,
              backgroundColor: currentTheme.ui.cardBg,
              color: currentTheme.ui.text,
              fontSize: `${subFontSize}px`,
            }}
            title="清空对话"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>清空</span>
          </button>
        </div>
      </div>

      {/* 对话主体视口 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3.5 select-text">
        {messages.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center h-full space-y-2 text-center p-4"
            style={{ color: currentTheme.ui.textMuted }}
          >
            <Terminal className="w-8 h-8 opacity-40" />
            <p
              className="font-medium"
              style={{ color: currentTheme.ui.text, fontSize: `${baseFontSize}px` }}
            >
              工作区智能运维就绪
            </p>
            <p
              className="leading-relaxed max-w-md"
              style={{ fontSize: `${subFontSize}px` }}
            >
              已就绪。AI 可协同访问勾选的主机，输入运维诉求，将自主调度执行排障与诊断。
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            if (msg.role === 'user') {
              const isCopied = copiedId === msg.id;
              return (
                <div key={msg.id} className="flex flex-col items-end group select-text">
                  <div className="flex items-start gap-1.5 max-w-[85%]">
                    <button
                      type="button"
                      onClick={() => copyText(msg.id, msg.content)}
                      className="opacity-0 group-hover:opacity-70 hover:!opacity-100 p-1 rounded transition-all cursor-pointer shrink-0 mt-1"
                      style={{ color: isCopied ? '#10b981' : currentTheme.ui.textMuted }}
                      title={isCopied ? '已复制' : '复制提问'}
                    >
                      {isCopied ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                    <div
                      className="border rounded-lg px-3 py-2 break-words leading-relaxed select-text"
                      style={{
                        backgroundColor: currentTheme.isDark
                          ? 'rgba(99, 102, 241, 0.2)'
                          : 'rgba(9, 105, 218, 0.1)',
                        borderColor: currentTheme.ui.accent,
                        color: currentTheme.ui.text,
                        fontSize: `${baseFontSize}px`,
                      }}
                    >
                      {msg.content}
                    </div>
                  </div>
                  <span
                    className="mt-1 mr-1 select-none"
                    style={{ color: currentTheme.ui.textMuted, fontSize: `${smallFontSize}px` }}
                  >
                    {new Date(msg.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              );
            }

            const isLatestAssistant =
              isThinking && msg.id === messages[messages.length - 1]?.id;
            const isThinkingExpanded =
              expandedThinking[msg.id] !== undefined
                ? expandedThinking[msg.id]
                : isLatestAssistant;

            return (
              <div
                key={msg.id}
                className="space-y-2 max-w-[90%]"
              >
                {/* 正在连接模型并构思阶段占位 */}
                {isLatestAssistant &&
                  !msg.thinking &&
                  !msg.content &&
                  (!msg.toolCalls || msg.toolCalls.length === 0) && (
                    <div
                      className="flex items-center gap-2 p-2.5 rounded border opacity-90 transition-opacity"
                      style={{
                        backgroundColor: currentTheme.ui.cardBg,
                        borderColor: currentTheme.ui.border,
                        color: currentTheme.ui.textMuted,
                        fontSize: `${subFontSize}px`,
                      }}
                    >
                      <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-indigo-400" />
                      <span>
                        正在连接模型并构思跨机方案 ({(elapsedMs / 1000).toFixed(1)}s)...
                      </span>
                    </div>
                  )}

                {/* 思考过程卡片 */}
                {msg.thinking && (
                  <div
                    className="border rounded p-2.5 transition-colors"
                    style={{
                      backgroundColor: currentTheme.ui.cardBg,
                      borderColor: currentTheme.ui.border,
                      fontSize: `${subFontSize}px`,
                    }}
                  >
                    <div
                      className="flex items-center justify-between font-medium select-none"
                      style={{ color: currentTheme.ui.accent, fontSize: `${subFontSize}px` }}
                    >
                      <span
                        onClick={() => toggleThinking(msg.id, isThinkingExpanded)}
                        className="flex items-center gap-1.5 cursor-pointer flex-1"
                      >
                        {isLatestAssistant && !msg.content ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                        ) : (
                          <Clock className="w-3.5 h-3.5 shrink-0" />
                        )}
                        <span>
                          {isLatestAssistant && !msg.content
                            ? `深度思考推理中 (${(elapsedMs / 1000).toFixed(1)}s)`
                            : msg.thinkingTimeMs
                            ? `思考与推理分析 (${(msg.thinkingTimeMs / 1000).toFixed(1)}s)`
                            : '思考与推理分析'}
                        </span>
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            copyText(`think-${msg.id}`, msg.thinking || '');
                          }}
                          className="p-1 rounded hover:opacity-100 opacity-60 transition-opacity cursor-pointer"
                          style={{
                            color:
                              copiedId === `think-${msg.id}`
                                ? '#10b981'
                                : currentTheme.ui.textMuted,
                          }}
                          title={
                            copiedId === `think-${msg.id}` ? '已复制' : '复制思考内容'
                          }
                        >
                          {copiedId === `think-${msg.id}` ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                        <span
                          onClick={() => toggleThinking(msg.id, isThinkingExpanded)}
                          className="cursor-pointer p-0.5"
                        >
                          {isThinkingExpanded ? (
                            <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                          )}
                        </span>
                      </div>
                    </div>
                    {isThinkingExpanded && (
                      <div
                        className="mt-2 whitespace-pre-wrap leading-relaxed border-t pt-2 font-mono"
                        style={{
                          borderColor: currentTheme.ui.border,
                          color: currentTheme.ui.textMuted,
                          fontSize: `${codeFontSize}px`,
                        }}
                      >
                        {msg.thinking}
                        {isLatestAssistant && !msg.content && (
                          <span className="inline-block w-1.5 h-3.5 ml-1 bg-indigo-400 animate-pulse align-middle" />
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* 多机工具执行卡片列表 */}
                {msg.toolCalls &&
                  msg.toolCalls.map((tc: ToolCallItem) => {
                    const isPending = tc.status === 'pending';
                    const isExecuting = tc.status === 'executing';
                    const isRejected = tc.status === 'rejected';

                    return (
                      <div
                        key={tc.id}
                        className="border rounded p-2.5 transition-colors"
                        style={{
                          backgroundColor:
                            tc.riskLevel === 'dangerous'
                              ? 'rgba(239, 68, 68, 0.15)'
                              : isPending
                              ? 'rgba(245, 158, 11, 0.15)'
                              : currentTheme.ui.cardBg,
                          borderColor:
                            tc.riskLevel === 'dangerous'
                              ? '#ef4444'
                              : isPending
                              ? '#f59e0b'
                              : currentTheme.ui.border,
                          fontSize: `${subFontSize}px`,
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <div
                            className="flex items-center gap-1.5 font-terminal"
                            style={{ fontSize: `${subFontSize}px` }}
                          >
                            <span className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-blue-500/20 text-blue-400 font-bold border border-blue-500/30">
                              {tc.hostName || tc.hostId || '集群'}
                            </span>
                            {renderToolIcon(tc.name)}
                            <span
                              className="font-medium"
                              style={{ color: currentTheme.ui.text }}
                            >
                              {tc.name}
                            </span>
                          </div>

                          <div
                            className="flex items-center gap-1"
                            style={{ fontSize: `${smallFontSize}px` }}
                          >
                            {isExecuting && (
                              <span
                                className="flex items-center gap-1"
                                style={{ color: currentTheme.ui.accent }}
                              >
                                <Loader2 className="w-3 h-3 animate-spin" /> 执行中
                              </span>
                            )}
                            {tc.status === 'success' && (
                              <span className="text-emerald-500 flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3" /> 成功{' '}
                                {tc.durationMs ? `(${tc.durationMs}ms)` : ''}
                              </span>
                            )}
                            {isRejected && (
                              <span
                                className="flex items-center gap-1"
                                style={{ color: currentTheme.ui.textMuted }}
                              >
                                <XCircle className="w-3 h-3" /> 已取消
                              </span>
                            )}
                            {tc.status === 'failed' && (
                              <span className="text-red-500 flex items-center gap-1">
                                <ShieldAlert className="w-3 h-3" /> 失败
                              </span>
                            )}
                            {isPending && (
                              <span className="text-amber-500 font-medium">待授权</span>
                            )}
                          </div>
                        </div>

                        {/* 执行参数与路径展示 */}
                        <div
                          className="mt-1 font-terminal px-2 py-1 rounded border break-all"
                          style={{
                            backgroundColor: currentTheme.ui.inputBg,
                            borderColor: currentTheme.ui.border,
                            color: currentTheme.ui.text,
                            fontSize: `${codeFontSize}px`,
                          }}
                        >
                          {tc.name === 'host_exec' && tc.args.command}
                          {tc.name === 'host_file_read' && `读取: ${tc.args.path}`}
                          {tc.name === 'host_file_write' &&
                            `写入: ${tc.args.path} (${tc.args.content?.length || 0} 字节)`}
                          {tc.name === 'host_transfer' &&
                            `传输: [${tc.args.src_host_id}] ${tc.args.src_path} -> [${tc.args.dst_host_id}] ${tc.args.dst_path}`}
                          {tc.name === 'host_system_info' && '收集主机基本系统信息'}
                        </div>

                        {/* 危险警告 */}
                        {tc.warningMessage && (
                          <div
                            className="mt-1.5 text-amber-500 flex items-center gap-1"
                            style={{ fontSize: `${smallFontSize}px` }}
                          >
                            <ShieldAlert className="w-3 h-3 shrink-0" />
                            <span>{tc.warningMessage}</span>
                          </div>
                        )}

                        {/* 工具输出结果 */}
                        {tc.result && (
                          <div
                            className="mt-1.5 font-terminal p-1.5 rounded max-h-36 overflow-y-auto whitespace-pre-wrap border select-text"
                            style={{
                              backgroundColor: currentTheme.ui.inputBg,
                              borderColor: currentTheme.ui.border,
                              color: currentTheme.ui.textMuted,
                              fontSize: `${codeFontSize}px`,
                            }}
                          >
                            {tc.result}
                          </div>
                        )}

                        {/* 单步审批操作按钮 */}
                        {isPending && pendingToolCall?.id === tc.id && (
                          <div
                            className="mt-2.5 flex items-center justify-end gap-2 pt-1 border-t"
                            style={{ borderColor: currentTheme.ui.border }}
                          >
                            <button
                              onClick={() => respondApproval(currentWsId, false)}
                              className="px-2.5 py-1 rounded cursor-pointer transition-colors"
                              style={{
                                backgroundColor: currentTheme.ui.hoverBg,
                                color: currentTheme.ui.text,
                                fontSize: `${subFontSize}px`,
                              }}
                            >
                              拒绝
                            </button>
                            <button
                              onClick={() => respondApproval(currentWsId, true)}
                              className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-medium cursor-pointer"
                              style={{ fontSize: `${subFontSize}px` }}
                            >
                              允许执行
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}

                {/* 独立待核准高危操作审批卡片 (当未绑定在具体步骤中时) */}
                {pendingToolCall &&
                  isLatestAssistant &&
                  !msg.toolCalls?.some((t) => t.id === pendingToolCall.id) && (
                    <div
                      className="border rounded p-3 font-mono space-y-2"
                      style={{
                        backgroundColor: 'rgba(245, 158, 11, 0.15)',
                        borderColor: '#f59e0b',
                        fontSize: `${subFontSize}px`,
                      }}
                    >
                      <div className="flex items-center justify-between pb-1 border-b border-amber-500/30">
                        <div className="flex items-center gap-1.5 text-amber-400 font-semibold">
                          <span className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30">
                            {pendingToolCall.hostName || pendingToolCall.hostId || '目标节点'}
                          </span>
                          <ShieldAlert className="w-4 h-4 text-amber-400" />
                          <span>待核准操作: {pendingToolCall.name}</span>
                        </div>
                        <span
                          className="opacity-75"
                          style={{ fontSize: `${smallFontSize}px` }}
                        >
                          仅影响目标节点
                        </span>
                      </div>

                      <div
                        className="text-gray-200 space-y-1"
                        style={{ fontSize: `${smallFontSize}px` }}
                      >
                        <div>
                          执行目标:{' '}
                          <strong className="text-white">
                            {pendingToolCall.hostName || pendingToolCall.hostId}
                          </strong>
                        </div>
                        {pendingToolCall.args.command && (
                          <div>
                            待运行指令:{' '}
                            <code className="text-amber-300 font-bold">
                              {pendingToolCall.args.command}
                            </code>
                          </div>
                        )}
                        {pendingToolCall.args.path && (
                          <div>
                            目标文件:{' '}
                            <code className="text-amber-300">
                              {pendingToolCall.args.path}
                            </code>
                          </div>
                        )}
                        {pendingToolCall.warningMessage && (
                          <div className="text-red-400">
                            告警原因: {pendingToolCall.warningMessage}
                          </div>
                        )}
                      </div>

                      <div className="pt-1 flex items-center justify-end gap-2">
                        <button
                          onClick={() => respondApproval(currentWsId, false)}
                          className="px-2.5 py-1 rounded cursor-pointer transition-colors"
                          style={{
                            backgroundColor: currentTheme.ui.hoverBg,
                            color: currentTheme.ui.text,
                            fontSize: `${subFontSize}px`,
                          }}
                        >
                          拒绝
                        </button>
                        <button
                          onClick={() => respondApproval(currentWsId, true)}
                          className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-medium cursor-pointer"
                          style={{ fontSize: `${subFontSize}px` }}
                        >
                          允许执行
                        </button>
                      </div>
                    </div>
                  )}

                {/* AI 结论或回复内容卡片 */}
                {msg.content && (
                  <div
                    className="border rounded-lg p-3 leading-relaxed transition-colors select-text group/content"
                    style={{
                      backgroundColor: currentTheme.ui.cardBg,
                      borderColor: currentTheme.ui.border,
                      color: currentTheme.ui.text,
                      fontSize: `${baseFontSize}px`,
                    }}
                  >
                    <div
                      className="flex items-center justify-between pb-1.5 mb-2 border-b select-none"
                      style={{ borderColor: currentTheme.ui.border }}
                    >
                      <span className="text-[11px] font-medium opacity-60">
                        AI 分析结果
                      </span>
                      <button
                        type="button"
                        onClick={() => copyText(msg.id, msg.content)}
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium cursor-pointer hover:opacity-100 opacity-70 transition-all"
                        style={{
                          color: copiedId === msg.id ? '#10b981' : currentTheme.ui.text,
                          backgroundColor: currentTheme.ui.hoverBg,
                        }}
                        title={copiedId === msg.id ? '已复制' : '复制回复'}
                      >
                        {copiedId === msg.id ? (
                          <>
                            <Check className="w-3 h-3 text-emerald-400" />
                            <span>已复制</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" />
                            <span>复制</span>
                          </>
                        )}
                      </button>
                    </div>
                    <MarkdownView
                      content={msg.content}
                      theme={currentTheme}
                      baseFontSize={baseFontSize}
                      isStreaming={isLatestAssistant && isThinking}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}

        {/* 执行中悬浮状态条 */}
        {isThinking && (
          <div
            className="flex items-center justify-between gap-2 p-2 rounded border transition-colors"
            style={{
              backgroundColor: currentTheme.ui.hoverBg,
              borderColor: currentTheme.ui.border,
              fontSize: `${subFontSize}px`,
            }}
          >
            <div
              className="flex items-center gap-2 min-w-0"
              style={{ color: currentTheme.ui.accent }}
            >
              <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
              <span className="truncate">Agent 正在分析与执行...</span>
            </div>
            <button
              onClick={handleAbort}
              className="px-2.5 py-0.5 rounded border text-red-400 hover:text-red-300 border-red-800/40 hover:bg-red-950/40 cursor-pointer flex items-center gap-1 shrink-0 font-medium transition-colors"
              style={{ fontSize: `${smallFontSize}px` }}
              title="中止任务"
            >
              <Square className="w-2.5 h-2.5 fill-current" />
              中止
            </button>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 底部输入框 */}
      <div
        className="p-3 border-t transition-colors"
        style={{
          backgroundColor: currentTheme.ui.cardBg,
          borderColor: currentTheme.ui.border,
        }}
      >
        {/* 快捷意图建议 */}
        <div className="flex items-center gap-2 font-mono overflow-x-auto no-scrollbar mb-2">
          <span
            className="text-gray-400 shrink-0 select-none"
            style={{ fontSize: `${smallFontSize}px` }}
          >
            快捷诉求:
          </span>
          <button
            onClick={() =>
              setInputPrompt('对比可见主机上的 Nginx 配置文件差异')
            }
            className="px-2 py-0.5 rounded border border-white/10 hover:bg-white/5 text-gray-300 cursor-pointer shrink-0 transition-colors"
            style={{ fontSize: `${smallFontSize}px` }}
          >
            跨机配置对比
          </button>
          <button
            onClick={() =>
              setInputPrompt(
                '检查所有可见主机的磁盘使用率，并清理超过 30 天的系统日志'
              )
            }
            className="px-2 py-0.5 rounded border border-white/10 hover:bg-white/5 text-gray-300 cursor-pointer shrink-0 transition-colors"
            style={{ fontSize: `${smallFontSize}px` }}
          >
            集群磁盘体检
          </button>
          <button
            onClick={() =>
              setInputPrompt(
                '查看各可见主机上的端口占用与服务监听状态并汇总报告'
              )
            }
            className="px-2 py-0.5 rounded border border-white/10 hover:bg-white/5 text-gray-300 cursor-pointer shrink-0 transition-colors"
            style={{ fontSize: `${smallFontSize}px` }}
          >
            集群端口巡检
          </button>
        </div>

        <div className="relative">
          <textarea
            ref={inputRef}
            value={inputPrompt}
            onChange={(e) => setInputPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isThinking}
            placeholder={
              isThinking
                ? 'Agent 正在执行任务中...'
                : isMac
                ? '描述跨机运维诉求 (Cmd + Enter 发送)...'
                : '描述跨机运维诉求 (Ctrl + Enter 发送)...'
            }
            rows={2}
            className="w-full rounded-lg p-2.5 border focus:outline-none resize-none transition-colors"
            style={{
              backgroundColor: currentTheme.ui.inputBg,
              borderColor: currentTheme.ui.border,
              color: currentTheme.ui.text,
              fontSize: `${baseFontSize}px`,
            }}
          />
          <div className="flex items-center justify-between mt-1.5">
            <span
              style={{
                color: currentTheme.ui.textMuted,
                fontSize: `${smallFontSize}px`,
              }}
            >
              {isMac ? 'Cmd + Enter 发送 / Enter 换行' : 'Ctrl + Enter 发送 / Enter 换行'}
            </span>
            {isThinking ? (
              <button
                onClick={handleAbort}
                className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white rounded font-medium cursor-pointer flex items-center gap-1.5 transition-colors"
                style={{ fontSize: `${subFontSize}px` }}
                title="中止执行"
              >
                <Square className="w-3 h-3 fill-current" />
                中止
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!inputPrompt.trim()}
                className="px-3 py-1 disabled:opacity-50 rounded font-semibold cursor-pointer flex items-center gap-1 transition-opacity hover:opacity-90"
                style={{
                  backgroundColor: '#23d18b',
                  color: '#064e3b',
                  fontSize: `${subFontSize}px`,
                }}
              >
                <Send className="w-3 h-3" />
                发送
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
