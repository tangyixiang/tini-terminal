import React, { useRef } from 'react';
import { Folder, Upload, X } from 'lucide-react';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { BUILTIN_THEMES } from '../../types/theme';
import { useSftpController } from './useSftpController';
import { SftpToolbar } from './SftpToolbar';
import { SftpFileList } from './SftpFileList';
import { SftpEditorPane } from './SftpEditorPane';
import { SftpTransferQueue } from './SftpTransferQueue';
import { SftpDialogs } from './SftpDialogs';

export const FileManagerDrawer: React.FC = () => {
  const { isSftpDrawerOpen, toggleSftpDrawer, themeId } = useSettingsStore();
  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;
  const { tabs, activeTabId } = useTerminalStore();
  const activeTab = tabs.find((t) => t.id === activeTabId);

  const drawerRef = useRef<HTMLDivElement>(null);
  const ctrl = useSftpController(isSftpDrawerOpen, activeTab, drawerRef);

  if (!isSftpDrawerOpen) return null;

  return (
    <div
      ref={drawerRef}
      className="fixed inset-y-0 right-0 border-l shadow-2xl z-40 flex flex-col select-none transition-colors duration-200"
      style={{
        width: `min(${ctrl.drawerWidth}px, 82vw)`,
        backgroundColor: currentTheme.ui.cardBg,
        borderColor: currentTheme.ui.border,
        color: currentTheme.ui.text,
      }}
    >
      {/* 左侧宽度拖拽条 */}
      <div
        onMouseDown={ctrl.handleResizeDrawer}
        className="absolute inset-y-0 -left-1.5 w-3 cursor-col-resize z-50 hover:bg-emerald-500/20"
        title="按住左右拖拽调整 SFTP 抽屉宽度"
      />

      {/* 头部标题 */}
      <div
        className="h-10 px-3 border-b flex items-center justify-between shrink-0"
        style={{
          backgroundColor: currentTheme.ui.headerBg,
          borderColor: currentTheme.ui.border,
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Folder className="w-4 h-4 shrink-0" style={{ color: currentTheme.ui.accent }} />
          <span className="text-xs font-semibold whitespace-nowrap">SFTP 文件管理器</span>
          <span className="text-[10px] font-mono truncate" style={{ color: currentTheme.ui.textMuted }}>
            {activeTab?.title || '无活动 SSH 会话'}
          </span>
        </div>
        <button
          onClick={() => toggleSftpDrawer(false)}
          className="p-1 rounded cursor-pointer hover:opacity-100 opacity-60 transition-opacity"
          style={{ color: currentTheme.ui.text }}
          title="关闭"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 面包屑、工具栏与过滤排序栏 */}
      <SftpToolbar
        theme={currentTheme}
        currentPath={ctrl.currentPath}
        isEditingPath={ctrl.isEditingPath}
        setIsEditingPath={ctrl.setIsEditingPath}
        pathInput={ctrl.pathInput}
        setPathInput={ctrl.setPathInput}
        loading={ctrl.loading}
        isSshActive={Boolean(activeTab?.isSsh)}
        hasRunningTransfer={ctrl.hasRunningTransfer}
        showFilterBar={!ctrl.selectedFile}
        filterText={ctrl.filterText}
        setFilterText={ctrl.setFilterText}
        sortField={ctrl.sortField}
        sortAsc={ctrl.sortAsc}
        toggleSort={ctrl.toggleSort}
        showHidden={ctrl.showHidden}
        setShowHidden={ctrl.setShowHidden}
        fileInputRef={ctrl.fileInputRef}
        onGoUp={ctrl.handleGoUp}
        onBreadcrumbClick={ctrl.handleBreadcrumbClick}
        onLoadDirectory={ctrl.loadDirectory}
        onSyncCwd={ctrl.syncWithTerminalCwd}
        onNewFolder={() => {
          ctrl.setDialogInput('');
          ctrl.setActiveDialog('new_folder');
        }}
        onNewFile={() => {
          ctrl.setDialogInput('');
          ctrl.setActiveDialog('new_file');
        }}
        onUploadFiles={ctrl.uploadFilesChunked}
      />

      {ctrl.statusMsg && (
        <div
          className="px-3 py-1 text-[11px] border-b truncate font-mono shrink-0"
          style={{
            backgroundColor: currentTheme.ui.hoverBg,
            borderColor: currentTheme.ui.border,
            color: currentTheme.ui.accent,
          }}
          title={ctrl.statusMsg}
        >
          {ctrl.statusMsg}
        </div>
      )}

      {/* 主工作区 */}
      <div
        className="flex-1 overflow-hidden flex flex-col relative"
        onContextMenu={(e) => ctrl.handleContextMenu(e, null)}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!ctrl.isDragging) ctrl.setIsDragging(true);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
          ctrl.setIsDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          ctrl.setIsDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          ctrl.setIsDragging(false);
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            ctrl.uploadFilesChunked(e.dataTransfer.files);
          }
        }}
      >
        {ctrl.isDragging && (
          <div
            className="absolute inset-2 border-2 border-dashed rounded-lg flex flex-col items-center justify-center pointer-events-none z-30"
            style={{
              borderColor: currentTheme.ui.accent,
              backgroundColor: currentTheme.isDark
                ? 'rgba(0, 0, 0, 0.85)'
                : 'rgba(255, 255, 255, 0.92)',
            }}
          >
            <Upload className="w-8 h-8 mb-2 animate-bounce" style={{ color: currentTheme.ui.accent }} />
            <p className="text-xs font-semibold">释放文件或文件夹上传至当前目录</p>
            <p className="text-[10px] font-mono mt-1" style={{ color: currentTheme.ui.textMuted }}>
              {ctrl.currentPath || '/'}
            </p>
          </div>
        )}

        {ctrl.selectedFile ? (
          <SftpEditorPane
            theme={currentTheme}
            file={ctrl.selectedFile}
            content={ctrl.fileContent}
            onChange={ctrl.setFileContent}
            isDirty={ctrl.isEditorDirty}
            saving={ctrl.saving}
            onClose={ctrl.handleCloseEditor}
            onSave={ctrl.handleSaveFile}
          />
        ) : (
          <SftpFileList
            theme={currentTheme}
            files={ctrl.filteredAndSortedFiles}
            loading={ctrl.loading}
            filterText={ctrl.filterText}
            onEnterDir={ctrl.loadDirectory}
            onOpenFile={ctrl.handleOpenFile}
            onDownload={ctrl.handleDownloadFile}
            onChmod={ctrl.openChmodDialog}
            onRename={ctrl.openRenameDialog}
            onDelete={ctrl.openDeleteDialog}
            onContextMenu={ctrl.handleContextMenu}
          />
        )}
      </div>

      {/* 传输进度队列 */}
      <SftpTransferQueue
        theme={currentTheme}
        transfers={ctrl.transfers}
        onClearFinished={() =>
          ctrl.setTransfers((prev) => prev.filter((t) => t.status === 'running'))
        }
        onCancel={ctrl.handleCancelTransfer}
      />

      {/* 右键菜单与操作弹窗 */}
      <SftpDialogs
        theme={currentTheme}
        currentPath={ctrl.currentPath}
        contextMenu={ctrl.contextMenu}
        closeContextMenu={() => ctrl.setContextMenu((prev) => ({ ...prev, visible: false }))}
        activeDialog={ctrl.activeDialog}
        setActiveDialog={ctrl.setActiveDialog}
        dialogInput={ctrl.dialogInput}
        setDialogInput={ctrl.setDialogInput}
        dialogTarget={ctrl.dialogTarget}
        recursiveDelete={ctrl.recursiveDelete}
        setRecursiveDelete={ctrl.setRecursiveDelete}
        dialogInputRef={ctrl.dialogInputRef}
        onDialogSubmit={ctrl.handleDialogSubmit}
        onEnterDir={ctrl.loadDirectory}
        onOpenFile={ctrl.handleOpenFile}
        onCdInTerminal={ctrl.handleCdInTerminal}
        onDownload={ctrl.handleDownloadFile}
        onCopyPath={(path) => {
          navigator.clipboard.writeText(path).catch(() => {});
          ctrl.setStatusMsg(`已复制路径: ${path}`);
        }}
        onOpenChmod={ctrl.openChmodDialog}
        onOpenRename={ctrl.openRenameDialog}
        onOpenDelete={ctrl.openDeleteDialog}
        onNewFolder={() => {
          ctrl.setDialogInput('');
          ctrl.setActiveDialog('new_folder');
        }}
        onNewFile={() => {
          ctrl.setDialogInput('');
          ctrl.setActiveDialog('new_file');
        }}
        onTriggerUpload={() => ctrl.fileInputRef.current?.click()}
        onRefresh={() => ctrl.loadDirectory(ctrl.currentPath)}
      />
    </div>
  );
};
