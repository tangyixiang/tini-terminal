import React, { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { getPrimaryButtonStyle, type ThemeConfig } from '../../types/theme';
import { focusManager } from '../../core/focus/FocusManager';

interface PasteConfirmModalProps {
  tabId: string;
  text: string | null;
  theme: ThemeConfig;
  onCancel: () => void;
  onConfirm: (text: string) => void;
}

export const PasteConfirmModal: React.FC<PasteConfirmModalProps> = ({
  tabId,
  text,
  theme,
  onCancel,
  onConfirm,
}) => {
  const scopeId = `terminal-paste-${tabId}`;

  useEffect(() => {
    if (text !== null) {
      focusManager.pushScope(scopeId, 'overlay');
    } else {
      focusManager.popScope(scopeId);
    }
    return () => {
      focusManager.popScope(scopeId, false);
    };
  }, [text, scopeId]);

  if (text === null) return null;

  const lineCount = text.split('\n').length;

  return (
    <div
      data-terminal-overlay
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 select-none p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-lg rounded-lg border shadow-2xl p-4 flex flex-col gap-3"
        style={{
          backgroundColor: theme.ui.cardBg,
          borderColor: theme.ui.border,
          color: theme.ui.text,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-xs font-semibold">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          <span>确认粘贴多行内容（共 {lineCount} 行）</span>
        </div>
        <p className="text-[11px]" style={{ color: theme.ui.textMuted }}>
          包含换行符的文本粘贴进终端后可能会立即按行执行，请确认内容无误后再粘贴：
        </p>
        <pre
          className="p-2.5 rounded border font-mono text-[11px] max-h-52 overflow-auto whitespace-pre-wrap break-all select-text"
          style={{
            backgroundColor: theme.ui.terminalBg,
            borderColor: theme.ui.border,
            color: theme.ui.text,
          }}
        >
          {text}
        </pre>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1 rounded text-xs border cursor-pointer"
            style={{
              borderColor: theme.ui.border,
              backgroundColor: theme.ui.hoverBg,
              color: theme.ui.text,
            }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onConfirm(text)}
            className="px-3 py-1 rounded text-xs font-semibold cursor-pointer"
            style={getPrimaryButtonStyle(theme)}
          >
            确认粘贴
          </button>
        </div>
      </div>
    </div>
  );
};
