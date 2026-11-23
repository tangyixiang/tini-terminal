import React, { useState, useRef, useEffect } from 'react';
import {
  Server,
  FolderKanban,
  Sparkles,
  Settings,
  Palette,
  PanelLeftClose,
  PanelLeft,
  Minus,
  Square,
  Copy,
  X,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { BUILTIN_THEMES, getPrimaryButtonStyle, type ThemeId } from '../../types/theme';
import { isMacPlatform } from '../../lib/platform';

export const TitleBar: React.FC = () => {
  const { tabs, activeTabId } = useTerminalStore();
  const {
    toggleServerModal,
    toggleSettingsModal,
    toggleSftpDrawer,
    toggleAiPanel,
    isAiPanelOpen,
    isServerSidebarOpen,
    toggleServerSidebar,
    terminalFontSize,
    setTerminalFontSize,
    themeId,
    setThemeId,
  } = useSettingsStore();

  const [isThemeMenuOpen, setIsThemeMenuOpen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;
  const headerRef = useRef<HTMLElement>(null);
  const themeMenuRef = useRef<HTMLDivElement>(null);
  const isMac = isMacPlatform();

  // Windows / Linux 方案 A：同步窗口最大化状态以切换最大化/还原图标
  useEffect(() => {
    if (isMac || !window.__TAURI_INTERNALS__) return;
    const syncMax = async () => {
      try {
        const maximized = await invoke<boolean>('is_window_maximized');
        setIsMaximized(maximized);
      } catch {
        try {
          const maximized = await getCurrentWindow().isMaximized();
          setIsMaximized(maximized);
        } catch {}
      }
    };
    syncMax();
    window.addEventListener('resize', syncMax);
    return () => window.removeEventListener('resize', syncMax);
  }, [isMac]);

  useEffect(() => {
    if (!isThemeMenuOpen) return;
    const handleOutsideClick = (e: PointerEvent) => {
      if (themeMenuRef.current && !themeMenuRef.current.contains(e.target as Node)) {
        setIsThemeMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', handleOutsideClick);
    return () => {
      document.removeEventListener('pointerdown', handleOutsideClick);
    };
  }, [isThemeMenuOpen]);

  const handleMinimize = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch {
      invoke('minimize_window').catch(() => {});
    }
  };

  const handleToggleMaximize = async () => {
    try {
      await getCurrentWindow().toggleMaximize();
      const max = await getCurrentWindow().isMaximized();
      setIsMaximized(max);
    } catch {
      try {
        await invoke('toggle_maximize_window');
        const max = await invoke<boolean>('is_window_maximized');
        setIsMaximized(max);
      } catch {}
    }
  };

  const handleClose = async () => {
    try {
      await getCurrentWindow().close();
    } catch {
      invoke('close_window').catch(() => {});
    }
  };

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;

    const handleMouseDown = async (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;

      if (
        target.closest(
          'button, a, input, select, textarea, [data-tauri-drag-region="false"], [data-tauri-no-drag]'
        )
      ) {
        return;
      }

      if (e.detail === 2) {
        await handleToggleMaximize();
        return;
      }

      try {
        await getCurrentWindow().startDragging();
      } catch {
        invoke('drag_window').catch(() => {});
      }
    };

    el.addEventListener('mousedown', handleMouseDown);
    return () => {
      el.removeEventListener('mousedown', handleMouseDown);
    };
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <header
      ref={headerRef}
      data-tauri-drag-region="deep"
      className={`h-10 border-b flex items-center justify-between ${
        isMac ? 'pl-[76px] pr-3' : 'pl-3 pr-0'
      } shrink-0 select-none cursor-default relative transition-colors duration-200`}
      style={{
        backgroundColor: currentTheme.ui.headerBg,
        borderColor: currentTheme.ui.border,
        color: currentTheme.ui.text,
      }}
    >
      {/* 左侧：应用标识与主机栏折叠按钮 */}
      <div
        data-tauri-drag-region="deep"
        className="flex items-center gap-2 mr-3 shrink-0 py-1"
      >
        <button
          data-tauri-no-drag
          data-tauri-drag-region="false"
          onClick={() => toggleServerSidebar()}
          className="p-1 rounded cursor-pointer mr-0.5 hover:opacity-100 opacity-70 transition-opacity"
          style={{ color: currentTheme.ui.text }}
          title={isServerSidebarOpen ? '收起主机列表' : '展开主机列表'}
        >
          {isServerSidebarOpen ? (
            <PanelLeftClose className="w-4 h-4" />
          ) : (
            <PanelLeft className="w-4 h-4" />
          )}
        </button>

        <img
          src="/tini-terminal-icon.svg"
          alt="Tini Terminal"
          className="w-4 h-4 rounded shrink-0 pointer-events-none"
        />
        <span
          data-tauri-drag-region="deep"
          className="text-xs font-semibold tracking-wider font-mono"
          style={{ color: currentTheme.ui.text }}
        >
          TINI TERMINAL
        </span>
      </div>

      {/* 中间：原生拖拽区与当前会话居中胶囊 */}
      <div
        data-tauri-drag-region="deep"
        className="flex-1 flex items-center justify-center h-full px-4 min-w-0"
      >
        {activeTab && (
          <div
            data-tauri-drag-region="deep"
            className="flex items-center gap-2 px-3 py-1 rounded-full text-xs font-terminal transition-colors max-w-full"
            style={{
              backgroundColor: currentTheme.ui.hoverBg,
              color: currentTheme.ui.text,
            }}
          >
            <span
              data-tauri-drag-region="deep"
              className={`w-2 h-2 rounded-full shrink-0 ${
                activeTab.connected ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'
              }`}
            />
            <span
              data-tauri-drag-region="deep"
              className="font-medium max-w-[320px] truncate"
            >
              {activeTab.isSsh && activeTab.server
                ? `${activeTab.server.username}@${activeTab.server.name} (${activeTab.server.host})`
                : activeTab.title}
            </span>
          </div>
        )}
      </div>

      {/* 右侧：全局动作按钮 + Windows/Linux 原生窗口控制按钮 */}
      <div
        data-tauri-no-drag
        data-tauri-drag-region="false"
        className="flex items-center gap-2 shrink-0 ml-2 h-full"
      >
        <div
          className="flex items-center rounded border px-1.5 py-0.5 text-xs mr-0.5"
          style={{
            backgroundColor: currentTheme.ui.cardBg,
            borderColor: currentTheme.ui.border,
          }}
        >
          <button
            onClick={() => setTerminalFontSize(terminalFontSize - 1)}
            className="px-1 cursor-pointer hover:opacity-100 opacity-70 font-semibold text-[11px]"
            style={{ color: currentTheme.ui.text }}
            title="缩小字号"
          >
            A-
          </button>
          <span
            className="px-1 text-[11px] font-mono font-medium"
            style={{ color: currentTheme.ui.accent }}
          >
            {terminalFontSize}px
          </span>
          <button
            onClick={() => setTerminalFontSize(terminalFontSize + 1)}
            className="px-1 cursor-pointer hover:opacity-100 opacity-70 font-semibold text-[11px]"
            style={{ color: currentTheme.ui.text }}
            title="放大字号"
          >
            A+
          </button>
        </div>

        <div className="relative" ref={themeMenuRef}>
          <button
            onClick={() => setIsThemeMenuOpen(!isThemeMenuOpen)}
            className="p-1.5 rounded cursor-pointer transition-colors flex items-center gap-1 text-xs"
            style={{
              backgroundColor: currentTheme.ui.hoverBg,
              color: currentTheme.ui.text,
            }}
            title="切换内置主题"
          >
            <Palette className="w-4 h-4" />
          </button>

          {isThemeMenuOpen && (
            <div
              className="absolute right-0 top-9 w-44 rounded-lg border shadow-xl z-50 py-1 text-xs select-none"
              style={{
                backgroundColor: currentTheme.ui.cardBg,
                borderColor: currentTheme.ui.border,
                color: currentTheme.ui.text,
              }}
            >
              <div
                className="px-3 py-1.5 text-[10px] font-semibold border-b"
                style={{
                  borderColor: currentTheme.ui.border,
                  color: currentTheme.ui.textMuted,
                }}
              >
                内置主题与配色
              </div>
              {(Object.keys(BUILTIN_THEMES) as ThemeId[]).map((id) => {
                const t = BUILTIN_THEMES[id];
                const active = themeId === id;
                return (
                  <button
                    key={id}
                    onClick={() => {
                      setThemeId(id);
                      setIsThemeMenuOpen(false);
                    }}
                    className="w-full text-left px-3 py-1.5 flex items-center justify-between cursor-pointer transition-colors"
                    style={{
                      backgroundColor: active ? currentTheme.ui.hoverBg : 'transparent',
                      color: active ? currentTheme.ui.accent : currentTheme.ui.text,
                    }}
                  >
                    <span>{t.name}</span>
                    {active && (
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ backgroundColor: currentTheme.ui.accent }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button
          onClick={() => toggleServerModal(true)}
          className="px-2.5 py-1 text-xs rounded flex items-center gap-1.5 cursor-pointer font-medium"
          style={{
            backgroundColor: currentTheme.ui.hoverBg,
            color: currentTheme.ui.text,
          }}
        >
          <Server className="w-3.5 h-3.5" style={{ color: currentTheme.ui.textMuted }} />
          添加主机
        </button>

        <button
          onClick={() => toggleSftpDrawer()}
          className="p-1.5 rounded cursor-pointer"
          style={{
            backgroundColor: currentTheme.ui.hoverBg,
            color: currentTheme.ui.text,
          }}
          title="SFTP 文件管理器"
        >
          <FolderKanban className="w-4 h-4" />
        </button>

        <button
          onClick={() => toggleAiPanel()}
          className="px-2.5 py-1 text-xs rounded flex items-center gap-1.5 font-semibold cursor-pointer transition-colors"
          style={{
            ...(isAiPanelOpen
              ? getPrimaryButtonStyle(currentTheme)
              : {
                  backgroundColor: currentTheme.ui.hoverBg,
                  color: currentTheme.ui.text,
                }),
          }}
        >
          <Sparkles className="w-3.5 h-3.5" />
          AI 智能体
        </button>

        <button
          onClick={() => toggleSettingsModal(true)}
          className="p-1.5 rounded cursor-pointer"
          style={{
            backgroundColor: currentTheme.ui.hoverBg,
            color: currentTheme.ui.text,
          }}
          title="系统与 AI 配置"
        >
          <Settings className="w-4 h-4" />
        </button>

        {/* Windows / Linux 方案 A 自绘窗口控制按钮 */}
        {!isMac && (
          <div
            className="flex items-center h-full ml-1 border-l"
            style={{ borderColor: currentTheme.ui.border }}
          >
            <button
              type="button"
              onClick={handleMinimize}
              className="h-full px-3 flex items-center justify-center cursor-pointer hover:bg-white/10 transition-colors"
              style={{ color: currentTheme.ui.text }}
              title="最小化"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleToggleMaximize}
              className="h-full px-3 flex items-center justify-center cursor-pointer hover:bg-white/10 transition-colors"
              style={{ color: currentTheme.ui.text }}
              title={isMaximized ? '向下还原' : '最大化'}
            >
              {isMaximized ? <Copy className="w-3 h-3" /> : <Square className="w-3 h-3" />}
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="h-full px-3 flex items-center justify-center cursor-pointer hover:bg-red-600 hover:text-white transition-colors"
              style={{ color: currentTheme.ui.text }}
              title="关闭"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </header>
  );
};
