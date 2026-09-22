import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { TerminalTab, ServerRecord } from '../types';

interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  latencyMs: number;
  openLocalTab: () => string;
  openSshTab: (server: ServerRecord) => string;
  closeTab: (id: string) => void;
  setActiveTabId: (id: string) => void;
  setTabConnected: (id: string, connected: boolean) => void;
  setLatencyMs: (ms: number) => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  latencyMs: 12,

  openLocalTab: () => {
    const id = 'tab-' + Math.random().toString(36).substring(2, 9);
    const isWindows = typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent);
    const newTab: TerminalTab = {
      id,
      sessionId: id,
      title: isWindows ? 'PowerShell' : 'Local Shell',
      isSsh: false,
      connected: true,
    };
    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: id,
    }));
    return id;
  },

  openSshTab: (server: ServerRecord) => {
    const id = 'tab-' + Math.random().toString(36).substring(2, 9);
    const newTab: TerminalTab = {
      id,
      sessionId: id,
      title: `${server.name} (${server.host})`,
      isSsh: true,
      server,
      connected: false,
    };
    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: id,
    }));
    return id;
  },

  closeTab: (id: string) => {
    const { tabs, activeTabId } = get();
    const tab = tabs.find((t) => t.id === id);
    if (tab && window.__TAURI_INTERNALS__) {
      invoke('close_terminal', { sessionId: tab.sessionId, isSsh: tab.isSsh }).catch(() => {});
    }

    const remaining = tabs.filter((t) => t.id !== id);
    let nextActiveId = activeTabId;
    if (activeTabId === id) {
      nextActiveId = remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    }

    set({
      tabs: remaining,
      activeTabId: nextActiveId,
    });
  },

  setActiveTabId: (id: string) => {
    set({ activeTabId: id });
  },

  setTabConnected: (id: string, connected: boolean) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, connected } : t)),
    }));
  },

  setLatencyMs: (ms: number) => {
    set({ latencyMs: ms });
  },
}));
