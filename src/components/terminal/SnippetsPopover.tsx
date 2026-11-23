import React, { useEffect, useState, useRef } from 'react';
import { BookMarked, Plus, Play, Radio, Trash2, Search, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { BUILTIN_THEMES, getPrimaryButtonStyle } from '../../types/theme';
import { sendToTerminal } from '../../lib/terminal/ptyBridge';
import type { SnippetRecord } from '../../types';

export const SnippetsPopover: React.FC = () => {
  const { tabs, activeTabId } = useTerminalStore();
  const { themeId } = useSettingsStore();
  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

  const [open, setOpen] = useState(false);
  const [snippets, setSnippets] = useState<SnippetRecord[]>([]);
  const [keyword, setKeyword] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('常用');
  const [command, setCommand] = useState('');
  const [feedback, setFeedback] = useState('');

  const popoverRef = useRef<HTMLDivElement>(null);

  const loadSnippets = async () => {
    if (!window.__TAURI_INTERNALS__) return;
    try {
      const list = await invoke<SnippetRecord[]>('list_snippets');
      setSnippets(list || []);
    } catch {}
  };

  useEffect(() => {
    if (open) loadSnippets();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: PointerEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onOutside);
    return () => document.removeEventListener('pointerdown', onOutside);
  }, [open]);

  const handleSave = async () => {
    if (!name.trim() || !command.trim()) return;
    const record: SnippetRecord = {
      id: `snip-${Date.now()}`,
      name: name.trim(),
      command: command.trim(),
      category: category.trim() || '常用',
      description: null,
      created_at: Date.now(),
    };
    try {
      if (window.__TAURI_INTERNALS__) {
        await invoke('save_snippet', { snippet: record });
      }
      setSnippets((prev) => [record, ...prev]);
      setName('');
      setCommand('');
      setCreating(false);
    } catch {}
  };

  const handleDelete = async (id: string) => {
    try {
      if (window.__TAURI_INTERNALS__) {
        await invoke('delete_snippet', { id });
      }
      setSnippets((prev) => prev.filter((s) => s.id !== id));
    } catch {}
  };

  const handleRunCurrent = (cmd: string) => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (!activeTab) return;
    sendToTerminal(activeTab.sessionId, `${cmd}\n`);
    setFeedback(`已发送至 ${activeTab.title}`);
    setTimeout(() => setFeedback(''), 2000);
    window.dispatchEvent(new CustomEvent('terminal:refocus', { detail: { tabId: activeTab.id } }));
  };

  const handleBroadcastAll = (cmd: string) => {
    const connectedTabs = tabs.filter((t) => t.connected);
    if (connectedTabs.length === 0) return;
    for (const t of connectedTabs) {
      sendToTerminal(t.sessionId, `${cmd}\n`);
    }
    setFeedback(`已广播至 ${connectedTabs.length} 个已连接终端`);
    setTimeout(() => setFeedback(''), 2500);
  };

  const filtered = snippets.filter((s) => {
    if (!keyword.trim()) return true;
    const q = keyword.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      s.command.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q)
    );
  });

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="px-2 py-0.5 rounded text-[11px] cursor-pointer flex items-center gap-1 transition-colors hover:opacity-100 opacity-80"
        style={{
          backgroundColor: open ? currentTheme.ui.activeTabBg : currentTheme.ui.hoverBg,
          color: open ? currentTheme.ui.accent : currentTheme.ui.text,
        }}
        title="快捷命令片段库（支持一键发送与多终端广播）"
      >
        <BookMarked className="w-3 h-3" />
        <span>命令库</span>
      </button>

      {open && (
        <div
          className="absolute right-0 top-8 w-80 rounded-lg border shadow-2xl z-50 p-2.5 flex flex-col gap-2 text-xs select-none"
          style={{
            backgroundColor: currentTheme.ui.cardBg,
            borderColor: currentTheme.ui.border,
            color: currentTheme.ui.text,
          }}
        >
          <div className="flex items-center justify-between pb-1.5 border-b" style={{ borderColor: currentTheme.ui.border }}>
            <span className="font-semibold text-[11px]">快捷命令片段库</span>
            <button
              type="button"
              onClick={() => setCreating(!creating)}
              className="px-1.5 py-0.5 rounded text-[11px] flex items-center gap-1 cursor-pointer"
              style={{
                backgroundColor: currentTheme.ui.hoverBg,
                color: currentTheme.ui.accent,
              }}
            >
              {creating ? <X className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
              <span>{creating ? '取消' : '新增'}</span>
            </button>
          </div>

          {creating ? (
            <div className="space-y-2 text-[11px]">
              <div className="grid grid-cols-3 gap-1.5">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="名称（如查看端口）"
                  className="col-span-2 px-2 py-1 rounded border outline-none"
                  style={{
                    backgroundColor: currentTheme.ui.inputBg,
                    borderColor: currentTheme.ui.border,
                    color: currentTheme.ui.text,
                  }}
                />
                <input
                  type="text"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="分组"
                  className="px-2 py-1 rounded border outline-none"
                  style={{
                    backgroundColor: currentTheme.ui.inputBg,
                    borderColor: currentTheme.ui.border,
                    color: currentTheme.ui.text,
                  }}
                />
              </div>
              <textarea
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                rows={2}
                placeholder="输入命令内容，如 ss -lntp"
                className="w-full px-2 py-1 rounded border font-mono outline-none resize-none"
                style={{
                  backgroundColor: currentTheme.ui.inputBg,
                  borderColor: currentTheme.ui.border,
                  color: currentTheme.ui.text,
                }}
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={!name.trim() || !command.trim()}
                  className="px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer disabled:opacity-40"
                  style={getPrimaryButtonStyle(currentTheme)}
                >
                  保存片段
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 opacity-50" />
                <input
                  type="text"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="搜索命令名称/内容..."
                  className="w-full pl-6 pr-2 py-1 rounded border text-[11px] outline-none"
                  style={{
                    backgroundColor: currentTheme.ui.inputBg,
                    borderColor: currentTheme.ui.border,
                    color: currentTheme.ui.text,
                  }}
                />
              </div>

              {feedback && (
                <div className="text-[10px] font-mono px-2 py-0.5 rounded" style={{ backgroundColor: currentTheme.ui.hoverBg, color: currentTheme.ui.accent }}>
                  {feedback}
                </div>
              )}

              <div className="max-h-64 overflow-y-auto space-y-1">
                {filtered.length === 0 ? (
                  <div className="text-center py-5 text-[11px]" style={{ color: currentTheme.ui.textMuted }}>
                    暂无保存的命令片段，点击右上角“新增”添加
                  </div>
                ) : (
                  filtered.map((snip) => (
                    <div
                      key={snip.id}
                      className="p-2 rounded border group transition-colors"
                      style={{
                        backgroundColor: currentTheme.ui.inputBg,
                        borderColor: currentTheme.ui.border,
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className="px-1 py-0.2 rounded text-[9px] font-mono shrink-0"
                            style={{
                              backgroundColor: currentTheme.ui.hoverBg,
                              color: currentTheme.ui.accent,
                            }}
                          >
                            {snip.category}
                          </span>
                          <span className="font-medium truncate text-[11px]">{snip.name}</span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleRunCurrent(snip.command)}
                            className="p-1 rounded hover:bg-white/10 cursor-pointer text-emerald-400"
                            title="发送到当前终端执行"
                          >
                            <Play className="w-3 h-3" />
                          </button>
                          {tabs.filter((t) => t.connected).length > 1 && (
                            <button
                              type="button"
                              onClick={() => handleBroadcastAll(snip.command)}
                              className="p-1 rounded hover:bg-white/10 cursor-pointer text-amber-400"
                              title="广播发送到全部已连接终端"
                            >
                              <Radio className="w-3 h-3" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleDelete(snip.id)}
                            className="p-1 rounded hover:bg-white/10 cursor-pointer opacity-60 hover:opacity-100 hover:text-red-400"
                            title="删除片段"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                      <div
                        className="mt-1 font-mono text-[10px] truncate"
                        style={{ color: currentTheme.ui.textMuted }}
                        title={snip.command}
                      >
                        {snip.command}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
