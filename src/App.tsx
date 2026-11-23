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
import { WorkspaceAgentView } from './components/workspace/WorkspaceAgentView';
import { useServerStore } from './stores/useServerStore';
import { useSettingsStore } from './stores/useSettingsStore';
import { useTerminalStore } from './stores/useTerminalStore';
import { invoke } from '@tauri-apps/api/core';
import { BUILTIN_THEMES, getPrimaryButtonStyle } from './types/theme';
import { clampAiPanelWidth, clampSidebarWidth } from './lib/layout';
import { useViewportWidth } from './lib/useViewportWidth';
import { focusManager } from './core/focus/FocusManager';
import { Terminal, Plus } from 'lucide-react';

export const App: React.FC = () => {
  const hasInitializedRef = useRef(false);
  const { fetchServers } = useServerStore();
  const {
    fetchSettings,
    primaryMode,
    isAiPanelOpen,
    isServerSidebarOpen,
    isServerModalOpen,
    isSettingsModalOpen,
    isSftpDrawerOpen,
    sidebarWidth,
    setSidebarWidth,
    aiPanelWidth,
    setAiPanelWidth,
    toggleServerModal,
    themeId,
    toggleAiPanelWide,
    syncLayoutToViewport,
  } = useSettingsStore();
  const { tabs, activeTabId, openLocalTab } = useTerminalStore();

  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

  // 视口宽度变化时按当前可用空间收敛面板宽度（仅影响渲染，不覆盖用户偏好）
  const viewportWidth = useViewportWidth();
  const effectiveSidebarWidth = clampSidebarWidth(sidebarWidth, viewportWidth);
  const effectiveAiPanelWidth = clampAiPanelWidth(aiPanelWidth, viewportWidth, effectiveSidebarWidth);

  useEffect(() => {
    if (hasInitializedRef.current) return;
    hasInitializedRef.current = true;

    fetchServers();
    fetchSettings().then(() => {
      // 清理历史遗留的超区间宽度值（渲染时仍会按当前视口二次收敛）
      syncLayoutToViewport();
    });
  }, []);

  // 动态同步原生系统窗口主题（暗色/浅色模式）
  useEffect(() => {
    if (window.__TAURI_INTERNALS__) {
      invoke('set_window_theme', { isDark: currentTheme.isDark }).catch(() => {});
    }
  }, [themeId, currentTheme.isDark]);

  // 统一由 FocusManager 仲裁模态弹窗、SFTP 抽屉与工作区视图的焦点域，关闭后自动归还终端焦点
  useEffect(() => {
    if (isServerModalOpen) focusManager.pushScope('server-modal', 'modal');
    else focusManager.popScope('server-modal');
  }, [isServerModalOpen]);

  useEffect(() => {
    if (isSettingsModalOpen) focusManager.pushScope('settings-modal', 'modal');
    else focusManager.popScope('settings-modal');
  }, [isSettingsModalOpen]);

  useEffect(() => {
    if (isSftpDrawerOpen) focusManager.pushScope('sftp-drawer', 'sftp');
    else focusManager.popScope('sftp-drawer');
  }, [isSftpDrawerOpen]);

  useEffect(() => {
    if (primaryMode === 'workspace') focusManager.pushScope('workspace-mode', 'ai');
    else focusManager.popScope('workspace-mode');
  }, [primaryMode]);

  const [isResizingLeft, setIsResizingLeft] = useState(false);
  const [isResizingRight, setIsResizingRight] = useState(false);

  // 左侧主机栏拖拽调整宽度
  const handleLeftResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = effectiveSidebarWidth;
    setIsResizingLeft(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent: MouseEvent) => {
      const target = startWidth + (moveEvent.clientX - startX);
      setSidebarWidth(clampSidebarWidth(target, window.innerWidth));
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
    const startWidth = effectiveAiPanelWidth;
    setIsResizingRight(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent: MouseEvent) => {
      const target = startWidth - (moveEvent.clientX - startX);
      setAiPanelWidth(clampAiPanelWidth(target, window.innerWidth, window.innerWidth > 0 ? clampSidebarWidth(sidebarWidth, window.innerWidth) : 0));
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
    toggleAiPanelWide();
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

      {/* 主工作区 */}
      <main className="flex-1 flex overflow-hidden relative">
        {/* 左侧：主机与工作区统一管理器 */}
        {isServerSidebarOpen && <ServerSidebar />}

        {/* 左侧拖拽调整宽度手柄 */}
        {isServerSidebarOpen && (
          <div
            className={`resize-handle-x ${isResizingLeft ? 'resizing' : ''}`}
            onMouseDown={handleLeftResize}
            title="按住左右拖拽调整主机列表宽度"
          />
        )}

        {/* 主画布视区：Workspace 模式与 Terminal 工作区通过 CSS 切换可见性，避免卸载活跃终端实例 */}
        {primaryMode === 'workspace' && <WorkspaceAgentView />}

        <div className={`flex-1 flex overflow-hidden min-w-0 ${primaryMode === 'workspace' ? 'hidden' : ''}`}>
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
                    style={getPrimaryButtonStyle(currentTheme)}
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
                      className={`absolute inset-0 ${
                        tab.id === activeTabId
                          ? 'visible z-10'
                          : 'invisible pointer-events-none z-0'
                      }`}
                    >
                      <XTerminal
                        tab={tab}
                        isActive={primaryMode !== 'workspace' && tab.id === activeTabId}
                      />
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
        </div>

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
