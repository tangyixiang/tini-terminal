import React, { useEffect, useRef, useState } from 'react';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';
import type { ThemeConfig } from '../../types/theme';
import { focusManager } from '../../core/focus/FocusManager';
import type { TerminalController } from '../../core/terminal/TerminalRuntimeManager';

interface TerminalSearchBarProps {
  tabId: string;
  open: boolean;
  theme: ThemeConfig;
  getController: () => TerminalController | null;
  onClose: () => void;
}

export const TerminalSearchBar: React.FC<TerminalSearchBarProps> = ({
  tabId,
  open,
  theme,
  getController,
  onClose,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const scopeId = `terminal-search-${tabId}`;

  useEffect(() => {
    if (open) {
      focusManager.pushScope(scopeId, 'overlay');
      setTimeout(() => inputRef.current?.focus(), 20);
    } else {
      focusManager.popScope(scopeId);
    }
    return () => {
      focusManager.popScope(scopeId, false);
    };
  }, [open, scopeId]);

  if (!open) return null;

  const runSearch = (
    direction: 'next' | 'prev',
    q = query,
    cs = caseSensitive,
    rx = useRegex
  ) => {
    const ctrl = getController();
    if (!q || !ctrl) {
      ctrl?.clearSearch();
      setNotFound(false);
      return;
    }
    const opts = { caseSensitive: cs, regex: rx };
    const found = direction === 'next' ? ctrl.findNext(q, opts) : ctrl.findPrevious(q, opts);
    setNotFound(!found);
  };

  const handleClose = () => {
    setNotFound(false);
    getController()?.clearSearch();
    onClose();
  };

  return (
    <div
      data-terminal-overlay
      className="absolute top-2 right-3 z-30 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border shadow-xl text-xs select-none"
      style={{
        backgroundColor: theme.ui.cardBg,
        borderColor: notFound ? '#ef4444' : theme.ui.border,
        color: theme.ui.text,
      }}
    >
      <Search className="w-3.5 h-3.5 opacity-60 shrink-0" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          runSearch('next', e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            runSearch(e.shiftKey ? 'prev' : 'next');
          } else if (e.key === 'Escape') {
            e.preventDefault();
            handleClose();
          }
        }}
        placeholder="搜索终端内容..."
        className="w-44 bg-transparent outline-none text-xs font-mono"
        style={{ color: theme.ui.text }}
      />
      <button
        type="button"
        onClick={() => {
          const next = !caseSensitive;
          setCaseSensitive(next);
          runSearch('next', query, next, useRegex);
        }}
        className="px-1.5 py-0.5 rounded text-[10px] font-mono border cursor-pointer"
        style={{
          borderColor: caseSensitive ? theme.ui.accent : theme.ui.border,
          color: caseSensitive ? theme.ui.accent : theme.ui.textMuted,
        }}
        title="区分大小写"
      >
        Aa
      </button>
      <button
        type="button"
        onClick={() => {
          const next = !useRegex;
          setUseRegex(next);
          runSearch('next', query, caseSensitive, next);
        }}
        className="px-1.5 py-0.5 rounded text-[10px] font-mono border cursor-pointer"
        style={{
          borderColor: useRegex ? theme.ui.accent : theme.ui.border,
          color: useRegex ? theme.ui.accent : theme.ui.textMuted,
        }}
        title="正则表达式"
      >
        .*
      </button>
      <button
        type="button"
        onClick={() => runSearch('prev')}
        className="p-0.5 rounded hover:bg-white/10 cursor-pointer"
        title="上一个 (Shift+Enter)"
      >
        <ChevronUp className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={() => runSearch('next')}
        className="p-0.5 rounded hover:bg-white/10 cursor-pointer"
        title="下一个 (Enter)"
      >
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={handleClose}
        className="p-0.5 rounded hover:bg-white/10 cursor-pointer opacity-70 hover:opacity-100"
        title="关闭 (Esc)"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
