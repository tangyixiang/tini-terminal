import React from 'react';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { BUILTIN_THEMES } from '../../types/theme';

export const StatusBar: React.FC = () => {
  const { tabs, activeTabId, latencyMs } = useTerminalStore();
  const { themeId } = useSettingsStore();
  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;
  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <footer
      className="h-6 border-t px-3 flex items-center justify-between text-[11px] shrink-0 select-none transition-colors duration-200"
      style={{
        backgroundColor: currentTheme.ui.headerBg,
        borderColor: currentTheme.ui.border,
        color: currentTheme.ui.textMuted,
      }}
    >
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full ${
              activeTab?.connected ? 'bg-emerald-500' : 'bg-zinc-500'
            }`}
          />
          <span style={{ color: currentTheme.ui.text }}>
            {activeTab
              ? activeTab.isSsh && activeTab.server
                ? `已连接: ${activeTab.server.name} (${activeTab.server.host}:${activeTab.server.port})`
                : '本地终端: Local Shell'
              : '就绪 (无活动终端)'}
          </span>
        </div>
        <span>延迟: {activeTab?.connected ? `${latencyMs}ms` : '--'}</span>
        <span>编码: UTF-8</span>
      </div>
    </footer>
  );
};
