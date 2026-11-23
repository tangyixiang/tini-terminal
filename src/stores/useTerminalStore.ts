import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { TerminalTab, ServerRecord } from '../types';
import { isWindowsPlatform } from '../lib/platform';
import { useAgentStore } from './useAgentStore';
import { abortAgentTask, isAgentTaskRunning } from '../lib/agent/runner';
import { terminalRuntimeManager } from '../core/terminal/TerminalRuntimeManager';

interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  latencyMs: number | null;
  openLocalTab: () => string;
  openSshTab: (server: ServerRecord) => string;
  closeTab: (id: string) => void;
  setActiveTabId: (id: string) => void;
  setTabConnected: (id: string, connected: boolean) => void;
  setTabLatency: (id: string, latencyMs: number | null) => void;
  setLatencyMs: (ms: number | null) => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  latencyMs: null,

  openLocalTab: () => {
    const id = 'tab-' + Math.random().toString(36).substring(2, 9);
    const newTab: TerminalTab = {
      id,
      sessionId: id,
      title: isWindowsPlatform() ? 'PowerShell' : 'Local Shell',
      isSsh: false,
      connected: true,
      latencyMs: 0,
    };
    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: id,
      latencyMs: 0,
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
      latencyMs: null,
    };
    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: id,
      latencyMs: null,
    }));
    return id;
  },

  closeTab: (id: string) => {
    const { tabs, activeTabId } = get();
    const tab = tabs.find((t) => t.id === id);

    if (isAgentTaskRunning(id)) {
      abortAgentTask(id);
    }

    if (tab) {
      terminalRuntimeManager.destroy(tab.sessionId);
    }

    if (tab && window.__TAURI_INTERNALS__) {
      invoke('close_terminal', { sessionId: tab.sessionId, isSsh: tab.isSsh }).catch(() => {});
    }

    useAgentStore.getState().removeSession(id);

    const remaining = tabs.filter((t) => t.id !== id);
    let nextActiveId = activeTabId;
    if (activeTabId === id) {
      nextActiveId = remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    }
    const nextTab = remaining.find((t) => t.id === nextActiveId);

    set({
      tabs: remaining,
      activeTabId: nextActiveId,
      latencyMs: nextTab?.latencyMs ?? null,
    });
  },

  setActiveTabId: (id: string) => {
    const target = get().tabs.find((t) => t.id === id);
    set({ activeTabId: id, latencyMs: target?.latencyMs ?? null });
  },

  setTabConnected: (id: string, connected: boolean) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, connected } : t)),
    }));
  },

  setTabLatency: (id: string, latencyMs: number | null) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, latencyMs } : t)),
      latencyMs: state.activeTabId === id ? latencyMs : state.latencyMs,
    }));
  },

  setLatencyMs: (ms: number | null) => {
    set({ latencyMs: ms });
  },
}));
