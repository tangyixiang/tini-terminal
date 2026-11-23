import React from 'react';
import { Loader2, Clock, Check, Copy, ChevronDown, ChevronRight } from 'lucide-react';
import type { ThemeConfig } from '../../../types/theme';

interface ThinkingCardProps {
  thinking: string;
  thinkingTimeMs?: number;
  elapsedMs: number;
  isStreaming: boolean;
  isExpanded: boolean;
  isCopied: boolean;
  theme: ThemeConfig;
  subFontSize: number;
  codeFontSize: number;
  onToggle: () => void;
  onCopy: () => void;
}

export const ThinkingCard: React.FC<ThinkingCardProps> = ({
  thinking,
  thinkingTimeMs,
  elapsedMs,
  isStreaming,
  isExpanded,
  isCopied,
  theme,
  subFontSize,
  codeFontSize,
  onToggle,
  onCopy,
}) => {
  return (
    <div
      className="border rounded p-2.5 transition-colors"
      style={{
        backgroundColor: theme.ui.cardBg,
        borderColor: theme.ui.border,
        fontSize: `${subFontSize}px`,
      }}
    >
      <div
        className="flex items-center justify-between font-medium select-none"
        style={{ color: theme.ui.accent, fontSize: `${subFontSize}px` }}
      >
        <span onClick={onToggle} className="flex items-center gap-1.5 cursor-pointer flex-1">
          {isStreaming ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
          ) : (
            <Clock className="w-3.5 h-3.5 shrink-0" />
          )}
          <span>
            {isStreaming
              ? `深度思考推理中 (${(elapsedMs / 1000).toFixed(1)}s)`
              : thinkingTimeMs
                ? `思考与推理分析 (${(thinkingTimeMs / 1000).toFixed(1)}s)`
                : '思考与推理分析'}
          </span>
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCopy();
            }}
            className="p-1 rounded hover:opacity-100 opacity-60 transition-opacity cursor-pointer"
            style={{ color: isCopied ? '#10b981' : theme.ui.textMuted }}
            title={isCopied ? '已复制' : '复制思考内容'}
          >
            {isCopied ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
          <span onClick={onToggle} className="cursor-pointer p-0.5">
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 shrink-0" />
            )}
          </span>
        </div>
      </div>

      {isExpanded && (
        <div
          className="mt-2 whitespace-pre-wrap leading-relaxed border-t pt-2 font-mono"
          style={{
            borderColor: theme.ui.border,
            color: theme.ui.textMuted,
            fontSize: `${codeFontSize}px`,
          }}
        >
          {thinking}
          {isStreaming && (
            <span className="inline-block w-1.5 h-3.5 ml-1 bg-indigo-400 animate-pulse align-middle" />
          )}
        </div>
      )}
    </div>
  );
};
