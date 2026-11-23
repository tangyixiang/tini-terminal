import React, { useState, useRef, useEffect } from 'react';
import {
  Loader2,
  ChevronRight,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Terminal,
  FileCode,
  Folder,
  Cpu,
  Trash2,
  Square,
  Copy,
  Check,
  Maximize2,
  Minimize2,
  ArrowDown,
  Download,
  UserCheck,
  Eye,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAgentStore, createDefaultSessionState } from '../../stores/useAgentStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { runAgentTask, abortAgentTask } from '../../lib/agent/runner';
import { BUILTIN_THEMES } from '../../types/theme';
import { maxAiPanelWidth, MIN_AI_PANEL_WIDTH } from '../../lib/layout';
import { useViewportWidth } from '../../lib/useViewportWidth';
import { isMacPlatform } from '../../lib/platform';
import { MiniTerminalConsole } from './MiniTerminalConsole';
import type { SessionContext, ToolCallItem } from '../../types';
import { MarkdownView } from './MarkdownView';
import { ThinkingCard } from './shared/ThinkingCard';
import { ApprovalBanner } from './shared/ApprovalBanner';
import { ChatComposer } from './shared/ChatComposer';

export const AgentPanel: React.FC = () => {
  const [input, setInput] = useState('');
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUpRef = useRef(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  const { tabs, activeTabId } = useTerminalStore();
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const currentTabId = activeTab?.id || 'global';

  const handleCopyText = async (id: string, text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 2000);
    } catch {
      // 忽略复制异常
    }
  };

  const {
    sessions,
    executionMode,
    attachTerminalContext,
    setExecutionMode,
    setAttachTerminalContext,
    respondApproval,
    clearMessages,
    loadHistory,
  } = useAgentStore();

  const [liveContext, setLiveContext] = useState<SessionContext | null>(null);
  const persistKey = activeTab
    ? activeTab.isSsh && activeTab.server
      ? `srv:${activeTab.server.id}`
      : 'local'
    : '';

  // 自动加载当前主机的持久化对话历史
  useEffect(() => {
    if (activeTab && persistKey) {
      loadHistory(activeTab.id, persistKey);
    }
  }, [activeTab?.id, persistKey, loadHistory]);

  // 实时同步当前终端会话上下文（用户切换 su / cwd / 退出码）
  useEffect(() => {
    if (!activeTab || !window.__TAURI_INTERNALS__) {
      setLiveContext(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const ctx = await invoke<SessionContext | null>('get_session_context', {
          sessionId: activeTab.sessionId,
        });
        if (!cancelled) setLiveContext(ctx);
      } catch {}
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeTab?.sessionId]);

  const currentSessionState = sessions[currentTabId] || createDefaultSessionState();
  const messages = currentSessionState.messages;
  const isThinking = currentSessionState.isThinking;
  const pendingToolCall = currentSessionState.pendingToolCall;

  // 响应终端右键菜单「发送给 AI 诊断 / 解释选中内容」事件
  useEffect(() => {
    const onAskWithContext = (e: Event) => {
      const detail = (e as CustomEvent<{ prompt: string; autoSend?: boolean }>).detail;
      if (!detail?.prompt) return;
      if (detail.autoSend && activeTab && !isThinking) {
        scrollToBottom();
        runAgentTask(detail.prompt, activeTab.id);
      } else {
        setInput(detail.prompt);
      }
    };
    window.addEventListener('agent:ask-with-context', onAskWithContext);
    return () => window.removeEventListener('agent:ask-with-context', onAskWithContext);
  }, [activeTab?.id, isThinking]);

  const {
    themeId,
    aiPanelWidth,
    sidebarWidth,
    toggleAiPanelWide,
    toggleAiPanel,
    terminalFontSize,
  } = useSettingsStore();
  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

  // 追踪窗口宽度，保证面板宽度上限始终跟随当前视口
  const viewportWidth = useViewportWidth();
  const panelMaxWidth = maxAiPanelWidth(viewportWidth, sidebarWidth);
  const resolvedPanelWidth = Math.max(
    MIN_AI_PANEL_WIDTH,
    Math.min(aiPanelWidth, panelMaxWidth)
  );

  // 动态字体大小联动（由系统字体配置统一驱动）
  const baseFontSize = terminalFontSize || 14;
  const subFontSize = Math.max(11, Math.round(baseFontSize * 0.86));
  const smallFontSize = Math.max(10, Math.round(baseFontSize * 0.75));
  const codeFontSize = Math.max(11, Math.round(baseFontSize * 0.9));

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

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    isUserScrolledUpRef.current = !isAtBottom;
    setShowScrollBottom(!isAtBottom);
  };

  useEffect(() => {
    if (!isUserScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, pendingToolCall, isThinking]);

  const scrollToBottom = () => {
    isUserScrolledUpRef.current = false;
    setShowScrollBottom(false);
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isThinking || !activeTab) return;
    setInput('');
    scrollToBottom();
    runAgentTask(trimmed, currentTabId);
  };

  const handleAbort = () => {
    abortAgentTask(currentTabId);
  };

  const handleClear = () => {
    if (isThinking) {
      abortAgentTask(currentTabId);
    }
    clearMessages(currentTabId, persistKey);
  };

  const handleExportMarkdown = () => {
    if (messages.length === 0) return;
    const md = messages
      .map((m) => {
        const time = new Date(m.timestamp).toLocaleString();
        const roleLabel = m.role === 'user' ? '用户提问' : 'AI 运维分析';
        const toolsMd = (m.toolCalls || [])
          .map(
            (tc) =>
              `- 工具 \`${tc.name}\` (${tc.status}): \`${
                tc.name === 'terminal_exec' ? tc.args?.command || '' : JSON.stringify(tc.args || {})
              }\``
          )
          .join('\n');
        return `## ${roleLabel} (${time})\n\n${toolsMd ? `${toolsMd}\n\n` : ''}${m.content || ''}`;
      })
      .join('\n\n---\n\n');
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tini-ops-report-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRespondApproval = (allowed: boolean) => {
    respondApproval(currentTabId, allowed);
  };

  const isMac = isMacPlatform();

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

  const toggleThinking = (msgId: string, currentExpanded: boolean) => {
    setExpandedThinking((prev) => ({
      ...prev,
      [msgId]: !currentExpanded,
    }));
  };

  const renderToolIcon = (name: string) => {
    switch (name) {
      case 'terminal_exec':
        return <Terminal className="w-3.5 h-3.5 text-indigo-400" />;
      case 'file_read':
        return <FileCode className="w-3.5 h-3.5 text-emerald-400" />;
      case 'file_write':
        return <FileCode className="w-3.5 h-3.5 text-amber-400" />;
      case 'file_list':
        return <Folder className="w-3.5 h-3.5 text-blue-400" />;
      case 'system_info':
        return <Cpu className="w-3.5 h-3.5 text-purple-400" />;
      default:
        return <Terminal className="w-3.5 h-3.5" />;
    }
  };

  return (
    <aside
      className="border-l flex flex-col shrink-0 select-none transition-colors duration-200 overflow-hidden"
      style={{
        width: resolvedPanelWidth,
        backgroundColor: currentTheme.ui.agentBg,
        borderColor: currentTheme.ui.border,
      }}
    >
      {/* 顶部控制栏 */}
      <div
        className="h-10 px-3 border-b flex items-center justify-between transition-colors shrink-0 overflow-hidden"
        style={{ borderColor: currentTheme.ui.border }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: currentTheme.ui.accent }}
          />
          <span
            className="font-semibold whitespace-nowrap"
            style={{ color: currentTheme.ui.text, fontSize: `${subFontSize}px` }}
          >
            AI 智能运维
          </span>
          {activeTab ? (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded font-mono truncate max-w-[130px] border"
              style={{
                backgroundColor: currentTheme.ui.cardBg,
                borderColor: currentTheme.ui.border,
                color: currentTheme.ui.textMuted,
              }}
              title={`已绑定终端: ${activeTab.title}`}
            >
              {activeTab.title}
            </span>
          ) : (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded font-mono opacity-50"
              style={{ color: currentTheme.ui.textMuted }}
            >
              未连接
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {isThinking && (
            <button
              onClick={handleAbort}
              className="px-2 py-0.5 rounded cursor-pointer text-red-400 hover:text-red-300 border border-red-800/40 hover:bg-red-950/40 transition-colors flex items-center gap-1 font-medium mr-1"
              style={{ fontSize: `${smallFontSize}px` }}
              title="中止任务"
            >
              <Square className="w-2.5 h-2.5 fill-current" />
              中止
            </button>
          )}

          <button
            onClick={handleExportMarkdown}
            disabled={messages.length === 0}
            className="p-1 rounded cursor-pointer hover:opacity-100 opacity-60 disabled:opacity-25 transition-opacity"
            style={{ color: currentTheme.ui.text }}
            title="导出 Markdown 运维报告"
          >
            <Download className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={handleClear}
            className="p-1 rounded cursor-pointer hover:opacity-100 opacity-60 transition-opacity"
            style={{ color: currentTheme.ui.text }}
            title="清空对话"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={toggleAiPanelWide}
            className="p-1 rounded cursor-pointer hover:opacity-100 opacity-60 transition-opacity"
            style={{ color: currentTheme.ui.text }}
            title={aiPanelWidth > 500 ? '恢复紧凑宽度' : '加宽面板'}
          >
            {aiPanelWidth > 500 ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>

          <button
            onClick={() => toggleAiPanel(false)}
            className="p-1 rounded cursor-pointer hover:opacity-100 opacity-60 transition-opacity"
            style={{ color: currentTheme.ui.text }}
            title="收起面板"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 终端实时上下文与执行通道控制条（直观展示 su 用户切换与 cwd 感知状态） */}
      {activeTab && (
        <div
          className="px-2.5 py-1.5 border-b flex items-center justify-between gap-2 shrink-0 text-[11px]"
          style={{
            backgroundColor: currentTheme.ui.cardBg,
            borderColor: currentTheme.ui.border,
            color: currentTheme.ui.textMuted,
          }}
        >
          <div className="flex items-center gap-1.5 min-w-0 font-mono truncate">
            {(() => {
              const user = liveContext?.user || activeTab.server?.username || '';
              const switched =
                Boolean(activeTab.isSsh && activeTab.server?.username && liveContext?.user && liveContext.user !== activeTab.server.username);
              const cwd = liveContext?.cwd || '';
              return (
                <span
                  className={`flex items-center gap-1 truncate ${switched ? 'text-amber-400 font-semibold' : ''}`}
                  title={
                    switched
                      ? `已感知终端用户切换: ${activeTab.server?.username} -> ${user}（建议开启「终端内联」直接继承身份）`
                      : `当前终端上下文: ${user || '-'} ${cwd || ''}`
                  }
                >
                  <UserCheck className="w-3 h-3 shrink-0" />
                  <span className="truncate">
                    {user || 'shell'}
                    {cwd ? `:${cwd}` : ''}
                  </span>
                </span>
              );
            })()}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setAttachTerminalContext(!attachTerminalContext)}
              className="px-1.5 py-0.5 rounded border cursor-pointer flex items-center gap-1 transition-colors"
              style={{
                borderColor: attachTerminalContext ? currentTheme.ui.accent : currentTheme.ui.border,
                color: attachTerminalContext ? currentTheme.ui.accent : currentTheme.ui.textMuted,
                backgroundColor: attachTerminalContext ? currentTheme.ui.hoverBg : 'transparent',
              }}
              title={
                attachTerminalContext
                  ? '已开启：自动附带当前终端目录、用户与屏幕快照'
                  : '已关闭：不附带终端屏幕上下文'
              }
            >
              <Eye className="w-3 h-3" />
              <span>现场</span>
            </button>

            <button
              type="button"
              onClick={() => setExecutionMode(executionMode === 'pty' ? 'isolated' : 'pty')}
              className="px-1.5 py-0.5 rounded border cursor-pointer transition-colors font-medium"
              style={{
                borderColor: executionMode === 'pty' ? '#f59e0b' : currentTheme.ui.border,
                color: executionMode === 'pty' ? '#f59e0b' : currentTheme.ui.text,
                backgroundColor: executionMode === 'pty' ? 'rgba(245, 158, 11, 0.12)' : 'transparent',
              }}
              title={
                executionMode === 'pty'
                  ? '终端内联模式：命令直接运行在当前交互 PTY 中，自动继承 su / sudo -i / cd / 虚拟环境 / 跳板机'
                  : '隔离通道模式：在独立 SSH Exec 通道执行，不干扰当前终端界面（自动同步 cwd）'
              }
            >
              {executionMode === 'pty' ? '终端内联' : '隔离通道'}
            </button>
          </div>
        </div>
      )}

      {/* 消息与多步任务时间线 */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-3 space-y-3.5 select-text relative"
      >
        {!activeTab ? (
          <div
            className="flex flex-col items-center justify-center h-full space-y-2 text-center p-4"
            style={{ color: currentTheme.ui.textMuted }}
          >
            <Terminal className="w-8 h-8 opacity-40" />
            <p className="font-medium" style={{ color: currentTheme.ui.text, fontSize: `${baseFontSize}px` }}>
              未连接终端会话
            </p>
            <p className="leading-relaxed" style={{ fontSize: `${subFontSize}px` }}>
              请在左侧选择主机连接或新建本地终端，AI 智能运维将自动与对应 Shell 绑定。
            </p>
          </div>
        ) : messages.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center h-full space-y-2 text-center p-4"
            style={{ color: currentTheme.ui.textMuted }}
          >
            <Terminal className="w-8 h-8 opacity-40" />
            <p className="font-medium" style={{ color: currentTheme.ui.text, fontSize: `${baseFontSize}px` }}>
              智能运维就绪
            </p>
            <p className="leading-relaxed" style={{ fontSize: `${subFontSize}px` }}>
              已绑定: {activeTab.title}。输入运维诉求，将自主调度执行排障与诊断。
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
                      onClick={() => handleCopyText(msg.id, msg.content)}
                      className="opacity-0 group-hover:opacity-70 hover:!opacity-100 p-1 rounded transition-all cursor-pointer shrink-0 mt-1"
                      style={{ color: isCopied ? '#10b981' : currentTheme.ui.textMuted }}
                      title={isCopied ? '已复制' : '复制提问'}
                    >
                      {isCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
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

            const isLatestAssistant = isThinking && msg.id === messages[messages.length - 1]?.id;
            const isThinkingExpanded =
              expandedThinking[msg.id] !== undefined
                ? expandedThinking[msg.id]
                : isLatestAssistant;

            return (
              <div key={msg.id} className="space-y-2">
                {/* 正在连接模型并构思阶段占位 */}
                {isLatestAssistant && !msg.thinking && !msg.content && (!msg.toolCalls || msg.toolCalls.length === 0) && (
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
                    <span>正在连接模型并构思方案 ({(elapsedMs / 1000).toFixed(1)}s)...</span>
                  </div>
                )}

                {/* 思考过程卡片 */}
                {msg.thinking && (
                  <ThinkingCard
                    thinking={msg.thinking}
                    thinkingTimeMs={msg.thinkingTimeMs}
                    elapsedMs={elapsedMs}
                    isStreaming={isLatestAssistant && !msg.content}
                    isExpanded={isThinkingExpanded}
                    isCopied={copiedId === `think-${msg.id}`}
                    theme={currentTheme}
                    subFontSize={subFontSize}
                    codeFontSize={codeFontSize}
                    onToggle={() => toggleThinking(msg.id, isThinkingExpanded)}
                    onCopy={() => handleCopyText(`think-${msg.id}`, msg.thinking || '')}
                  />
                )}

                {/* 工具调用卡片列表 */}
                {msg.toolCalls &&
                  msg.toolCalls.map((tc: ToolCallItem) => {
                    const isPending = tc.status === 'pending';
                    const isExecuting = tc.status === 'executing';
                    const isRejected = tc.status === 'rejected';

                    return (
                      <div
                        key={tc.id}
                        id={`tool-call-${tc.id}`}
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
                                <CheckCircle2 className="w-3 h-3" /> 成功
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

                        {/* 如果是 terminal_exec 并且处于执行中或已有输出/执行完毕，呈现微型实时终端控制台 */}
                        {tc.name === 'terminal_exec' &&
                        (tc.status === 'executing' ||
                          tc.status === 'success' ||
                          tc.status === 'failed' ||
                          tc.result !== undefined) ? (
                          <MiniTerminalConsole
                            toolCall={tc}
                            theme={currentTheme}
                            fontSize={codeFontSize}
                          />
                        ) : (
                          <>
                            {/* 执行参数 */}
                            <div
                              className="mt-1 font-terminal px-2 py-1 rounded border break-all"
                              style={{
                                backgroundColor: currentTheme.ui.inputBg,
                                borderColor: currentTheme.ui.border,
                                color: currentTheme.ui.text,
                                fontSize: `${codeFontSize}px`,
                              }}
                            >
                              {tc.name === 'terminal_exec'
                                ? tc.args.command
                                : JSON.stringify(tc.args)}
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

                            {/* 输出结果 */}
                            {tc.result && (
                              <div
                                className="mt-1.5 font-terminal p-1.5 rounded max-h-36 overflow-y-auto whitespace-pre-wrap border"
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
                          </>
                        )}
                      </div>
                    );
                  })}

                {/* AI 结论或回复内容 */}
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
                      <span className="text-[11px] font-medium opacity-60">AI 分析结果</span>
                      <button
                        type="button"
                        onClick={() => handleCopyText(msg.id, msg.content)}
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

        {/* 浮动回到底部快捷按钮 */}
        {showScrollBottom && (
          <div className="sticky bottom-2 flex justify-end pr-1 pointer-events-none z-10">
            <button
              type="button"
              onClick={scrollToBottom}
              className="pointer-events-auto px-2.5 py-1 rounded-full shadow-lg border flex items-center gap-1 cursor-pointer transition-transform hover:scale-105 active:scale-95"
              style={{
                backgroundColor: currentTheme.ui.cardBg,
                borderColor: currentTheme.ui.border,
                color: currentTheme.ui.text,
                fontSize: `${smallFontSize}px`,
              }}
              title="滚动至最新消息"
            >
              <ArrowDown className="w-3.5 h-3.5 text-indigo-400" />
              <span>最新位置</span>
            </button>
          </div>
        )}
      </div>

      {/* 底部输入框与常驻审批操作条 */}
      <div
        className="p-3 border-t transition-colors"
        style={{
          backgroundColor: currentTheme.ui.agentBg,
          borderColor: currentTheme.ui.border,
        }}
      >
        {/* 常驻待审批操作条 */}
        {pendingToolCall && (
          <ApprovalBanner
            toolCall={pendingToolCall}
            titlePrefix="待授权执行"
            commandText={
              pendingToolCall.name === 'terminal_exec'
                ? pendingToolCall.args?.command
                : JSON.stringify(pendingToolCall.args)
            }
            theme={currentTheme}
            subFontSize={subFontSize}
            smallFontSize={smallFontSize}
            codeFontSize={codeFontSize}
            onLocate={() => {
              const el = document.getElementById(`tool-call-${pendingToolCall.id}`);
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              } else {
                scrollToBottom();
              }
            }}
            onReject={() => handleRespondApproval(false)}
            onApprove={() => handleRespondApproval(true)}
          />
        )}

        <ChatComposer
          value={input}
          onChange={setInput}
          onKeyDown={handleKeyDown}
          onSend={handleSend}
          onAbort={handleAbort}
          disabled={!activeTab || isThinking}
          sendDisabled={!activeTab || !input.trim()}
          isThinking={isThinking}
          isMac={isMac}
          placeholder={
            !activeTab
              ? '请先连接或打开终端...'
              : isThinking
                ? 'Agent 正在执行任务中...'
                : isMac
                  ? '向当前 Shell 描述运维任务 (Cmd + Enter 发送)...'
                  : '向当前 Shell 描述运维任务 (Ctrl + Enter 发送)...'
          }
          theme={currentTheme}
          baseFontSize={baseFontSize}
          subFontSize={subFontSize}
          smallFontSize={smallFontSize}
        />
      </div>
    </aside>
  );
};
