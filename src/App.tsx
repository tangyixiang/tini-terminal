import React, { useEffect, useRef, useState } from 'react';
import { TitleBar } from './components/layout/TitleBar';
import { ServerSidebar } from './components/servers/ServerSidebar';
import { XTerminal } from './components/terminal/XTerminal';
import { SecondaryTabBar } from './components/terminal/SecondaryTabBar';
import { AgentPanel } from './components/agent/AgentPanel';
import { StatusBar } from './components/layout/StatusBar';
import { ServerModal } from './components/modals/ServerModal';
import { SettingsModal } from './components/modals/SettingsModal';
import { FileManagerDrawer } from './components/sftp/FileManagerDrawer';
import { useServerStore } from './stores/useServerStore';
import { useSettingsStore } from './stores/useSettingsStore';
import { useTerminalStore } from './stores/useTerminalStore';
import { invoke } from '@tauri-apps/api/core';
import { BUILTIN_THEMES, PRIMARY_BUTTON_STYLE } from './types/theme';
import { Terminal, Plus } from 'lucide-react';

export const App: React.FC = () => {
  const hasInitializedRef = useRef(false);
  const { fetchServers } = useServerStore();
  const {
    fetchSettings,
    isAiPanelOpen,
    isServerSidebarOpen,
    sidebarWidth,
    setSidebarWidth,
    aiPanelWidth,
    setAiPanelWidth,
    toggleServerModal,
    themeId,
  } = useSettingsStore();
  const { tabs, activeTabId, openLocalTab } = useTerminalStore();

  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

  useEffect(() => {
    if (hasInitializedRef.current) return;
    hasInitializedRef.current = true;

    fetchServers();
    fetchSettings();
  }, []);

  // 动态同步原生系统窗口主题（暗色/浅色模式）
  useEffect(() => {
    if (window.__TAURI_INTERNALS__) {
      invoke('set_window_theme', { isDark: currentTheme.isDark }).catch(() => {});
    }
  }, [themeId, currentTheme.isDark]);

  const [isResizingLeft, setIsResizingLeft] = useState(false);
  const [isResizingRight, setIsResizingRight] = useState(false);

  // 左侧主机栏拖拽调整宽度
  const handleLeftResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    setIsResizingLeft(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent: MouseEvent) => {
      const maxWidth = Math.max(360, Math.min(600, window.innerWidth - 400));
      const newWidth = Math.max(160, Math.min(maxWidth, startWidth + (moveEvent.clientX - startX)));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      setIsResizingLeft(false);
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // 右侧 AI 运维面板自由左右拖拽调整宽度
  const handleRightResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = aiPanelWidth;
    setIsResizingRight(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent: MouseEvent) => {
      // 允许自由拖拽宽度，仅保留左侧最小终端与面板工作区
      const maxWidth = Math.max(640, window.innerWidth - 300);
      const newWidth = Math.max(260, Math.min(maxWidth, startWidth - (moveEvent.clientX - startX)));
      setAiPanelWidth(newWidth);
    };

    const onMouseUp = () => {
      setIsResizingRight(false);
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // 双击手柄在紧凑宽度与宽屏模式间快速切换
  const handleRightDoubleClick = () => {
    if (aiPanelWidth > 500) {
      setAiPanelWidth(360);
    } else {
      const wideWidth = Math.min(Math.round(window.innerWidth * 0.48), window.innerWidth - 320);
      setAiPanelWidth(Math.max(600, wideWidth));
    }
  };

  return (
    <div
      className="flex flex-col h-screen w-screen antialiased overflow-hidden select-none transition-colors duration-200"
      style={{
        backgroundColor: currentTheme.ui.appBg,
        color: currentTheme.ui.text,
      }}
    >
      {/* 顶部标题栏与标签栏 */}
      <TitleBar />

      {/* 主工作区（三栏伸缩与拖拽布局） */}
      <main className="flex-1 flex overflow-hidden relative">
        {/* 左侧：主机管理器 */}
        {isServerSidebarOpen && <ServerSidebar />}

        {/* 左侧拖拽调整宽度手柄 */}
        {isServerSidebarOpen && (
          <div
            className={`resize-handle-x ${isResizingLeft ? 'resizing' : ''}`}
            onMouseDown={handleLeftResize}
            title="按住左右拖拽调整主机列表宽度"
          />
        )}

        {/* 中间：终端工作区 */}
        <section
          className="flex-1 flex flex-col overflow-hidden relative transition-colors duration-200"
          style={{ backgroundColor: currentTheme.ui.terminalBg }}
        >
          {tabs.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center space-y-4">
              <Terminal
                className="w-12 h-12"
                style={{ color: currentTheme.ui.textMuted }}
              />
              <div className="text-center">
                <p
                  className="text-sm font-medium"
                  style={{ color: currentTheme.ui.text }}
                >
                  暂无打开的终端标签
                </p>
                <p
                  className="text-xs mt-1"
                  style={{ color: currentTheme.ui.textMuted }}
                >
                  选择左侧主机连接，或快速启动本地终端
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => openLocalTab()}
                  className="px-3 py-1.5 rounded text-xs flex items-center gap-1.5 cursor-pointer font-medium transition-colors"
                  style={{
                    backgroundColor: currentTheme.ui.hoverBg,
                    color: currentTheme.ui.text,
                  }}
                >
                  <Plus className="w-3.5 h-3.5" />
                  新建本地终端
                </button>
                <button
                  onClick={() => toggleServerModal(true)}
                  className="px-3 py-1.5 rounded text-xs cursor-pointer font-semibold transition-opacity hover:opacity-90"
                  style={PRIMARY_BUTTON_STYLE}
                >
                  添加远程主机
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col h-full overflow-hidden">
              {/* 二级紧凑标签工作条 */}
              <SecondaryTabBar />

              {/* 终端会话视图容器 */}
              <div className="flex-1 relative overflow-hidden">
                {tabs.map((tab) => (
                  <div
                    key={tab.id}
                    className={`w-full h-full ${
                      tab.id === activeTabId
                        ? 'relative z-10'
                        : 'absolute inset-0 invisible pointer-events-none -z-10'
                    }`}
                  >
                    <XTerminal tab={tab} isActive={tab.id === activeTabId} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* 右侧拖拽调整宽度手柄 */}
        {isAiPanelOpen && (
          <div
            className={`resize-handle-x ${isResizingRight ? 'resizing' : ''}`}
            onMouseDown={handleRightResize}
            onDoubleClick={handleRightDoubleClick}
            title="按住左右拖拽调整宽度，双击快速切换宽屏/紧凑模式"
          />
        )}

        {/* 右侧：AI 智能体工作面板 */}
        {isAiPanelOpen && <AgentPanel />}

        {/* 全局拖拽事件捕获遮罩层，杜绝终端捕获或文字选中干扰 */}
        {(isResizingLeft || isResizingRight) && (
          <div className="fixed inset-0 z-50 cursor-col-resize select-none pointer-events-auto" />
        )}
      </main>

      {/* 底部状态栏 */}
      <StatusBar />

      {/* 模态弹窗与侧抽屉 */}
      <ServerModal />
      <SettingsModal />
      <FileManagerDrawer />
    </div>
  );
};

export default App;
