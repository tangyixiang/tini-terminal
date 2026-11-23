import { useState, useEffect, useRef, useMemo, type RefObject } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import { isMacPlatform, normalizeTauriDragPosition } from '../../lib/platform';
import { sendToTerminal } from '../../lib/terminal/ptyBridge';
import type {
  RemoteFileInfo,
  SessionContext,
  SftpListResult,
  TerminalTab,
  TransferItem,
} from '../../types';
import {
  formatBytes,
  type DialogType,
  type SftpContextMenuState,
  type SortField,
} from './sftpUtils';

interface TransferProgressPayload {
  transfer_id: string;
  file_name: string;
  transferred: number;
  total: number;
  done: boolean;
}

const UPLOAD_CHUNK_BYTES = 256 * 1024;
const MAX_INLINE_EDIT_BYTES = 2 * 1024 * 1024;

export function useSftpController(
  isOpen: boolean,
  activeTab: TerminalTab | undefined,
  drawerRef: RefObject<HTMLDivElement | null>
) {
  const [drawerWidth, setDrawerWidth] = useState(600);
  const [currentPath, setCurrentPath] = useState('');
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [files, setFiles] = useState<RemoteFileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [showHidden, setShowHidden] = useState(true);
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortAsc, setSortAsc] = useState(true);

  const [selectedFile, setSelectedFile] = useState<RemoteFileInfo | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const cancelledChunkIdsRef = useRef<Set<string>>(new Set());

  const [activeDialog, setActiveDialog] = useState<DialogType>(null);
  const [dialogInput, setDialogInput] = useState('');
  const [dialogTarget, setDialogTarget] = useState<RemoteFileInfo | null>(null);
  const [recursiveDelete, setRecursiveDelete] = useState(true);
  const [contextMenu, setContextMenu] = useState<SftpContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    item: null,
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogInputRef = useRef<HTMLInputElement>(null);

  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const tabPathMapRef = useRef<Record<string, string>>({});
  const lastSessionIdRef = useRef<string | null>(null);

  const isEditorDirty = selectedFile !== null && fileContent !== originalContent;
  const hasRunningTransfer = transfers.some((t) => t.status === 'running');

  const upsertTransfer = (item: TransferItem) => {
    setTransfers((prev) => {
      const idx = prev.findIndex((t) => t.id === item.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = item;
        return next;
      }
      return [item, ...prev].slice(0, 12);
    });
  };

  const patchTransfer = (id: string, patch: Partial<TransferItem>) => {
    setTransfers((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  const loadDirectory = async (dirPath = '') => {
    const tab = activeTabRef.current;
    if (!tab || !tab.isSsh) {
      setStatusMsg('请先激活并连接一个 SSH 远程终端');
      return;
    }

    setLoading(true);
    setStatusMsg('');
    try {
      if (!window.__TAURI_INTERNALS__) {
        setFiles([]);
        setStatusMsg('未检测到原生运行时环境，无法访问远程 SFTP 文件系统');
        return;
      }
      const res = await invoke<SftpListResult>('sftp_list_dir', {
        sessionId: tab.sessionId,
        remotePath: dirPath,
      });
      setFiles(res.files || []);
      setCurrentPath(res.current_dir);
      setPathInput(res.current_dir);
      tabPathMapRef.current[tab.sessionId] = res.current_dir;
    } catch (e: any) {
      setStatusMsg(`读取目录失败: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  };

  const syncWithTerminalCwd = async () => {
    const tab = activeTabRef.current;
    if (!tab || !tab.isSsh || !window.__TAURI_INTERNALS__) return;
    try {
      const ctx = await invoke<SessionContext | null>('get_session_context', {
        sessionId: tab.sessionId,
      });
      if (ctx?.cwd && ctx.cwd.startsWith('/')) {
        await loadDirectory(ctx.cwd);
        setStatusMsg(`已同步终端当前目录: ${ctx.cwd}`);
      } else {
        setStatusMsg('尚未捕捉到终端当前绝对目录，请先在终端执行任意命令或 cd');
      }
    } catch (e: any) {
      setStatusMsg(`同步终端目录失败: ${e?.message || e}`);
    }
  };

  useEffect(() => {
    if (!isOpen) return;

    if (activeTab && activeTab.isSsh) {
      if (lastSessionIdRef.current !== activeTab.sessionId) {
        lastSessionIdRef.current = activeTab.sessionId;
        setSelectedFile(null);
        setFileContent('');
        setOriginalContent('');
        setSaving(false);
        const cachedPath = tabPathMapRef.current[activeTab.sessionId] || '';
        loadDirectory(cachedPath);
      }
    } else {
      lastSessionIdRef.current = null;
      setFiles([]);
      setCurrentPath('');
      setPathInput('');
      setSelectedFile(null);
      setStatusMsg('请先激活并连接一个 SSH 远程终端');
    }
  }, [isOpen, activeTab?.sessionId, activeTab?.isSsh]);

  // 跨平台原生文件/文件夹拖拽上传
  useEffect(() => {
    if (!isOpen || !window.__TAURI_INTERNALS__) return;
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

          if (payload.type === 'enter' || payload.type === 'over') {
            const { x: px, y: py } = normalizeTauriDragPosition(payload.position);
            const inside =
              px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom;
            setIsDragging(inside);
          } else if (payload.type === 'leave') {
            setIsDragging(false);
          } else if (payload.type === 'drop') {
            setIsDragging(false);
            const { x: px, y: py } = normalizeTauriDragPosition(payload.position);
            const inside =
              px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom;
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
      if (unlistenFn) unlistenFn();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!contextMenu.visible) return;
    const close = () => setContextMenu((prev) => ({ ...prev, visible: false }));
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu.visible]);

  useEffect(() => {
    if (activeDialog && activeDialog !== 'delete') {
      setTimeout(() => dialogInputRef.current?.focus(), 50);
    }
  }, [activeDialog]);

  const handleSaveFile = async () => {
    if (!activeTab || !selectedFile || saving) return;
    setSaving(true);
    try {
      if (!window.__TAURI_INTERNALS__) {
        setStatusMsg('未检测到原生运行时环境，无法保存远程文件');
        return;
      }
      await invoke('sftp_write_file', {
        sessionId: activeTab.sessionId,
        remotePath: selectedFile.path,
        content: fileContent,
      });
      setOriginalContent(fileContent);
      setStatusMsg(`已保存: ${selectedFile.name}`);
    } catch (e: any) {
      setStatusMsg(`保存文件失败: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!isOpen || !selectedFile) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = isMacPlatform() ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSaveFile();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, selectedFile, fileContent]);

  const filteredAndSortedFiles = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    const list = files.filter((f) => {
      if (!showHidden && f.name.startsWith('.')) return false;
      if (q && !f.name.toLowerCase().includes(q)) return false;
      return true;
    });

    return [...list].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      let cmp = 0;
      if (sortField === 'name') {
        cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      } else if (sortField === 'size') {
        cmp = a.size - b.size;
      } else {
        cmp = a.mtime - b.mtime;
      }
      return sortAsc ? cmp : -cmp;
    });
  }, [files, filterText, showHidden, sortField, sortAsc]);

  const handleResizeDrawer = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = drawerWidth;
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: MouseEvent) => {
      const next = startWidth - (ev.clientX - startX);
      const maxW = Math.max(420, window.innerWidth - 200);
      setDrawerWidth(Math.max(380, Math.min(maxW, next)));
    };
    const onUp = () => {
      document.body.style.cursor = 'default';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const uploadLocalPaths = async (paths: string[]) => {
    const tab = activeTabRef.current;
    const pathTarget = currentPathRef.current || '/';
    if (!tab || !tab.isSsh) {
      setStatusMsg('请先激活并连接一个 SSH 远程终端');
      return;
    }
    if (paths.length === 0) return;

    let successCount = 0;
    for (let i = 0; i < paths.length; i++) {
      const localPath = paths[i];
      const fileName = localPath.split(/[/\\]/).filter(Boolean).pop() || `item_${i}`;
      const transferId = `up-${Date.now()}-${i}`;
      upsertTransfer({
        id: transferId,
        type: 'upload',
        fileName,
        transferred: 0,
        total: 0,
        status: 'running',
        startedAt: Date.now(),
      });

      const channel = new Channel<TransferProgressPayload>();
      channel.onmessage = (payload) => {
        patchTransfer(transferId, {
          transferred: payload.transferred,
          total: payload.total,
        });
      };

      try {
        await invoke<number>('sftp_upload_path', {
          sessionId: tab.sessionId,
          localPath,
          remoteDir: pathTarget,
          transferId,
          channel,
        });
        patchTransfer(transferId, { status: 'done' });
        successCount++;
      } catch (e: any) {
        const msg = String(e?.message || e);
        patchTransfer(transferId, {
          status: msg.includes('取消') ? 'cancelled' : 'failed',
          error: msg,
        });
        setStatusMsg(`上传失败 (${fileName}): ${msg}`);
      }
    }

    if (successCount > 0) {
      setStatusMsg(`已完成 ${successCount} 项上传至 ${pathTarget}`);
      await loadDirectory(pathTarget);
    }
  };

  const uploadFilesChunked = async (fileList: FileList | File[]) => {
    const tab = activeTabRef.current;
    const pathTarget = currentPathRef.current || '/';
    if (!tab || !tab.isSsh) {
      setStatusMsg('请先激活并连接一个 SSH 远程终端');
      return;
    }
    const filesArray = Array.from(fileList);
    if (filesArray.length === 0) return;

    const remoteClean = pathTarget.trim().replace(/\/+$/, '');
    let successCount = 0;

    for (let i = 0; i < filesArray.length; i++) {
      const file = filesArray[i];
      const transferId = `up-chunk-${Date.now()}-${i}`;
      upsertTransfer({
        id: transferId,
        type: 'upload',
        fileName: file.name,
        transferred: 0,
        total: file.size,
        status: 'running',
        startedAt: Date.now(),
      });

      try {
        const remotePath = `${remoteClean}/${file.name}`;
        if (file.size === 0) {
          await invoke('sftp_upload_chunk', {
            sessionId: tab.sessionId,
            remotePath,
            offset: 0,
            data: [],
          });
        } else {
          let offset = 0;
          while (offset < file.size) {
            if (cancelledChunkIdsRef.current.has(transferId)) {
              cancelledChunkIdsRef.current.delete(transferId);
              throw new Error('上传已取消');
            }
            const end = Math.min(file.size, offset + UPLOAD_CHUNK_BYTES);
            const sliceBuf = await file.slice(offset, end).arrayBuffer();
            const chunkBytes = Array.from(new Uint8Array(sliceBuf));
            await invoke('sftp_upload_chunk', {
              sessionId: tab.sessionId,
              remotePath,
              offset,
              data: chunkBytes,
            });
            offset = end;
            patchTransfer(transferId, { transferred: offset, total: file.size });
          }
        }
        patchTransfer(transferId, { status: 'done', transferred: file.size, total: file.size });
        successCount++;
      } catch (e: any) {
        const msg = String(e?.message || e);
        patchTransfer(transferId, {
          status: msg.includes('取消') ? 'cancelled' : 'failed',
          error: msg,
        });
        setStatusMsg(`上传失败 (${file.name}): ${msg}`);
      }
    }

    if (successCount > 0) {
      setStatusMsg(`已成功上传 ${successCount} 个文件至 ${pathTarget}`);
      await loadDirectory(pathTarget);
    }
  };

  const handleCancelTransfer = (item: TransferItem) => {
    if (item.id.startsWith('up-chunk-')) {
      cancelledChunkIdsRef.current.add(item.id);
    } else if (window.__TAURI_INTERNALS__) {
      invoke('sftp_cancel_transfer', { transferId: item.id }).catch(() => {});
    }
    patchTransfer(item.id, { status: 'cancelled' });
  };

  const handleOpenFile = async (file: RemoteFileInfo) => {
    if (!activeTab) return;
    if (file.size > MAX_INLINE_EDIT_BYTES) {
      setStatusMsg(
        `文件 ${file.name} 体积为 ${formatBytes(file.size)}（超过 2MB 在线编辑上限），请直接下载查看`
      );
      return;
    }

    setLoading(true);
    setStatusMsg('');
    try {
      if (window.__TAURI_INTERNALS__) {
        const content = await invoke<string>('sftp_read_file', {
          sessionId: activeTab.sessionId,
          remotePath: file.path,
        });
        setSelectedFile(file);
        setFileContent(content);
        setOriginalContent(content);
      } else {
        setStatusMsg('未检测到桌面端运行时，无法预览远程文件内容');
      }
    } catch (e: any) {
      setStatusMsg(`打开文件失败: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCloseEditor = () => {
    if (isEditorDirty && !window.confirm('当前文件有未保存的修改，确定放弃修改并关闭吗？')) {
      return;
    }
    setSelectedFile(null);
    setFileContent('');
    setOriginalContent('');
  };

  const handleDownloadFile = async (file: RemoteFileInfo) => {
    if (!activeTab || file.is_dir) return;
    const transferId = `dl-${Date.now()}`;
    upsertTransfer({
      id: transferId,
      type: 'download',
      fileName: file.name,
      transferred: 0,
      total: file.size,
      status: 'running',
      startedAt: Date.now(),
    });

    const channel = new Channel<TransferProgressPayload>();
    channel.onmessage = (payload) => {
      patchTransfer(transferId, {
        transferred: payload.transferred,
        total: payload.total,
      });
    };

    try {
      const localPath = await invoke<string>('sftp_download_file_progress', {
        sessionId: activeTab.sessionId,
        remotePath: file.path,
        transferId,
        channel,
      });
      patchTransfer(transferId, { status: 'done', transferred: file.size, total: file.size });
      setStatusMsg(`已下载至: ${localPath}`);
    } catch (e: any) {
      const msg = String(e?.message || e);
      patchTransfer(transferId, {
        status: msg.includes('取消') ? 'cancelled' : 'failed',
        error: msg,
      });
      setStatusMsg(`下载失败: ${msg}`);
    }
  };

  const handleGoUp = () => {
    if (currentPath === '/' || !currentPath.includes('/')) return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    loadDirectory('/' + parts.join('/'));
  };

  const handleBreadcrumbClick = (index: number, segments: string[]) => {
    if (index === -1) {
      loadDirectory('/');
      return;
    }
    loadDirectory('/' + segments.slice(0, index + 1).join('/'));
  };

  const handleDialogSubmit = async () => {
    if (!activeTab) return;
    const tab = activeTab;
    const remoteClean = currentPath.trim().replace(/\/+$/, '');

    try {
      if (activeDialog === 'new_folder') {
        const name = dialogInput.trim();
        if (!name || name.includes('/')) return;
        await invoke('sftp_mkdir', { sessionId: tab.sessionId, remotePath: `${remoteClean}/${name}` });
        setStatusMsg(`已创建文件夹: ${name}`);
        await loadDirectory(currentPath);
      } else if (activeDialog === 'new_file') {
        const name = dialogInput.trim();
        if (!name || name.includes('/')) return;
        await invoke('sftp_create_file', {
          sessionId: tab.sessionId,
          remotePath: `${remoteClean}/${name}`,
        });
        setStatusMsg(`已创建文件: ${name}`);
        await loadDirectory(currentPath);
      } else if (activeDialog === 'rename' && dialogTarget) {
        const newName = dialogInput.trim();
        if (!newName || newName === dialogTarget.name || newName.includes('/')) {
          setActiveDialog(null);
          return;
        }
        const parentDir = dialogTarget.path.substring(0, dialogTarget.path.lastIndexOf('/')) || '/';
        const cleanParent = parentDir.replace(/\/+$/, '');
        await invoke('sftp_rename', {
          sessionId: tab.sessionId,
          oldPath: dialogTarget.path,
          newPath: `${cleanParent}/${newName}`,
        });
        setStatusMsg(`已重命名为: ${newName}`);
        await loadDirectory(currentPath);
      } else if (activeDialog === 'chmod' && dialogTarget) {
        const cleaned = dialogInput.trim();
        if (!/^[0-7]{3,4}$/.test(cleaned)) {
          setStatusMsg('权限格式无效，请输入 3~4 位八进制权限（如 755 或 644）');
          return;
        }
        const mode = parseInt(cleaned, 8);
        await invoke('sftp_chmod', {
          sessionId: tab.sessionId,
          remotePath: dialogTarget.path,
          mode,
        });
        setStatusMsg(`已将 ${dialogTarget.name} 权限修改为 ${cleaned}`);
        await loadDirectory(currentPath);
      } else if (activeDialog === 'delete' && dialogTarget) {
        await invoke('sftp_remove', {
          sessionId: tab.sessionId,
          remotePath: dialogTarget.path,
          isDir: dialogTarget.is_dir,
          recursive: dialogTarget.is_dir ? recursiveDelete : false,
        });
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

  const openChmodDialog = (item: RemoteFileInfo) => {
    setDialogTarget(item);
    const octal = ((item.permissions || 0o644) & 0o777).toString(8).padStart(3, '0');
    setDialogInput(octal);
    setActiveDialog('chmod');
  };

  const openRenameDialog = (item: RemoteFileInfo) => {
    setDialogTarget(item);
    setDialogInput(item.name);
    setActiveDialog('rename');
  };

  const openDeleteDialog = (item: RemoteFileInfo) => {
    setDialogTarget(item);
    setRecursiveDelete(true);
    setActiveDialog('delete');
  };

  const handleCdInTerminal = (dirPath: string) => {
    if (!activeTab) return;
    const escaped = `'${dirPath.replace(/'/g, `'\\''`)}'`;
    sendToTerminal(activeTab.sessionId, `cd ${escaped}\n`);
    setStatusMsg(`已向终端发送: cd ${dirPath}`);
  };

  const handleContextMenu = (e: React.MouseEvent, item: RemoteFileInfo | null) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      visible: true,
      x: Math.min(e.clientX, window.innerWidth - 190),
      y: Math.min(e.clientY, window.innerHeight - 250),
      item,
    });
  };

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  return {
    drawerWidth,
    handleResizeDrawer,
    currentPath,
    isEditingPath,
    setIsEditingPath,
    pathInput,
    setPathInput,
    loading,
    filterText,
    setFilterText,
    showHidden,
    setShowHidden,
    sortField,
    sortAsc,
    toggleSort,
    filteredAndSortedFiles,
    selectedFile,
    fileContent,
    setFileContent,
    isEditorDirty,
    saving,
    statusMsg,
    setStatusMsg,
    isDragging,
    setIsDragging,
    transfers,
    setTransfers,
    hasRunningTransfer,
    activeDialog,
    setActiveDialog,
    dialogInput,
    setDialogInput,
    dialogTarget,
    recursiveDelete,
    setRecursiveDelete,
    contextMenu,
    setContextMenu,
    fileInputRef,
    dialogInputRef,
    loadDirectory,
    syncWithTerminalCwd,
    uploadFilesChunked,
    handleCancelTransfer,
    handleOpenFile,
    handleCloseEditor,
    handleSaveFile,
    handleDownloadFile,
    handleGoUp,
    handleBreadcrumbClick,
    handleDialogSubmit,
    openChmodDialog,
    openRenameDialog,
    openDeleteDialog,
    handleCdInTerminal,
    handleContextMenu,
  };
}
