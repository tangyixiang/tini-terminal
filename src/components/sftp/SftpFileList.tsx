import React from 'react';
import {
  Folder,
  FileText,
  Upload,
  Link2,
  Download,
  Shield,
  Pencil,
  Trash2,
} from 'lucide-react';
import type { RemoteFileInfo } from '../../types';
import type { ThemeConfig } from '../../types/theme';
import { formatBytes, formatMtime, formatPermissions } from './sftpUtils';

interface SftpFileListProps {
  theme: ThemeConfig;
  files: RemoteFileInfo[];
  loading: boolean;
  filterText: string;
  onEnterDir: (path: string) => void;
  onOpenFile: (file: RemoteFileInfo) => void;
  onDownload: (file: RemoteFileInfo) => void;
  onChmod: (file: RemoteFileInfo) => void;
  onRename: (file: RemoteFileInfo) => void;
  onDelete: (file: RemoteFileInfo) => void;
  onContextMenu: (e: React.MouseEvent, file: RemoteFileInfo) => void;
}

export const SftpFileList: React.FC<SftpFileListProps> = ({
  theme,
  files,
  loading,
  filterText,
  onEnterDir,
  onOpenFile,
  onDownload,
  onChmod,
  onRename,
  onDelete,
  onContextMenu,
}) => {
  return (
    <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
      {files.length === 0 && !loading ? (
        <div className="text-center py-16 text-xs space-y-2" style={{ color: theme.ui.textMuted }}>
          <Upload className="w-8 h-8 mx-auto opacity-30" />
          <p>{filterText ? '无匹配文件' : '当前目录为空'}</p>
          <p className="text-[10px]">支持直接拖入本地文件或整个文件夹递归上传（双击文件在线编辑）</p>
        </div>
      ) : (
        files.map((file) => (
          <div
            key={file.path}
            onClick={() => {
              if (file.is_dir) onEnterDir(file.path);
            }}
            onDoubleClick={() => {
              if (!file.is_dir) onOpenFile(file);
            }}
            onContextMenu={(e) => onContextMenu(e, file)}
            className="flex items-center justify-between px-2 py-1.5 rounded text-xs cursor-pointer group transition-colors"
            style={{ color: theme.ui.text }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = theme.ui.hoverBg;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            title={`${file.path}\n权限: ${formatPermissions(file.permissions)}\n修改时间: ${formatMtime(file.mtime)}${!file.is_dir ? '\n双击编辑文本文件' : ''}`}
          >
            <div className="flex items-center gap-2 truncate flex-1 min-w-0 pr-2">
              {file.is_dir ? (
                <Folder className="w-3.5 h-3.5 shrink-0" style={{ color: theme.ui.accent }} />
              ) : (
                <FileText className="w-3.5 h-3.5 shrink-0" style={{ color: theme.ui.textMuted }} />
              )}
              <span className={`truncate font-mono ${file.is_dir ? 'font-medium' : ''}`}>
                {file.name}
              </span>
              {file.is_symlink && <Link2 className="w-3 h-3 shrink-0 text-cyan-400 opacity-80" />}
            </div>

            <div className="flex items-center gap-2 shrink-0 font-mono text-[10px]">
              <span
                className="hidden sm:inline opacity-65 w-[70px] text-right"
                style={{ color: theme.ui.textMuted }}
              >
                {formatPermissions(file.permissions).split(' ')[0]}
              </span>
              <span className="w-[62px] text-right" style={{ color: theme.ui.textMuted }}>
                {file.is_dir ? '目录' : formatBytes(file.size)}
              </span>
              <span
                className="hidden md:inline w-[108px] text-right opacity-65"
                style={{ color: theme.ui.textMuted }}
              >
                {formatMtime(file.mtime)}
              </span>

              <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                {!file.is_dir && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDownload(file);
                    }}
                    className="p-1 rounded hover:bg-white/10 cursor-pointer"
                    style={{ color: theme.ui.accent }}
                    title="下载到本地"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onChmod(file);
                  }}
                  className="p-1 rounded hover:bg-white/10 cursor-pointer"
                  style={{ color: theme.ui.textMuted }}
                  title="修改权限 (chmod)"
                >
                  <Shield className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRename(file);
                  }}
                  className="p-1 rounded hover:bg-white/10 cursor-pointer"
                  style={{ color: theme.ui.textMuted }}
                  title="重命名"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(file);
                  }}
                  className="p-1 rounded hover:bg-white/10 cursor-pointer text-red-400"
                  title="删除"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
};
