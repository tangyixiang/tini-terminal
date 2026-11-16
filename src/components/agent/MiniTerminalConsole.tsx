import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  Terminal,
  Copy,
  Check,
  Maximize2,
  Minimize2,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  X,
} from 'lucide-react';
import type { ToolCallItem } from '../../types';
import type { ThemeConfig } from '../../types/theme';

interface MiniTerminalConsoleProps {
  toolCall: ToolCallItem;
  theme: ThemeConfig;
  fontSize?: number;
}

const ANSI_COLOR_MAP: Record<number, string> = {
  30: '#4b5563', // black
  31: '#f87171', // red
  32: '#34d399', // green
  33: '#fbbf24', // yellow
  34: '#60a5fa', // blue
  35: '#f472b6', // magenta
  36: '#38bdf8', // cyan
  37: '#f3f4f6', // white
  90: '#9ca3af', // bright black
  91: '#fca5a5', // bright red
  92: '#6ee7b7', // bright green
  93: '#fde68a', // bright yellow
  94: '#93c5fd', // bright blue
  95: '#fbcfe8', // bright magenta
  96: '#7dd3fc', // bright cyan
  97: '#ffffff', // bright white
};

interface TextSegment {
  text: string;
  color?: string;
  bold?: boolean;
}

function parseAnsi(text: string): TextSegment[] {
  if (!text) return [];
  const segments: TextSegment[] = [];
  const regex = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  let currentColor: string | undefined = undefined;
  let isBold = false;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        text: text.substring(lastIndex, match.index),
        color: currentColor,
        bold: isBold,
      });
    }

    const codeStr = match[1];
    if (!codeStr || codeStr === '0') {
      currentColor = undefined;
      isBold = false;
    } else {
      const codes = codeStr.split(';').map((c) => parseInt(c, 10));
      for (const code of codes) {
        if (code === 0) {
          currentColor = undefined;
          isBold = false;
        } else if (code === 1) {
          isBold = true;
        } else if (ANSI_COLOR_MAP[code]) {
          currentColor = ANSI_COLOR_MAP[code];
        }
      }
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({
      text: text.substring(lastIndex),
      color: currentColor,
      bold: isBold,
    });
  }

  return segments;
}

export const MiniTerminalConsole: React.FC<MiniTerminalConsoleProps> = ({
  toolCall,
  theme,
  fontSize = 12,
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const inlineScrollRef = useRef<HTMLDivElement>(null);
  const modalScrollRef = useRef<HTMLDivElement>(null);
  const inlineUserScrolledRef = useRef(false);
  const modalUserScrolledRef = useRef(false);

  const command = (toolCall.args?.command as string) || '';
  const rawOutput = toolCall.result || '';
  const isExecuting = toolCall.status === 'executing';

  // 行内视口自动滚动
  useEffect(() => {
    const el = inlineScrollRef.current;
    if (!el) return;
    if (!inlineUserScrolledRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [rawOutput, isExecuting]);

  // 弹窗视口自动滚动
  useEffect(() => {
    if (!isModalOpen) return;
    const el = modalScrollRef.current;
    if (!el) return;
    if (!modalUserScrolledRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [rawOutput, isExecuting, isModalOpen]);

  // ESC 快捷键关闭弹窗
  useEffect(() => {
    if (!isModalOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isModalOpen]);

  const handleInlineScroll = () => {
    const el = inlineScrollRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    inlineUserScrolledRef.current = distanceToBottom > 40;
  };

  const handleModalScroll = () => {
    const el = modalScrollRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    modalUserScrolledRef.current = distanceToBottom > 40;
  };

  const handleCopy = async () => {
    const textToCopy = rawOutput.replace(/\x1b\[[0-9;]*m/g, '') || command;
    try {
      await navigator.clipboard.writeText(textToCopy);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {}
  };

  const segments = useMemo(() => parseAnsi(rawOutput), [rawOutput]);

  const renderContent = () => {
    if (segments.length > 0) {
      return segments.map((seg, idx) => (
        <span
          key={idx}
          style={{
            color: seg.color,
            fontWeight: seg.bold ? 600 : 400,
          }}
        >
          {seg.text}
        </span>
      ));
    }
    if (isExecuting) {
      return (
        <span className="flex items-center gap-1.5" style={{ color: theme.ui.textMuted }}>
          <span
            className="inline-block w-2 h-3.5 animate-pulse"
            style={{ backgroundColor: theme.ui.accent }}
          />
          <span>正在建立执行流...</span>
        </span>
      );
    }
    return <span style={{ color: theme.ui.textMuted }}>(无输出)</span>;
  };

  return (
    <>
      {/* 侧边面板内的紧凑微型控制台 */}
      <div
        className="mt-2 rounded border overflow-hidden flex flex-col font-mono transition-all duration-200 select-text max-h-48"
        style={{
          backgroundColor: theme.ui.inputBg,
          borderColor: isExecuting ? theme.ui.accent : theme.ui.border,
        }}
      >
        {/* 顶部控制栏 */}
        <div
          className="px-2.5 py-1.5 border-b flex items-center justify-between text-xs select-none shrink-0"
          style={{
            backgroundColor: theme.ui.cardBg,
            borderColor: theme.ui.border,
            color: theme.ui.textMuted,
          }}
        >
          <div className="flex items-center gap-1.5 min-w-0 mr-2">
            <Terminal className="w-3.5 h-3.5 shrink-0" style={{ color: theme.ui.accent }} />
            <span
              className="text-[11px] font-semibold truncate"
              style={{ color: theme.ui.textMuted }}
              title={command}
            >
              $ {command}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* 状态标识 */}
            {isExecuting && (
              <span
                className="flex items-center gap-1 text-[11px] font-medium"
                style={{ color: theme.ui.accent }}
              >
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>运行中</span>
              </span>
            )}
            {!isExecuting && toolCall.status === 'success' && (
              <span className="flex items-center gap-1 text-[11px] text-emerald-500 font-medium">
                <CheckCircle2 className="w-3 h-3" />
                <span>完成</span>
              </span>
            )}
            {!isExecuting && toolCall.status === 'failed' && (
              <span className="flex items-center gap-1 text-[11px] text-red-500 font-medium">
                <AlertTriangle className="w-3 h-3" />
                <span>错误</span>
              </span>
            )}

            {/* 执行耗时 */}
            {toolCall.durationMs !== undefined && toolCall.durationMs > 0 && (
              <span
                className="text-[10px] font-mono"
                style={{ color: theme.ui.textMuted }}
              >
                {toolCall.durationMs < 1000
                  ? `${toolCall.durationMs}ms`
                  : `${(toolCall.durationMs / 1000).toFixed(1)}s`}
              </span>
            )}

            {/* 弹出窗口放大查看按钮 */}
            <button
              type="button"
              onClick={() => setIsModalOpen(true)}
              className="p-1 rounded cursor-pointer hover:opacity-80 transition-colors"
              style={{ color: theme.ui.textMuted }}
              title="弹出窗口放大查看"
            >
              <Maximize2 className="w-3 h-3" />
            </button>

            {/* 一键复制输出 */}
            <button
              type="button"
              onClick={handleCopy}
              className="p-1 rounded cursor-pointer hover:opacity-80 transition-colors"
              style={{ color: theme.ui.textMuted }}
              title={isCopied ? '已复制' : '复制输出'}
            >
              {isCopied ? (
                <Check className="w-3 h-3 text-emerald-500" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
            </button>
          </div>
        </div>

        {/* 紧凑终端内容区 */}
        <div
          ref={inlineScrollRef}
          onScroll={handleInlineScroll}
          className="p-2 overflow-y-auto whitespace-pre-wrap break-all flex-1 font-mono leading-relaxed min-h-[56px]"
          style={{
            fontSize: `${Math.max(11, fontSize - 1)}px`,
            color: theme.ui.text,
          }}
        >
          {renderContent()}
        </div>
      </div>

      {/* 放大弹窗模式 (Portal 至 body 根节点) */}
      {isModalOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/70 backdrop-blur-xs select-none"
            onClick={() => setIsModalOpen(false)}
          >
            <div
              className="w-full max-w-5xl h-[80vh] rounded-xl border shadow-2xl flex flex-col overflow-hidden select-text"
              style={{
                backgroundColor: theme.ui.appBg,
                borderColor: theme.ui.border,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* 弹窗 Header */}
              <div
                className="px-4 py-2.5 border-b flex items-center justify-between text-xs select-none shrink-0"
                style={{
                  backgroundColor: theme.ui.headerBg,
                  borderColor: theme.ui.border,
                }}
              >
                <div className="flex items-center gap-2 min-w-0 mr-4">
                  <Terminal className="w-4 h-4 shrink-0" style={{ color: theme.ui.accent }} />
                  <span
                    className="text-xs font-semibold truncate"
                    style={{ color: theme.ui.text }}
                    title={command}
                  >
                    $ {command}
                  </span>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  {/* 状态指示 */}
                  {isExecuting && (
                    <span
                      className="flex items-center gap-1.5 text-xs font-medium"
                      style={{ color: theme.ui.accent }}
                    >
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>运行中</span>
                    </span>
                  )}
                  {!isExecuting && toolCall.status === 'success' && (
                    <span className="flex items-center gap-1.5 text-xs text-emerald-500 font-medium">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>完成</span>
                    </span>
                  )}
                  {!isExecuting && toolCall.status === 'failed' && (
                    <span className="flex items-center gap-1.5 text-xs text-red-500 font-medium">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      <span>错误</span>
                    </span>
                  )}

                  {toolCall.durationMs !== undefined && toolCall.durationMs > 0 && (
                    <span
                      className="text-xs font-mono"
                      style={{ color: theme.ui.textMuted }}
                    >
                      {toolCall.durationMs < 1000
                        ? `${toolCall.durationMs}ms`
                        : `${(toolCall.durationMs / 1000).toFixed(1)}s`}
                    </span>
                  )}

                  {/* 复制 */}
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="p-1.5 rounded cursor-pointer hover:opacity-80 transition-colors flex items-center gap-1 text-xs"
                    style={{ color: theme.ui.text }}
                    title={isCopied ? '已复制' : '复制输出'}
                  >
                    {isCopied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-500" />
                        <span className="text-emerald-500">已复制</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>复制</span>
                      </>
                    )}
                  </button>

                  {/* 缩小还原 */}
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="p-1.5 rounded cursor-pointer hover:opacity-80 transition-colors flex items-center gap-1 text-xs"
                    style={{ color: theme.ui.text }}
                    title="缩小还原"
                  >
                    <Minimize2 className="w-3.5 h-3.5" />
                    <span>缩小还原</span>
                  </button>

                  {/* 关闭 */}
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="p-1.5 rounded cursor-pointer hover:opacity-80 transition-colors"
                    style={{ color: theme.ui.textMuted }}
                    title="关闭"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* 弹窗终端大视口 */}
              <div
                ref={modalScrollRef}
                onScroll={handleModalScroll}
                className="p-4 overflow-y-auto whitespace-pre-wrap break-all flex-1 font-mono leading-relaxed"
                style={{
                  fontSize: '13px',
                  color: theme.ui.text,
                  backgroundColor: theme.ui.terminalBg,
                }}
              >
                {renderContent()}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
