import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { BUILTIN_THEMES } from '../../types/theme';
import { terminalRuntimeManager } from '../../core/terminal/TerminalRuntimeManager';
import type { TerminalTab } from '../../types';
import { TerminalCanvas } from './TerminalCanvas';
import { TerminalSearchBar } from './TerminalSearchBar';
import { TerminalContextMenu, type ContextMenuState } from './TerminalContextMenu';
import { PasteConfirmModal } from './PasteConfirmModal';
import { DisconnectBanner } from './DisconnectBanner';

interface XTerminalProps {
  tab: TerminalTab;
  isActive?: boolean;
}

export const XTerminal: React.FC<XTerminalProps> = ({ tab, isActive = true }) => {
  const [hasConnectedOnce, setHasConnectedOnce] = useState(
    () => terminalRuntimeManager.getController(tab.sessionId)?.hasConnectedOnce() ?? false
  );
  const [inputErrorMsg, setInputErrorMsg] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [pendingPasteText, setPendingPasteText] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    selection: '',
  });

  const setTabConnected = useTerminalStore((state) => state.setTabConnected);
  const setTabLatency = useTerminalStore((state) => state.setTabLatency);
  const themeId = useSettingsStore((state) => state.themeId);
  const terminalFontSize = useSettingsStore((state) => state.terminalFontSize);
  const setTerminalFontSize = useSettingsStore((state) => state.setTerminalFontSize);
  const isSftpDrawerOpen = useSettingsStore((state) => state.isSftpDrawerOpen);
  const toggleSftpDrawer = useSettingsStore((state) => state.toggleSftpDrawer);
  const toggleAiPanel = useSettingsStore((state) => state.toggleAiPanel);
  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

  const getController = useCallback(
    () => terminalRuntimeManager.getController(tab.sessionId),
    [tab.sessionId]
  );

  const callbacks = useMemo(
    () => ({
      onOpenSearch: () => setSearchOpen(true),
      onMultiLinePaste: (text: string) => setPendingPasteText(text),
      onZoomFont: (delta: number) => {
        const cur = useSettingsStore.getState().terminalFontSize || 14;
        setTerminalFontSize(cur + delta);
      },
      onConnectedChange: (tabId: string, connected: boolean) => {
        if (connected) setInputErrorMsg(null);
        setTabConnected(tabId, connected);
      },
      onLatencyChange: (tabId: string, latencyMs: number | null) => {
        setTabLatency(tabId, latencyMs);
      },
      onConnectedOnce: () => setHasConnectedOnce(true),
      onInputError: (err: Error) => {
        setInputErrorMsg(err.message || '终端输入通道异常');
      },
    }),
    [setTabConnected, setTabLatency, setTerminalFontSize]
  );

  // 点击外部关闭右键菜单
  useEffect(() => {
    if (!contextMenu.visible) return;
    const close = () => setContextMenu((prev) => ({ ...prev, visible: false }));
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu.visible]);

  // 二级标签栏指令监听
  useEffect(() => {
    const matchTab = (e: Event) => {
      const detail = (e as CustomEvent<{ tabId?: string }>).detail;
      return !detail?.tabId || detail.tabId === tab.id;
    };

    const onClear = (e: Event) => {
      if (matchTab(e)) getController()?.clear();
    };
    const onCopyAll = (e: Event) => {
      if (matchTab(e)) getController()?.copyAll();
    };
    const onRetry = async (e: Event) => {
      if (matchTab(e)) {
        setInputErrorMsg(null);
        await getController()?.retry();
      }
    };
    const onOpenSearch = (e: Event) => {
      if (matchTab(e)) setSearchOpen(true);
    };

    window.addEventListener('terminal:clear', onClear);
    window.addEventListener('terminal:copy-all', onCopyAll);
    window.addEventListener('terminal:retry', onRetry);
    window.addEventListener('terminal:search', onOpenSearch);

    return () => {
      window.removeEventListener('terminal:clear', onClear);
      window.removeEventListener('terminal:copy-all', onCopyAll);
      window.removeEventListener('terminal:retry', onRetry);
      window.removeEventListener('terminal:search', onOpenSearch);
    };
  }, [tab.id, getController]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const selection = getController()?.getSelection() || '';
    setContextMenu({
      visible: true,
      x: Math.min(e.clientX, window.innerWidth - 200),
      y: Math.min(e.clientY, window.innerHeight - 220),
      selection,
    });
  };

  const handleReconnect = async () => {
    setInputErrorMsg(null);
    await getController()?.retry();
  };

  const handleAskAi = () => {
    const snippet = contextMenu.selection.trim() || getController()?.getRecentBufferText(30) || '';
    if (!snippet) return;
    toggleAiPanel(true);
    const prompt = `请分析以下终端输出并给出排查结论或修复建议：\n\`\`\`text\n${snippet.slice(0, 3000)}\n\`\`\``;
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('agent:ask-with-context', { detail: { prompt, autoSend: false } })
      );
    }, 60);
  };

  const showDisconnectBanner =
    (tab.isSsh && hasConnectedOnce && !tab.connected) || Boolean(inputErrorMsg);

  return (
    <div
      className="flex-1 w-full h-full overflow-hidden transition-colors duration-200 cursor-text relative"
      style={{ backgroundColor: currentTheme.ui.terminalBg }}
      onContextMenu={handleContextMenu}
    >
      <DisconnectBanner
        visible={showDisconnectBanner}
        message={inputErrorMsg || 'SSH 会话已断开'}
        theme={currentTheme}
        onReconnect={handleReconnect}
      />

      <TerminalSearchBar
        tabId={tab.id}
        open={searchOpen}
        theme={currentTheme}
        getController={getController}
        onClose={() => setSearchOpen(false)}
      />

      <TerminalContextMenu
        menu={contextMenu}
        isSsh={tab.isSsh}
        theme={currentTheme}
        onCopy={() => {
          if (contextMenu.selection) {
            navigator.clipboard.writeText(contextMenu.selection).catch(() => {});
            getController()?.clearSelection();
          }
          setContextMenu((p) => ({ ...p, visible: false }));
          getController()?.focus(true);
        }}
        onPaste={() => {
          setContextMenu((p) => ({ ...p, visible: false }));
          navigator.clipboard
            .readText()
            .then((t) => {
              if (t) getController()?.triggerSafePaste(t);
            })
            .catch(() => {});
          getController()?.focus(true);
        }}
        onAskAi={() => {
          setContextMenu((p) => ({ ...p, visible: false }));
          handleAskAi();
        }}
        onOpenSearch={() => {
          setContextMenu((p) => ({ ...p, visible: false }));
          setSearchOpen(true);
        }}
        onOpenSftp={() => {
          setContextMenu((p) => ({ ...p, visible: false }));
          toggleSftpDrawer(true);
        }}
        onClear={() => {
          setContextMenu((p) => ({ ...p, visible: false }));
          getController()?.clear();
          getController()?.focus(true);
        }}
        onReconnect={() => {
          setContextMenu((p) => ({ ...p, visible: false }));
          handleReconnect();
        }}
      />

      <PasteConfirmModal
        tabId={tab.id}
        text={pendingPasteText}
        theme={currentTheme}
        onCancel={() => {
          setPendingPasteText(null);
          getController()?.focus(true);
        }}
        onConfirm={(text) => {
          setPendingPasteText(null);
          getController()?.paste(text);
          getController()?.focus(true);
        }}
      />

      <TerminalCanvas
        tab={tab}
        isActive={isActive}
        themeId={themeId}
        fontSize={terminalFontSize || 14}
        isSftpDrawerOpen={isSftpDrawerOpen}
        callbacks={callbacks}
      />
    </div>
  );
};
