import React, { type RefObject } from 'react';
import { X, Terminal, Download, Copy, Shield } from 'lucide-react';
import { getPrimaryButtonStyle, type ThemeConfig } from '../../types/theme';
import type { RemoteFileInfo } from '../../types';
import {
  formatPermissions,
  type DialogType,
  type SftpContextMenuState,
} from './sftpUtils';

interface SftpDialogsProps {
  theme: ThemeConfig;
  currentPath: string;
  contextMenu: SftpContextMenuState;
  closeContextMenu: () => void;
  activeDialog: DialogType;
  setActiveDialog: (v: DialogType) => void;
  dialogInput: string;
  setDialogInput: (v: string) => void;
  dialogTarget: RemoteFileInfo | null;
  recursiveDelete: boolean;
  setRecursiveDelete: (v: boolean) => void;
  dialogInputRef: RefObject<HTMLInputElement | null>;
  onDialogSubmit: () => void;
  onEnterDir: (path: string) => void;
  onOpenFile: (file: RemoteFileInfo) => void;
  onCdInTerminal: (path: string) => void;
  onDownload: (file: RemoteFileInfo) => void;
  onCopyPath: (path: string) => void;
  onOpenChmod: (file: RemoteFileInfo) => void;
  onOpenRename: (file: RemoteFileInfo) => void;
  onOpenDelete: (file: RemoteFileInfo) => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onTriggerUpload: () => void;
  onRefresh: () => void;
}

export const SftpDialogs: React.FC<SftpDialogsProps> = ({
  theme,
  currentPath,
  contextMenu,
  closeContextMenu,
  activeDialog,
  setActiveDialog,
  dialogInput,
  setDialogInput,
  dialogTarget,
  recursiveDelete,
  setRecursiveDelete,
  dialogInputRef,
  onDialogSubmit,
  onEnterDir,
  onOpenFile,
  onCdInTerminal,
  onDownload,
  onCopyPath,
  onOpenChmod,
  onOpenRename,
  onOpenDelete,
  onNewFolder,
  onNewFile,
  onTriggerUpload,
  onRefresh,
}) => {
  return (
    <>
      {contextMenu.visible && (
        <div
          className="fixed z-50 py-1 rounded-lg shadow-xl border text-xs min-w-[168px]"
          style={{
            top: contextMenu.y,
            left: contextMenu.x,
            backgroundColor: theme.ui.cardBg,
            borderColor: theme.ui.border,
            color: theme.ui.text,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.item ? (
            <>
              <button
                className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
                onClick={() => {
                  const target = contextMenu.item!;
                  closeContextMenu();
                  if (target.is_dir) onEnterDir(target.path);
                  else onOpenFile(target);
                }}
              >
                <span>{contextMenu.item.is_dir ? '进入目录' : '在线编辑文件'}</span>
              </button>
              {contextMenu.item.is_dir && (
                <button
                  className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
                  onClick={() => {
                    const target = contextMenu.item!;
                    closeContextMenu();
                    onCdInTerminal(target.path);
                  }}
                >
                  <Terminal className="w-3.5 h-3.5 opacity-75" />
                  <span>在终端中进入 (cd)</span>
                </button>
              )}
              {!contextMenu.item.is_dir && (
                <button
                  className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
                  onClick={() => {
                    const target = contextMenu.item!;
                    closeContextMenu();
                    onDownload(target);
                  }}
                >
                  <Download className="w-3.5 h-3.5 opacity-75" />
                  <span>下载到本地</span>
                </button>
              )}
              <button
                className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
                onClick={() => {
                  const target = contextMenu.item!;
                  closeContextMenu();
                  onCopyPath(target.path);
                }}
              >
                <Copy className="w-3.5 h-3.5 opacity-75" />
                <span>复制完整路径</span>
              </button>
              <button
                className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
                onClick={() => {
                  const target = contextMenu.item!;
                  closeContextMenu();
                  onOpenChmod(target);
                }}
              >
                <Shield className="w-3.5 h-3.5 opacity-75" />
                <span>修改权限 (chmod)</span>
              </button>
              <button
                className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
                onClick={() => {
                  const target = contextMenu.item!;
                  closeContextMenu();
                  onOpenRename(target);
                }}
              >
                <span>重命名</span>
              </button>
              <div className="h-px my-1" style={{ backgroundColor: theme.ui.border }} />
              <button
                className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer text-red-400"
                onClick={() => {
                  const target = contextMenu.item!;
                  closeContextMenu();
                  onOpenDelete(target);
                }}
              >
                <span>删除</span>
              </button>
            </>
          ) : (
            <>
              <button
                className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
                onClick={() => {
                  closeContextMenu();
                  onNewFolder();
                }}
              >
                <span>新建文件夹</span>
              </button>
              <button
                className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
                onClick={() => {
                  closeContextMenu();
                  onNewFile();
                }}
              >
                <span>新建文件</span>
              </button>
              <button
                className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
                onClick={() => {
                  closeContextMenu();
                  onTriggerUpload();
                }}
              >
                <span>上传文件</span>
              </button>
              <button
                className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
                onClick={() => {
                  closeContextMenu();
                  onCdInTerminal(currentPath || '/');
                }}
              >
                <span>在终端中进入当前目录</span>
              </button>
              <div className="h-px my-1" style={{ backgroundColor: theme.ui.border }} />
              <button
                className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
                onClick={() => {
                  closeContextMenu();
                  onRefresh();
                }}
              >
                <span>刷新</span>
              </button>
            </>
          )}
        </div>
      )}

      {activeDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setActiveDialog(null)}
        >
          <div
            className="w-[370px] rounded-lg shadow-2xl border p-4 flex flex-col gap-3"
            style={{
              backgroundColor: theme.ui.cardBg,
              borderColor: theme.ui.border,
              color: theme.ui.text,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold">
                {activeDialog === 'new_folder' && '新建文件夹'}
                {activeDialog === 'new_file' && '新建文件'}
                {activeDialog === 'rename' && '重命名'}
                {activeDialog === 'chmod' && '修改文件权限 (chmod)'}
                {activeDialog === 'delete' && '确认删除'}
              </span>
              <button
                onClick={() => setActiveDialog(null)}
                className="p-1 rounded hover:opacity-100 opacity-60 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {activeDialog === 'delete' ? (
              <div className="text-xs space-y-2 py-1">
                <p>确定要删除此{dialogTarget?.is_dir ? '文件夹' : '文件'}吗？</p>
                <p
                  className="font-mono text-[11px] px-2 py-1 rounded break-all"
                  style={{ backgroundColor: theme.ui.hoverBg, color: theme.ui.textMuted }}
                >
                  {dialogTarget?.path}
                </p>
                {dialogTarget?.is_dir && (
                  <label className="flex items-center gap-2 text-[11px] text-amber-400 cursor-pointer pt-1">
                    <input
                      type="checkbox"
                      checked={recursiveDelete}
                      onChange={(e) => setRecursiveDelete(e.target.checked)}
                      className="accent-amber-500"
                    />
                    <span>递归删除目录内所有子文件与子目录</span>
                  </label>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px]" style={{ color: theme.ui.textMuted }}>
                  {activeDialog === 'rename'
                    ? '新名称'
                    : activeDialog === 'chmod'
                      ? '八进制权限值（例如 755、644、600）'
                      : '名称'}
                </label>
                <input
                  ref={dialogInputRef}
                  type="text"
                  value={dialogInput}
                  onChange={(e) => setDialogInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onDialogSubmit();
                    if (e.key === 'Escape') setActiveDialog(null);
                  }}
                  className="w-full px-2.5 py-1.5 rounded text-xs font-mono outline-none border"
                  style={{
                    backgroundColor: theme.ui.sidebarBg,
                    borderColor: theme.ui.border,
                    color: theme.ui.text,
                  }}
                  placeholder={activeDialog === 'chmod' ? '755' : '请输入名称'}
                />
                {activeDialog === 'chmod' && /^[0-7]{3,4}$/.test(dialogInput.trim()) && (
                  <span className="text-[10px] font-mono" style={{ color: theme.ui.accent }}>
                    预览: {formatPermissions(parseInt(dialogInput.trim(), 8))}
                  </span>
                )}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => setActiveDialog(null)}
                className="px-3 py-1 rounded text-xs border cursor-pointer hover:opacity-80"
                style={{
                  borderColor: theme.ui.border,
                  backgroundColor: theme.ui.hoverBg,
                  color: theme.ui.text,
                }}
              >
                取消
              </button>
              <button
                onClick={onDialogSubmit}
                className={`px-3 py-1 rounded text-xs font-semibold cursor-pointer ${
                  activeDialog === 'delete' ? 'bg-red-500 hover:bg-red-600 text-white' : ''
                }`}
                style={activeDialog !== 'delete' ? getPrimaryButtonStyle(theme) : undefined}
              >
                {activeDialog === 'delete' ? '确认删除' : '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
