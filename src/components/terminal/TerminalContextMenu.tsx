import React from 'react';
import {
  Copy,
  Clipboard,
  Sparkles,
  Search,
  FolderKanban,
  Trash2,
  RefreshCw,
} from 'lucide-react';
import type { ThemeConfig } from '../../types/theme';

export interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  selection: string;
}

interface TerminalContextMenuProps {
  menu: ContextMenuState;
  isSsh: boolean;
  theme: ThemeConfig;
  onCopy: () => void;
  onPaste: () => void;
  onAskAi: () => void;
  onOpenSearch: () => void;
  onOpenSftp: () => void;
  onClear: () => void;
  onReconnect: () => void;
}

export const TerminalContextMenu: React.FC<TerminalContextMenuProps> = ({
  menu,
  isSsh,
  theme,
  onCopy,
  onPaste,
  onAskAi,
  onOpenSearch,
  onOpenSftp,
  onClear,
  onReconnect,
}) => {
  if (!menu.visible) return null;

  return (
    <div
      data-terminal-overlay
      className="fixed z-50 py-1 rounded-lg shadow-2xl border text-xs min-w-[176px] select-none"
      style={{
        top: menu.y,
        left: menu.x,
        backgroundColor: theme.ui.cardBg,
        borderColor: theme.ui.border,
        color: theme.ui.text,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        disabled={!menu.selection}
        onClick={onCopy}
        className="w-full px-3 py-1.5 text-left hover:bg-white/10 disabled:opacity-40 flex items-center gap-2 cursor-pointer"
      >
        <Copy className="w-3.5 h-3.5 opacity-75" />
        <span>复制选中内容</span>
      </button>
      <button
        type="button"
        onClick={onPaste}
        className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
      >
        <Clipboard className="w-3.5 h-3.5 opacity-75" />
        <span>粘贴</span>
      </button>
      <button
        type="button"
        onClick={onAskAi}
        className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
        style={{ color: theme.ui.accent }}
      >
        <Sparkles className="w-3.5 h-3.5" />
        <span>{menu.selection ? '发送选中内容给 AI' : '诊断当前终端输出'}</span>
      </button>
      <div className="h-px my-1" style={{ backgroundColor: theme.ui.border }} />
      <button
        type="button"
        onClick={onOpenSearch}
        className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
      >
        <Search className="w-3.5 h-3.5 opacity-75" />
        <span>搜索终端内容</span>
      </button>
      {isSsh && (
        <button
          type="button"
          onClick={onOpenSftp}
          className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
        >
          <FolderKanban className="w-3.5 h-3.5 opacity-75" />
          <span>打开 SFTP 文件管理</span>
        </button>
      )}
      <button
        type="button"
        onClick={onClear}
        className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
      >
        <Trash2 className="w-3.5 h-3.5 opacity-75" />
        <span>清屏</span>
      </button>
      {isSsh && (
        <button
          type="button"
          onClick={onReconnect}
          className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5 opacity-75" />
          <span>重新连接</span>
        </button>
      )}
    </div>
  );
};
