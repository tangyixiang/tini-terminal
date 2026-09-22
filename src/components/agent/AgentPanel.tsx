import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  Loader2,
  ChevronDown,
  ChevronRight,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Clock,
  Terminal,
  FileCode,
  Folder,
  Cpu,
  Trash2,
  Square,
} from 'lucide-react';
import { useAgentStore } from '../../stores/useAgentStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { runAgentTask, abortAgentTask } from '../../lib/agent/runner';
import { BUILTIN_THEMES } from '../../types/theme';
import type { ToolCallItem } from '../../types';
import { MarkdownView } from './MarkdownView';

export const AgentPanel: React.FC = () => {
  const [input, setInput] = useState('');
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const {
    messages,
    isThinking,
    pendingToolCall,
    respondApproval,
    clearMessages,
  } = useAgentStore();

  const { themeId, aiPanelWidth, toggleAiPanel, terminalFontSize } = useSettingsStore();
  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pendingToolCall, isThinking]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isThinking) return;
    setInput('');
    runAgentTask(trimmed);
  };

  const handleAbort = () => {
    abortAgentTask();
  };

  const handleClear = () => {
    if (isThinking) {
      abortAgentTask();
    }
    clearMessages();
  };

  const isMac = typeof navigator !== 'undefined' && /(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent || navigator.platform || '');

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
        width: aiPanelWidth,
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
            className="font-semibold whitespace-nowrap truncate"
            style={{ color: currentTheme.ui.text, fontSize: `${subFontSize}px` }}
          >
            AI 智能运维
          </span>
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
            onClick={handleClear}
            className="p-1 rounded cursor-pointer hover:opacity-100 opacity-60 transition-opacity"
            style={{ color: currentTheme.ui.text }}
            title="清空对话"
          >
            <Trash2 className="w-3.5 h-3.5" />
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

      {/* 消息与多步任务时间线 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3.5">
        {messages.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center h-full space-y-2 text-center p-4"
            style={{ color: currentTheme.ui.textMuted }}
          >
            <Terminal className="w-8 h-8 opacity-40" />
            <p className="font-medium" style={{ color: currentTheme.ui.text, fontSize: `${baseFontSize}px` }}>
              智能运维 Agent 就绪
            </p>
            <p className="leading-relaxed" style={{ fontSize: `${subFontSize}px` }}>
              输入任务目标（如检查端口占用、排障高负载等），Agent 将自主规划并调用工具执行诊断。
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            if (msg.role === 'user') {
              return (
                <div key={msg.id} className="flex flex-col items-end">
                  <div
                    className="border rounded-lg px-3 py-2 max-w-[85%] break-words leading-relaxed"
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
                  <span
                    className="mt-1"
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
                  <div
                    className="border rounded p-2.5 transition-colors"
                    style={{
                      backgroundColor: currentTheme.ui.cardBg,
                      borderColor: currentTheme.ui.border,
                      fontSize: `${subFontSize}px`,
                    }}
                  >
                    <div
                      onClick={() => toggleThinking(msg.id, isThinkingExpanded)}
                      className="flex items-center justify-between font-medium cursor-pointer select-none"
                      style={{ color: currentTheme.ui.accent, fontSize: `${subFontSize}px` }}
                    >
                      <span className="flex items-center gap-1.5">
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
                      {isThinkingExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                      )}
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

                {/* 工具调用卡片列表 */}
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

                        {/* 单步审批操作按钮 */}
                        {isPending && pendingToolCall?.id === tc.id && (
                          <div
                            className="mt-2.5 flex items-center justify-end gap-2 pt-1 border-t"
                            style={{ borderColor: currentTheme.ui.border }}
                          >
                            <button
                              onClick={() => respondApproval(false)}
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
                              onClick={() => respondApproval(true)}
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

                {/* AI 结论或回复内容 */}
                {msg.content && (
                  <div
                    className="border rounded-lg p-3 leading-relaxed transition-colors"
                    style={{
                      backgroundColor: currentTheme.ui.cardBg,
                      borderColor: currentTheme.ui.border,
                      color: currentTheme.ui.text,
                      fontSize: `${baseFontSize}px`,
                    }}
                  >
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
      </div>

      {/* 底部输入框 */}
      <div
        className="p-3 border-t transition-colors"
        style={{
          backgroundColor: currentTheme.ui.agentBg,
          borderColor: currentTheme.ui.border,
        }}
      >
        <div className="relative">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="向 Agent 描述运维任务或排障需求..."
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
                disabled={!input.trim()}
                className="px-3 py-1 disabled:opacity-50 text-white rounded font-medium cursor-pointer flex items-center gap-1 transition-colors"
                style={{
                  backgroundColor: currentTheme.ui.accent,
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
    </aside>
  );
};
