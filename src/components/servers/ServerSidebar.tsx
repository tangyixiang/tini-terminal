import React, { useState, useRef } from 'react';
import { Search, Terminal, Edit2, Trash2, FolderKanban, ChevronLeft } from 'lucide-react';
import { useServerStore } from '../../stores/useServerStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { BUILTIN_THEMES } from '../../types/theme';
import type { ServerRecord } from '../../types';

export const ServerSidebar: React.FC = () => {
  const [keyword, setKeyword] = useState('');
  const lastConnectTimeRef = useRef<{ [id: string]: number }>({});
  const { servers, deleteServer } = useServerStore();
  const { tabs, openSshTab, openLocalTab, setActiveTabId } = useTerminalStore();
  const {
    toggleServerModal,
    toggleSftpDrawer,
    themeId,
    sidebarWidth,
    toggleServerSidebar,
  } = useSettingsStore();

  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

  const filtered = servers.filter(
    (s) =>
      s.name.toLowerCase().includes(keyword.toLowerCase()) ||
      s.host.toLowerCase().includes(keyword.toLowerCase()) ||
      (s.tags && s.tags.toLowerCase().includes(keyword.toLowerCase()))
  );

  const groups: Record<string, ServerRecord[]> = {};
  for (const s of filtered) {
    const grp = s.group_name || '未分组';
    if (!groups[grp]) groups[grp] = [];
    groups[grp].push(s);
  }

  const handleConnect = (server: ServerRecord) => {
    const now = Date.now();
    if (now - (lastConnectTimeRef.current[server.id] || 0) < 400) {
      return;
    }
    lastConnectTimeRef.current[server.id] = now;

    if (server.host === 'localhost' && server.username === 'local') {
      openLocalTab();
      return;
    }
    // 若该主机已有打开的终端会话，直接平滑切换，避免重复发起并行连接造成卡顿
    const existing = tabs.find((t) => t.isSsh && t.server?.id === server.id);
    if (existing) {
      setActiveTabId(existing.id);
      window.dispatchEvent(
        new CustomEvent('terminal:refocus', { detail: { tabId: existing.id } })
      );
      return;
    }
    openSshTab(server);
  };

  const handleOpenNewTab = (server: ServerRecord) => {
    openSshTab(server);
  };

  return (
    <aside
      className="border-r flex flex-col shrink-0 select-none transition-colors duration-200 overflow-hidden"
      style={{
        width: sidebarWidth,
        backgroundColor: currentTheme.ui.sidebarBg,
        borderColor: currentTheme.ui.border,
      }}
    >
      {/* 顶部标题与折叠控制 */}
      <div
        className="h-9 px-3 border-b flex items-center justify-between text-xs font-semibold shrink-0"
        style={{
          borderColor: currentTheme.ui.border,
          color: currentTheme.ui.text,
        }}
      >
        <span>主机列表</span>
        <button
          onClick={() => toggleServerSidebar(false)}
          className="p-1 rounded cursor-pointer hover:opacity-100 opacity-60 transition-opacity"
          style={{ color: currentTheme.ui.text }}
          title="收起主机栏"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      </div>
      {/* 搜索框 */}
      <div
        className="p-2 border-b"
        style={{ borderColor: currentTheme.ui.border }}
      >
        <div className="relative">
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索主机名/IP/标签..."
            className="w-full text-xs rounded px-2.5 py-1.5 pl-7 border focus:outline-none transition-colors"
            style={{
              backgroundColor: currentTheme.ui.inputBg,
              borderColor: currentTheme.ui.border,
              color: currentTheme.ui.text,
            }}
          />
          <Search
            className="w-3.5 h-3.5 absolute left-2 top-2"
            style={{ color: currentTheme.ui.textMuted }}
          />
        </div>
      </div>

      {/* 主机树列表 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {/* 本地终端快捷入口 */}
        <div>
          <div
            className="flex items-center justify-between text-[11px] font-semibold px-2 py-1 tracking-wider"
            style={{ color: currentTheme.ui.textMuted }}
          >
            <span>本地环境</span>
          </div>
          <div
            onClick={() => openLocalTab()}
            className="flex items-center justify-between px-2.5 py-1.5 rounded text-xs cursor-pointer group mt-0.5 transition-colors"
            style={{
              color: currentTheme.ui.text,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.backgroundColor = currentTheme.ui.hoverBg;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
            }}
          >
            <div className="flex items-center gap-2 truncate">
              <Terminal className="w-3.5 h-3.5 text-blue-500 shrink-0" />
              <span className="font-medium truncate">本地 Shell</span>
            </div>
            <span
              className="text-[10px] font-terminal"
              style={{ color: currentTheme.ui.textMuted }}
            >
              {typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent)
                ? 'PowerShell'
                : 'zsh/bash'}
            </span>
          </div>
        </div>

        {/* 动态远程分组 */}
        {Object.keys(groups).length === 0 && filtered.length === 0 ? (
          <div
            className="text-center py-6 text-xs"
            style={{ color: currentTheme.ui.textMuted }}
          >
            暂无匹配主机
          </div>
        ) : (
          Object.entries(groups).map(([grpName, sList]) => (
            <div key={grpName}>
              <div
                className="flex items-center justify-between text-[11px] font-semibold px-2 py-1 tracking-wider"
                style={{ color: currentTheme.ui.textMuted }}
              >
                <span>{grpName}</span>
                <span className="text-[10px]">{sList.length}</span>
              </div>
              <div className="mt-1 space-y-0.5">
                {sList.map((srv) => (
                  <div
                    key={srv.id}
                    onClick={() => handleConnect(srv)}
                    className="flex items-center justify-between px-2.5 py-1.5 rounded text-xs cursor-pointer group transition-colors"
                    style={{
                      color: currentTheme.ui.text,
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.backgroundColor = currentTheme.ui.hoverBg;
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
                    }}
                  >
                    <div className="flex items-center gap-2 truncate flex-1">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                      <span className="font-medium truncate">{srv.name}</span>
                    </div>

                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenNewTab(srv);
                        }}
                        className="p-1 hover:opacity-100 opacity-60"
                        style={{ color: currentTheme.ui.text }}
                        title="新建终端标签"
                      >
                        <Terminal className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleConnect(srv);
                          toggleSftpDrawer(true);
                        }}
                        className="p-1 hover:opacity-100 opacity-60"
                        style={{ color: currentTheme.ui.text }}
                        title="打开 SFTP"
                      >
                        <FolderKanban className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleServerModal(true, srv.id);
                        }}
                        className="p-1 hover:opacity-100 opacity-60"
                        style={{ color: currentTheme.ui.text }}
                        title="编辑配置"
                      >
                        <Edit2 className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`确定删除主机 "${srv.name}"？`)) {
                            deleteServer(srv.id);
                          }
                        }}
                        className="p-1 hover:text-red-500 opacity-60"
                        style={{ color: currentTheme.ui.text }}
                        title="删除配置"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>

                    <span
                      className="text-[10px] font-terminal group-hover:hidden ml-1"
                      style={{ color: currentTheme.ui.textMuted }}
                    >
                      {srv.host}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 侧边栏底部状态与新建按钮 */}
      <div
        className="p-2.5 border-t text-[11px] flex items-center justify-between"
        style={{
          borderColor: currentTheme.ui.border,
          color: currentTheme.ui.textMuted,
        }}
      >
        <span>已存主机: {servers.length} 台</span>
        <button
          onClick={() => toggleServerModal(true)}
          className="cursor-pointer font-medium"
          style={{ color: currentTheme.ui.accent }}
        >
          新建主机
        </button>
      </div>
    </aside>
  );
};
