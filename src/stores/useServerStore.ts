import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { ServerRecord } from '../types';

interface ServerState {
  servers: ServerRecord[];
  loading: boolean;
  activeServer: ServerRecord | null;
  fetchServers: () => Promise<void>;
  saveServer: (server: ServerRecord) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  setActiveServer: (server: ServerRecord | null) => void;
}

export const useServerStore = create<ServerState>((set, get) => ({
  servers: [],
  loading: false,
  activeServer: null,

  fetchServers: async () => {
    set({ loading: true });
    try {
      if (!window.__TAURI_INTERNALS__) {
        set({ servers: [], loading: false });
        return;
      }
      const list = await invoke<ServerRecord[]>('list_servers');
      set({ servers: list, loading: false });
    } catch (e) {
      console.error('获取主机列表失败:', e);
      set({ loading: false });
    }
  },

  saveServer: async (server: ServerRecord) => {
    try {
      if (window.__TAURI_INTERNALS__) {
        await invoke('save_server', { server });
      } else {
        const current = get().servers.filter((s) => s.id !== server.id);
        const updated = [server, ...current];
        localStorage.setItem('ai_terminal_servers', JSON.stringify(updated));
      }
      await get().fetchServers();
    } catch (e) {
      console.error('保存主机配置失败:', e);
      throw e;
    }
  },

  deleteServer: async (id: string) => {
    try {
      if (window.__TAURI_INTERNALS__) {
        await invoke('delete_server', { id });
      } else {
        const updated = get().servers.filter((s) => s.id !== id);
        localStorage.setItem('ai_terminal_servers', JSON.stringify(updated));
      }
      await get().fetchServers();
    } catch (e) {
      console.error('删除主机配置失败:', e);
      throw e;
    }
  },

  setActiveServer: (server: ServerRecord | null) => {
    set({ activeServer: server });
  },
}));
