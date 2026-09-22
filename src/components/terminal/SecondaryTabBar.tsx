import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  Plus,
  Terminal,
  Server,
  X,
  ChevronDown,
  Layers,
  Search,
  RefreshCw,
} from 'lucide-react';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { BUILTIN_THEMES } from '../../types/theme';

export const SecondaryTabBar: React.FC = () => {
  const { tabs, activeTabId, setActiveTabId, closeTab, openLocalTab } = useTerminalStore();
  const { themeId } = useSettingsStore();
  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId), [tabs, activeTabId]);

  // 计算同一主机/环境的多开会话计数与序号（主机分组堆叠标识）
  const tabIndexMap = useMemo(() => {
    const counts: Record<string, number> = {};
    const indices: Record<string, { index: number; total: number }> = {};
    for (const t of tabs) {
      const key = t.isSsh && t.server ? t.server.id : 'local';
      counts[key] = (counts[key] || 0) + 1;
    }
    const currentCounters: Record<string, number> = {};
    for (const t of tabs) {
      const key = t.isSsh && t.server ? t.server.id : 'local';
      currentCounters[key] = (currentCounters[key] || 0) + 1;
      indices[t.id] = { index: currentCounters[key], total: counts[key] };
    }
    return indices;
  }, [tabs]);

  // 鼠标滚轮横向平滑滚动标签栏
  const handleWheel = (e: React.WheelEvent) => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft += e.deltaY;
    }
  };

  // 点击外部自动关闭会话下拉面板
  useEffect(() => {
    if (!isDropdownOpen) return;
    const handleOutsideClick = (e: PointerEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener('pointerdown', handleOutsideClick);
    return () => {
      document.removeEventListener('pointerdown', handleOutsideClick);
    };
  }, [isDropdownOpen]);

  const handleClear = () => {
    window.dispatchEvent(new CustomEvent('terminal:clear', { detail: { tabId: activeTabId } }));
  };

  const handleCopyAll = () => {
    window.dispatchEvent(new CustomEvent('terminal:copy-all', { detail: { tabId: activeTabId } }));
  };

  const handleRetry = () => {
    window.dispatchEvent(new CustomEvent('terminal:retry', { detail: { tabId: activeTabId } }));
  };

  const handleCloseOthers = () => {
    if (!activeTabId) return;
    const otherTabs = tabs.filter((t) => t.id !== activeTabId);
    otherTabs.forEach((t) => closeTab(t.id));
    setIsDropdownOpen(false);
  };

  const handleCloseAll = () => {
    [...tabs].forEach((t) => closeTab(t.id));
    setIsDropdownOpen(false);
  };

  const filteredTabs = useMemo(() => {
    if (!keyword.trim()) return tabs;
    const q = keyword.toLowerCase();
    return tabs.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        (t.server && t.server.host.toLowerCase().includes(q)) ||
        (t.server && t.server.username.toLowerCase().includes(q))
    );
  }, [tabs, keyword]);

  if (tabs.length === 0) return null;

  return (
    <div
      className="h-[34px] border-b flex items-center justify-between px-2 gap-2 shrink-0 select-none relative transition-colors duration-200"
      style={{
        backgroundColor: currentTheme.ui.cardBg,
        borderColor: currentTheme.ui.border,
      }}
    >
      {/* 左侧：可横向滚动紧凑二级标签带 */}
      <div
        ref={scrollRef}
        onWheel={handleWheel}
        className="flex-1 flex items-center gap-1.5 overflow-x-auto h-full no-scrollbar py-1"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const grouping = tabIndexMap[tab.id];
          const hasMultiple = grouping && grouping.total > 1;

          return (
            <div
              key={tab.id}
              onClick={() => {
                setActiveTabId(tab.id);
                window.dispatchEvent(
                  new CustomEvent('terminal:refocus', { detail: { tabId: tab.id } })
                );
              }}
              onMouseDown={(e) => {
                // 鼠标中键单击关闭标签
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(tab.id);
                }
              }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs cursor-pointer shrink-0 border transition-all duration-150 group max-w-[200px]"
              style={{
                backgroundColor: isActive ? currentTheme.ui.activeTabBg : 'transparent',
                borderColor: isActive ? currentTheme.ui.accent : currentTheme.ui.border,
                color: isActive ? currentTheme.ui.text : currentTheme.ui.textMuted,
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLElement).style.backgroundColor = currentTheme.ui.hoverBg;
                  (e.currentTarget as HTMLElement).style.color = currentTheme.ui.text;
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
                  (e.currentTarget as HTMLElement).style.color = currentTheme.ui.textMuted;
                }
              }}
              title={`${tab.title}${hasMultiple ? ` (会话 #${grouping.index})` : ''} - 鼠标中键或右侧按钮可关闭`}
            >
              {/* 会话连接状态圆点 */}
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  tab.connected ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'
                }`}
              />

              {/* 终端类型小图标 */}
              {tab.isSsh ? (
                <Server className="w-3 h-3 shrink-0 opacity-70" />
              ) : (
                <Terminal className="w-3 h-3 shrink-0 opacity-70 text-blue-400" />
              )}

              {/* 会话名称 */}
              <span className="font-terminal truncate text-[11px] font-medium">
                {tab.isSsh && tab.server ? tab.server.name : 'Local Shell'}
              </span>

              {/* 同机多开分组标签序号 */}
              {hasMultiple && (
                <span
                  className="text-[9px] px-1 rounded font-mono font-bold shrink-0 opacity-80"
                  style={{
                    backgroundColor: currentTheme.ui.hoverBg,
                    color: currentTheme.ui.accent,
                  }}
                >
                  #{grouping.index}
                </span>
              )}

              {/* 关闭标签按钮 */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="p-0.5 rounded ml-0.5 cursor-pointer opacity-40 group-hover:opacity-100 hover:text-red-400 transition-opacity"
                style={{ color: currentTheme.ui.text }}
                title="关闭此会话"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}

        {/* 快捷新建本地终端按钮 */}
        <button
          onClick={() => openLocalTab()}
          className="p-1 rounded text-xs cursor-pointer shrink-0 hover:opacity-100 opacity-60 transition-opacity"
          style={{
            backgroundColor: currentTheme.ui.hoverBg,
            color: currentTheme.ui.text,
          }}
          title="新建本地终端"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 右侧：动作按钮与会话池总览下拉 */}
      <div className="flex items-center gap-1 shrink-0 pl-2 border-l" style={{ borderColor: currentTheme.ui.border }}>
        {/* 断开状态重试按钮 */}
        {activeTab?.isSsh && !activeTab?.connected && (
          <button
            onClick={handleRetry}
            className="px-2 py-0.5 rounded text-[11px] cursor-pointer flex items-center gap-1 transition-colors"
            style={{
              backgroundColor: currentTheme.ui.hoverBg,
              color: currentTheme.ui.accent,
            }}
            title="重新连接当前主机"
          >
            <RefreshCw className="w-2.5 h-2.5" />
            <span>重试</span>
          </button>
        )}

        {/* 清屏 */}
        <button
          onClick={handleClear}
          className="px-2 py-0.5 rounded text-[11px] cursor-pointer transition-colors hover:opacity-100 opacity-70"
          style={{
            backgroundColor: currentTheme.ui.hoverBg,
            color: currentTheme.ui.text,
          }}
          title="清空当前终端屏幕"
        >
          清屏
        </button>

        {/* 复制全部 */}
        <button
          onClick={handleCopyAll}
          className="px-2 py-0.5 rounded text-[11px] cursor-pointer transition-colors hover:opacity-100 opacity-70"
          style={{
            backgroundColor: currentTheme.ui.hoverBg,
            color: currentTheme.ui.text,
          }}
          title="复制终端全部内容"
        >
          复制
        </button>

        {/* 全部会话下拉面板触发按钮 */}
        <div className="relative">
          <button
            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
            className="px-2 py-0.5 rounded text-[11px] cursor-pointer flex items-center gap-1 border transition-colors"
            style={{
              backgroundColor: isDropdownOpen ? currentTheme.ui.hoverBg : 'transparent',
              borderColor: currentTheme.ui.border,
              color: currentTheme.ui.text,
            }}
            title="所有已开启会话总览"
          >
            <Layers className="w-3 h-3 text-emerald-400" />
            <span className="font-mono text-[10px]">{tabs.length}</span>
            <ChevronDown className="w-3 h-3 opacity-60" />
          </button>

          {/* 会话总览下拉浮层 */}
          {isDropdownOpen && (
            <div
              ref={dropdownRef}
              className="absolute right-0 top-8 w-72 rounded-lg border shadow-2xl z-50 p-2 flex flex-col gap-1 text-xs select-none"
              style={{
                backgroundColor: currentTheme.ui.cardBg,
                borderColor: currentTheme.ui.border,
                color: currentTheme.ui.text,
              }}
            >
              <div
                className="px-2 py-1 text-[11px] font-semibold border-b flex items-center justify-between"
                style={{
                  borderColor: currentTheme.ui.border,
                  color: currentTheme.ui.textMuted,
                }}
              >
                <span>活跃会话 ({tabs.length})</span>
                <span className="text-[10px]">点击切换</span>
              </div>

              {/* 搜索框 */}
              <div className="relative my-1">
                <input
                  type="text"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="搜索会话/IP..."
                  className="w-full text-xs rounded px-2.5 py-1 pl-7 border focus:outline-none transition-colors"
                  style={{
                    backgroundColor: currentTheme.ui.inputBg,
                    borderColor: currentTheme.ui.border,
                    color: currentTheme.ui.text,
                  }}
                  autoFocus
                />
                <Search
                  className="w-3 h-3 absolute left-2 top-2"
                  style={{ color: currentTheme.ui.textMuted }}
                />
              </div>

              {/* 会话列表 */}
              <div className="max-h-60 overflow-y-auto space-y-0.5">
                {filteredTabs.length === 0 ? (
                  <div className="text-center py-4 text-xs" style={{ color: currentTheme.ui.textMuted }}>
                    未匹配到会话
                  </div>
                ) : (
                  filteredTabs.map((t) => {
                    const isActive = t.id === activeTabId;
                    const grouping = tabIndexMap[t.id];
                    return (
                      <div
                        key={t.id}
                        onClick={() => {
                          setActiveTabId(t.id);
                          setIsDropdownOpen(false);
                          window.dispatchEvent(
                            new CustomEvent('terminal:refocus', { detail: { tabId: t.id } })
                          );
                        }}
                        className="flex items-center justify-between px-2 py-1.5 rounded cursor-pointer transition-colors group"
                        style={{
                          backgroundColor: isActive ? currentTheme.ui.hoverBg : 'transparent',
                          color: isActive ? currentTheme.ui.accent : currentTheme.ui.text,
                        }}
                      >
                        <div className="flex items-center gap-2 truncate flex-1">
                          <span
                            className={`w-2 h-2 rounded-full shrink-0 ${
                              t.connected ? 'bg-emerald-400' : 'bg-amber-400'
                            }`}
                          />
                          <span className="truncate text-xs font-medium font-terminal">
                            {t.title}
                          </span>
                          {grouping && grouping.total > 1 && (
                            <span
                              className="text-[9px] px-1 rounded font-mono font-bold shrink-0 opacity-80"
                              style={{
                                backgroundColor: currentTheme.ui.hoverBg,
                                color: currentTheme.ui.accent,
                              }}
                            >
                              #{grouping.index}
                            </span>
                          )}
                        </div>

                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            closeTab(t.id);
                          }}
                          className="p-1 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity ml-2 shrink-0"
                          style={{ color: currentTheme.ui.textMuted }}
                          title="关闭"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>

              {/* 底部批量操作 */}
              <div
                className="pt-1.5 mt-1 border-t flex items-center justify-between text-[11px]"
                style={{
                  borderColor: currentTheme.ui.border,
                  color: currentTheme.ui.textMuted,
                }}
              >
                <button
                  onClick={handleCloseOthers}
                  className="hover:text-red-400 cursor-pointer transition-colors"
                >
                  关闭其他会话
                </button>
                <button
                  onClick={handleCloseAll}
                  className="hover:text-red-400 cursor-pointer transition-colors"
                >
                  关闭全部
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
