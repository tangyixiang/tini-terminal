import React, { useEffect, useRef } from 'react';
import {
  terminalRuntimeManager,
  type TerminalUiCallbacks,
} from '../../core/terminal/TerminalRuntimeManager';
import { BUILTIN_THEMES, type ThemeId } from '../../types/theme';
import type { TerminalTab } from '../../types';

interface TerminalCanvasProps {
  tab: TerminalTab;
  isActive: boolean;
  themeId: ThemeId;
  fontSize: number;
  isSftpDrawerOpen: boolean;
  callbacks: TerminalUiCallbacks;
}

export const TerminalCanvas: React.FC<TerminalCanvasProps> = ({
  tab,
  isActive,
  themeId,
  fontSize,
  isSftpDrawerOpen,
  callbacks,
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

  // 挂载/卸载仅做 DOM attach/detach，绝不销毁终端引擎与 PTY 会话
  useEffect(() => {
    const mountEl = mountRef.current;
    if (!mountEl) return;

    terminalRuntimeManager.ensureInstance(
      tab,
      { themeId, fontSize, isActive },
      callbacksRef.current
    );
    terminalRuntimeManager.attach(tab.sessionId, mountEl);

    return () => {
      terminalRuntimeManager.detach(tab.sessionId, mountEl);
    };
  }, [tab.sessionId]);

  useEffect(() => {
    terminalRuntimeManager.setUiCallbacks(tab.sessionId, callbacks);
  }, [tab.sessionId, callbacks]);

  useEffect(() => {
    terminalRuntimeManager.updateTab(tab);
  }, [tab]);

  useEffect(() => {
    terminalRuntimeManager.setActive(tab.sessionId, isActive);
  }, [tab.sessionId, isActive]);

  useEffect(() => {
    const theme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;
    terminalRuntimeManager.setTheme(tab.sessionId, theme.terminal, theme.ui.terminalBg);
  }, [tab.sessionId, themeId]);

  useEffect(() => {
    if (fontSize) {
      terminalRuntimeManager.setFontSize(tab.sessionId, fontSize);
    }
  }, [tab.sessionId, fontSize]);

  useEffect(() => {
    if (!isActive) return;
    terminalRuntimeManager.syncResize(tab.sessionId);
    const timer = setTimeout(() => {
      terminalRuntimeManager.syncResize(tab.sessionId);
    }, 100);
    return () => clearTimeout(timer);
  }, [tab.sessionId, isSftpDrawerOpen, isActive]);

  useEffect(() => {
    const handleWinResize = () => {
      if (isActive) {
        terminalRuntimeManager.syncResize(tab.sessionId);
      }
    };
    window.addEventListener('resize', handleWinResize);
    return () => window.removeEventListener('resize', handleWinResize);
  }, [tab.sessionId, isActive]);

  useEffect(() => {
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        terminalRuntimeManager.onFontsReady(tab.sessionId);
      });
    }
  }, [tab.sessionId]);

  return (
    <div className="w-full h-full p-2 overflow-hidden">
      <div
        ref={mountRef}
        className="w-full h-full overflow-hidden"
        style={{ backgroundColor: currentTheme.ui.terminalBg }}
      />
    </div>
  );
};
