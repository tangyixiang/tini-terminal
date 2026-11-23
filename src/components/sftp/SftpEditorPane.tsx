import React from 'react';
import { Loader2, Save } from 'lucide-react';
import { isMacPlatform } from '../../lib/platform';
import { getPrimaryButtonStyle, type ThemeConfig } from '../../types/theme';
import type { RemoteFileInfo } from '../../types';

interface SftpEditorPaneProps {
  theme: ThemeConfig;
  file: RemoteFileInfo;
  content: string;
  onChange: (value: string) => void;
  isDirty: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: () => void;
}

export const SftpEditorPane: React.FC<SftpEditorPaneProps> = ({
  theme,
  file,
  content,
  onChange,
  isDirty,
  saving,
  onClose,
  onSave,
}) => {
  return (
    <div className="flex-1 flex flex-col h-full" style={{ backgroundColor: theme.ui.terminalBg }}>
      <div
        className="h-8 px-3 border-b flex items-center justify-between text-xs shrink-0"
        style={{
          backgroundColor: theme.ui.headerBg,
          borderColor: theme.ui.border,
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono truncate text-[11px]">{file.path}</span>
          {isDirty && (
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-400 shrink-0">
              未保存
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] opacity-50 hidden sm:inline">
            {isMacPlatform() ? 'Cmd+S 保存' : 'Ctrl+S 保存'}
          </span>
          <button
            onClick={onClose}
            className="px-2 py-0.5 rounded border text-[11px] cursor-pointer"
            style={{
              backgroundColor: theme.ui.hoverBg,
              borderColor: theme.ui.border,
              color: theme.ui.text,
            }}
          >
            关闭
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="px-2.5 py-0.5 rounded text-[11px] font-semibold flex items-center gap-1 cursor-pointer hover:opacity-90"
            style={getPrimaryButtonStyle(theme)}
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            保存覆盖
          </button>
        </div>
      </div>
      <textarea
        value={content}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 w-full p-3 font-terminal text-[13px] leading-[19px] bg-transparent border-none outline-none resize-none select-text"
        style={{
          color: theme.ui.text,
          backgroundColor: theme.ui.terminalBg,
        }}
        spellCheck={false}
      />
    </div>
  );
};
