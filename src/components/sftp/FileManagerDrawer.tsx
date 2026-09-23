import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Folder,
  FolderPlus,
  FileText,
  FilePlus,
  ArrowUp,
  RefreshCw,
  Save,
  Loader2,
  Upload,
  Download,
  Trash2,
  Pencil,
  ChevronRight,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { BUILTIN_THEMES } from '../../types/theme';
import type { RemoteFileInfo, SftpListResult } from '../../types';

type DialogType = 'new_folder' | 'new_file' | 'rename' | 'delete' | null;

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  item: RemoteFileInfo | null;
}

export const FileManagerDrawer: React.FC = () => {
  const { isSftpDrawerOpen, toggleSftpDrawer, themeId } = useSettingsStore();
  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;
  const { tabs, activeTabId } = useTerminalStore();
  const activeTab = tabs.find((t) => t.id === activeTabId);

  const [currentPath, setCurrentPath] = useState('');
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [files, setFiles] = useState<RemoteFileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<RemoteFileInfo | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  // 弹窗与交互状态
  const [activeDialog, setActiveDialog] = useState<DialogType>(null);
  const [dialogInput, setDialogInput] = useState('');
  const [dialogTarget, setDialogTarget] = useState<RemoteFileInfo | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    item: null,
  });

  const drawerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogInputRef = useRef<HTMLInputElement>(null);

  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const loadDirectory = async (dirPath: string = '') => {
    const tab = activeTabRef.current;
    if (!tab || !tab.isSsh) {
      setStatusMsg('请先激活并连接一个 SSH 远程终端');
      return;
    }

    setLoading(true);
    setStatusMsg('');
    try {
      if (window.__TAURI_INTERNALS__) {
        const res = await invoke<SftpListResult>('sftp_list_dir', {
          sessionId: tab.sessionId,
          remotePath: dirPath,
        });
        setFiles(res.files || []);
        setCurrentPath(res.current_dir);
        setPathInput(res.current_dir);
      } else {
        // 开发预览环境模拟
        const mockTarget = dirPath || '/root';
        setFiles([
          { name: 'nginx.conf', path: `${mockTarget}/nginx.conf`, size: 1420, is_dir: false, permissions: 420, mtime: Date.now() },
          { name: 'conf.d', path: `${mockTarget}/conf.d`, size: 4096, is_dir: true, permissions: 493, mtime: Date.now() },
          { name: 'access.log', path: `${mockTarget}/access.log`, size: 84920, is_dir: false, permissions: 420, mtime: Date.now() },
        ]);
        setCurrentPath(mockTarget);
        setPathInput(mockTarget);
      }
    } catch (e: any) {
      setStatusMsg(`读取目录失败: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isSftpDrawerOpen && activeTab && activeTab.isSsh) {
      // 传入空字符串，后端直接执行 realpath(".") 解析用户默认根目录，单次网络往返即可完成
      loadDirectory('');
    }
  }, [isSftpDrawerOpen, activeTab?.sessionId]);

  // 监听 Tauri 2 原生文件拖拽（解决 macOS 拦截从访达拖入图片/文件的问题）
  useEffect(() => {
    if (!isSftpDrawerOpen || !window.__TAURI_INTERNALS__) return;
    let unlistenFn: (() => void) | null = null;
    let isMounted = true;

    const setupListener = async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (!isMounted) return;
          const payload = event.payload;
          if (!drawerRef.current) return;
          const rect = drawerRef.current.getBoundingClientRect();
          const dpr = window.devicePixelRatio || 1;

          if (payload.type === 'enter' || payload.type === 'over') {
            const px = payload.position ? payload.position.x / dpr : 0;
            const py = payload.position ? payload.position.y / dpr : 0;
            const inside = px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom;
            setIsDragging(inside);
          } else if (payload.type === 'leave') {
            setIsDragging(false);
          } else if (payload.type === 'drop') {
            setIsDragging(false);
            const px = payload.position ? payload.position.x / dpr : 0;
            const py = payload.position ? payload.position.y / dpr : 0;
            const inside = px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom;
            if (inside && payload.paths && payload.paths.length > 0) {
              uploadLocalPaths(payload.paths);
            }
          }
        });
        if (isMounted) {
          unlistenFn = unlisten;
        } else {
          unlisten();
        }
      } catch (err) {
        console.warn('注册 Tauri 原生拖拽监听器失败:', err);
      }
    };

    setupListener();

    return () => {
      isMounted = false;
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, [isSftpDrawerOpen]);

  // 点击空白处关闭右键菜单
  useEffect(() => {
    const handleGlobalClick = () => {
      if (contextMenu.visible) {
        setContextMenu((prev) => ({ ...prev, visible: false }));
      }
    };
    window.addEventListener('click', handleGlobalClick);
    return () => window.removeEventListener('click', handleGlobalClick);
  }, [contextMenu.visible]);

  // 弹窗打开时聚焦输入框
  useEffect(() => {
    if (activeDialog && activeDialog !== 'delete') {
      setTimeout(() => dialogInputRef.current?.focus(), 50);
    }
  }, [activeDialog]);

  if (!isSftpDrawerOpen) return null;

  // 上传本地绝对路径文件列表
  const uploadLocalPaths = async (paths: string[]) => {
    const tab = activeTabRef.current;
    const pathTarget = currentPathRef.current || '/';
    if (!tab || !tab.isSsh) {
      setStatusMsg('请先激活并连接一个 SSH 远程终端');
      return;
    }
    if (paths.length === 0) return;

    setUploading(true);
    let successCount = 0;
    try {
      const remoteClean = pathTarget.trim().replace(/\/+$/, '');
      for (let i = 0; i < paths.length; i++) {
        const localPath = paths[i];
        const fileName = localPath.split(/[/\\]/).pop() || `file_${i}`;
        setStatusMsg(`正在上传 (${i + 1}/${paths.length}): ${fileName}...`);
        const remotePath = `${remoteClean}/${fileName}`;
        await invoke('sftp_upload_file', {
          sessionId: tab.sessionId,
          localPath,
          remotePath,
        });
        successCount++;
      }
      setStatusMsg(`已成功上传 ${successCount} 个文件至当前目录`);
      await loadDirectory(pathTarget);
    } catch (e: any) {
      setStatusMsg(`上传失败: ${e?.message || e}`);
    } finally {
      setUploading(false);
    }
  };

  // HTML5 原生拖拽与文件选择器兜底上传
  const uploadFiles = async (fileList: FileList | File[]) => {
    const tab = activeTabRef.current;
    const pathTarget = currentPathRef.current || '/';
    if (!tab || !tab.isSsh) {
      setStatusMsg('请先激活并连接一个 SSH 远程终端');
      return;
    }

    const filesArray = Array.from(fileList);
    if (filesArray.length === 0) return;

    setUploading(true);
    let successCount = 0;
    try {
      const remoteClean = pathTarget.trim().replace(/\/+$/, '');
      for (let i = 0; i < filesArray.length; i++) {
        const file = filesArray[i];
        setStatusMsg(`正在上传 (${i + 1}/${filesArray.length}): ${file.name}...`);

        const localPath = (file as any).path;
        if (localPath && window.__TAURI_INTERNALS__) {
          const remotePath = `${remoteClean}/${file.name}`;
          await invoke('sftp_upload_file', {
            sessionId: tab.sessionId,
            localPath,
            remotePath,
          });
        } else if (window.__TAURI_INTERNALS__) {
          const arrayBuf = await file.arrayBuffer();
          const data = Array.from(new Uint8Array(arrayBuf));
          await invoke('sftp_upload_bytes', {
            sessionId: tab.sessionId,
            remoteDir: pathTarget,
            fileName: file.name,
            data,
          });
        }
        successCount++;
      }
      setStatusMsg(`已成功上传 ${successCount} 个文件至当前目录`);
      await loadDirectory(pathTarget);
    } catch (e: any) {
      setStatusMsg(`上传失败: ${e?.message || e}`);
    } finally {
      setUploading(false);
    }
  };

  const handleOpenFile = async (file: RemoteFileInfo) => {
    if (!activeTab) return;
    setSelectedFile(file);
    setLoading(true);
    setStatusMsg('');
    try {
      if (window.__TAURI_INTERNALS__) {
        const content = await invoke<string>('sftp_read_file', {
          sessionId: activeTab.sessionId,
          remotePath: file.path,
        });
        setFileContent(content);
      } else {
        setFileContent('# 预览环境内容\nserver {\n    listen 80;\n    server_name localhost;\n}');
      }
    } catch (e: any) {
      setStatusMsg(`读取文件失败: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveFile = async () => {
    if (!activeTab || !selectedFile) return;
    setSaving(true);
    try {
      if (window.__TAURI_INTERNALS__) {
        await invoke('sftp_write_file', {
          sessionId: activeTab.sessionId,
          remotePath: selectedFile.path,
          content: fileContent,
        });
        setStatusMsg('文件已成功保存');
      } else {
        setStatusMsg('模拟保存成功');
      }
    } catch (e: any) {
      setStatusMsg(`保存文件失败: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadFile = async (file: RemoteFileInfo) => {
    if (!activeTab || file.is_dir) return;
    setStatusMsg(`正在下载 ${file.name}...`);
    try {
      if (window.__TAURI_INTERNALS__) {
        const localPath = await invoke<string>('sftp_download_file', {
          sessionId: activeTab.sessionId,
          remotePath: file.path,
        });
        setStatusMsg(`已下载至: ${localPath}`);
      } else {
        setStatusMsg(`已下载至 Downloads 目录`);
      }
    } catch (e: any) {
      setStatusMsg(`下载失败: ${e?.message || e}`);
    }
  };

  const handleGoUp = () => {
    if (currentPath === '/' || !currentPath.includes('/')) return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    const upPath = '/' + parts.join('/');
    loadDirectory(upPath || '/');
  };

  const handleBreadcrumbClick = (index: number, segments: string[]) => {
    if (index === -1) {
      loadDirectory('/');
      return;
    }
    const targetPath = '/' + segments.slice(0, index + 1).join('/');
    loadDirectory(targetPath);
  };

  // 执行弹窗确认操作（新建文件夹、新建文件、重命名、删除）
  const handleDialogSubmit = async () => {
    if (!activeTab) return;
    const tab = activeTab;
    const remoteClean = currentPath.trim().replace(/\/+$/, '');

    try {
      if (activeDialog === 'new_folder') {
        const name = dialogInput.trim();
        if (!name) return;
        const targetPath = `${remoteClean}/${name}`;
        if (window.__TAURI_INTERNALS__) {
          await invoke('sftp_mkdir', {
            sessionId: tab.sessionId,
            remotePath: targetPath,
          });
        }
        setStatusMsg(`已创建文件夹: ${name}`);
        await loadDirectory(currentPath);
      } else if (activeDialog === 'new_file') {
        const name = dialogInput.trim();
        if (!name) return;
        const targetPath = `${remoteClean}/${name}`;
        if (window.__TAURI_INTERNALS__) {
          await invoke('sftp_create_file', {
            sessionId: tab.sessionId,
            remotePath: targetPath,
          });
        }
        setStatusMsg(`已创建文件: ${name}`);
        await loadDirectory(currentPath);
      } else if (activeDialog === 'rename' && dialogTarget) {
        const newName = dialogInput.trim();
        if (!newName || newName === dialogTarget.name) {
          setActiveDialog(null);
          return;
        }
        const parentDir = dialogTarget.path.substring(0, dialogTarget.path.lastIndexOf('/')) || '/';
        const cleanParent = parentDir.replace(/\/+$/, '');
        const newPath = `${cleanParent}/${newName}`;
        if (window.__TAURI_INTERNALS__) {
          await invoke('sftp_rename', {
            sessionId: tab.sessionId,
            oldPath: dialogTarget.path,
            newPath,
          });
        }
        setStatusMsg(`已重命名为: ${newName}`);
        await loadDirectory(currentPath);
      } else if (activeDialog === 'delete' && dialogTarget) {
        if (window.__TAURI_INTERNALS__) {
          await invoke('sftp_remove', {
            sessionId: tab.sessionId,
            remotePath: dialogTarget.path,
            isDir: dialogTarget.is_dir,
          });
        }
        setStatusMsg(`已删除: ${dialogTarget.name}`);
        await loadDirectory(currentPath);
      }
    } catch (err: any) {
      setStatusMsg(`操作失败: ${err?.message || err}`);
    } finally {
      setActiveDialog(null);
      setDialogInput('');
      setDialogTarget(null);
    }
  };

  const openNewFolderDialog = () => {
    setDialogInput('');
    setActiveDialog('new_folder');
  };

  const openNewFileDialog = () => {
    setDialogInput('');
    setActiveDialog('new_file');
  };

  const openRenameDialog = (item: RemoteFileInfo) => {
    setDialogTarget(item);
    setDialogInput(item.name);
    setActiveDialog('rename');
  };

  const openDeleteDialog = (item: RemoteFileInfo) => {
    setDialogTarget(item);
    setActiveDialog('delete');
  };

  const handleContextMenu = (e: React.MouseEvent, item: RemoteFileInfo | null) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      visible: true,
      x: Math.min(e.clientX, window.innerWidth - 180),
      y: Math.min(e.clientY, window.innerHeight - 200),
      item,
    });
  };

  // 面包屑路径切分
  const pathSegments = currentPath.split('/').filter(Boolean);

  return (
    <div
      ref={drawerRef}
      className="fixed inset-y-0 right-0 w-[580px] border-l shadow-2xl z-40 flex flex-col select-none transition-colors duration-200"
      style={{
        backgroundColor: currentTheme.ui.cardBg,
        borderColor: currentTheme.ui.border,
        color: currentTheme.ui.text,
      }}
    >
      {/* 头部标题与关闭控制 */}
      <div
        className="h-10 px-3 border-b flex items-center justify-between"
        style={{
          backgroundColor: currentTheme.ui.headerBg,
          borderColor: currentTheme.ui.border,
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Folder className="w-4 h-4 shrink-0" style={{ color: currentTheme.ui.accent }} />
          <span className="text-xs font-semibold whitespace-nowrap" style={{ color: currentTheme.ui.text }}>
            SFTP 文件管理器
          </span>
          <span
            className="text-[10px] font-mono truncate"
            style={{ color: currentTheme.ui.textMuted }}
          >
            {activeTab?.title || '无活动 SSH 会话'}
          </span>
        </div>
        <button
          onClick={() => {
            toggleSftpDrawer(false);
            window.dispatchEvent(new CustomEvent('terminal:refocus'));
          }}
          className="p-1 rounded cursor-pointer hover:opacity-100 opacity-60 transition-opacity"
          style={{ color: currentTheme.ui.text }}
          title="关闭"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 面包屑可点击导航栏与快捷操作工具条 */}
      <div
        className="h-9 border-b px-2.5 flex items-center justify-between gap-2 text-xs"
        style={{
          backgroundColor: currentTheme.ui.sidebarBg,
          borderColor: currentTheme.ui.border,
        }}
      >
        <div className="flex items-center gap-1 min-w-0 flex-1 overflow-hidden font-mono text-[11px]">
          <button
            onClick={handleGoUp}
            disabled={currentPath === '/' || loading}
            className="p-1 rounded hover:opacity-100 opacity-70 disabled:opacity-30 cursor-pointer shrink-0 transition-opacity"
            style={{ color: currentTheme.ui.text }}
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
                  loadDirectory(pathInput);
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
                backgroundColor: currentTheme.ui.cardBg,
                borderColor: currentTheme.ui.accent,
                color: currentTheme.ui.text,
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
                  handleBreadcrumbClick(-1, []);
                }}
                className="hover:underline px-0.5 font-medium shrink-0"
                style={{ color: currentTheme.ui.accent }}
              >
                /
              </span>
              {pathSegments.map((seg, idx) => (
                <React.Fragment key={idx}>
                  <ChevronRight className="w-3 h-3 shrink-0 opacity-40" />
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      handleBreadcrumbClick(idx, pathSegments);
                    }}
                    className="hover:underline px-0.5 truncate shrink-0 max-w-[120px]"
                    style={{
                      color: idx === pathSegments.length - 1 ? currentTheme.ui.text : currentTheme.ui.textMuted,
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

        {/* 顶部工具栏操作区 */}
        <div className="flex items-center gap-1 shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                uploadFiles(e.target.files);
                e.target.value = '';
              }
            }}
          />

          <button
            onClick={openNewFolderDialog}
            disabled={loading}
            className="p-1.5 rounded hover:opacity-100 opacity-75 cursor-pointer transition-opacity border"
            style={{
              borderColor: currentTheme.ui.border,
              backgroundColor: currentTheme.ui.hoverBg,
              color: currentTheme.ui.text,
            }}
            title="新建文件夹"
          >
            <FolderPlus className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={openNewFileDialog}
            disabled={loading}
            className="p-1.5 rounded hover:opacity-100 opacity-75 cursor-pointer transition-opacity border"
            style={{
              borderColor: currentTheme.ui.border,
              backgroundColor: currentTheme.ui.hoverBg,
              color: currentTheme.ui.text,
            }}
            title="新建文件"
          >
            <FilePlus className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || loading}
            className="px-2 py-1 rounded hover:opacity-100 opacity-75 cursor-pointer flex items-center gap-1 transition-opacity border"
            style={{
              borderColor: currentTheme.ui.border,
              backgroundColor: currentTheme.ui.hoverBg,
              color: currentTheme.ui.text,
            }}
            title="上传本地文件"
          >
            {uploading ? (
              <Loader2 className="w-3 h-3 animate-spin text-emerald-400" />
            ) : (
              <Upload className="w-3 h-3" />
            )}
            <span className="text-[11px] font-medium">上传</span>
          </button>

          <button
            onClick={() => loadDirectory(currentPath)}
            disabled={loading}
            className="p-1.5 rounded hover:opacity-100 opacity-75 cursor-pointer transition-opacity"
            style={{ color: currentTheme.ui.text }}
            title="刷新目录"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {statusMsg && (
        <div
          className="px-3 py-1 text-[11px] border-b truncate font-mono"
          style={{
            backgroundColor: currentTheme.ui.hoverBg,
            borderColor: currentTheme.ui.border,
            color: currentTheme.ui.accent,
          }}
          title={statusMsg}
        >
          {statusMsg}
        </div>
      )}

      {/* 主工作区：文件列表或文件编辑器（支持拖拽文件/图片自动上传） */}
      <div
        className="flex-1 overflow-hidden flex flex-col relative"
        onContextMenu={(e) => handleContextMenu(e, null)}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!isDragging) setIsDragging(true);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setIsDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDragging(false);
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            uploadFiles(e.dataTransfer.files);
          }
        }}
      >
        {/* 拖拽释放文件浮层 */}
        {isDragging && !selectedFile && (
          <div
            className="absolute inset-2 border-2 border-dashed rounded-lg flex flex-col items-center justify-center pointer-events-none z-30"
            style={{
              borderColor: currentTheme.ui.accent,
              backgroundColor: currentTheme.isDark ? 'rgba(0, 0, 0, 0.85)' : 'rgba(255, 255, 255, 0.9)',
            }}
          >
            <Upload className="w-8 h-8 mb-2 animate-bounce" style={{ color: currentTheme.ui.accent }} />
            <p className="text-xs font-semibold" style={{ color: currentTheme.ui.text }}>
              释放文件上传至当前目录
            </p>
            <p className="text-[10px] font-mono mt-1" style={{ color: currentTheme.ui.textMuted }}>
              {currentPath || '/'}
            </p>
          </div>
        )}

        {selectedFile ? (
          /* 文件编辑视图 */
          <div
            className="flex-1 flex flex-col h-full"
            style={{ backgroundColor: currentTheme.ui.terminalBg }}
          >
            <div
              className="h-8 px-3 border-b flex items-center justify-between text-xs"
              style={{
                backgroundColor: currentTheme.ui.headerBg,
                borderColor: currentTheme.ui.border,
              }}
            >
              <span
                className="font-mono truncate text-[11px]"
                style={{ color: currentTheme.ui.text }}
              >
                {selectedFile.name}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setSelectedFile(null)}
                  className="px-2 py-0.5 rounded border text-[11px] cursor-pointer"
                  style={{
                    backgroundColor: currentTheme.ui.hoverBg,
                    borderColor: currentTheme.ui.border,
                    color: currentTheme.ui.text,
                  }}
                >
                  关闭
                </button>
                <button
                  onClick={handleSaveFile}
                  disabled={saving}
                  className="px-2.5 py-0.5 rounded text-[11px] font-semibold flex items-center gap-1 cursor-pointer text-black hover:opacity-90"
                  style={{ backgroundColor: '#23d18b', color: '#000000' }}
                >
                  {saving ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Save className="w-3 h-3" />
                  )}
                  保存覆盖
                </button>
              </div>
            </div>
            <textarea
              value={fileContent}
              onChange={(e) => setFileContent(e.target.value)}
              className="flex-1 w-full p-3 font-terminal text-[13px] leading-[18px] bg-transparent border-none outline-none resize-none"
              style={{
                color: currentTheme.ui.text,
                backgroundColor: currentTheme.ui.terminalBg,
              }}
              spellCheck={false}
            />
          </div>
        ) : (
          /* 文件目录列表 */
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {files.length === 0 && !loading ? (
              <div
                className="text-center py-16 text-xs space-y-2"
                style={{ color: currentTheme.ui.textMuted }}
              >
                <Upload className="w-8 h-8 mx-auto opacity-30" />
                <p>当前目录为空</p>
                <p className="text-[10px]">支持拖拽外部文件/图片到此处自动上传</p>
              </div>
            ) : (
              files.map((file) => (
                <div
                  key={file.path}
                  onClick={() => {
                    if (file.is_dir) {
                      loadDirectory(file.path);
                    } else {
                      handleOpenFile(file);
                    }
                  }}
                  onContextMenu={(e) => handleContextMenu(e, file)}
                  className="flex items-center justify-between px-2.5 py-1.5 rounded text-xs cursor-pointer group transition-colors"
                  style={{ color: currentTheme.ui.text }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = currentTheme.ui.hoverBg;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  <div className="flex items-center gap-2 truncate flex-1 min-w-0">
                    {file.is_dir ? (
                      <Folder className="w-3.5 h-3.5 shrink-0" style={{ color: currentTheme.ui.accent }} />
                    ) : (
                      <FileText className="w-3.5 h-3.5 shrink-0" style={{ color: currentTheme.ui.textMuted }} />
                    )}
                    <span
                      className={`truncate font-mono ${
                        file.is_dir ? 'font-medium' : ''
                      }`}
                      style={{ color: currentTheme.ui.text }}
                    >
                      {file.name}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <span
                      className="text-[10px] font-mono mr-1"
                      style={{ color: currentTheme.ui.textMuted }}
                    >
                      {file.is_dir ? '目录' : `${(file.size / 1024).toFixed(1)} KB`}
                    </span>

                    {/* 快捷悬浮操作按钮 */}
                    <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                      {!file.is_dir && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDownloadFile(file);
                          }}
                          className="p-1 rounded hover:bg-white/10 transition-colors cursor-pointer"
                          style={{ color: currentTheme.ui.accent }}
                          title="下载"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openRenameDialog(file);
                        }}
                        className="p-1 rounded hover:bg-white/10 transition-colors cursor-pointer"
                        style={{ color: currentTheme.ui.textMuted }}
                        title="重命名"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openDeleteDialog(file);
                        }}
                        className="p-1 rounded hover:bg-white/10 transition-colors cursor-pointer text-red-400"
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
        )}
      </div>

      {/* 右键上下文菜单 */}
      {contextMenu.visible && (
        <div
          className="fixed z-50 py-1 rounded shadow-xl border text-xs min-w-[140px]"
          style={{
            top: contextMenu.y,
            left: contextMenu.x,
            backgroundColor: currentTheme.ui.cardBg,
            borderColor: currentTheme.ui.border,
            color: currentTheme.ui.text,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.item ? (
            <>
              <button
                className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
                onClick={() => {
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                  if (contextMenu.item?.is_dir) {
                    loadDirectory(contextMenu.item.path);
                  } else if (contextMenu.item) {
                    handleOpenFile(contextMenu.item);
                  }
                }}
              >
                <span>{contextMenu.item.is_dir ? '进入目录' : '编辑文件'}</span>
              </button>
              {!contextMenu.item.is_dir && (
                <button
                  className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
                  onClick={() => {
                    setContextMenu((prev) => ({ ...prev, visible: false }));
                    if (contextMenu.item) handleDownloadFile(contextMenu.item);
                  }}
                >
                  <span>下载到本地</span>
                </button>
              )}
              <button
                className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
                onClick={() => {
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                  if (contextMenu.item) openRenameDialog(contextMenu.item);
                }}
              >
                <span>重命名</span>
              </button>
              <div className="h-px my-1" style={{ backgroundColor: currentTheme.ui.border }} />
              <button
                className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer text-red-400"
                onClick={() => {
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                  if (contextMenu.item) openDeleteDialog(contextMenu.item);
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
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                  openNewFolderDialog();
                }}
              >
                <span>新建文件夹</span>
              </button>
              <button
                className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
                onClick={() => {
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                  openNewFileDialog();
                }}
              >
                <span>新建文件</span>
              </button>
              <button
                className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
                onClick={() => {
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                  fileInputRef.current?.click();
                }}
              >
                <span>上传文件</span>
              </button>
              <div className="h-px my-1" style={{ backgroundColor: currentTheme.ui.border }} />
              <button
                className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 cursor-pointer"
                onClick={() => {
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                  loadDirectory(currentPath);
                }}
              >
                <span>刷新</span>
              </button>
            </>
          )}
        </div>
      )}

      {/* 弹窗遮罩与交互模态框 */}
      {activeDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div
            className="w-[360px] rounded-lg shadow-2xl border p-4 flex flex-col gap-3"
            style={{
              backgroundColor: currentTheme.ui.cardBg,
              borderColor: currentTheme.ui.border,
              color: currentTheme.ui.text,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold">
                {activeDialog === 'new_folder' && '新建文件夹'}
                {activeDialog === 'new_file' && '新建文件'}
                {activeDialog === 'rename' && '重命名'}
                {activeDialog === 'delete' && '确认删除'}
              </span>
              <button
                onClick={() => setActiveDialog(null)}
                className="p-1 rounded hover:opacity-100 opacity-60 transition-opacity cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {activeDialog === 'delete' ? (
              <div className="text-xs space-y-2 py-1">
                <p>
                  确定要删除此{dialogTarget?.is_dir ? '文件夹' : '文件'}吗？
                </p>
                <p
                  className="font-mono text-[11px] px-2 py-1 rounded break-all"
                  style={{ backgroundColor: currentTheme.ui.hoverBg, color: currentTheme.ui.textMuted }}
                >
                  {dialogTarget?.name}
                </p>
                {dialogTarget?.is_dir && (
                  <p className="text-[10px] text-amber-400">
                    注意：非空文件夹需要先清空内部文件。
                  </p>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px]" style={{ color: currentTheme.ui.textMuted }}>
                  {activeDialog === 'rename' ? '新名称' : '名称'}
                </label>
                <input
                  ref={dialogInputRef}
                  type="text"
                  value={dialogInput}
                  onChange={(e) => setDialogInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleDialogSubmit();
                    if (e.key === 'Escape') setActiveDialog(null);
                  }}
                  className="w-full px-2.5 py-1.5 rounded text-xs font-mono outline-none border"
                  style={{
                    backgroundColor: currentTheme.ui.sidebarBg,
                    borderColor: currentTheme.ui.border,
                    color: currentTheme.ui.text,
                  }}
                  placeholder="请输入名称"
                />
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => setActiveDialog(null)}
                className="px-3 py-1 rounded text-xs border cursor-pointer hover:opacity-80 transition-opacity"
                style={{
                  borderColor: currentTheme.ui.border,
                  backgroundColor: currentTheme.ui.hoverBg,
                  color: currentTheme.ui.text,
                }}
              >
                取消
              </button>
              <button
                onClick={handleDialogSubmit}
                className={`px-3 py-1 rounded text-xs font-semibold cursor-pointer transition-opacity ${
                  activeDialog === 'delete'
                    ? 'bg-red-500 hover:bg-red-600 text-white'
                    : 'text-black'
                }`}
                style={activeDialog !== 'delete' ? { backgroundColor: '#23d18b', color: '#000000' } : undefined}
              >
                {activeDialog === 'delete' ? '确认删除' : '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
