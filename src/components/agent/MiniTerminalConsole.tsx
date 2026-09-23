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
        <span className="text-zinc-500 flex items-center gap-1.5">
          <span className="inline-block w-2 h-3.5 bg-emerald-400 animate-pulse" />
          <span>正在建立执行流...</span>
        </span>
      );
    }
    return <span className="text-zinc-600">(无输出)</span>;
  };

  return (
    <>
      {/* 侧边面板内的紧凑微型控制台 */}
      <div
        className="mt-2 rounded border overflow-hidden flex flex-col font-mono transition-all duration-200 select-text max-h-48"
        style={{
          backgroundColor: '#0f1117',
          borderColor: isExecuting ? '#23d18b' : theme.ui.border,
        }}
      >
        {/* 顶部控制栏 */}
        <div
          className="px-2.5 py-1.5 border-b flex items-center justify-between text-xs select-none shrink-0"
          style={{
            backgroundColor: '#161922',
            borderColor: theme.ui.border,
            color: theme.ui.textMuted,
          }}
        >
          <div className="flex items-center gap-1.5 min-w-0 mr-2">
            <Terminal className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span className="text-[11px] text-zinc-400 font-semibold truncate" title={command}>
              $ {command}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* 状态标识 */}
            {isExecuting && (
              <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-medium">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>运行中</span>
              </span>
            )}
            {!isExecuting && toolCall.status === 'success' && (
              <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-medium">
                <CheckCircle2 className="w-3 h-3" />
                <span>0</span>
              </span>
            )}
            {!isExecuting && toolCall.status === 'failed' && (
              <span className="flex items-center gap-1 text-[11px] text-red-400 font-medium">
                <AlertTriangle className="w-3 h-3" />
                <span>错误</span>
              </span>
            )}

            {/* 执行耗时 */}
            {toolCall.durationMs !== undefined && toolCall.durationMs > 0 && (
              <span className="text-[10px] text-zinc-500 font-mono">
                {toolCall.durationMs < 1000
                  ? `${toolCall.durationMs}ms`
                  : `${(toolCall.durationMs / 1000).toFixed(1)}s`}
              </span>
            )}

            {/* 弹出窗口放大查看按钮 */}
            <button
              type="button"
              onClick={() => setIsModalOpen(true)}
              className="p-1 rounded cursor-pointer hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
              title="弹出窗口放大查看"
            >
              <Maximize2 className="w-3 h-3" />
            </button>

            {/* 一键复制输出 */}
            <button
              type="button"
              onClick={handleCopy}
              className="p-1 rounded cursor-pointer hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
              title={isCopied ? '已复制' : '复制输出'}
            >
              {isCopied ? (
                <Check className="w-3 h-3 text-emerald-400" />
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
            color: '#e4e4e7',
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
              className="w-full max-w-5xl h-[80vh] rounded-xl border border-zinc-700/80 shadow-2xl flex flex-col overflow-hidden select-text"
              style={{ backgroundColor: '#0d0f14' }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* 弹窗 Header */}
              <div
                className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between text-xs select-none shrink-0"
                style={{ backgroundColor: '#141720' }}
              >
                <div className="flex items-center gap-2 min-w-0 mr-4">
                  <Terminal className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="text-xs font-semibold text-zinc-300 truncate" title={command}>
                    $ {command}
                  </span>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  {/* 状态指示 */}
                  {isExecuting && (
                    <span className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>运行中</span>
                    </span>
                  )}
                  {!isExecuting && toolCall.status === 'success' && (
                    <span className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>0</span>
                    </span>
                  )}
                  {!isExecuting && toolCall.status === 'failed' && (
                    <span className="flex items-center gap-1.5 text-xs text-red-400 font-medium">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      <span>错误</span>
                    </span>
                  )}

                  {toolCall.durationMs !== undefined && toolCall.durationMs > 0 && (
                    <span className="text-xs text-zinc-400 font-mono">
                      {toolCall.durationMs < 1000
                        ? `${toolCall.durationMs}ms`
                        : `${(toolCall.durationMs / 1000).toFixed(1)}s`}
                    </span>
                  )}

                  {/* 复制 */}
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="p-1.5 rounded cursor-pointer hover:bg-zinc-800 text-zinc-300 hover:text-white transition-colors flex items-center gap-1 text-xs"
                    title={isCopied ? '已复制' : '复制输出'}
                  >
                    {isCopied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400">已复制</span>
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
                    className="p-1.5 rounded cursor-pointer hover:bg-zinc-800 text-zinc-300 hover:text-white transition-colors flex items-center gap-1 text-xs"
                    title="缩小还原"
                  >
                    <Minimize2 className="w-3.5 h-3.5" />
                    <span>缩小还原</span>
                  </button>

                  {/* 关闭 */}
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="p-1.5 rounded cursor-pointer hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
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
                  color: '#f4f4f5',
                  backgroundColor: '#0a0c10',
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
