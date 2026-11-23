import React, { type RefObject } from 'react';
import {
  ArrowUp,
  ChevronRight,
  Compass,
  FolderPlus,
  FilePlus,
  Loader2,
  Upload,
  RefreshCw,
  Search,
  Eye,
  EyeOff,
} from 'lucide-react';
import type { ThemeConfig } from '../../types/theme';
import type { SortField } from './sftpUtils';

interface SftpToolbarProps {
  theme: ThemeConfig;
  currentPath: string;
  isEditingPath: boolean;
  setIsEditingPath: (v: boolean) => void;
  pathInput: string;
  setPathInput: (v: string) => void;
  loading: boolean;
  isSshActive: boolean;
  hasRunningTransfer: boolean;
  showFilterBar: boolean;
  filterText: string;
  setFilterText: (v: string) => void;
  sortField: SortField;
  sortAsc: boolean;
  toggleSort: (field: SortField) => void;
  showHidden: boolean;
  setShowHidden: (v: boolean) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onGoUp: () => void;
  onBreadcrumbClick: (index: number, segments: string[]) => void;
  onLoadDirectory: (path: string) => void;
  onSyncCwd: () => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onUploadFiles: (files: FileList) => void;
}

export const SftpToolbar: React.FC<SftpToolbarProps> = ({
  theme,
  currentPath,
  isEditingPath,
  setIsEditingPath,
  pathInput,
  setPathInput,
  loading,
  isSshActive,
  hasRunningTransfer,
  showFilterBar,
  filterText,
  setFilterText,
  sortField,
  sortAsc,
  toggleSort,
  showHidden,
  setShowHidden,
  fileInputRef,
  onGoUp,
  onBreadcrumbClick,
  onLoadDirectory,
  onSyncCwd,
  onNewFolder,
  onNewFile,
  onUploadFiles,
}) => {
  const pathSegments = currentPath.split('/').filter(Boolean);

  return (
    <>
      <div
        className="h-9 border-b px-2.5 flex items-center justify-between gap-2 text-xs shrink-0"
        style={{
          backgroundColor: theme.ui.sidebarBg,
          borderColor: theme.ui.border,
        }}
      >
        <div className="flex items-center gap-1 min-w-0 flex-1 overflow-hidden font-mono text-[11px]">
          <button
            onClick={onGoUp}
            disabled={currentPath === '/' || loading}
            className="p-1 rounded hover:opacity-100 opacity-70 disabled:opacity-30 cursor-pointer shrink-0"
            title="返回上一级"
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>

          {isEditingPath ? (
            <input
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setIsEditingPath(false);
                  onLoadDirectory(pathInput);
                } else if (e.key === 'Escape') {
                  setIsEditingPath(false);
                  setPathInput(currentPath);
                }
              }}
              onBlur={() => {
                setIsEditingPath(false);
                setPathInput(currentPath);
              }}
              autoFocus
              className="flex-1 px-1.5 py-0.5 rounded text-[11px] font-mono outline-none border"
              style={{
                backgroundColor: theme.ui.cardBg,
                borderColor: theme.ui.accent,
                color: theme.ui.text,
              }}
            />
          ) : (
            <div
              className="flex items-center gap-0.5 truncate overflow-x-auto no-scrollbar cursor-pointer py-0.5 px-1 rounded hover:bg-white/5"
              onClick={() => setIsEditingPath(true)}
              title="点击编辑绝对路径"
            >
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onBreadcrumbClick(-1, []);
                }}
                className="hover:underline px-0.5 font-medium shrink-0"
                style={{ color: theme.ui.accent }}
              >
                /
              </span>
              {pathSegments.map((seg, idx) => (
                <React.Fragment key={idx}>
                  <ChevronRight className="w-3 h-3 shrink-0 opacity-40" />
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      onBreadcrumbClick(idx, pathSegments);
                    }}
                    className="hover:underline px-0.5 truncate shrink-0 max-w-[120px]"
                    style={{
                      color:
                        idx === pathSegments.length - 1
                          ? theme.ui.text
                          : theme.ui.textMuted,
                      fontWeight: idx === pathSegments.length - 1 ? 600 : 400,
                    }}
                  >
                    {seg}
                  </span>
                </React.Fragment>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                onUploadFiles(e.target.files);
                e.target.value = '';
              }
            }}
          />

          <button
            onClick={onSyncCwd}
            disabled={loading || !isSshActive}
            className="p-1.5 rounded hover:opacity-100 opacity-75 cursor-pointer border"
            style={{
              borderColor: theme.ui.border,
              backgroundColor: theme.ui.hoverBg,
              color: theme.ui.accent,
            }}
            title="跳转到终端当前目录 (同步 cwd)"
          >
            <Compass className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={onNewFolder}
            disabled={loading}
            className="p-1.5 rounded hover:opacity-100 opacity-75 cursor-pointer border"
            style={{
              borderColor: theme.ui.border,
              backgroundColor: theme.ui.hoverBg,
              color: theme.ui.text,
            }}
            title="新建文件夹"
          >
            <FolderPlus className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={onNewFile}
            disabled={loading}
            className="p-1.5 rounded hover:opacity-100 opacity-75 cursor-pointer border"
            style={{
              borderColor: theme.ui.border,
              backgroundColor: theme.ui.hoverBg,
              color: theme.ui.text,
            }}
            title="新建文件"
          >
            <FilePlus className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
            className="px-2 py-1 rounded hover:opacity-100 opacity-80 cursor-pointer flex items-center gap-1 border"
            style={{
              borderColor: theme.ui.border,
              backgroundColor: theme.ui.hoverBg,
              color: theme.ui.text,
            }}
            title="选择文件分片上传（支持大文件）"
          >
            {hasRunningTransfer ? (
              <Loader2 className="w-3 h-3 animate-spin text-emerald-400" />
            ) : (
              <Upload className="w-3 h-3" />
            )}
            <span className="text-[11px] font-medium">上传</span>
          </button>

          <button
            onClick={() => onLoadDirectory(currentPath)}
            disabled={loading}
            className="p-1.5 rounded hover:opacity-100 opacity-75 cursor-pointer"
            title="刷新目录"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {showFilterBar && (
        <div
          className="px-2.5 py-1.5 border-b flex items-center justify-between gap-2 text-[11px] shrink-0"
          style={{ borderColor: theme.ui.border }}
        >
          <div className="relative flex-1">
            <Search
              className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2"
              style={{ color: theme.ui.textMuted }}
            />
            <input
              type="text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="过滤当前目录文件名..."
              className="w-full pl-6 pr-2 py-0.5 rounded border text-[11px] outline-none"
              style={{
                backgroundColor: theme.ui.inputBg,
                borderColor: theme.ui.border,
                color: theme.ui.text,
              }}
            />
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => toggleSort('name')}
              className="px-1.5 py-0.5 rounded cursor-pointer hover:bg-white/5"
              style={{ color: sortField === 'name' ? theme.ui.accent : theme.ui.textMuted }}
            >
              名称{sortField === 'name' ? (sortAsc ? '↑' : '↓') : ''}
            </button>
            <button
              type="button"
              onClick={() => toggleSort('size')}
              className="px-1.5 py-0.5 rounded cursor-pointer hover:bg-white/5"
              style={{ color: sortField === 'size' ? theme.ui.accent : theme.ui.textMuted }}
            >
              大小{sortField === 'size' ? (sortAsc ? '↑' : '↓') : ''}
            </button>
            <button
              type="button"
              onClick={() => toggleSort('mtime')}
              className="px-1.5 py-0.5 rounded cursor-pointer hover:bg-white/5"
              style={{ color: sortField === 'mtime' ? theme.ui.accent : theme.ui.textMuted }}
            >
              时间{sortField === 'mtime' ? (sortAsc ? '↑' : '↓') : ''}
            </button>
            <button
              type="button"
              onClick={() => setShowHidden(!showHidden)}
              className="p-1 rounded cursor-pointer hover:bg-white/10"
              style={{ color: showHidden ? theme.ui.accent : theme.ui.textMuted }}
              title={showHidden ? '当前显示隐藏文件（点击隐藏）' : '当前隐藏点文件（点击显示）'}
            >
              {showHidden ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      )}
    </>
  );
};
