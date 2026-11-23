import React from 'react';
import { ShieldAlert } from 'lucide-react';
import type { ToolCallItem } from '../../../types';
import type { ThemeConfig } from '../../../types/theme';

interface ApprovalBannerProps {
  toolCall: ToolCallItem;
  titlePrefix: string;
  commandText: string;
  theme: ThemeConfig;
  subFontSize: number;
  smallFontSize: number;
  codeFontSize: number;
  onLocate: () => void;
  onApprove: () => void;
  onReject: () => void;
}

export const ApprovalBanner: React.FC<ApprovalBannerProps> = ({
  toolCall,
  titlePrefix,
  commandText,
  theme,
  subFontSize,
  smallFontSize,
  codeFontSize,
  onLocate,
  onApprove,
  onReject,
}) => {
  const isDangerous = toolCall.riskLevel === 'dangerous';

  return (
    <div
      className="mb-2.5 p-2.5 rounded-lg border flex flex-col gap-2 shadow-sm transition-all animate-in fade-in slide-in-from-bottom-2 duration-150"
      style={{
        backgroundColor: isDangerous ? 'rgba(239, 68, 68, 0.12)' : 'rgba(245, 158, 11, 0.12)',
        borderColor: isDangerous ? '#ef4444' : '#f59e0b',
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <ShieldAlert
            className={`w-4 h-4 shrink-0 ${isDangerous ? 'text-red-500' : 'text-amber-500'}`}
          />
          <span
            className="font-semibold truncate"
            style={{ color: theme.ui.text, fontSize: `${subFontSize}px` }}
          >
            {titlePrefix}: {toolCall.name}
          </span>
          {toolCall.hostName && (
            <span className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-blue-500/20 text-blue-400 font-bold border border-blue-500/30">
              {toolCall.hostName}
            </span>
          )}
          <span
            className={`px-1.5 py-0.2 rounded font-medium text-[10px] ${
              isDangerous
                ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
            }`}
          >
            {isDangerous ? '高危命令' : '需确认'}
          </span>
        </div>

        <button
          type="button"
          onClick={onLocate}
          className="underline opacity-75 hover:opacity-100 cursor-pointer transition-opacity shrink-0"
          style={{ color: theme.ui.accent, fontSize: `${smallFontSize}px` }}
          title="在上方对话中定位该卡片"
        >
          定位卡片
        </button>
      </div>

      <div
        className="font-terminal px-2 py-1 rounded border break-all max-h-20 overflow-y-auto"
        style={{
          backgroundColor: theme.ui.inputBg,
          borderColor: theme.ui.border,
          color: theme.ui.text,
          fontSize: `${codeFontSize}px`,
        }}
      >
        {commandText}
      </div>

      {toolCall.warningMessage && (
        <div
          className="text-amber-500 flex items-center gap-1"
          style={{ fontSize: `${smallFontSize}px` }}
        >
          <span>{toolCall.warningMessage}</span>
        </div>
      )}

      <div
        className="flex items-center justify-end gap-2 pt-1 border-t"
        style={{ borderColor: theme.ui.border }}
      >
        <button
          type="button"
          onClick={onReject}
          className="px-2.5 py-1 rounded cursor-pointer transition-colors"
          style={{
            backgroundColor: theme.ui.hoverBg,
            color: theme.ui.text,
            fontSize: `${subFontSize}px`,
          }}
        >
          拒绝
        </button>
        <button
          type="button"
          onClick={onApprove}
          className="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-medium cursor-pointer transition-colors"
          style={{ fontSize: `${subFontSize}px` }}
        >
          允许执行
        </button>
      </div>
    </div>
  );
};
