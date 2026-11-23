import React, { type RefObject } from 'react';
import { Send, Square } from 'lucide-react';
import { getPrimaryButtonStyle, type ThemeConfig } from '../../../types/theme';

interface ChatComposerProps {
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onAbort: () => void;
  disabled: boolean;
  sendDisabled: boolean;
  isThinking: boolean;
  isMac: boolean;
  placeholder: string;
  theme: ThemeConfig;
  baseFontSize: number;
  subFontSize: number;
  smallFontSize: number;
}

export const ChatComposer: React.FC<ChatComposerProps> = ({
  inputRef,
  value,
  onChange,
  onKeyDown,
  onSend,
  onAbort,
  disabled,
  sendDisabled,
  isThinking,
  isMac,
  placeholder,
  theme,
  baseFontSize,
  subFontSize,
  smallFontSize,
}) => {
  return (
    <div className="relative">
      <textarea
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        rows={2}
        className="w-full rounded-lg p-2.5 border focus:outline-none resize-none transition-colors"
        style={{
          backgroundColor: theme.ui.inputBg,
          borderColor: theme.ui.border,
          color: theme.ui.text,
          fontSize: `${baseFontSize}px`,
        }}
      />
      <div className="flex items-center justify-between mt-1.5">
        <span
          style={{
            color: theme.ui.textMuted,
            fontSize: `${smallFontSize}px`,
          }}
        >
          {isMac ? 'Cmd + Enter 发送 / Enter 换行' : 'Ctrl + Enter 发送 / Enter 换行'}
        </span>
        {isThinking ? (
          <button
            onClick={onAbort}
            className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white rounded font-medium cursor-pointer flex items-center gap-1.5 transition-colors"
            style={{ fontSize: `${subFontSize}px` }}
            title="中止执行"
          >
            <Square className="w-3 h-3 fill-current" />
            中止
          </button>
        ) : (
          <button
            onClick={onSend}
            disabled={sendDisabled}
            className="px-3 py-1 disabled:opacity-50 rounded font-semibold cursor-pointer flex items-center gap-1 transition-opacity hover:opacity-90"
            style={{
              ...getPrimaryButtonStyle(theme),
              fontSize: `${subFontSize}px`,
            }}
          >
            <Send className="w-3 h-3" />
            发送
          </button>
        )}
      </div>
    </div>
  );
};
