import React, { useEffect, useRef } from 'react';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { BUILTIN_THEMES } from '../../types/theme';
import type { TerminalTab } from '../../types';
import { TerminalView } from './TerminalView';
import { TerminalSession } from './TerminalSession';
import { TerminalInput } from './TerminalInput';
import { TerminalResize } from './TerminalResize';
import { TerminalFocus } from './TerminalFocus';

interface XTerminalProps {
  tab: TerminalTab;
  isActive?: boolean;
}

export const XTerminal: React.FC<XTerminalProps> = ({ tab, isActive = true }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<TerminalView | null>(null);
  const sessionRef = useRef<TerminalSession | null>(null);
  const inputRef = useRef<TerminalInput | null>(null);
  const resizeRef = useRef<TerminalResize | null>(null);
  const focusRef = useRef<TerminalFocus | null>(null);

  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  const tabRef = useRef(tab);
  tabRef.current = tab;

  const setTabConnected = useTerminalStore((state) => state.setTabConnected);
  const themeId = useSettingsStore((state) => state.themeId);
  const terminalFontSize = useSettingsStore((state) => state.terminalFontSize);
  const isSftpDrawerOpen = useSettingsStore((state) => state.isSftpDrawerOpen);
  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

  // 1. 初始化终端引擎、会话生命周期、输入与焦点控制
  useEffect(() => {
    if (!containerRef.current) return;

    const initialTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

    const view = new TerminalView({
      fontSize: terminalFontSize || 14,
      theme: initialTheme.terminal,
    });
    view.open(containerRef.current);
    viewRef.current = view;

    const session = new TerminalSession({
      tab: tabRef.current,
      onOutput: (data) => {
        view.write(data);
      },
      onConnectedChange: (connected) => {
        setTabConnected(tabRef.current.id, connected);
      },
    });
    sessionRef.current = session;

    const input = new TerminalInput({
      view,
      session,
      getIsActive: () => isActiveRef.current,
    });
    inputRef.current = input;

    const resize = new TerminalResize({
      container: containerRef.current,
      view,
      session,
      getIsActive: () => isActiveRef.current,
    });
    resizeRef.current = resize;

    const focus = new TerminalFocus({
      tabId: tab.id,
      view,
      container: containerRef.current,
      getIsActive: () => isActiveRef.current,
    });
    focusRef.current = focus;

    // 初始布局与连接建立
    resize.sync();
    session.connect(view.cols, view.rows);

    if (isActiveRef.current) {
      focus.focus();
      requestAnimationFrame(() => focus.focus());
      setTimeout(() => focus.focus(), 80);
      setTimeout(() => focus.focus(), 200);
    }

    setTimeout(() => {
      resize.sync();
    }, 80);
    setTimeout(() => {
      resize.sync();
    }, 200);

    return () => {
      focus.dispose();
      resize.dispose();
      input.dispose();
      session.dispose();
      view.dispose();

      focusRef.current = null;
      resizeRef.current = null;
      inputRef.current = null;
      sessionRef.current = null;
      viewRef.current = null;
    };
  }, [tab.id]);

  // 2. 保持 Tab 状态与控制器同步
  useEffect(() => {
    sessionRef.current?.updateTab(tab);
    focusRef.current?.updateTabId(tab.id);
  }, [tab]);

  // 3. 响应标签激活状态切换：自适应尺寸并聚焦
  useEffect(() => {
    if (isActive) {
      resizeRef.current?.sync();
      focusRef.current?.onActiveChange(true);
    } else {
      focusRef.current?.onActiveChange(false);
    }
  }, [isActive]);

  // 4. 响应主题切换
  useEffect(() => {
    const theme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;
    viewRef.current?.setTheme(theme.terminal);
  }, [themeId]);

  // 5. 响应字体大小变更
  useEffect(() => {
    if (terminalFontSize && viewRef.current) {
      viewRef.current.setFontSize(terminalFontSize);
      resizeRef.current?.sync();
    }
  }, [terminalFontSize]);

  // 6. 响应 SFTP 侧抽屉切换
  useEffect(() => {
    if (isActive) {
      resizeRef.current?.sync();
      const timer = setTimeout(() => {
        resizeRef.current?.sync();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isSftpDrawerOpen, isActive]);

  // 7. 响应窗口全局尺寸变动
  useEffect(() => {
    const handleWinResize = () => {
      if (isActiveRef.current) {
        resizeRef.current?.sync();
      }
    };
    window.addEventListener('resize', handleWinResize);
    return () => window.removeEventListener('resize', handleWinResize);
  }, []);

  // 8. 响应字体加载完成
  useEffect(() => {
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        resizeRef.current?.sync();
        viewRef.current?.refresh();
      });
    }
  }, []);

  // 9. 响应来自二级标签栏的清屏、全选复制与重试指令
  useEffect(() => {
    const onClear = (e: Event) => {
      const customEvent = e as CustomEvent<{ tabId?: string }>;
      if (!customEvent.detail?.tabId || customEvent.detail.tabId === tab.id) {
        viewRef.current?.clear();
      }
    };

    const onCopyAll = (e: Event) => {
      const customEvent = e as CustomEvent<{ tabId?: string }>;
      if (!customEvent.detail?.tabId || customEvent.detail.tabId === tab.id) {
        if (viewRef.current) {
          viewRef.current.selectAll();
          const text = viewRef.current.getSelection();
          if (text) {
            navigator.clipboard.writeText(text).catch(() => {});
            viewRef.current.clearSelection();
          }
        }
      }
    };

    const onRetry = async (e: Event) => {
      const customEvent = e as CustomEvent<{ tabId?: string }>;
      if (!customEvent.detail?.tabId || customEvent.detail.tabId === tab.id) {
        if (viewRef.current && sessionRef.current) {
          viewRef.current.clear();
          await sessionRef.current.retry(viewRef.current.cols, viewRef.current.rows);
        }
      }
    };

    window.addEventListener('terminal:clear', onClear);
    window.addEventListener('terminal:copy-all', onCopyAll);
    window.addEventListener('terminal:retry', onRetry);

    return () => {
      window.removeEventListener('terminal:clear', onClear);
      window.removeEventListener('terminal:copy-all', onCopyAll);
      window.removeEventListener('terminal:retry', onRetry);
    };
  }, [tab.id]);

  return (
    <div
      className="flex-1 w-full h-full overflow-hidden transition-colors duration-200 cursor-text relative"
      style={{ backgroundColor: currentTheme.ui.terminalBg }}
      onMouseDown={() => {
        focusRef.current?.focus();
      }}
      onClick={() => {
        focusRef.current?.focus();
      }}
    >
      <div
        ref={containerRef}
        className="w-full h-full p-2 overflow-hidden"
        style={{ backgroundColor: currentTheme.ui.terminalBg }}
      />
    </div>
  );
};
