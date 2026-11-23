import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { BUILTIN_THEMES } from '../../types/theme';
import { getDesktopPlatform } from '../../lib/platform';
import type { SessionContext } from '../../types';

export const StatusBar: React.FC = () => {
  const { tabs, activeTabId, latencyMs, setTabLatency } = useTerminalStore();
  const { themeId } = useSettingsStore();
  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const [ctx, setCtx] = useState<SessionContext | null>(null);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    if (!activeTab || !window.__TAURI_INTERNALS__) {
      setCtx(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await invoke<SessionContext | null>('get_session_context', {
          sessionId: activeTab.sessionId,
        });
        if (!cancelled) setCtx(res);
      } catch {}
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeTab?.sessionId]);

  const handleProbeLatency = async () => {
    if (!activeTab?.isSsh || !activeTab.connected || probing || !window.__TAURI_INTERNALS__) return;
    setProbing(true);
    try {
      const ms = await invoke<number>('measure_ssh_latency', {
        sessionId: activeTab.sessionId,
      });
      setTabLatency(activeTab.id, ms);
    } catch {
      setTabLatency(activeTab.id, null);
    } finally {
      setProbing(false);
    }
  };

  const displayLatency = activeTab?.latencyMs ?? latencyMs;

  return (
    <footer
      className="h-6 border-t px-3 flex items-center justify-between text-[11px] shrink-0 select-none transition-colors duration-200"
      style={{
        backgroundColor: currentTheme.ui.headerBg,
        borderColor: currentTheme.ui.border,
        color: currentTheme.ui.textMuted,
      }}
    >
      <div className="flex items-center gap-4 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              activeTab?.connected ? 'bg-emerald-500' : 'bg-zinc-500'
            }`}
          />
          <span className="truncate" style={{ color: currentTheme.ui.text }}>
            {activeTab
              ? activeTab.isSsh && activeTab.server
                ? `${activeTab.connected ? '已连接' : '已断开'}: ${activeTab.server.name} (${activeTab.server.host}:${activeTab.server.port})`
                : `本地终端: ${activeTab.title}`
              : '就绪 (无活动终端)'}
          </span>
        </div>

        {ctx?.user && (
          <span className="font-mono truncate hidden sm:inline">
            用户: {ctx.user}
          </span>
        )}
        {ctx?.cwd && (
          <span className="font-mono truncate max-w-[260px] hidden md:inline" title={ctx.cwd}>
            目录: {ctx.cwd}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3 shrink-0 font-mono">
        {activeTab?.isSsh && activeTab.connected && (
          <button
            type="button"
            onClick={handleProbeLatency}
            className="cursor-pointer hover:underline"
            style={{
              color:
                displayLatency != null
                  ? displayLatency < 80
                    ? '#10b981'
                    : displayLatency < 200
                      ? '#f59e0b'
                      : '#ef4444'
                  : currentTheme.ui.textMuted,
            }}
            title="点击重新探测 TCP 往返延迟"
          >
            {probing ? '测速中...' : displayLatency != null ? `RTT: ${displayLatency}ms` : '测速'}
          </button>
        )}
        <span>UTF-8</span>
        <span className="uppercase opacity-70">{getDesktopPlatform()}</span>
      </div>
    </footer>
  );
};
